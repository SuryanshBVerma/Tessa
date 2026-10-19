# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org/);
before 1.0, each minor version is one phase of the plan.

## Unreleased

### Added

- Angular adapter: routes from standalone `provideRouter` and NgModule `forRoot`/`forChild`,
  through lazy `loadComponent` and `loadChildren`; route guards (`canActivate`, `canMatch`,
  `canActivateChild`) and role lists in route `data`; component templates (inline and
  `templateUrl`) with test ids, labels, text, `routerLink` targets and permission checks in
  `@if`, `*ngIf` and custom directives; `HttpClient` calls. With the `adapter-angular` skill
  for Angular Material, overlays and reactive forms.
- The frontend map follows `tsconfig` path aliases for every stack.
- `detect_stack` suggests the stack's usual dev server URL (`url_hint`).
- Monorepos: `detect_stack` finds the frontend in a subfolder (`app_root`) and reports backends
  beside it (.NET Web, Node, Spring Boot); `/tessa-init` sets `app.cwd` to the app's folder, and
  the frontend map reads routes, source globs and tsconfig aliases from there.
- The planner, executor and context builder follow the adapter skill for the app's stack.

## 0.9.1 — 2026-10-16

### Fixed

- The drive-letter path test now runs only on Windows; on Linux, `C:\Windows` is an ordinary file
  name and stays inside the workspace.

## 0.9.0 — 2026-10-16

### Added

- Per-role models (`models` in config) with an `auto` policy: aliases in Claude Code
  (`opus`, `sonnet`, `inherit`), the user's picked model in VS Code. Each run records the models
  it used, and the report shows them.
- `write_host_files` and `tessa-qa install`: write Tessa's agents, commands and skills for Claude
  Code or VS Code agent mode, and register `tessa-mcp` with the host. Only files marked
  `tessa-generated` are ever replaced or removed.
- The context-builder agent, used by `/tessa-refresh-context` and the orchestrator.
- The `tessa-qa` package, with the `tessa-qa` CLI (`install`, `mcp`, `version`) and the
  `tessa-mcp` binary.
- A Claude Code plugin in `plugins/claude-code/`, generated from the host-neutral sources, and a
  plugin marketplace file.
- docs/INSTALL.md and docs/SECURITY.md.

### Security

- Plan text can no longer end a comment or string in exported code through a Unicode line
  separator.
- Exported project and runner files cannot be edited before validation runs them.
- A symlinked parent folder can no longer redirect a write outside the workspace.
- `health_path` and `login_path` cannot point at another host.
- Screenshot import refuses network and device paths, and reads files through one handle.
- `load_config` reads only YAML files and no longer quotes file content in errors.
- The handoff moves only test files, never into control folders such as `.git` or `.github`, and
  flags a diff that was cut short.
- Tools that run code, write into the repository or record a user's decision are never
  pre-approved by Claude Code commands.

## 0.8.0 — 2026-10-16

### Added

- `/tessa-rerun-failed`: rerun a run's failed tests as a new run linked to it (`list_runs`,
  `failed_test_ids`, `begin_run` with `rerun_of`).
- `/tessa-diff` and `diff_runs`: compare two runs of a story as JSON and HTML, with the files
  changed between their commits.
- The triage agent and the `failure-triage` skill: class each failure as an app bug, a test or
  selector problem, an environment problem or a data problem (`record_triage`, `annotate_diff`).

## 0.7.0 — 2026-10-16

### Added

- Export to Playwright TS and Playwright .NET from the reviewer's selection, with a deterministic
  emitter, an optional convention pass (the exporter agent and `export-conventions` skill),
  validation, and a confirmed handoff into the repository's test folder.

### Known limits

- Exports are validated by compiling; running them once is deferred.

## 0.6.0 — 2026-10-16

### Added

- The frontend map: a static extractor with a React Router adapter, five context query tools,
  `context_freshness`, story-scoped retrieval, knowledge-graph modes, and a per-persona crawl.

## 0.5.0 — 2026-10-16

### Added

- The planner agent with the `story-analysis` and `test-planning` skills, plan approval bound to
  the plan's hash, and `/tessa-test-story` with the orchestrator.

## 0.4.0 — 2026-10-16

### Added

- The HTML report, the local review server (127.0.0.1, random port, session token, idle timeout)
  and a static fallback for selecting tests.

## 0.3.0 — 2026-10-16

### Added

- The executor agent and `browser-execution` skill, with the sign-in pause in the host browser,
  `record_step` and `write_results`.

## 0.2.0 — 2026-10-16

### Added

- App lifecycle (`start_app`, `stop_app`, `health_check`), database seeding restricted to local
  hosts, and environment capture.

## 0.1.1 — 2026-10-16

### Fixed

- An unanchored ignore pattern hid every `context/` folder from Git.

## 0.1.0 — 2026-10-16

### Added

- JSON Schemas for config, test plans, results, selections and run diffs; config loading and
  validation; `/tessa-init`.

## 0.0.1 — 2026-10-16

### Added

- Repository foundations, CI, and the sample app.
