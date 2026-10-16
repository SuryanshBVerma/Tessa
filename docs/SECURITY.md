# Security

Tessa runs on a developer's machine, inside an AI agent host, against an app and a database the
developer runs locally. This page sets out what it protects, what it trusts, the controls that
enforce that, and the risks that remain.

## Reporting a vulnerability

Do not open a public issue. Contact the maintainers privately with the affected version, the
steps to reproduce, and the impact. If you find a secret in the repository, report it the same
way so it can be revoked.

## What Tessa protects

- **The repository under test.** Tessa writes only inside it, and only where a tool's contract
  says it may.
- **Databases.** Seeding wipes and reloads data, so it must never reach a shared or production
  database.
- **Credentials and sessions** of the app under test. Tessa never asks for, stores or replays them.
- **Run evidence.** Screenshots and pages can show personal or confidential data.
- **The host's configuration.** Agent, command, skill and MCP files decide what an agent may do.

## Trust boundaries

| Party                                                                     | Trusted for                                                    | Not trusted for                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The developer                                                             | Every decision at a gate                                       | —                                                                                      |
| `tessa-mcp` (this package)                                                | Enforcing the invariants below, whatever arguments it is given | Judgement                                                                              |
| The agent host and its model                                              | Following the agents' instructions                             | Resisting prompt injection; it can be talked into calling tools with hostile arguments |
| Stories, repository code, app pages, knowledge-graph answers, run results | Nothing: they are data                                         | Instructions of any kind                                                               |
| Other processes on the machine                                            | Nothing                                                        | Reaching the review server or Tessa's files                                            |

The design rule follows from this: agents hold judgement, the server holds every side effect,
and the server checks each call as if the arguments came from an attacker.

## Threats and controls

| Threat                                                                              | Control                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Injected content makes the agent wipe a real database                               | `seed_db` and `reset_db` run only the SQL files a profile lists in config, against a URL read from an environment variable, and refuse any host that is not loopback and allowlisted, including `host`/`hostaddr` query overrides and socket paths                                                                                                                                                                                           | `src/db/guard.ts`, tests in `test/db.test.ts`       |
| Injected content makes a tool read or write outside the repository                  | Every path is resolved inside the workspace; the nearest part of it that exists is resolved through symlinks, so a linked parent folder cannot redirect a new file, and dangling links are refused. IDs used in paths are pattern-checked                                                                                                                                                                                                    | `src/util/paths.ts`                                 |
| Command injection through config or arguments                                       | `start_app` parses `app.start` into an argument list and refuses shell operators; git, tsc and dotnet run with argument arrays, never a shell string                                                                                                                                                                                                                                                                                         | `src/app/command.ts`, `src/runs/diff.ts`            |
| Tests run without the user agreeing to them                                         | `begin_run` refuses a plan that is not approved, or changed since approval (SHA-256 of its canonical JSON)                                                                                                                                                                                                                                                                                                                                   | `src/plans/plans.ts`                                |
| Exported code lands in the repository without review                                | `apply_handoff` writes only a proposal returned by `propose_handoff`, and only if nothing changed since; it moves only test files (by path, not by the manifest's flag) and never into `.git`, `.github`, `.vscode`, `.claude`, `.tessa` or `node_modules`; a cut-short diff is flagged so the user opens the files                                                                                                                          | `src/export/handoff.ts`                             |
| Script injection into the report or diff page from run data                         | Fixed templates; the report builds its DOM from embedded JSON (with `<` escaped) under a nonce CSP; the diff page is rendered server-side with every value escaped and a CSP that allows no script                                                                                                                                                                                                                                           | `src/report/`, `templates/`                         |
| Code injection into exported tests from plan values                                 | Emitters write values as escaped string literals and regexes, never as code. Comments drop every character that ends a line in TypeScript or C# (CR, LF, NEL, U+2028, U+2029) and all control characters; string literals escape NEL, U+2028 and U+2029                                                                                                                                                                                      | `src/export/emitters/common.ts`                     |
| Other local processes or web pages use the review server                            | Binds to 127.0.0.1 on a random port, needs a per-session token, checks Host and Origin, and stops after an idle timeout                                                                                                                                                                                                                                                                                                                      | `src/report/server.ts`                              |
| Credentials or sessions are captured                                                | Sign-in is always by hand; Tessa has no tool that takes a password. Runs use the host browser's own session. For validating exports, `capture_session` opens Playwright's browser and Playwright saves the storage state to the gitignored `.session/`; Tessa passes only the path and never reads the file. Exported tests take that path from `TESSA_AUTH_<PERSONA>`                                                                       | `src/export/validate.ts`                            |
| Screenshots or session state are committed                                          | `runs/`, `diffs/` and `.session/` are gitignored by the managed `.gitignore` block; screenshots are accepted only as PNG, JPEG or WebP, checked by content                                                                                                                                                                                                                                                                                   | `src/init/`, `src/runs/screenshots.ts`              |
| Tessa overwrites the team's own host files                                          | Host files are replaced or removed only when they carry the `tessa-generated` marker; JSON configs gain only Tessa's entry and are left alone if they are not plain JSON                                                                                                                                                                                                                                                                     | `src/hosts/write.ts`                                |
| The database URL or other secrets leak through tool output or errors                | The URL is never returned; errors carry messages only, no stack traces                                                                                                                                                                                                                                                                                                                                                                       | `src/db/seed.ts`, `src/server.ts`                   |
| A compromised or vulnerable dependency                                              | Exact version pins and a lockfile; `npm audit --audit-level=high` in CI; MCP entries pin the exact `tessa-qa` version; exported tests pin Playwright 1.63.0 (never below 1.55.1, GHSA-7mvr-c777-76hp)                                                                                                                                                                                                                                        | `package.json`, CI                                  |
| An agent gets more tools than its job needs                                         | Each agent lists its tools; triage and planner cannot drive the browser; the Claude Code browser list leaves out page script evaluation and file upload                                                                                                                                                                                                                                                                                      | `agents/`, `src/hosts/render.ts`                    |
| Exported code runs without the host asking                                          | `update_export_file` cannot touch project or runner files (`*.csproj`, `playwright.config.*`, `tsconfig*.json`, `package.json`, `Directory.Build.*`, `global.json`, `nuget.config`). `validate_export` runs the tests, so it is marked destructive and open-world, and Claude Code commands never pre-approve it, `apply_handoff`, `init_workspace`, `reset_db`, `capture_session`, `approve_plan`, `record_selection` or `write_host_files` | `src/export/export.ts`, `src/hosts/render.ts`       |
| A repository's config sends the health check or the user's sign-in elsewhere        | `health_path` and `login_path` must be paths that cannot change host (`//x` and `/\x` are refused), and every URL built from them is checked to keep the app's origin                                                                                                                                                                                                                                                                        | `schemas/config.schema.json`, `src/util/app-url.ts` |
| A screenshot path makes Windows connect to another machine, or swaps files mid-copy | Network and device paths (`\\server\share`, `//server`, `\\?\`) are refused before any file call; local files are opened once, and size, type and copy all go through that handle; base64 input is capped before decoding                                                                                                                                                                                                                    | `src/runs/screenshots.ts`                           |
| A tool echoes secrets from a file that is not a config                              | `load_config` reads only `.yaml`/`.yml` files and reports YAML errors by line and column without quoting the source                                                                                                                                                                                                                                                                                                                          | `src/config/load.ts`                                |

## Security review (v0.9.0)

An independent review of the server, templates and agent files before v0.9.0 found nine issues;
all are fixed, each with a regression test. The most serious was a plan's text ending a comment
in exported code with a Unicode line separator, which the plan view would not show. Others: build
files editable before `validate_export` ran them, a symlinked parent folder escaping the
workspace, `login_path` able to point at another host, network paths in screenshot import,
config errors quoting file content, the handoff trusting its manifest, and gate tools that a host
could pre-approve. They are covered in the table above.

## Remaining risks

- **Gates the server cannot enforce.** Sign-in, test selection and the final "move into the repo"
  question are asked by the agent. A model that has been prompt-injected could skip asking. The
  server still enforces plan approval and the proposal check, and the host's own tool
  permission prompts remain in place for the tools listed above.
- **`npx` fetches the package when the host starts the server.** The version is pinned, but npm
  checks integrity only against the registry. Teams that need more can install `tessa-qa` as a
  dev dependency and point the MCP entry at `node_modules/tessa-qa/dist/cli.js`.
- **Run evidence is sensitive.** Screenshots stay on the machine and out of Git, but anyone with
  access to the working copy can read them. Delete `runs/` when it is no longer needed.
- **The browser server is the user's.** For Claude Code, the Playwright MCP server and its version
  are configured by the user, outside Tessa.
- **Generated tests run code by design.** `validate_export` with `run_once` runs the exported
  tests, which the convention pass may have edited. The host asks before each call; do not
  approve it without looking at the export folder when the export was adapted.
- **Smaller limits not yet in place.** Some readers load a file before checking its size (source
  files for the frontend map), and `run-state.json` is trusted once written. Both are inside the
  workspace and written by Tessa.
- **Exports were validated by compiling only** in v0.7 and later; running them once is deferred.

## Secret handling

- Tessa never asks for a password, token or database URL in chat or in config. The database URL
  is read from the environment variable named in `db.url_env` (or a gitignored `.env`).
- `.env` files are gitignored; only `.env.example` files with empty values are tracked.
- The repository's tracked files and history were scanned for credentials, keys and tokens
  before release; the only matches are placeholder URLs (`postgres://u:p@...`) in tests.

## Dependencies

Runtime dependencies are `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `pg`, `typescript`,
`yaml` and `zod`, all pinned. `npm audit` reports no known vulnerabilities at the time of release,
and every runtime package is under a permissive licence (MIT, ISC, BSD or Apache-2.0).
