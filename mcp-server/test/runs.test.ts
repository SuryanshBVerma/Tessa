import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { overlaps, selectorStability } from '../src/runs/results.js';
import { SCHEMAS_DIR, validate } from '../src/schemas/index.js';
import { call, connect, tempWorkspace } from './helpers.js';

const PLAN = readFileSync(new URL('examples/tests.example.json', SCHEMAS_DIR), 'utf8');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

function fixture(plan = PLAN) {
  const workspace = tempWorkspace({
    '.tessa/config.yaml': stringify({
      version: 1,
      app: { start: 'npm run dev', url: 'http://127.0.0.1:5173', stack: 'react-router' },
      db: { allowed_hosts: ['127.0.0.1'], profiles: { default: ['seed.sql'] } },
      auth: { mode: 'manual', login_path: '/login' },
      personas: [
        { name: 'viewer', seed_profile: 'default' },
        { name: 'editor', seed_profile: 'default' },
      ],
    }),
    'seed.sql': '',
    'ai-test-artifacts/plans/create-ticket/tests.json': plan,
    'shot.png': '',
    'notes.txt': 'not an image',
  });
  writeFileSync(join(workspace, 'shot.png'), PNG);
  return workspace;
}

async function begin(workspace: string, args: Record<string, unknown> = {}) {
  const client = await connect(workspace);
  await call(client, 'approve_plan', { story: 'create-ticket' });
  const begun = await call(client, 'begin_run', {
    story: 'create-ticket',
    host: 'claude-code',
    ...args,
  });
  expect(begun.isError, JSON.stringify(begun.data)).toBe(false);
  return { client, runId: begun.data.run_id as string, data: begun.data };
}

describe('begin_run', () => {
  it('creates the run directory and returns indexed steps', async () => {
    const workspace = fixture();
    const { data, runId } = await begin(workspace);
    expect(runId).toMatch(/^\d{8}T\d{6}Z(-\d+)?$/);
    expect(data.run_dir).toBe(`ai-test-artifacts/runs/${runId}`);
    expect(data.login_path).toBe('/login');
    expect(data.tests.map((t: any) => t.id)).toEqual([
      'editor-creates-ticket',
      'short-title-rejected',
      'viewer-cannot-create',
    ]);
    expect(data.tests[0].steps[2]).toMatchObject({ index: 2, action: 'select' });
    expect(existsSync(join(workspace, data.run_dir, 'screenshots'))).toBe(true);
    expect(existsSync(join(workspace, data.run_dir, 'run-state.json'))).toBe(true);
  });

  it('gives runs in the same second distinct ids', async () => {
    const workspace = fixture();
    const first = await begin(workspace);
    const second = await begin(workspace);
    expect(second.runId).not.toBe(first.runId);
  });

  it('runs a subset of tests', async () => {
    const { data } = await begin(fixture(), { test_ids: ['viewer-cannot-create'] });
    expect(data.tests).toHaveLength(1);
  });

  it.each([
    [{ story: 'missing' }, /no plan at ai-test-artifacts\/plans\/missing\/tests\.json/],
    [{ story: '../escape' }, /must be lowercase/],
    [{ story: 'create-ticket', test_ids: ['nope'] }, /plan has no tests: nope/],
  ])('refuses %j', async (args, message) => {
    const client = await connect(fixture());
    await call(client, 'approve_plan', { story: 'create-ticket' });
    const { isError, data } = await call(client, 'begin_run', args);
    expect(isError).toBe(true);
    expect(data.error).toMatch(message);
  });

  it('refuses a plan that fails the schema or names an unknown persona', async () => {
    const plan = JSON.parse(PLAN);
    plan.tests[0].persona = 'superuser';
    const client = await connect(fixture(JSON.stringify(plan)));
    const { data } = await call(client, 'begin_run', { story: 'create-ticket' });
    expect(data.error).toMatch(/unknown persona "superuser"/);

    delete plan.tests[0].steps;
    const client2 = await connect(fixture(JSON.stringify(plan)));
    const second = await call(client2, 'begin_run', { story: 'create-ticket' });
    expect(second.data.error).toMatch(/missing required property "steps"/);
  });
});

describe('record_step', () => {
  it('copies a screenshot by path and by base64 into the run', async () => {
    const workspace = fixture();
    const { client, runId, data } = await begin(workspace);
    const byPath = await call(client, 'record_step', {
      run_id: runId,
      test_id: 'editor-creates-ticket',
      index: 0,
      status: 'passed',
      screenshot: { path: join(workspace, 'shot.png') },
    });
    expect(byPath.data.recorded.screenshot).toBe('screenshots/editor-creates-ticket/1-00.png');
    const byData = await call(client, 'record_step', {
      run_id: runId,
      test_id: 'editor-creates-ticket',
      index: 1,
      status: 'passed',
      screenshot: { data_base64: `data:image/png;base64,${PNG.toString('base64')}` },
    });
    expect(byData.data.recorded.screenshot).toBe('screenshots/editor-creates-ticket/1-01.png');
    expect(
      readFileSync(join(workspace, data.run_dir, 'screenshots/editor-creates-ticket/1-01.png')),
    ).toEqual(PNG);
  });

  it.each([
    [{ index: 99 }, /has no step 99/],
    [{ test_id: 'other' }, /has no test "other"/],
    [{ screenshot: { path: 'shot.png' } }, /must be absolute/],
    [{ screenshot: { data_base64: Buffer.from('hello').toString('base64') } }, /PNG, JPEG or WebP/],
  ])('refuses %j', async (override, message) => {
    const workspace = fixture();
    const { client, runId } = await begin(workspace);
    const { isError, data } = await call(client, 'record_step', {
      run_id: runId,
      test_id: 'editor-creates-ticket',
      index: 0,
      status: 'passed',
      ...override,
    });
    expect(isError).toBe(true);
    expect(data.error).toMatch(message);
  });

  it('refuses a non-image file even with an image extension', async () => {
    const workspace = fixture();
    writeFileSync(join(workspace, 'fake.png'), 'PRIVATE KEY');
    const { client, runId } = await begin(workspace);
    const { data } = await call(client, 'record_step', {
      run_id: runId,
      test_id: 'editor-creates-ticket',
      index: 0,
      status: 'passed',
      screenshot: { path: join(workspace, 'fake.png') },
    });
    expect(data.error).toMatch(/PNG, JPEG or WebP/);
  });

  it('refuses an unknown run id and path-like run ids', async () => {
    const client = await connect(fixture());
    for (const runId of ['20990101T000000Z', '../../etc']) {
      const { isError } = await call(client, 'record_step', {
        run_id: runId,
        test_id: 'editor-creates-ticket',
        index: 0,
        status: 'passed',
      });
      expect(isError).toBe(true);
    }
  });
});

describe('write_results', () => {
  it('computes statuses, failures and quality, and writes valid results.json', async () => {
    const workspace = fixture();
    const { client, runId, data } = await begin(workspace);
    const record = (test_id: string, index: number, status: string, extra = {}) =>
      call(client, 'record_step', {
        run_id: runId,
        test_id,
        index,
        status,
        duration_ms: 100,
        ...extra,
      });

    for (let i = 0; i < 6; i++) await record('editor-creates-ticket', i, 'passed');
    await record('short-title-rejected', 0, 'passed');
    await record('short-title-rejected', 1, 'passed');
    await record('short-title-rejected', 2, 'failed', {
      expected: 'A validation message',
      actual: 'Nothing happened',
      error: 'No message appeared',
      screenshot: { path: join(workspace, 'shot.png') },
    });
    await record('short-title-rejected', 3, 'skipped');
    // Retry of the failed test that passes: attempts 2, consistency 0.5.
    for (let i = 0; i < 4; i++) await record('short-title-rejected', i, 'passed', { attempt: 2 });

    await call(client, 'capture_env_state', {
      persona: 'editor',
      run_id: runId,
      observed: { role: 'editor', settings: { theme: 'light' } },
    });

    const written = await call(client, 'write_results', { run_id: runId });
    expect(written.isError, JSON.stringify(written.data)).toBe(false);
    expect(written.data.summary).toMatchObject({ total: 3, passed: 2, failed: 0, skipped: 1 });

    const results = JSON.parse(readFileSync(join(workspace, data.run_dir, 'results.json'), 'utf8'));
    expect(validate('results', results).ok).toBe(true);
    const byId = Object.fromEntries(results.tests.map((t: any) => [t.test_id, t]));
    expect(byId['editor-creates-ticket']).toMatchObject({
      status: 'passed',
      attempts: 1,
      duration_ms: 600,
      env_state: { persona: 'editor', role: 'editor', settings: { theme: 'light' } },
      quality: { selector_stability: 'medium', rerun_consistency: 1 },
    });
    expect(byId['short-title-rejected']).toMatchObject({
      status: 'passed',
      attempts: 2,
      quality: { rerun_consistency: 0.5 },
    });
    expect(byId['viewer-cannot-create']).toMatchObject({
      status: 'skipped',
      steps: [],
      env_state: { persona: 'viewer', seed_profile: 'default' },
    });
    expect(results.environment).toMatchObject({
      app_url: 'http://127.0.0.1:5173',
      host: 'claude-code',
    });
    expect(existsSync(join(workspace, data.run_dir, 'env-state.json'))).toBe(true);
  });

  it('reports the failed step with its screenshot, and unfinished tests as errors', async () => {
    const workspace = fixture();
    const { client, runId } = await begin(workspace);
    await call(client, 'record_step', {
      run_id: runId,
      test_id: 'short-title-rejected',
      index: 0,
      status: 'failed',
      expected: 'Form opens',
      actual: '404 page',
      screenshot: { path: join(workspace, 'shot.png') },
    });
    await call(client, 'record_step', {
      run_id: runId,
      test_id: 'viewer-cannot-create',
      index: 0,
      status: 'passed',
    });
    const { data } = await call(client, 'write_results', { run_id: runId });
    const byId = Object.fromEntries(data.tests.map((t: any) => [t.test_id, t]));
    expect(byId['short-title-rejected']).toEqual({
      test_id: 'short-title-rejected',
      status: 'failed',
      failure: {
        step_index: 0,
        message: '404 page',
        expected: 'Form opens',
        actual: '404 page',
        screenshot: 'screenshots/short-title-rejected/1-00.png',
      },
    });
    expect(byId['viewer-cannot-create']).toMatchObject({
      status: 'error',
      failure: { step_index: 1, message: 'The executor stopped before recording step 1.' },
    });
  });
});

describe('selectorStability', () => {
  const step = (target: object) => ({ action: 'click' as const, description: 'x', target });
  it.each([
    [
      [
        { strategy: 'testid', value: 'a' },
        { strategy: 'role', role: 'button' },
      ],
      'high',
    ],
    [
      [
        { strategy: 'testid', value: 'a' },
        { strategy: 'label', value: 'Title' },
      ],
      'medium',
    ],
    [
      [
        { strategy: 'label', value: 'Title' },
        { strategy: 'css', value: '.x' },
      ],
      'low',
    ],
    [[{ strategy: 'text', value: 'Save' }], 'low'],
  ])('%j -> %s', (targets, expected) => {
    const test = {
      id: 't',
      name: 't',
      intent: 't',
      persona: 'p',
      preconditions: { seed_profile: 'default' },
      steps: targets.map(step),
    };
    expect(selectorStability(test as any)).toBe(expected);
  });
});

describe('overlaps', () => {
  const t = (id: string, values: string[]) => ({
    id,
    name: id,
    intent: id,
    persona: 'p',
    preconditions: { seed_profile: 'default' },
    steps: values.map((value) => ({
      action: 'click' as const,
      description: value,
      target: { strategy: 'testid' as const, value },
    })),
  });

  it('links tests whose steps mostly match, in both directions', () => {
    const result = overlaps([
      t('a', ['1', '2', '3', '4', '5']),
      t('b', ['1', '2', '3', '4', '5']),
      t('c', ['1', '9']),
    ] as any);
    expect(result.get('a')).toEqual(['b']);
    expect(result.get('b')).toEqual(['a']);
    expect(result.get('c')).toEqual([]);
  });

  it('never links tests for different personas', () => {
    const a = t('a', ['1', '2']);
    const b = { ...t('b', ['1', '2']), persona: 'other' };
    expect(overlaps([a, b] as any).get('a')).toEqual([]);
  });

  it('ignores step descriptions when comparing', () => {
    const a = t('a', ['1', '2']);
    const b = t('b', ['1', '2']);
    const [first] = b.steps;
    if (first) first.description = 'worded differently';
    expect(overlaps([a, b] as any).get('a')).toEqual(['b']);
  });
});
