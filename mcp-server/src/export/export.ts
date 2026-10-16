import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import type { ResolvedConfig } from '../config/index.js';
import { detectStack } from '../config/stacks.js';
import { loadResults } from '../report/render.js';
import { readSelection } from '../report/server.js';
import { artifactsDir, loadPlan, RunError, STORY_ID, writeAtomic } from '../runs/store.js';
import { resolveInside } from '../util/paths.js';
import { EMITTERS } from './emitters/index.js';

export interface ExportCtx {
  config: ResolvedConfig;
  workspace: string;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ManifestFile {
  path: string;
  sha256: string;
  /** Test code to hand off into the repository; config, project and README files are standalone. */
  handoff: boolean;
  /** Changed by the convention pass after emitting. */
  edited?: boolean;
}

export interface Manifest {
  version: 1;
  story_id: string;
  run_id: string;
  target: string;
  selected_test_ids: string[];
  emitted_at: string;
  files: ManifestFile[];
}

const HANDOFF = /\.(spec|test)\.(ts|js)$|Tests\.cs$/;
const EDITABLE = /\.(ts|js|cs|md|json|csproj)$/;
const MAX_FILE_BYTES = 512 * 1024;

export function sha256(text: string): string {
  return createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

export function exportDir(ctx: ExportCtx, target: string, story: string): string {
  if (!/^[a-z0-9-]+$/.test(target) || !STORY_ID.test(story)) {
    throw new ExportError('invalid target or story id');
  }
  return artifactsDir(ctx, 'export', target, story);
}

export function exportRel(ctx: ExportCtx, target: string, story: string, path = ''): string {
  return posix.join(ctx.config.artifacts.root, 'export', target, story, path);
}

/** The target to emit: the reviewer's choice, then the caller's, then config; "auto" detects. */
export function resolveTarget(ctx: ExportCtx, ...choices: (string | undefined)[]): string {
  const chosen = choices.find((c) => c !== undefined) ?? ctx.config.export.target;
  if (chosen !== 'auto') {
    if (EMITTERS[chosen] === undefined) {
      throw new ExportError(
        `no emitter for "${chosen}" yet; available: ${Object.keys(EMITTERS).join(', ')}`,
      );
    }
    return chosen;
  }
  const detected = [
    ...new Set(detectStack(ctx.workspace).export_targets.map((t) => t.name)),
  ].filter((t) => EMITTERS[t] !== undefined);
  if (detected.length === 1 && detected[0] !== undefined) return detected[0];
  throw new ExportError(
    detected.length === 0
      ? `export.target is auto and no test framework was detected; ask the user which to use: ${Object.keys(EMITTERS).join(', ')}`
      : `export.target is auto and several frameworks were detected (${detected.join(', ')}); ask the user which to use`,
  );
}

export function readManifest(ctx: ExportCtx, target: string, story: string): Manifest {
  const file = resolveInside(exportDir(ctx, target, story), 'export-manifest.json');
  if (!existsSync(file)) {
    throw new ExportError(`nothing exported for ${story} as ${target} yet; call emit_tests first`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

function writeManifest(ctx: ExportCtx, manifest: Manifest): void {
  const dir = exportDir(ctx, manifest.target, manifest.story_id);
  writeAtomic(resolveInside(dir, 'export-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Emits the selected tests of a run into export/<target>/<story>/. */
export function emitTests(ctx: ExportCtx, runId: string, requestedTarget?: string) {
  const selection = readSelection(ctx, runId);
  if (selection === null) {
    throw new ExportError(
      `run ${runId} has no selection yet; the reviewer selects tests on the review page`,
    );
  }
  const results = loadResults(ctx, runId);
  const plan = loadPlan(ctx, results.story_id);
  const target = resolveTarget(ctx, selection.target, requestedTarget);
  const emitter = EMITTERS[target];
  if (emitter === undefined) throw new ExportError(`no emitter for ${target}`);

  const selected = new Set(selection.selected_test_ids);
  const tests = plan.tests.filter((t) => selected.has(t.id));
  if (tests.length === 0) throw new RunError('the selection has no tests from this plan');
  const notPassing = results.tests.filter((t) => selected.has(t.test_id) && t.status !== 'passed');

  const files = emitter.emit({
    plan,
    tests,
    runId,
    appUrl: ctx.config.app.url,
    conventions: {
      ...(ctx.config.export.conventions.naming === undefined
        ? {}
        : { naming: ctx.config.export.conventions.naming }),
    },
  });

  const dir = exportDir(ctx, target, plan.story.id);
  // Re-emitting replaces the previous export for this story and target.
  if (existsSync(dir)) {
    try {
      for (const old of readManifest(ctx, target, plan.story.id).files) {
        rmSync(resolveInside(dir, old.path), { force: true });
      }
    } catch {
      // No previous manifest.
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const abs = resolveInside(dir, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, file.content);
  }
  const manifest: Manifest = {
    version: 1,
    story_id: plan.story.id,
    run_id: runId,
    target,
    selected_test_ids: tests.map((t) => t.id),
    emitted_at: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path,
      sha256: sha256(f.content),
      handoff: HANDOFF.test(f.path),
    })),
  };
  writeManifest(ctx, manifest);
  return {
    target,
    story_id: plan.story.id,
    export_dir: exportRel(ctx, target, plan.story.id),
    tests: manifest.selected_test_ids,
    files: manifest.files.map((f) => ({ path: f.path, handoff: f.handoff })),
    warnings: notPassing.map(
      (t) =>
        `${t.test_id} did not pass in run ${runId} (${t.status}); exported as planned, so it will fail until the app or the test is fixed`,
    ),
  };
}

/** Replaces one exported file, for the convention pass. Only inside the export folder. */
export function updateExportFile(
  ctx: ExportCtx,
  target: string,
  story: string,
  path: string,
  content: string,
) {
  if (!EDITABLE.test(path))
    throw new ExportError('only .ts, .js, .cs, .md, .json and .csproj files can be edited');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES)
    throw new ExportError('file is larger than 512 KB');
  const manifest = readManifest(ctx, target, story);
  const dir = exportDir(ctx, target, story);
  const abs = resolveInside(dir, path);
  const rel = posix.normalize(path.replaceAll('\\', '/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeAtomic(abs, content);
  const entry = manifest.files.find((f) => f.path === rel);
  if (entry === undefined) {
    manifest.files.push({
      path: rel,
      sha256: sha256(content),
      handoff: HANDOFF.test(rel),
      edited: true,
    });
  } else {
    entry.sha256 = sha256(content);
    entry.edited = true;
  }
  writeManifest(ctx, manifest);
  return { path: exportRel(ctx, target, story, rel), handoff: HANDOFF.test(rel) };
}
