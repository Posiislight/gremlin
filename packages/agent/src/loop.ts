import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Action, Candidate, Charter, Locator, Signal, Step, StepOutcome } from '@gremlin/contract';
import type { Llm } from '@gremlin/llm';
import type { Storage } from '@gremlin/storage';
import { dismissConsent } from './consent.js';
import { createAgentContext } from './context.js';
import { execute, type ExecResult } from './execute.js';
import { observe, type Observation } from './observe.js';
import { runOracles, signatureFor, clip } from './oracles/index.js';
import type { PolicyHandle } from './policy.js';
import { buildNavigatorPrompt, clipText, NAVIGATOR_SYSTEM, navigatorTool, PROMPT_LIMITS } from './prompts.js';
import { startRecording, type Recorder } from './recorder/index.js';
import { redact } from './secrets.js';
import { settle } from './settle.js';
import { normalizePath } from './url.js';

export type RunAgentOpts = {
  browser: Browser;
  baseUrl: string;
  charter: Charter;
  llm: Llm;
  storage: Storage;
  runId: string;
  keyPrefix: string;
  secrets: Record<string, string>;
  allowedActions: 'read_only' | 'full';
  authAllowlist?: string[];
  storageState?: string;
  playbook?: string;
  budgets?: { steps?: number; ms?: number; tokens?: number };
  suppressed?: Set<string>;
  onEvent?: (e: AgentEvent) => void;
  /** Directory `upload` actions may take fixtures from. Default: none (uploads fail with an error outcome). */
  fixturesDir?: string;
};

export type AgentStatus = 'running' | 'finished' | 'budget_steps' | 'budget_time' | 'budget_tokens' | 'stuck' | 'error';

export type AgentEvent =
  | { type: 'step'; step: Step; screenshotKey?: string }
  | { type: 'candidate'; candidate: Candidate }
  | { type: 'status'; status: AgentStatus };

export type Expectation = { stepN: number; statement: string; before: Observation; after: Observation };

export type RunAgentResult = {
  status: AgentStatus;
  steps: Step[];
  candidates: Candidate[];
  expectations: Expectation[];
  artifacts: { timelineKey: string; videoKey?: string; traceKey: string; rrwebKeys: string[] };
  tokens: number;
  /** Set when status is 'error': what ended the run (redacted). */
  error?: string;
};

export const DEFAULT_BUDGETS = { steps: 40, ms: 300_000, tokens: 150_000 };
/** Consecutive no-op steps (no state change, no signals, no error) before the run is declared stuck. */
export const STUCK_AFTER = 3;

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

/** Errors a navigation can cause mid-call; worth one retry after the page settles. */
const NAV_RACE = /execution context was destroyed|navigation|frame was detached|context.*destroyed|Target closed/i;

/** Not page actions: they never touch the page and neither extend nor break a no-op streak, nor close an expectation. */
const NON_PAGE: ReadonlySet<Action['type']> = new Set(['expect', 'report_bug']);

/** Placeholder action recorded for steps that never got a (valid) model action. */
function syntheticAction(intent: string): Action {
  return { type: 'wait', ms: 0, intent };
}

/** Every encoding a secret may show up in (raw, JSON-escaped, URL-encoded), for redact(). */
function secretForms(secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  for (const v of Object.values(secrets)) {
    if (!v) continue;
    for (const f of new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])) if (f) out[`f${i++}`] = f;
  }
  return out;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isLlmError(e: unknown): e is Error & { code: string } {
  return e instanceof Error && e.name === 'LlmError' && typeof (e as { code?: unknown }).code === 'string';
}

/** One-line description of an action for the history (model-produced text is clipped; it holds placeholders only). */
function describeAction(a: Action): string {
  const q = (s: string, n = 60) => JSON.stringify(clipText(s, n));
  switch (a.type) {
    case 'click':
    case 'hover':
      return `${a.type}(${a.ref})`;
    case 'type':
      return `type(${a.ref}, ${q(a.text)}${a.submit ? ', submit' : ''})`;
    case 'select':
      return `select(${a.ref}, ${q(a.option)})`;
    case 'press':
      return `press(${q(a.key, 20)})`;
    case 'scroll':
      return `scroll(${a.direction})`;
    case 'upload':
      return `upload(${a.ref}, ${q(a.fixture)})`;
    case 'goto':
      return `goto(${q(a.path, 100)})`;
    case 'back':
    case 'refresh':
      return `${a.type}()`;
    case 'wait':
      return `wait(${a.ms})`;
    case 'expect':
      return `expect(${q(a.statement, 120)})`;
    case 'report_bug':
      return `report_bug(${q(a.title, 100)}, ${a.severityHint})`;
    case 'finish':
      return `finish(${q(a.reason, 100)})`;
  }
}

function describeSignal(s: Signal): string {
  switch (s.kind) {
    case 'console':
      return `console.${s.level}: ${s.text}`;
    case 'pageerror':
      return `uncaught error: ${s.message}`;
    case 'network':
      return `${s.method} ${s.url} -> ${s.status ?? s.failure ?? 'failed'} (${s.resourceType}, ${s.durationMs}ms)`;
    case 'navigation':
      return `navigated to ${s.url}`;
    case 'policy':
      return `BLOCKED by safety policy: ${s.method} ${s.url}`;
  }
}

/** Signals worth showing the model: errors, failed/4xx/5xx requests, navigations, policy blocks. */
function promptWorthy(s: Signal): boolean {
  if (s.kind === 'network') return s.status === null || s.status >= 400;
  return true;
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const budgets = { ...DEFAULT_BUDGETS, ...opts.budgets };
  const origin = new URL(opts.baseUrl).origin;
  const forms = secretForms(opts.secrets);
  const scrub = (s: string) => redact(s, forms);
  const scrubJson = <T>(v: T): T => JSON.parse(scrub(JSON.stringify(v))) as T;
  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* a listener must never break the run */
    }
  };

  const steps: Step[] = [];
  const candidates: Candidate[] = [];
  const seenSigs = new Set<string>(opts.suppressed ?? []);
  const expectations: Expectation[] = [];
  let openExpectations: { stepN: number; statement: string; before: Observation }[] = [];
  let tokens = 0;
  /** The most recent (redacted) observation; closes expectations still open when the run ends. */
  let lastObservation: Observation | undefined;
  let status: AgentStatus = 'running';
  let fatal: string | undefined;

  const viewport = VIEWPORTS[opts.charter.viewport];
  const tmpDir = await mkdtemp(join(tmpdir(), `gremlin-${opts.runId.replace(/[^\w-]/g, '_')}-`));
  let context: BrowserContext | null = null;
  let recorder: Recorder | null = null;
  let artifacts: RunAgentResult['artifacts'] | null = null;
  emit({ type: 'status', status: 'running' });

  try {
    const created = await createAgentContext(opts.browser, {
      viewport,
      ...(opts.charter.viewport === 'mobile' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      recordVideo: { dir: tmpDir, size: viewport },
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
      policy: { origin, allowedActions: opts.allowedActions, authAllowlist: opts.authAllowlist ?? [] },
    });
    const t0 = Date.now();
    context = created.context;
    const page = created.page;
    const policy = created.policy;
    recorder = await startRecording(context, {
      runId: opts.runId,
      t0,
      storage: opts.storage,
      keyPrefix: opts.keyPrefix,
      tmpDir,
      secrets: opts.secrets,
      origin,
    });
    const rec = recorder;

    await page.goto(new URL(opts.charter.startPath, origin).href, { timeout: 15_000 }).catch(() => undefined);
    await settle(page).catch(() => undefined);

    status = await loop(page, rec, policy, t0);
  } catch (e) {
    status = 'error';
    fatal = clip(scrub(errMessage(e)));
  } finally {
    // An expectation still open at the end is closed with the last observation the run made.
    if (openExpectations.length && lastObservation) {
      for (const o of openExpectations) expectations.push({ ...o, after: lastObservation });
      openExpectations = [];
    }
    try {
      if (recorder) artifacts = await recorder.stop();
    } catch (e) {
      status = 'error';
      fatal ??= clip(scrub(`recorder stop failed: ${errMessage(e)}`));
    }
    await context?.close().catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
  emit({ type: 'status', status });
  return {
    status,
    steps,
    candidates,
    expectations,
    artifacts: artifacts ?? { timelineKey: '', traceKey: '', rrwebKeys: [] },
    tokens,
    ...(fatal ? { error: fatal } : {}),
  };

  // --- helpers (hoisted function declarations; they close over the run state above) -----------------------------

  /** observe() with one retry after settle (a navigation can destroy the execution context mid-call). Redacted. */
  async function observeSafe(page: Page): Promise<Observation> {
    let obs: Observation;
    try {
      obs = await observe(page);
    } catch {
      await settle(page).catch(() => undefined);
      obs = await observe(page);
    }
    const clean = scrubJson(obs);
    lastObservation = clean;
    return clean;
  }

  async function executeSafe(page: Page, action: Action, ctx: Parameters<typeof execute>[2]): Promise<ExecResult> {
    try {
      const r = await execute(page, action, ctx);
      if (r.outcome !== 'error' || !NAV_RACE.test(r.error ?? '') || action.type === 'click' || action.type === 'type') return r;
      // Non-click actions raced a navigation before they took effect: settle and retry once.
    } catch {
      /* thrown (not returned) errors: retry once below */
    }
    await settle(page).catch(() => undefined);
    try {
      return await execute(page, action, ctx);
    } catch (e) {
      return { outcome: 'error', locator: null, error: clip(scrub(errMessage(e)).split('\n')[0] ?? '') };
    }
  }

  async function loop(page: Page, rec: Recorder, policy: PolicyHandle | null, t0: number): Promise<AgentStatus> {
    const fence = () => randomBytes(8).toString('hex');
    const placeholders = Object.keys(opts.secrets).map((k) => `{{${k}}}`);
    const history: string[] = [];
    let summary = '';
    let noopStreak = 0;
    let policySeen = policy?.blocked.length ?? 0;
    const settleCaps = new Map<string, number>();
    let pendingSignals: string[] = [];
    const execCtx = {
      secrets: opts.secrets,
      origin,
      fixturesDir: opts.fixturesDir ?? join(tmpDir, 'no-fixtures'),
      policy,
    };

    const remember = (line: string) => {
      history.push(clipText(line, PROMPT_LIMITS.historyLineChars));
      while (history.length > PROMPT_LIMITS.historyItems) {
        const old = history.shift()!;
        summary = summary ? `${summary}\n${old}` : old;
        if (summary.length > PROMPT_LIMITS.summaryChars) summary = '…' + summary.slice(summary.length - PROMPT_LIMITS.summaryChars + 1);
      }
    };

    /** Signals since the previous step: recorder streams plus the policy's blocks (which bypass the recorder). */
    const drain = (): Signal[] => {
      const out = rec.drainSignals();
      if (policy) {
        const fresh = policy.blocked.slice(policySeen);
        policySeen = policy.blocked.length;
        out.push(...fresh);
      }
      return scrubJson(out).sort((a, b) => a.tMs - b.tMs);
    };

    const record = (step: Step, screenshotKey?: string) => {
      const clean = scrubJson(step);
      steps.push(clean);
      rec.addStep(clean);
      emit({ type: 'step', step: clean, ...(screenshotKey ? { screenshotKey } : {}) });
      return clean;
    };

    const surface = (c: Candidate) => {
      if (seenSigs.has(c.signature)) return;
      seenSigs.add(c.signature);
      const clean = scrubJson(c);
      candidates.push(clean);
      emit({ type: 'candidate', candidate: clean });
    };

    for (let n = 1; ; n++) {
      if (steps.length >= budgets.steps) return 'budget_steps';
      if (Date.now() - t0 >= budgets.ms) return 'budget_time';
      if (tokens >= budgets.tokens) return 'budget_tokens';
      if (page.isClosed()) throw new Error('agent page was closed');

      await dismissConsent(page);
      let before: Observation;
      try {
        before = await observeSafe(page);
      } catch (e) {
        const err = clip(scrub(errMessage(e)).split('\n')[0] ?? '');
        record({
          n,
          action: syntheticAction('observe failed'),
          locator: null,
          intent: 'observe failed',
          tMs: rec.now(),
          stateHash: lastObservation?.stateHash ?? '',
          signals: drain(),
          outcome: 'error',
          error: `observe failed: ${err}`,
        });
        remember(`#${n} (could not read the page: ${err}) -> error`);
        noopStreak = 0;
        await settle(page).catch(() => undefined);
        continue;
      }

      const prompt = scrub(
        buildNavigatorPrompt({
          charter: opts.charter,
          ...(opts.playbook ? { playbook: opts.playbook } : {}),
          placeholders,
          summary,
          history,
          signals: pendingSignals,
          page: before.rendered,
          step: n,
          maxSteps: budgets.steps,
          fence: fence(),
        }),
      );

      let action: Action;
      try {
        const res = await opts.llm.callTool('navigator', {
          system: NAVIGATOR_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          tool: navigatorTool,
        });
        tokens += res.usage.tokensIn + res.usage.tokensOut;
        action = res.value;
      } catch (e) {
        if (isLlmError(e) && (e.code === 'invalid_output' || e.code === 'no_tool_call')) {
          const err = clip(scrub(errMessage(e)));
          record({
            n,
            action: syntheticAction('model_error'),
            locator: null,
            intent: 'model_error',
            tMs: rec.now(),
            stateHash: before.stateHash,
            signals: [],
            outcome: 'model_error',
            error: err,
          });
          remember(`#${n} (your previous reply was not a valid action: ${clipText(err, 160)}) -> model_error`);
          continue;
        }
        throw e;
      }

      const tMs = rec.now();
      const isPageAction = !NON_PAGE.has(action.type) && action.type !== 'finish';
      let result: ExecResult = { outcome: 'ok', locator: null };
      let after = before;
      let capped = false;
      if (isPageAction) {
        result = await executeSafe(page, action, execCtx);
        const s = await settle(page).catch(() => ({ capped: false, ms: 0 }));
        capped = s.capped;
        try {
          after = await observeSafe(page);
        } catch (e) {
          after = before;
          if (result.outcome === 'ok' || result.outcome === 'noop') {
            result = { ...result, outcome: 'error', error: clip(`observe after action failed: ${scrub(errMessage(e)).split('\n')[0]}`) };
          }
        }
      }

      const signals = drain();
      let outcome: StepOutcome = result.outcome;
      // No-op: nothing observable changed and the action caused no signal. Signals stamped before the action
      // (e.g. the start page's load, drained into step 1 for the oracles) do not count. A successful `type`
      // is never a no-op: the value it sets may be invisible to observation (password fields are not echoed).
      const changed =
        after.url !== before.url ||
        after.stateHash !== before.stateHash ||
        after.contentSig !== before.contentSig ||
        after.text !== before.text;
      const caused = signals.some((s) => s.tMs >= tMs);
      if (isPageAction && action.type !== 'type' && outcome === 'ok' && !changed && !caused) outcome = 'noop';

      const pathKey = normalizePath(after.url);
      if (capped) settleCaps.set(pathKey, (settleCaps.get(pathKey) ?? 0) + 1);

      let screenshotKey: string | undefined;
      try {
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
        screenshotKey = `${opts.keyPrefix}/screens/${n}.jpg`;
        await opts.storage.put(screenshotKey, jpeg, 'image/jpeg');
      } catch {
        screenshotKey = undefined;
      }

      const step = record(
        {
          n,
          action,
          locator: result.locator as Locator | null,
          intent: action.intent,
          ...(action.type === 'expect' ? { expectation: action.statement } : {}),
          tMs,
          stateHash: before.stateHash,
          ...(screenshotKey ? { screenshotKey } : {}),
          signals,
          outcome,
          ...(result.error ? { error: clip(scrub(result.error)) } : {}),
        },
        screenshotKey,
      );

      // Oracles see only this step's signals; the settle-cap count is per page (normalised path).
      for (const c of runOracles(
        {
          step,
          signals,
          observation: after,
          prevObservation: before,
          origin,
          loggedIn: Boolean(opts.storageState),
          settleCappedCount: settleCaps.get(pathKey) ?? 0,
        },
        opts.suppressed ? { suppressed: opts.suppressed } : {},
      )) {
        surface(c);
      }

      if (action.type === 'report_bug') {
        const message = clip(action.title);
        surface({
          oracle: 'agent_report',
          stepN: n,
          tMs,
          url: after.url,
          message,
          severity: action.severityHint,
          signature: signatureFor('agent_report', after.url, message),
          evidence: { expected: clip(action.expected), actual: clip(action.actual) },
        });
      }

      if (action.type === 'expect') {
        openExpectations.push({ stepN: n, statement: action.statement, before });
      } else if (isPageAction && openExpectations.length) {
        for (const o of openExpectations) expectations.push({ ...o, after });
        openExpectations = [];
      }

      const errNote = step.error ? ` (${clipText(step.error, 160)})` : '';
      remember(`#${n} ${describeAction(action)} -> ${outcome}${errNote}; now at ${after.path}`);
      pendingSignals = signals
        .filter(promptWorthy)
        .slice(-PROMPT_LIMITS.signalLines)
        .map((s) => clipText(describeSignal(s), PROMPT_LIMITS.signalLineChars));

      if (action.type === 'finish') return 'finished';
      if (isPageAction) {
        noopStreak = outcome === 'noop' ? noopStreak + 1 : 0;
        if (noopStreak >= STUCK_AFTER) return 'stuck';
      }
    }
  }
}
