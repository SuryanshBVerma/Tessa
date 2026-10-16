# tessa-mcp

The MCP server behind Tessa. It owns every deterministic or side-effecting operation; Tessa's
agents and skills call these tools instead of running shell commands or editing files.

## Tools

| Tool              | Read-only | What it does                                                                                                                                                        |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect_stack`    | yes       | Suggests the stack adapter, export targets, package manager and start command                                                                                       |
| `load_config`     | yes       | Reads `.tessa/config.yaml`, validates it, and returns it with defaults filled in                                                                                    |
| `validate_config` | yes       | Lists config errors and warnings with JSON Pointer paths                                                                                                            |
| `init_workspace`  | no        | Creates `.tessa/config.yaml`, the hints file and a managed `.gitignore` block. Supports `dry_run`; replaces a config only with `overwrite` and never replaces hints |

Later phases add app lifecycle, database seeding, auth, results, review, runs and export tools
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
