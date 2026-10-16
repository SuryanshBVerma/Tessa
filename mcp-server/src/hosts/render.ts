import { stringify } from 'yaml';
import type { ResolvedConfig } from '../config/index.js';
import { SERVER_VERSION } from '../version.js';
import { resolveModel, ROLES, type Host, type Role } from './models.js';
import { toolRefs, type Source } from './sources.js';

/** Marks a file as Tessa's, so regenerating may replace or remove it and nothing else. */
export const MARKER = 'tessa-generated';

export interface RenderOptions {
  /** Claude Code only: plugin output names MCP tools by plugin, and has no project MCP config. */
  mode: 'project' | 'plugin';
  platform: NodeJS.Platform;
}

export interface RenderedFile {
  path: string;
  content: string;
  /** json files are merged into an existing file by key; markdown files are owned whole. */
  kind: 'markdown' | 'json';
  /** For json: the key path whose value Tessa owns, e.g. ["mcpServers", "tessa-mcp"]. */
  key?: string[];
}

export const PACKAGE = 'tessa-qa';
export const PLUGIN_NAME = 'tessa-qa';
const SERVER = 'tessa-mcp';

/** Tool names of the Playwright MCP server, which gives Claude Code its browser. Page script evaluation and file upload are left out. */
const PLAYWRIGHT_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_hover',
  'browser_press_key',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_resize',
  'browser_console_messages',
  'browser_network_requests',
  'browser_close',
];

/**
 * Tools a command must never pre-approve in Claude Code, so the host still asks before each
 * call: they write into the repository, wipe the database, run generated code, start a browser
 * outside the host, or record a decision that belongs to the user.
 */
export const NEVER_PREAPPROVED = new Set([
  'apply_handoff',
  'init_workspace',
  'reset_db',
  'validate_export',
  'capture_session',
  'approve_plan',
  'record_selection',
  'write_host_files',
]);

function roleOf(agent: Source): Role | null {
  const role = agent.name.replace(/^tessa-/, '').replaceAll('-', '_');
  return (ROLES as readonly string[]).includes(role) ? (role as Role) : null;
}

function marker(source: Source): string {
  return `<!-- ${MARKER}: written by ${PACKAGE} ${SERVER_VERSION} from ${source.origin}. Edits are overwritten; change .tessa/config.yaml or the source instead. -->`;
}

function markdown(frontmatter: Record<string, unknown>, source: Source, body: string): string {
  const yaml = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${marker(source)}\n\n${body.trimEnd()}\n`;
}

/** Replaces argument placeholders for hosts that pass a command's text differently. */
function argumentsFor(host: Host, body: string): string {
  return host === 'claude-code' ? body : body.replaceAll('`$ARGUMENTS`', "the command's arguments");
}

function npxCommand(
  platform: NodeJS.Platform,
  args: string[],
): { command: string; args: string[] } {
  // Claude Code on native Windows needs cmd /c to start npx.
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', ...args] }
    : { command: 'npx', args };
}

// ---------------------------------------------------------------------------------------------
// Claude Code

function claudeTools(source: Source, options: RenderOptions, forCommand: boolean): string[] {
  const refs = toolRefs(source);
  const server = options.mode === 'plugin' ? `plugin_${PLUGIN_NAME}_${SERVER}` : SERVER;
  const tools = refs.mcp
    .filter((tool) => !(forCommand && NEVER_PREAPPROVED.has(tool)))
    .map((tool) => `mcp__${server}__${tool}`);
  for (const builtin of refs.builtin) {
    if (builtin === 'read') tools.push('Read');
    if (builtin === 'search') tools.push('Grep', 'Glob');
    if (builtin === 'browser') tools.push(...PLAYWRIGHT_TOOLS.map((t) => `mcp__playwright__${t}`));
  }
  if (refs.agents.length > 0) tools.push('Agent');
  return [...new Set(tools)];
}

/**
 * Claude Code subagents cannot start subagents, so an agent that delegates (the orchestrator)
 * becomes a skill the main conversation follows.
 */
function delegates(source: Source): boolean {
  return toolRefs(source).agents.length > 0;
}

/** Skills an agent's instructions name in backticks, so a Claude Code subagent preloads them. */
export function referencedSkills(source: Source, sources: readonly Source[]): string[] {
  return sources
    .filter((s) => s.kind === 'skill' && source.body.includes(`\`${s.name}\``))
    .map((s) => s.name);
}

export function renderClaudeCode(
  sources: readonly Source[],
  config: Pick<ResolvedConfig, 'models'>,
  options: RenderOptions,
): RenderedFile[] {
  const base = options.mode === 'plugin' ? '' : '.claude/';
  const files: RenderedFile[] = [];
  for (const source of sources) {
    if (source.kind === 'agent' && delegates(source)) {
      files.push({
        path: `${base}skills/${source.name}/SKILL.md`,
        kind: 'markdown',
        content: markdown(
          { name: source.name, description: source.frontmatter.description },
          source,
          `You are running this flow in the main conversation. Where it says to hand work to an agent, start that agent as a subagent.\n\n${source.body}`,
        ),
      });
    } else if (source.kind === 'agent') {
      const role = roleOf(source);
      const model = role === null ? null : resolveModel(config, role, 'claude-code').model;
      const skills = referencedSkills(source, sources);
      files.push({
        path: `${base}agents/${source.name}.md`,
        kind: 'markdown',
        content: markdown(
          {
            name: source.name,
            description: source.frontmatter.description,
            tools: claudeTools(source, options, false).join(', '),
            ...(model === null ? {} : { model }),
            ...(skills.length > 0 ? { skills } : {}),
          },
          source,
          source.body,
        ),
      });
    } else if (source.kind === 'command') {
      const agent = source.frontmatter.agent;
      const lead =
        typeof agent === 'string'
          ? `Load the \`${agent}\` skill and follow it for this command.\n\n`
          : '';
      files.push({
        path: `${base}commands/${source.name}.md`,
        kind: 'markdown',
        content: markdown(
          {
            description: source.frontmatter.description,
            ...(typeof source.frontmatter['argument-hint'] === 'string'
              ? { 'argument-hint': source.frontmatter['argument-hint'] }
              : {}),
            'allowed-tools': claudeTools(source, options, true).join(', '),
          },
          source,
          lead + argumentsFor('claude-code', source.body),
        ),
      });
    } else {
      files.push({
        path: `${base}skills/${source.name}/SKILL.md`,
        kind: 'markdown',
        content: markdown(
          { name: source.name, description: source.frontmatter.description },
          source,
          source.body,
        ),
      });
    }
  }
  const server = npxCommand(options.platform, ['-y', `${PACKAGE}@${SERVER_VERSION}`, 'mcp']);
  files.push({
    path: '.mcp.json',
    kind: 'json',
    key: ['mcpServers', SERVER],
    content: JSON.stringify({ mcpServers: { [SERVER]: server } }, null, 2),
  });
  return files;
}

// ---------------------------------------------------------------------------------------------
// VS Code agent mode

function vscodeTools(source: Source): string[] {
  const refs = toolRefs(source);
  return [
    ...refs.mcp.map((tool) => `${SERVER}/${tool}`),
    ...refs.builtin,
    ...(refs.agents.length > 0 ? ['agent'] : []),
  ];
}

export function renderVsCode(
  sources: readonly Source[],
  config: Pick<ResolvedConfig, 'models'>,
): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const source of sources) {
    if (source.kind === 'agent') {
      const refs = toolRefs(source);
      const role = roleOf(source);
      const model = role === null ? null : resolveModel(config, role, 'vscode-agent').model;
      files.push({
        path: `.github/agents/${source.name}.agent.md`,
        kind: 'markdown',
        content: markdown(
          {
            name: source.name,
            description: source.frontmatter.description,
            tools: vscodeTools(source),
            ...(refs.agents.length > 0 ? { agents: refs.agents } : {}),
            ...(model === null ? {} : { model }),
            // Only an agent that delegates is picked by the user; the rest run as its subagents.
            'user-invocable': refs.agents.length > 0,
          },
          source,
          source.body,
        ),
      });
    } else if (source.kind === 'command') {
      const agent = source.frontmatter.agent;
      files.push({
        path: `.github/prompts/${source.name}.prompt.md`,
        kind: 'markdown',
        content: markdown(
          {
            description: source.frontmatter.description,
            ...(typeof source.frontmatter['argument-hint'] === 'string'
              ? { 'argument-hint': source.frontmatter['argument-hint'] }
              : {}),
            // A prompt that runs in a custom agent uses that agent's tools.
            ...(typeof agent === 'string'
              ? { agent }
              : { agent: 'agent', tools: vscodeTools(source) }),
          },
          source,
          argumentsFor('vscode-agent', source.body),
        ),
      });
    } else {
      files.push({
        path: `.github/skills/${source.name}/SKILL.md`,
        kind: 'markdown',
        content: markdown(
          { name: source.name, description: source.frontmatter.description },
          source,
          source.body,
        ),
      });
    }
  }
  files.push({
    path: '.vscode/mcp.json',
    kind: 'json',
    key: ['servers', SERVER],
    content: JSON.stringify(
      {
        servers: {
          [SERVER]: {
            type: 'stdio',
            command: 'npx',
            args: [
              '-y',
              `${PACKAGE}@${SERVER_VERSION}`,
              'mcp',
              '--workspace',
              '${workspaceFolder}',
            ],
          },
        },
      },
      null,
      2,
    ),
  });
  return files;
}

export function renderHost(
  host: Host,
  sources: readonly Source[],
  config: Pick<ResolvedConfig, 'models'>,
  platform: NodeJS.Platform = process.platform,
): RenderedFile[] {
  return host === 'claude-code'
    ? renderClaudeCode(sources, config, { mode: 'project', platform })
    : renderVsCode(sources, config);
}
