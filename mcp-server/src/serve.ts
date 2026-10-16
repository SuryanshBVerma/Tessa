import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

/**
 * The workspace a command acts on: --workspace, then TESSA_WORKSPACE, then the working
 * directory (hosts start MCP servers in the project folder). Exits when it is not a directory.
 */
export function resolveWorkspace(flag: string | undefined, label: string): string {
  const workspace = resolve(flag ?? process.env.TESSA_WORKSPACE ?? process.cwd());
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    console.error(`${label}: workspace "${workspace}" is not a directory`);
    process.exit(2);
  }
  return workspace;
}

/** Serves tessa-mcp over stdio. stdout carries the protocol; diagnostics go to stderr only. */
export async function serveStdio(workspace: string): Promise<void> {
  const server = createServer({ workspace });
  await server.connect(new StdioServerTransport());
  console.error(`tessa-mcp ready (workspace: ${workspace})`);
}
