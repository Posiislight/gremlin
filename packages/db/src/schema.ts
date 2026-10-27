import { createId } from '@paralleldrive/cuid2';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Action, Locator, Signal } from '@gremlin/contract';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => createId());
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const apiKeys = pgTable('api_keys', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  hash: text('hash').notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
});

export const environments = pgTable('environments', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  baseUrl: text('base_url').notNull(),
  allowedActions: text('allowed_actions').notNull().default('read_only'),
});

export const personas = pgTable('personas', {
  id: id(),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environments.id),
  name: text('name').notNull(),
  role: text('role'),
  credentialsEnc: text('credentials_enc'),
  storageStateKey: text('storage_state_key'),
  authRecipeJson: jsonb('auth_recipe_json'),
});

export const scans = pgTable('scans', {
  id: id(),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environments.id),
  status: text('status').notNull().default('queued'),
  teamSize: integer('team_size').notNull().default(1),
  allowedActions: text('allowed_actions').notNull().default('read_only'),
  focus: text('focus'),
  viewports: jsonb('viewports').$type<string[]>(),
  costUsd: doublePrecision('cost_usd').notNull().default(0),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
});

export const charters = pgTable('charters', {
  id: id(),
  scanId: text('scan_id')
    .notNull()
    .references(() => scans.id),
  type: text('type').notNull(),
  area: text('area'),
  goal: text('goal').notNull(),
  personaId: text('persona_id').references(() => personas.id),
  startPath: text('start_path'),
  viewport: text('viewport'),
  score: real('score'),
});

export const agentRuns = pgTable('agent_runs', {
  id: id(),
  // Null for verify/live/scenario runs that are not part of a scan.
  scanId: text('scan_id').references(() => scans.id),
  charterId: text('charter_id').references(() => charters.id),
  kind: text('kind').notNull().$type<'scan' | 'confirm' | 'live' | 'verify' | 'scenario'>(),
  status: text('status').notNull().default('queued'),
  t0: ts('t0'),
  videoKey: text('video_key'),
  rrwebKey: text('rrweb_key'),
  traceKey: text('trace_key'),
  timelineKey: text('timeline_key'),
  tokens: integer('tokens').notNull().default(0),
  costUsd: doublePrecision('cost_usd').notNull().default(0),
  /** Why the run ended in status 'error' (redacted, clipped). */
  error: text('error'),
});

export const steps = pgTable('steps', {
  id: id(),
  agentRunId: text('agent_run_id')
    .notNull()
    .references(() => agentRuns.id),
  n: integer('n').notNull(),
  actionJson: jsonb('action_json').$type<Action>().notNull(),
  locatorJson: jsonb('locator_json').$type<Locator>(),
  intent: text('intent'),
  expectation: text('expectation'),
  tMs: integer('t_ms').notNull(),
  stateHash: text('state_hash'),
  screenshotKey: text('screenshot_key'),
  signalsJson: jsonb('signals_json').$type<Signal[]>(),
  reasoningSummary: text('reasoning_summary'),
  outcome: text('outcome'),
  error: text('error'),
});

export const findings = pgTable(
  'findings',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    scanId: text('scan_id').references(() => scans.id),
    signature: text('signature').notNull(),
    priority: text('priority').notNull(),
    title: text('title').notNull(),
    expected: text('expected').notNull(),
    actual: text('actual').notNull(),
    status: text('status').notNull().default('open'),
    confirmJson: jsonb('confirm_json'),
    fixStatus: text('fix_status'),
    promptVariant: text('prompt_variant'),
    /** Oracle that raised the first occurrence (crash, network, expectation, ...). */
    oracle: text('oracle'),
    /** Page URL of the first occurrence. */
    url: text('url'),
    /** True when the judge could not run (LLM outage): status stays 'new' and the candidate should be re-judged. */
    unjudged: boolean('unjudged').notNull().default(false),
    /** The judge verdict (JudgeVerdict) or, when unjudged, `{reason}`. */
    verdictJson: jsonb('verdict_json'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('findings_project_signature_uq').on(t.projectId, t.signature)],
);

export const findingOccurrences = pgTable(
  'finding_occurrences',
  {
    findingId: text('finding_id')
      .notNull()
      .references(() => findings.id),
    agentRunId: text('agent_run_id')
      .notNull()
      .references(() => agentRuns.id),
    stepId: text('step_id')
      .notNull()
      .references(() => steps.id),
  },
  (t) => [primaryKey({ columns: [t.findingId, t.agentRunId, t.stepId] })],
);

export const scenarios = pgTable('scenarios', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(),
  yaml: text('yaml').notNull(),
  triggers: jsonb('triggers'),
  sourceFindingId: text('source_finding_id').references(() => findings.id),
  locatorSeqJson: jsonb('locator_seq_json'),
});

export const scenarioRuns = pgTable('scenario_runs', {
  id: id(),
  scenarioId: text('scenario_id')
    .notNull()
    .references(() => scenarios.id),
  agentRunId: text('agent_run_id').references(() => agentRuns.id),
  status: text('status').notNull().default('queued'),
});

export const productMaps = pgTable(
  'product_maps',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    version: integer('version').notNull(),
    mapJson: jsonb('map_json').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('product_maps_project_version_uq').on(t.projectId, t.version)],
);

export const playbooks = pgTable(
  'playbooks',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    version: integer('version').notNull(),
    bodyMd: text('body_md').notNull(),
    diff: text('diff'),
    statsJson: jsonb('stats_json'),
    createdAt: createdAt(),
    revertedAt: ts('reverted_at'),
  },
  (t) => [uniqueIndex('playbooks_project_version_uq').on(t.projectId, t.version)],
);

export const locatorMemory = pgTable(
  'locator_memory',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    stateHash: text('state_hash').notNull(),
    intent: text('intent').notNull(),
    locatorJson: jsonb('locator_json').$type<Locator>().notNull(),
    okCount: integer('ok_count').notNull().default(0),
    failCount: integer('fail_count').notNull().default(0),
  },
  (t) => [uniqueIndex('locator_memory_project_state_intent_uq').on(t.projectId, t.stateHash, t.intent)],
);

export const noise = pgTable(
  'noise',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    signature: text('signature').notNull(),
    dismissCount: integer('dismiss_count').notNull().default(0),
    suppressed: integer('suppressed').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.signature] })],
);

export const banditArms = pgTable(
  'bandit_arms',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    area: text('area').notNull(),
    charterType: text('charter_type').notNull(),
    alpha: doublePrecision('alpha').notNull().default(1),
    beta: doublePrecision('beta').notNull().default(1),
    costAvg: doublePrecision('cost_avg').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.area, t.charterType] })],
);

export const promptVariants = pgTable('prompt_variants', {
  id: id(),
  template: text('template').notNull(),
  uses: integer('uses').notNull().default(0),
  fixes: integer('fixes').notNull().default(0),
});

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: id(),
    scanId: text('scan_id').references(() => scans.id),
    agentRunId: text('agent_run_id').references(() => agentRuns.id),
    role: text('role').notNull(),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [index('llm_usage_scan_idx').on(t.scanId)],
);
