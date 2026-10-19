import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { angularAdapter } from '../src/context/adapters/angular.js';
import { aliasCandidates, loadAliases } from '../src/context/aliases.js';
import { scanTemplate } from '../src/context/extractors/angular-template.js';
import { call, connect, REPO_ROOT, tempWorkspace } from './helpers.js';

const FIXTURES = join(REPO_ROOT, 'testing', 'fixtures');
const STANDALONE = join(FIXTURES, 'angular-standalone');
const NGMODULE = join(FIXTURES, 'angular-ngmodule');

describe('scanTemplate', () => {
  it('reads test ids, roles, labels and text, static and bound', () => {
    const { selectors } = scanTemplate(
      [
        '<button data-testid="save" type="submit">Save changes</button>',
        `<tr [attr.data-testid]="'row-' + item.id"><td>{{ item.name }}</td></tr>`,
        `<input [placeholder]="'Search'" aria-label="Search orders" />`,
        '<mat-form-field><mat-label>Title</mat-label><input matInput /></mat-form-field>',
        '<div role="dialog"><h2>Confirm</h2></div>',
      ].join('\n'),
    );
    const by = (kind: string) => selectors.filter((s) => s.kind === kind).map((s) => s.value);
    expect(by('testid')).toEqual(['save', 'row-*']);
    expect(selectors.find((s) => s.value === 'row-*')).toMatchObject({ pattern: true, line: 2 });
    expect(by('text')).toEqual(['Save changes', 'Confirm']);
    expect(by('placeholder')).toEqual(['Search']);
    expect(by('aria-label')).toEqual(['Search orders']);
    expect(by('label')).toEqual(['Title']);
    expect(by('role')).toEqual(['dialog']);
  });

  it('reads routerLink in all its forms, and absolute hrefs', () => {
    const { links } = scanTemplate(
      [
        '<a routerLink="/orders">Orders</a>',
        `<a [routerLink]="'/settings'">Settings</a>`,
        `<a [routerLink]="['/orders', order.id, 'edit']">Edit</a>`,
        '<a routerLink="details">Relative</a>',
        '<a href="/help">Help</a>',
      ].join('\n'),
    );
    expect(links.map((l) => [l.to, l.pattern])).toEqual([
      ['/orders', false],
      ['/settings', false],
      ['/orders/*/edit', true],
      ['/help', false],
    ]);
  });

  it('records permission checks from *ngIf, @if, bindings and custom directives', () => {
    const { guards } = scanTemplate(
      [
        `<button *ngIf="auth.hasPermission('orders:create'); else none">New</button>`,
        `@if (perms.can('orders:delete')) { <button>Delete</button> }`,
        `<a *appHasRole="'admin'">Admin</a>`,
        `<button [disabled]="!auth.hasAnyRole(['editor', 'admin'])">Edit</button>`,
        `@if (items.length > 0) { <p>Items</p> }`,
      ].join('\n'),
    );
    expect(guards.map((g) => [g.call, g.args, g.in])).toEqual([
      ['hasPermission', ['orders:create'], 'template'],
      ['can', ['orders:delete'], 'template'],
      ['appHasRole', ['admin'], 'template'],
      ['hasAnyRole', ['editor', 'admin'], 'template'],
    ]);
  });

  it('skips comments, icon ligatures, interpolated text and keeps quoted ">"', () => {
    const { selectors } = scanTemplate(
      [
        '<!-- <button data-testid="old">Old</button> -->',
        '<button title="a > b" data-testid="next"><mat-icon>arrow_forward</mat-icon> Next</button>',
        '<button>{{ label }}</button>',
      ].join('\n'),
    );
    expect(selectors.map((s) => `${s.kind}:${s.value}`)).toEqual(['testid:next', 'text:Next']);
  });
});

describe('Angular routes', () => {
  it('follows standalone routes, lazy components and lazy children, with their guards', () => {
    const found = angularAdapter.findRoutes(STANDALONE);
    expect(found.routeConfig).toBe('src/app/app.routes.ts');
    expect(found.rootModule).toBe('src/app/app.component.ts');
    expect(found.warnings).toEqual([]);
    const rows = found.routes.map((r) => [r.path, r.kind, r.file, r.parent ?? null]);
    const shell = 'src/app/shell/shell.component.ts';
    expect(rows).toEqual([
      ['/login', 'route', 'src/app/login/login.component.ts', null],
      ['/', 'layout', shell, null],
      ['/tickets', 'route', 'src/app/tickets/ticket-list.component.ts', shell],
      ['/tickets/new', 'route', 'src/app/tickets/ticket-new.component.ts', shell],
      ['/tickets/:id', 'route', 'src/app/tickets/ticket-detail.component.ts', shell],
      ['/admin/users', 'route', 'src/app/admin/users.component.ts', shell],
    ]);
    const guards = (path: string) =>
      found.routes.find((r) => r.path === path)?.guards?.map((g) => [g.in, g.call, g.args]);
    expect(guards('/')).toEqual([['canActivate', 'authGuard', []]]);
    expect(guards('/tickets/new')).toEqual([['canActivate', 'roleGuard', ['editor', 'admin']]]);
    expect(guards('/admin/users')).toEqual([
      ['canMatch', 'roleGuard', ['admin']],
      ['route-data', 'data.roles', ['admin']],
    ]);
  });

  it('follows NgModule forRoot and forChild, and warns about string loadChildren', () => {
    const found = angularAdapter.findRoutes(NGMODULE);
    expect(found.routeConfig).toBe('src/app/app-routing.module.ts');
    expect(found.routes.map((r) => [r.path, r.kind, r.file])).toEqual([
      ['/', 'index', 'src/app/home/home.component.ts'],
      ['/orders', 'index', 'src/app/orders/order-list.component.ts'],
    ]);
    // The lazy group's canActivate gates the module's routes.
    expect(found.routes[1]?.guards?.map((g) => [g.in, g.call, g.args])).toEqual([
      ['canActivate', 'AuthGuard', []],
      ['route-data', 'data.permission', ['orders:read']],
    ]);
    expect(found.warnings).toEqual([
      expect.stringMatching(/string loadChildren ".\/legacy\/legacy.module#LegacyModule"/),
    ]);
  });

  it('says where it looked when there are no routes', () => {
    const found = angularAdapter.findRoutes(tempWorkspace({ 'src/app/app.ts': 'export {};' }));
    expect(found.routes).toEqual([]);
    expect(found.warnings[0]).toMatch(/no Angular routes found/);
  });
});

describe('tsconfig path aliases', () => {
  it('maps wildcard and exact aliases, and never leaves the workspace', () => {
    const aliases = loadAliases(STANDALONE);
    expect(aliasCandidates(aliases, '@app/login/login.component')).toEqual([
      'src/app/login/login.component',
    ]);
    expect(aliasCandidates(aliases, '@core')).toEqual(['src/app/core/index.ts']);
    expect(aliasCandidates(aliases, '@outside/x')).toEqual([]);
    expect(aliasCandidates(aliases, '@angular/core')).toEqual([]);
  });
});

const describeGuard = (g: { call: string; args: string[] }) => `${g.call}(${g.args.join(',')})`;

describe('the Angular map through the tools', () => {
  const config = stringify({
    version: 1,
    app: { start: 'npm start', url: 'http://localhost:4200', stack: 'angular' },
    db: { allowed_hosts: ['localhost'], profiles: { default: ['seed.sql'] } },
    auth: { mode: 'manual', login_path: '/login' },
    personas: [{ name: 'editor', seed_profile: 'default' }],
  });

  async function built() {
    const workspace = tempWorkspace({ '.tessa/config.yaml': config, 'seed.sql': '' }, 'tessa-ng-');
    cpSync(STANDALONE, workspace, { recursive: true });
    const client = await connect(workspace);
    const build = await call(client, 'build_static_map');
    expect(build.isError, JSON.stringify(build.data)).toBe(false);
    return { workspace, client, build: build.data };
  }

  it('builds the map with templates, services and aliased imports', async () => {
    const { workspace, build } = await built();
    expect(build).toMatchObject({ adapter: 'angular', routes: 6, warnings: [] });
    const map = JSON.parse(
      readFileSync(join(workspace, 'ai-test-artifacts/context/frontend-map.json'), 'utf8'),
    );
    const list = map.modules['src/app/tickets/ticket-list.component.ts'];
    expect(list.assets).toEqual(['src/app/tickets/ticket-list.component.html']);
    // Imports through the "@core" alias and a relative path are both followed.
    expect(list.imports).toEqual(['src/app/core/index.ts', 'src/app/tickets/ticket.service.ts']);
    expect(map.modules['src/app/tickets/ticket.service.ts'].api.map((a: any) => a.url)).toEqual([
      '/api/tickets',
      '/api/tickets',
      '/api/tickets/*/close',
    ]);
    expect(map.files['src/app/tickets/ticket-list.component.html']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers permission, selector and feature queries', async () => {
    const { client } = await built();
    const perms = await call(client, 'permissions_for_route', { route: '/tickets/new' });
    expect(perms.data.requires_sign_in).toBe(true);
    expect(perms.data.enforced.map(describeGuard)).toEqual([
      'roleGuard(editor,admin)',
      'authGuard()',
    ]);
    const admin = await call(client, 'permissions_for_route', { route: '/admin/users' });
    expect(admin.data.enforced.map((g: any) => g.call)).toEqual([
      'roleGuard',
      'data.roles',
      'authGuard',
    ]);
    // The shell's template shows the New ticket link only to those who can create tickets.
    const list = await call(client, 'permissions_for_route', { route: '/tickets' });
    expect(list.data.visibility.map(describeGuard)).toEqual(
      expect.arrayContaining(['can(tickets:create)', 'hasPermission(tickets:create)']),
    );

    const selectors = await call(client, 'selectors_for_component', { route: '/tickets' });
    const testids = selectors.data.selectors
      .filter((s: any) => s.kind === 'testid')
      .map((s: any) => s.value);
    expect(testids).toEqual(
      expect.arrayContaining(['create-ticket', 'ticket-row-*', 'nav-new-ticket']),
    );
    expect(selectors.data.selectors.find((s: any) => s.value === 'create-ticket').source).toBe(
      'src/app/tickets/ticket-list.component.html',
    );

    const routes = await call(client, 'routes_for_feature', { query: 'create a new ticket' });
    expect(routes.data.routes[0].path).toBe('/tickets/new');
  });

  it('re-reads a component when only its template changes', async () => {
    const { workspace, client } = await built();
    const again = await call(client, 'build_static_map');
    expect(again.data.reparsed).toBe(0);
    const html = join(workspace, 'src/app/tickets/ticket-list.component.html');
    writeFileSync(
      html,
      `${readFileSync(html, 'utf8')}\n<button data-testid="export-csv">Export</button>\n`,
    );
    const changed = await call(client, 'build_static_map');
    expect(changed.data.reparsed).toBe(1);
    const selectors = await call(client, 'selectors_for_component', {
      file: 'src/app/tickets/ticket-list.component.ts',
    });
    expect(selectors.data.selectors.map((s: any) => s.value)).toContain('export-csv');
  });

  it('is offered by detect_stack', async () => {
    const workspace = tempWorkspace({}, 'tessa-ng-detect-');
    cpSync(STANDALONE, workspace, { recursive: true });
    const client = await connect(workspace);
    const { data } = await call(client, 'detect_stack');
    expect(data.stack).toMatchObject({ name: 'angular', adapter_available: true });
    expect(data.url_hint).toBe('http://localhost:4200');
    expect(data.start_command).toBe('npm run start');
  });
});
