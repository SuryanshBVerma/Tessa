# tessa-mcp

The MCP server behind Tessa. It owns every deterministic or side-effecting operation; Tessa's
agents and skills call these tools instead of running shell commands or editing files.

## Tools

| Tool                | Read-only        | What it does                                                                                                                                                                        |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect_stack`      | yes              | Suggests the stack adapter, export targets, package manager and start command                                                                                                       |
| `load_config`       | yes              | Reads `.tessa/config.yaml`, validates it, and returns it with defaults filled in                                                                                                    |
| `validate_config`   | yes              | Lists config errors and warnings with JSON Pointer paths                                                                                                                            |
| `init_workspace`    | no               | Creates `.tessa/config.yaml`, the hints file and a managed `.gitignore` block. Supports `dry_run`; replaces a config only with `overwrite` and never replaces hints                 |
| `start_app`         | no               | Starts the app with `app.start` (no shell operators allowed) and waits for `app.health_path`. Leaves an app that is already up alone                                                |
| `stop_app`          | no               | Stops the app only if Tessa started it                                                                                                                                              |
| `health_check`      | yes              | One request to `app.url` + `app.health_path`; any status below 500 counts as healthy                                                                                                |
| `seed_db`           | no (destructive) | Applies a seed profile's listed `.sql` files in one transaction. Refuses any host that is not local and in `db.allowed_hosts`; reads the URL from `db.url_env` and never returns it |
| `reset_db`          | no (destructive) | Re-applies the given profile, else the last one seeded, else `default`                                                                                                              |
| `capture_env_state` | yes              | Persona, seed profile, app URL and Git commit/branch/dirty state, merged with what the executor observed in the app                                                                 |
| `save_plan`         | no               | Validates a test IR plan against the schema and config and writes `tests.json` and a readable `plan.md`; returns coverage warnings                                                  |
| `approve_plan`      | no               | Records the user's approval with the plan's SHA-256; any later edit makes it stale                                                                                                  |
| `plan_status`       | yes              | Whether a story's plan is approved, unapproved or stale                                                                                                                             |
| `begin_run`         | no               | Creates `runs/<run_id>/` for an approved, unchanged plan and returns its tests with indexed steps                                                                                   |
| `record_step`       | no               | Records one step's outcome and copies in its screenshot (PNG, JPEG or WebP only, checked by content)                                                                                |
| `write_results`     | no               | Builds `results.json`; status, failures, attempts and quality signals are computed from the recorded steps                                                                          |
| `render_report`     | no               | Renders `report.html` from a fixed template; cards are built with DOM APIs from embedded JSON, under a nonce-based CSP                                                              |
| `serve_review`      | no               | Serves the report on `127.0.0.1` at a random port behind a per-session path token; checks Host and Origin, stops after the idle timeout                                             |
| `get_selection`     | yes              | Returns the reviewer's `selection.json`, optionally waiting up to 50 s per call for Export                                                                                          |
| `record_selection`  | no               | Saves a selection pasted from a report opened from disk (static fallback)                                                                                                           |
| `stop_review`       | no               | Stops the review server                                                                                                                                                             |

Later phases add context, run diff and export tools
(see [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)).

## Run it

```bash
npm run build -w mcp-server
node mcp-server/dist/bin.js --workspace path/to/your/repo
```

The server speaks MCP over stdio. The workspace is the repository under test, taken from
`--workspace`, then `TESSA_WORKSPACE`, then the directory the host starts the server in. No tool
reads or writes outside it.

### Claude Code

`.mcp.json` in the repository under test:

```json
{
  "mcpServers": {
    "tessa-mcp": {
      "command": "node",
      "args": ["/path/to/Tessa/mcp-server/dist/bin.js"]
    }
  }
}
```

### VS Code agent mode

`.vscode/mcp.json` in the repository under test:

```json
{
  "servers": {
    "tessa-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Tessa/mcp-server/dist/bin.js", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

## Development

```bash
npm run schemas:types -w mcp-server   # regenerate src/schemas/generated/ after editing schemas/
npm test                              # unit and MCP integration tests
```
