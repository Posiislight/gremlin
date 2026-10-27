import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FindingStatus, parseScenarioYaml, ScenarioParseError } from '@gremlin/contract';
import {
  agentRuns,
  environments,
  findingOccurrences,
  findings,
  playbooks,
  productMaps,
  promptVariants,
  scenarioRuns,
  scenarios,
  scans,
  steps,
  type Db,
} from '@gremlin/db';
import type { Queues } from '../queue.js';
import { inScan } from '../scan-findings.js';
import { CREDENTIAL_LINK_TTL_S, DEFAULT_PERSONA, savedPersonaNames, signCredentialLink } from '../credentials.js';
import { fixPrompt, playwrightTest, replayUrl, scrub, type PromptStep } from './prompt.js';

export interface McpDeps {
  db: Db;
  queues: Queues;
  /** Dashboard base URL for replay links. Defaults to GREMLIN_WEB_URL, then http://localhost:3000. */
  webUrl?: string;
  /** HMAC secret for credential links (defaults to GREMLIN_SECRET_KEY). */
  secret?: string;
  /** Public base URL of this engine, for links shown to the user (derived from the incoming request). */
  publicBase?: string;
}

const TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled', 'completed', 'error']);
const MAX_WAIT_S = 55;

class ToolError extends Error {}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const fail = (message: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const httpUrl = z.url().refine((u) => /^https?:$/.test(new URL(u).protocol), 'url must be http(s)');

export const startScanInput = {
  url: httpUrl.optional().describe('Target URL (http/https). Provide url or environmentId.'),
  environmentId: z.string().min(1).optional().describe('Existing environment id; its base URL is scanned.'),
  teamSize: z.number().int().min(1).max(20).default(5).describe('Number of parallel agents.'),
  focus: z.string().min(1).max(500).optional().describe('Area or flow to concentrate on, e.g. "checkout".'),
  allowedActions: z.enum(['read_only', 'full']).default('read_only'),
  personas: z.array(z.string().min(1).max(100)).max(10).optional().describe('Persona names to scan as.'),
};

/** Registers the Gremlin tools on a fresh McpServer scoped to one project. */
export function registerTools(server: McpServer, projectId: string, deps: McpDeps): void {
  const { db, queues } = deps;
  const webBase = () => deps.webUrl ?? process.env.GREMLIN_WEB_URL ?? 'http://localhost:3000';


  /** Finds (or creates, by origin) the project's environment for a url / environmentId argument. */
  async function resolveEnvironment(
    tx: Pick<Db, 'select' | 'insert' | 'execute'>,
    a: { url?: string | undefined; environmentId?: string | undefined },
    allowed: string,
  ): Promise<string> {
    if (a.environmentId) {
      const [env] = await tx
        .select()
        .from(environments)
        .where(and(eq(environments.id, a.environmentId), eq(environments.projectId, projectId)))
        .limit(1);
      if (!env) throw new ToolError('environment_not_found');
      return env.id;
    }
    const origin = new URL(a.url!).origin;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId + '|' + origin}))`);
    const [existing] = await tx
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, projectId), eq(environments.baseUrl, origin)))
      .limit(1);
    if (existing) return existing.id;
    const [env] = await tx.insert(environments).values({ projectId, baseUrl: origin, allowedActions: allowed }).returning();
    return env!.id;
  }

  const guard =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        if (e instanceof ToolError) return fail(e.message);
        return fail('internal_error');
      }
    };

  async function ownedFinding(id: string) {
    const [f] = await db
      .select()
      .from(findings)
      .where(and(eq(findings.id, id), eq(findings.projectId, projectId)))
      .limit(1);
    if (!f) throw new ToolError('finding_not_found');
    return f;
  }

  async function ownedScan(id: string) {
    const [row] = await db
      .select({ scan: scans, baseUrl: environments.baseUrl })
      .from(scans)
      .innerJoin(environments, eq(scans.environmentId, environments.id))
      .where(and(eq(scans.id, id), eq(environments.projectId, projectId)))
      .limit(1);
    if (!row) throw new ToolError('scan_not_found');
    return row;
  }

  /** First occurrence: run id, step number. */
  async function occurrenceOf(findingId: string) {
    const [o] = await db
      .select({ runId: findingOccurrences.agentRunId, stepId: findingOccurrences.stepId, n: steps.n })
      .from(findingOccurrences)
      .innerJoin(steps, eq(steps.id, findingOccurrences.stepId))
      .where(eq(findingOccurrences.findingId, findingId))
      .orderBy(asc(steps.n))
      .limit(1);
    return o ?? null;
  }

  const scanSummary = async (scanId: string) => {
    const { scan, baseUrl } = await ownedScan(scanId);
    const runRows = await db
      .select({ status: agentRuns.status, count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(eq(agentRuns.scanId, scanId))
      .groupBy(agentRuns.status);
    const findingRows = await db
      .select({ status: findings.status, count: sql<number>`count(*)::int` })
      .from(findings)
      .where(inScan(scanId))
      .groupBy(findings.status);
    const [blocked] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(steps)
      .innerJoin(agentRuns, eq(steps.agentRunId, agentRuns.id))
      .where(and(eq(agentRuns.scanId, scanId), sql`${steps.actionJson}->>'type' = 'finish'`, sql`${steps.actionJson}->>'reason' ilike 'Blocked by sign-in%'`));
    const needsCredentials = (blocked?.n ?? 0) > 0;
    return {
      scanId: scan.id,
      status: scan.status,
      url: baseUrl,
      ...(needsCredentials
        ? { needsCredentials: true, nextStep: 'The scan was stopped by a sign-in page. Call request_credentials for this url, give the user the link, then start_scan again.' }
        : {}),
      teamSize: scan.teamSize,
      focus: scan.focus,
      costUsd: Number(scan.costUsd.toFixed(4)),
      startedAt: scan.startedAt?.toISOString() ?? null,
      finishedAt: scan.finishedAt?.toISOString() ?? null,
      progress: {
        runs: Object.fromEntries(runRows.map((r) => [r.status, r.count])),
        findings: Object.fromEntries(findingRows.map((r) => [r.status, r.count])),
      },
      done: TERMINAL.has(scan.status),
    };
  };

  server.registerTool(
    'get_playbook',
    {
      description:
        'Current QA playbook and app memory summary for the project. Call this first, before any other Gremlin tool.',
      inputSchema: { projectId: z.string().min(1).describe('Project id (must match the API key project).') },
    },
    guard(async ({ projectId: pid }: { projectId: string }) => {
      if (pid !== projectId) throw new ToolError('project_not_found');
      const [pb] = await db
        .select()
        .from(playbooks)
        .where(and(eq(playbooks.projectId, projectId), isNull(playbooks.revertedAt)))
        .orderBy(desc(playbooks.version))
        .limit(1);
      const [map] = await db
        .select()
        .from(productMaps)
        .where(eq(productMaps.projectId, projectId))
        .orderBy(desc(productMaps.version))
        .limit(1);
      const counts = await db
        .select({ status: findings.status, count: sql<number>`count(*)::int` })
        .from(findings)
        .where(eq(findings.projectId, projectId))
        .groupBy(findings.status);
      const envs = await db
        .select({ id: environments.id, baseUrl: environments.baseUrl, allowedActions: environments.allowedActions })
        .from(environments)
        .where(eq(environments.projectId, projectId))
        .limit(20);
      const mapJson = map?.mapJson as { areas?: unknown } | undefined;
      return {
        projectId,
        playbook: pb ? { version: pb.version, bodyMd: scrub(pb.bodyMd) } : null,
        memory: {
          productMapVersion: map?.version ?? null,
          areas: Array.isArray(mapJson?.areas) ? (mapJson.areas as unknown[]).slice(0, 30) : [],
          findingCounts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
        },
        environments: envs,
      };
    }),
  );

  server.registerTool(
    'request_credentials',
    {
      description:
        'Use when the target needs a login (the user says so, or a scan could not get past a sign-in page). Returns a secure link: tell the user to open it and type the test login (email/username + password) there. NEVER ask the user to type the password in chat, and never put credentials in focus text. After they confirm, call start_scan; saved logins are used automatically. Also reports whether a login is already saved.',
      inputSchema: {
        url: httpUrl.optional().describe('Target URL. Provide url or environmentId.'),
        environmentId: z.string().min(1).optional(),
        persona: z.string().min(1).max(100).optional().describe('Name for this login, e.g. "customer" or "admin". Default: "default".'),
        replace: z.boolean().optional().describe('Issue a link even if a login is already saved (to change it).'),
      },
    },
    guard(async (a: { url?: string | undefined; environmentId?: string | undefined; persona?: string | undefined; replace?: boolean | undefined }) => {
      if (!a.url && !a.environmentId) throw new ToolError('provide url or environmentId');
      const secret = deps.secret ?? process.env.GREMLIN_SECRET_KEY;
      if (!secret) throw new ToolError('credentials_unavailable');
      const persona = a.persona ?? DEFAULT_PERSONA;
      const environmentId = await db.transaction((tx) => resolveEnvironment(tx, a, 'read_only'));
      const saved = await savedPersonaNames(db, environmentId);
      if (saved.includes(persona) && !a.replace) {
        return {
          environmentId,
          persona,
          alreadySaved: true,
          savedLogins: saved,
          note: 'A login is already saved and will be used automatically by start_scan. Pass replace: true to issue a link to change it.',
        };
      }
      const token = signCredentialLink({ projectId, environmentId, persona }, secret);
      const base = (deps.publicBase ?? process.env.GREMLIN_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
      return {
        environmentId,
        persona,
        alreadySaved: false,
        link: `${base}/credentials/${token}`,
        expiresInMinutes: CREDENTIAL_LINK_TTL_S / 60,
        note: 'Show this link to the user and ask them to open it and enter a TEST login for the site. Do not ask for the password in chat. When they say they have saved it, call start_scan.',
      };
    }),
  );

  server.registerTool(
    'start_scan',
    {
      description:
        'Start a Deep Scan of a web app. Calling this asserts you are authorised to test the target. Defaults to read_only (no mutating requests; sign-in requests are still allowed). If the app needs a login, call request_credentials first; a saved login is used automatically.',
      inputSchema: startScanInput,
    },
    guard(async (a: z.infer<z.ZodObject<typeof startScanInput>>) => {
      if (!a.url && !a.environmentId) throw new ToolError('provide url or environmentId');
      const teamSize = a.teamSize ?? 5;
      const allowed = a.allowedActions ?? 'read_only';
      const { scanId, environmentId } = await db.transaction(async (tx) => {
        const environmentId = await resolveEnvironment(tx, a, allowed);
        const [scan] = await tx
          .insert(scans)
          .values({ environmentId, status: 'queued', teamSize, allowedActions: allowed, focus: a.focus ?? null })
          .returning();
        return { scanId: scan!.id, environmentId };
      });
      const entry = a.url ? new URL(a.url) : null;
      await queues.discovery.add('discover', { scanId, ...(entry ? { startPath: `${entry.pathname}${entry.search}` } : {}) });
      const loginSaved = (await savedPersonaNames(db, environmentId)).length > 0;
      return {
        scanId,
        status: 'queued',
        loginSaved,
        note: loginSaved
          ? 'A saved login will be used if the app asks for one. Call wait_scan or get_scan to follow progress.'
          : 'No login saved. If the scan reports it was stopped by a sign-in page, call request_credentials and start the scan again. Call wait_scan or get_scan to follow progress.',
      };
    }),
  );

  server.registerTool(
    'get_scan',
    {
      description: 'Scan status, progress (runs and findings by status) and cost so far.',
      inputSchema: { scanId: z.string().min(1) },
    },
    guard(async ({ scanId }: { scanId: string }) => scanSummary(scanId)),
  );

  server.registerTool(
    'wait_scan',
    {
      description: `Block until the scan finishes or timeoutS elapses (capped at ${MAX_WAIT_S}s per call; call again if not done).`,
      inputSchema: { scanId: z.string().min(1), timeoutS: z.number().int().min(1).max(600).default(30) },
    },
    guard(async ({ scanId, timeoutS }: { scanId: string; timeoutS?: number }) => {
      const deadline = Date.now() + Math.min(timeoutS ?? 30, MAX_WAIT_S) * 1000;
      for (;;) {
        const s = await scanSummary(scanId);
        if (s.done || Date.now() >= deadline) return { ...s, timedOut: !s.done };
        await sleep(500);
      }
    }),
  );

  server.registerTool(
    'list_findings',
    {
      description: 'Findings of a scan with trimmed fields. `truncated` is true when more exist than `limit`.',
      inputSchema: {
        scanId: z.string().min(1),
        status: FindingStatus.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    guard(async (a: { scanId: string; status?: z.infer<typeof FindingStatus>; limit?: number }) => {
      await ownedScan(a.scanId);
      const limit = a.limit ?? 20;
      const rows = await db
        .select({
          id: findings.id,
          priority: findings.priority,
          title: findings.title,
          status: findings.status,
          oracle: findings.oracle,
          url: findings.url,
          fixStatus: findings.fixStatus,
        })
        .from(findings)
        .where(
          and(
            eq(findings.projectId, projectId),
            inScan(a.scanId),
            ...(a.status ? [eq(findings.status, a.status)] : []),
          ),
        )
        .orderBy(asc(findings.priority), asc(findings.createdAt))
        .limit(limit + 1);
      const out = [];
      for (const r of rows.slice(0, limit)) {
        const o = await occurrenceOf(r.id);
        out.push({
          ...r,
          title: scrub(r.title),
          replayUrl: o ? replayUrl(webBase(), o.runId, o.n, r.id) : null,
        });
      }
      return { findings: out, truncated: rows.length > limit };
    }),
  );

  async function stepsFor(runId: string, upTo: number): Promise<PromptStep[]> {
    const rows = await db.select().from(steps).where(eq(steps.agentRunId, runId)).orderBy(asc(steps.n));
    return rows
      .filter((s) => s.n <= upTo)
      .map((s) => ({ n: s.n, action: s.actionJson, locator: s.locatorJson ?? null, intent: s.intent }));
  }

  async function signalsAt(runId: string, n: number): Promise<unknown[]> {
    const [s] = await db
      .select({ signals: steps.signalsJson })
      .from(steps)
      .where(and(eq(steps.agentRunId, runId), eq(steps.n, n)))
      .limit(1);
    return (s?.signals ?? []).slice(0, 10);
  }

  server.registerTool(
    'get_finding',
    {
      description: 'One finding: expected vs actual, reproduction steps, raw signals and the replay URL.',
      inputSchema: { id: z.string().min(1) },
    },
    guard(async ({ id }: { id: string }) => {
      const f = await ownedFinding(id);
      const o = await occurrenceOf(id);
      const st = o ? await stepsFor(o.runId, o.n) : [];
      const signals = o ? await signalsAt(o.runId, o.n) : [];
      return {
        id: f.id,
        scanId: f.scanId,
        priority: f.priority,
        title: scrub(f.title),
        status: f.status,
        oracle: f.oracle,
        url: f.url,
        expected: scrub(f.expected),
        actual: scrub(f.actual),
        steps: st.slice(-15).map((s) => ({ n: s.n, text: scrub(s.intent ?? s.action.type) })),
        signals: JSON.parse(scrub(JSON.stringify(signals))) as unknown[],
        fixStatus: f.fixStatus,
        replayUrl: o ? replayUrl(webBase(), o.runId, o.n, f.id) : null,
      };
    }),
  );

  server.registerTool(
    'get_fix_prompt',
    {
      description: 'Ready-to-paste coding-agent prompt for a finding, including a generated Playwright test.',
      inputSchema: { id: z.string().min(1) },
    },
    guard(async ({ id }: { id: string }) => {
      const f = await ownedFinding(id);
      const o = await occurrenceOf(id);
      const st = o ? await stepsFor(o.runId, o.n) : [];
      const signals = o ? await signalsAt(o.runId, o.n) : [];
      const replay = o ? replayUrl(webBase(), o.runId, o.n, f.id) : null;
      let baseUrl: string | null = null;
      if (f.url) {
        try {
          baseUrl = new URL(f.url).origin;
        } catch {
          baseUrl = null;
        }
      }
      const pf = {
        id: f.id,
        title: f.title,
        priority: f.priority,
        expected: f.expected,
        actual: f.actual,
        url: f.url,
        oracle: f.oracle,
      };
      const test = playwrightTest(pf, st, baseUrl);
      return {
        id: f.id,
        replayUrl: replay,
        prompt: fixPrompt({ finding: pf, steps: st, signals, replay, test }),
        playwrightTest: scrub(test),
      };
    }),
  );

  const matches = (pattern: string, value: string) =>
    pattern.includes('*')
      ? new RegExp(
          `^${pattern
            .split('*')
            .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
        ).test(value)
      : value.includes(pattern);

  async function enqueueScenarioRun(scenarioId: string, url: string) {
    const [run] = await db.insert(agentRuns).values({ scanId: null, kind: 'scenario', status: 'queued' }).returning();
    const [sr] = await db.insert(scenarioRuns).values({ scenarioId, agentRunId: run!.id, status: 'queued' }).returning();
    await queues.confirm.add('scenario', {
      kind: 'scenario',
      scenarioId,
      scenarioRunId: sr!.id,
      runId: run!.id,
      url,
    });
    return {
      scenarioId,
      scenarioRunId: sr!.id,
      runId: run!.id,
      replayUrl: `${webBase().replace(/\/+$/, '')}/runs/${run!.id}`,
    };
  }

  server.registerTool(
    'run_relevant_scenarios',
    {
      description:
        'Regression net: run the saved scenarios whose triggers match the changed files or routes against url. Returns the queued runs.',
      inputSchema: {
        projectId: z.string().min(1),
        changedFiles: z.array(z.string().max(500)).max(500).default([]),
        changedRoutes: z.array(z.string().max(500)).max(200).default([]),
        url: httpUrl,
      },
    },
    guard(async (a: { projectId: string; changedFiles?: string[]; changedRoutes?: string[]; url: string }) => {
      if (a.projectId !== projectId) throw new ToolError('project_not_found');
      const changed = [...(a.changedFiles ?? []), ...(a.changedRoutes ?? [])];
      const rows = await db.select().from(scenarios).where(eq(scenarios.projectId, projectId)).limit(500);
      const hit = rows.filter((s) => {
        const triggers = Array.isArray(s.triggers)
          ? (s.triggers as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        return triggers.some((t) => changed.some((c) => matches(t, c)));
      });
      const queued = [];
      for (const s of hit.slice(0, 25)) queued.push({ name: s.name, ...(await enqueueScenarioRun(s.id, a.url)) });
      return { matched: hit.length, queued, truncated: hit.length > 25 };
    }),
  );

  server.registerTool(
    'run_scenarios',
    {
      description: 'Run explicit scenarios, by saved id or inline YAML (validated and saved), against url.',
      inputSchema: {
        ids: z.array(z.string().min(1)).max(25).optional(),
        yaml: z.array(z.string().min(1).max(20_000)).max(25).optional(),
        url: httpUrl,
      },
    },
    guard(async (a: { ids?: string[]; yaml?: string[]; url: string }) => {
      if (!a.ids?.length && !a.yaml?.length) throw new ToolError('provide ids or yaml');
      const targets: { id: string; name: string }[] = [];
      if (a.ids?.length) {
        const rows = await db
          .select()
          .from(scenarios)
          .where(and(eq(scenarios.projectId, projectId), inArray(scenarios.id, a.ids)));
        if (rows.length !== new Set(a.ids).size) throw new ToolError('scenario_not_found');
        targets.push(...rows.map((r) => ({ id: r.id, name: r.name })));
      }
      for (const text of a.yaml ?? []) {
        let parsed;
        try {
          parsed = parseScenarioYaml(text);
        } catch (e) {
          if (e instanceof ScenarioParseError) throw new ToolError(`invalid scenario yaml: ${e.message.slice(0, 400)}`);
          throw e;
        }
        const [row] = await db
          .insert(scenarios)
          .values({ projectId, name: parsed.name, yaml: text, triggers: parsed.triggers ?? [] })
          .returning();
        targets.push({ id: row!.id, name: row!.name });
      }
      const runs = [];
      for (const t of targets) runs.push({ name: t.name, ...(await enqueueScenarioRun(t.id, a.url)) });
      return { runs };
    }),
  );

  server.registerTool(
    'verify_fix',
    {
      description:
        'Queue a deterministic re-run of a finding against a new (preview/deployed) URL. Returns the run to follow.',
      inputSchema: { findingId: z.string().min(1), url: httpUrl },
    },
    guard(async ({ findingId, url }: { findingId: string; url: string }) => {
      const f = await ownedFinding(findingId);
      const [run] = await db
        .insert(agentRuns)
        .values({ scanId: f.scanId, kind: 'verify', status: 'queued' })
        .returning();
      await db.update(findings).set({ fixStatus: 'verifying' }).where(eq(findings.id, f.id));
      await queues.confirm.add('verify', { kind: 'verify', findingId: f.id, runId: run!.id, url });
      return {
        findingId: f.id,
        runId: run!.id,
        status: 'queued',
        replayUrl: `${webBase().replace(/\/+$/, '')}/runs/${run!.id}?finding=${encodeURIComponent(f.id)}`,
      };
    }),
  );

  server.registerTool(
    'report_fix_outcome',
    {
      description: 'Close the fix loop: tell Gremlin how a fix attempt using a prompt variant turned out.',
      inputSchema: {
        findingId: z.string().min(1),
        promptVariant: z.string().min(1).max(100),
        outcome: z.enum(['fixed', 'partial', 'not_fixed', 'abandoned']),
      },
    },
    guard(
      async (a: {
        findingId: string;
        promptVariant: string;
        outcome: 'fixed' | 'partial' | 'not_fixed' | 'abandoned';
      }) => {
        const f = await ownedFinding(a.findingId);
        await db
          .update(findings)
          .set({
            fixStatus: a.outcome,
            promptVariant: a.promptVariant,
            ...(a.outcome === 'fixed' ? { status: 'fixed' } : {}),
          })
          .where(eq(findings.id, f.id));
        await db
          .update(promptVariants)
          .set({
            uses: sql`${promptVariants.uses} + 1`,
            fixes: sql`${promptVariants.fixes} + ${a.outcome === 'fixed' ? 1 : 0}`,
          })
          .where(eq(promptVariants.id, a.promptVariant));
        return { findingId: f.id, fixStatus: a.outcome };
      },
    ),
  );
}
