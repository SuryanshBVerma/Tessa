import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach } from 'vitest';
import { createServer } from '../src/index.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SAMPLE_APP = join(REPO_ROOT, 'testing', 'sample-app');

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

export function onCleanup(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup);
}

/** A fresh temp directory with the given files, removed after the test. */
export function tempWorkspace(files: Record<string, string> = {}, prefix = 'tessa-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  onCleanup(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

// Skipped when copying the sample app, so each test starts from an uninitialised workspace.
const SKIP_DIRS = /[\\/](node_modules|build|\.react-router|\.tessa|ai-test-artifacts)([\\/]|$)/;
const SKIP_FILES = /[\\/]\.(env|gitignore)$/;

/** Copies the sample app, without Tessa files, build output or .env, into a temp workspace. */
export function sampleWorkspace(): string {
  const dir = tempWorkspace({}, 'tessa-sample-');
  cpSync(SAMPLE_APP, dir, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.test(src) && !SKIP_FILES.test(src),
  });
  return dir;
}

export async function connect(workspace: string): Promise<Client> {
  const server = createServer({ workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  onCleanup(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  // start_app waits for the app to come up, which can pass the SDK's 60 s default on a busy machine.
  const response = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 115_000,
  });
  return {
    isError: response.isError === true,
    data: response.structuredContent as Record<string, any>,
  };
}

/** A TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('no port'));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

/** init_workspace arguments that configure the sample app. */
export const SAMPLE_INIT = {
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

/** A copy of the sample app with its real Tessa config, ready for context tools. */
export function initialisedSample(): string {
  const workspace = sampleWorkspace();
  mkdirSync(join(workspace, '.tessa'), { recursive: true });
  cpSync(join(SAMPLE_APP, '.tessa', 'config.yaml'), join(workspace, '.tessa', 'config.yaml'));
  return workspace;
}
