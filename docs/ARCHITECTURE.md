# Tessa — Architecture

Tessa is packaged as a plugin that bundles skills, agents, commands, one MCP server (`tessa-mcp`),
and config templates. Agents and skills hold judgment; the MCP server holds every deterministic or
side-effecting operation. JSON schemas are the contracts between all parts.

## 1. End-to-end flow

1. `/tessa-test-story <story>` starts the orchestrator.
2. Context: the frontend map is refreshed if stale; the story-scoped subgraph is retrieved.
3. Planner produces scenarios in the neutral test format → `plans/<story>/tests.json`.
4. **Gate:** the user approves or edits the plan.
5. App is started and the database seeded with the persona's seed profile.
6. **Gate:** for each persona, Tessa opens the login page and waits for the user to sign in; session state is saved.
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

| Skill                 | Purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `story-analysis`      | Acceptance criteria, personas, edge cases, implicit requirements                                   |
| `ui-flow-discovery`   | Using context queries to understand screens, guards, navigation                                    |
| `adapter-<framework>` | Where routes, guards, permissions, test IDs live (React Router first; Next.js, Angular, Vue later) |
| `test-planning`       | Neutral test format rules, coverage heuristics, persona × permission matrices, dedup               |
| `browser-execution`   | Step protocol, waits, evidence capture, auth-pause protocol                                        |
| `failure-triage`      | Failure classes and the evidence each needs                                                        |
| `export-conventions`  | Detecting and following page objects, fixtures, naming, layout                                     |

Stack adapters are the main extension point: an adapter skill plus an extractor adapter in code.

## 4. MCP server: `tessa-mcp`

| Group              | Tools                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config             | `load_config`, `validate_config`, `detect_stack`, `init_workspace`                                                                                                   |
| App lifecycle      | `start_app`, `stop_app`, `health_check`                                                                                                                              |
| Database           | `seed_db(profile)`, `reset_db` — allowlisted scripts only, local hosts only                                                                                          |
| Context            | `build_static_map`, `context_freshness`, `routes_for_feature`, `components_for_route`, `permissions_for_route`, `api_calls_for_component`, `selectors_for_component` |
| Auth               | `await_manual_login(persona)`, `save_session_state`                                                                                                                  |
| Evidence & results | `capture_env_state`, `record_step`, `write_results`                                                                                                                  |
| Review             | `render_report`, `serve_review`, `get_selection`, `stop_review`                                                                                                      |
| Runs               | `list_runs`, `diff_runs`, `failed_test_ids`                                                                                                                          |
| Export             | `emit_tests(selection, target)`, `validate_export`                                                                                                                   |

Internal modules: static extractor + framework adapters (ts-morph / tree-sitter), context query
router, report renderer (fixed HTML/CSS/JS template), review server, emitters per target, run diff
engine, export validator.

External MCP servers (configured, not built): browser (VS Code agent browser or Playwright MCP),
optional knowledge graph, optional story source (Jira/Azure DevOps, read-only, post-v1.0).

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
- `hybrid` — external first, built-in fills gaps (e.g. selectors, guards).

`context_freshness` warns in the report when the graph's indexed commit lags HEAD by more than `max_staleness_commits`.

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

Page features: a checkbox per card, filters (status, persona, story), "select all passing", and a sticky footer with the selection count and an Export button.

**Review server:** served by `tessa-mcp` on `127.0.0.1`, random port, per-session token in the URL,
shut down at session end or idle timeout. Export writes `selection.json`, which the agent picks up.
Static fallback: when the report is opened from disk, it produces a selection file or a copyable
command instead.

## 8. Export pipeline

1. **Deterministic emitter** per target maps the IR to framework code. v1.0: Playwright TS,
   Playwright .NET. Later: Cypress TS, Selenium C#/Java. (Cypress is JS/TS only; for C# the options
   are Playwright .NET or Selenium.)
2. **Convention pass (LLM, optional)** adapts to page objects, fixtures, naming, helpers.
3. **Validation** compiles/lints and runs each test once headless; failures are flagged in `export-summary.md`.

Auth in exported tests uses stored sessions (Playwright storage state, `cy.session`), with values
from environment variables. Credentials are never written into test code. Target `auto` detects the
framework from `package.json`, `*.csproj`, `pom.xml`, and asks when ambiguous.

## 9. Reruns and diffs

`/tessa-rerun-failed [run]` reruns only failed tests via `failed_test_ids`. `/tessa-diff <runA> <runB>`
compares runs and writes JSON + HTML to `diffs/`. Triage interprets the diff.

## 10. Model configuration

Each role's model is set in config or left `auto`. `/tessa-init` (or `/tessa-sync-models`) writes the
configured model into each agent definition file, so config stays the single source of truth.
`auto` policy: planner and triage use the strongest reasoning model; executor needs reliable tool
use and vision; exporter and context builder can use a mid-tier model; orchestrator inherits the
host model. If the host lacks per-agent models, everything inherits and the report records what was used.

## 11. Commands

| Command                          | Action                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| `/tessa-init`                    | Scaffold config, detect stack, write model settings into agent files |
| `/tessa-refresh-context`         | Rebuild the frontend map and run the crawl                           |
| `/tessa-test-story <id or text>` | Full flow (section 1)                                                |
| `/tessa-rerun-failed [run]`      | Rerun failed tests only                                              |
| `/tessa-diff <runA> <runB>`      | Compare two runs                                                     |
| `/tessa-export [run]`            | Open review and export selected tests                                |

## 12. Schemas

`config.schema.json`, `test-ir.schema.json`, `results.schema.json`, `selection.schema.json`,
`run-diff.schema.json`. Defined first; everything else depends on them.

## 13. Config (target shape)

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
  runs/<ts>/        results.json, report.html, screenshots/, env-state.json   (gitignore)
  diffs/            <runA>__<runB>.json + .html                        (gitignore)
  export/<fw>/      generated tests, export-summary.md                 (commit after review)
  .session/         stored auth state                                  (gitignore)
```

## 15. Plugin layout (this repo, target)

```
agents/        orchestrator, context-builder, planner, executor, triage, exporter
skills/        story-analysis, ui-flow-discovery, test-planning, browser-execution,
               failure-triage, export-conventions, adapters/<framework>/
commands/      tessa-init, tessa-refresh-context, tessa-test-story, tessa-rerun-failed, tessa-diff, tessa-export
mcp-server/    src/{config,app,db,context,auth,results,review,runs,export}, emitters/, extractors/, templates/report/
schemas/       *.schema.json
templates/     config.yaml, kg-mapping.yaml, hints.md, gitignore
testing/       sample-app/ and other test targets used during development
docs/          ARCHITECTURE.md
```

Agent content stays host-neutral; `/tessa-init` writes it in the format of the host (VS Code agent mode or Claude Code).
