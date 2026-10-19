# Tessa

**An agentic tester for Claude Code and VS Code agent mode.** Give Tessa a user story. It reads
the story and your code, plans the tests a careful manual tester would run, and runs them in
your host's browser while you sign in. You get a clean HTML report, and the tests you pick
export to your own framework: Playwright TS or Playwright .NET.

Tessa does the legwork and you keep the decisions. It stops for you at four points: you approve
the plan, sign in yourself, choose which tests to keep, and confirm before anything is written
into your repository.

> **Status: pre-1.0 (v0.9.1).** Every feature for 1.0 is built and tested against the sample app in
> this repository. The first pilot on a real project is next. See [Status and limits](#status-and-limits).

## How it works

```
 story ──► plan ──► you approve ──► run in your browser ──► report ──► you pick tests ──► export ──► you confirm
            │                         (you sign in)            │                                         │
      reads the code,                                    triage explains                        diff into your
      routes, guards,                                    every failure                          test folder
      selectors
```

1. **Plan.** The planner reads the story, pulls the routes, guards and selectors it touches from a
   map of your frontend, and writes tests in a framework-neutral format. You see the plan as
   Markdown and approve it, or ask for changes.
2. **Run.** Tessa starts your app, seeds your local database with the right profile for each
   persona, opens the login page, and waits while you sign in. Then it runs every step in the
   browser, with a screenshot and the environment it ran in.
3. **Triage.** Each failure is classed as an app bug, a test or selector problem, an environment
   problem, or a data problem, with the evidence behind it.
4. **Report.** A local review page shows each test's intent, steps, screenshots and failures, and
   quality signals such as selector stability, rerun consistency and overlap with other tests. You
   tick the tests worth keeping.
5. **Export.** The selected tests are generated as Playwright code, adapted to your repository's
   conventions, compiled, and proposed as a diff into your test folder.

## Features

- **Two hosts:** Claude Code and VS Code agent mode (GitHub Copilot), from the same agents,
  commands and skills.
- **Plans that follow the code:** a static map of routes, permission guards, links, API calls,
  feature flags and test IDs; an optional crawl per persona; and story-scoped retrieval. It can
  also use your team's existing knowledge graph.
- **You stay signed in, Tessa stays out:** sign-in always happens by hand, in your host's browser.
  Tessa has no tool that takes a password.
- **Safe database seeding:** only the SQL files you list, only against local hosts on your
  allowlist.
- **Reruns and diffs:** rerun just the failures, and compare two runs as JSON and HTML, with triage
  notes on what regressed.
- **Deterministic export:** code is generated from the plan by a fixed emitter, never written from
  memory, then adapted to your page objects, fixtures and naming.
- **Per-role models:** pick a model for each agent role, or leave it on `auto`.

## Get started

Requirements: Node 24 or later, Claude Code or VS Code with Copilot agent mode, your app running
locally, and a local Postgres database for seeding.

```bash
npx tessa-qa@0.9.1 install --host claude-code    # or --host vscode-agent
```

Restart your host, approve the `tessa-mcp` server, and run `/tessa-init`. Then try a story:

```text
/tessa-test-story stories/checkout.md
```

`tessa-qa` is not on npm yet. Until it is, install from a local build:
[docs/INSTALL.md](docs/INSTALL.md#before-the-package-is-published) has the steps, along with the
Claude Code plugin and the browser setup for each host.

## Commands

| Command                            | What it does                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `/tessa-init`                      | Detect the stack and write the config, hints, `.gitignore` entries and host files |
| `/tessa-test-story <story>`        | Plan, approve, run, triage, report and select, end to end                         |
| `/tessa-run <story> [test-id ...]` | Run an approved plan again, without replanning                                    |
| `/tessa-rerun-failed [run]`        | Rerun only the tests that failed in a run                                         |
| `/tessa-diff [run-a] [run-b]`      | Compare two runs and triage what changed                                          |
| `/tessa-export [run] [target]`     | Export the selected tests and propose them for your repository                    |
| `/tessa-refresh-context [crawl]`   | Rebuild the frontend map, and optionally crawl the app per persona                |

[docs/USAGE.md](docs/USAGE.md) walks through a first run, the config, what Tessa writes in your
repository, and troubleshooting.

## Supported today

| Area            | Supported                                                            | Planned                        |
| --------------- | -------------------------------------------------------------------- | ------------------------------ |
| Hosts           | Claude Code, VS Code agent mode                                      |                                |
| Frontend stacks | React Router (framework mode), Angular 14+ (standalone and NgModule) | Next.js, Vue                   |
| Databases       | Postgres on a local host                                             |                                |
| Export targets  | Playwright TS, Playwright .NET (NUnit)                               | Cypress TS, Selenium C#/Java   |
| Stories         | Text or a Markdown file                                              | Jira, Azure DevOps (read-only) |

## Status and limits

- **No real-project pilot yet.** Tessa has been run end to end against the sample app in
  `testing/sample-app`, mostly by driving its tools directly. The generated host files have not
  yet run inside a real Claude Code or VS Code session. The pilot gates v1.0.0.
- **The Angular adapter has been tested against fixture apps only**, not yet a real Angular
  project.
- **Exports are checked by compiling.** Running each exported test once (`export.validate.run_once`)
  is built but not yet verified.
- **The Claude Code plugin has not been validated** with `claude plugin validate`.

## Documentation

| Document                                     | What it covers                                                       |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [docs/INSTALL.md](docs/INSTALL.md)           | Installing for each host, the plugin, browsers, models, updating     |
| [docs/USAGE.md](docs/USAGE.md)               | A first run, the gates, config reference, artifacts, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Agents, skills, the MCP server's tools, data flow, schemas           |
| [docs/SECURITY.md](docs/SECURITY.md)         | Threat model, controls, remaining risks, reporting a vulnerability   |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Development setup, conventions, adding an adapter or an emitter      |
| [CHANGELOG.md](CHANGELOG.md)                 | What changed in each release                                         |

## Repository layout

```
agents/          host-neutral agent definitions (orchestrator, planner, executor, ...)
commands/        host-neutral slash commands (/tessa-*)
skills/          host-neutral skills, including stack adapters (adapter-react-router)
mcp-server/      the tessa-qa package: the tessa-mcp server, the CLI, report templates
schemas/         JSON Schemas for config, test plans, results, selections and run diffs
templates/       files /tessa-init writes into your repository
plugins/         the generated Claude Code plugin
testing/         the sample app Tessa is developed against
docs/            documentation
```

## Development

Requires Node 24 or later and Docker (for the sample app's database).

```bash
npm install
npm run ci       # format, schemas, type-check, lint, tests, build, plugin check
npm run sample   # start the sample app Tessa tests against
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and how the pieces fit together.

## Licence

[MIT](LICENSE)
