# Tessa

Tessa is an agentic tester for Claude Code and VS Code agent mode. It reads a user story and the
implementation, seeds a local database, tests the app in the host's browser like a manual
tester while you sign in, and produces an HTML report. The tests you select there export to
your own framework: Playwright TS or Playwright .NET.

You stay in charge at four points: you approve the plan, sign in yourself, pick the tests to
keep, and confirm before exported tests move into your repository.

Status: pre-1.0. The pilot on a real project is still to come.

- Install: [docs/INSTALL.md](docs/INSTALL.md)
- Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Commands

| Command                     | What it does                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| `/tessa-init`               | Set up Tessa: config, hints, `.gitignore`, host files and models |
| `/tessa-test-story <story>` | Plan, approve, run, triage, report and select, end to end        |
| `/tessa-run <story>`        | Run an approved plan again                                       |
| `/tessa-rerun-failed`       | Rerun only the tests that failed                                 |
| `/tessa-diff`               | Compare two runs and triage what changed                         |
| `/tessa-export`             | Export the selected tests and propose them for the repo          |
| `/tessa-refresh-context`    | Rebuild the frontend map, optionally crawl per persona           |

## Development

Requires Node 24+ and Docker.

```bash
npm install
npm run ci       # format, schemas, type-check, lint, tests, build, plugin check
npm run sample   # start the sample app Tessa tests against
```

`agents/`, `commands/` and `skills/` are host-neutral; `npm run plugin:build` regenerates the
Claude Code plugin in `plugins/claude-code/` from them. See
[testing/sample-app/README.md](testing/sample-app/README.md) for the sample app.

## Licence

[MIT](LICENSE)
