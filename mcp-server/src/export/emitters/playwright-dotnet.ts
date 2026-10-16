// Test IR -> Playwright for .NET with NUnit (C#). Deterministic: the same plan always gives the same code.
import type { Plan } from '../../schemas/generated/index.js';
import {
  authDefault,
  authEnv,
  comment,
  fullUrlPattern,
  header,
  pascal,
  str,
  type EmitInput,
  type EmittedFile,
  type Emitter,
} from './common.js';

export const PLAYWRIGHT_DOTNET_VERSION = '1.52.0';
export const DOTNET_PACKAGES: Record<string, string> = {
  'Microsoft.Playwright.NUnit': PLAYWRIGHT_DOTNET_VERSION,
  'Microsoft.NET.Test.Sdk': '17.13.0',
  NUnit: '4.3.2',
  NUnit3TestAdapter: '5.0.0',
};

function ariaRole(role: string): string {
  return `AriaRole.${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

function locator(target: Plan.Target): string {
  const exact = target.exact === true ? ', new() { Exact = true }' : '';
  switch (target.strategy) {
    case 'testid':
      return `Page.GetByTestId(${str(target.value)})`;
    case 'role': {
      const options = [
        target.name === undefined ? null : `Name = ${str(target.name)}`,
        target.exact === true ? 'Exact = true' : null,
      ].filter((o) => o !== null);
      return `Page.GetByRole(${ariaRole(target.role)}${options.length > 0 ? `, new() { ${options.join(', ')} }` : ''})`;
    }
    case 'label':
      return `Page.GetByLabel(${str(target.value)}${exact})`;
    case 'placeholder':
      return `Page.GetByPlaceholder(${str(target.value)}${exact})`;
    case 'text':
      return `Page.GetByText(${str(target.value)}${exact})`;
    case 'css':
      return `Page.Locator(${str(target.value)})`;
  }
}

function opts(step: Plan.Step): string {
  return step.timeout_ms === undefined ? '' : `new() { Timeout = ${String(step.timeout_ms)} }`;
}

function args(...parts: string[]): string {
  return parts.filter((p) => p !== '').join(', ');
}

function value(step: Plan.Step): string {
  return step.value_env !== undefined
    ? `RequireEnv(${str(step.value_env)})`
    : str(step.value ?? '');
}

function assertion(step: Plan.Step, assert: Plan.Assertion): string {
  const target = step.target === undefined ? 'Page' : locator(step.target);
  const on = (matcher: string, arg = '') =>
    `await Expect(${target}).${matcher}(${args(arg, opts(step))});`;
  switch (assert.kind) {
    case 'visible':
      return on('ToBeVisibleAsync');
    case 'hidden':
      return on('ToBeHiddenAsync');
    case 'enabled':
      return on('ToBeEnabledAsync');
    case 'disabled':
      return on('ToBeDisabledAsync');
    case 'checked':
      return on('ToBeCheckedAsync');
    case 'unchecked':
      return on('Not.ToBeCheckedAsync');
    case 'text-equals':
      return on('ToHaveTextAsync', str(assert.expected));
    case 'text-contains':
      return on('ToContainTextAsync', str(assert.expected));
    case 'value-equals':
      return on('ToHaveValueAsync', str(assert.expected));
    case 'count-equals':
      return on('ToHaveCountAsync', String(assert.expected));
    case 'title-equals':
      return `await Expect(Page).ToHaveTitleAsync(${args(str(assert.expected), opts(step))});`;
    case 'url-matches':
      return `await Expect(Page).ToHaveURLAsync(${args(`new Regex(${str(fullUrlPattern(assert.expected))})`, opts(step))});`;
  }
}

function stepCode(step: Plan.Step): string[] {
  const target = step.target === undefined ? 'Page.Locator("body")' : locator(step.target);
  switch (step.action) {
    case 'navigate':
      return [`await Page.GotoAsync(${str(step.value ?? '/')});`];
    case 'click':
      return [`await ${target}.ClickAsync(${opts(step)});`];
    case 'fill':
      return [`await ${target}.FillAsync(${args(value(step), opts(step))});`];
    case 'select':
      return [`await ${target}.SelectOptionAsync(${args(value(step), opts(step))});`];
    case 'check':
      return [`await ${target}.CheckAsync(${opts(step)});`];
    case 'uncheck':
      return [`await ${target}.UncheckAsync(${opts(step)});`];
    case 'wait':
      return step.assertion !== undefined
        ? [assertion(step, step.assertion)]
        : [`await Expect(${target}).ToBeVisibleAsync(${opts(step)});`];
    case 'assert':
      return step.assertion === undefined ? [] : [assertion(step, step.assertion)];
  }
}

function testMethod(test: Plan.Test): string[] {
  const body: string[] = [];
  if (test.preconditions.start_path !== undefined) {
    body.push(`await Page.GotoAsync(${str(test.preconditions.start_path)});`);
  }
  test.steps.forEach((step, i) => {
    body.push(`// ${String(i + 1)}. ${comment(step.description)}`, ...stepCode(step));
  });
  return [
    `/// <summary>${comment(test.intent).replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</summary>`,
    '[Test]',
    `[Description(${str(test.name)})]`,
    `[Property("SeedProfile", ${str(test.preconditions.seed_profile)})]`,
    ...(test.tags ?? []).map((t) => `[Category(${str(t)})]`),
    `public async Task ${pascal(test.id)}()`,
    '{',
    ...body.map((l) => `    ${l}`),
    '}',
  ];
}

function storyFile(input: EmitInput): string {
  const usesEnv = input.tests.some((t) => t.steps.some((s) => s.value_env !== undefined));
  const lines = [
    ...header(input, '//'),
    'using System.Text.RegularExpressions;',
    'using Microsoft.Playwright;',
    'using Microsoft.Playwright.NUnit;',
    'using NUnit.Framework;',
    '',
    'namespace Tessa.Generated;',
  ];
  const personas = [...new Set(input.tests.map((t) => t.persona))];
  for (const persona of personas) {
    lines.push(
      '',
      `/// <summary>${comment(input.plan.story.title)}, as ${comment(persona)}.</summary>`,
      '[TestFixture]',
      `[Category(${str(input.plan.story.id)})]`,
      `[Category(${str(persona)})]`,
      `public class ${pascal(input.plan.story.id)}${pascal(persona)}Tests : PageTest`,
      '{',
      '    public override BrowserNewContextOptions ContextOptions() => new()',
      '    {',
      `        BaseURL = Environment.GetEnvironmentVariable("BASE_URL") ?? ${str(input.appUrl)},`,
      `        // Signed-in session for ${comment(persona)}; see README.md.`,
      `        StorageStatePath = Environment.GetEnvironmentVariable(${str(authEnv(persona))}) ?? ${str(authDefault(persona))},`,
      '    };',
    );
    if (usesEnv) {
      lines.push(
        '',
        '    private static string RequireEnv(string name) =>',
        '        Environment.GetEnvironmentVariable(name) is { Length: > 0 } value',
        '            ? value',
        '            : throw new InvalidOperationException($"Set {name} to run this test.");',
      );
    }
    for (const test of input.tests.filter((t) => t.persona === persona)) {
      lines.push('', ...testMethod(test).map((l) => `    ${l}`));
    }
    lines.push('}');
  }
  lines.push('');
  return lines.join('\n');
}

function projectFile(): string {
  return [
    '<!-- Standalone project for running these exported tests on their own (validation, or before',
    "     moving them into your test project). Your repository's own .csproj takes over after that. -->",
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <Nullable>enable</Nullable>',
    '    <IsPackable>false</IsPackable>',
    '    <IsTestProject>true</IsTestProject>',
    '  </PropertyGroup>',
    '  <ItemGroup>',
    ...Object.entries(DOTNET_PACKAGES).map(
      ([name, version]) => `    <PackageReference Include="${name}" Version="${version}" />`,
    ),
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n');
}

function readme(input: EmitInput, file: string): string {
  const personas = [...new Set(input.tests.map((t) => t.persona))];
  return [
    `# Exported tests: ${comment(input.plan.story.title)}`,
    '',
    `Playwright for .NET with NUnit, generated by Tessa from run ${input.runId}.`,
    '',
    `- \`${file}\`: one test class per persona`,
    '- `Tessa.Generated.csproj`: a standalone project to run them on their own',
    '',
    '## Signed-in sessions',
    '',
    'Each persona uses a stored session (Playwright storage state). Tessa never writes credentials',
    'into tests. Create each file once by signing in by hand, then keep it out of Git:',
    '',
    '```bash',
    'dotnet build',
    ...personas.map(
      (p) =>
        `pwsh bin/Debug/net8.0/playwright.ps1 codegen --save-storage=${authDefault(p)} ${input.appUrl}`,
    ),
    '```',
    '',
    ...personas.map(
      (p) => `- \`${authEnv(p)}\` overrides the path for **${p}** (default \`${authDefault(p)}\`)`,
    ),
    '',
    '## Run',
    '',
    '```bash',
    'dotnet test',
    '```',
    '',
  ].join('\n');
}

export const playwrightDotnet: Emitter = {
  target: 'playwright-dotnet',
  emit(input) {
    const file = `${pascal(input.plan.story.id)}Tests.cs`;
    return [
      { path: file, content: storyFile(input) },
      { path: 'Tessa.Generated.csproj', content: projectFile() },
      { path: 'README.md', content: readme(input, file) },
    ] satisfies EmittedFile[];
  },
};
