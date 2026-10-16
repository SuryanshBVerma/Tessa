import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { comment, fileName, fullUrlPattern, pascal, str } from '../src/export/emitters/common.js';
import { playwrightDotnet } from '../src/export/emitters/playwright-dotnet.js';
import { playwrightTs } from '../src/export/emitters/playwright-ts.js';
import { unifiedDiff } from '../src/export/handoff.js';
import { SCHEMAS_DIR } from '../src/schemas/index.js';
import { call, connect, tempWorkspace } from './helpers.js';

const PLAN = JSON.parse(readFileSync(new URL('examples/tests.example.json', SCHEMAS_DIR), 'utf8'));

/** A plan exercising every action, strategy and assertion kind. */
const KITCHEN_SINK = {
  version: 1,
  story: { id: 'all-kinds', title: 'All "kinds" of steps' },
  tests: [
    {
      id: 'every-step',
      name: 'Every step kind',
      intent: 'Covers each action and assertion.',
      persona: 'editor',
      preconditions: { seed_profile: 'default', start_path: '/start' },
      steps: [
        { action: 'navigate', description: 'Open', value: '/tickets?x=1' },
        {
          action: 'click',
          description: 'Role',
          target: { strategy: 'role', role: 'button', name: 'Save "it"', exact: true },
        },
        {
          action: 'fill',
          description: 'Label',
          target: { strategy: 'label', value: 'Title' },
          value: 'line1\nline2 "quoted"',
        },
        {
          action: 'fill',
          description: 'Secret',
          target: { strategy: 'placeholder', value: 'Token' },
          value_env: 'API_TOKEN',
        },
        {
          action: 'select',
          description: 'Text',
          target: { strategy: 'text', value: 'Pick' },
          value: 'b',
        },
        { action: 'check', description: 'Css', target: { strategy: 'css', value: '#agree' } },
        { action: 'uncheck', description: 'Uncheck', target: { strategy: 'testid', value: 'opt' } },
        {
          action: 'wait',
          description: 'Wait',
          target: { strategy: 'testid', value: 'spinner' },
          assertion: { kind: 'hidden' },
          timeout_ms: 5000,
        },
        {
          action: 'assert',
          description: 'Visible',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'visible' },
        },
        {
          action: 'assert',
          description: 'Enabled',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'enabled' },
        },
        {
          action: 'assert',
          description: 'Disabled',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'disabled' },
        },
        {
          action: 'assert',
          description: 'Checked',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'checked' },
        },
        {
          action: 'assert',
          description: 'Unchecked',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'unchecked' },
        },
        {
          action: 'assert',
          description: 'Text',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'text-equals', expected: 'x' },
        },
        {
          action: 'assert',
          description: 'Contains',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'text-contains', expected: 'y' },
        },
        {
          action: 'assert',
          description: 'Value',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'value-equals', expected: 'z' },
        },
        {
          action: 'assert',
          description: 'Count',
          target: { strategy: 'testid', value: 'a' },
          assertion: { kind: 'count-equals', expected: 0 },
        },
        {
          action: 'assert',
          description: 'Title',
          assertion: { kind: 'title-equals', expected: 'Home' },
        },
        {
          action: 'assert',
          description: 'Url */ end',
          assertion: { kind: 'url-matches', expected: '^/tickets/[0-9]+$' },
        },
      ],
    },
  ],
};

const input = (plan: any, naming?: string) => ({
  plan,
  tests: plan.tests,
  runId: '20261016T000000Z',
  appUrl: 'http://127.0.0.1:5173',
  conventions: naming === undefined ? {} : { naming },
});

describe('emitter helpers', () => {
  it('turns a path pattern into a full-URL pattern', () => {
    expect(fullUrlPattern('^/tickets/[0-9]+$')).toBe('^[a-z][a-z0-9+.-]*://[^/]+/tickets/[0-9]+$');
    expect(fullUrlPattern('/tickets')).toBe('/tickets');
    expect(
      new RegExp(fullUrlPattern('^/tickets/[0-9]+$')).test('http://127.0.0.1:5173/tickets/42'),
    ).toBe(true);
    expect(
      new RegExp(fullUrlPattern('^/tickets/[0-9]+$')).test('http://127.0.0.1:5173/tickets/new'),
    ).toBe(false);
  });

  it('names files from the naming convention', () => {
    expect(fileName('{feature}.{scenario}.spec', 'create-ticket', 'editor-creates', '.ts')).toBe(
      'create-ticket.editor-creates.spec.ts',
    );
    expect(fileName(undefined, 'create-ticket', null, '.ts')).toBe('create-ticket.spec.ts');
    expect(fileName('{feature}/../{scenario}', 'a', 'b', '.ts')).not.toContain('/');
    expect(pascal('editor-creates-ticket')).toBe('EditorCreatesTicket');
  });

  it('never lets plan text end a comment line or a string literal', () => {
    const payload = 'Process.Start("calc");';
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    const terminators = /[\r\n\u0085\u2028\u2029\u000b\u000c]/;
    for (const sep of ['\r', '\n', '\u0085', '\u2028', '\u2029', '\u000b', '\u000c']) {
      const hostile = `Open the page${sep}${payload}`;
      expect(comment(hostile)).not.toMatch(terminators);
      expect(str(hostile)).not.toMatch(terminators);
      expect(JSON.parse(str(hostile))).toBe(hostile);
    }
    const sink = structuredClone(KITCHEN_SINK);
    sink.story.title = `Title\u2028${payload}`;
    for (const test of sink.tests) {
      test.intent = `Intent\u2028${payload}`;
      for (const step of test.steps) step.description = `Step\u2029${payload}`;
    }
    for (const emitter of [playwrightTs, playwrightDotnet]) {
      for (const file of emitter.emit(input(sink))) {
        for (const line of file.content.split(/\r?\n/)) {
          if (!line.includes(payload)) continue;
          // The payload may only appear inside a comment or a string literal on its line.
          expect(line, `${emitter.target} ${file.path}`).toMatch(/^\s*(\/\/|#|\[|.*"[^"]*Process)/);
          expect(line).not.toMatch(/[\u0085\u2028\u2029]/);
        }
      }
    }
  });
});

describe('playwright-ts emitter', () => {
  const [spec, config, readme] = playwrightTs.emit(input(KITCHEN_SINK));
  const code = spec?.content ?? '';

  it('emits a spec, a standalone config and a README', () => {
    expect([spec?.path, config?.path, readme?.path]).toEqual([
      'all-kinds.spec.ts',
      'playwright.config.ts',
      'README.md',
    ]);
    expect(config?.content).toContain('baseURL: process.env.BASE_URL ?? "http://127.0.0.1:5173"');
  });

  it('maps every action, strategy and assertion', () => {
    for (const expected of [
      'await page.goto("/start");',
      'await page.goto("/tickets?x=1");',
      'await page.getByRole("button", { name: "Save \\"it\\"", exact: true }).click();',
      'await page.getByLabel("Title").fill("line1\\nline2 \\"quoted\\"");',
      'await page.getByPlaceholder("Token").fill(requireEnv("API_TOKEN"));',
      'await page.getByText("Pick").selectOption("b");',
      'await page.locator("#agree").check();',
      'await page.getByTestId("opt").uncheck();',
      'await expect(page.getByTestId("spinner")).toBeHidden({ timeout: 5000 });',
      'await expect(page.getByTestId("a")).toBeVisible();',
      'await expect(page.getByTestId("a")).toBeEnabled();',
      'await expect(page.getByTestId("a")).toBeDisabled();',
      'await expect(page.getByTestId("a")).toBeChecked();',
      'await expect(page.getByTestId("a")).not.toBeChecked();',
      'await expect(page.getByTestId("a")).toHaveText("x");',
      'await expect(page.getByTestId("a")).toContainText("y");',
      'await expect(page.getByTestId("a")).toHaveValue("z");',
      'await expect(page.getByTestId("a")).toHaveCount(0);',
      'await expect(page).toHaveTitle("Home");',
      'await expect(page).toHaveURL(new RegExp("^[a-z][a-z0-9+.-]*://[^/]+/tickets/[0-9]+$"));',
      'test.use({ storageState: process.env.TESSA_AUTH_EDITOR ?? ".auth/editor.json" });',
    ]) {
      expect(code).toContain(expected);
    }
  });

  it('wraps steps in test.step and tags tests', () => {
    expect(code).toContain('await test.step("Url */ end", async () => {');
    expect(code).toContain('tag: ["@all-kinds", "@editor"]');
    expect(code).toContain('{ type: \'seed-profile\', description: "default" }');
  });

  it('never writes secret values into the code', () => {
    expect(code).toContain('function requireEnv(name: string): string');
    expect(code).not.toMatch(/API_TOKEN"\s*\)\s*\?\?/);
  });

  it('writes one file per test when the naming has {scenario}', () => {
    const files = playwrightTs.emit(input(PLAN, '{feature}.{scenario}.spec')).map((f) => f.path);
    expect(files).toEqual([
      'create-ticket.editor-creates-ticket.spec.ts',
      'create-ticket.short-title-rejected.spec.ts',
      'create-ticket.viewer-cannot-create.spec.ts',
      'playwright.config.ts',
      'README.md',
    ]);
  });

  it('is deterministic', () => {
    expect(playwrightTs.emit(input(KITCHEN_SINK))).toEqual(playwrightTs.emit(input(KITCHEN_SINK)));
  });
});

describe('playwright-dotnet emitter', () => {
  const [cs, project] = playwrightDotnet.emit(input(KITCHEN_SINK));
  const code = cs?.content ?? '';

  it('emits a test class per persona and a project', () => {
    expect(cs?.path).toBe('AllKindsTests.cs');
    expect(code).toContain('public class AllKindsEditorTests : PageTest');
    expect(code).toContain(
      'StorageStatePath = Environment.GetEnvironmentVariable("TESSA_AUTH_EDITOR") ?? ".auth/editor.json",',
    );
    expect(project?.content).toContain(
      '<PackageReference Include="Microsoft.Playwright.NUnit" Version="1.63.0" />',
    );
  });

  it('maps every action, strategy and assertion', () => {
    for (const expected of [
      'await Page.GotoAsync("/start");',
      'await Page.GetByRole(AriaRole.Button, new() { Name = "Save \\"it\\"", Exact = true }).ClickAsync();',
      'await Page.GetByLabel("Title").FillAsync("line1\\nline2 \\"quoted\\"");',
      'await Page.GetByPlaceholder("Token").FillAsync(RequireEnv("API_TOKEN"));',
      'await Page.GetByText("Pick").SelectOptionAsync("b");',
      'await Page.Locator("#agree").CheckAsync();',
      'await Page.GetByTestId("opt").UncheckAsync();',
      'await Expect(Page.GetByTestId("spinner")).ToBeHiddenAsync(new() { Timeout = 5000 });',
      'await Expect(Page.GetByTestId("a")).Not.ToBeCheckedAsync();',
      'await Expect(Page.GetByTestId("a")).ToHaveCountAsync(0);',
      'await Expect(Page).ToHaveTitleAsync("Home");',
      'await Expect(Page).ToHaveURLAsync(new Regex("^[a-z][a-z0-9+.-]*://[^/]+/tickets/[0-9]+$"));',
      '[Property("SeedProfile", "default")]',
      'public async Task EveryStep()',
    ]) {
      expect(code).toContain(expected);
    }
  });

  it('keeps comment text from closing comments', () => {
    expect(code).toContain('// 19. Url * / end');
  });
});

/** A workspace with a finished run and a selection, ready to export. */
async function exportable() {
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
      export: { target: 'playwright-ts', conventions: { test_dir: 'tests/e2e' } },
    }),
    'seed.sql': '',
    'ai-test-artifacts/plans/create-ticket/tests.json': JSON.stringify(PLAN),
  });
  const client = await connect(workspace);
  await call(client, 'approve_plan', { story: 'create-ticket' });
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
    actual: 'x',
  });
  await call(client, 'write_results', { run_id: runId });
  await call(client, 'record_selection', {
    run_id: runId,
    selected_test_ids: ['viewer-cannot-create', 'short-title-rejected'],
  });
  return { workspace, client, runId };
}

describe('emit_tests', () => {
  it('emits the selection, writes a manifest, and warns about tests that did not pass', async () => {
    const { workspace, client, runId } = await exportable();
    const { isError, data } = await call(client, 'emit_tests', { run_id: runId });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({
      target: 'playwright-ts',
      export_dir: 'ai-test-artifacts/export/playwright-ts/create-ticket',
      tests: ['short-title-rejected', 'viewer-cannot-create'],
    });
    expect(data.warnings[0]).toMatch(/short-title-rejected did not pass/);
    const dir = join(workspace, data.export_dir as string);
    const spec = readFileSync(join(dir, 'create-ticket.spec.ts'), 'utf8');
    expect(spec).toContain('as viewer');
    expect(spec).not.toContain('editor-creates-ticket');
    expect(
      JSON.parse(readFileSync(join(dir, 'export-manifest.json'), 'utf8')).files.find(
        (f: any) => f.handoff,
      ).path,
    ).toBe('create-ticket.spec.ts');
  });

  it('needs a selection, and refuses targets without an emitter', async () => {
    const { client, runId } = await exportable();
    expect(
      (await call(client, 'emit_tests', { run_id: runId, target: 'cypress-ts' })).data.error,
    ).toMatch(/no emitter for "cypress-ts" yet/);
  });

  it('emits C# for playwright-dotnet', async () => {
    const { workspace, client, runId } = await exportable();
    const { data } = await call(client, 'emit_tests', {
      run_id: runId,
      target: 'playwright-dotnet',
    });
    expect(existsSync(join(workspace, data.export_dir as string, 'CreateTicketTests.cs'))).toBe(
      true,
    );
  });
});

describe('update_export_file', () => {
  it('edits inside the export folder only', async () => {
    const { client, runId } = await exportable();
    await call(client, 'emit_tests', { run_id: runId });
    const ok = await call(client, 'update_export_file', {
      story: 'create-ticket',
      target: 'playwright-ts',
      path: 'pages/TicketPage.ts',
      content: 'export {};',
    });
    expect(ok.data).toMatchObject({ ok: true, handoff: false });
    for (const path of ['../../../../.tessa/config.yaml', 'evil.sh', '/abs/x.ts']) {
      const bad = await call(client, 'update_export_file', {
        story: 'create-ticket',
        target: 'playwright-ts',
        path,
        content: 'x',
      });
      expect(bad.isError, path).toBe(true);
    }
  });

  it('refuses project and runner files, which validate_export would obey', async () => {
    const { client, runId } = await exportable();
    await call(client, 'emit_tests', { run_id: runId });
    for (const path of [
      'playwright.config.ts',
      'sub/playwright.config.mjs',
      'tsconfig.json',
      'package.json',
      'Tessa.Generated.csproj',
      'Directory.Build.props',
      'nuget.config',
    ]) {
      const bad = await call(client, 'update_export_file', {
        story: 'create-ticket',
        target: 'playwright-ts',
        path,
        content: '{}',
      });
      expect(bad.isError, path).toBe(true);
    }
  });
});

describe('handoff', () => {
  it('proposes a diff, writes nothing, and applies only the confirmed proposal', async () => {
    const { workspace, client, runId } = await exportable();
    await call(client, 'emit_tests', { run_id: runId });
    const proposal = await call(client, 'propose_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
    });
    expect(proposal.data.changes).toEqual([
      {
        from: 'ai-test-artifacts/export/playwright-ts/create-ticket/create-ticket.spec.ts',
        to: 'tests/e2e/create-ticket.spec.ts',
        action: 'create',
        lines: expect.any(Number),
      },
    ]);
    expect(proposal.data.truncated).toBe(false);
    expect(proposal.data.diff).toContain('+++ b/tests/e2e/create-ticket.spec.ts');
    const dest = join(workspace, 'tests', 'e2e', 'create-ticket.spec.ts');
    expect(existsSync(dest)).toBe(false);

    // Something changes between proposal and confirmation: the old id is refused.
    await call(client, 'update_export_file', {
      story: 'create-ticket',
      target: 'playwright-ts',
      path: 'create-ticket.spec.ts',
      content: '// changed\n',
    });
    const stale = await call(client, 'apply_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
      proposal_id: proposal.data.proposal_id,
    });
    expect(stale.data.error).toMatch(/changed since that proposal/);
    expect(existsSync(dest)).toBe(false);

    const fresh = await call(client, 'propose_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
    });
    const applied = await call(client, 'apply_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
      proposal_id: fresh.data.proposal_id,
    });
    expect(applied.data.written).toEqual(['tests/e2e/create-ticket.spec.ts']);
    expect(readFileSync(dest, 'utf8')).toBe('// changed\n');

    const again = await call(client, 'propose_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
    });
    expect(again.data.changes[0].action).toBe('unchanged');

    writeFileSync(dest, '// edited in the repo\n');
    const modify = await call(client, 'propose_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
    });
    expect(modify.data.changes[0].action).toBe('modify');
    expect(modify.data.diff).toContain('-// edited in the repo');
  });

  it('diffs lines', () => {
    expect(unifiedDiff('x.ts', 'a\nb\nc', 'a\nB\nc')).toBe(
      '--- a/x.ts\n+++ b/x.ts\n a\n+B\n-b\n c\n',
    );
    expect(unifiedDiff('x.ts', null, 'new')).toBe('--- /dev/null\n+++ b/x.ts\n+new\n');
  });
});

describe('handoff destinations', () => {
  it('refuses control folders as the test folder', async () => {
    const { workspace, client, runId } = await exportable();
    await call(client, 'emit_tests', { run_id: runId });
    const configFile = join(workspace, '.tessa', 'config.yaml');
    for (const dir of [
      '.github/workflows',
      '.git/hooks',
      'tests/node_modules/x',
      '.claude/agents',
    ]) {
      const config = readFileSync(configFile, 'utf8').replace(/test_dir: .*/, `test_dir: ${dir}`);
      writeFileSync(configFile, config);
      const proposal = await call(client, 'propose_handoff', {
        story: 'create-ticket',
        target: 'playwright-ts',
      });
      expect(proposal.isError, dir).toBe(true);
      expect(proposal.data.error).toMatch(/refusing to hand off into/);
    }
  });

  it('hands off only test files, whatever the manifest says', async () => {
    const { workspace, client, runId } = await exportable();
    await call(client, 'emit_tests', { run_id: runId });
    const manifestFile = join(
      workspace,
      'ai-test-artifacts/export/playwright-ts/create-ticket/export-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const file of manifest.files) file.handoff = true;
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const proposal = await call(client, 'propose_handoff', {
      story: 'create-ticket',
      target: 'playwright-ts',
    });
    expect(proposal.data.changes.map((c: { to: string }) => c.to)).toEqual([
      'tests/e2e/create-ticket.spec.ts',
    ]);
  });
});

describe('validate_export without Playwright installed', () => {
  it('says what to install instead of failing obscurely', async () => {
    const { client, runId } = await exportable();
    await call(client, 'emit_tests', { run_id: runId });
    const { data } = await call(client, 'validate_export', {
      story: 'create-ticket',
      target: 'playwright-ts',
      run_once: false,
    });
    expect(data.compiled).toBe(false);
    expect(data.compile_errors[0]).toMatch(/@playwright\/test is not installed/);
  });
});
