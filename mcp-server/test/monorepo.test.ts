import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { call, connect, REPO_ROOT, tempWorkspace } from './helpers.js';

const ANGULAR = join(REPO_ROOT, 'testing', 'fixtures', 'angular-standalone');

/**
 * A monorepo with no package.json at the root: the Angular app in frontend/, a .NET Web API in
 * api/, Playwright tests in tests/e2e/, and a class library that is not a backend.
 */
function monorepo(files: Record<string, string> = {}): string {
  const workspace = tempWorkspace(
    {
      'api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      'lib/Shared.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'tests/e2e/package.json': JSON.stringify({
        devDependencies: { '@playwright/test': '1.63.0' },
      }),
      'frontend/package-lock.json': '{}',
      ...files,
    },
    'tessa-mono-',
  );
  cpSync(ANGULAR, join(workspace, 'frontend'), { recursive: true });
  return workspace;
}

describe('detect_stack in a monorepo', () => {
  it('finds the frontend in its folder, its start command, and the backend beside it', async () => {
    const client = await connect(monorepo());
    const { data } = await call(client, 'detect_stack');
    expect(data.stack).toEqual({
      name: 'angular',
      evidence: ['frontend/package.json: @angular/core'],
      adapter_available: true,
    });
    expect(data.app_root).toBe('frontend');
    expect(data.start_command).toBe('npm run start');
    expect(data.package_manager).toBe('npm');
    expect(data.url_hint).toBe('http://localhost:4200');
    expect(data.backends).toEqual([
      { name: 'dotnet', evidence: ['api/Api.csproj: Microsoft.NET.Sdk.Web'] },
    ]);
    expect(data.export_targets).toEqual(
      expect.arrayContaining([
        { name: 'playwright-ts', evidence: ['frontend/package.json: @playwright/test'] },
        { name: 'playwright-ts', evidence: ['tests/e2e/package.json: @playwright/test'] },
      ]),
    );
  });

  it('prefers a frontend Tessa has an adapter for over the root workspace package', async () => {
    const workspace = monorepo({
      'package.json': JSON.stringify({ private: true, workspaces: ['frontend'] }),
      'tools/vue-docs/package.json': JSON.stringify({ dependencies: { vue: '3' } }),
    });
    const { data } = await call(await connect(workspace), 'detect_stack');
    expect(data.stack.name).toBe('angular');
    expect(data.app_root).toBe('frontend');
    expect(data.candidates.map((c: { name: string }) => c.name).sort()).toEqual(['angular', 'vue']);
  });

  it('keeps the root as the app folder for a single-app repository', async () => {
    const workspace = tempWorkspace({}, 'tessa-single-');
    cpSync(ANGULAR, workspace, { recursive: true });
    const { data } = await call(await connect(workspace), 'detect_stack');
    expect(data).toMatchObject({ app_root: '.', backends: [] });
  });
});

describe('the map of an app in a subfolder', () => {
  const init = {
    app: { url: 'http://localhost:4200' },
    seed_profiles: { default: ['db/seed.sql'] },
    personas: [{ name: 'editor', seed_profile: 'default' }],
    export_target: 'playwright-ts',
  };

  it('/tessa-init sets app.cwd and source globs inside the app folder', async () => {
    const workspace = monorepo({ 'db/seed.sql': '' });
    const client = await connect(workspace);
    const written = await call(client, 'init_workspace', init);
    expect(written.isError, JSON.stringify(written.data)).toBe(false);
    const config = parse(readFileSync(join(workspace, '.tessa', 'config.yaml'), 'utf8'));
    expect(config.app).toMatchObject({ cwd: 'frontend', stack: 'angular', start: 'npm run start' });
    expect(config.context.static_map.include).toEqual(['src/**']);
  });

  it('builds routes, modules and templates with workspace-relative paths', async () => {
    const workspace = monorepo({
      'db/seed.sql': '',
      '.tessa/config.yaml': stringify({
        version: 1,
        app: {
          start: 'npm start',
          cwd: 'frontend',
          url: 'http://localhost:4200',
          stack: 'angular',
        },
        db: { allowed_hosts: ['localhost'], profiles: { default: ['db/seed.sql'] } },
        auth: { mode: 'manual', login_path: '/login' },
        personas: [{ name: 'editor', seed_profile: 'default' }],
      }),
    });
    const client = await connect(workspace);
    const build = await call(client, 'build_static_map');
    expect(build.isError, JSON.stringify(build.data)).toBe(false);
    expect(build.data).toMatchObject({ routes: 6, warnings: [] });
    const map = JSON.parse(
      readFileSync(join(workspace, 'ai-test-artifacts/context/frontend-map.json'), 'utf8'),
    );
    expect(map.app_root).toBe('frontend');
    const list = map.routes.find((r: { path: string }) => r.path === '/tickets');
    expect(list).toMatchObject({
      file: 'frontend/src/app/tickets/ticket-list.component.ts',
      parent: 'frontend/src/app/shell/shell.component.ts',
    });
    const info = map.modules['frontend/src/app/tickets/ticket-list.component.ts'];
    expect(info.assets).toEqual(['frontend/src/app/tickets/ticket-list.component.html']);
    // The "@core" alias comes from frontend/tsconfig.json.
    expect(info.imports).toEqual([
      'frontend/src/app/core/index.ts',
      'frontend/src/app/tickets/ticket.service.ts',
    ]);

    const perms = await call(client, 'permissions_for_route', { route: '/tickets/new' });
    expect(perms.data.enforced.map((g: { call: string }) => g.call)).toEqual([
      'roleGuard',
      'authGuard',
    ]);
    const fresh = await call(client, 'context_freshness');
    // Every mapped file, templates included, resolves from the workspace root.
    expect(fresh.data).toMatchObject({ changed_files: [], stale: false });
  });
});
