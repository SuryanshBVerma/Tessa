import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveConfig } from '../src/config/index.js';
import { renderClaudeCode, renderVsCode } from '../src/hosts/render.js';
import { loadSources } from '../src/hosts/sources.js';
import type { TessaConfig } from '../src/schemas/generated/index.js';
import { call, connect, initialisedSample } from './helpers.js';

/** A mapping for a code graph like codebase-memory: a project name on every call. */
const MAPPING = {
  server: 'codebase-memory',
  notes: 'Every tool needs project: "my-app". Results are JSON with a "results" array.',
  queries: {
    routes_for_feature: {
      tool: 'search_graph',
      args: { project: 'my-app', query: '{query}', label: 'Route', limit: 20 },
      description: 'Each result has a "file" and a "name"; the name is the route path.',
    },
    components_for_route: {
      tool: 'trace_path',
      args: { project: 'my-app', start: '{route}', direction: 'outbound' },
    },
  },
  freshness: { tool: 'index_status', args: { project: 'my-app' }, commit_field: 'commit' },
  extra_tools: ['get_code_snippet'],
};

async function sample() {
  const workspace = initialisedSample();
  const client = await connect(workspace);
  return { workspace, client };
}

describe('save_kg_mapping', () => {
  it('previews the mapping and the config change without writing', async () => {
    const { workspace, client } = await sample();
    const { isError, data } = await call(client, 'save_kg_mapping', { ...MAPPING, dry_run: true });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data.files.map((f: { path: string }) => f.path)).toEqual([
      '.tessa/kg-mapping.yaml',
      '.tessa/config.yaml',
    ]);
    expect(data.files[0].preview).toContain('tool: search_graph');
    expect(data.files[0].preview).toContain('limit: 20');
    expect(existsSync(join(workspace, '.tessa', 'kg-mapping.yaml'))).toBe(false);
  });

  it('writes the mapping and turns the graph on, keeping the rest of the config', async () => {
    const { workspace, client } = await sample();
    const before = readFileSync(join(workspace, '.tessa', 'config.yaml'), 'utf8');
    const saved = await call(client, 'save_kg_mapping', MAPPING);
    expect(saved.isError, JSON.stringify(saved.data)).toBe(false);
    const config = parse(readFileSync(join(workspace, '.tessa', 'config.yaml'), 'utf8'));
    expect(config.context.knowledge_graph).toEqual({
      enabled: true,
      mode: 'hybrid',
      mcp_server: 'codebase-memory',
      query_mapping: '.tessa/kg-mapping.yaml',
    });
    expect(config.app).toEqual(parse(before).app);
    expect((await call(client, 'load_config')).data.ok).toBe(true);
  });

  it('refuses mappings it cannot use', async () => {
    const { client } = await sample();
    const bad = await call(client, 'save_kg_mapping', {
      server: 'codebase-memory',
      queries: { routes_for_feature: { tool: 'search graph; rm -rf' } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/mapping is invalid/);
    const empty = await call(client, 'save_kg_mapping', { server: 'codebase-memory' });
    expect(empty.data.error).toMatch(/map at least one query/);
    const badServer = await call(client, 'save_kg_mapping', {
      ...MAPPING,
      server: '../evil',
    });
    expect(badServer.isError).toBe(true);
  });
});

describe('kg_status and the context tools after connecting', () => {
  it('reports what the graph answers, the tools to grant, and a probe call', async () => {
    const { client } = await sample();
    const off = await call(client, 'kg_status');
    expect(off.data).toMatchObject({ enabled: false, mode: 'builtin', mapped: [] });

    await call(client, 'save_kg_mapping', MAPPING);
    const { data } = await call(client, 'kg_status');
    expect(data).toMatchObject({
      enabled: true,
      mode: 'hybrid',
      server: 'codebase-memory',
      mapped: ['routes_for_feature', 'components_for_route'],
      freshness_tool: 'index_status',
      granted_tools: ['get_code_snippet', 'index_status', 'search_graph', 'trace_path'],
      issues: [],
    });
    expect(data.probe).toMatchObject({ tool: 'index_status', arguments: { project: 'my-app' } });
  });

  it('hands the agent the call with its notes, and keeps non-string arguments', async () => {
    const { client } = await sample();
    await call(client, 'save_kg_mapping', MAPPING);
    await call(client, 'build_static_map');
    const { data } = await call(client, 'routes_for_feature', { query: 'close a ticket' });
    expect(data.source).toBe('hybrid');
    expect(data.delegate).toMatchObject({
      server: 'codebase-memory',
      tool: 'search_graph',
      arguments: { project: 'my-app', query: 'close a ticket', label: 'Route', limit: 20 },
      notes: MAPPING.notes,
    });
    expect(data.delegate.instruction).toMatch(/the name is the route path/);
  });
});

describe('host files with a connected graph', () => {
  const BASE: TessaConfig = {
    version: 1,
    app: { start: 'npm start', url: 'http://localhost:4200', stack: 'angular' },
    db: { enabled: false },
    auth: { mode: 'manual' },
    personas: [{ name: 'editor' }],
  };
  const setup = {
    models: resolveConfig(BASE).models,
    graph: { server: 'codebase.memory', tools: ['index_status', 'search_graph'] },
  };
  const sources = loadSources();
  const byPath = (files: { path: string; content: string }[]) =>
    Object.fromEntries(files.map((f) => [f.path, f.content]));

  it('grants the mapped tools only to agents and commands that use context queries', () => {
    const claude = byPath(renderClaudeCode(sources, setup, { mode: 'project', platform: 'linux' }));
    // Claude Code turns "." in a server name into "_".
    expect(claude['.claude/agents/tessa-planner.md']).toContain(
      'mcp__codebase_memory__search_graph',
    );
    expect(claude['.claude/agents/tessa-context-builder.md']).toContain(
      'mcp__codebase_memory__index_status',
    );
    expect(claude['.claude/agents/tessa-executor.md']).not.toContain('codebase_memory');

    const vscode = byPath(renderVsCode(sources, setup));
    expect(vscode['.github/agents/tessa-planner.agent.md']).toContain(
      '  - codebase.memory/search_graph\n',
    );
    expect(vscode['.github/agents/tessa-exporter.agent.md']).not.toContain('codebase.memory');
  });

  it('lets /tessa-connect-graph see every MCP server in VS Code', () => {
    const vscode = byPath(renderVsCode(sources, setup));
    const prompt = vscode['.github/prompts/tessa-connect-graph.prompt.md'] ?? '';
    expect(prompt).toMatch(/\nagent: agent\n---/);
    expect(prompt).not.toMatch(/\ntools:/);
  });

  it('write_host_files picks up the connected graph from the workspace', async () => {
    const { workspace, client } = await sample();
    await call(client, 'save_kg_mapping', MAPPING);
    const { data } = await call(client, 'write_host_files', { host: 'vscode-agent' });
    expect(data.knowledge_graph_tools).toEqual({
      server: 'codebase-memory',
      tools: ['get_code_snippet', 'index_status', 'search_graph', 'trace_path'],
    });
    const planner = readFileSync(
      join(workspace, '.github', 'agents', 'tessa-planner.agent.md'),
      'utf8',
    );
    expect(planner).toContain('  - codebase-memory/trace_path\n');
  });
});
