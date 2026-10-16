import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createServer, SERVER_VERSION } from '../src/index.js';
import { mergeGitignore } from '../src/init/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_APP = join(REPO_ROOT, 'testing', 'sample-app');

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

// Skipped when copying the sample app, so each test starts from an uninitialised workspace.
const SKIP_DIRS = /[\\/](node_modules|build|\.react-router|\.tessa|ai-test-artifacts)([\\/]|$)/;
const SKIP_FILES = /[\\/]\.(env|gitignore)$/;

/** Copies the sample app, without Tessa files, build output or .env, into a temp workspace. */
function sampleWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tessa-server-'));
  cpSync(SAMPLE_APP, dir, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.test(src) && !SKIP_FILES.test(src),
  });
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function connect(workspace: string): Promise<Client> {
  const server = createServer({ workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    data: response.structuredContent as Record<string, any>,
  };
}

const SAMPLE_INIT = {
  app: { url: 'http://127.0.0.1:5173' },
  seed_profiles: {
    default: ['scripts/seed/base.sql', 'scripts/seed/users.sql', 'scripts/seed/tickets.sql'],
    'admin-heavy': ['scripts/seed/base.sql', 'scripts/seed/admins.sql', 'scripts/seed/tickets.sql'],
  },
  personas: [
    { name: 'viewer', seed_profile: 'default' },
    { name: 'editor', seed_profile: 'default' },
    { name: 'admin', seed_profile: 'admin-heavy' },
  ],
  export_target: 'playwright-ts',
};

describe('tessa-mcp server', () => {
  it('reports a version matching package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'mcp-server', 'package.json'), 'utf8'));
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('lists the Phase 1 tools with read-only hints where they apply', async () => {
    const client = await connect(sampleWorkspace());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'detect_stack',
      'init_workspace',
      'load_config',
      'validate_config',
    ]);
    expect(byName.load_config?.annotations?.readOnlyHint).toBe(true);
    expect(byName.init_workspace?.annotations?.readOnlyHint).toBe(false);
  });

  it('detects the sample app stack', async () => {
    const client = await connect(sampleWorkspace());
    const { data } = await call(client, 'detect_stack');
    expect(data.stack.name).toBe('react-router');
    expect(data.start_command).toBe('npm run dev');
  });

  it('load_config tells the agent to run /tessa-init when there is no config', async () => {
    const client = await connect(sampleWorkspace());
    const { isError, data } = await call(client, 'load_config');
    expect(isError).toBe(true);
    expect(data.issues[0].message).toMatch(/\/tessa-init/);
  });

  it('init_workspace dry run writes nothing', async () => {
    const workspace = sampleWorkspace();
    const client = await connect(workspace);
    const { data } = await call(client, 'init_workspace', { ...SAMPLE_INIT, dry_run: true });
    expect(data.ok).toBe(true);
    expect(data.files.map((f: any) => [f.path, f.action])).toEqual([
      ['.tessa/config.yaml', 'created'],
      ['ai-test-artifacts/context/hints.md', 'created'],
      ['.gitignore', 'created'],
    ]);
    const after = await call(client, 'load_config');
    expect(after.isError).toBe(true);
  });

  it('initialises the sample app so load_config succeeds', async () => {
    const workspace = sampleWorkspace();
    const client = await connect(workspace);
    const init = await call(client, 'init_workspace', SAMPLE_INIT);
    expect(init.isError).toBe(false);
    expect(init.data.issues).toEqual([]);

    const config = parse(readFileSync(join(workspace, '.tessa', 'config.yaml'), 'utf8'));
    expect(config.app).toMatchObject({ start: 'npm run dev', stack: 'react-router' });
    // The sample app keeps its code in app/, not src/.
    expect(config.context.static_map.include).toEqual(['app/**']);
    expect(readFileSync(join(workspace, '.tessa', 'config.yaml'), 'utf8')).toMatch(
      /# Tessa never automates login/,
    );

    const loaded = await call(client, 'load_config');
    expect(loaded.isError).toBe(false);
    expect(loaded.data.config.personas).toHaveLength(3);
    expect(loaded.data.config.export.target).toBe('playwright-ts');

    const ignore = readFileSync(join(workspace, '.gitignore'), 'utf8');
    expect(ignore).toContain('ai-test-artifacts/.session/');
  });

  it('is idempotent and never replaces an existing config without overwrite', async () => {
    const workspace = sampleWorkspace();
    const client = await connect(workspace);
    await call(client, 'init_workspace', SAMPLE_INIT);

    const again = await call(client, 'init_workspace', SAMPLE_INIT);
    expect(again.data.files.map((f: any) => f.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);

    writeFileSync(join(workspace, 'ai-test-artifacts', 'context', 'hints.md'), '# mine\n');
    const changed = await call(client, 'init_workspace', {
      ...SAMPLE_INIT,
      export_target: 'cypress-ts',
    });
    expect(changed.data.files[0]).toMatchObject({ action: 'skipped' });
    expect(readFileSync(join(workspace, 'ai-test-artifacts', 'context', 'hints.md'), 'utf8')).toBe(
      '# mine\n',
    );

    const replaced = await call(client, 'init_workspace', {
      ...SAMPLE_INIT,
      export_target: 'cypress-ts',
      overwrite: true,
    });
    expect(replaced.data.files[0]).toMatchObject({ action: 'updated' });
  });

  it('refuses to write a config that fails the schema', async () => {
    const workspace = sampleWorkspace();
    const client = await connect(workspace);
    const { isError, data } = await call(client, 'init_workspace', {
      ...SAMPLE_INIT,
      app: { url: 'https://prod.example.com' },
    });
    expect(isError).toBe(true);
    expect(data.files[0]).toMatchObject({ action: 'skipped' });
    expect(data.issues.some((i: any) => i.path === '/app/url')).toBe(true);
  });

  it('writes the config but flags seed files that do not exist', async () => {
    const workspace = sampleWorkspace();
    const client = await connect(workspace);
    const { data } = await call(client, 'init_workspace', {
      ...SAMPLE_INIT,
      seed_profiles: { default: ['scripts/seed/missing.sql'] },
      personas: [{ name: 'viewer', seed_profile: 'default' }],
    });
    expect(data.ok).toBe(true);
    expect(data.issues[0].message).toMatch(/does not exist/);
  });

  it('refuses artifact roots that could inject .gitignore lines or escape the repo', async () => {
    const client = await connect(sampleWorkspace());
    for (const root of ['../out', 'a\n!secret', '/abs']) {
      const { isError } = await call(client, 'init_workspace', {
        ...SAMPLE_INIT,
        artifacts_root: root,
      });
      expect(isError).toBe(true);
    }
  });

  it('returns validation issues from validate_config', async () => {
    const workspace = sampleWorkspace();
    const client = await connect(workspace);
    await call(client, 'init_workspace', SAMPLE_INIT);
    const path = join(workspace, '.tessa', 'config.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('mode: manual', 'mode: scripted'));
    const { data } = await call(client, 'validate_config');
    expect(data.ok).toBe(false);
    expect(data.issues).toContainEqual({
      severity: 'error',
      path: '/auth/mode',
      message: 'must be "manual"',
    });
  });
});

describe('mergeGitignore', () => {
  const block = '# >>> tessa\nx/runs/\n# <<< tessa\n';

  it('appends to an existing file', () => {
    expect(mergeGitignore('node_modules/\n', block)).toBe(`node_modules/\n\n${block}`);
  });

  it('replaces only the managed block', () => {
    const existing = `a\n# >>> tessa\nold/\n# <<< tessa\nb\n`;
    expect(mergeGitignore(existing, block)).toBe(`a\n${block}b\n`);
  });
});
