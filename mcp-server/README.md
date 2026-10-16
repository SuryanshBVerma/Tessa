# tessa-qa

Tessa is an agentic tester for Claude Code and VS Code agent mode. It reads a user story and the
code, plans tests for you to approve, runs them in the browser while you sign in, writes an HTML
report, and exports the tests you keep to Playwright TS or Playwright .NET.

This package holds the `tessa-mcp` server, which owns every deterministic or side-effecting
operation, and the agents, commands and skills Tessa installs into your host.

## Install

In the repository you want to test (Node 24 or later):

```bash
npx tessa-qa@<version> install --host claude-code    # or --host vscode-agent
```

Then restart the host, approve the `tessa-mcp` server, and run `/tessa-init`. Claude Code users
can install the plugin instead; see docs/INSTALL.md in the repository.

`install` writes `.claude/` and `.mcp.json`, or `.github/agents`, `.github/prompts`,
`.github/skills` and `.vscode/mcp.json`. It replaces only files it wrote before, adds only its
own entry to the MCP config, and pins the server to the installed version. Preview with
`--dry-run`.

The server only allows local databases and app URLs, never automates sign-in, and keeps run
output (screenshots included) in gitignored folders.

## Tools

| Tool                                                                                                                        | Read-only        | What it does                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `detect_stack`                                                                                                              | yes              | Suggests the stack adapter, export targets, package manager and start command                                                                                                                    |
| `load_config`                                                                                                               | yes              | Reads `.tessa/config.yaml`, validates it, and returns it with defaults filled in                                                                                                                 |
| `validate_config`                                                                                                           | yes              | Lists config errors and warnings with JSON Pointer paths                                                                                                                                         |
| `init_workspace`                                                                                                            | no               | Creates `.tessa/config.yaml`, the hints file and a managed `.gitignore` block. Supports `dry_run`; replaces a config only with `overwrite` and never replaces hints                              |
| `start_app`                                                                                                                 | no               | Starts the app with `app.start` (no shell operators allowed) and waits for `app.health_path`. Leaves an app that is already up alone                                                             |
| `stop_app`                                                                                                                  | no               | Stops the app only if Tessa started it                                                                                                                                                           |
| `health_check`                                                                                                              | yes              | One request to `app.url` + `app.health_path`; any status below 500 counts as healthy                                                                                                             |
| `seed_db`                                                                                                                   | no (destructive) | Applies a seed profile's listed `.sql` files in one transaction. Refuses any host that is not local and in `db.allowed_hosts`; reads the URL from `db.url_env` and never returns it              |
| `reset_db`                                                                                                                  | no (destructive) | Re-applies the given profile, else the last one seeded, else `default`                                                                                                                           |
| `capture_env_state`                                                                                                         | yes              | Persona, seed profile, app URL and Git commit/branch/dirty state, merged with what the executor observed in the app                                                                              |
| `build_static_map`                                                                                                          | no               | Reads the source with the stack adapter (React Router first) into `context/frontend-map.json` and `.md`: routes, guards, links, API calls, flags and selectors. Incremental; never runs app code |
| `context_freshness`                                                                                                         | yes              | Whether the map, or an external knowledge graph, lags the code                                                                                                                                   |
| `routes_for_feature`, `components_for_route`, `permissions_for_route`, `api_calls_for_component`, `selectors_for_component` | yes              | The five context queries, answered from the map, or as a call for the agent to make on the team's knowledge graph (`external`/`hybrid`)                                                          |
| `story_context`                                                                                                             | yes              | The routes a story is about (term matches, branch changes, linked routes) with their guards and selectors                                                                                        |
| `record_crawl`                                                                                                              | no               | Saves a persona's runtime crawl and reports where code and runtime disagree                                                                                                                      |
| `save_plan`                                                                                                                 | no               | Validates a test IR plan against the schema and config and writes `tests.json` and a readable `plan.md`; returns coverage warnings                                                               |
| `approve_plan`                                                                                                              | no               | Records the user's approval with the plan's SHA-256; any later edit makes it stale                                                                                                               |
| `plan_status`                                                                                                               | yes              | Whether a story's plan is approved, unapproved or stale                                                                                                                                          |
| `begin_run`                                                                                                                 | no               | Creates `runs/<run_id>/` for an approved, unchanged plan and returns its tests with indexed steps                                                                                                |
| `record_step`                                                                                                               | no               | Records one step's outcome and copies in its screenshot (PNG, JPEG or WebP only, checked by content)                                                                                             |
| `write_results`                                                                                                             | no               | Builds `results.json`; status, failures, attempts and quality signals are computed from the recorded steps                                                                                       |
| `render_report`                                                                                                             | no               | Renders `report.html` from a fixed template; cards are built with DOM APIs from embedded JSON, under a nonce-based CSP                                                                           |
| `serve_review`                                                                                                              | no               | Serves the report on `127.0.0.1` at a random port behind a per-session path token; checks Host and Origin, stops after the idle timeout                                                          |
| `get_selection`                                                                                                             | yes              | Returns the reviewer's `selection.json`, optionally waiting up to 50 s per call for Export                                                                                                       |
| `record_selection`                                                                                                          | no               | Saves a selection pasted from a report opened from disk (static fallback)                                                                                                                        |
| `stop_review`                                                                                                               | no               | Stops the review server                                                                                                                                                                          |
| `emit_tests`                                                                                                                | no               | Generates Playwright TS or Playwright .NET code for the reviewer's selection with a deterministic emitter, into `export/<target>/<story>/`                                                       |
| `update_export_file`                                                                                                        | no               | Replaces one file in the export folder, for the convention pass                                                                                                                                  |
| `validate_export`                                                                                                           | no               | Type-checks or builds the export and optionally runs it once; writes `export-summary.md`                                                                                                         |
| `capture_session`                                                                                                           | no               | Opens Playwright's browser so the user signs in; Playwright saves the session to the gitignored `.session/`                                                                                      |
| `propose_handoff`                                                                                                           | yes              | The diff for copying exported tests into the repo's test folder, with a proposal id                                                                                                              |
| `apply_handoff`                                                                                                             | no               | Writes that proposal, only if nothing changed since; the user confirms first                                                                                                                     |
| `list_runs`                                                                                                                 | yes              | Runs under the artifacts root, newest first, with their state, commit, summary and the run they reran                                                                                            |
| `failed_test_ids`                                                                                                           | yes              | The failed and errored tests of a run (default: the newest complete one), for a rerun with `begin_run`'s `rerun_of`                                                                              |
| `diff_runs`                                                                                                                 | no               | Compares two runs of a story and writes `diffs/<a>__<b>.json` and `.html`; lists files changed between the commits                                                                               |
| `annotate_diff`                                                                                                             | no               | Adds triage notes to a diff and re-renders its page                                                                                                                                              |
| `record_triage`                                                                                                             | no               | Stores a failure's triage class, rationale, confidence and evidence in `results.json`                                                                                                            |
| `write_host_files`                                                                                                          | no               | Writes the agents, commands, skills and MCP entry for Claude Code or VS Code, with models from config; replaces only files it wrote                                                              |

## Run it by hand

```bash
npx tessa-qa@<version> mcp --workspace path/to/your/repo
```

The server speaks MCP over stdio. The workspace is the repository under test, taken from
`--workspace`, then `TESSA_WORKSPACE`, then the directory the host starts the server in. No tool
reads or writes outside it. `tessa-mcp` is the same server as a separate binary.

## Development

From a clone of the repository:

```bash
npm run build -w mcp-server
node mcp-server/dist/cli.js mcp --workspace path/to/your/repo
```

```bash
npm run schemas:types -w mcp-server   # regenerate src/schemas/generated/ after editing schemas/
npm test                              # unit and MCP integration tests
```
