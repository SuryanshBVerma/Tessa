// Moving exported tests into the repository: propose a diff, then apply it only with the
// proposal's id, so the user confirms exactly what gets written.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { writeAtomic } from '../runs/store.js';
import { resolveInside } from '../util/paths.js';
import { exportDir, ExportError, readManifest, type ExportCtx } from './export.js';

const DEFAULT_TEST_DIRS: Record<string, string> = {
  'playwright-ts': 'tests/e2e',
  'playwright-dotnet': 'tests/E2E',
};
const MAX_DIFF_LINES = 400;

export interface HandoffChange {
  from: string;
  to: string;
  action: 'create' | 'modify' | 'unchanged';
}

/** Line diff in unified style. Small and dependency-free; fine for test files. */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = before === null ? [] : before.replaceAll('\r\n', '\n').split('\n');
  const b = after.replaceAll('\r\n', '\n').split('\n');
  // Longest common subsequence table, bounded to keep this cheap.
  if (a.length * b.length > 4_000_000) {
    return `--- a/${path}\n+++ b/${path}\n(file too large to diff: ${String(a.length)} -> ${String(b.length)} lines)\n`;
  }
  // lcs[i * w + j] = length of the longest common subsequence of a[i..] and b[j..].
  const w = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i] ?? ''}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || at(i, j + 1) >= at(i + 1, j))) {
      out.push(`+${b[j] ?? ''}`);
      j++;
    } else {
      out.push(`-${a[i] ?? ''}`);
      i++;
    }
  }
  return `${out.join('\n')}\n`;
}

function plan(ctx: ExportCtx, target: string, story: string) {
  const manifest = readManifest(ctx, target, story);
  const testDir = ctx.config.export.conventions.test_dir ?? DEFAULT_TEST_DIRS[target] ?? 'tests';
  const src = exportDir(ctx, target, story);
  const changes: (HandoffChange & { content: string; before: string | null })[] = [];
  for (const file of manifest.files.filter((f) => f.handoff)) {
    const content = readFileSync(resolveInside(src, file.path), 'utf8');
    const to = posix.join(testDir, file.path);
    const dest = resolveInside(ctx.workspace, to);
    const before = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    const action =
      before === null
        ? 'create'
        : before.replaceAll('\r\n', '\n') === content.replaceAll('\r\n', '\n')
          ? 'unchanged'
          : 'modify';
    changes.push({
      from: posix.join(ctx.config.artifacts.root, 'export', target, story, file.path),
      to,
      action,
      content,
      before,
    });
  }
  const id = createHash('sha256')
    .update(JSON.stringify(changes.map((c) => [c.to, c.action, c.content, c.before])))
    .digest('hex')
    .slice(0, 16);
  return { id, testDir, changes };
}

/** Shows what moving the exported tests into the repository would change. Writes nothing. */
export function proposeHandoff(ctx: ExportCtx, target: string, story: string) {
  const { id, testDir, changes } = plan(ctx, target, story);
  if (changes.length === 0) throw new ExportError('the export has no test files to hand off');
  let diff = changes
    .filter((c) => c.action !== 'unchanged')
    .map((c) => unifiedDiff(c.to, c.before, c.content))
    .join('\n');
  const lines = diff.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    diff = `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n... (${String(lines.length - MAX_DIFF_LINES)} more lines)`;
  }
  return {
    proposal_id: id,
    test_dir: testDir,
    changes: changes.map(({ from, to, action }) => ({ from, to, action })),
    diff,
    note: 'Nothing has been written. Show the user this diff; call apply_handoff with proposal_id only after they confirm.',
  };
}

/** Writes the proposed files, only if nothing changed since the proposal the user confirmed. */
export function applyHandoff(ctx: ExportCtx, target: string, story: string, proposalId: string) {
  const { id, changes } = plan(ctx, target, story);
  if (id !== proposalId) {
    throw new ExportError(
      'the export or the destination files changed since that proposal; call propose_handoff again and show the user the new diff',
    );
  }
  const written: string[] = [];
  for (const change of changes) {
    if (change.action === 'unchanged') continue;
    const dest = resolveInside(ctx.workspace, change.to);
    mkdirSync(dirname(dest), { recursive: true });
    writeAtomic(dest, change.content);
    written.push(change.to);
  }
  return { written, unchanged: changes.filter((c) => c.action === 'unchanged').map((c) => c.to) };
}
