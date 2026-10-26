# Gremlin M1–M2: Foundation + Single Agent End to End — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed engine that can run one GLM-driven browser agent against a URL, record every stream on one clock, detect bugs with oracles + judge, and persist steps, findings and a replay timeline.

**Architecture:** pnpm/Turborepo monorepo. Shared zod contract; Drizzle/Postgres; pluggable object storage; OpenRouter LLM client with per-role config; Playwright agent with injected observation script, network-level safety policy, oracles, and a recorder that merges video, rrweb, console, network and steps into a `ReplayTimeline`. The engine is a Fastify app + BullMQ worker in a Playwright Docker image.

**Tech Stack:** Node 24, TypeScript (strict, ESM), pnpm workspaces, Turborepo, Vitest, zod 4 (`z.toJSONSchema`), Drizzle ORM + `postgres`, BullMQ + ioredis, Fastify 5, Playwright (Chromium), rrweb 2, `yaml`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, Docker Compose (Postgres 17, Redis 7, MinIO). Install the latest stable of each; the lockfile pins them.

**Spec:** `docs/superpowers/specs/2026-10-26-gremlin-design.md` (v3). Section refs like §6.3 point there.

## Global Constraints
- Node 24; TypeScript `strict: true`, ESM (`"type": "module"`), no `any` in exported signatures.
- Default model `z-ai/glm-5.3-flash` via OpenRouter `https://openrouter.ai/api/v1`; per-role effort: navigator `low`, judge `high`, mapper `medium`, healer `low`, reflect `max`, scenario `medium` (§5).
- LLM call timeout 30s; retry 429/5xx with jitter, max 3; one repair turn on invalid output (§5).
- Agent budgets default: 40 steps, 300000 ms, 150000 tokens; stop after 3 consecutive no-op steps (§6.4).
- Observation: ≤150 interactables, text digest ≤1500 tokens, total ≈6000 input tokens (§6.1).
- Settle: 500 ms quiet, 4000 ms cap; action timeout 5000 ms; `wait` ≤3000 ms (§6.2–6.3).
- Locator priority: `data-testid` > role+name > label/placeholder > text > CSS (§6.3).
- Path normalisation: numeric and UUID segments → `:id` (§6.5).
- All streams share `t0` = context creation; every event stores `tMs = Date.now() - t0`; alignment ≤100 ms (§9, §21).
- Network bodies captured only for status ≥400 or same-origin XHR/fetch, max 64 KB, secrets redacted (§9).
- Secrets never appear in prompts, `steps`, `action_json`, rrweb, network logs or app logs (§14).
- `read_only` aborts non-GET/HEAD to the target origin except the auth allowlist; logged `blocked_by_policy` (§14).
- Scan cost cap default $2 (§8.3).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **SPA route changes (pushState, no load)** — the state hash must change and the rrweb recording must keep running in one segment. Test: Task 9 `observe.spa.test.ts`, Task 11 `recorder.spa.test.ts`.
2. **Model returns a ref that doesn't exist (`e999`) or a malformed action** — the step records `outcome:'error'`, the loop continues, nothing crashes. Test: Task 10 `execute.badref.test.ts`, Task 13 `loop.badaction.test.ts`.
3. **Huge pages (2000 links, 200 KB of text)** — the observation stays within budget. Test: Task 9 `observe.budget.test.ts`.
4. **Secret leakage** — a typed `{{password}}` value never appears in persisted steps, rrweb, network bodies or prompts. Test: Task 11 `recorder.test.ts`, Task 13 `loop.secrets.test.ts`.
5. **Link opens a new tab (`target=_blank` / `window.open`)** — the popup is closed and a same-origin URL is opened in the agent's own tab (off-origin is ignored); the recording continues. Test: Task 10 `execute.popup.test.ts`.

---

## File Structure
```
package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, vitest.workspace.ts
docker-compose.yml, .env.example
packages/contract/src/{index,action,signal,step,finding,timeline,scenario,charter,cli}.ts
packages/db/src/{index,schema,migrate}.ts, drizzle.config.ts, migrations/
packages/storage/src/{index,fs,s3}.ts
packages/llm/src/{index,config,client,usage}.ts
packages/agent/src/
  url.ts            normalizePath, stateHash, sameOrigin
  inject/observe.js browser-side script (tags refs, collects interactables + text)
  observe.ts        observe(), renderObservation()
  settle.ts         settle()
  locator.ts        computeLocator(), resolveLocator()
  secrets.ts        resolvePlaceholders(), redact()
  policy.ts         installPolicy()
  consent.ts        dismissConsent()
  execute.ts        execute()
  oracles/{index,crash,console,network,http,errorText,blank,slow}.ts
  recorder/{index,rrweb-inject,timeline}.ts
  prompts.ts        navigator + judge system prompts, tool definitions
  loop.ts           runAgent()
  judge.ts          judge()
packages/agent/test/fixtures/*.html, test/server.ts
apps/engine/src/{server,auth,routes/scans,queue,worker,persist,scripts/scan-one}.ts, Dockerfile
apps/demo-target/   (Alan) + tests/seeded-bugs.spec.ts (Claude)
scripts/tunnel.sh
```

---

# Milestone 1 — Foundation

### Task 1: Monorepo, tooling, local services

**Files:** Create root `package.json` (scripts `build`, `test`, `typecheck` via turbo), `pnpm-workspace.yaml` (`packages/*`, `apps/*`), `turbo.json`, `tsconfig.base.json` (strict, ESM, `moduleResolution: bundler`, `target: ES2023`), `vitest.workspace.ts`, `docker-compose.yml` (postgres:17 port 5432 db `gremlin`; redis:7 port 6379; minio port 9000 with bucket `gremlin` created by an `mc` init service), `.env.example` (`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `OPENROUTER_API_KEY`, `GREMLIN_SECRET_KEY`, `GREMLIN_MODEL_<ROLE>`), `.gitignore`.

- [ ] **Step 1:** Create `packages/contract` with `package.json` and a placeholder test `test/smoke.test.ts` asserting `1 === 1`.
- [ ] **Step 2:** Run `pnpm install && pnpm test`. Expected: 1 passed.
- [ ] **Step 3:** Run `docker compose up -d && docker compose ps`. Expected: postgres, redis, minio healthy; bucket `gremlin` exists (`docker compose logs minio-init` shows it created).
- [ ] **Step 4:** Commit `chore: monorepo scaffold and local services`.

### Task 2: Contract package

**Files:** `packages/contract/src/*.ts`; tests `packages/contract/test/*.test.ts`.

**Interfaces — Produces** (all exported from `@gremlin/contract`, each a zod schema `X` plus `type X = z.infer<typeof X>`):
- `Priority = z.enum(['P0','P1','P2','P3'])`
- `Locator = { testId?, role?: {role, name}, label?, placeholder?, text?, css: string }`
- `Action` = discriminated union on `type`: `click{ref}`, `type{ref, text, submit?: boolean}`, `select{ref, option}`, `press{key}`, `hover{ref}`, `scroll{direction:'up'|'down'}`, `upload{ref, fixture}`, `goto{path}` (must start with `/`), `back{}`, `refresh{}`, `wait{ms: int 0..3000}`, `expect{statement}`, `report_bug{title, expected, actual, severityHint: Priority}`, `finish{reason}`. Every action also carries `intent: string` (navigator's one-line why).
- `Signal` = discriminated union on `kind`: `console{level:'error'|'warning', text, location?}`, `pageerror{message, stack?}`, `network{method, url, status: number|null, failure?, durationMs, resourceType, bodyKey?}`, `navigation{url}`, `policy{method, url}`; each has `tMs: number`.
- `OracleKind = z.enum(['crash','console','network','http','dead_link','error_text','blank','a11y','layout','vitals','slow','permission','expectation','agent_report'])`
- `Candidate = {oracle: OracleKind, stepN, tMs, url, message, severity: Priority, signature: string, evidence: Record<string, unknown>}`
- `StepOutcome = z.enum(['ok','error','blocked_by_policy','model_error','noop'])`
- `Step = {n, action: Action, locator: Locator|null, intent, expectation?: string, tMs, stateHash, screenshotKey?, signals: Signal[], outcome: StepOutcome, error?, reasoningSummary?}`
- `FindingStatus = z.enum(['new','confirmed','flaky','unconfirmed','dismissed','fixed','still_failing'])`
- `Finding = {id, scanId, signature, priority, title, expected, actual, steps: {n, text, tMs}[], evidence: {videoUrl?, traceUrl?, timelineUrl?, screenshotUrls: string[]}, status: FindingStatus, url, createdAt}`
- `ReplayTimeline = {runId, t0: number, durationMs, videoKey?, traceKey?, rrwebSegments: {index, startMs, endMs, url, key}[], steps: Step[], signals: Signal[], findings: {id, tMs}[]}`
- `Charter = {id, area, goal, persona?: string, type: 'happy_path'|'edge_input'|'navigation'|'permission'|'reproduce'|'regression', startPath, focus?, risk: number, viewport: 'desktop'|'mobile'}`
- `Scenario = {name, persona, allowed_actions: 'read_only'|'full', viewport?: 'desktop'|'mobile', starting_conditions?: string[], steps: string[] (min 1), outcomes: string[] (min 1), triggers?: string[]}`; `parseScenarioYaml(text: string): Scenario` (throws `ScenarioParseError` with `issues`); `scenarioJsonSchema(): object`
- `CliEnvelope<T> = {schemaVersion: 1, status: 'ok'|'error', errorCode?, retryable?, nextCommands?: string[], data: T}`; helper `cliEnvelope(schema)`.
- `JudgeVerdict = {isBug: boolean, priority: Priority, title, expected, actual, duplicateOf: string|null, reasoning}`.

- [ ] **Step 1: Write failing tests** — `action.test.ts`: parses each of the 14 action types; rejects `wait{ms:5000}`; rejects `goto{path:'https://evil.com'}`; rejects unknown `type`. `scenario.test.ts`: parses the example YAML below; `parseScenarioYaml('name: x\nsteps: []')` throws `ScenarioParseError` whose `issues` mention `steps` and `outcomes`; `scenarioJsonSchema()` has `required` containing `name`,`steps`,`outcomes`. `timeline.test.ts`: round-trip `ReplayTimeline.parse(JSON.parse(JSON.stringify(t)))` equals `t`.
  ```yaml
  name: Guest adds item to cart
  persona: guest
  allowed_actions: full
  steps: ["Open /shop", "Add 'Kayak' to cart"]
  outcomes: ["Cart badge shows 1"]
  triggers: ["/shop/**", "src/cart/**"]
  ```
- [ ] **Step 2:** `pnpm --filter @gremlin/contract test` → FAIL (modules missing).
- [ ] **Step 3:** Implement the schemas listed above.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(contract): shared zod schemas`.

### Task 3: Database schema

**Files:** `packages/db/src/schema.ts` (every table in spec §15 with the listed columns; ids `text` with `createId()` from `@paralleldrive/cuid2`; `*_json` → `jsonb`; timestamps `timestamptz default now()`), `src/index.ts`, `src/migrate.ts`, `drizzle.config.ts`, `test/db.test.ts`.

**Interfaces — Produces:** `createDb(url: string): Db` (Drizzle instance + `close()`); `migrate(db): Promise<void>`; table objects exported by name (`projects`, `apiKeys`, `environments`, `personas`, `scans`, `charters`, `agentRuns`, `steps`, `findings`, `findingOccurrences`, `scenarios`, `scenarioRuns`, `productMaps`, `playbooks`, `locatorMemory`, `noise`, `banditArms`, `promptVariants`, `llmUsage`).

- [ ] **Step 1: Failing test** `db.test.ts` (uses `DATABASE_URL`, creates a fresh schema `test_<random>` via `search_path`): migrate; insert project → environment → scan(status `queued`) → agent_run(kind `scan`) → step with `action_json` = a `click` action; select it back and assert `action_json` deep-equals; `findings.signature` + `project_id` unique index rejects a duplicate insert.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement schema; `pnpm drizzle-kit generate` produces `migrations/0000_*.sql`. Add unique index `(project_id, signature)` on `findings`, and `(project_id, state_hash, intent)` on `locator_memory`.
- [ ] **Step 4:** Test passes.
- [ ] **Step 5:** Commit `feat(db): drizzle schema and migrations`.

### Task 4: Storage

**Files:** `packages/storage/src/{index,fs,s3}.ts`, `test/storage.test.ts`.

**Interfaces — Produces:** `interface Storage { put(key: string, body: Buffer | Readable, contentType: string): Promise<void>; get(key): Promise<Buffer>; signedUrl(key, ttlSeconds = 3600): Promise<string>; exists(key): Promise<boolean> }`; `createStorage(env): Storage` (S3 when `S3_ENDPOINT` set, else `FsStorage(rootDir)`). Keys follow `scans/{scanId}/runs/{runId}/{file}`.

- [ ] **Step 1: Failing tests:** for both `FsStorage(tmpdir)` and `S3Storage` (MinIO from compose): put/get round-trip of a 1 MB buffer; `exists` false for a missing key; `signedUrl` fetches with HTTP 200 and the same bytes (Fs implementation returns a `file://` URL in tests; the engine serves it in Task 6).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `@aws-sdk/client-s3` (`forcePathStyle: true`) and `getSignedUrl`.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(storage): fs and s3 storage`.

### Task 5: LLM client

**Files:** `packages/llm/src/{config,client,usage,index}.ts`, `test/client.test.ts`.

**Interfaces — Produces:**
- `type Role = 'navigator'|'judge'|'mapper'|'healer'|'reflect'|'scenario'`
- `loadLlmConfig(env: Record<string,string|undefined>): LlmConfig` — `{apiKey, baseUrl, provider?: string, roles: Record<Role, {model, effort: 'low'|'medium'|'high'|'max', fallbackModel?}>, maxConcurrency: number (default 8)}`; per-role model override from `GREMLIN_MODEL_<ROLE>`.
- `createLlm(cfg, deps?: {fetch?: typeof fetch; onUsage?: (u: Usage) => void; now?: () => number}): Llm`
- `Llm.callTool<T>(role: Role, req: {system: string; messages: ChatMessage[]; tool: {name: string; description: string; schema: z.ZodType<T>}; images?: {mime: string; base64: string}[]}): Promise<{value: T; usage: Usage}>` — sends the OpenAI-format `tools` with `parameters = z.toJSONSchema(schema)` and `tool_choice` forcing that tool; `reasoning: {effort}`; `provider: {order: [provider], allow_fallbacks: false}` when pinned.
- `Usage = {role, model, tokensIn, tokensOut, latencyMs, costUsd: number|null}` (cost from the response `usage.cost` when present).
- `class LlmError extends Error { code: 'invalid_output'|'timeout'|'http'|'no_tool_call' }`

- [ ] **Step 1: Failing tests** with an injected `fetch` stub:
  - returns parsed `value` when the stub returns a valid tool call;
  - invalid arguments first, valid second → resolves, stub called twice, second request's last message contains the zod error text (repair turn);
  - invalid twice → rejects `LlmError` code `invalid_output`;
  - 429, 429, 200 → resolves after 3 calls; 500 ×4 → rejects code `http`;
  - request body for role `navigator` has `reasoning.effort === 'low'` and model `z-ai/glm-5.3-flash`;
  - `onUsage` called once per successful call with `tokensIn`/`tokensOut` from the response;
  - with `maxConcurrency: 2`, 5 parallel calls never have more than 2 in flight.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Timeout via `AbortSignal.timeout(30000)`; backoff `250ms * 2^attempt + random(0..250)`; a semaphore for concurrency.
- [ ] **Step 4:** Pass.
- [ ] **Step 5: Live smoke (manual):** `OPENROUTER_API_KEY=… pnpm --filter @gremlin/llm smoke` (script calls `callTool('navigator', …)` with a trivial `finish` tool). Expected: valid `{reason}` printed with latency. Record the latency in the commit message.
- [ ] **Step 6:** Commit `feat(llm): openrouter client with roles, repair, retries`.

### Task 6: Engine skeleton + Docker

**Files:** `apps/engine/src/{server,auth,queue,routes/scans}.ts`, `apps/engine/Dockerfile`, `test/scans.test.ts`.

**Interfaces — Produces:**
- `buildServer(deps: {db: Db; storage: Storage; queues: Queues}): FastifyInstance`
- `Queues = {discovery, agent, judge, confirm, live, reflect}` (BullMQ `Queue`s), `createQueues(redisUrl): Queues`
- Auth: `Authorization: Bearer <key>`; keys stored as sha256 hash in `api_keys`; `createApiKey(db, projectId): Promise<string>` returns plaintext `grm_<32 base62>` once.
- `GET /healthz` → `{ok: true}`; `POST /v1/scans` body `{url, teamSize?: 1..20 (default 5), focus?, allowedActions?: 'read_only'|'full' (default 'read_only'), authorised: true}` → 201 `{scanId}`, scan row `queued`, environment upserted by `base_url` origin; `GET /v1/scans/:id` → scan row; `GET /v1/files/*` serves FsStorage signed paths (HMAC-signed, 1h).

- [ ] **Step 1: Failing tests** (Fastify `inject`, real Postgres, BullMQ against compose Redis): no auth → 401; wrong key → 401; `authorised` missing → 400; valid → 201 and one job in `queues.discovery` with `{scanId}`; `GET` returns `status:'queued'`; another project's key → 404 for that scan.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Dockerfile `FROM mcr.microsoft.com/playwright:<version matching installed playwright>-noble`, pnpm `deploy --filter engine --prod`, `CMD node dist/server.js`. Run `docker build -t gremlin-engine . && docker run --rm -p 8080:8080 --env-file .env gremlin-engine` then `curl localhost:8080/healthz`. Expected `{"ok":true}`.
- [ ] **Step 6:** Commit `feat(engine): api skeleton, auth, queues, docker image`.

### Task 7: Deploy engine + dev tunnel

**Files:** `render.yaml` (web service from Dockerfile, env vars from §Task 1 list, health check `/healthz`), `scripts/tunnel.sh` (`cloudflared tunnel --url http://localhost:8080`, prints the https URL).

- [ ] **Step 1:** Provision Postgres (Supabase), Redis (Render Key Value or Upstash), storage (Supabase Storage S3 endpoint) — ask the user before creating anything billable.
- [ ] **Step 2:** Deploy; run `curl https://<engine>/healthz`. Expected `{"ok":true}`.
- [ ] **Step 3:** Run `scripts/tunnel.sh`; `curl <tunnel-url>/healthz` → `{"ok":true}`.
- [ ] **Step 4:** Commit `chore: render config and dev tunnel`.

### Task 8 [Alan]: Demo target with seeded bugs

Alan builds `apps/demo-target` (Next.js shop: guest/customer/admin personas, `/shop`, `/product/[id]`, `/cart`, `/checkout`, `/profile`, `/orders`, `/admin/orders`, `/search`, footer with Careers link). Claude writes the acceptance test **first**; it is Alan's definition of done.

**Files (Claude):** `apps/demo-target/tests/seeded-bugs.spec.ts` (Playwright test runner), `apps/demo-target/ALAN_BRIEF.md` (the brief to paste into Alan: routes, personas with credentials in `apps/demo-target/seed.json`, the 12 bugs from spec §19 verbatim, "make every test in seeded-bugs.spec.ts pass; do not modify the test file").

- [ ] **Step 1: Write `seeded-bugs.spec.ts`** — one `test()` per bug in §19, each asserting the bug **is present**, e.g. bug 1: set quantity input to empty → `getByTestId('cart-total')` has text `NaN`; bug 2: POST `/api/checkout` with `{coupon:'save10'}` → status 500; bug 3: customer with empty bio opens `/profile` → `pageerror` fires; bug 4: footer Careers → 404; bug 5: add item twice → cart badge `1`; bug 6: complete checkout, `goBack()` → orders count increases by 2 total; bug 7: search `'` → page text matches `/at .*\(.*:\d+:\d+\)/`; bug 8: axe reports `button-name` on the cart delete button; bug 9: customer `goto('/admin/orders')` → 200 and heading "All orders"; bug 10: at 390×844 the checkout button's bounding box `x + width > 390`; bug 11: LCP on `/product/1` > 4000 ms (web-vitals); bug 12: 30 requests to `/api/orders` → 5–15 have status 500. Plus 3 sanity tests that core happy paths work (browse, add to cart, login).
- [ ] **Step 2:** Write `ALAN_BRIEF.md`. Commit `test(demo-target): seeded bug acceptance suite and Alan brief`.
- [ ] **Step 3 (Alan):** Builds the app. **Verification (Claude):** `pnpm --filter demo-target test:bugs` → 15 passed. Deploy to Vercel; rerun against the deployed URL with `BASE_URL=<url>` → 15 passed.
- [ ] **Step 4:** Commit Alan's work `feat(demo-target): seeded-bug shop (built with Alan)`.

---

# Milestone 2 — Single agent end to end

Test fixtures: `packages/agent/test/server.ts` exports `startFixtureServer(): Promise<{url: string; close(): Promise<void>}>` serving `test/fixtures/` plus scripted endpoints (`/api/500`, `/api/slow` (6 s), `/api/ok`, `/api/echo` POST). Tests launch one shared Chromium per file.

### Task 9: URL helpers, observation

**Files:** `src/url.ts`, `src/inject/observe.js`, `src/observe.ts`; tests `test/url.test.ts`, `test/observe.test.ts`, `test/observe.budget.test.ts`, `test/observe.spa.test.ts`; fixtures `form.html`, `huge.html`, `spa.html`, `empty.html`.

**Interfaces — Produces:**
- `normalizePath(url: string): string` — path only, numeric and UUID segments → `:id`, trailing slash removed (root stays `/`).
- `stateHash(path: string, items: {role: string; name: string}[]): string` — sha1 hex of path + sorted `role:name` lines.
- `sameOrigin(a: string, b: string): boolean`
- `Interactable = {ref: string; role: string; name: string; value?: string; disabled: boolean; section?: string; inViewport: boolean}`
- `Observation = {url, path, stateHash, title, interactables: Interactable[], text: string, alerts: string[], rendered: string, tokenEstimate: number}`
- `observe(page: Page, opts?: {maxInteractables?: number; maxTextTokens?: number; previous?: Observation}): Promise<Observation>` — runs `inject/observe.js` via `page.evaluate`, which tags elements with `data-gremlin-ref` (stable per element across calls on the same document: reuse an existing attribute), returns raw items; viewport items first, cap at `maxInteractables` (150). `rendered` is the prompt text; with `previous` and identical `stateHash`, the interactables section says `(unchanged, N elements)`.
- `estimateTokens(s: string): number` = `Math.ceil(s.length / 4)`.

- [ ] **Step 1: Failing tests:**
  - `url.test.ts`: `normalizePath('https://a.com/orders/123/items/9f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c/')` → `/orders/:id/items/:id`; `stateHash` is order-independent over items.
  - `observe.test.ts` on `form.html` (label-wrapped inputs, a disabled button, a `role=alert` div, an `aria-label` icon button, a hidden button): interactables include the email input named "Email", disabled button `disabled:true`, icon button named by `aria-label`; hidden button absent; `alerts` contains the alert text; calling `observe` twice gives the same ref for the same element.
  - `observe.budget.test.ts` on `huge.html` (2000 links, 200 KB text): `interactables.length === 150`; `tokenEstimate <= 6000`.
  - `observe.spa.test.ts` on `spa.html` (pushState router with two views): click nav → new `stateHash`, `path` updated.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Accessible name: `aria-label` > `aria-labelledby` text > associated `<label>` > `placeholder` > `alt`/`title` > trimmed innerText (≤80 chars). Role: explicit `role` or implicit by tag/type. Section: nearest landmark/heading text.
- [ ] **Step 4:** Pass. **Step 5:** Commit `feat(agent): observation and state hashing`.

### Task 10: Settle, locators, secrets, policy, consent, execute

**Files:** `src/{settle,locator,secrets,policy,consent,execute}.ts`; tests `test/execute.test.ts`, `test/execute.badref.test.ts`, `test/execute.popup.test.ts`, `test/policy.test.ts`, `test/locator.test.ts`, `test/secrets.test.ts`; fixtures `actions.html`, `popup.html`, `consent.html`.

**Interfaces — Produces:**
- `settle(page, opts?: {quietMs?: number; capMs?: number}): Promise<{capped: boolean; ms: number}>` — tracks in-flight requests via context events and DOM mutations via an injected `MutationObserver`.
- `computeLocator(handle: ElementHandle): Promise<Locator>`; `resolveLocator(page, loc: Locator): Promise<ElementHandle | null>` (tries in priority order, requires exactly one match).
- `resolvePlaceholders(text: string, secrets: Record<string,string>): string` — `{{name}}`, `{{persona:x.y}}` (key `persona:x.y`), `{{fuzz:<kind>}}` with fixed values: `empty` `""`, `whitespace` `"   "`, `long` 5000 × `"a"`, `unicode` `"😀 Ünïcödé 漢字"`, `rtl` `"مرحبا بالعالم"`, `negative` `"-1"`, `zero` `"0"`, `huge` `"99999999999999999999"`, `quotes` `` `'"<>` ``.
- `redact(text: string, secrets: Record<string,string>): string` — replaces every secret value with `•••`.
- `installPolicy(context, opts: {origin: string; allowedActions: 'read_only'|'full'; authAllowlist: string[]; extraHosts?: string[]}): Promise<{blocked: Signal[]}>` — aborts as per §14; blocked third-party payment hosts list: `stripe.com`, `checkout.stripe.com`, `paypal.com`, `*.paypal.com`, `adyen.com`, `squareup.com`.
- `dismissConsent(page): Promise<boolean>` — clicks a visible button matching `/^(reject( all)?|decline|necessary only|only necessary)$/i` inside a likely banner (`[id*=cookie i], [class*=consent i], [aria-label*=cookie i]`); returns whether clicked.
- `ExecContext = {secrets: Record<string,string>; origin: string; fixturesDir: string}`
- `ExecResult = {outcome: StepOutcome; locator: Locator | null; error?: string}`
- `execute(page, action: Action, ctx: ExecContext): Promise<ExecResult>` — non-DOM actions (`expect`, `report_bug`, `finish`) return `{outcome:'ok', locator:null}` without touching the page.

- [ ] **Step 1: Failing tests:**
  - `execute.test.ts` on `actions.html`: `click`, `type` (+`submit:true` submits the form; the echo endpoint receives the value), `select`, `press('Enter')`, `hover` reveals a tooltip, `scroll`, `goto('/form.html')`, `back`, `refresh`, `wait(100)`; each returns `outcome:'ok'` and (for ref actions) a locator whose first available field matches priority (button with `data-testid` → `testId`; button without → `role`).
  - `execute.badref.test.ts`: `click{ref:'e999'}` → `{outcome:'error', error: /ref e999 not found/}`, page unchanged.
  - `execute.popup.test.ts` on `popup.html`: click a `target=_blank` same-origin link → popup closed, the agent's page URL is the link target; click an off-origin `window.open` → popup closed, page URL unchanged, outcome `ok`.
  - `policy.test.ts`: `read_only` → POST to `/api/echo` aborted and `blocked` has a `policy` signal; GET allowed; `full` → POST allowed; navigation to `https://example.org` aborted in both modes; request to `checkout.stripe.com` aborted in `full`.
  - `locator.test.ts`: `resolveLocator(computeLocator(h))` returns the same element after the DOM is re-rendered with a new ref attribute.
  - `secrets.test.ts`: `resolvePlaceholders('{{password}}', {password:'hunter2'})` → `hunter2`; `{{fuzz:long}}` length 5000; `redact('x hunter2 y', {password:'hunter2'})` → `x ••• y`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (popups: `context.on('page')`). **Step 4:** Pass. **Step 5:** Commit `feat(agent): action execution, settle, locators, policy`.

### Task 11: Recorder

**Files:** `src/recorder/{index,rrweb-inject,timeline}.ts`; tests `test/recorder.test.ts`, `test/recorder.spa.test.ts`.

**Interfaces — Produces:**
- `startRecording(context: BrowserContext, opts: {runId: string; t0: number; storage: Storage; keyPrefix: string; tmpDir: string; secrets: Record<string,string>; origin: string}): Promise<Recorder>` — must be called before the first page opens; context must have been created with `recordVideo: {dir: tmpDir, size: {width:1280, height:800}}` and `t0 = Date.now()` captured immediately after `newContext()`.
- `Recorder = { t0: number; now(): number; drainSignals(): Signal[]; addStep(step: Step): void; addFinding(id: string, tMs: number): void; stop(): Promise<{timelineKey: string; videoKey?: string; traceKey: string; rrwebKeys: string[]}> }`
- rrweb: `rrweb.record({emit, maskAllInputs: false, maskInputOptions: {password: true}, recordCanvas: true})` injected with `context.addInitScript` from the bundled rrweb UMD; events batched every 250 ms through `context.exposeBinding('__gremlinEmit')`; a new segment starts on each document load (detected by the init script running); pushState navigations stay in the same segment and emit a `navigation` signal.
- Network capture per Global Constraints; bodies stored at `{keyPrefix}/bodies/{n}.txt` after `redact`.
- `buildTimeline(parts): ReplayTimeline` (pure; sorts signals by `tMs`).

- [ ] **Step 1: Failing tests:**
  - `recorder.test.ts` on `actions.html` + `/api/500`: run 3 actions via `execute`, trigger a console error and a fetch to `/api/500`, stop. Assert: timeline parses as `ReplayTimeline`; video key exists in storage with size > 0; `trace.zip` exists; ≥1 rrweb segment with >0 events; the console signal and the network signal (status 500, with `bodyKey`) exist; for each step, `|step.tMs − tMs of the first rrweb event after the action| ≤ 100`; a typed password value appears in no stored artifact (scan every stored object's bytes).
  - `recorder.spa.test.ts` on `spa.html`: pushState navigation → still 1 segment, plus a `navigation` signal; a full navigation → 2 segments with `startMs` increasing.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(agent): recorder with unified timeline`.

### Task 12: Oracles

**Files:** `src/oracles/{index,crash,console,network,http,errorText,blank,slow}.ts`; tests `test/oracles.test.ts` (pure, fixture inputs) and `test/oracles.e2e.test.ts` (one fixture page per oracle + `clean.html`).

**Interfaces — Produces:**
- `OracleInput = {step: Step; signals: Signal[]; observation: Observation; prevObservation?: Observation; origin: string; loggedIn: boolean; settleCappedCount: number}`
- `type Oracle = (input: OracleInput) => Candidate[]`
- `runOracles(input: OracleInput, opts?: {suppressed?: Set<string>}): Candidate[]` — runs all, drops suppressed signatures.
- `signatureFor(oracle: OracleKind, url: string, message: string): string` — sha1 of `oracle + normalizePath(url) + normalizeMessage(message)`; `normalizeMessage` strips numbers, hex ≥8 chars, UUIDs, ISO timestamps, quoted strings >40 chars.
- Severity defaults and rules exactly as spec §7 for `crash`, `console`, `network`, `http`, `error_text`, `blank`, `slow`. The `console` vendor-noise list ships as `oracles/noise.ts` (`/favicon\.ico/`, `/Download the React DevTools/`, `/\[HMR\]/`, `/ResizeObserver loop/`).

- [ ] **Step 1: Failing tests:**
  - pure: a `pageerror` → one `crash` P1; 500 same-origin → `network` P1; 404 XHR → P2; 401 with `loggedIn:false` → none; 503 to a third-party host → none; text "Total: NaN" → `error_text` P2; text "Not a number" → none; body text 5 chars + 0 interactables → `blank` P1; `settleCappedCount: 3` → `slow` P3; `signatureFor` equal for `/orders/12` "id 12 failed" and `/orders/99` "id 99 failed".
  - e2e: each fixture fires exactly its oracle; `clean.html` fires none.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(agent): deterministic oracles`.

### Task 13: Navigator loop

**Files:** `src/prompts.ts`, `src/loop.ts`; tests `test/loop.test.ts`, `test/loop.badaction.test.ts`, `test/loop.secrets.test.ts` (all with a scripted fake `Llm`).

**Interfaces — Consumes:** `Llm.callTool` (Task 5), `observe` (9), `execute`/`settle`/`installPolicy`/`dismissConsent` (10), `startRecording` (11), `runOracles` (12).
**Produces:**
- `NAVIGATOR_SYSTEM` (fixed rules: safety, one action per turn, state an `expect` before actions whose outcome matters, never invent refs, use placeholders for credentials) and `navigatorTool` = `{name:'act', schema: Action}`.
- `RunAgentOpts = {browser: Browser; baseUrl: string; charter: Charter; llm: Llm; storage: Storage; runId: string; keyPrefix: string; secrets: Record<string,string>; allowedActions: 'read_only'|'full'; authAllowlist?: string[]; storageState?: string; playbook?: string; budgets?: {steps?: number; ms?: number; tokens?: number}; suppressed?: Set<string>; onEvent?: (e: AgentEvent) => void}`
- `AgentEvent = {type:'step'; step: Step; screenshotKey?: string} | {type:'candidate'; candidate: Candidate} | {type:'status'; status: AgentStatus}`
- `AgentStatus = 'running'|'finished'|'budget_steps'|'budget_time'|'budget_tokens'|'stuck'|'error'`
- `runAgent(opts): Promise<{status: AgentStatus; steps: Step[]; candidates: Candidate[]; expectations: {stepN: number; statement: string; before: Observation; after: Observation}[]; artifacts: {timelineKey; videoKey?; traceKey; rrwebKeys: string[]}; tokens: number}>`
- Prompt content per step: charter (goal, persona, type, focus), playbook excerpt (if any), last 8 actions with outcomes, running summary, `observation.rendered`, signals since last step (already redacted). No images in M2; the §6.1 vision fallback arrives in M8.
- Per step: `dismissConsent` → `observe` → `llm.callTool('navigator')` → `execute` → `settle` → `observe` (after) → `runOracles` → screenshot JPEG q60 to storage → `recorder.addStep`. `report_bug` becomes a candidate with oracle `agent_report`; `expect` opens an expectation that is closed by the next non-expect action's after-observation.

- [ ] **Step 1: Failing tests:**
  - `loop.test.ts`: fake LLM scripted `click(add) → expect("badge shows 1") → click(add) → finish` on `cart.html` fixture → `status:'finished'`, 4 steps, 1 expectation captured with before/after observations; with a script of 50 clicks → `status:'budget_steps'` at 40; 3 clicks on an inert element → `status:'stuck'`.
  - `loop.badaction.test.ts`: fake LLM throws `LlmError('invalid_output')` once then `finish` → steps[0].outcome `model_error`, final status `finished`; a click on `e999` → step outcome `error`, loop continues.
  - `loop.secrets.test.ts`: script `type(email,'{{username}}') → type(pw,'{{password}}', submit) → finish` with secrets `{username:'ann@x.io', password:'S3cret!x'}` → every prompt string the fake LLM received, every persisted `Step` JSON, and every stored artifact byte stream contains no `S3cret!x`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(agent): navigator loop with budgets`.

### Task 14: Judge

**Files:** `src/judge.ts`; test `test/judge.test.ts` (fake LLM).

**Interfaces — Produces:**
- `JudgeVerdict` from `@gremlin/contract` (Task 2).
- `judgeCandidate(llm: Llm, input: {candidate: Candidate; recentSteps: Step[]; beforeShot?: Buffer; afterShot?: Buffer; existing: {id: string; title: string}[]}): Promise<JudgeVerdict>`
- `judgeExpectation(llm, input: {statement: string; before: Observation; after: Observation; recentSteps: Step[]}): Promise<JudgeVerdict & {held: boolean}>` — `held:true` means no bug.

- [ ] **Step 1: Failing tests:** prompt sent to role `judge` includes the candidate message and the last 5 steps only (given 8); screenshots go as images; a verdict with `duplicateOf` pointing to an id not in `existing` is coerced to `null`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(agent): judge`.

### Task 15: Engine worker + persistence + `scan-one`

**Files:** `apps/engine/src/{worker,persist}.ts`, `src/scripts/scan-one.ts`; test `test/worker.test.ts`.

**Interfaces — Consumes:** `runAgent`, `judgeCandidate`, `judgeExpectation`, `createDb`, `createStorage`, `createLlm`.
**Produces:**
- `processAgentJob(deps: {db; storage; llm; browser}, job: {scanId: string; runId: string; charter: Charter}): Promise<void>` — runs the agent; persists `agent_runs` (artifact keys, tokens, status) and `steps`; for each candidate: dedupe by `(project_id, signature)` (existing → add `finding_occurrences` only), else judge → insert `findings` with status `new` (or `dismissed` when `isBug:false`); each closed expectation → `judgeExpectation`, a `held:false` verdict becomes a finding with oracle `expectation`; writes `llm_usage` rows via `onUsage`.
- Worker bootstrap `startWorkers(deps)` consuming the `agent` queue with concurrency `GREMLIN_CONTEXTS_PER_WORKER` (default 3) over one shared Chromium.
- `pnpm --filter engine scan:one <url> "<goal>" [--persona name] [--full]` — creates project/env/scan/run rows, runs `processAgentJob` inline, prints findings (priority, title, signature) and the timeline signed URL, plus per-step p50/p95 navigator latency and total tokens/cost.

- [ ] **Step 1: Failing test** (fake LLM scripted against the fixture server's `cart.html` whose second "add" makes `/api/cart` return 500): one finding `network` P1 persisted; running the same job again adds an occurrence, not a second finding; a judge `isBug:false` candidate is stored `dismissed`; `llm_usage` has one row per fake call.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass.
- [ ] **Step 5: Live acceptance (manual, real GLM):** with demo-target running, `pnpm --filter engine scan:one $DEMO_URL "Add a product to the cart, then clear the quantity field and review the total" --full`. Expected: a finding for bug 1 (`error_text`, `NaN`) and a timeline URL that downloads a valid `ReplayTimeline`. Record p50 step latency and success. **Decision gate:** if p50 navigator latency > 8 s or the agent fails to reach the cart in 3 attempts, set `GREMLIN_MODEL_NAVIGATOR` to a stronger OpenRouter model, re-run, and note the result in the commit.
- [ ] **Step 6:** Commit `feat(engine): agent worker, persistence, scan-one`.

---

# Later milestones (each gets its own detailed plan when started)

| # | Plan | Deliverable | Consumes from M1–M2 |
|---|---|---|---|
| M3 | Replay UI | `apps/web` replay page: video + rrweb DOM modes, synced step list/timeline/devtools (console, network, element, agent), compare view, share links; `GET /v1/runs/:id/timeline`, `/rrweb/:segment` | `ReplayTimeline`, `Step`, `Signal`, storage signed URLs |
| M4 | Swarm | discovery crawler + `dead_link`, mapper, charters, personas + auth recipes, coverage sharing, SSE live view, scan state machine, confirmation replays | `runAgent`, `observe`, `stateHash`, queues, `processAgentJob` |
| M5 | Alan plugin | MCP Streamable HTTP server (10 tools, API key), `plugins/gremlin` manifest/mcp.json/skills, marketplace repo, `validate.mjs`, install in Alan, then OAuth DCR | engine API, findings, scans |
| M6 | Replay actions | deterministic replayer, live re-run (screencast over WebSocket), verify-fix, Playwright `.spec.ts` + YAML exports, fix prompt | `Locator`, `resolveLocator`, recorder, oracles |
| M7 | Self-improvement | app memory, locator memory, noise list, regression net + `run_relevant_scenarios`, playbook reflect with versions/revert, bandit, fix-loop variants, metrics panel | findings, steps, charters, judge outcomes |
| M8 | Breadth | scenarios runner + editor, CLI, GitHub Action, `a11y`/`layout`/`vitals`/`permission` oracles, vision fallback, healer, mobile viewport | everything above |
| M9 | Ship | deploy web/engine/demo-target, full acceptance (§1), demo script, X post | all |
