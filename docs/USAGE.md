# Using Tessa

This guide takes you from a fresh install to exported tests, then covers the config, what Tessa
writes in your repository, and what to do when something goes wrong. Install Tessa first:
[INSTALL.md](INSTALL.md).

## Before you start

Tessa tests your app the way a person would, on your machine. It needs:

- **The app, runnable locally** with one command (for example `npm run dev` or `npm start`), on a
  `localhost` or `127.0.0.1` URL. If the frontend talks to a separate backend (common with
  Angular), start the backend yourself first, or use one script that starts both.
- **A local development database** and plain `.sql` seed scripts that put it into a known state
  (optional: with `db.enabled: false`, Tessa never touches the database and tests run on the data
  the app already has):
  users for each role, and the data your stories need. Tessa runs only the scripts you list, and
  only against hosts on your allowlist. It never touches a shared or production database.
- **One account per persona** you want to test (for example viewer, editor, admin). You sign in
  as each of them yourself when Tessa asks.
- **A story** as text or a Markdown file, ideally with acceptance criteria.

## A first run

### 1. Set up: `/tessa-init`

Tessa detects your stack and export target, finds candidate seed scripts, and asks you to
confirm:

- the app URL and start command;
- seed profiles: a name and an ordered list of SQL files for each;
- personas: one per role, each with the seed profile it needs;
- the export target, if more than one framework was found.

It shows a dry run of the files it will write, then writes `.tessa/config.yaml`, a hints file,
a managed block in `.gitignore`, and the host files with the models from the config. It never asks
for passwords or database URLs: set the URL in the environment variable named by `db.url_env`
(default `DATABASE_URL`), or in a gitignored `.env`.

Worth five minutes: fill in the hints file (`ai-test-artifacts/context/hints.md`) with a glossary,
the journeys that matter, quirks of the app, and which seed profile suits which feature. The
planner reads it.

### 2. Map the frontend: `/tessa-refresh-context`

Tessa reads your source with the stack adapter and writes a map of routes, guards, links, API
calls, feature flags and selectors to `ai-test-artifacts/context/`. Later runs only re-read
changed files. Add `crawl` to also visit the app once per persona and compare what each user
sees with what the code defines: `/tessa-refresh-context crawl`.

`/tessa-test-story` refreshes a stale map by itself, so this step is optional, but the summary
is a good check that Tessa understood your app.

### 3. Test a story: `/tessa-test-story <story>`

Pass the story text, or the path to a Markdown file in the repository:

```text
/tessa-test-story stories/create-ticket.md
```

What happens next, and where you come in:

1. **Plan.** Tessa writes `ai-test-artifacts/plans/<story>/tests.json` and a readable `plan.md`,
   and shows you the tests per acceptance criterion, plus any gaps, assumptions and questions.
2. **You approve.** Read the plan and approve it, or say what to change. Nothing runs before
   you approve, and editing the plan afterwards needs a fresh approval.
3. **App and data.** Tessa starts the app if it is not running, and seeds the database before
   each test with that test's seed profile.
4. **You sign in.** For each persona, Tessa opens the login page in the host's browser and waits.
   Sign in as that persona and say so. To switch persona, it asks you to sign out and sign in
   again.
5. **Run.** Each step runs in the browser with a screenshot. A failed step ends that test, and
   the rest of its steps are marked skipped.
6. **Triage.** Failures are classed (app bug, test or selector, environment, data) with the
   evidence behind each.
7. **You pick tests.** Tessa serves the report at a local URL with a one-time token. Tick the
   tests worth keeping and press **Export**. The URL works only on your machine; do not share it.
8. **Export and you confirm.** See the next step.

### 4. Export: `/tessa-export`

The selected tests are generated as Playwright code in
`ai-test-artifacts/export/<target>/<story>/`, adapted to your repository's page objects, fixtures
and naming if `export.conventions.adapt_to_codebase` is on, and compiled. Tessa then shows you
the diff that would copy the test files into your test folder (`export.conventions.test_dir`).
Nothing is written there until you say yes.

Exported tests sign in from stored sessions, never from credentials in code. The export's
`README.md` explains how to create a session file per persona, and which environment variable
(`TESSA_AUTH_<PERSONA>`) points at it.

## After the first run

| Situation                         | Command                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Run an approved plan again        | `/tessa-run <story>` or `/tessa-run <story> <test-id> ...`                         |
| Rerun only what failed            | `/tessa-rerun-failed` (newest run) or `/tessa-rerun-failed <run-id>`               |
| See what changed between two runs | `/tessa-diff` (newest run against the one before) or `/tessa-diff <run-a> <run-b>` |
| Export from an earlier run        | `/tessa-export <run-id>`                                                           |
| The code changed a lot            | `/tessa-refresh-context`                                                           |

A rerun is linked to the run it repeats, and its diff compares only the tests it reran. Diffs
are written as JSON and as an HTML page to `ai-test-artifacts/diffs/`; triage adds a note to each
regression explaining what changed.

## Reading the report

Each test is one row: status, name, persona and duration. Open it for:

- **Intent:** what the test proves, and the acceptance criteria it covers.
- **Failure:** the failing step, expected against actual, and its screenshot.
- **Steps:** every step with its screenshot and the selector actually used.
- **Environment and quality:** persona, role, permissions, settings, feature flags, seed
  profile; selector stability (high for test IDs and roles, low for CSS or text), rerun
  consistency, tests that overlap this one, and the triage finding.
- **Code preview:** the test in your export target, if `review.show_code_preview` is on.

The header shows the run, commit, time and the model used for each role. Filter by status or
persona, and use **Select passing** to tick every passing test at once.

If you open `report.html` straight from disk, the Export button cannot reach Tessa; it saves a
`selection.json` instead, or gives you text to paste back into the chat.

## Config reference

`.tessa/config.yaml` is validated against `schemas/config.schema.json`. Run `/tessa-init` again,
or ask the agent to call `validate_config`, to check it.

| Key                                             | Default                              | Meaning                                                                                                                                |
| ----------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app.start`                                     | (required)                           | Command that starts the app. Run without a shell, so no `&&`, pipes or redirects                                                       |
| `app.cwd`                                       | repository root                      | The app's folder in a monorepo: where the start command runs and the map reads source                                                  |
| `app.url`                                       | (required)                           | Base URL; must be `localhost`, `127.0.0.1` or `[::1]`                                                                                  |
| `app.stack`                                     | (required)                           | Stack adapter, for example `react-router`                                                                                              |
| `app.health_path`                               | `/`                                  | Path polled until the app answers; any status below 500 counts                                                                         |
| `app.start_timeout_seconds`                     | `60`                                 | How long to wait for the app to come up                                                                                                |
| `db.enabled`                                    | `true`                               | `false` switches seeding off: Tessa never connects to the database, and the other `db` keys and personas' seed profiles are not needed |
| `db.url_env`                                    | `DATABASE_URL`                       | Environment variable holding the database URL                                                                                          |
| `db.allowed_hosts`                              | (required with seeding on)           | Hosts seeding may touch; only local hosts are accepted                                                                                 |
| `db.profiles`                                   | (required with seeding on)           | Seed profiles: name → ordered list of `.sql` files                                                                                     |
| `auth.mode`                                     | `manual`                             | Always manual: you sign in by hand                                                                                                     |
| `auth.login_path`                               | `/login`                             | Where Tessa sends you to sign in                                                                                                       |
| `personas`                                      | (required)                           | One entry per role: `name` and the `seed_profile` it needs                                                                             |
| `artifacts.root`                                | `ai-test-artifacts`                  | Where Tessa writes everything                                                                                                          |
| `context.static_map.include`, `exclude`         | `src/**`, none                       | Source files the map reads, relative to `app.cwd`                                                                                      |
| `context.runtime_crawl.enabled`                 | `true`                               | Allow `/tessa-refresh-context crawl`                                                                                                   |
| `context.knowledge_graph.mode`                  | `builtin`                            | `builtin` (Tessa's map), `external` (your team's graph) or `hybrid`                                                                    |
| `context.hints`                                 | `<root>/context/hints.md`            | The hand-written hints file                                                                                                            |
| `review.mode`                                   | `local-server`                       | `local-server` (served with an Export button) or `static` (file only)                                                                  |
| `review.idle_timeout_minutes`                   | `30`                                 | The review server stops after this long without requests                                                                               |
| `review.show_code_preview`, `show_overlap`      | `true`                               | Report sections                                                                                                                        |
| `export.target`                                 | `auto`                               | `playwright-ts`, `playwright-dotnet`, or `auto` to detect from your project files                                                      |
| `export.conventions.test_dir`                   | `tests/e2e` (TS), `tests/E2E` (.NET) | Where exported tests go after you confirm                                                                                              |
| `export.conventions.page_objects_dir`, `naming` |                                      | Your page objects folder; file naming such as `{feature}.{scenario}.spec`                                                              |
| `export.conventions.adapt_to_codebase`          | `true`                               | Adapt generated tests to your conventions                                                                                              |
| `export.validate.compile`, `run_once`           | `true`, `true`                       | Compile the export; run it once (see [Status](../README.md#status-and-limits))                                                         |
| `models.<role>`                                 | `auto`                               | Model per role: `orchestrator`, `context_builder`, `planner`, `executor`, `triage`, `exporter`; `default` applies to all               |

After changing `models`, run `/tessa-init` again (or `npx tessa-qa install` again) so the host files
pick up the new models.

## What Tessa writes in your repository

| Path                                                                                                 | Contents                                                      | Commit?         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| `.tessa/config.yaml`                                                                                 | The config                                                    | Yes             |
| `.claude/`, `.mcp.json` or `.github/agents`, `.github/prompts`, `.github/skills`, `.vscode/mcp.json` | Host files, marked `tessa-generated`                          | Yes             |
| `ai-test-artifacts/context/`                                                                         | Frontend map, runtime map, hints                              | Yes             |
| `ai-test-artifacts/plans/<story>/`                                                                   | `tests.json`, `plan.md`, `approval.json`                      | Yes             |
| `ai-test-artifacts/export/<target>/<story>/`                                                         | Generated tests and `export-summary.md`                       | After review    |
| `ai-test-artifacts/runs/<run-id>/`                                                                   | `results.json`, `report.html`, screenshots, environment state | No (gitignored) |
| `ai-test-artifacts/diffs/`                                                                           | Run diffs as JSON and HTML                                    | No (gitignored) |
| `ai-test-artifacts/.session/`                                                                        | Sessions captured for checking exports                        | No (gitignored) |

Screenshots can show personal or confidential data. They stay on your machine; delete old runs
when you no longer need them.

## Troubleshooting

| Symptom                                                        | What to do                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The host does not list `tessa-mcp`, or it fails to start       | Restart the host and approve the server. On Windows with Claude Code, the `.mcp.json` entry must start `cmd /c npx`; the project install writes that, the plugin does not |
| `/tessa-init` says there is no adapter for your stack          | React Router and Angular are supported so far. You can continue, but plans will lean on the story and the crawl instead of the code map                                   |
| Seeding is refused: "not a local host"                         | The database URL points somewhere other than a local host, or the host is not in `db.allowed_hosts`. This check cannot be turned off                                      |
| Seeding is refused: a `host` or `hostaddr` parameter           | Remove connection overrides from the URL's query string                                                                                                                   |
| `start_app` refuses the start command                          | Shell syntax (`&&`, pipes, `>`) is not allowed. Point `app.start` at a script, such as `npm run dev`                                                                      |
| "plan is not approved" or "changed since approval"             | Run `/tessa-run <story>` and approve the plan when asked                                                                                                                  |
| Tests fail because you were signed out mid-run                 | Sign in again when asked. If a seed profile rebuilds users, sign out first, then sign back in after seeding                                                               |
| The browser tools are missing in VS Code                       | Check `workbench.browser.enableChatTools`; your organisation's policy may turn it off                                                                                     |
| The executor has no browser in Claude Code                     | Add a Playwright MCP server named `playwright` to the project                                                                                                             |
| Playwright's own Chromium will not start when checking exports | Ask the agent to validate with `browser_channel: msedge` or `chrome` to use an installed browser; set `PLAYWRIGHT_CHANNEL` the same way when you run the exported tests   |
| The review URL stopped working                                 | The server stops after `review.idle_timeout_minutes`. Run `/tessa-export` again to serve it afresh                                                                        |
| `.vscode/mcp.json` was not updated                             | It contains comments, so Tessa left it alone. Add the entry the installer printed by hand                                                                                 |
| A file is reported as a `conflict` during install              | A file Tessa did not write sits at that path. Rename or remove it, or rerun with `--overwrite`                                                                            |
