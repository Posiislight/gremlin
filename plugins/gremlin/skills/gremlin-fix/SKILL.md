---
name: gremlin-fix
description: Use to fix a bug that Gremlin reported (a finding id or replay link). Fetches the ready-made fix prompt and failing Playwright test, fixes the app, verifies the fix against a preview URL, and reports the outcome.
---

# Gremlin Fix

Use when the user gives you a Gremlin finding id, a replay link containing `finding=<id>`, or asks you to fix what a scan found.

## Workflow

1. Call `get_playbook` if you have not already this session, then **`get_fix_prompt`** with the finding `id`. The result has a `prompt` (follow it) and a `playwrightTest` (the reproduction).
2. Add the Playwright test to the project's test suite. **Make it pass without weakening it**: do not delete assertions, loosen expectations, add retries or skip it. Fix the root cause in the app code. If the test needs adapting (selectors, base URL), keep its intent intact.
3. Run the project's own tests and typecheck.
4. Deploy or start a preview and note its URL. Gremlin must be able to reach it over the network (not localhost on your machine unless tunnelled).
5. **Call `verify_fix`** with `findingId` and the preview `url`. It queues a deterministic re-run; poll `get_finding` until its status changes (`fixed` or `still_failing`).
6. **Call `report_fix_outcome`** with `findingId`, the `promptVariant` (use the value from the prompt if present, otherwise `default`), and `outcome`: `fixed`, `partial`, `not_fixed` or `abandoned`.

## Reporting

Tell the user what changed (files), the verify result, and give the finding's `replayUrl` so they can watch the original failure. If verification still fails, read the new replay, adjust once or twice, then stop and explain rather than weakening the test.

Never echo API keys, tokens or credentials found in signals.
