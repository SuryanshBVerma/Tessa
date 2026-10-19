# Installing Tessa

Tessa runs inside your agent host, Claude Code or VS Code with GitHub Copilot in agent mode, as a
set of agents, commands and skills plus one MCP server, `tessa-mcp`. Installing writes those
files into the repository you want to test and registers the server with your host.

## Requirements

| You need                                        | Notes                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Node 24 or later                                | Runs `tessa-mcp`                                                                               |
| Claude Code, or VS Code with Copilot agent mode | Custom agents, prompt files and skills must be available in VS Code                            |
| A browser the agent can drive                   | Claude Code: a Playwright MCP server named `playwright`. VS Code: the integrated browser tools |
| Your app, runnable locally                      | One start command, on a `localhost` or `127.0.0.1` URL                                         |
| A local Postgres database                       | With `.sql` seed scripts. Tessa refuses any database host that is not local                    |
| A supported stack                               | React Router (framework mode) or Angular 14+; other stacks run without the code map            |

## Choose how to install

| Way                                                    | Hosts                | Models from your config | Notes                                         |
| ------------------------------------------------------ | -------------------- | ----------------------- | --------------------------------------------- |
| [Project install](#project-install)                    | Claude Code, VS Code | Yes                     | Recommended; files are committed for the team |
| [From a local build](#before-the-package-is-published) | Claude Code, VS Code | Yes                     | Until `tessa-qa` is published to npm          |
| [Claude Code plugin](#claude-code-plugin)              | Claude Code          | No (`auto` only)        | Quickest; commands are namespaced             |

## Project install

In the root of the repository you want to test, preview first:

```bash
npx tessa-qa@0.9.1 install --host claude-code --dry-run
```

Then run it without `--dry-run`. For VS Code, use `--host vscode-agent`.

| Host        | Files written                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/agents/tessa-*.md`, `.claude/commands/tessa-*.md`, `.claude/skills/*/SKILL.md`, and an entry in `.mcp.json`                    |
| VS Code     | `.github/agents/tessa-*.agent.md`, `.github/prompts/tessa-*.prompt.md`, `.github/skills/*/SKILL.md`, and an entry in `.vscode/mcp.json` |

How the installer treats your files:

- Every file it writes starts with a `tessa-generated` comment. It replaces or removes only those
  files. Any other file at the same path is reported as a `conflict` and left alone; rerun with
  `--overwrite` only if you want it replaced.
- In the MCP config it adds or updates only its own `tessa-mcp` entry, pinned to the installed
  version. If `.vscode/mcp.json` contains comments, it leaves the file alone and prints the entry
  for you to add.
- `--workspace <dir>` installs into another folder than the current one.

Then:

1. Restart the host (or reload the VS Code window) and approve the `tessa-mcp` server when asked.
2. Run `/tessa-init`. It detects the stack, writes `.tessa/config.yaml`, and rewrites the host
   files with the models from the config.
3. Commit the generated files and `.tessa/config.yaml` so the team shares them.

## Before the package is published

`tessa-qa` is not on npm yet, so `npx tessa-qa@0.9.1` cannot download it. Until it is, build Tessa
from this repository and point your project at the build.

1. Build Tessa:

   ```bash
   git clone https://github.com/SuryanshBVerma/Tessa.git
   cd Tessa
   npm install
   npm run build -w mcp-server
   ```

2. In the repository you want to test, run the installer from the build (use the full path to
   your clone):

   ```bash
   node /path/to/Tessa/mcp-server/dist/cli.js install --host claude-code
   ```

3. The installer writes an MCP entry that runs `npx tessa-qa@0.9.1`. Replace it with one that runs
   your build.

   Claude Code, in `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "tessa-mcp": {
         "command": "node",
         "args": ["/path/to/Tessa/mcp-server/dist/cli.js", "mcp"]
       }
     }
   }
   ```

   VS Code, in `.vscode/mcp.json`:

   ```json
   {
     "servers": {
       "tessa-mcp": {
         "type": "stdio",
         "command": "node",
         "args": [
           "/path/to/Tessa/mcp-server/dist/cli.js",
           "mcp",
           "--workspace",
           "${workspaceFolder}"
         ]
       }
     }
   }
   ```

   On Windows, write the path with forward slashes, for example `D:/Projects/Tessa/...`.

4. Continue with the steps after the project install: restart, approve, `/tessa-init`. Running
   the installer or `/tessa-init` again puts the `npx` entry back, so repeat step 3 after each.

Do not commit an MCP entry that points at your own machine's path.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. In Claude Code:

```text
/plugin marketplace add SuryanshBVerma/Tessa
/plugin install tessa-qa@tessa
```

- The plugin's commands are namespaced, for example `/tessa-qa:tessa-test-story`.
- It uses `auto` models. For models from `.tessa/config.yaml`, use the project install.
- It starts the server with `npx tessa-qa@0.9.1`, so it needs the package on npm.
- On native Windows, if the server fails with `spawn npx ENOENT`, use the project install, which
  writes a `cmd /c npx` entry.

## The browser

Tessa drives your app in the host's own browser and never signs in for you: it opens the login
page, you sign in, and the browser keeps the session.

- **VS Code** uses the integrated browser tools (`workbench.browser.enableChatTools`, on by
  default). Your organisation's policy may turn them off.
- **Claude Code** uses a Playwright MCP server named `playwright`. If the project has none, add
  one, pinned to a version you have reviewed. Tessa's executor may use only its navigation,
  reading, clicking, typing and screenshot tools; page-script evaluation and file upload are
  left out.

## Check the install

1. In Claude Code, `/mcp` should list `tessa-mcp` as connected. In VS Code, the MCP servers view
   should show it running.
2. Type `/tessa` in the chat: the seven commands should be listed (`/tessa-qa:tessa-...` with
   the plugin).
3. Run `/tessa-init`. If it can call `detect_stack`, the server is working.

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
section, run `/tessa-init` again (or the installer again). Each run's report lists the models it
used.

## Both hosts in one repository

VS Code also reads `.claude/agents` and `.claude/skills`. If you install for both hosts, VS Code
shows both sets. Install for one host per repository unless your team uses both.

## Updating and removing

- **Update:** run the installer for the new version. Generated files the new version no longer
  needs are removed.
- **Remove:** delete the files that start with the `tessa-generated` comment, and the `tessa-mcp`
  entry from the MCP config. Your config, plans and exported tests stay.

Next: [USAGE.md](USAGE.md) walks through a first run.
