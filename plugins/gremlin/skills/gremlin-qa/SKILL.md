---
name: gremlin-qa
description: Use after you change a user-facing flow (pages, forms, checkout, auth, navigation) to QA it with Gremlin, or when asked to test, scan or regression-check a web app. Runs relevant scenarios or a Deep Scan and reports findings with replay links.
---

# Gremlin QA

Gremlin is an AI QA team reachable through the `gremlin` MCP server. Use it to verify UI changes against a running app (tunnel, preview or staging URL) and to present evidence.

## Workflow

1. **Always call `get_playbook` first** with the project id. It returns the current playbook and app memory. Follow its guidance on areas, personas and known noise. The playbook improves over time, so do not rely on memory of earlier runs.
2. **Pick the run type.**
   - Change touches existing flows: call `run_relevant_scenarios` with `projectId`, `changedFiles`, `changedRoutes` and the app `url`. If nothing matches, say so and fall through to a scan.
   - Change adds a new surface, or nothing matched: call `start_scan` with `url`, a small `teamSize` (3 to 5), a `focus` naming the changed area, and `allowedActions: "read_only"` unless the user explicitly allows mutations. Calling `start_scan` asserts the user is authorised to test that target; never scan a site you were not given.
   - The user wrote scenario YAML: call `run_scenarios` with `yaml` or `ids`.
   - **Login required.** If the user says the app needs a login, or `get_scan` returns `needsCredentials: true`, call `request_credentials` with the app `url` and give the user the returned `link`. They open it and type a TEST email/username and password into Gremlin's own page. **Never ask for the password in chat, never repeat it, and never put it in `focus`.** When they say it is saved, call `start_scan` again; the saved login is used automatically (`loginSaved: true`). Use a test account, not a real one. `request_credentials` reports `alreadySaved` if a login exists.
3. **Wait.** Call `wait_scan` (it returns after at most about 55 seconds; call it again while `done` is false). Use `get_scan` for a cheap status check.
4. **Read results.** `list_findings` with the `scanId` (filter `status: "confirmed"` first), then `get_finding` for anything P0 to P2.
5. **Report.** Never paste raw tool JSON.

## Presenting findings

For each finding show: priority, title, expected vs actual in one line each, and the **replay link** (`replayUrl`) as a clickable URL. Order by priority. If `truncated` is true, say that more exist and offer to page.

Verdict mapping for an evidence report:
- all checks passed, no confirmed findings: **Pass**
- any confirmed failure: **Fail**
- only blocked, flaky or unconfirmed results: **Mixed**

Include the scan id, the cost from `get_scan`, and the replay links. Do not invent findings and do not include credentials or API keys in any output.

## Next step

For each confirmed finding the user wants fixed, hand off to the `gremlin-fix` skill.
