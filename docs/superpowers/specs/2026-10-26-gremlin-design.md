# Gremlin: AI browser-agent QA (design spec)

Working name: **Gremlin**. A Composal-style product: point it at a web app, a swarm of browser agents tests it, you get bugs with video, repro steps, and a one-click handoff to a coding agent.

## Intent
- **Goal:** win/place at OpenFire hackathon; deadline ~12h from 2026-10-26.
- **Success:** a deployed demo where a URL goes in, agents find seeded bugs live, findings show video replay + repro steps, and a finding exports as a YAML scenario and a coding-agent prompt.
- **Assumptions (not confirmed):** Alan usage is optional; judges value a working live demo over breadth.

## Scope
In (priority order):
1. Discovery: crawl a URL, list Areas / Features / Flows.
2. Deep Scan: N parallel Playwright agents (model tool-use loop on the accessibility tree), 3-5 browsers.
3. Findings: priority, title, expected vs actual, numbered repro steps, video with per-step timestamps.
4. Rerun-to-confirm in a fresh browser (marks finding `confirmed`/`flaky`).
5. Scenario export (YAML) + "Fix with agent" prompt.
6. CLI `gremlin` with `--json` output; installable agent skill file.
7. Stretch: GitHub Action for PRs, Sentry/PostHog discovery.

Out: nightly knowledge pass, Notion/Granola, multi-tenant orgs, billing, 20-tester scale.

## Architecture
Monorepo (pnpm workspaces), TypeScript everywhere.

| Package | Purpose | Owner |
|---|---|---|
| `packages/contract` | zod schemas + types (below). Single source of truth | Claude |
| `apps/web` | Next.js dashboard + API routes | UI: Alan; API: Claude |
| `packages/agent` | Playwright browser agent loop, discovery, tester | Claude |
| `packages/orchestrator` | job queue, swarm, dedupe, rerun | Claude |
| `packages/cli` | `gremlin` CLI + MCP server | Claude |
| `apps/demo-target` | small app with seeded bugs | Alan |

Data: Postgres (Supabase) for scans/findings/scenarios; object storage for video/trace/screenshots. Auth: Clerk (or none for demo; decide at deploy). Models: Claude Sonnet 5.5 for testers, Haiku 5.5 for cheap steps; model name behind one config value.

Browser agent loop: each step sends the page's accessibility snapshot + goal + history to the model; model returns one tool call (`click`, `type`, `goto`, `scroll`, `report_finding`, `done`); Playwright executes; each step is timestamped for video seeking. Hard step cap and per-agent time budget; `allowed_actions: read_only` blocks form submits/deletes.

Swarm: orchestrator splits discovered flows across N agents, each with a distinct persona/goal; findings are deduped by (page, normalized title) and rerun once to confirm.

## Contract (v0)
```ts
Finding = {
  id, scanId, priority: 'P0'|'P1'|'P2'|'P3', title,
  expected: string, actual: string,
  steps: { n: number, text: string, tMs: number }[],   // tMs = video offset
  evidence: { videoUrl: string, traceUrl?: string, screenshotUrls: string[] },
  status: 'new'|'confirmed'|'flaky'|'dismissed',
  url: string, createdAt: string
}
Scan = {
  id, targetUrl, testAccount?: {username, password},
  allowedActions: 'read_only'|'full', focus?: string,
  teamSize: number, status: 'queued'|'running'|'done'|'failed',
  areas: { name, features: { name, flows: string[] }[] }[]
}
Scenario(YAML) = {
  name, persona, allowed_actions, starting_conditions,
  steps: string[], outcomes: string[]
}
CLI --json = { schemaVersion: 1, status, errorCode?, retryable?, nextCommands?: string[], data }
```
API routes: `POST /api/scans`, `GET /api/scans/:id`, `GET /api/scans/:id/findings`, `POST /api/findings/:id/rerun`, `GET /api/findings/:id/scenario`, `GET /api/findings/:id/prompt`.

## Error handling
- Agent step errors: retry once, then record a "blocked" outcome (distinct from "failed").
- Browser crash / timeout: scan continues with remaining agents; status reflects partial.
- Model/API failure: surfaced in scan status, never silently dropped.

## Testing
- Contract: zod round-trip tests.
- Agent: run against `apps/demo-target`; assert the seeded bugs are found (the acceptance test for the whole product).
- CLI: snapshot of `--json` output.

## Risks
Agent flakiness (mitigated by step caps + rerun-to-confirm), video capture/storage time, deploy of Playwright (needs a container host, not a plain serverless function, so the worker runs on Render/Fly/local while the dashboard deploys to Vercel).
