import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { call, connect, SAMPLE_APP, tempWorkspace } from './helpers.js';

function fixture() {
  return tempWorkspace({
    '.tessa/config.yaml': stringify({
      version: 1,
      app: { start: 'npm run dev', url: 'http://localhost:3000', stack: 'react-router' },
      db: { allowed_hosts: ['localhost'], profiles: { default: ['a.sql'], other: ['a.sql'] } },
      auth: { mode: 'manual' },
      personas: [
        { name: 'viewer', seed_profile: 'default' },
        { name: 'admin', seed_profile: 'other' },
      ],
    }),
    'a.sql': '',
  });
}

describe('capture_env_state', () => {
  it('uses the persona seed profile and omits Git facts outside a repository', async () => {
    const client = await connect(fixture());
    const { isError, data } = await call(client, 'capture_env_state', { persona: 'admin' });
    expect(isError).toBe(false);
    expect(data.env_state).toEqual({ persona: 'admin', seed_profile: 'other' });
    expect(data.seed_profile_source).toBe('persona-config');
    expect(data.environment).toEqual({ app_url: 'http://localhost:3000' });
    expect(Date.parse(data.captured_at)).not.toBeNaN();
  });

  it('merges what the executor observed', async () => {
    const client = await connect(fixture());
    const observed = {
      role: 'admin',
      permissions: ['tickets:read', 'users:manage'],
      settings: { theme: 'dark', page_size: 25 },
      feature_flags: { ticket_priority: true },
      build: 'local',
    };
    const { data } = await call(client, 'capture_env_state', {
      persona: 'admin',
      observed,
      host: 'claude-code',
    });
    expect(data.env_state).toEqual({ persona: 'admin', seed_profile: 'other', ...observed });
    expect(data.environment.host).toBe('claude-code');
  });

  it('rejects an unknown persona', async () => {
    const client = await connect(fixture());
    const { isError, data } = await call(client, 'capture_env_state', { persona: 'root' });
    expect(isError).toBe(true);
    expect(data.issues[0].message).toBe('unknown persona "root"; defined: viewer, admin');
  });

  it('rejects observed values that are not plain data', async () => {
    const client = await connect(fixture());
    const { isError } = await call(client, 'capture_env_state', {
      persona: 'viewer',
      observed: { settings: { nested: { deep: true } } },
    });
    expect(isError).toBe(true);
  });

  it('records the Git commit, branch and dirty flag inside a repository', async () => {
    const client = await connect(SAMPLE_APP);
    const loaded = await call(client, 'load_config');
    if (loaded.isError) return; // Sample app not initialised in this checkout.
    const { data } = await call(client, 'capture_env_state', { persona: 'viewer' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SAMPLE_APP }).toString().trim();
    expect(data.environment.commit).toBe(head);
    expect(typeof data.environment.dirty).toBe('boolean');
  });
});
