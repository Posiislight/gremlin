# Demo integration implementation plan

**Goal:** Connect the existing REST API, MCP plugin and dashboard to real browser-agent runs and replay artifacts.

**Architecture:** Keep Fastify, BullMQ, Postgres and Next.js. Add the missing discovery consumer to fan out charters to the existing agent queue, finalize scans after all agents settle, expose the project scan index, and mount a replay studio using the existing DOM pane and timeline helpers. Both REST and MCP retain their existing scan entry points.

**Spec:** `docs/superpowers/specs/2026-10-26-gremlin-design.md`.

**Constraints:** Preserve existing local changes. No simulated results presented as live runs. Use existing auth and signed artifact proxy. Keep this checkout because it contains the components being integrated. No deployment or external publishing.

## Tasks

- [x] Write failing API tests for the project scan index, including isolation and counts. Implement the missing endpoint.
- [x] Write failing integration tests for discovery -> agent queue -> terminal scan status, including mixed outcomes and duplicate jobs. Implement orchestration and mount it in worker-main.
- [x] Persist agent steps during execution so SSE reports progress before completion; retain final redacted data and artifact mapping. Verify worker tests.
- [x] Mount `/runs/[id]` with synchronized video, DOM, steps, console/network evidence and deep links; show pending/unavailable runs honestly. Keep mock mode explicit.
- [x] Add a reproducible local demo launcher and project key setup using the same credentials for REST, MCP and the dashboard. Document plugin connection and recording flow.
- [x] Run engine/web tests, type checks, production web build and a real local scan through the integrated service. Inspect dashboard in browser and verify artifact access and MCP tool calls.

## Review focus

Queue retries must not multiply runs; failed scans must finish; project keys must remain isolated; links must preserve step/finding selection; disconnected live mode must not silently display fabricated results.

## Execution notes

User requested direct integration of the existing components. Scope is the working scan/findings/replay path; scenario, verify-fix and learning workers are separate unfinished features and must not be claimed as working unless verified.

## Verification and review

- Engine: 51 tests passed, including the generated reproduction against a real browser and repeat-scan finding association.
- Dashboard: 33 tests passed; production build and engine/web type checks passed.
- Plugin manifest validation passed; MCP SDK connected to the combined API server (11 tools), started a real scan and retrieved the fix prompt.
- Real completed scan: `atzz00dsg0079hr8zaf0l5nm`; run: `x0eyuxkhew9prkq67wthwwgj`. Recorded two clicks and `POST /api/cart?n=2` HTTP 500. Video, trace and DOM artifacts downloaded through the dashboard proxy.
- Browser verified deep link selects step 4, DOM replay shows “Could not save cart”, and Copy fix prompt changes to Copied.
- Independent read-only review found repeat-scan dedup omission; corrected across REST/SSE/MCP. Follow-up review found no important regressions.
- Final visual review found rrweb's strict seek boundary omitting the last mutation; added boundary regression and included the final event. Guarded video teardown events when switching views.
- Root lockfile and pre-existing untracked DomPane were preserved. No deployment, commit or publish performed.
