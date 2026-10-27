# Gremlin

Browser-agent QA with recorded video, inspectable DOM replay, console/network evidence and a coding-agent fix handoff. The REST API, MCP plugin and Next.js dashboard use the same project and findings.

## Run the integrated local demo

Requires Node 24+, pnpm, Docker Desktop, and an OpenRouter API key.

1. Install dependencies: `pnpm install`.
2. Copy `.env.example` to `.env` if you do not already have it. Set `OPENROUTER_API_KEY` and a nonempty `GREMLIN_SECRET_KEY`; keep your existing database/storage settings. If port 5432 is occupied, set `GREMLIN_PG_PORT` and change `DATABASE_URL` to match.
3. Start the local backing services: `docker compose up -d`.
4. Install the recording browser once: `pnpm --filter @gremlin/engine exec playwright install chromium`.
5. Start everything: `pnpm demo`.

Open [the dashboard](http://localhost:3200). The launcher starts the engine at port 8080, discovery and browser-agent workers, and the existing cart fixture at [port 3100](http://127.0.0.1:3100/cart.html). It generates a project key in the git-ignored `.env.demo` and passes that same key to the dashboard. It reuses the key on subsequent starts. Ctrl+C stops this stack.

The fixture deliberately returns HTTP 500 on the second `POST /api/cart` request. It is a real test target; scan results, screenshots, video, DOM events and network logs are produced by the actual browser agent and configured model. It is not the unfinished `apps/demo-target` storefront.

The dashboard defaults to one agent per scan for a short demo. REST and MCP support larger teams. Check both the authorization box and **Allow form submissions and other changes on this test site** when using the local fixture; read-only mode intentionally blocks its cart writes.

Suggested focus:

> Perform TWO separate click actions on Add to cart. After the first click, click Add to cart AGAIN before expecting, reporting or finishing. Then inspect the save status. Report the failed POST /api/cart after the SECOND click and finish.

The model can make mistakes. Use the recorded actions and network response to choose the finding to show. A model report alone is not proof of a bug.

## Verify the connections

With the demo running and a scan completed:

```
pnpm --filter @gremlin/engine demo:check
```

This connects with the MCP SDK, lists tools, reads the playbook and the same scan visible in REST, fetches the fix prompt, and downloads video, DOM and trace artifacts through the dashboard proxy. No API key is printed. To create a new fixture scan through MCP, use `pnpm --filter @gremlin/engine demo:check --start` and run the check again after completion.

```
pnpm --filter @gremlin/engine --filter @gremlin/web typecheck
pnpm --filter @gremlin/engine test
pnpm --filter @gremlin/web test
pnpm --filter @gremlin/web build
node plugins/gremlin/validate.mjs
```

## Alan plugin

See [plugin installation](plugins/gremlin/README.md). MCP is available at `http://localhost:8080/mcp` with `Authorization: Bearer <GREMLIN_API_KEY from .env.demo>`. A local MCP client can use this directly. Alan's remote connector requires a reachable HTTPS engine URL; configure `GREMLIN_ENGINE_URL` and the same project key in the plugin. Set `GREMLIN_WEB_URL` to a dashboard URL reachable from the machine opening replay links. Do not show `.env` or `.env.demo` in the recording.

The server currently exposes 11 tools. The demo path is `get_playbook` → `start_scan` → `get_scan`/`wait_scan` → `list_findings`/`get_finding` → `get_fix_prompt`. Scenario, live rerun and verify-fix tools enqueue work for additional workers that are not implemented in this local stack. Do not use them as completion claims in the demo. Self-improvement metrics also require later milestones; the live dashboard displays their empty state.

## Record 90 seconds

- **0–10s:** “Gremlin tests a web app and gives developers a bug report they can inspect.” Show the dashboard using engine data.
- **10–25s:** Show the target URL and focus. Start a scan; cut the waiting time in the video.
- **25–45s:** Open a real completed finding with captured evidence. Explain expected versus actual behavior.
- **45–75s:** Open its replay. Play the video, switch to DOM replay, select a step and show the failing network response.
- **75–90s:** Return to the finding and copy the fix prompt. “The coding agent gets the reproduction steps and evidence in one handoff.”

Prepare a completed scan before recording. No slides or installation walkthrough are needed.

## Offline UI preview

Set `NEXT_PUBLIC_MOCK=1` explicitly to view sample data. The badge labels it as mock. A configured live engine that becomes unreachable shows a connection error instead of falling back to sample results.

## Self-fixing loop (autofix)

Turn a finding into a reviewed PR without hand-holding:

```
pnpm --filter @gremlin/engine autofix <findingId> --repro-cmd "pnpm --filter demo-target exec playwright test tests/gremlin-repro.spec.ts"
```

The loop fetches the fix prompt, runs `claude -p` in an isolated git worktree, and retries up to `--attempts` times, feeding failures back. A fix only reaches a PR after all gates pass: tests not weakened (no removed assertions, skips or retries), project tests (`--test-cmd`, default `pnpm test`), the generated reproduction now passes (`--repro-cmd`), and an independent reviewer pass returns APPROVE. Then you approve (`--yes` skips the prompt), it pushes, opens the PR with `gh`, and calls `report_fix_outcome` so the prompt variant's fix rate improves. Anything else is discarded with the worktree. Requires `claude` and `gh` on PATH and a running engine.
