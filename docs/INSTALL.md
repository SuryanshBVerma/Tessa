# Installing Tessa

Tessa runs inside your agent host: Claude Code, or VS Code with GitHub Copilot in agent mode. It
needs Node 24 or later, the app under test running locally, and a local development database
for seeding. Tessa refuses any database host that is not local.

There are two ways to install it. The project install works for both hosts and is the one to
use if you set models in `.tessa/config.yaml`. The Claude Code plugin is quicker but always uses
`auto` models.

## Option 1: project install (Claude Code or VS Code)

In the root of the repository you want to test:

```bash
npx tessa-qa@0.9.1 install --host claude-code --dry-run
```

The dry run lists the files Tessa would write. Then run it without `--dry-run`, or use
`--host vscode-agent` for VS Code.

| Host        | Files written                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/agents/tessa-*.md`, `.claude/commands/tessa-*.md`, `.claude/skills/*/SKILL.md`, and an entry in `.mcp.json`                    |
| VS Code     | `.github/agents/tessa-*.agent.md`, `.github/prompts/tessa-*.prompt.md`, `.github/skills/*/SKILL.md`, and an entry in `.vscode/mcp.json` |

Every generated file starts with a `tessa-generated` comment. Tessa replaces or removes only
those files; any other file at the same path is reported as a conflict and left alone. In the
MCP config it adds or updates only its own `tessa-mcp` entry, pinned to the installed version. If
`.vscode/mcp.json` has comments, Tessa leaves it alone and prints the entry for you to add.

Then:

1. Restart the host (or reload the VS Code window) and approve the `tessa-mcp` server when asked.
2. Run `/tessa-init`. It detects the stack, writes `.tessa/config.yaml`, and rewrites the host
   files with the models from the config.
3. Commit the generated files and `.tessa/config.yaml` so the team shares them.

## Option 2: Claude Code plugin

```text
/plugin marketplace add <owner>/<repo>
/plugin install tessa-qa@tessa
```

The plugin's commands are namespaced, for example `/tessa-qa:tessa-test-story`. It starts the
server with `npx`; on native Windows, if the server fails to start (`spawn npx ENOENT`), use the
project install instead, which writes a `cmd /c npx` entry.

## The browser

Tessa drives the app in the host's own browser and never signs in for you: it opens the login
page, you sign in, and the browser keeps the session.

- **VS Code** uses the integrated browser tools (`workbench.browser.enableChatTools`, on by
  default). Your organisation's policy may turn them off.
- **Claude Code** uses a Playwright MCP server named `playwright`. If the project has none, add
  one, pinned to a version you have reviewed. The executor's tool list leaves out Playwright's
  page-script and file-upload tools.

## Models

Each role's model is set in the `models` section of `.tessa/config.yaml`, or left `auto`:

| Role            | `auto` in Claude Code | `auto` in VS Code |
| --------------- | --------------------- | ----------------- |
| planner, triage | `opus`                | your picked model |
| executor        | `sonnet`              | your picked model |
| exporter        | `sonnet`              | your picked model |
| context builder | `sonnet`              | your picked model |
| orchestrator    | `inherit`             | your picked model |

A model you name is written as given, so it must be one your host accepts. After changing the
section, run `/tessa-init` again (or `npx tessa-qa install` again). Each run's report lists the
models it used.

## Both hosts in one repository

VS Code also reads `.claude/agents` and `.claude/skills`. If you install for both hosts, VS Code
shows both sets. Install for one host per repository unless your team uses both.

## Updating and removing

To update, run the install for the new version; files from the old version that are no longer
needed are removed. To remove Tessa, delete the files that start with the `tessa-generated`
comment and the `tessa-mcp` entry from the MCP config. Your config, plans and exported tests stay.

## What Tessa writes in your repository

| Path                                             | Commit?                                                |
| ------------------------------------------------ | ------------------------------------------------------ |
| `.tessa/config.yaml`, hints file                 | Yes                                                    |
| `ai-test-artifacts/context/`, `plans/`           | Yes                                                    |
| `ai-test-artifacts/export/`                      | After review                                           |
| `ai-test-artifacts/runs/`, `diffs/`, `.session/` | No: gitignored, may hold screenshots and session state |
