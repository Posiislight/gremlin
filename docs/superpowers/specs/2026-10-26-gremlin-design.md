# Gremlin: self-improving browser-agent QA for Alan (design spec v3)

Working name **Gremlin**. An Alan plugin (remote MCP server + skills) backed by a QA engine. Point it at a web app: it maps the product, a swarm of browser agents tests it, every bug comes back with a full replay (video, inspectable DOM, devtools timeline, live re-run), a confirmation verdict, and a handoff a coding agent can act on. Every run makes the next one better.

## 1. Intent
- **Goal:** the best possible product for OpenFire; scope is not cut for time. Build order (§20) still puts the most demo-critical parts first.
- **Positioning:** Alan already has "Testing evidence" (agent-written report, screenshots/recordings, Pass/Fail/Mixed). Its docs mention no step replay, no devtools logs, and no learning across runs. Gremlin plugs into Alan and adds exactly those, and goes beyond Composal with inspectable DOM replay, live re-run, verify-fix, and a measurable self-improvement loop.
- **System model:** GLM 5.3 Flash via OpenRouter (`z-ai/glm-5.3-flash`): tool calling, structured output, image input; reasoning always on (default effort max), so effort is set per role.
- **Acceptance (headline):** against `apps/demo-target` (12 seeded bugs, §19): scan 1 finds ≥9/12 with ≤2 false positives, all confirmed by replay; scan 2 on the same app is measurably cheaper/faster with fewer false positives; an Alan agent, through the plugin, fixes a bug and Gremlin verifies the fix live.

## 2. Design principles
1. **The LLM navigates and judges; deterministic oracles detect.** Console errors, failed requests and crashes are facts. Semantic bugs come from expectations the agent states *before* acting.
2. **One clock, one recording, many views.** Video, DOM events, console, network and agent steps share a timeline so every view syncs.
3. **Everything is replayable without the model.** Actions are stored as robust locators.
4. **Learning is explicit, versioned and reversible.** Every change the system makes to itself is a diff a human can read and revert.
5. **The model never sees secrets; safety rules are not learnable.**
6. **Bounded everything:** steps, time, tokens and money per agent and per scan.

## 3. Topology
```
Alan (desktop/cloud agents) ──MCP (Streamable HTTP, https)──┐
gremlin CLI / GitHub Action ──REST──────────────────────────┤
apps/web (Next.js, Vercel) ──REST + SSE + WebSocket─────────┤
                                                            v
                                apps/engine (Fastify API + MCP endpoint + BullMQ workers)
                                Docker (mcr.microsoft.com/playwright base) on Render/Fly
                                  │             │                         │
                    Postgres (Supabase)   Redis (queues, pub/sub,     Object storage
                                          coverage, live frames)      (video, rrweb, traces)
                                  │
                              OpenRouter (GLM 5.3 Flash, per-role config)
```
Packages (pnpm workspaces + Turborepo, Node 24, TypeScript strict, Drizzle ORM):

| Package | Purpose |
|---|---|
| `packages/contract` | zod schemas + types; JSON Schema export for scenarios |
| `packages/llm` | OpenRouter client, roles, validation/repair, usage accounting |
| `packages/agent` | observation, actions, settle, oracles, agent loop |
| `packages/recorder` | video/rrweb/console/network capture on one clock; timeline builder |
| `packages/replay` | deterministic replayer, live re-run, verify-fix |
| `packages/knowledge` | app memory, playbook, bandit charter selection, reflect job |
| `apps/engine` | API, MCP server, workers, orchestrator |
| `apps/web` | dashboard + replay UI |
| `packages/cli` | `gremlin` CLI |
| `plugins/gremlin` | Alan plugin (manifest, `mcp.json`, skills) |
| `apps/demo-target` | seeded-bug app |

During development the engine is exposed over https with a tunnel (cloudflared) because Alan only accepts remote https MCP servers.

## 4. Alan plugin
Verified from `tryalan-ai/plugins` CONTRIBUTING: plugins bundle **remote https MCP servers only** (no stdio), declared as `{"type":"http","url":...}`, with optional `headers` (API key, Alan prompts the user and stores it encrypted) or OAuth with dynamic client registration (preferred, one click). The team-level **Add custom connector** button is documented only as "for your own MCP server"; its form fields are not documented, so confirm in the app (expected: URL + headers).

Layout (Alan plugin spec):
```
plugins/gremlin/
  .cursor-plugin/plugin.json   name, displayName, version, description, author, homepage,
                               repository, license, category, keywords, mcpServers:"./mcp.json", skills:"./skills/"
  mcp.json                     {"mcpServers":{"gremlin":{"type":"http","url":"https://<engine>/mcp",
                                 "headers":{"Authorization":"Bearer ${GREMLIN_API_KEY}"}}}}
  skills/gremlin-qa/SKILL.md
  skills/gremlin-fix/SKILL.md
.cursor-plugin/marketplace.json  (repo root; lets a team add this repo via Plugins → Add marketplace)
```
Validated with the plugin repo's `scripts/validate.mjs` and an authenticated `tools/call` (not just `initialize`).

**Auth:** API key header first; then OAuth 2.1 with dynamic client registration + protected-resource metadata on the engine, so Alan can connect in one click.

**MCP tools** (Streamable HTTP at `/mcp`):
| Tool | Purpose |
|---|---|
| `get_playbook(projectId)` | current playbook + app memory summary; skills call this first |
| `start_scan({url\|environmentId, teamSize, focus, allowedActions, personas?})` | Deep Scan |
| `get_scan(scanId)` / `wait_scan(scanId, timeoutS)` | status, progress, cost |
| `list_findings({scanId, status?, limit})` | trimmed fields + `truncated` flag |
| `get_finding(id)` | expected/actual, steps, signals, replay URL |
| `get_fix_prompt(id)` | handoff prompt + generated Playwright test |
| `run_relevant_scenarios({projectId, changedFiles[], changedRoutes[], url})` | regression net |
| `run_scenarios({ids\|yaml[], url})` | explicit runs |
| `verify_fix({findingId, url})` | live deterministic re-run against a new URL |
| `report_fix_outcome({findingId, promptVariant, outcome})` | closes the fix loop when the agent knows |

**Skills** (frontmatter `name` = directory name, `description` says when to use):
- `gremlin-qa`: when an agent changes a user-facing flow: call `get_playbook`, then `run_relevant_scenarios` with the changed files/routes; if the change is new surface, `start_scan` with `focus`; paste the replay link and verdicts into Alan's Testing evidence report (Pass/Fail/Mixed mapping: all passed → Pass; any confirmed failure → Fail; blocked/flaky only → Mixed).
- `gremlin-fix`: for a finding: `get_fix_prompt`, make the generated test pass without weakening it, deploy/preview, `verify_fix`, report outcome.

Because the skill always starts with `get_playbook`, it improves without republishing the plugin.

## 5. LLM layer (`packages/llm`)
OpenAI-compatible client to OpenRouter; model, `reasoning.effort`, provider pin and fallback come from config **per role**:

| Role | Effort | Input | Output |
|---|---|---|---|
| `navigator` | low | observation + charter + playbook excerpt + recent history | one tool call |
| `judge` | high | candidate + evidence + existing findings in area | verdict |
| `mapper` | medium | compressed crawl graph + prior product map | product map + charters |
| `healer` | low | failed locator + snapshot + locator memory | replacement ref |
| `reflect` | max | run stats + current playbook | playbook diff |
| `scenario` | medium | scenario step + observation | tool call / outcome verdict |

- zod-validated tool calls; one repair turn on invalid output, then `model_error` is recorded and the agent continues.
- Stable prefix (system prompt, tool schema, playbook) first to benefit from prompt caching.
- Token-bucket concurrency limiter; 429/5xx retry with jitter (max 3); 30s timeout.
- `llm_usage` row per call (role, tokens, latency, cost). Navigator model can be swapped by config if GLM Flash is too weak; measured early (§20, phase 2).

## 6. Browser agent (`packages/agent`)

### 6.1 Observation
- **Interactables:** visible, enabled elements (links, buttons, inputs, selects, `[role]`, `[onclick]`, `[contenteditable]`) tagged `data-gremlin-ref="e12"`, one line each: `e12 button "Add to cart" [disabled] (section: Product)`. Capped at ~150, viewport first.
- **Text digest:** headings, alerts/toasts (`[role=alert]`, `aria-live`), form errors, truncated main text (~1.5k tokens).
- **Signals since last step:** console errors, failed/4xx/5xx requests, navigations.
- **Diff mode** after step 1.
- **Vision fallback:** fewer than 3 interactables, a repeated no-op, or canvas-heavy page → JPEG screenshot with set-of-marks labels on refs.
- **Memory hints:** known noise and known-good locators for this state from app memory.

Budget ~6k input tokens per step.

### 6.2 Action space
`click(ref)`, `type(ref, text, submit?)`, `select(ref, option)`, `press(key)`, `hover(ref)`, `scroll(direction)`, `upload(ref, fixture)`, `goto(path)` (same origin), `back()`, `refresh()`, `wait(ms≤3000)`, `expect(statement)`, `report_bug(title, expected, actual, severity_hint)`, `finish(reason)`.
Placeholders in text: `{{username}}`, `{{password}}`, `{{persona:<name>.<field>}}`, `{{fuzz:<kind>}}`, resolved at execution.

### 6.3 Execution and settling
Resolve ref → element, execute with Playwright auto-wait (5s). Settle: no in-flight requests and no DOM mutations for 500ms, capped at 4s. Auto-dismiss common cookie/consent banners (choose "reject"/"necessary only") before each step. Store a **robust locator** per action, in priority order: `data-testid` > role + accessible name > label/placeholder > text > CSS path, plus the intent string the navigator gave.

### 6.4 Loop and budgets
Per agent: 40 steps, 5 min, 150k tokens (configurable). Stop on `finish`, budget, or 3 consecutive no-op steps. History: last 8 actions + running summary.

### 6.5 State hashing
`stateHash = sha1(normalizedPath + sorted interactable role/name set)`; numeric and UUID path segments → `:id`. Used for no-op detection, coverage sharing, the discovery graph and app memory.

### 6.6 Personas and viewports
A scan can define up to 4 personas (e.g. signed-out, customer, admin), each with its own credentials and saved `storageState`. Charters are assigned a persona. Optional viewport matrix: desktop 1280×800 and mobile 390×844 (mobile emulation).

## 7. Bug detection: oracles → candidates → judge

| Oracle | Signal | Default severity |
|---|---|---|
| `crash` | `pageerror` (uncaught exception) | P1 |
| `console` | `console.error` (vendor noise list + learned noise) | P2 |
| `network` | 5xx same-origin; 4xx on XHR/fetch except expected 401/404 | P1 / P2 |
| `http` | document response ≥400 | P1 |
| `dead_link` | crawled link ≥400 | P3 |
| `error_text` | visible `NaN`, `undefined`, `null`, `[object Object]`, "something went wrong", stack traces | P2 |
| `blank` | body text <20 chars and no interactables after settle | P1 |
| `a11y` | axe-core critical/serious violations, once per state | P3 |
| `layout` | horizontal overflow, overlapping interactables, offscreen primary buttons (mobile viewport) | P3 |
| `vitals` | LCP >4s, CLS >0.25, INP >500ms (web-vitals injected) | P3 |
| `slow` | request >5s or settle cap hit 3× on one page | P3 |
| `permission` | persona reaches a page/action its role should not (judge-confirmed) | P1 |
| `expectation` | `expect` judged false | judge |
| `agent_report` | `report_bug` | judge |

The **judge** (effort high) receives the candidate, last 5 steps, before/after screenshots, raw signals and existing findings in the area; returns `{isBug, priority, title, expected, actual, duplicateOf, reasoning}`. Rejected candidates are kept as `dismissed`, visible behind a filter, and feed the noise list.

## 8. Discovery, charters, swarm

### 8.1 Discovery
1. Per persona: run its login recipe (from app memory if known, else an LLM-driven login charter), save `storageState`.
2. Crawl: BFS over same-origin links and nav-like clickables, depth 3, 60 states, read-only. Graph: nodes = states, edges = actions.
3. Incremental mode: if app memory has a map younger than 24h, only re-crawl states whose path is new or whose hash changed.
4. Mapper → **Areas → Features → Flows**, merged into the stored product map, plus charters.

### 8.2 Charters
`{id, area, goal, persona, type, startPath, focus, risk, viewport}`. Types: `happy_path`, `edge_input` (fuzz set: empty, whitespace, 5k chars, unicode/emoji, RTL, negative, 0, huge numbers, quotes/`<>`; needs `allowedActions=full`), `navigation` (back/refresh/deep-link mid-flow, double submit, two tabs), `permission` (lower persona tries higher persona's URLs/actions), `reproduce` (user-supplied bug report), `regression` (saved scenario).

Charter selection: the bandit in §11.2, round-robin across areas, top-N by score for team size N.

### 8.3 Orchestration
- BullMQ queues `discovery`, `agent`, `judge`, `confirm`, `live`, `reflect`. One Chromium per worker process, K isolated contexts (default 3).
- **Coverage sharing:** Redis set `scan:{id}:visited`; navigator is told which states in its area are covered.
- Scan state machine: `queued → discovering → scanning → confirming → reflecting → done | failed | partial`.
- Events (step, thumbnail, candidate, finding, cost) → Redis pub/sub → SSE to dashboard.
- Scan cost cap (default $2) and concurrency cap per target (1 running scan).

## 9. Recording (`packages/recorder`)
All streams share `t0` = context creation time; every event stores `tMs = wallClock − t0`.

| Stream | How | Stored as |
|---|---|---|
| Video | `recordVideo` 1280×800 webm (starts at context creation) | `video.webm` |
| DOM | rrweb `record()` injected via `context.addInitScript`; events batched (250ms) through `page.exposeBinding('__gremlinEmit')`; each page load starts a new segment; inputs masked (`maskAllInputs` for password/secret fields) | `rrweb.ndjson.gz` with segment index |
| Console | `page.on('console'/'pageerror')` with source location | in `timeline.json` |
| Network | `context.on('request'/'response'/'requestfailed')`: method, URL, status, timing, sizes; request/response bodies for failed (≥400) or same-origin XHR up to 64KB, secrets redacted | in `timeline.json`, large bodies as separate objects |
| Steps | action, locator, intent, expectation, model reasoning summary, tokens, screenshot | `steps` table + `timeline.json` |
| Trace | Playwright tracing (screenshots, snapshots, sources) | `trace.zip` (opens in trace.playwright.dev) |

`timeline.json` (`ReplayTimeline` in contract): `{t0, durationMs, videoUrl, rrwebSegments[{startMs,endMs,url,key}], steps[], console[], network[], signals[], findings[{id,tMs}]}`. Uploads happen after context close; until then the UI shows step screenshots.

## 10. Replay (`packages/replay` + replay UI)

### 10.1 Replay page (hero UI)
```
┌──────────── steps ─────────────┬──────────── player ───────────────┬──── devtools ─────┐
│ 1 goto /shop            ✓      │  [ Video | DOM ]                  │ Console Network   │
│ 2 click "Add to cart"   ✓      │                                   │ Element Agent     │
│ 3 expect "count = 2"    ✗ ◀    │   (DOM mode: target element       │                   │
│ 4 click "Checkout"      ·      │    highlighted, page inspectable) │ (synced to        │
│                                │                                   │  playhead)        │
├────────────────────────────────┴───────────────────────────────────┴───────────────────┤
│ timeline ▮──●──────●──▲──────■──────────────  (● steps ▲ console error ■ failed request) │
└────────────────────────────────────────────────────────────────────────────────────────┘
 [Replay live] [Verify fix on URL…] [Export Playwright] [Export YAML] [Copy fix prompt] [Share]
```
- One playhead drives everything. Clicking a step, a timeline marker, a console line or a network row seeks all views.
- **Video mode:** `<video>` seeks to `tMs`.
- **DOM mode:** `rrweb-player` Replayer; segment chosen by `tMs`; the acted-on element (found via `data-gremlin-ref` in the recorded DOM) gets an overlay; pause and hover to inspect elements, read their attributes and computed text. Scales to any viewport, crisp at any zoom.
- **Devtools panel:** Console (level filter, source location), Network (waterfall, status, timing, bodies for failures), Element (target element HTML/attributes at that step, before/after), Agent (intent, expectation, model reasoning summary, tokens).
- Keyboard: space play/pause, ←/→ previous/next step, `v`/`d` switch mode.
- **Share:** signed read-only link to the replay (used in Alan reports and PR comments).
- **Compare:** two runs side by side (failing run vs. fixed run), playheads aligned by step number.

### 10.2 Deterministic replayer
Replays a stored locator sequence in a fresh context with the same persona, viewport and seed, no LLM; re-checks the original failing oracle or expectation at the failing step. Locator miss → locator memory → `healer` once per step → else `replay_broke`. Produces its own recording, so every replay is itself replayable.

### 10.3 Live re-run
"Replay live" enqueues a `live` job; the worker runs the deterministic replayer and streams `Page.startScreencast` JPEG frames plus step events over WebSocket (via Redis) to the UI, highlighting the current step; ends with `reproduced` / `not_reproduced`.

### 10.4 Verify fix
Same as live re-run against a different base URL (preview deploy). Pass → finding `fixed`; still failing → `still_failing` with a new replay to compare.

### 10.5 Confirmation
After a scan, each finding is replayed: reproduced → `confirmed`; else 2 more: any hit → `flaky (k/3)`, none → `unconfirmed`.

## 11. Self-improvement (`packages/knowledge`)
A `reflect` job runs after every scan and every scenario/verify batch. Everything it changes is versioned with a diff in the UI and can be reverted.

### 11.1 App memory
- **Product map:** merged across runs, with `lastSeen` per state.
- **Auth recipes:** per persona, the step sequence that logged in, reused next time (falls back to LLM if it breaks).
- **Locator memory:** `(stateHash, intent) → locator` with success/failure counts; consulted before the healer.
- **Noise list:** signatures dismissed by the judge or a user twice are suppressed (shown as "suppressed: n" in the UI, never hidden silently).
- **State graph:** used for incremental discovery and for routing agents to under-tested states.

### 11.2 Playbook rewrites + charter bandit
- Per project, `playbook` (versioned markdown, ≤2k tokens): tactics that found bugs, area risk notes, things to avoid. The `reflect` model gets run stats (per charter: findings, confirmed, false positives, flakes, steps, cost) and returns a diff; it is applied as a new version.
- Fixed safety rules and the tool schema live outside the playbook and cannot be changed by it.
- **Charter bandit:** each `(area, charterType)` arm keeps a Beta posterior over "produces a confirmed finding"; selection uses Thompson sampling weighted by cost, with a floor so every area is still tested.

### 11.3 Regression net
- Every confirmed finding becomes a scenario with `triggers`: route globs from the area's URLs and source-file globs from stack traces / source maps / failing endpoint handlers.
- `run_relevant_scenarios` matches `changedFiles`/`changedRoutes` against triggers, plus an LLM relevance pass for scenarios with no trigger match; returns selected scenarios with a confidence score.

### 11.4 Fix-loop learning
- Finding lifecycle: `confirmed → handed_off(promptVariant) → verifying → fixed | still_failing`.
- Prompt templates are variants; outcomes are counted per variant; the default becomes the variant with the best fix rate (with exploration).
- Dashboard metric: fix rate, median time to fix, per variant.

### 11.5 Improvement metrics (shown in UI)
Per scan vs. previous scan on the same project: tokens, cost, wall time, steps per finding, false-positive rate, confirmed findings, regression catches. This is the "it learns" demo panel.

## 12. Scenarios
- YAML: `name, persona, allowed_actions, viewport, starting_conditions, steps[], outcomes[], triggers[]`, zod-validated with exported JSON Schema for editor validation.
- Runner: `scenario` role executes steps as goals; outcomes become `expect` checks. Result `passed | failed | blocked`.
- Fast path: if a scenario has a recorded locator sequence from a previous pass, run it deterministically first and use the LLM only on a locator miss.
- Exports from a confirmed finding: scenario YAML and a **deterministic Playwright `.spec.ts`** (locator sequence + assertion for the failing oracle).
- Dashboard: scenario list, YAML editor with schema validation and inline errors, run history with replays.

## 13. Coding-agent handoff
`get_fix_prompt` / `GET /v1/findings/:id/prompt` renders: title, priority, expected/actual, repro steps, replay link, raw signals (source-mapped stack `file:line` when source maps are public, failing endpoint + status + response body), the generated Playwright test, and "make this test pass without weakening it, then call `verify_fix`". Copy buttons for Alan, Claude Code, Codex, Cursor.

## 14. Safety
- **Read-only at the network layer:** `allowedActions=read_only` → `context.route` aborts non-GET/HEAD to the target origin except allowlisted auth endpoints; attempts logged as `blocked_by_policy`.
- **Origin allowlist:** navigation outside target origin + allowlisted auth hosts is aborted; payment/checkout third parties always blocked.
- **Secrets:** AES-GCM encrypted at rest; never sent to the model; masked in rrweb, network bodies, logs and prompts.
- **Authorisation tickbox** on scan creation; one running scan per target; per-scan cost cap.
- Playbook cannot alter safety rules (§11.2).

## 15. Data model (Postgres)
```
projects(id, name, created_at)
api_keys(id, project_id, hash, created_at, last_used_at)
environments(id, project_id, base_url, allowed_actions)
personas(id, environment_id, name, role, credentials_enc, storage_state_key, auth_recipe_json)
scans(id, environment_id, status, team_size, focus, viewports, cost_usd, started_at, finished_at)
charters(id, scan_id, type, area, goal, persona_id, start_path, viewport, score)
agent_runs(id, scan_id, charter_id, kind[scan|confirm|live|verify|scenario], status, t0,
           video_key, rrweb_key, trace_key, timeline_key, tokens, cost_usd)
steps(id, agent_run_id, n, action_json, locator_json, intent, expectation, t_ms, state_hash,
      screenshot_key, signals_json, reasoning_summary)
findings(id, project_id, scan_id, signature, priority, title, expected, actual, status,
         confirm_json, fix_status, prompt_variant, created_at)
finding_occurrences(finding_id, agent_run_id, step_id)
scenarios(id, project_id, name, yaml, triggers, source_finding_id, locator_seq_json)
scenario_runs(id, scenario_id, agent_run_id, status)
product_maps(id, project_id, version, map_json, created_at)
playbooks(id, project_id, version, body_md, diff, stats_json, created_at, reverted_at)
locator_memory(project_id, state_hash, intent, locator_json, ok_count, fail_count)
noise(project_id, signature, dismiss_count, suppressed)
bandit_arms(project_id, area, charter_type, alpha, beta, cost_avg)
prompt_variants(id, template, uses, fixes)
llm_usage(id, scan_id, agent_run_id, role, model, tokens_in, tokens_out, latency_ms, cost_usd)
```

## 16. Engine API
- `POST /v1/scans`, `GET /v1/scans/:id`, `GET /v1/scans/:id/events` (SSE), `GET /v1/scans/:id/findings`
- `GET /v1/runs/:id/timeline` (signed artifact URLs), `GET /v1/runs/:id/rrweb/:segment`
- `GET /v1/findings/:id`, `POST /v1/findings/:id/confirm`, `POST /v1/findings/:id/live` (→ WebSocket `/v1/live/:jobId`), `POST /v1/findings/:id/verify {url}`
- `GET /v1/findings/:id/{scenario,playwright,prompt}`, `POST /v1/findings/:id/dismiss`
- `POST /v1/scenarios`, `POST /v1/scenarios/run`, `POST /v1/scenarios/relevant`
- `GET /v1/projects/:id/{playbook,playbook/versions,memory,metrics}`, `POST /v1/projects/:id/playbook/revert {version}`
- `POST /mcp` (MCP Streamable HTTP), OAuth endpoints (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`)
Auth: project API key (bearer) or OAuth access token; dashboard via server-side proxy.

## 17. CLI and CI (`packages/cli`)
- `gremlin scan <url> [--team 5] [--focus] [--persona ...] [--wait]`, `gremlin findings list|get|prompt|verify <id> --url`, `gremlin scenarios run <files> [--relevant --changed-files ...] --wait`, `gremlin replay open <runId>`, `gremlin evidence download <id> -o <file>`, `gremlin playbook show|diff|revert`, `gremlin skills install --target alan|claude|codex|cursor`.
- `--json` envelope `{schemaVersion:1, status, errorCode?, retryable?, nextCommands?, data}`; exit codes 0 pass / 1 failures / 2 blocked / 3 usage-auth.
- GitHub Action `gremlin/verify`: runs relevant scenarios against the preview URL, posts a PR comment with verdicts and replay links, fails the job on confirmed failures.

## 18. Dashboard (`apps/web`)
- **Projects / environments / personas** setup.
- **New scan:** URL, personas, allowed actions, focus, team size, viewports, authorisation tickbox.
- **Live scan:** agent tiles (live screenshot, current action, step count), product map tree filling in, findings feed, cost/token meter.
- **Findings list:** filters (status, priority, area, oracle), "seen by N agents", confirmation badge, suppressed count.
- **Replay page** (§10.1), **compare view**, **live re-run view**.
- **Scenarios:** list, YAML editor, run history.
- **Knowledge:** product map, playbook with version history and diffs, locator memory stats, noise list, bandit arms.
- **Metrics:** improvement panel (§11.5), fix-loop stats.

## 19. Demo target (`apps/demo-target`)
Next.js shop with three personas (guest, customer, admin). Seeded bugs:
1. Cart total `NaN` when quantity is cleared (`error_text`).
2. Checkout API 500 for lowercase coupon codes (`network`).
3. Uncaught exception on profile when bio is empty (`crash`).
4. Footer "Careers" link 404 (`dead_link`).
5. Adding the same item twice shows count 1 (`expectation`).
6. Back after checkout re-submits the order (`navigation`).
7. Search with `'` shows a raw stack trace (`error_text`).
8. Icon-only delete button without accessible name (`a11y`).
9. Customer can open `/admin/orders` directly (`permission`).
10. Checkout button off-screen on mobile (`layout`).
11. Product page LCP ~6s from an unoptimised hero image (`vitals`).
12. Order history intermittently 500s (1 in 3) (`flaky` path for the confirmation logic).

## 20. Build order (milestones, not cuts)
1. **Foundation:** monorepo, contract, DB schema, engine Docker image deployed + tunnel, demo-target with seeded bugs (Alan).
2. **Single agent end to end:** observation, actions, settle, oracles, recorder (all streams), judge; measure GLM Flash step latency and success, swap navigator model if needed.
3. **Replay UI:** timeline API, replay page with video + DOM + devtools, compare view.
4. **Swarm:** queues, discovery + mapper, personas, coverage sharing, SSE live view, dedupe, confirmation.
5. **Alan plugin:** MCP server (API key), skills, marketplace repo, install in Alan, Testing evidence mapping; then OAuth DCR.
6. **Live re-run + verify fix + exports** (Playwright, YAML, fix prompt).
7. **Self-improvement:** app memory, regression net, playbook reflect, bandit, fix-loop stats, metrics panel.
8. **Breadth:** scenarios UI/runner, CLI, GitHub Action, a11y/layout/vitals oracles, vision fallback, healer, mobile viewport.
9. **Ship:** deploy all three apps, run full acceptance (§1), demo script, X post.

Alan builds: demo-target, dashboard shells and styling, knowledge/metrics pages. Claude builds: everything in engine/agent/recorder/replay/knowledge/MCP, and the replay page's player/timeline sync.

## 21. Testing
- Contract: zod round-trips, scenario JSON Schema validation.
- Units: path/signature normalisation, locator resolution, settle, timeline merge (clock alignment), bandit update, playbook diff application/revert.
- Oracles: one fixture page per oracle that must fire, one clean page that must not.
- Recorder: fixture flow; assert video, rrweb segments, console and network events align within 100ms of step `tMs`.
- Replay: deterministic replay of a recorded fixture run reproduces the same oracle; live re-run streams frames.
- MCP: `initialize`, `tools/list`, authenticated `tools/call` for every tool; Alan plugin `validate.mjs`.
- **Acceptance (§1):** two consecutive scans on demo-target + plugin fix/verify loop, run after every milestone from 4 on.

## 22. Risks
| Risk | Mitigation |
|---|---|
| GLM Flash too weak/slow as navigator | oracles carry detection; low effort; per-role model swap; measured in milestone 2 |
| Always-on reasoning latency | navigator effort low; parallel agents; deterministic fast paths for replay/scenarios |
| Alan custom connector form differs from plugin spec | marketplace-repo route is documented and works with `type:http` + headers; confirm form in app at milestone 5 |
| rrweb gaps (canvas, cross-origin iframes, shadow DOM) | video mode always available; enable rrweb canvas recording where present |
| Clock drift between streams | single `t0`; test asserts ≤100ms alignment |
| Self-improvement makes things worse | versioned playbook, metrics comparison, one-click revert, safety rules locked |
| Playwright on the engine host | Docker image deployed in milestone 1 |
| OpenRouter price/route variance | provider pinned; per-call cost; scan cost cap |
