#!/usr/bin/env node
// Entry point for hosts: `tessa-mcp [--workspace <dir>]`, speaking MCP over stdio.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const { values } = parseArgs({
  options: { workspace: { type: 'string', short: 'w' } },
  strict: true,
});

// Hosts start MCP servers in the project folder; --workspace or TESSA_WORKSPACE override that.
const workspace = resolve(values.workspace ?? process.env.TESSA_WORKSPACE ?? process.cwd());
if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  console.error(`tessa-mcp: workspace "${workspace}" is not a directory`);
  process.exit(2);
}

const server = createServer({ workspace });
await server.connect(new StdioServerTransport());
// stdout carries the protocol; diagnostics go to stderr only.
console.error(`tessa-mcp ready (workspace: ${workspace})`);
