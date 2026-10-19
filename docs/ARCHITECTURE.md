# Tessa — Architecture

Tessa is a set of host-neutral agents, commands and skills plus one MCP server, `tessa-mcp`,
shipped together as the `tessa-qa` package (and as a Claude Code plugin). Agents and skills hold
judgement; the MCP server holds every deterministic or side-effecting operation. JSON schemas are
the contracts between all parts. For installing and using Tessa, see [INSTALL.md](INSTALL.md) and
[USAGE.md](USAGE.md); for the threat model, [SECURITY.md](SECURITY.md).

## 1. End-to-end flow

1. `/tessa-test-story <story>` starts the orchestrator.
2. Context: the frontend map is refreshed if stale; the story-scoped subgraph is retrieved.
3. Planner produces scenarios in the neutral test format → `plans/<story>/tests.json`.
4. **Gate:** the user approves or edits the plan.
5. App is started and the database seeded with the persona's seed profile.
6. **Gate:** for each persona, Tessa opens the login page in the host browser and waits for the user to sign in. The host browser keeps the session.
7. Executor runs each scenario step by step, capturing evidence and environment state.
8. Triage classifies failures; results are written to `runs/<timestamp>/results.json`.
9. The report is rendered and served by the local review server.
10. **Gate:** the reviewer selects tests on the review page; `selection.json` returns to the agent.
11. Exporter emits code for the selected tests in the target framework, validates it, and writes to `export/<framework>/`.
12. **Gate:** moving exported tests into the repo's test folder is proposed as a diff and applied only on confirmation.

## 2. Agents

| Agent           | Role                                                                              | Output                                |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| Orchestrator    | Runs the workflow, enforces gates, delegates                                      | Run summary                           |
| Context builder | Builds/refreshes static map, merges KG, runs per-persona crawl                    | `context/`                            |
| Planner         | Story + context subgraph → scenarios                                              | `plans/<story>/tests.json`            |
| Executor        | Seeds, drives the browser, records steps and evidence                             | `runs/<ts>/results.json`, screenshots |
| Triage          | Classifies failures (app bug, test/selector, environment, data); interprets diffs | Triage notes in results               |
| Exporter        | Adapts emitted code to repo conventions                                           | `export/<framework>/`                 |

Subagents get narrow context and return structured artifacts, not prose.

## 3. Skills

| Skill                 | Purpose                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `story-analysis`      | Acceptance criteria, personas, edge cases, implicit requirements                                |
| `ui-flow-discovery`   | Using context queries to understand screens, guards, navigation                                 |
| `adapter-<framework>` | Where routes, guards, permissions, test IDs live (React Router and Angular; Next.js, Vue later) |
| `test-planning`       | Neutral test format rules, coverage heuristics, persona × permission matrices, dedup            |
| `browser-execution`   | Step protocol, waits, evidence capture, the sign-in pause in the host browser                   |
| `failure-triage`      | Failure classes and the evidence each needs                                                     |
| `export-conventions`  | Detecting and following page objects, fixtures, naming, layout                                  |

Stack adapters are the main extension point: an adapter skill plus an extractor adapter in code.
An adapter finds the route tree and may read modules its own way: the Angular adapter follows
`Routes` arrays through lazy `loadComponent`/`loadChildren` (standalone or NgModule), keeps
route-level guards (`canActivate`, `canMatch`, role lists in route `data`) on the route, and
scans each component's template (inline or `templateUrl`) for selectors, `routerLink` targets
and permission checks. Template files are hashed with the module, so editing only the HTML
re-reads the component. Both adapters follow `tsconfig` path aliases.

## 4. MCP server: `tessa-mcp`

| Group              | Tools                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config             | `load_config`, `validate_config`, `detect_stack`, `init_workspace`                                                                                                                                                                    |
| App lifecycle      | `start_app`, `stop_app`, `health_check`                                                                                                                                                                                               |
| Database           | `seed_db(profile)`, `reset_db` — allowlisted scripts only, local hosts only                                                                                                                                                           |
| Context            | `build_static_map`, `context_freshness`, `routes_for_feature`, `components_for_route`, `permissions_for_route`, `api_calls_for_component`, `selectors_for_component`, `story_context`, `record_crawl`, `kg_status`, `save_kg_mapping` |
| Plans              | `save_plan`, `approve_plan`, `plan_status` — approval is recorded with the plan's hash and `begin_run` refuses unapproved or changed plans                                                                                            |
| Evidence & results | `begin_run`, `capture_env_state`, `record_step`, `write_results`                                                                                                                                                                      |
| Review             | `render_report`, `serve_review`, `get_selection`, `record_selection`, `stop_review`                                                                                                                                                   |
| Runs               | `list_runs`, `failed_test_ids`, `diff_runs`, `annotate_diff`, `record_triage`                                                                                                                                                         |
| Hosts              | `write_host_files` — writes the agents, commands, skills and MCP entry for Claude Code or VS Code                                                                                                                                     |
| Export             | `emit_tests(selection, target)`, `update_export_file`, `validate_export`, `capture_session`, `propose_handoff`, `apply_handoff`                                                                                                       |

Internal modules: static extractor with framework adapters (the TypeScript compiler API), context
query router, report and diff renderers (fixed HTML/CSS/JS templates), review server, emitters per
target, run diff engine, export validator, host writers.

External capabilities (used, not built): the host's browser (VS Code's integrated browser tools,
or a Playwright MCP server in Claude Code), an optional knowledge graph, and later an optional
story source (Jira/Azure DevOps, read-only, after v1.0).

### Sign-in

Sign-in is an instruction, not a tool. Tessa always drives the host's browser. When a persona needs
a session, the executor opens the app's `auth.login_path`, asks the user to sign in, and waits for
them to confirm. The host browser keeps the session (and offers its own dev tools), so Tessa never
sees, stores or replays credentials or session state. To switch persona, the executor asks the user
to sign out and sign in again as that persona.

Exported tests need sessions of their own. For validating an export, `capture_session` opens
Playwright's browser so the user signs in by hand; Playwright saves the storage state to the
gitignored `.session/` folder, and Tessa passes only the file's path.

## 5. Frontend context layers

1. **Static map** — deterministic extraction of routes → page components → children → API calls →
   permission guards → feature flags → selectors (data-testid, ARIA roles, labels). JSON graph plus a
   Markdown summary. Incremental: files are hashed and only changed parts regenerate.
2. **Runtime map** — per-persona crawl after manual login, recording navigation edges and
   accessibility snapshots; merged with the static map. Code-vs-runtime discrepancies are reported.
3. **Story-scoped retrieval** — the planner gets only the relevant subgraph: text matches on story
   terms, files changed on the branch (git diff vs `develop`/`main`), and 1–2 graph hops out.
4. **Hints file** — hand-written `context/hints.md`: glossary, critical journeys, quirks, which seed profile fits which feature.

### Knowledge graph integration

Agents depend only on the five context query tools. Config chooses who answers them:

- `builtin` — the generated static map (default).
- `external` — the team's existing knowledge graph via its MCP server, mapped by `kg-mapping.yaml`.
  `tessa-mcp` does not connect to that server: the query tool returns the tool to call and its
  arguments, and the agent makes the call with the host's own MCP client.
- `hybrid` — external first, built-in fills gaps (e.g. selectors, guards).

`context_freshness` warns in the report when the graph's indexed commit lags HEAD by more than `max_staleness_commits`.

**Connecting a graph.** `/tessa-connect-graph` has the agent find the graph's MCP server, check
that it answers and has indexed the repository, and map each query to a read-only tool from the
graph's own tool descriptions, trying each call once. The mapping can hold constant arguments
(a project name), a description of each answer and free-form `notes`; every delegate carries
them. `save_kg_mapping` validates the mapping and writes it and `context.knowledge_graph` after
the user confirms; `kg_status` reports the setup and a probe call. The host writers then grant
the mapped tools (plus any `extra_tools`), and only those, to agents and commands that use the
context queries: `mcp__<server>__<tool>` in Claude Code, `<server>/<tool>` in VS Code.
Without that grant an agent could be told to call a tool it is not allowed to use.

## 6. Neutral test format (test IR)

Every test exists first as framework-neutral data in `plans/<story>/tests.json`. Each test has an
ID, name, intent, story reference, persona, environment preconditions, and ordered steps. Each step
has an action (`navigate`, `click`, `fill`, `select`, `wait`, `assert`), a target with its selector
strategy, and an expected outcome. The report renders it, the selection references it by ID, and
emitters translate it. Exported code is never rewritten from memory.

## 7. Report and review

Each test card shows:

- **Header:** name, ID, story, status, duration.
- **Intent:** one or two sentences on what the test proves.
- **Environment state:** persona/role, permissions, user settings, feature flags, seed profile, build/commit, models used.
- **Flow:** numbered plain-language steps with screenshot thumbnails; on failure the failing step is highlighted with a full screenshot and expected vs actual.
- **Quality signals:** selector stability, rerun consistency, overlap with other tests.
- **Code preview:** collapsed, in the configured target framework.

Page features: a checkbox per test, filters by status and persona, "Select passing", and a sticky footer with the selection count and an Export button. Details open and close per test, so the list stays short.

**Review server:** served by `tessa-mcp` on `127.0.0.1`, random port, per-session token in the URL,
shut down at session end or idle timeout. Export writes `selection.json`, which the agent picks up.
Static fallback: when the report is opened from disk, it produces a selection file or a copyable
command instead.

## 8. Export pipeline

1. **Deterministic emitter** per target maps the IR to framework code. v1.0: Playwright TS,
   Playwright .NET (NUnit). Later: Cypress TS, Selenium C#/Java. (Cypress is JS/TS only; for C#
   the options are Playwright .NET or Selenium.) Config accepts the later targets; `emit_tests`
   says there is no emitter for them yet.
2. **Convention pass (LLM, optional)** adapts to page objects, fixtures, naming, helpers. It edits
   test and page-object files only; project and runner files stay as the emitter wrote them.
3. **Validation** type-checks or builds the export and, with `run_once`, runs each test once
   headless; results go to `export-summary.md`. Run-once is built but not yet verified outside
   the development machine.
4. **Handoff** proposes the diff into the repository's test folder and writes it only with the
   proposal's id, after the user confirms.

Auth in exported tests uses stored sessions (Playwright storage state), whose paths come from
`TESSA_AUTH_<PERSONA>` environment variables. Credentials are never written into test code.
Target `auto` detects the framework from `package.json`, `*.csproj` and `pom.xml`, and asks
when ambiguous.

## 9. Reruns and diffs

`/tessa-rerun-failed [run]` reruns only failed tests via `failed_test_ids`; the new run records
`rerun_of`. `/tessa-diff [runA] [runB]` compares two runs of a story and writes JSON + HTML to
`diffs/`: each test is fixed, regressed, still failing, still passing, added, removed, or changed
(skipped on one side). A rerun is compared only on the tests it repeated. The diff lists files
changed between the two runs' commits, leaving out the artifacts root. Triage interprets it with
`annotate_diff`, and records each failure's class with `record_triage`.

## 10. Model configuration

Each role's model is set in config or left `auto`. `/tessa-init` (through `write_host_files`) and
`tessa-qa install` write the configured model into each agent file, so config stays the single
source of truth.
`auto` policy: planner and triage use the strongest reasoning model; executor needs reliable tool
use and vision; exporter and context builder can use a mid-tier model; orchestrator inherits the
host model. If the host lacks per-agent models, everything inherits and the report records what was used.

In Claude Code, `auto` becomes a model alias (`opus` for planner and triage, `sonnet` for the
executor, exporter and context builder, `inherit` for the orchestrator), so agent files never
pin a version that goes stale. In VS Code, model names are picker labels that vary by account,
so `auto` leaves the field out and the agent uses the model the user picked. An explicit value in
`models` is written as given. `begin_run` records the resolved models, overlaid with any model an
agent reports for itself, in `results.json`, and the report header shows them.

## 11. Commands

| Command                            | Action                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| `/tessa-init`                      | Scaffold config, detect stack, write host files with model settings |
| `/tessa-refresh-context`           | Rebuild the frontend map and run the crawl                          |
| `/tessa-connect-graph [server]`    | Check and connect an existing knowledge graph                       |
| `/tessa-test-story <id or text>`   | Full flow (section 1)                                               |
| `/tessa-run <story> [test-id ...]` | Run an approved plan without replanning                             |
| `/tessa-rerun-failed [run]`        | Rerun failed tests only                                             |
| `/tessa-diff <runA> <runB>`        | Compare two runs                                                    |
| `/tessa-export [run]`              | Open review and export selected tests                               |

## 12. Schemas

`config.schema.json`, `test-ir.schema.json`, `results.schema.json`, `selection.schema.json`,
`run-diff.schema.json`. Defined first; everything else depends on them.

## 13. Config (example)

```yaml
app:
  start: 'npm run dev'
  url: 'http://localhost:3000'
  stack: react-router # selects adapter
db:
  allowed_hosts: [localhost, 127.0.0.1]
  profiles:
    default: ['scripts/seed/base.sql', 'scripts/seed/users.sql']
    admin-heavy: ['scripts/seed/base.sql', 'scripts/seed/admins.sql']
auth:
  mode: manual
personas:
  - name: viewer
    seed_profile: default
  - name: admin
    seed_profile: admin-heavy
artifacts:
  root: 'ai-test-artifacts'
context:
  knowledge_graph:
    enabled: true
    mode: hybrid # builtin | external | hybrid
    mcp_server: 'frontend-kg'
    query_mapping: '.tessa/kg-mapping.yaml'
    max_staleness_commits: 20
  static_map:
    adapter: react-router
    include: ['src/**']
    exclude: ['**/*.test.*', '**/*.stories.*']
  runtime_crawl:
    enabled: true
    max_depth: 4
  hints: 'ai-test-artifacts/context/hints.md'
review:
  mode: local-server # local-server | static
  show_code_preview: true
  show_overlap: true
export:
  target: auto # auto | playwright-ts | playwright-dotnet | cypress-ts | selenium-csharp
  detect_from: [package.json, '*.csproj', pom.xml]
  conventions:
    adapt_to_codebase: true
    page_objects_dir: 'tests/pages'
    test_dir: 'tests/e2e'
    naming: '{feature}.{scenario}.spec'
  validate:
    compile: true
    run_once: true
  auth:
    strategy: stored-session
models:
  default: auto
  orchestrator: auto
  context_builder: auto
  planner: auto
  executor: auto
  triage: auto
  exporter: auto
```

## 14. Artifact layout (in the user's repo)

```
ai-test-artifacts/
  context/          frontend-map.json, runtime-map.json, hints.md      (commit)
  plans/<story>/    tests.json, plan.md                                (commit)
  runs/<run-id>/    results.json, report.html, screenshots/, env-state.json   (gitignore)
  diffs/            <runA>__<runB>.json + .html                        (gitignore)
  export/<fw>/      generated tests, export-summary.md                 (commit after review)
  .session/         storage state captured for validating exports      (gitignore)
```

## 15. Repository and package layout

```
agents/              orchestrator, context-builder, planner, executor, triage, exporter (host-neutral)
skills/              story-analysis, ui-flow-discovery, test-planning, browser-execution,
                     failure-triage, export-conventions, adapter-<framework>/
commands/            tessa-init, tessa-refresh-context, tessa-test-story, tessa-run,
                     tessa-rerun-failed, tessa-diff, tessa-export
mcp-server/          the tessa-qa package
  src/               app, config, context (extractors, adapters), db, export (emitters), hosts,
                     init, plans, report, results, runs, schemas, util; server.ts, cli.ts, bin.ts
  templates/         report/ and diff/ page templates
  scripts/           schema type generation, pack-assets (copies the folders below into the
                     package), build-plugin
schemas/             *.schema.json
templates/           config.yaml, kg-mapping.yaml, hints.md, gitignore (written by /tessa-init)
plugins/claude-code/ the generated Claude Code plugin; .claude-plugin/marketplace.json lists it
testing/             sample-app/, the app Tessa is developed against
docs/                INSTALL, USAGE, ARCHITECTURE, SECURITY
```

The published package carries `schemas/`, `agents/`, `commands/`, `skills/` and the init
templates (as `init-templates/`) beside `dist/`; the server finds them there, or in the
repository when run from a clone.

Agent content stays host-neutral; `write_host_files` (run by `/tessa-init`) writes it in the
format of the host. Every generated file carries a `tessa-generated` marker; only marked files
are replaced or removed, and JSON configs gain only Tessa's own entry.

| Neutral                         | Claude Code                                                                                            | VS Code agent mode                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Agent                           | `.claude/agents/<name>.md` (subagent)                                                                  | `.github/agents/<name>.agent.md` (custom agent)                      |
| Delegating agent (orchestrator) | `.claude/skills/<name>/SKILL.md`, followed by the main conversation (subagents cannot start subagents) | Custom agent with `agent` tool and `agents:` list; prompts run in it |
| Command                         | `.claude/commands/<name>.md`                                                                           | `.github/prompts/<name>.prompt.md`                                   |
| Skill                           | `.claude/skills/<name>/SKILL.md`                                                                       | `.github/skills/<name>/SKILL.md`                                     |
| `tessa-mcp/<t>`                 | `mcp__tessa-mcp__<t>`                                                                                  | `tessa-mcp/<t>`                                                      |
| `read`, `search`                | `Read`; `Grep`, `Glob`                                                                                 | `read`; `search`                                                     |
| `browser`                       | Playwright MCP server named `playwright`                                                               | Integrated browser tool set `browser`                                |
| MCP server                      | `.mcp.json` → `npx -y tessa-qa@<version> mcp`                                                          | `.vscode/mcp.json` → same, with `--workspace`                        |

In Claude Code, commands never pre-approve `apply_handoff`, `init_workspace`, `reset_db`,
`validate_export`, `capture_session`, `approve_plan`, `record_selection` or `write_host_files`,
so the host still asks before each call.
