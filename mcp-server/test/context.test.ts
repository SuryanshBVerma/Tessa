import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { reactRouterAdapter } from '../src/context/adapters/react-router.js';
import { buildStaticMap, routeModules } from '../src/context/build.js';
import { extractModule } from '../src/context/extractors/jsx.js';
import { SAMPLE_APP, sampleWorkspace, tempWorkspace } from './helpers.js';

describe('extractModule', () => {
  const source = `
import { Form, Link, redirect } from 'react-router';
import { requirePermission } from '../lib/auth.server';
import { can } from '../lib/permissions';
export async function loader({ request }) {
  const user = await requirePermission(request, 'tickets:read');
  if (!user) throw redirect('/login');
  return { canClose: can(user.role, 'tickets:close'), x: flags.ticket_priority };
}
export async function action() { await fetch('/api/tickets', { method: 'POST' }); return api.post(\`/api/tickets/\${id}\`); }
export default function Page({ open, id }) {
  return (
    <main>
      <h1>Tickets</h1>
      <label>Title<input name="title" placeholder="Short summary" data-testid="ticket-title" /></label>
      <button type="submit" data-testid={\`toggle-\${id}\`} aria-label="Toggle">{open ? 'Close ticket' : 'Reopen ticket'}</button>
      <Link to="/tickets">Back</Link>
      <Link to={\`/tickets/\${id}\`}>Open</Link>
      <a href="https://example.com">External</a>
      <Form method="post" action="/logout"><button>Sign out</button></Form>
      <div role="alert">{useFlag('beta') ? 'on' : 'off'}</div>
    </main>
  );
}`;
  const info = extractModule('app/routes/page.tsx', source);
  const sel = (kind: string) => info.selectors.filter((s) => s.kind === kind).map((s) => s.value);

  it('finds route exports and imports', () => {
    expect(info.exports).toEqual(['action', 'default', 'loader']);
    expect(info.importSpecifiers).toEqual([
      'react-router',
      '../lib/auth.server',
      '../lib/permissions',
    ]);
  });

  it('finds selectors, including template patterns and both sides of a ternary', () => {
    expect(sel('testid')).toEqual(['ticket-title', 'toggle-*']);
    expect(info.selectors.find((s) => s.value === 'toggle-*')?.pattern).toBe(true);
    expect(sel('label')).toEqual(['Title']);
    expect(sel('placeholder')).toEqual(['Short summary']);
    expect(sel('aria-label')).toEqual(['Toggle']);
    expect(sel('role')).toEqual(['alert']);
    expect(sel('text')).toEqual(
      expect.arrayContaining(['Tickets', 'Close ticket', 'Reopen ticket', 'Back', 'Sign out']),
    );
  });

  it('finds guards with their arguments and where they run', () => {
    expect(info.guards.map((g) => `${g.call}(${g.args.join(',')})@${g.in}`)).toEqual([
      'requirePermission(tickets:read)@loader',
      'can(tickets:close)@loader',
    ]);
  });

  it('finds links, redirects, forms, API calls and flags; ignores external links', () => {
    expect(info.links.map((l) => `${l.kind}:${l.to}`)).toEqual(
      expect.arrayContaining([
        'redirect:/login',
        'link:/tickets',
        'link:/tickets/*',
        'form:/logout',
      ]),
    );
    expect(info.links.some((l) => l.to.includes('example.com'))).toBe(false);
    expect(info.api.map((a) => `${a.kind}:${a.method ?? ''}:${a.url}`)).toEqual(
      expect.arrayContaining([
        'fetch::/api/tickets',
        'http-client:POST:/api/tickets/*',
        'form:POST:/logout',
      ]),
    );
    expect(info.flags.map((f) => f.name).sort()).toEqual(['beta', 'ticket_priority']);
  });

  it('never executes code', () => {
    const hostile =
      'export default function X() { process.exit(1); return <div data-testid={require("child_process").execSync("calc")} /> }';
    expect(() => extractModule('x.tsx', hostile)).not.toThrow();
  });
});

describe('react-router adapter', () => {
  it('reads the sample app route tree with full paths and layouts', () => {
    const { routes, warnings } = reactRouterAdapter.findRoutes(SAMPLE_APP);
    expect(warnings).toEqual([]);
    const byPath = (path: string, kind = 'route') =>
      routes.find((r) => r.path === path && r.kind === kind);
    expect(routes).toHaveLength(9);
    expect(byPath('/tickets/:ticketId')).toMatchObject({
      file: 'app/routes/ticket.tsx',
      parent: 'app/routes/app-layout.tsx',
    });
    expect(byPath('/', 'index')).toMatchObject({
      file: 'app/routes/home.tsx',
      id: 'app/routes/home.tsx#index',
    });
    expect(byPath('/', 'layout')?.children).toHaveLength(6);
  });

  it('handles prefix() and nested routes, and warns about missing modules', () => {
    const workspace = tempWorkspace({
      'app/routes.ts': `import { route, prefix, layout } from '@react-router/dev/routes';
export default [
  ...prefix('admin', [route('users', 'routes/users.tsx', [route(':id', 'routes/user.tsx')])]),
  route('ghost', 'routes/missing.tsx'),
] satisfies RouteConfig;`,
      'app/routes/users.tsx': 'export default function U() { return null }',
      'app/routes/user.tsx': 'export default function U() { return null }',
    });
    const { routes, warnings } = reactRouterAdapter.findRoutes(workspace);
    expect(routes.map((r) => r.path)).toEqual(['/admin/users', '/admin/users/:id', '/ghost']);
    expect(warnings).toEqual(['app/routes.ts: route module app/routes/missing.tsx does not exist']);
  });
});

describe('buildStaticMap', () => {
  function ctxFor(workspace: string) {
    const loaded = loadConfig({ workspace });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    return { config: loaded.config, workspace };
  }

  /** A copy of the sample app with its real Tessa config. */
  function initialised() {
    const workspace = sampleWorkspace();
    mkdirSync(join(workspace, '.tessa'), { recursive: true });
    copyFileSync(
      join(SAMPLE_APP, '.tessa', 'config.yaml'),
      join(workspace, '.tessa', 'config.yaml'),
    );
    return ctxFor(workspace);
  }

  it('maps the sample app and reuses unchanged files on the next build', async () => {
    const ctx = initialised();
    const first = await buildStaticMap(ctx);
    expect(first).toMatchObject({ routes: 9, reused: 0, warnings: [] });
    expect(first.reparsed).toBeGreaterThan(9);

    const second = await buildStaticMap(ctx);
    expect(second.reparsed).toBe(0);

    const file = join(ctx.workspace, 'app', 'routes', 'settings.tsx');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// touched\n`);
    const third = await buildStaticMap(ctx);
    expect(third.reparsed).toBe(1);

    expect((await buildStaticMap(ctx, { force: true })).reused).toBe(0);
    const md = readFileSync(
      join(ctx.workspace, 'ai-test-artifacts', 'context', 'frontend-map.md'),
      'utf8',
    );
    expect(md).toContain(
      '| `/admin/users` | route | `app/routes/admin-users.tsx` | users:manage | 5 |',
    );
  });

  it('follows local imports and skips excluded files', async () => {
    const ctx = initialised();
    await buildStaticMap(ctx);
    const map = JSON.parse(
      readFileSync(
        join(ctx.workspace, 'ai-test-artifacts', 'context', 'frontend-map.json'),
        'utf8',
      ),
    );
    expect(Object.keys(map.modules)).toContain('app/lib/permissions.ts');
    const ticket = map.routes.find((r: any) => r.path === '/tickets/:ticketId');
    const modules = routeModules(map, ticket);
    expect(modules[0]).toBe('app/routes/app-layout.tsx');
    expect(modules).toContain('app/routes/ticket.tsx');
  });
});
