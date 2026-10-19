import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { resolveConfig } from '../src/config/index.js';
import type { TessaConfig } from '../src/schemas/generated/index.js';
import { modelsForRun, resolveModel, resolveModels } from '../src/hosts/models.js';
import { renderClaudeCode, renderVsCode } from '../src/hosts/render.js';
import { loadSources, toolRefs } from '../src/hosts/sources.js';
import { writeHostFiles } from '../src/hosts/write.js';
import { SCHEMAS_DIR } from '../src/schemas/index.js';
import { SERVER_VERSION } from '../src/version.js';
import { call, connect, tempWorkspace } from './helpers.js';

const BASE: TessaConfig = {
  version: 1,
  app: { start: 'npm run dev', url: 'http://127.0.0.1:5173', stack: 'react-router' },
  db: { allowed_hosts: ['127.0.0.1'], profiles: { default: ['seed.sql'] } },
  auth: { mode: 'manual', login_path: '/login' },
  personas: [
    { name: 'viewer', seed_profile: 'default' },
    { name: 'editor', seed_profile: 'default' },
  ],
};

describe('model resolution', () => {
  it('maps auto to Claude Code aliases by role', () => {
    const config = resolveConfig(BASE);
    expect(
      Object.fromEntries(resolveModels(config, 'claude-code').map((c) => [c.role, c.model])),
    ).toEqual({
      orchestrator: 'inherit',
      context_builder: 'sonnet',
      planner: 'opus',
      executor: 'sonnet',
      triage: 'opus',
      exporter: 'sonnet',
    });
  });

  it('leaves auto out for VS Code, so the picker model is inherited', () => {
    const choice = resolveModel(resolveConfig(BASE), 'planner', 'vscode-agent');
    expect(choice).toEqual({
      role: 'planner',
      model: null,
      source: 'auto',
      label: 'host default (auto: strongest)',
    });
  });

  it('uses configured models as written, with default filling the rest', () => {
    const config = resolveConfig({
      ...BASE,
      models: { default: 'claude-sonnet-5-5', planner: 'claude-opus-5-5' },
    });
    expect(resolveModel(config, 'planner', 'vscode-agent')).toMatchObject({
      model: 'claude-opus-5-5',
      source: 'config',
    });
    expect(resolveModel(config, 'triage', 'claude-code').model).toBe('claude-sonnet-5-5');
  });

  it('labels run models from config and overlays what agents reported', () => {
    const models = modelsForRun(resolveConfig(BASE), 'claude-code', {
      executor: 'claude-sonnet-5-5',
    });
    expect(models.planner).toBe('opus (auto: strongest)');
    expect(models.executor).toBe('claude-sonnet-5-5 (reported)');
    expect(modelsForRun(resolveConfig(BASE), 'other').planner).toBe('auto');
  });
});

describe('models in runs', () => {
  it('records models at begin_run and keeps them through capture_env_state', async () => {
    const workspace = tempWorkspace({
      '.tessa/config.yaml': stringify(BASE),
      'seed.sql': '',
      'ai-test-artifacts/plans/create-ticket/tests.json': readFileSync(
        new URL('examples/tests.example.json', SCHEMAS_DIR),
        'utf8',
      ),
    });
    const client = await connect(workspace);
    await call(client, 'approve_plan', { story: 'create-ticket' });
    const begun = await call(client, 'begin_run', {
      story: 'create-ticket',
      host: 'claude-code',
      models: { executor: 'claude-sonnet-5-5' },
    });
    expect(begun.isError, JSON.stringify(begun.data)).toBe(false);
    const runId = begun.data.run_id as string;
    await call(client, 'capture_env_state', { persona: 'editor', run_id: runId });
    await call(client, 'write_results', { run_id: runId });
    const results = JSON.parse(
      readFileSync(join(workspace, 'ai-test-artifacts', 'runs', runId, 'results.json'), 'utf8'),
    );
    expect(results.environment.models).toMatchObject({
      planner: 'opus (auto: strongest)',
      executor: 'claude-sonnet-5-5 (reported)',
    });
  });
});

const AUTO = resolveConfig(BASE);
const sources = loadSources();
const byPath = (files: { path: string; content: string }[]) =>
  Object.fromEntries(files.map((f) => [f.path, f.content]));

describe('host-neutral sources', () => {
  it('load every agent, command and skill, with only known tool names', () => {
    const names = sources.map((s) => `${s.kind}:${s.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'agent:tessa-orchestrator',
        'agent:tessa-context-builder',
        'agent:tessa-triage',
        'command:tessa-test-story',
        'command:tessa-diff',
        'skill:adapter-react-router',
        'skill:failure-triage',
      ]),
    );
    for (const source of sources) {
      expect(() => toolRefs(source)).not.toThrow();
    }
  });

  it('name only tessa-mcp tools that the server registers', async () => {
    const client = await connect(tempWorkspace());
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));
    const named = sources.flatMap((s) => toolRefs(s).mcp);
    expect(named.filter((t) => !registered.has(t))).toEqual([]);
  });

  it('name only agents that exist', () => {
    const agents = new Set(sources.filter((s) => s.kind === 'agent').map((s) => s.name));
    const named = sources.flatMap((s) => toolRefs(s).agents);
    expect(named.filter((a) => !agents.has(a))).toEqual([]);
  });
});

describe('Claude Code files', () => {
  const files = byPath(renderClaudeCode(sources, AUTO, { mode: 'project', platform: 'linux' }));

  it('writes subagents with translated tools, models and skills', () => {
    const executor = files['.claude/agents/tessa-executor.md'] ?? '';
    expect(executor).toMatch(/^---\nname: tessa-executor\n/);
    expect(executor).toContain('mcp__tessa-mcp__record_step');
    expect(executor).toContain('mcp__playwright__browser_navigate');
    expect(executor).not.toContain('browser_evaluate');
    expect(executor).toMatch(/\nmodel: sonnet\n/);
    // An agent that follows "the adapter skill" preloads every stack adapter.
    expect(executor).toMatch(
      /\nskills:\n {2}- adapter-angular\n {2}- adapter-react-router\n {2}- browser-execution\n/,
    );
    expect(files['.claude/agents/tessa-planner.md']).toMatch(/\nmodel: opus\n/);
    expect(files['.claude/agents/tessa-planner.md']).toContain('Read, Grep, Glob');
  });

  it('turns the delegating orchestrator into a skill the main conversation follows', () => {
    expect(files['.claude/agents/tessa-orchestrator.md']).toBeUndefined();
    expect(files['.claude/skills/tessa-orchestrator/SKILL.md']).toContain(
      'start that agent as a subagent',
    );
    expect(files['.claude/commands/tessa-test-story.md']).toContain(
      'Load the `tessa-orchestrator` skill',
    );
  });

  it('never pre-approves tools that write into the repo or wipe the database', () => {
    const allowed = (path: string) => /\nallowed-tools: (.*)\n/.exec(files[path] ?? '')?.[1] ?? '';
    expect(allowed('.claude/commands/tessa-export.md')).toContain(
      'mcp__tessa-mcp__propose_handoff',
    );
    expect(allowed('.claude/commands/tessa-export.md')).not.toContain('apply_handoff');
    expect(allowed('.claude/commands/tessa-init.md')).toContain('mcp__tessa-mcp__detect_stack');
    expect(allowed('.claude/commands/tessa-init.md')).not.toContain('init_workspace');
    expect(allowed('.claude/commands/tessa-export.md')).not.toContain('validate_export');
    expect(allowed('.claude/commands/tessa-test-story.md')).not.toContain('approve_plan');
    expect(allowed('.claude/commands/tessa-export.md')).not.toContain('record_selection');
    expect(files['.claude/commands/tessa-export.md']).toContain('$ARGUMENTS');
  });

  it('pins the package version in .mcp.json, with cmd /c on Windows', () => {
    const json = JSON.parse(files['.mcp.json'] ?? '{}');
    expect(json.mcpServers['tessa-mcp']).toEqual({
      command: 'npx',
      args: ['-y', `tessa-qa@${SERVER_VERSION}`, 'mcp'],
    });
    const windows = renderClaudeCode(sources, AUTO, { mode: 'project', platform: 'win32' });
    const server = JSON.parse(byPath(windows)['.mcp.json'] ?? '{}').mcpServers['tessa-mcp'];
    expect(server.command).toBe('cmd');
    expect(server.args.slice(0, 2)).toEqual(['/c', 'npx']);
  });

  it('names plugin tools by plugin and writes plugin-relative paths', () => {
    const plugin = byPath(renderClaudeCode(sources, AUTO, { mode: 'plugin', platform: 'linux' }));
    expect(plugin['agents/tessa-executor.md']).toContain(
      'mcp__plugin_tessa-qa_tessa-mcp__record_step',
    );
  });

  it('writes configured models as given', () => {
    const config = resolveConfig({ ...BASE, models: { executor: 'claude-sonnet-5-5' } });
    const custom = byPath(
      renderClaudeCode(sources, config, { mode: 'project', platform: 'linux' }),
    );
    expect(custom['.claude/agents/tessa-executor.md']).toMatch(/\nmodel: claude-sonnet-5-5\n/);
  });
});

describe('VS Code files', () => {
  const files = byPath(renderVsCode(sources, AUTO));

  it('writes custom agents, with subagents declared on the orchestrator', () => {
    const orchestrator = files['.github/agents/tessa-orchestrator.agent.md'] ?? '';
    expect(orchestrator).toMatch(/\n {2}- agent\n/);
    expect(orchestrator).toMatch(/\nagents:\n {2}- tessa-context-builder\n/);
    expect(orchestrator).toMatch(/\nuser-invocable: true\n/);
    const executor = files['.github/agents/tessa-executor.agent.md'] ?? '';
    expect(executor).toContain('  - tessa-mcp/record_step\n');
    expect(executor).toContain('  - browser\n');
    expect(executor).toMatch(/\nuser-invocable: false\n/);
    // auto leaves the model to the picker.
    expect(executor).not.toMatch(/\nmodel:/);
  });

  it('writes prompt files that run in the right agent', () => {
    expect(files['.github/prompts/tessa-test-story.prompt.md']).toMatch(
      /\nagent: tessa-orchestrator\n---/,
    );
    const run = files['.github/prompts/tessa-run.prompt.md'] ?? '';
    expect(run).toMatch(/\nagent: agent\ntools:\n/);
    expect(run).not.toContain('$ARGUMENTS');
    expect(run).toContain("the command's arguments");
  });

  it('adds the MCP server to .vscode/mcp.json', () => {
    const json = JSON.parse(files['.vscode/mcp.json'] ?? '{}');
    expect(json.servers['tessa-mcp']).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(json.servers['tessa-mcp'].args).toContain('${workspaceFolder}');
  });
});

describe('writeHostFiles', () => {
  const files = renderVsCode(sources, AUTO);

  it('creates, then leaves unchanged, then updates only its own files', () => {
    const workspace = tempWorkspace({
      '.vscode/mcp.json': JSON.stringify({ servers: { other: { type: 'stdio', command: 'x' } } }),
      '.github/prompts/tessa-run.prompt.md': 'mine',
    });
    const first = writeHostFiles(workspace, 'vscode-agent', files);
    const status = (path: string, outcomes = first) =>
      outcomes.find((o) => o.path === path)?.status;
    expect(status('.github/agents/tessa-executor.agent.md')).toBe('created');
    expect(status('.github/prompts/tessa-run.prompt.md')).toBe('conflict');
    expect(readFileSync(join(workspace, '.github/prompts/tessa-run.prompt.md'), 'utf8')).toBe(
      'mine',
    );
    expect(status('.vscode/mcp.json')).toBe('updated');
    const mcp = JSON.parse(readFileSync(join(workspace, '.vscode/mcp.json'), 'utf8'));
    expect(Object.keys(mcp.servers)).toEqual(['other', 'tessa-mcp']);

    const second = writeHostFiles(workspace, 'vscode-agent', files);
    expect(second.every((o) => o.status === 'unchanged' || o.status === 'conflict')).toBe(true);

    const forced = writeHostFiles(workspace, 'vscode-agent', files, { overwrite: true });
    expect(status('.github/prompts/tessa-run.prompt.md', forced)).toBe('updated');
  });

  it('removes generated files that are no longer produced, and nothing else', () => {
    const workspace = tempWorkspace({ '.github/agents/tessa-mine.agent.md': 'hand written' });
    writeHostFiles(workspace, 'vscode-agent', files);
    const fewer = files.filter((f) => !f.path.includes('failure-triage'));
    const outcomes = writeHostFiles(workspace, 'vscode-agent', fewer);
    expect(outcomes).toContainEqual({
      path: '.github/skills/failure-triage/SKILL.md',
      status: 'removed',
    });
    expect(existsSync(join(workspace, '.github/skills/failure-triage'))).toBe(false);
    expect(existsSync(join(workspace, '.github/agents/tessa-mine.agent.md'))).toBe(true);
  });

  it('leaves a JSON file with comments alone and hands back the entry', () => {
    const workspace = tempWorkspace({ '.vscode/mcp.json': '{ // mine\n "servers": {} }' });
    const outcome = writeHostFiles(workspace, 'vscode-agent', files).find(
      (o) => o.path === '.vscode/mcp.json',
    );
    expect(outcome?.status).toBe('conflict');
    expect(outcome?.snippet).toContain('tessa-qa@');
  });
});

describe('write_host_files', () => {
  it('previews without writing, then writes with auto models when there is no config', async () => {
    const workspace = tempWorkspace();
    const client = await connect(workspace);
    const preview = await call(client, 'write_host_files', { host: 'claude-code', dry_run: true });
    expect(preview.isError, JSON.stringify(preview.data)).toBe(false);
    expect(preview.data.config_used).toBe(false);
    expect(preview.data.files.length).toBeGreaterThan(10);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);

    const written = await call(client, 'write_host_files', { host: 'claude-code' });
    expect(written.data.ok).toBe(true);
    expect(written.data.models).toContainEqual({
      role: 'planner',
      model: 'opus (auto: strongest)',
    });
    expect(existsSync(join(workspace, '.claude', 'agents', 'tessa-executor.md'))).toBe(true);
  });
});
