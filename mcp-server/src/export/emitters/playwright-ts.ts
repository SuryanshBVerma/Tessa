// Test IR -> Playwright Test (TypeScript). Deterministic: the same plan always gives the same code.
import type { Plan } from '../../schemas/generated/index.js';
import {
  authDefault,
  authEnv,
  comment,
  fileName,
  fullUrlPattern,
  header,
  str,
  type EmitInput,
  type EmittedFile,
  type Emitter,
} from './common.js';

export const PLAYWRIGHT_TS_VERSION = '1.52.0';

function locator(target: Plan.Target): string {
  const exact = target.exact === true ? ', { exact: true }' : '';
  switch (target.strategy) {
    case 'testid':
      return `page.getByTestId(${str(target.value)})`;
    case 'role': {
      const options = [
        target.name === undefined ? null : `name: ${str(target.name)}`,
        target.exact === true ? 'exact: true' : null,
      ].filter((o) => o !== null);
      return `page.getByRole(${str(target.role)}${options.length > 0 ? `, { ${options.join(', ')} }` : ''})`;
    }
    case 'label':
      return `page.getByLabel(${str(target.value)}${exact})`;
    case 'placeholder':
      return `page.getByPlaceholder(${str(target.value)}${exact})`;
    case 'text':
      return `page.getByText(${str(target.value)}${exact})`;
    case 'css':
      return `page.locator(${str(target.value)})`;
  }
}

function timeout(step: Plan.Step): string {
  return step.timeout_ms === undefined ? '' : `{ timeout: ${String(step.timeout_ms)} }`;
}

function withTimeout(args: string, step: Plan.Step): string {
  const t = timeout(step);
  return [args, t].filter((a) => a !== '').join(', ');
}

function value(step: Plan.Step): string {
  return step.value_env !== undefined
    ? `requireEnv(${str(step.value_env)})`
    : str(step.value ?? '');
}

function assertion(step: Plan.Step, assert: Plan.Assertion): string {
  const target = step.target === undefined ? null : locator(step.target);
  const t = timeout(step);
  const on = (matcher: string, arg?: string) =>
    `await expect(${target ?? 'page'}).${matcher}(${withTimeout(arg ?? '', step)});`;
  switch (assert.kind) {
    case 'visible':
      return on('toBeVisible');
    case 'hidden':
      return on('toBeHidden');
    case 'enabled':
      return on('toBeEnabled');
    case 'disabled':
      return on('toBeDisabled');
    case 'checked':
      return on('toBeChecked');
    case 'unchecked':
      return on('not.toBeChecked');
    case 'text-equals':
      return on('toHaveText', str(assert.expected));
    case 'text-contains':
      return on('toContainText', str(assert.expected));
    case 'value-equals':
      return on('toHaveValue', str(assert.expected));
    case 'count-equals':
      return on('toHaveCount', String(assert.expected));
    case 'title-equals':
      return `await expect(page).toHaveTitle(${withTimeout(str(assert.expected), step)});`;
    case 'url-matches':
      return `await expect(page).toHaveURL(new RegExp(${str(fullUrlPattern(assert.expected))})${t === '' ? '' : `, ${t}`});`;
  }
}

function stepCode(step: Plan.Step): string[] {
  const target = step.target === undefined ? null : locator(step.target);
  switch (step.action) {
    case 'navigate':
      return [`await page.goto(${str(step.value ?? '/')});`];
    case 'click':
      return [`await ${target ?? 'page'}.click(${timeout(step)});`];
    case 'fill':
      return [`await ${target ?? 'page'}.fill(${withTimeout(value(step), step)});`];
    case 'select':
      return [`await ${target ?? 'page'}.selectOption(${withTimeout(value(step), step)});`];
    case 'check':
      return [`await ${target ?? 'page'}.check(${timeout(step)});`];
    case 'uncheck':
      return [`await ${target ?? 'page'}.uncheck(${timeout(step)});`];
    case 'wait':
      return step.assertion !== undefined
        ? [assertion(step, step.assertion)]
        : [`await expect(${target ?? 'page'}).toBeVisible(${timeout(step)});`];
    case 'assert':
      return step.assertion === undefined ? [] : [assertion(step, step.assertion)];
  }
}

function testCode(test: Plan.Test, storyId: string): string[] {
  const details = [
    `tag: [${[storyId, test.persona, ...(test.tags ?? [])].map((t) => str(`@${t}`)).join(', ')}]`,
    `annotation: [${[
      `{ type: 'intent', description: ${str(test.intent)} }`,
      `{ type: 'seed-profile', description: ${str(test.preconditions.seed_profile)} }`,
      ...(test.criteria ?? []).map((c) => `{ type: 'criterion', description: ${str(c)} }`),
    ].join(', ')}]`,
  ];
  const body: string[] = [];
  if (test.preconditions.start_path !== undefined) {
    body.push(`await page.goto(${str(test.preconditions.start_path)});`);
  }
  for (const step of test.steps) {
    const lines = stepCode(step);
    body.push(
      `await test.step(${str(step.description)}, async () => {`,
      ...lines.map((l) => `  ${l}`),
      '});',
    );
  }
  return [
    `test(${str(test.name)}, { ${details.join(', ')} }, async ({ page }) => {`,
    ...body.map((l) => `  ${l}`),
    '});',
  ];
}

function specFile(input: EmitInput, tests: Plan.Test[]): string {
  const usesEnv = tests.some((t) => t.steps.some((s) => s.value_env !== undefined));
  const lines = [...header(input, '//'), "import { expect, test } from '@playwright/test';", ''];
  if (usesEnv) {
    lines.push(
      'function requireEnv(name: string): string {',
      '  const value = process.env[name];',
      "  if (value === undefined || value === '') throw new Error(`Set ${name} to run this test.`);",
      '  return value;',
      '}',
      '',
    );
  }
  lines.push(`test.describe(${str(input.plan.story.title)}, () => {`);
  const personas = [...new Set(tests.map((t) => t.persona))];
  personas.forEach((persona, i) => {
    if (i > 0) lines.push('');
    lines.push(
      `  test.describe(${str(`as ${persona}`)}, () => {`,
      `    // Signed-in session for ${comment(persona)}; see README.md.`,
      `    test.use({ storageState: process.env.${authEnv(persona)} ?? ${str(authDefault(persona))} });`,
    );
    for (const test of tests.filter((t) => t.persona === persona)) {
      lines.push('', ...testCode(test, input.plan.story.id).map((l) => `    ${l}`));
    }
    lines.push('  });');
  });
  lines.push('});', '');
  return lines.join('\n');
}

function configFile(input: EmitInput): string {
  return [
    '// Standalone config for running these exported tests on their own (validation, or before',
    "// moving them into your suite). Your repository's own playwright.config.ts takes over after that.",
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: '.',",
    "  testMatch: '**/*.spec.ts',",
    '  workers: 1,',
    '  retries: 0,',
    "  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],",
    '  use: {',
    `    baseURL: process.env.BASE_URL ?? ${str(input.appUrl)},`,
    "    trace: 'retain-on-failure',",
    '  },',
    "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],",
    '});',
    '',
  ].join('\n');
}

function readme(input: EmitInput, files: string[]): string {
  const personas = [...new Set(input.tests.map((t) => t.persona))];
  return [
    `# Exported tests: ${comment(input.plan.story.title)}`,
    '',
    `Playwright Test (TypeScript), generated by Tessa from run ${input.runId}.`,
    '',
    '## Files',
    '',
    ...files.map((f) => `- \`${f}\``),
    '',
    '## Signed-in sessions',
    '',
    'Each persona uses a stored session (Playwright storage state). Tessa never writes credentials',
    'into tests. Create each file once by signing in by hand, then keep it out of Git:',
    '',
    '```bash',
    ...personas.map(
      (p) => `npx playwright codegen --save-storage=${authDefault(p)} ${input.appUrl}`,
    ),
    '```',
    '',
    'Or point the environment variables at existing files:',
    '',
    ...personas.map((p) => `- \`${authEnv(p)}\` for **${p}** (default \`${authDefault(p)}\`)`),
    '',
    '## Data',
    '',
    'Each test notes the seed profile it expects in its `seed-profile` annotation. Seed the database',
    'before running, as your suite already does.',
    '',
    '## Run',
    '',
    '```bash',
    'npx playwright test --config playwright.config.ts',
    '```',
    '',
  ].join('\n');
}

export const playwrightTs: Emitter = {
  target: 'playwright-ts',
  emit(input) {
    const perTest = input.conventions.naming?.includes('{scenario}') ?? false;
    const story = input.plan.story.id;
    const files: EmittedFile[] = [];
    if (perTest) {
      for (const test of input.tests) {
        files.push({
          path: fileName(input.conventions.naming, story, test.id, '.ts'),
          content: specFile(input, [test]),
        });
      }
    } else {
      files.push({
        path: fileName(input.conventions.naming, story, null, '.ts'),
        content: specFile(input, input.tests),
      });
    }
    const specs = files.map((f) => f.path);
    files.push({ path: 'playwright.config.ts', content: configFile(input) });
    files.push({ path: 'README.md', content: readme(input, specs) });
    return files;
  },
};
