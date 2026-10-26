# Gremlin: AI browser-agent QA (design spec v2)

Working name **Gremlin**. Point it at a web app; it maps the product, a swarm of browser agents tests it, and every bug comes back with video, repro steps, a confirmation verdict, and a handoff a coding agent can act on.

## 1. Intent
- **Goal:** strong placing at OpenFire; deadline ~12h from 2026-10-26.
- **Success (acceptance test):** against `apps/demo-target` (8 seeded bugs), one Deep Scan with 5 agents finds ≥6/8, reports ≤2 false positives, confirms each true bug by replay, and finishes in under 10 minutes, live on a deployed URL.
- **System model:** GLM 5.3 Flash via OpenRouter (`z-ai/glm-5.3-flash`). Tool calling, structured output, image input; reasoning is always on, default effort max.
- **Assumptions (unconfirmed):** Alan usage optional; judges weigh a working live demo over breadth.

## 2. Design principles
1. **The LLM navigates and judges; deterministic oracles detect.** A small fast model is unreliable at noticing bugs from text alone, but console errors, failed requests and crashes are facts. Most findings start as oracle signals; the model explains and ranks them. Semantic bugs (wrong total, wrong redirect) come from explicit expectations the agent states *before* acting.
2. **Everything is replayable.** Every agent action is stored as a resolved, robust locator, so any finding can be replayed without the model.
3. **The model never sees secrets.** Credentials are placeholders resolved at execution.
4. **Bounded everything.** Steps, time, tokens and money per agent and per scan.

## 3. Topology
```
apps/web (Next.js, Vercel) ──HTTP/SSE──> apps/engine (Fastify API + BullMQ workers, Docker on Render/Fly)
                                             │            │             │
                                       Postgres (Supabase)  Redis (queue, pub/sub, coverage)  Object storage (Supabase Storage)
                                             │
                                       OpenRouter (GLM 5.3 Flash)
packages/contract   zod schemas shared by all
packages/cli        `gremlin` CLI + MCP server
apps/demo-target    seeded-bug app (Vercel)
```
Playwright cannot run in Vercel functions, so the engine is one container image (`mcr.microsoft.com/playwright` base) running API and workers; it scales by adding worker replicas. ORM: Drizzle. Monorepo: pnpm workspaces + Turborepo. Node 24, TypeScript strict.

## 4. LLM layer (`packages/llm`, used by `apps/engine` and `packages/agent`)
- OpenAI-compatible client pointed at OpenRouter; `model`, `reasoning.effort`, provider pin and fallback model all come from config **per role**:

| Role | Effort | Input | Output |
|---|---|---|---|
| `navigator` | low | observation + charter + recent history | exactly one tool call |
| `judge` | high | candidate finding + evidence | structured verdict |
| `mapper` | medium | crawl graph summary | product map + charters |
| `healer` | low | failed locator + current snapshot | replacement ref |

- Tool calls validated with zod; on invalid output, one repair turn including the validation error, then the step is recorded as `model_error` and the agent continues.
- Prompt layout puts the stable system prompt and tool schema first to benefit from provider-side prompt caching.
- Concurrency limiter (token bucket) on OpenRouter calls; 429/5xx retry with jitter (max 3); 30s timeout per call.
- Every call writes an `llm_usage` row (role, tokens in/out, latency, cost) for per-scan cost and latency display.
- Swapping the navigator to a stronger model is a config change; this is the fallback if GLM Flash proves too weak in testing.

## 5. Browser agent (`packages/agent`)

### 5.1 Observation
Built each step by an injected script plus Playwright:
- **Interactables list:** visible, enabled elements (links, buttons, inputs, selects, `[role]`, `[onclick]`, `[contenteditable]`) tagged with `data-gremlin-ref="e12"`. Each line: `e12 button "Add to cart" [disabled?] [value?] (section: Product)`. Capped at ~150 elements, prioritised by viewport then DOM order.
- **Page text digest:** headings, alerts/toasts (`[role=alert]`, `aria-live`), form errors, truncated main text (~1.5k tokens).
- **Signals since last step:** new console errors, failed/4xx/5xx requests (method, path, status), navigations.
- **Diff mode:** after step 1, unchanged sections are summarised as "unchanged" to cut tokens.
- **Vision fallback:** when the interactables list has <3 items or the agent repeats an action twice with no state change, attach a JPEG screenshot with set-of-marks labels drawn on the refs.

Budget: ~6k input tokens per step.

### 5.2 Action space (tool schema)
`click(ref)`, `type(ref, text, submit?)`, `select(ref, option)`, `press(key)`, `scroll(direction)`, `goto(path)` (same origin only), `back()`, `refresh()`, `wait(ms≤3000)`, `expect(statement)`, `report_bug(title, expected, actual, severity_hint)`, `finish(reason)`.
- `expect` records the agent's prediction before an action ("cart count becomes 2"); the judge later checks it against what happened. This is how semantic bugs are caught.
- Text may contain `{{username}}` / `{{password}}` / `{{fuzz:long}}` placeholders, resolved at execution.

### 5.3 Execution and settling
Resolve ref to an element handle and execute with Playwright auto-wait (5s timeout). Then settle: wait until there are no in-flight requests and no DOM mutations for 500ms, capped at 4s. Each executed action is stored with a **robust locator** computed at execution time, in priority order: `data-testid` > role+accessible name > label/placeholder > text > CSS path. That locator is what replay uses.

### 5.4 Loop and budgets
Per agent: max 40 steps, 5 min wall time, 150k tokens. Stops early on `finish`, on budget exhaustion, or after 3 consecutive no-op steps (state hash unchanged). History passed to the model: last 8 actions with outcomes plus a running one-line summary.

### 5.5 State hashing
`stateHash = sha1(normalizedPath + sorted interactable role/name set)`. Path normalisation replaces numeric and UUID segments with `:id`. Used for no-op detection, coverage sharing (§7.3) and the discovery graph.

## 6. Bug detection: oracles → candidates → judge
Oracles run on every step and emit **candidate findings** with raw evidence:

| Oracle | Signal | Default severity |
|---|---|---|
| `crash` | `pageerror` (uncaught exception) | P1 |
| `console` | `console.error` (dedup vendor noise list) | P2 |
| `network` | 5xx on any same-origin request; 4xx on XHR/fetch except 401 pre-login and expected 404 probes | P1 / P2 |
| `http` | document response ≥400 | P1 |
| `dead_link` | crawler link returns ≥400 | P3 |
| `error_text` | visible text matches `NaN`, `undefined`, `null`, `[object Object]`, "something went wrong", stack traces | P2 |
| `blank` | body text <20 chars and no interactables after settle | P1 |
| `a11y` | axe-core critical violations, once per state | P3 |
| `slow` | request >5s or settle cap hit 3× on one page | P3 |
| `expectation` | `expect` statement judged false | judge decides |
| `agent_report` | `report_bug` tool call | judge decides |

The **judge** (high effort) gets the candidate, the last 5 steps, before/after screenshots and the raw signals. It returns `{isBug, priority, title, expected, actual, reasoning}`. Candidates the judge rejects are kept as `dismissed` (visible behind a filter, never deleted), so false positives can be audited.

## 7. Discovery and swarm

### 7.1 Discovery
1. Optional login: run the login charter once, save Playwright `storageState`, reuse it in every context.
2. Crawl: BFS over same-origin links and nav-like clickables, max depth 3, max 40 states, read-only. Builds a graph: nodes are states (§5.5), edges are actions.
3. The mapper turns a compressed graph (paths, titles, headings, forms, main actions per node) into **Areas → Features → Flows**, plus a ranked list of **charters**.

### 7.2 Charters
`{id, area, goal, persona, type, startPath, focus, risk}`. Types:
- `happy_path`: complete the main flow.
- `edge_input`: fuzz forms with a fixed value set (empty, whitespace, 5k chars, unicode/emoji, negative, 0, huge numbers, `'"<>` quoting). Needs `allowedActions=full`.
- `navigation`: back, refresh and deep-link mid-flow; double-submit.
- `reproduce`: user-supplied bug report text.

Scan team size N picks the top-N charters by risk, round-robin across areas.

### 7.3 Orchestration
- BullMQ queues `discovery`, `agent`, `confirm`, `judge`. One Chromium per worker process with K isolated `BrowserContext`s (K=3 default). Each agent job is one context.
- **Coverage sharing:** Redis set `scan:{id}:visited` of state hashes. The navigator prompt lists already-covered states in its area and asks it to prefer unvisited ones.
- Scan state machine: `queued → discovering → scanning → confirming → done | failed | partial`. A crashed job marks its agent `failed`; the scan still completes as `partial`.
- Progress events (step, screenshot thumb URL, candidate, finding) go to Redis pub/sub and are fanned out to the dashboard over SSE.

## 8. Evidence
- Per context: `recordVideo` (webm, 1280×800), Playwright trace (`trace.zip`: screenshots, DOM snapshots, network) and a JPEG screenshot per step.
- **Video seeking:** `t0` is taken at context creation (when video recording starts); each step stores `tMs = now - t0` at action start, so the player seeks to a step exactly.
- Artifacts are uploaded after context close to `scans/{scanId}/agents/{agentId}/...`. The trace opens in `trace.playwright.dev` via signed URL.

## 9. Dedupe, confirmation, flakiness
- **Signature:** for oracle findings, `sha1(oracle + normalizedPath + normalizedMessage)` (numbers, ids, hashes and timestamps stripped). For judge-sourced findings, the judge is shown existing findings in the same area and returns `duplicateOf` or null. Duplicates become occurrences of one finding, and "seen by N agents" raises confidence.
- **Confirmation:** replay the stored locator sequence up to the failing step in a fresh context, deterministically (no LLM), then check that the same oracle or expectation fails.
  - Reproduced → `confirmed`.
  - Not reproduced → 2 more replays: any hit → `flaky (k/3)`, none → `unconfirmed`.
  - A locator miss calls the `healer` once per step; if healing fails → `unconfirmed (replay broke)`.

## 10. Scenarios
- YAML, compatible in spirit with Composal's shape: `name, persona, allowed_actions, starting_conditions, steps[], outcomes[]`. Validated by the zod schema, with a JSON Schema exported for editor validation.
- **Runner:** navigator executes steps as goals; each `outcome` becomes an `expect` judged at the end. Result is `passed | failed | blocked` (blocked = could not reach the step: auth, captcha, popup).
- **Export from a confirmed finding:** (a) a scenario YAML; (b) a **deterministic Playwright `.spec.ts`** generated from the locator sequence plus an assertion for the failing oracle. The coding agent gets a test that fails before the fix and passes after.

## 11. Coding-agent handoff
`GET /api/findings/:id/prompt` renders: title, priority, expected/actual, repro steps, evidence links, raw signals (stack trace with source-mapped file:line when sourcemaps are public, failing endpoint and status), the generated Playwright test, and the instruction: "make this test pass without weakening it". The dashboard has copy buttons for Claude Code, Codex and Cursor. The CLI provides the same via `gremlin findings prompt <id>`.

## 12. Safety
- **Read-only enforced at the network layer, not just in the prompt:** with `allowedActions=read_only`, `context.route` aborts non-GET/HEAD requests to the target origin, except an allowlist (login endpoint). Blocked attempts are logged as `blocked_by_policy`.
- **Origin allowlist:** navigation outside the target origin (plus allowlisted auth hosts) is aborted; third-party payment/checkout domains are always blocked.
- **Secrets:** stored encrypted (AES-GCM, key from env), never sent to the model, and masked in logs, traces metadata and prompts.
- **Ownership:** the scan form requires ticking "I own or am authorised to test this site". Rate limit per target: 1 running scan.

## 13. Data model (Postgres)
`projects(id, name, target_url, created_at)`
`environments(id, project_id, base_url, auth_json_enc, allowed_actions)`
`scans(id, environment_id, status, team_size, focus, product_map_json, started_at, finished_at, cost_usd)`
`charters(id, scan_id, type, goal, persona, start_path, risk)`
`agent_runs(id, scan_id, charter_id, status, steps_count, tokens, video_key, trace_key, t0)`
`steps(id, agent_run_id, n, action_json, locator_json, t_ms, state_hash, screenshot_key, signals_json)`
`findings(id, scan_id, signature, priority, title, expected, actual, status, confirm_json, created_at)`
`finding_occurrences(finding_id, agent_run_id, step_id)`
`scenarios(id, project_id, name, yaml, source_finding_id)`
`scenario_runs(id, scenario_id, status, agent_run_id)`
`llm_usage(id, scan_id, role, model, tokens_in, tokens_out, latency_ms, cost_usd)`

## 14. API (engine)
- `POST /v1/scans` `{environmentId|url, teamSize, focus, allowedActions, auth?}` → `{scanId}`
- `GET /v1/scans/:id`; `GET /v1/scans/:id/events` (SSE); `GET /v1/scans/:id/findings?status=`
- `GET /v1/findings/:id` (with steps and signed evidence URLs); `POST /v1/findings/:id/confirm`; `GET /v1/findings/:id/{scenario,playwright,prompt}`
- `POST /v1/scenarios/run` `{yaml[]|ids[]}` → `{runId}`; `GET /v1/runs/:id`

Auth: one API key per project (bearer) for CLI and CI; the dashboard uses the same through a server-side proxy.

## 15. CLI and agent integration (`packages/cli`)
- Commands: `gremlin scan <url> [--team 5] [--focus "..."] [--wait]`, `gremlin findings list|get|prompt`, `gremlin scenarios run <files> --wait`, `gremlin evidence download <id> -o <file>`, `gremlin skills install --target claude|codex|cursor`.
- `--json` envelope: `{schemaVersion:1, status:"ok"|"error", errorCode?, retryable?, nextCommands?:string[], data}`.
- Exit codes: 0 pass, 1 findings/failed scenarios, 2 blocked, 3 usage/auth error.
- **MCP server** (`gremlin mcp`) exposes `start_scan`, `get_scan`, `list_findings`, `get_finding_prompt`, `run_scenarios`, so a coding agent can run QA itself.
- **Skill file** (`.agents/skills/gremlin/SKILL.md`): when to scan, how to read findings, the fix-then-rerun loop.
- Stretch: GitHub Action `gremlin/verify@v0` running scenarios against a preview URL, failing the job on any failure.

## 16. Dashboard (`apps/web`)
- **New scan:** URL, test account, allowed actions, focus, team size, authorisation tickbox.
- **Live scan:** grid of agent tiles (latest screenshot, current action, step count), product map tree filling in, findings feed streaming in, cost and token meter.
- **Finding detail:** video player with a step list that seeks on click; expected/actual; signals panel; confirmation badge (`confirmed`/`flaky 1/3`/`unconfirmed`); buttons for rerun, export YAML, export Playwright, copy fix prompt.
- **Scenarios:** list, YAML editor with schema validation, run results.

## 17. Demo target (`apps/demo-target`)
Small Next.js shop, deployed separately. Seeded bugs, one per oracle class plus semantic:
1. Cart total shows `NaN` when quantity is cleared (`error_text`).
2. Checkout API returns 500 for coupon codes with lowercase letters (`network`).
3. Uncaught exception on the profile page when the bio is empty (`crash`).
4. Footer "Careers" link is a 404 (`dead_link`).
5. Adding the same item twice shows cart count 1 (`expectation`).
6. Back button after checkout re-submits the order (`navigation`/`expectation`).
7. Search with a `'` shows a raw stack trace (`error_text`).
8. Icon-only delete button with no accessible name (`a11y`).

## 18. Ownership and build order
| Hours | Claude | Alan |
|---|---|---|
| 0–1 | monorepo, `packages/contract`, DB schema, engine skeleton | demo-target with seeded bugs (§17) |
| 1–4 | observation, actions, settle, oracles, single-agent loop against demo-target | dashboard shell, new-scan form, scan list (mock data from contract) |
| 4–6 | queue/swarm, discovery + mapper, judge, evidence upload, SSE | live scan view, finding detail with video seek |
| 6–8 | dedupe + confirmation replay, Playwright/YAML export, prompt | scenarios view, polish |
| 8–10 | CLI + MCP + skill, scenario runner | landing page, screenshots for X |
| 10–11 | deploy engine (Docker) + web + demo-target; acceptance run | demo script |
| 11–12 | buffer, fix what the acceptance run breaks | — |

Cut order if behind: GitHub Action → a11y oracle → MCP server → vision fallback → healer → scenario runner.

## 19. Testing
- Contract: zod round-trip and YAML schema tests.
- Agent units: locator resolution, path normalisation, signature normalisation, settle logic (against local fixture pages).
- Oracles: one fixture page per oracle that must fire, and one clean page that must not.
- **Acceptance:** full scan against demo-target; assert recall ≥6/8, false positives ≤2, all found bugs `confirmed`. Run after every major merge.
- CLI: snapshot of `--json` output and exit codes.

## 20. Risks
| Risk | Mitigation |
|---|---|
| GLM Flash too weak/slow as navigator | oracles carry detection; low effort for navigator; one-line config swap to a stronger model; measure in hour 3 |
| Reasoning latency (always on) × 5 agents × 40 steps | effort `low` for navigator, parallel agents, step cap; measure p50 step latency early |
| Agent flakiness (popups, cookie banners) | auto-dismiss common cookie banners pre-step; no-op detection; vision fallback |
| Video/trace upload time | upload async after context close; dashboard shows step screenshots until video is ready |
| Engine deploy (Playwright image) | build Docker image in hour 1 and deploy a hello-world early, not at hour 10 |
| OpenRouter price/route variance | pin provider; record per-call cost; scan cost cap ($1 default) |
