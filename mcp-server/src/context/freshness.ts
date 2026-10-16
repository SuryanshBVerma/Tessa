import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { readGitState } from '../results/env.js';
import { resolveInside } from '../util/paths.js';
import type { ContextCtx } from './build.js';
import { loadMap } from './build.js';

const run = promisify(execFile);

async function git(workspace: string, args: string[]): Promise<string | null> {
  try {
    return (
      await run('git', args, { cwd: workspace, windowsHide: true, timeout: 15_000 })
    ).stdout.trim();
  } catch {
    return null;
  }
}

/** Commits between `from` and HEAD, or null when unknown (no Git, unknown commit). */
export async function commitsBehind(workspace: string, from: string): Promise<number | null> {
  if (!/^[0-9a-f]{7,40}$/.test(from)) return null;
  const out = await git(workspace, ['rev-list', '--count', `${from}..HEAD`]);
  return out === null ? null : Number(out);
}

/** Files changed on this branch compared with the base branch (merge-base diff). */
export async function changedOnBranch(
  workspace: string,
  base?: string,
): Promise<{ base: string; files: string[] } | null> {
  const candidates = base === undefined ? ['develop', 'main', 'master'] : [base];
  for (const candidate of candidates) {
    if (!/^[A-Za-z0-9._/-]+$/.test(candidate)) continue;
    const exists = await git(workspace, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${candidate}^{commit}`,
    ]);
    if (exists === null || exists === '') continue;
    const prefix = (await git(workspace, ['rev-parse', '--show-prefix'])) ?? '';
    const out = await git(workspace, ['diff', '--name-only', `${candidate}...HEAD`]);
    const uncommitted = await git(workspace, ['diff', '--name-only', 'HEAD']);
    if (out === null) return null;
    const files = [...new Set([...out.split('\n'), ...(uncommitted ?? '').split('\n')])]
      .filter(Boolean)
      // git reports paths from the repository root; make them workspace-relative.
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length));
    return { base: candidate, files };
  }
  return null;
}

export interface Freshness {
  source: 'builtin' | 'external';
  built_at?: string;
  map_commit?: string;
  head?: string;
  commits_behind: number | null;
  changed_files: string[];
  max_staleness_commits: number;
  stale: boolean;
  message: string;
}

export async function builtinFreshness(ctx: ContextCtx): Promise<Freshness> {
  const max = ctx.config.context.knowledge_graph.max_staleness_commits;
  const map = loadMap(ctx);
  if (map === null) {
    return {
      source: 'builtin',
      commits_behind: null,
      changed_files: [],
      max_staleness_commits: max,
      stale: true,
      message: 'No frontend map yet. Call build_static_map.',
    };
  }
  const head = await readGitState(ctx.workspace);
  const behind = map.commit === undefined ? null : await commitsBehind(ctx.workspace, map.commit);
  const changed = Object.entries(map.files)
    .filter(([file, hash]) => {
      const abs = resolveInside(ctx.workspace, file);
      return (
        !existsSync(abs) ||
        createHash('sha256').update(readFileSync(abs, 'utf8'), 'utf8').digest('hex') !== hash
      );
    })
    .map(([file]) => file);
  const stale = changed.length > 0 || (behind !== null && behind > max);
  return {
    source: 'builtin',
    built_at: map.built_at,
    ...(map.commit === undefined ? {} : { map_commit: map.commit }),
    ...(head === null ? {} : { head: head.commit }),
    commits_behind: behind,
    changed_files: changed,
    max_staleness_commits: max,
    stale,
    message: stale
      ? `The map is out of date (${String(changed.length)} mapped file(s) changed${behind === null ? '' : `, ${String(behind)} commit(s) behind`}). Call build_static_map.`
      : 'The map is current.',
  };
}

export async function externalFreshness(
  ctx: ContextCtx,
  indexedCommit: string,
): Promise<Freshness> {
  const max = ctx.config.context.knowledge_graph.max_staleness_commits;
  const behind = await commitsBehind(ctx.workspace, indexedCommit);
  const head = await readGitState(ctx.workspace);
  const stale = behind === null || behind > max;
  return {
    source: 'external',
    map_commit: indexedCommit,
    ...(head === null ? {} : { head: head.commit }),
    commits_behind: behind,
    changed_files: [],
    max_staleness_commits: max,
    stale,
    message:
      behind === null
        ? 'The knowledge graph reports a commit this repository does not know; treat its answers with care.'
        : stale
          ? `The knowledge graph is ${String(behind)} commits behind HEAD (limit ${String(max)}). The report will say so.`
          : `The knowledge graph is ${String(behind)} commit(s) behind HEAD, within the limit.`,
  };
}
