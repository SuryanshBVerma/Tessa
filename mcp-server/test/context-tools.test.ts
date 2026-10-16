import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { pathMatches, terms } from '../src/context/query.js';
import { call, connect, initialisedSample } from './helpers.js';

async function ready() {
  const workspace = initialisedSample();
  const client = await connect(workspace);
  const built = await call(client, 'build_static_map');
  expect(built.isError, JSON.stringify(built.data)).toBe(false);
  return { workspace, client };
}

describe('query helpers', () => {
  it('extracts terms, dropping stop words and plurals', () => {
    expect(terms('Editors can close the tickets')).toEqual(['editor', 'close', 'ticket']);
  });

  it.each([
    ['/tickets/:ticketId', '/tickets/4', true],
    ['/tickets/:ticketId', '/tickets/*', true],
    ['/tickets/:ticketId', '/tickets', false],
    ['/tickets', '/tickets?status=open', true],
    ['/admin/users', '/admin/users/', true],
  ])('pathMatches(%s, %s) = %s', (route, target, expected) => {
    expect(pathMatches(route, target)).toBe(expected);
  });
});

describe('context query tools (builtin)', () => {
  it('needs a map first', async () => {
    const client = await connect(initialisedSample());
    const { isError, data } = await call(client, 'routes_for_feature', { query: 'tickets' });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/build_static_map/);
  });

  it('ranks routes for a feature', async () => {
    const { client } = await ready();
    const { data } = await call(client, 'routes_for_feature', {
      query: 'Admins change user roles',
    });
    expect(data.source).toBe('builtin');
    expect(data.routes[0].path).toBe('/admin/users');
  });

  it('resolves a concrete URL to its route and lists its modules', async () => {
    const { client } = await ready();
    const { data } = await call(client, 'components_for_route', { route: '/tickets/42' });
    expect(data.route).toMatchObject({ path: '/tickets/:ticketId', file: 'app/routes/ticket.tsx' });
    expect(data.layouts).toEqual(['app/routes/app-layout.tsx']);
    expect(data.modules.map((m: any) => m.file)).toContain('app/lib/permissions.ts');
  });

  it('separates enforced and visibility guards', async () => {
    const { client } = await ready();
    const { data } = await call(client, 'permissions_for_route', { route: '/tickets/new' });
    expect(data.requires_sign_in).toBe(true);
    expect(
      data.enforced.map(
        (g: any) => `${String(g.call)}(${String(g.args.join(','))})@${String(g.in)}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'requirePermission(tickets:create)@loader',
        'requirePermission(tickets:create)@action',
      ]),
    );
    expect(data.visibility.some((g: any) => g.args.includes('users:manage'))).toBe(true);
  });

  it('lists data functions and API calls', async () => {
    const { client } = await ready();
    const { data } = await call(client, 'api_calls_for_component', { route: '/tickets/:ticketId' });
    expect(data.modules[0]).toMatchObject({
      file: 'app/routes/ticket.tsx',
      data_functions: ['action', 'loader'],
    });
  });

  it('lists selectors most stable first, including patterns', async () => {
    const { client } = await ready();
    const { data } = await call(client, 'selectors_for_component', { route: '/admin/users' });
    expect(data.selectors[0].kind).toBe('testid');
    expect(data.selectors.find((s: any) => s.value === 'role-select-*')).toMatchObject({
      pattern: true,
      element: 'select',
    });
    const byFile = await call(client, 'selectors_for_component', { file: 'app/routes/login.tsx' });
    expect(byFile.data.selectors.map((s: any) => s.value)).toEqual(
      expect.arrayContaining(['login-username', 'Password']),
    );
  });

  it('says when nothing matches', async () => {
    const { client } = await ready();
    const { isError, data } = await call(client, 'components_for_route', {
      route: '/does/not/exist',
    });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/nothing in the frontend map/);
  });
});

describe('story_context', () => {
  it('returns the routes a story is about, with neighbours and their selectors', async () => {
    const { client } = await ready();
    const story = readFileSync(
      join(import.meta.dirname, '..', '..', 'testing', 'sample-app', 'stories', 'close-ticket.md'),
      'utf8',
    );
    const { data } = await call(client, 'story_context', { text: story, hops: 1 });
    const paths = data.routes.map((r: any) => r.path);
    expect(paths[0]).toBe('/tickets/:ticketId');
    expect(paths).toContain('/tickets');
    const detail = data.routes[0];
    expect(detail.selectors.map((s: any) => s.value)).toEqual(
      expect.arrayContaining(['ticket-status', 'ticket-toggle-status', 'Close ticket']),
    );
    expect(detail.guards).toEqual(
      expect.arrayContaining(['requirePermission(tickets:close) in action']),
    );
    expect(detail.flags).toEqual(['ticket_priority']);
    expect(data.freshness.stale).toBe(false);
  });
});

describe('context_freshness', () => {
  it('reports changed files after an edit', async () => {
    const { workspace, client } = await ready();
    expect((await call(client, 'context_freshness')).data.stale).toBe(false);
    const file = join(workspace, 'app', 'routes', 'tickets.tsx');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// changed\n`);
    const { data } = await call(client, 'context_freshness');
    expect(data).toMatchObject({ stale: true, changed_files: ['app/routes/tickets.tsx'] });
    expect(data.message).toMatch(/build_static_map/);
  });
});

describe('knowledge-graph modes', () => {
  const MAPPING = {
    version: 1,
    server: 'frontend-kg',
    queries: {
      routes_for_feature: { tool: 'search_routes', args: { q: 'feature: {query}' } },
      selectors_for_component: {
        tool: 'get_selectors',
        args: { route: '{route}', file: '{file}' },
      },
    },
    freshness: { tool: 'index_status', commit_field: 'head_sha' },
  };

  async function withMode(kgMode: 'external' | 'hybrid', mapping: object = MAPPING) {
    const workspace = initialisedSample();
    const configFile = join(workspace, '.tessa', 'config.yaml');
    const config = parse(readFileSync(configFile, 'utf8'));
    config.context.knowledge_graph = {
      enabled: true,
      mode: kgMode,
      mcp_server: 'frontend-kg',
      query_mapping: '.tessa/kg-mapping.yaml',
      max_staleness_commits: 5,
    };
    writeFileSync(configFile, stringify(config));
    writeFileSync(join(workspace, '.tessa', 'kg-mapping.yaml'), stringify(mapping));
    const client = await connect(workspace);
    await call(client, 'build_static_map');
    return client;
  }

  it('external: returns the call to make on the knowledge-graph server', async () => {
    const client = await withMode('external');
    const { data } = await call(client, 'routes_for_feature', { query: 'close a ticket' });
    expect(data).toMatchObject({
      source: 'external',
      delegate: {
        server: 'frontend-kg',
        tool: 'search_routes',
        arguments: { q: 'feature: close a ticket' },
      },
    });
    expect(data.routes).toBeUndefined();
  });

  it('external: falls back to the built-in map for unmapped queries', async () => {
    const client = await withMode('external');
    const { data } = await call(client, 'permissions_for_route', { route: '/admin/users' });
    expect(data.source).toBe('builtin');
    expect(data.note).toMatch(/not in the query mapping/);
  });

  it('hybrid: returns built-in results and the external call', async () => {
    const client = await withMode('hybrid');
    const { data } = await call(client, 'selectors_for_component', { route: '/admin/users' });
    expect(data.source).toBe('hybrid');
    expect(data.selectors.length).toBeGreaterThan(0);
    expect(data.delegate).toMatchObject({
      tool: 'get_selectors',
      arguments: { route: '/admin/users', file: '{file}' },
    });
  });

  it('freshness: asks for the indexed commit, then measures the lag', async () => {
    const client = await withMode('external');
    const first = await call(client, 'context_freshness');
    expect(first.data.delegate).toMatchObject({ tool: 'index_status' });
    expect(first.data.delegate.instruction).toMatch(/head_sha/);
    const unknown = await call(client, 'context_freshness', {
      external_indexed_commit: 'deadbeef',
    });
    expect(unknown.data).toMatchObject({ source: 'external', stale: true, commits_behind: null });
  });

  it('rejects an invalid mapping with a readable error', async () => {
    const client = await withMode('external', {
      version: 1,
      queries: { routes_for_feature: { tool: 'bad tool name!' } },
    });
    const { isError, data } = await call(client, 'routes_for_feature', { query: 'x' });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/query mapping is invalid/);
  });
});

describe('record_crawl', () => {
  it('merges a persona crawl and reports where code and runtime disagree', async () => {
    const { client } = await ready();
    const { data } = await call(client, 'record_crawl', {
      persona: 'viewer',
      pages: [
        {
          path: '/tickets',
          links: ['/tickets/1', 'https://evil.example/x'],
          testids: ['tickets-table', 'ticket-row-1'],
          roles: [],
        },
        {
          path: 'http://127.0.0.1:5173/tickets/1',
          testids: ['ticket-detail', 'mystery-widget'],
          links: [],
          roles: [],
        },
        { path: '/old-page', testids: [], links: [], roles: [] },
        { path: 'https://evil.example/phish', testids: [], links: [], roles: [] },
      ],
    });
    expect(data.pages).toBe(3);
    expect(data.dropped_off_origin).toEqual(['https://evil.example/phish']);
    expect(data.unknown_pages).toEqual([{ persona: 'viewer', path: '/old-page' }]);
    expect(data.runtime_only_testids).toEqual([
      { persona: 'viewer', path: '/tickets/1', testid: 'mystery-widget' },
    ]);
    expect(data.reached.map((r: any) => r.path)).toEqual(['/tickets', '/tickets/:ticketId']);
    expect(data.unreached_routes.map((r: any) => r.path)).toContain('/admin/users');
  });

  it('refuses an unknown persona', async () => {
    const { client } = await ready();
    const { isError } = await call(client, 'record_crawl', {
      persona: 'root',
      pages: [{ path: '/' }],
    });
    expect(isError).toBe(true);
  });
});
