# Gremlin plugin for Alan

Connects Alan to a Gremlin engine over a remote MCP server (Streamable HTTP) and ships two skills:

- `gremlin-qa`: scan or regression-test a web app after a change and present findings with replay links.
- `gremlin-fix`: take a finding, get a ready-made fix prompt and failing Playwright test, fix, verify, report.

## Install

1. Deploy the engine so it is reachable over **https** (Alan accepts remote https MCP servers only).
2. Create a project API key (`grm_...`) for your project.
3. Set the placeholders used by `mcp.json`:
   - `GREMLIN_ENGINE_URL`, for example `https://gremlin.example.com` (no trailing slash; `/mcp` is appended)
   - `GREMLIN_API_KEY`, the project API key
4. In Alan: **Plugins -> Add marketplace**, point it at this repository (root `.cursor-plugin/marketplace.json`), then install **gremlin**. Alan prompts for the API key and stores it encrypted.
   Alternative: **Add custom connector** with URL `https://<engine>/mcp` and header `Authorization: Bearer <key>` (confirm the form fields in the app).
5. Ask Alan to "QA the checkout flow with Gremlin".

The engine must have `GREMLIN_WEB_URL` set to the dashboard origin so replay links look like `<web>/runs/<runId>?step=N&finding=<id>`.

## Tools

`get_playbook`, `start_scan`, `get_scan`, `wait_scan`, `list_findings`, `get_finding`, `get_fix_prompt`, `run_relevant_scenarios`, `run_scenarios`, `verify_fix`, `report_fix_outcome`.

## Validate

```
node plugins/gremlin/validate.mjs
```

Checks the manifest, `mcp.json` and skill frontmatter. For a live check, make an authenticated `tools/call` (for example `get_playbook`), not just `initialize`.
