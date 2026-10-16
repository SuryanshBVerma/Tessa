import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/index.js';
import { assertSeedable, UnsafeDatabaseError } from '../src/db/guard.js';
import { resolveDatabaseUrl } from '../src/db/seed.js';
import { call, connect, SAMPLE_APP, tempWorkspace } from './helpers.js';

const LOCAL = ['localhost', '127.0.0.1', '::1'];

describe('assertSeedable', () => {
  it.each([
    ['postgres://u:p@localhost:5433/app', { host: 'localhost', port: 5433, database: 'app' }],
    ['postgresql://u:p@127.0.0.1/app', { host: '127.0.0.1', port: 5432, database: 'app' }],
    ['postgres://u:p@[::1]:5433/app', { host: '::1', port: 5433, database: 'app' }],
    ['postgres://u:p@LOCALHOST/app', { host: 'localhost', port: 5432, database: 'app' }],
    [
      'postgres://u:p@localhost/app?host=localhost',
      { host: 'localhost', port: 5432, database: 'app' },
    ],
  ])('allows %s', (url, target) => {
    expect(assertSeedable(url, LOCAL)).toEqual(target);
  });

  it.each([
    ['postgres://u:p@db.example.com/prod', /not a local host/],
    ['postgres://u:p@10.0.0.5/shared', /not a local host/],
    ['postgres://u:p@0.0.0.0/app', /not a local host/],
    ['postgres://u:p@127.0.0.2/app', /not a local host/],
    ['postgres://u:p@localhost.example.com/app', /not a local host/],
    ['postgres://u:p@127.0.0.1.nip.io/app', /not a local host/],
    ['postgres://u:p@localhost,db.example.com/app', /not a valid URL|not a local host/],
    ['postgres://u:p@localhost/app?host=db.example.com', /"host" parameter/],
    ['postgres://u:p@localhost/app?hostaddr=10.0.0.5', /"hostaddr" parameter/],
    ['postgres://u:p@localhost/app?host=%2Fvar%2Frun%2Fpostgresql', /"host" parameter/],
    ['postgres:///app', /no host/],
    ['mysql://u:p@localhost/app', /only postgres/],
    ['not a url', /not a valid URL/],
  ])('refuses %s', (url, reason) => {
    expect(() => assertSeedable(url, LOCAL)).toThrow(reason);
  });

  it('refuses a local host that config does not allow', () => {
    expect(() => assertSeedable('postgres://u:p@localhost/app', ['127.0.0.1'])).toThrow(
      /not in db.allowed_hosts/,
    );
  });

  it('never allows a remote host even if config lists it', () => {
    expect(() => assertSeedable('postgres://u:p@db.example.com/app', ['db.example.com'])).toThrow(
      /not a local host/,
    );
  });

  it('never puts the URL or password in the error', () => {
    try {
      assertSeedable('postgres://admin:hunter2-secret@db.example.com/prod', LOCAL);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeDatabaseError);
      expect(String(error)).not.toMatch(/hunter2|admin:/);
    }
  });
});

const envNames: string[] = [];
afterEach(() => {
  for (const name of envNames.splice(0)) {
    Reflect.deleteProperty(process.env, name);
  }
});

function uniqueEnvName(): string {
  const name = `TESSA_TEST_DB_URL_${String(process.pid)}_${String(envNames.length)}`;
  envNames.push(name);
  return name;
}

function fixture(
  urlEnv: string,
  files: Record<string, string>,
  profiles: Record<string, string[]>,
) {
  return tempWorkspace({
    '.tessa/config.yaml': stringify({
      version: 1,
      app: { start: 'npm run dev', url: 'http://localhost:3000', stack: 'react-router' },
      db: { url_env: urlEnv, allowed_hosts: ['localhost', '127.0.0.1'], profiles },
      auth: { mode: 'manual' },
      personas: [{ name: 'user', seed_profile: Object.keys(profiles)[0] }],
    }),
    ...files,
  });
}

describe('resolveDatabaseUrl', () => {
  it('prefers the environment, then .env', () => {
    const name = uniqueEnvName();
    const workspace = fixture(
      name,
      { 'a.sql': '', '.env': `${name}=postgres://u:p@localhost/fromfile\n` },
      { default: ['a.sql'] },
    );
    const loaded = loadConfig({ workspace });
    if (!loaded.ok) throw new Error('config');
    expect(resolveDatabaseUrl(loaded.config, workspace)).toEqual({
      url: 'postgres://u:p@localhost/fromfile',
      source: '.env',
    });
    process.env[name] = 'postgres://u:p@localhost/fromenv';
    expect(resolveDatabaseUrl(loaded.config, workspace).source).toBe('environment');
  });

  it('names the variable when it is missing', () => {
    const name = uniqueEnvName();
    const workspace = fixture(name, { 'a.sql': '' }, { default: ['a.sql'] });
    const loaded = loadConfig({ workspace });
    if (!loaded.ok) throw new Error('config');
    expect(() => resolveDatabaseUrl(loaded.config, workspace)).toThrow(
      new RegExp(`${name} is not set`),
    );
  });
});

describe('seed_db tool safety', () => {
  it('refuses a remote database before connecting and never echoes the URL', async () => {
    const name = uniqueEnvName();
    process.env[name] = 'postgres://admin:hunter2-secret@db.example.com:5432/prod';
    const client = await connect(
      fixture(name, { 'a.sql': 'DROP TABLE users;' }, { default: ['a.sql'] }),
    );
    const { isError, data } = await call(client, 'seed_db', { profile: 'default' });
    expect(isError).toBe(true);
    expect(data).toMatchObject({ ok: false, refused: true });
    expect(JSON.stringify(data)).not.toMatch(/hunter2|admin:|db\.example\.com:5432\/prod/);
  });

  it('rejects an unknown profile', async () => {
    const name = uniqueEnvName();
    process.env[name] = 'postgres://u:p@localhost:1/none';
    const client = await connect(fixture(name, { 'a.sql': '' }, { default: ['a.sql'] }));
    const { data } = await call(client, 'seed_db', { profile: 'nope' });
    expect(data.error).toMatch(/unknown seed profile "nope"; defined: default/);
  });

  it('reports a connection failure with the target but no credentials', async () => {
    const name = uniqueEnvName();
    process.env[name] = 'postgres://u:secret-pw@127.0.0.1:1/none';
    const client = await connect(fixture(name, { 'a.sql': '' }, { default: ['a.sql'] }));
    const { data } = await call(client, 'seed_db', { profile: 'default' });
    expect(data.error).toMatch(/could not connect to 127\.0\.0\.1:1\/none/);
    expect(JSON.stringify(data)).not.toMatch(/secret-pw/);
  });
});

// Needs the sample app's Postgres (Docker) and testing/sample-app/.env.
const sampleReady = existsSync(join(SAMPLE_APP, '.env')) && existsSync(join(SAMPLE_APP, '.tessa'));

describe.skipIf(!sampleReady)('seeding the sample app database', () => {
  async function count(sql: string): Promise<number> {
    const loaded = loadConfig({ workspace: SAMPLE_APP });
    if (!loaded.ok) throw new Error('sample config');
    const db = new pg.Client({
      connectionString: resolveDatabaseUrl(loaded.config, SAMPLE_APP).url,
    });
    await db.connect();
    try {
      const { rows } = await db.query<{ n: string }>(sql);
      return Number(rows[0]?.n);
    } finally {
      await db.end();
    }
  }

  it('applies profiles and resets to the last one', async () => {
    const client = await connect(SAMPLE_APP);

    const seeded = await call(client, 'seed_db', { profile: 'default' });
    expect(seeded.data).toMatchObject({
      ok: true,
      profile: 'default',
      target: { host: '127.0.0.1', port: 5433, database: 'tessa_sample' },
      url_source: '.env',
    });
    expect(JSON.stringify(seeded.data)).not.toMatch(/postgres:\/\//);
    expect(await count('SELECT count(*) AS n FROM users')).toBe(4);

    await call(client, 'seed_db', { profile: 'admin-heavy' });
    expect(await count("SELECT count(*) AS n FROM users WHERE role = 'admin'")).toBe(3);

    await count("INSERT INTO tickets (title, created_by) VALUES ('stray', 1) RETURNING 1 AS n");
    const reset = await call(client, 'reset_db');
    expect(reset.data).toMatchObject({ ok: true, reset_to: 'admin-heavy' });
    expect(await count("SELECT count(*) AS n FROM tickets WHERE title = 'stray'")).toBe(0);

    expect((await call(client, 'reset_db', { profile: 'default' })).data.ok).toBe(true);
    expect(await count('SELECT count(*) AS n FROM users')).toBe(4);
  }, 60_000);

  it('rolls back the whole profile when one file fails', async () => {
    const loaded = loadConfig({ workspace: SAMPLE_APP });
    if (!loaded.ok) throw new Error('sample config');
    const name = uniqueEnvName();
    process.env[name] = resolveDatabaseUrl(loaded.config, SAMPLE_APP).url;
    const client = await connect(
      fixture(
        name,
        {
          'ok.sql': 'CREATE TABLE tessa_rollback_probe (id int);',
          'bad.sql': 'THIS IS NOT SQL;',
        },
        { broken: ['ok.sql', 'bad.sql'] },
      ),
    );
    const { data } = await call(client, 'seed_db', { profile: 'broken' });
    expect(data).toMatchObject({ ok: false, file: 'bad.sql' });
    expect(data.error).toMatch(/rolled back/);
    expect(
      await count("SELECT count(*) AS n FROM pg_tables WHERE tablename = 'tessa_rollback_probe'"),
    ).toBe(0);
  }, 60_000);
});
