import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseCommand, UnsafeCommandError } from '../src/app/command.js';
import { createServer } from '../src/index.js';
import { call, connect, freePort, onCleanup, SAMPLE_APP, tempWorkspace } from './helpers.js';

describe('parseCommand', () => {
  it.each([
    ['npm run dev', { program: 'npm', args: ['run', 'dev'] }],
    ['node   server.js  3000', { program: 'node', args: ['server.js', '3000'] }],
    ['dotnet run --project src/Web', { program: 'dotnet', args: ['run', '--project', 'src/Web'] }],
    ['node "my server.js" --port=3000', { program: 'node', args: ['my server.js', '--port=3000'] }],
    ["pnpm --filter '@acme/web' dev", { program: 'pnpm', args: ['--filter', '@acme/web', 'dev'] }],
    ['C:\\tools\\app.exe -p 1', { program: 'C:\\tools\\app.exe', args: ['-p', '1'] }],
  ])('parses %j', (command, expected) => {
    expect(parseCommand(command)).toEqual(expected);
  });

  it.each([
    'npm run build && npm start',
    'npm run dev | tee log',
    'npm run dev > out.txt',
    'npm run dev; rm -rf /',
    'echo $HOME',
    'echo %PATH%',
    'npm run dev ^& calc',
    'node -e "require(1)"',
    'npm run `whoami`',
    'npm run dev\ncalc',
    'node "unclosed',
    '',
    '   ',
  ])('rejects %j', (command) => {
    expect(() => parseCommand(command)).toThrow(UnsafeCommandError);
  });
});

// A tiny app: listens on the port given as its first argument and answers /health.
const FIXTURE_SERVER = `
const http = require('node:http');
const port = Number(process.argv[2]);
console.log('fixture starting on ' + port);
http.createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404);
  res.end('ok');
}).listen(port, '127.0.0.1');
`;

async function fixtureWorkspace(overrides: { start?: string; timeout?: number } = {}) {
  const port = await freePort();
  const config = {
    version: 1,
    app: {
      start: overrides.start ?? `node server.cjs ${String(port)}`,
      url: `http://127.0.0.1:${String(port)}`,
      stack: 'react-router',
      health_path: '/health',
      start_timeout_seconds: overrides.timeout ?? 20,
    },
    db: { allowed_hosts: ['127.0.0.1'], profiles: { default: ['seed.sql'] } },
    auth: { mode: 'manual' },
    personas: [{ name: 'user', seed_profile: 'default' }],
  };
  const workspace = tempWorkspace({
    '.tessa/config.yaml': stringify(config),
    'seed.sql': '',
    'server.cjs': FIXTURE_SERVER,
    'idle.cjs': 'console.log("never listens"); setInterval(() => {}, 1000);',
  });
  return { workspace, port };
}

describe('app lifecycle tools', () => {
  it('starts, reports health, and stops the app', async () => {
    const { workspace, port } = await fixtureWorkspace();
    const client = await connect(workspace);

    const down = await call(client, 'health_check');
    expect(down.data).toMatchObject({ ok: false, healthy: false, managed: false });

    const started = await call(client, 'start_app');
    expect(started.isError).toBe(false);
    expect(started.data).toMatchObject({ ok: true, status: 'started', managed: true });
    expect(started.data.output_tail).toBeUndefined();

    const up = await call(client, 'health_check');
    expect(up.data).toMatchObject({
      healthy: true,
      status_code: 200,
      url: `http://127.0.0.1:${String(port)}/health`,
      managed: true,
    });

    const again = await call(client, 'start_app');
    expect(again.data).toMatchObject({ status: 'already_running', managed: true });

    const stopped = await call(client, 'stop_app');
    expect(stopped.data).toMatchObject({ ok: true, status: 'stopped' });
    expect((await call(client, 'health_check')).data.healthy).toBe(false);
    expect((await call(client, 'stop_app')).data.status).toBe('not_running');
  }, 60_000);

  it('stops the app when the server closes without stop_app', async () => {
    const { workspace, port } = await fixtureWorkspace();
    const server = createServer({ workspace });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect((await call(client, 'start_app')).data.status).toBe('started');

    await client.close();
    await server.close();

    const url = `http://127.0.0.1:${String(port)}/health`;
    await expect
      .poll(
        () =>
          fetch(url, { signal: AbortSignal.timeout(1000) }).then(
            () => 'up',
            () => 'down',
          ),
        { timeout: 10_000 },
      )
      .toBe('down');
  }, 60_000);

  it('leaves an app it did not start alone', async () => {
    const { workspace, port } = await fixtureWorkspace();
    const external = spawn(process.execPath, ['server.cjs', String(port)], { cwd: workspace });
    onCleanup(async () => {
      // Wait for exit: Windows will not delete a directory a running process is using.
      const exited = new Promise((resolve) => external.once('exit', resolve));
      external.kill();
      await exited;
    });
    const client = await connect(workspace);
    await expect
      .poll(async () => (await call(client, 'health_check')).data.healthy, { timeout: 10_000 })
      .toBe(true);

    const started = await call(client, 'start_app');
    expect(started.data).toMatchObject({ status: 'already_running', managed: false });
    const stopped = await call(client, 'stop_app');
    expect(stopped.data.status).toBe('not_managed');
    expect((await call(client, 'health_check')).data.healthy).toBe(true);
  }, 60_000);

  it('reports output when the app exits before it is healthy', async () => {
    const { workspace } = await fixtureWorkspace({ start: 'node missing.cjs' });
    const client = await connect(workspace);
    const started = await call(client, 'start_app');
    expect(started.isError).toBe(true);
    expect(started.data.status).toBe('failed');
    expect(started.data.error).toMatch(/exited before/);
    expect(started.data.output_tail.join('\n')).toMatch(/Cannot find module/);
  }, 60_000);

  it('gives up and stops the process after the start timeout', async () => {
    const { workspace } = await fixtureWorkspace({ start: 'node idle.cjs', timeout: 2 });
    const client = await connect(workspace);
    const started = await call(client, 'start_app');
    expect(started.data.status).toBe('failed');
    expect(started.data.error).toMatch(/not healthy within 2s/);
    expect(started.data.output_tail).toContain('never listens');
    expect((await call(client, 'stop_app')).data.status).toBe('not_running');
  }, 60_000);

  it('refuses a start command with shell operators', async () => {
    const { workspace } = await fixtureWorkspace({ start: 'node server.cjs && calc' });
    const client = await connect(workspace);
    const started = await call(client, 'start_app');
    expect(started.isError).toBe(true);
    expect(started.data.error).toMatch(/Shell operators/);
  });

  it('explains when there is no config', async () => {
    const client = await connect(tempWorkspace());
    const started = await call(client, 'start_app');
    expect(started.isError).toBe(true);
    expect(started.data.issues[0].message).toMatch(/\/tessa-init/);
  });
});

// Needs Docker and testing/sample-app/.env, so it only runs on a developer machine.
const sampleReady = existsSync(join(SAMPLE_APP, '.env')) && existsSync(join(SAMPLE_APP, '.tessa'));

describe.skipIf(!sampleReady)('app lifecycle against the sample app', () => {
  it('starts the sample app and passes its health check', async () => {
    const client = await connect(SAMPLE_APP);
    const before = await call(client, 'health_check');
    const started = await call(client, 'start_app');
    expect(started.data.ok, JSON.stringify(started.data.output_tail)).toBe(true);
    // / redirects to /login, which still counts as healthy.
    expect((await call(client, 'health_check')).data).toMatchObject({
      healthy: true,
      status_code: 302,
    });
    if (!before.data.healthy) {
      expect((await call(client, 'stop_app')).data.status).toBe('stopped');
    }
  }, 120_000);
});
