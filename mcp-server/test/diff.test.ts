import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { renderDiffHtml } from '../src/report/diff.js';
import { changedFiles, classify, diffRuns } from '../src/runs/diff.js';
import { SCHEMAS_DIR, validate } from '../src/schemas/index.js';
import { call, connect, tempWorkspace } from './helpers.js';

const PLAN = readFileSync(new URL('examples/tests.example.json', SCHEMAS_DIR), 'utf8');

type Status = 'passed' | 'failed' | 'skipped' | 'error';

function results(runId: string, statuses: Record<string, Status>, extra: object = {}) {
  return {
    version: 1 as const,
    run_id: runId,
    story_id: 'create-ticket',
    plan: 'plans/create-ticket/tests.json',
    started_at: '2026-10-16T10:00:00Z',
    finished_at: '2026-10-16T10:05:00Z',
    environment: { app_url: 'http://127.0.0.1:5173', host: 'claude-code' as const },
    tests: Object.entries(statuses).map(([test_id, status]) => ({
      test_id,
      status,
      attempts: 1,
      duration_ms: 1000,
      env_state: { persona: 'editor', seed_profile: 'default' },
      steps: [],
      ...(status === 'failed' || status === 'error'
        ? { failure: { step_index: 2, message: `${test_id} <b>broke</b>` } }
        : {}),
    })),
    ...extra,
  };
}

describe('classify', () => {
  it.each([
    ['passed', 'passed', 'still-passing'],
    ['failed', 'error', 'still-failing'],
    ['error', 'passed', 'fixed'],
    ['passed', 'failed', 'regressed'],
    ['passed', 'skipped', 'changed-other'],
    ['skipped', 'skipped', 'changed-other'],
    [undefined, 'passed', 'added'],
    ['failed', undefined, 'removed'],
  ] as const)('%s to %s is %s', (a, b, change) => {
    expect(classify(a, b)).toBe(change);
  });
});

describe('diffRuns', () => {
  it('counts every kind of change and matches the schema', () => {
    const a = results('20261016T100000Z', {
      one: 'passed',
      two: 'failed',
      three: 'passed',
      gone: 'passed',
    });
    const b = results('20261016T110000Z', {
      one: 'passed',
      two: 'passed',
      three: 'failed',
      fresh: 'skipped',
    });
    const first = b.tests[0];
    if (first) first.duration_ms = 1500;
    const diff = diffRuns({ a, b, changedFiles: ['app/routes/tickets.new.tsx'] });
    expect(validate('run-diff', diff).ok).toBe(true);
    expect(diff.summary).toEqual({
      fixed: 1,
      regressed: 1,
      still_failing: 0,
      still_passing: 1,
      added: 1,
      removed: 1,
      changed_other: 0,
    });
    expect(diff.tests.map((t) => [t.test_id, t.change])).toEqual([
      ['one', 'still-passing'],
      ['two', 'fixed'],
      ['three', 'regressed'],
      ['gone', 'removed'],
      ['fresh', 'added'],
    ]);
    expect(diff.tests[0]).toMatchObject({ duration_delta_ms: 500 });
    expect(diff.tests[2]).toMatchObject({ failing_step_b: 2 });
    expect(diff.changed_files).toEqual(['app/routes/tickets.new.tsx']);
  });

  it('leaves out tests a rerun did not repeat', () => {
    const a = results('20261016T100000Z', { one: 'passed', two: 'failed' });
    const b = results('20261016T110000Z', { two: 'passed' }, { rerun_of: '20261016T100000Z' });
    const diff = diffRuns({ a, b });
    expect(diff.rerun_only).toBe(true);
    expect(diff.tests.map((t) => t.change)).toEqual(['fixed']);
  });

  it('refuses runs of different stories and a run compared with itself', () => {
    const a = results('20261016T100000Z', { one: 'passed' });
    const other = { ...a, run_id: '20261016T110000Z', story_id: 'other' };
    expect(() => diffRuns({ a, b: other })).toThrow(/same story/);
    expect(() => diffRuns({ a, b: a })).toThrow(/two different runs/);
  });
});

describe('changedFiles', () => {
  it('lists files changed between commits, leaving out the artifacts root', async () => {
    const repo = tempWorkspace({ 'app/a.ts': '1', 'ai-test-artifacts/plans/p.json': '1' });
    // Identity through the environment, so no Git config is written.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'app', 'a.ts'), '2');
    writeFileSync(join(repo, 'ai-test-artifacts', 'plans', 'p.json'), '2');
    git('commit', '-q', '-am', 'two');
    const second = git('rev-parse', 'HEAD');
    expect(await changedFiles(repo, first, second, 'ai-test-artifacts')).toEqual(['app/a.ts']);
    expect(await changedFiles(repo, first, second)).toEqual([
      'ai-test-artifacts/plans/p.json',
      'app/a.ts',
    ]);
    expect(await changedFiles(repo, first, 'abcdef1')).toBeUndefined();
  });
});

describe('renderDiffHtml', () => {
  it('escapes content from the runs and allows no script', () => {
    const a = results('20261016T100000Z', { one: 'passed' });
    const b = results('20261016T110000Z', { one: 'failed' });
    const diff = diffRuns({ a, b, changedFiles: ['<img src=x onerror=alert(1)>.ts'] });
    const html = renderDiffHtml({ diff, a, b, plan: null });
    expect(html).toContain('one &lt;b&gt;broke&lt;/b&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/default-src 'none'/);
    expect(html).toContain('Regressed');
  });
});

function fixture() {
  return tempWorkspace({
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
    'ai-test-artifacts/plans/create-ticket/tests.json': PLAN,
  });
}

/** Two complete runs of viewer-cannot-create: the first passes, the second fails at step 0. */
async function passThenFail(client: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
  await call(client, 'approve_plan', { story: 'create-ticket' });
  const ids: string[] = [];
  for (const status of ['passed', 'failed'] as const) {
    const begun = await call(client, 'begin_run', {
      story: 'create-ticket',
      test_ids: ['viewer-cannot-create'],
    });
    const runId = begun.data.run_id as string;
    const steps = begun.data.tests[0].steps.length as number;
    for (let i = 0; i < steps; i++) {
      await call(client, 'record_step', {
        run_id: runId,
        test_id: 'viewer-cannot-create',
        index: i,
        status: status === 'passed' ? 'passed' : i === 0 ? 'failed' : 'skipped',
      });
    }
    await call(client, 'write_results', { run_id: runId });
    ids.push(runId);
  }
  return ids;
}

describe('diff_runs', () => {
  it('writes JSON and HTML, and defaults to the newest run against the one before', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    const ids = await passThenFail(client);
    const { isError, data } = await call(client, 'diff_runs', {});
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({ run_a: ids[0], run_b: ids[1], summary: { regressed: 1 } });
    expect(data.changed).toEqual([
      expect.objectContaining({ test_id: 'viewer-cannot-create', change: 'regressed' }),
    ]);
    const json = JSON.parse(readFileSync(join(workspace, data.json_path), 'utf8'));
    expect(validate('run-diff', json).ok).toBe(true);
    expect(existsSync(join(workspace, data.html_path))).toBe(true);

    const reversed = await call(client, 'diff_runs', { run_a: ids[1], run_b: ids[0] });
    expect(reversed.data.summary).toMatchObject({ fixed: 1 });

    const alone = await call(client, 'diff_runs', { run_b: ids[0] });
    expect(alone.isError).toBe(true);
    expect(alone.data.error).toMatch(/no complete run of "create-ticket" before/);
  });
});

describe('triage', () => {
  const finding = {
    class: 'app-bug',
    rationale: 'The New ticket link is shown to viewers.',
    confidence: 'high',
    evidence: ['step 1 actual: link visible'],
  };

  it('stores a finding in results.json, keeps it through write_results, and renders it', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    const [, failed = ''] = await passThenFail(client);
    await call(client, 'render_report', { run_id: failed });
    const recorded = await call(client, 'record_triage', {
      run_id: failed,
      test_id: 'viewer-cannot-create',
      ...finding,
    });
    expect(recorded.isError, JSON.stringify(recorded.data)).toBe(false);
    expect(recorded.data.report).toBe(`ai-test-artifacts/runs/${failed}/report.html`);

    await call(client, 'write_results', { run_id: failed });
    const results = JSON.parse(
      readFileSync(join(workspace, 'ai-test-artifacts', 'runs', failed, 'results.json'), 'utf8'),
    );
    expect(results.tests[0].triage).toEqual(finding);
    const listed = await call(client, 'failed_test_ids', { run_id: failed });
    expect(listed.data.failed[0].triage).toEqual(finding);
  });

  it('refuses triage for a clean pass, an unknown test, or a run without results', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    const [passed] = await passThenFail(client);
    const clean = await call(client, 'record_triage', {
      run_id: passed,
      test_id: 'viewer-cannot-create',
      ...finding,
    });
    expect(clean.data.error).toMatch(/passed on its first attempt/);
    const unknown = await call(client, 'record_triage', {
      run_id: passed,
      test_id: 'nope',
      ...finding,
    });
    expect(unknown.data.error).toMatch(/has no test "nope"/);
    const begun = await call(client, 'begin_run', { story: 'create-ticket' });
    const early = await call(client, 'record_triage', {
      run_id: begun.data.run_id,
      test_id: 'viewer-cannot-create',
      ...finding,
    });
    expect(early.data.error).toMatch(/no results\.json yet/);
  });

  it('annotates a diff, keeps notes when the diff is rebuilt, and removes empty notes', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    const [a, b] = await passThenFail(client);
    const diffed = await call(client, 'diff_runs', { run_a: a, run_b: b });
    const missing = await call(client, 'annotate_diff', {
      run_a: b,
      run_b: a,
      notes: [{ test_id: 'viewer-cannot-create', note: 'x' }],
    });
    expect(missing.data.error).toMatch(/call diff_runs first/);
    const wrong = await call(client, 'annotate_diff', {
      run_a: a,
      run_b: b,
      notes: [{ test_id: 'nope', note: 'x' }],
    });
    expect(wrong.data.error).toMatch(/has no tests: nope/);

    const note = 'The viewer guard was removed from the new-ticket route <script>.';
    const annotated = await call(client, 'annotate_diff', {
      run_a: a,
      run_b: b,
      notes: [{ test_id: 'viewer-cannot-create', note }],
    });
    expect(annotated.isError, JSON.stringify(annotated.data)).toBe(false);
    const readJson = () => JSON.parse(readFileSync(join(workspace, diffed.data.json_path), 'utf8'));
    expect(readJson().tests[0].notes).toBe(note);
    const html = readFileSync(join(workspace, diffed.data.html_path), 'utf8');
    expect(html).toContain('route &lt;script&gt;.');

    await call(client, 'diff_runs', { run_a: a, run_b: b });
    expect(readJson().tests[0].notes).toBe(note);

    await call(client, 'annotate_diff', {
      run_a: a,
      run_b: b,
      notes: [{ test_id: 'viewer-cannot-create', note: ' ' }],
    });
    expect(readJson().tests[0].notes).toBeUndefined();
  });
});
