import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { planHash } from '../src/plans/plans.js';
import { SCHEMAS_DIR } from '../src/schemas/index.js';
import { call, connect, tempWorkspace } from './helpers.js';

const PLAN = JSON.parse(readFileSync(new URL('examples/tests.example.json', SCHEMAS_DIR), 'utf8'));

function fixture() {
  return tempWorkspace({
    '.tessa/config.yaml': stringify({
      version: 1,
      app: { start: 'npm run dev', url: 'http://127.0.0.1:5173', stack: 'react-router' },
      db: { allowed_hosts: ['127.0.0.1'], profiles: { default: ['seed.sql'] } },
      auth: { mode: 'manual' },
      personas: [
        { name: 'viewer', seed_profile: 'default' },
        { name: 'editor', seed_profile: 'default' },
      ],
    }),
    'seed.sql': '',
  });
}

const planFile = (workspace: string) =>
  join(workspace, 'ai-test-artifacts', 'plans', 'create-ticket', 'tests.json');

describe('save_plan', () => {
  it('writes tests.json and a readable plan.md', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    const { isError, data } = await call(client, 'save_plan', { plan: PLAN });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({
      story_id: 'create-ticket',
      plan_path: 'ai-test-artifacts/plans/create-ticket/tests.json',
      tests: 3,
      warnings: [],
      approval: 'unapproved',
    });
    expect(JSON.parse(readFileSync(planFile(workspace), 'utf8'))).toEqual(PLAN);
    const md = readFileSync(join(workspace, data.markdown_path as string), 'utf8');
    expect(md).toContain('# Test plan: Editors can create tickets; viewers cannot');
    expect(md).toContain(
      '| ac-1 | An editor can create a ticket with a title and priority. | `editor-creates-ticket` |',
    );
    expect(md).toContain('persona **viewer**');
    expect(md).toMatch(/1\. Click New ticket _\(click testid `create-ticket`\)_/);
  });

  it('warns about uncovered criteria, missing asserts and CSS selectors', async () => {
    const plan = structuredClone(PLAN);
    plan.story.acceptance_criteria.push({ id: 'ac-4', text: 'Nobody covers this.' });
    plan.tests[0].steps = [
      { action: 'click', description: 'Click', target: { strategy: 'css', value: '.btn' } },
    ];
    const workspace = fixture();
    const client = await connect(workspace);
    const { data } = await call(client, 'save_plan', { plan });
    const messages = data.warnings.map((w: any) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'acceptance criterion ac-4 is not covered by any test',
        'test "editor-creates-ticket" has no assert step',
        'test "editor-creates-ticket" step 1 uses a CSS selector, which is fragile',
      ]),
    );
    expect(readFileSync(join(workspace, data.markdown_path as string), 'utf8')).toContain(
      '## Check before approving',
    );
  });

  it.each([
    [(p: any) => (p.tests[0].persona = 'root'), /unknown persona "root"/],
    [(p: any) => (p.tests[0].preconditions.seed_profile = 'big'), /unknown seed profile "big"/],
    [(p: any) => (p.tests[0].criteria = ['ac-9']), /unknown acceptance criterion "ac-9"/],
    [(p: any) => (p.tests[1].id = p.tests[0].id), /two tests with id/],
    [(p: any) => (p.story.id = '../../etc'), /test-ir\.schema\.json/],
    [(p: any) => delete p.tests[0].intent, /missing required property "intent"/],
  ])('refuses an invalid plan (%#)', async (mutate, message) => {
    const plan = structuredClone(PLAN);
    mutate(plan);
    const client = await connect(fixture());
    const { isError, data } = await call(client, 'save_plan', { plan });
    expect(isError).toBe(true);
    expect(data.error).toMatch(message);
  });

  it('escapes Markdown from story text in plan.md', async () => {
    const plan = structuredClone(PLAN);
    plan.story.title = 'Title with <img src=x> and `code` | pipe';
    const workspace = fixture();
    const client = await connect(workspace);
    const { data } = await call(client, 'save_plan', { plan });
    const md = readFileSync(join(workspace, data.markdown_path as string), 'utf8');
    expect(md).toContain('# Test plan: Title with \\<img src=x\\> and \\`code\\` \\| pipe');
  });
});

describe('plan approval gate', () => {
  it('blocks runs until the plan is approved, and again after it changes', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    await call(client, 'save_plan', { plan: PLAN });

    const blocked = await call(client, 'begin_run', { story: 'create-ticket' });
    expect(blocked.isError).toBe(true);
    expect(blocked.data.error).toMatch(/has not been approved/);
    expect((await call(client, 'plan_status', { story: 'create-ticket' })).data.approval).toBe(
      'unapproved',
    );

    const approved = await call(client, 'approve_plan', {
      story: 'create-ticket',
      note: 'looks good',
    });
    expect(approved.data.approval).toMatchObject({
      story_id: 'create-ticket',
      approved_via: 'chat',
      plan_sha256: planHash(readFileSync(planFile(workspace), 'utf8')),
    });
    expect((await call(client, 'begin_run', { story: 'create-ticket' })).isError).toBe(false);

    // A hand edit after approval makes it stale.
    const edited = structuredClone(PLAN);
    edited.tests[0].name = 'Renamed by hand';
    writeFileSync(planFile(workspace), JSON.stringify(edited, null, 2));
    expect((await call(client, 'plan_status', { story: 'create-ticket' })).data.approval).toBe(
      'stale',
    );
    const stale = await call(client, 'begin_run', { story: 'create-ticket' });
    expect(stale.data.error).toMatch(/changed after it was approved/);

    // Saving through save_plan reports the stale approval too.
    expect((await call(client, 'save_plan', { plan: edited })).data.approval).toBe('stale');
  });

  it('ignores line-ending differences when checking approval', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    await call(client, 'save_plan', { plan: PLAN });
    await call(client, 'approve_plan', { story: 'create-ticket' });
    writeFileSync(
      planFile(workspace),
      readFileSync(planFile(workspace), 'utf8').replaceAll('\n', '\r\n'),
    );
    expect((await call(client, 'plan_status', { story: 'create-ticket' })).data.approval).toBe(
      'approved',
    );
  });

  it('refuses to approve a plan that does not exist or is invalid', async () => {
    const workspace = fixture();
    const client = await connect(workspace);
    expect((await call(client, 'approve_plan', { story: 'nothing' })).isError).toBe(true);
    await call(client, 'save_plan', { plan: PLAN });
    writeFileSync(planFile(workspace), '{"version": 1}');
    expect((await call(client, 'approve_plan', { story: 'create-ticket' })).isError).toBe(true);
  });
});
