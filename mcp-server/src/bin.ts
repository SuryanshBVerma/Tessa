#!/usr/bin/env node
// Entry point for hosts: `tessa-mcp [--workspace <dir>]`, speaking MCP over stdio.
import { parseArgs } from 'node:util';
import { resolveWorkspace, serveStdio } from './serve.js';

const { values } = parseArgs({
  options: { workspace: { type: 'string', short: 'w' } },
  strict: true,
});

await serveStdio(resolveWorkspace(values.workspace, 'tessa-mcp'));
