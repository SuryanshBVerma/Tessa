import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadConfig, NO_SEED_PROFILE } from '../src/config/index.js';
import { SCHEMAS_DIR } from '../src/schemas/index.js';
import { call, connect, tempWorkspace } from './helpers.js';

const OFF = {
  version: 1,
  app: { start: 'npm start', url: 'http://localhost:4200', stack: 'angular' },
  db: { enabled: false },
  auth: { mode: 'manual', login_path: '/login' },
  personas: [{ name: 'editor' }, { name: 'viewer' }],
};

/** A plan whose tests all use the "none" seed profile. */
function plan(): string {
  const example = JSON.parse(
    readFileSync(new URL('examples/tests.example.json', SCHEMAS_DIR), 'utf8'),
  ) as { tests: { preconditions: { seed_profile: string } }[] };
  for (const test of example.tests) test.preconditions.seed_profile = NO_SEED_PROFILE;
  return JSON.stringify(example);
}

describe('config with seeding off', () => {
  it('needs no hosts, profiles or seed profiles, and gives every persona "none"', () => {
    const workspace = tempWorkspace({ '.tessa/config.yaml': stringify(OFF) });
    const loaded = loadConfig({ workspace });
    expect(loaded.ok, JSON.stringify(loaded.issues)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.db).toMatchObject({ enabled: false, profiles: { none: [] } });
    expect(loaded.config.personas.map((p) => p.seed_profile)).toEqual(['none', 'none']);
  });

  it('ignores seed files that are listed but not used', () => {
    const workspace = tempWorkspace({
      '.tessa/config.yaml': stringify({
        ...OFF,
        db: { enabled: false, profiles: { default: ['missing.sql'] } },
        personas: [{ name: 'editor', seed_profile: 'default' }],
      }),
    });
    expect(loadConfig({ workspace }).ok).toBe(true);
  });

  it('still requires hosts, profiles and a seed profile per persona while seeding is on', () => {
    const missingDb = tempWorkspace({
      '.tessa/config.yaml': stringify({ ...OFF, db: {} }),
    });
    const noDb = loadConfig({ workspace: missingDb });
    expect(noDb.ok).toBe(false);
    expect(noDb.issues.map((i) => i.message).join(' ')).toMatch(/allowed_hosts|profiles/);

    const noProfile = tempWorkspace({
      'seed.sql': '',
      '.tessa/config.yaml': stringify({
        ...OFF,
        db: { allowed_hosts: ['localhost'], profiles: { default: ['seed.sql'] } },
      }),
    });
    const loaded = loadConfig({ workspace: noProfile });
    expect(loaded.ok).toBe(false);
    expect(loaded.issues[0]).toMatchObject({
      path: '/personas/0/seed_profile',
      message: expect.stringMatching(/required while seeding is on/),
    });
  });
});

describe('the tools with seeding off', () => {
  it('seed_db and reset_db touch nothing and say so, with no database URL set', async () => {
    const client = await connect(tempWorkspace({ '.tessa/config.yaml': stringify(OFF) }));
    const seeded = await call(client, 'seed_db', { profile: 'none' });
    expect(seeded.isError, JSON.stringify(seeded.data)).toBe(false);
    expect(seeded.data).toMatchObject({ ok: true, skipped: true, profile: 'none' });
    expect(seeded.data.message).toMatch(/Seeding is off/);
    const reset = await call(client, 'reset_db');
    expect(reset.data).toMatchObject({ ok: true, skipped: true });
  });

  it('runs plans that use the "none" profile and records it in the environment', async () => {
    const workspace = tempWorkspace({
      '.tessa/config.yaml': stringify(OFF),
      'ai-test-artifacts/plans/create-ticket/tests.json': plan(),
    });
    const client = await connect(workspace);
    await call(client, 'approve_plan', { story: 'create-ticket' });
    const begun = await call(client, 'begin_run', { story: 'create-ticket' });
    expect(begun.isError, JSON.stringify(begun.data)).toBe(false);
    const env = await call(client, 'capture_env_state', {
      persona: 'editor',
      run_id: begun.data.run_id,
    });
    expect(env.data.env_state).toMatchObject({ persona: 'editor', seed_profile: 'none' });
  });

  it('/tessa-init writes db.enabled: false and personas without seed profiles', async () => {
    const workspace = tempWorkspace({ 'src/app/app.ts': 'export {};' });
    const client = await connect(workspace);
    const written = await call(client, 'init_workspace', {
      seeding: false,
      app: { url: 'http://localhost:4200', start: 'npm start', stack: 'angular' },
      personas: [{ name: 'editor' }],
      export_target: 'playwright-ts',
    });
    expect(written.isError, JSON.stringify(written.data)).toBe(false);
    const config = parse(readFileSync(join(workspace, '.tessa', 'config.yaml'), 'utf8'));
    expect(config.db).toEqual({ enabled: false });
    expect(config.personas).toEqual([{ name: 'editor' }]);
    expect((await call(client, 'load_config')).data.ok).toBe(true);
  });
});
