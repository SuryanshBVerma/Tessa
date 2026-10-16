// Validates exported tests: compile them, and optionally run them once against the app.
import { execFile } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { writeAtomic } from '../runs/store.js';
import { resolveInside } from '../util/paths.js';
import { authEnv } from './emitters/common.js';
import { exportDir, ExportError, exportRel, readManifest, type ExportCtx } from './export.js';

// Terminal colour codes in Playwright's error messages.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\u001b\[[0-9;]*m/g;
const RUN_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const SESSION_TIMEOUT_MS = 10 * 60_000;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeout,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? '') });
      },
    );
  });
}

function tail(text: string, lines = 30): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-lines);
}

export function sessionPath(ctx: ExportCtx, persona: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(persona)) throw new ExportError('invalid persona');
  return resolveInside(
    ctx.workspace,
    posix.join(ctx.config.artifacts.root, '.session', `${persona}.json`),
  );
}

/** The Playwright CLI script from the workspace's own @playwright/test, or null. */
export function playwrightCli(workspace: string): string | null {
  try {
    const require = createRequire(join(workspace, 'package.json'));
    const pkg = require.resolve('@playwright/test/package.json');
    const cli = join(dirname(pkg), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

function personasOf(dir: string, manifestFiles: string[]): string[] {
  const found = new Set<string>();
  for (const file of manifestFiles) {
    const text = readFileSync(resolveInside(dir, file), 'utf8');
    for (const match of text.matchAll(/TESSA_AUTH_([A-Z0-9_]+)/g)) {
      if (match[1] !== undefined) found.add(match[1].toLowerCase().replaceAll('_', '-'));
    }
  }
  return [...found];
}

export interface TestOutcome {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
}

export interface ValidationReport {
  target: string;
  story_id: string;
  compiled: boolean;
  compile_errors: string[];
  ran: boolean;
  run_skipped_reason?: string;
  outcomes: TestOutcome[];
  summary_path: string;
}

// Playwright TS

function compileTs(dir: string, files: string[]): string[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      types: ['node'],
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where =
      d.file === undefined || d.start === undefined
        ? ''
        : `${posix.relative(dir.replaceAll('\\', '/'), d.file.fileName.replaceAll('\\', '/'))}:${String(d.file.getLineAndCharacterOfPosition(d.start).line + 1)}: `;
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

interface PwSpec {
  title: string;
  tests: { results: { status: string; error?: { message?: string } }[] }[];
}
interface PwSuite {
  title: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

function pwOutcomes(report: { suites?: PwSuite[] }): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  const walk = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      const results = spec.tests.flatMap((t) => t.results);
      const last = results[results.length - 1];
      const status =
        last?.status === 'passed' ? 'passed' : last?.status === 'skipped' ? 'skipped' : 'failed';
      const message = last?.error?.message
        ?.replace(ANSI_ESCAPES, '')
        .split('\n')
        .slice(0, 6)
        .join('\n');
      outcomes.push({
        name: spec.title,
        status,
        ...(status === 'failed' && message !== undefined ? { error: message } : {}),
      });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return outcomes;
}

// Playwright .NET

function trxOutcomes(trx: string): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  for (const match of trx.matchAll(
    /<UnitTestResult\b[^>]*\btestName="([^"]*)"[^>]*\boutcome="([^"]*)"[^>]*>([\s\S]*?)<\/UnitTestResult>|<UnitTestResult\b[^>]*\btestName="([^"]*)"[^>]*\boutcome="([^"]*)"[^>]*\/>/g,
  )) {
    const name = match[1] ?? match[4] ?? '';
    const outcome = (match[2] ?? match[5] ?? '').toLowerCase();
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(match[3] ?? '')?.[1];
    const status =
      outcome === 'passed' ? 'passed' : outcome === 'notexecuted' ? 'skipped' : 'failed';
    outcomes.push({
      name: name.split('.').pop() ?? name,
      status,
      ...(status === 'failed' && message !== undefined
        ? { error: message.split('\n').slice(0, 6).join('\n') }
        : {}),
    });
  }
  return outcomes;
}

function summaryMarkdown(report: Omit<ValidationReport, 'summary_path'>): string {
  const lines = [
    `# Export summary: ${report.story_id} (${report.target})`,
    '',
    `- Compiled: ${report.compiled ? 'yes' : 'no'}`,
    `- Ran once: ${report.ran ? 'yes' : `no${report.run_skipped_reason === undefined ? '' : ` (${report.run_skipped_reason})`}`}`,
    '',
  ];
  if (report.compile_errors.length > 0) {
    lines.push('## Compile errors', '', '```', ...report.compile_errors.slice(0, 50), '```', '');
  }
  if (report.outcomes.length > 0) {
    lines.push('## Results', '', '| Test | Result |', '| --- | --- |');
    for (const o of report.outcomes)
      lines.push(`| ${o.name.replace(/\|/g, '\\|')} | ${o.status} |`);
    lines.push('');
    const failed = report.outcomes.filter((o) => o.status === 'failed');
    if (failed.length > 0) {
      lines.push('## Failures', '');
      for (const o of failed)
        lines.push(`### ${o.name}`, '', '```', o.error ?? '(no message)', '```', '');
    }
  }
  return lines.join('\n');
}

export async function validateExport(
  ctx: ExportCtx,
  target: string,
  story: string,
  options: { runOnce?: boolean } = {},
): Promise<ValidationReport> {
  const manifest = readManifest(ctx, target, story);
  const dir = exportDir(ctx, target, story);
  const runOnce = options.runOnce ?? ctx.config.export.validate.run_once;
  const testFiles = manifest.files.filter((f) => f.handoff).map((f) => f.path);
  let compiled = false;
  let compileErrors: string[] = [];
  let ran = false;
  let skipped: string | undefined;
  let outcomes: TestOutcome[] = [];

  const personas = personasOf(dir, testFiles);
  const missingSessions = personas.filter((p) => !existsSync(sessionPath(ctx, p)));
  const env: NodeJS.ProcessEnv = { ...process.env, BASE_URL: ctx.config.app.url, CI: '1' };
  for (const p of personas) env[authEnv(p)] = sessionPath(ctx, p);

  if (target === 'playwright-ts') {
    const cli = playwrightCli(ctx.workspace);
    if (cli === null) {
      compileErrors = [
        '@playwright/test is not installed in this workspace; add it as a dev dependency to validate (npm install -D @playwright/test)',
      ];
    } else {
      compileErrors = compileTs(dir, testFiles);
      compiled = compileErrors.length === 0;
      if (compiled && runOnce) {
        if (missingSessions.length > 0) {
          skipped = `no stored session for ${missingSessions.join(', ')}; call capture_session for each`;
        } else {
          rmSync(join(dir, 'test-results'), { recursive: true, force: true });
          const run = await exec(
            process.execPath,
            [cli, 'test', '--config', join(dir, 'playwright.config.ts')],
            { cwd: dir, env, timeout: RUN_TIMEOUT_MS },
          );
          const reportFile = join(dir, 'test-results', 'results.json');
          if (existsSync(reportFile)) {
            ran = true;
            outcomes = pwOutcomes(
              JSON.parse(readFileSync(reportFile, 'utf8')) as { suites?: PwSuite[] },
            );
          } else {
            skipped = `Playwright did not produce results: ${tail(run.stderr || run.stdout, 8).join(' | ')}`;
          }
        }
      }
    }
  } else if (target === 'playwright-dotnet') {
    const build = await exec('dotnet', ['build', dir, '--nologo', '-v', 'q', '-clp:NoSummary'], {
      cwd: dir,
      timeout: BUILD_TIMEOUT_MS,
    });
    compiled = build.code === 0;
    if (!compiled) {
      const errors = tail(`${build.stdout}\n${build.stderr}`, 200).filter((l) => /error/i.test(l));
      compileErrors =
        errors.length > 0 ? errors.slice(0, 50) : tail(build.stdout || build.stderr, 20);
    } else if (runOnce) {
      if (missingSessions.length > 0) {
        skipped = `no stored session for ${missingSessions.join(', ')}; call capture_session for each`;
      } else {
        const results = join(dir, 'TestResults');
        rmSync(results, { recursive: true, force: true });
        mkdirSync(results, { recursive: true });
        await exec(
          'dotnet',
          [
            'test',
            dir,
            '--nologo',
            '--no-build',
            '--logger',
            'trx;LogFileName=results.trx',
            '--results-directory',
            results,
          ],
          { cwd: dir, env, timeout: RUN_TIMEOUT_MS },
        );
        const trx = globSync('**/*.trx', { cwd: results })[0];
        if (trx !== undefined) {
          ran = true;
          outcomes = trxOutcomes(readFileSync(join(results, trx), 'utf8'));
        } else {
          skipped = 'dotnet test produced no results';
        }
      }
    }
  } else {
    throw new ExportError(`no validator for ${target}`);
  }

  const report = {
    target,
    story_id: story,
    compiled,
    compile_errors: compileErrors,
    ran,
    ...(skipped === undefined ? {} : { run_skipped_reason: skipped }),
    outcomes,
  };
  writeAtomic(join(dir, 'export-summary.md'), summaryMarkdown(report));
  return { ...report, summary_path: exportRel(ctx, target, story, 'export-summary.md') };
}

/**
 * Opens Playwright's own browser at the login page so the user can sign in; Playwright saves the
 * session to <artifacts>/.session/<persona>.json when they close the window. Tessa never sees the
 * credentials, and the file stays in the gitignored .session/ folder.
 */
export async function captureSession(ctx: ExportCtx, persona: string) {
  if (!ctx.config.personas.some((p) => p.name === persona))
    throw new ExportError(`unknown persona "${persona}"`);
  const cli = playwrightCli(ctx.workspace);
  if (cli === null) throw new ExportError('@playwright/test is not installed in this workspace');
  const file = sessionPath(ctx, persona);
  mkdirSync(dirname(file), { recursive: true });
  const loginUrl = new URL(ctx.config.auth.login_path, ctx.config.app.url).toString();
  const run = await exec(process.execPath, [cli, 'open', `--save-storage=${file}`, loginUrl], {
    cwd: ctx.workspace,
    timeout: SESSION_TIMEOUT_MS,
  });
  if (!existsSync(file)) {
    throw new ExportError(
      `no session was saved (${tail(run.stderr, 3).join(' | ') || 'the window was closed before signing in?'})`,
    );
  }
  return { persona, saved: posix.join(ctx.config.artifacts.root, '.session', `${persona}.json`) };
}
