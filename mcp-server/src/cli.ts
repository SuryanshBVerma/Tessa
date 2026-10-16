#!/usr/bin/env node
// `tessa-qa`: the package's command line.
//   tessa-qa mcp [--workspace <dir>]       serve tessa-mcp over stdio (what hosts run)
//   tessa-qa install --host <host> [...]   write Tessa's agents, commands, skills and MCP entry
//   tessa-qa version
import { parseArgs } from 'node:util';
import { resolveModels, workspaceModels, type Host } from './hosts/models.js';
import { renderHost } from './hosts/render.js';
import { loadSources } from './hosts/sources.js';
import { writeHostFiles } from './hosts/write.js';
import { resolveWorkspace, serveStdio } from './serve.js';
import { SERVER_VERSION } from './version.js';

const USAGE = `tessa-qa ${SERVER_VERSION}

Usage:
  tessa-qa install --host <claude-code|vscode-agent> [--dry-run] [--overwrite] [--workspace <dir>]
  tessa-qa mcp [--workspace <dir>]
  tessa-qa version

install writes Tessa's agents, commands and skills for the host, and adds tessa-mcp to the
host's MCP config. It replaces only files it wrote before. Run it in the repository to test.`;

const HOSTS: readonly Host[] = ['claude-code', 'vscode-agent'];

function install(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string' },
      'dry-run': { type: 'boolean' },
      overwrite: { type: 'boolean' },
      workspace: { type: 'string', short: 'w' },
    },
    strict: true,
  });
  const host = values.host as Host | undefined;
  if (host === undefined || !HOSTS.includes(host)) {
    console.error(`--host must be one of: ${HOSTS.join(', ')}\n\n${USAGE}`);
    return 2;
  }
  const workspace = resolveWorkspace(values.workspace, 'tessa-qa');
  const { config, fromConfig } = workspaceModels(workspace);
  const outcomes = writeHostFiles(workspace, host, renderHost(host, loadSources(), config), {
    ...(values['dry-run'] === true ? { dryRun: true } : {}),
    ...(values.overwrite === true ? { overwrite: true } : {}),
  });

  const dry = values['dry-run'] === true;
  console.log(
    `${dry ? 'Would write' : 'Wrote'} Tessa ${SERVER_VERSION} files for ${host} in ${workspace}\n`,
  );
  for (const o of outcomes) {
    console.log(
      `  ${o.status.padEnd(9)} ${o.path}${o.reason === undefined ? '' : `\n            ${o.reason}`}`,
    );
    if (o.snippet !== undefined) console.log(o.snippet.replace(/^/gm, '            '));
  }
  console.log(`\nModels${fromConfig ? '' : ' (no .tessa/config.yaml yet, so auto)'}:`);
  for (const c of resolveModels(config, host)) console.log(`  ${c.role.padEnd(16)} ${c.label}`);
  console.log(
    host === 'claude-code'
      ? '\nNext: restart Claude Code and approve tessa-mcp, make sure a Playwright MCP server named "playwright" is configured, then run /tessa-init.'
      : '\nNext: reload VS Code and trust tessa-mcp, then run /tessa-init in agent mode.',
  );
  return outcomes.some((o) => o.status === 'conflict') ? 1 : 0;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'mcp': {
    const { values } = parseArgs({
      args: rest,
      options: { workspace: { type: 'string', short: 'w' } },
      strict: true,
    });
    await serveStdio(resolveWorkspace(values.workspace, 'tessa-qa'));
    break;
  }
  case 'install':
    process.exitCode = install(rest);
    break;
  case 'version':
  case '--version':
    console.log(SERVER_VERSION);
    break;
  case undefined:
  case 'help':
  case '--help':
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = 2;
}
