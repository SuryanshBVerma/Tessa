import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/index.js';
import { embedJson, escapeHtml } from '../src/report/render.js';
import { ReviewServer } from '../src/report/server.js';
import { SCHEMAS_DIR } from '../src/schemas/index.js';
import { call, connect, onCleanup, tempWorkspace } from './helpers.js';

const PLAN = readFileSync(new URL('examples/tests.example.json', SCHEMAS_DIR), 'utf8');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const HOSTILE = '</script><img src=x onerror=alert(1)><!-- \u2028 ${x} $& done';

/** A workspace with one finished run: one passed test, one failed test with a screenshot. */
async function finishedRun() {
  const workspace = tempWorkspace({
    '.tessa/config.yaml': stringify({
      version: 1,
      app: { start: 'npm run dev', url: 'http://127.0.0.1:5173', stack: 'react-router' },
      db: { allowed_hosts: ['127.0.0.1'], profiles: { default: ['seed.sql'] } },
      auth: { mode: 'manual' },
      personas: [
        { name: 'viewer', seed_profile: 'default' },
        { name: 'editor', seed_profile: 'default' },
      ],
      review: { idle_timeout_minutes: 5 },
    }),
    'seed.sql': '',
    'ai-test-artifacts/plans/create-ticket/tests.json': PLAN,
  });
  writeFileSync(join(workspace, 'shot.png'), PNG);
  const client = await connect(workspace);
  const runId = (await call(client, 'begin_run', { story: 'create-ticket' })).data.run_id as string;
  for (let i = 0; i < 3; i++) {
    await call(client, 'record_step', {
      run_id: runId,
      test_id: 'viewer-cannot-create',
      index: i,
      status: 'passed',
    });
  }
  await call(client, 'record_step', {
    run_id: runId,
    test_id: 'short-title-rejected',
    index: 0,
    status: 'failed',
    actual: HOSTILE,
    screenshot: { path: join(workspace, 'shot.png') },
  });
  expect((await call(client, 'write_results', { run_id: runId })).data.ok).toBe(true);
  return { workspace, client, runId };
}

/** Raw HTTP so tests can send any Host and Origin headers. */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

async function serve(client: Awaited<ReturnType<typeof connect>>, runId: string) {
  const { data } = await call(client, 'serve_review', { run_id: runId });
  expect(data.ok).toBe(true);
  const url = new URL(data.url as string);
  return {
    base: data.url as string,
    origin: url.origin,
    port: Number(url.port),
    token: url.pathname.split('/')[1] ?? '',
  };
}

describe('render_report', () => {
  it('writes a self-contained report with a fresh nonce and inert embedded data', async () => {
    const { workspace, client, runId } = await finishedRun();
    const first = await call(client, 'render_report', { run_id: runId });
    expect(first.data).toMatchObject({ ok: true, tests: 3 });
    const html = readFileSync(join(workspace, first.data.path as string), 'utf8');

    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce ?? ''}">`);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/\{\{[A-Z]+\}\}/);

    // App text cannot end the data block or add markup.
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('\u2028');
    const data = /<script type="application\/json" id="tessa-data">\s*([\s\S]*?)\s*<\/script>/.exec(
      html,
    )?.[1];
    const parsed = JSON.parse(data ?? '{}');
    const failed = parsed.results.tests.find((t: any) => t.test_id === 'short-title-rejected');
    expect(failed.failure.actual).toBe(HOSTILE);

    const second = await call(client, 'render_report', { run_id: runId });
    const again = readFileSync(join(workspace, second.data.path as string), 'utf8');
    expect(/script-src 'nonce-([^']+)'/.exec(again)?.[1]).not.toBe(nonce);
  });

  it('needs results first', async () => {
    const { client } = await finishedRun();
    const { isError, data } = await call(client, 'render_report', { run_id: '20200101T000000Z' });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/no results\.json yet/);
  });

  it('escapes HTML and embeds JSON safely', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(embedJson({ a: '</script>\u2028' })).toBe('{"a":"\\u003c/script>\\u2028"}');
  });
});

describe('review server', () => {
  it('serves the report and screenshots on 127.0.0.1 behind the token', async () => {
    const { client, runId } = await finishedRun();
    const { base, token } = await serve(client, runId);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/$/);

    const page = await raw(base);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
    });

    const shot = await raw(`${base}screenshots/short-title-rejected/1-00.png`);
    expect(shot.status).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');

    for (const path of [
      '',
      `${token.slice(0, -1)}x/`,
      `${token}x/`,
      `${token}/run-state.json`,
      `${token}/results.json`,
      `${token}/screenshots/../run-state.json`,
      `${token}/screenshots/%2e%2e/run-state.json`,
      `${token}/screenshots/short-title-rejected/..%2f..%2frun-state.json`,
      `${token}/screenshots/short-title-rejected/1-00.txt`,
    ]) {
      const { port } = new URL(base);
      expect((await raw(`http://127.0.0.1:${port}/${path}`)).status, path).toBe(404);
    }
  });

  it('refuses requests whose Host is not 127.0.0.1:<port> (DNS rebinding)', async () => {
    const { client, runId } = await finishedRun();
    const { base, port } = await serve(client, runId);
    for (const host of [
      'evil.example',
      `evil.example:${String(port)}`,
      `localhost:${String(port)}`,
    ]) {
      expect((await raw(base, { headers: { Host: host } })).status, host).toBe(403);
    }
  });

  it('accepts a selection only from its own origin, as JSON, for known tests', async () => {
    const { workspace, client, runId } = await finishedRun();
    const { base, origin } = await serve(client, runId);
    const post = (headers: Record<string, string>, body: unknown) =>
      raw(`${base}selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    const valid = { selected_test_ids: ['viewer-cannot-create'] };

    expect((await raw(`${base}selection`)).status).toBe(405);
    expect((await post({}, valid)).status).toBe(403);
    expect((await post({ Origin: 'http://evil.example' }, valid)).status).toBe(403);
    expect((await post({ Origin: origin, 'Content-Type': 'text/plain' }, valid)).status).toBe(415);
    expect((await post({ Origin: origin }, 'not json')).status).toBe(400);
    expect((await post({ Origin: origin }, { selected_test_ids: [] })).status).toBe(400);
    const unknown = await post({ Origin: origin }, { selected_test_ids: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toMatch(/no tests: nope/);
    const huge = await post({ Origin: origin }, { selected_test_ids: ['x'.repeat(70_000)] }).catch(
      () => ({ status: 413 }),
    );
    expect(huge.status).toBeGreaterThanOrEqual(400);

    const ok = await post({ Origin: origin }, { ...valid, token: 'ignored', notes: 'looks good' });
    expect(ok.status).toBe(200);
    const saved = JSON.parse(
      readFileSync(join(workspace, 'ai-test-artifacts', 'runs', runId, 'selection.json'), 'utf8'),
    );
    expect(saved).toMatchObject({
      run_id: runId,
      selected_test_ids: ['viewer-cannot-create'],
      source: 'local-server',
      notes: 'looks good',
    });
    expect(saved.token).toBeUndefined();

    const got = await call(client, 'get_selection', { run_id: runId });
    expect(got.data).toMatchObject({ status: 'received', selection: { source: 'local-server' } });
  });

  it('get_selection waits for the reviewer to press Export', async () => {
    const { client, runId } = await finishedRun();
    const { base, origin } = await serve(client, runId);
    expect((await call(client, 'get_selection', { run_id: runId })).data.status).toBe('waiting');
    const waiting = call(client, 'get_selection', { run_id: runId, wait_seconds: 10 });
    setTimeout(() => {
      void raw(`${base}selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ selected_test_ids: ['short-title-rejected'] }),
      });
    }, 200);
    expect((await waiting).data).toMatchObject({
      status: 'received',
      selection: { selected_test_ids: ['short-title-rejected'] },
    });
  });

  it('stops on stop_review and when the MCP session closes', async () => {
    const { client, runId } = await finishedRun();
    const { base } = await serve(client, runId);
    expect((await call(client, 'stop_review')).data.status).toBe('stopped');
    await expect(raw(base)).rejects.toThrow();
    expect((await call(client, 'stop_review')).data.status).toBe('not_running');

    const second = await serve(client, runId);
    await client.close();
    await expect
      .poll(() =>
        raw(second.base).then(
          () => 'up',
          () => 'down',
        ),
      )
      .toBe('down');
  });

  it('serves one review at a time', async () => {
    const { client, runId } = await finishedRun();
    const first = await serve(client, runId);
    const second = await serve(client, runId);
    expect(second.token).not.toBe(first.token);
    await expect(raw(first.base)).rejects.toThrow();
    expect((await raw(second.base)).status).toBe(200);
  });

  it('shuts itself down after the idle timeout', async () => {
    const { workspace, runId } = await finishedRun();
    const loaded = loadConfig({ workspace });
    if (!loaded.ok) throw new Error('config');
    // Below the schema minimum on purpose, to keep the test fast.
    loaded.config.review.idle_timeout_minutes = 0.005;
    const review = new ReviewServer();
    onCleanup(async () => {
      await review.stop();
    });
    const info = await review.start({ config: loaded.config, workspace }, runId);
    expect((await raw(info.url)).status).toBe(200);
    // Every request resets the timer, so stay quiet past the 300 ms timeout before checking.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(review.active).toBeNull();
    await expect(raw(info.url)).rejects.toThrow();
  });
});

describe('record_selection (static fallback)', () => {
  it('saves a pasted selection and checks the test ids', async () => {
    const { workspace, client, runId } = await finishedRun();
    const bad = await call(client, 'record_selection', {
      run_id: runId,
      selected_test_ids: ['nope'],
    });
    expect(bad.isError).toBe(true);
    const good = await call(client, 'record_selection', {
      run_id: runId,
      selected_test_ids: ['viewer-cannot-create', 'viewer-cannot-create'],
      target: 'playwright-ts',
    });
    expect(good.data.selection).toMatchObject({
      source: 'static',
      selected_test_ids: ['viewer-cannot-create'],
      target: 'playwright-ts',
    });
    expect(existsSync(join(workspace, 'ai-test-artifacts', 'runs', runId, 'selection.json'))).toBe(
      true,
    );
    expect((await call(client, 'get_selection', { run_id: runId })).data.status).toBe('received');
  });
});
