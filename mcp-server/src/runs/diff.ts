import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Diff, Results } from '../schemas/generated/index.js';
import { validate } from '../schemas/index.js';
import { RunError } from './store.js';

const run = promisify(execFile);

type Status = Results.TestResult['status'];
type Change = Diff.TestDiff['change'];

const MAX_CHANGED_FILES = 500;

const failing = (s: Status) => s === 'failed' || s === 'error';

/** How a test's status moved from the baseline (a) to the new run (b). */
export function classify(a: Status | undefined, b: Status | undefined): Change {
  if (a === undefined) {
    return 'added';
  }
  if (b === undefined) {
    return 'removed';
  }
  if (a === 'passed' && b === 'passed') {
    return 'still-passing';
  }
  if (failing(a) && failing(b)) {
    return 'still-failing';
  }
  if (failing(a) && b === 'passed') {
    return 'fixed';
  }
  if (a === 'passed' && failing(b)) {
    return 'regressed';
  }
  // Anything involving a skipped test: it did not run in one of the two, so nothing is proven.
  return 'changed-other';
}

/**
 * Files changed between two commits, relative to the workspace and limited to it, or undefined
 * when either commit is unknown to Git. Commits are checked against the results schema's
 * hex pattern before they reach here, and git gets an argument array, never a shell string.
 */
export async function changedFiles(
  workspace: string,
  commitA: string,
  commitB: string,
  /** Workspace-relative folder left out, normally Tessa's artifacts root: its plans and exports are not app code. */
  exclude?: string,
): Promise<string[] | undefined> {
  if (commitA === commitB) {
    return [];
  }
  try {
    const { stdout } = await run(
      'git',
      [
        'diff',
        '--name-only',
        '--relative',
        commitA,
        commitB,
        '--',
        '.',
        ...(exclude === undefined ? [] : [`:(exclude)${exclude}`]),
      ],
      {
        cwd: workspace,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, MAX_CHANGED_FILES);
  } catch {
    return undefined;
  }
}

export interface DiffInput {
  a: Results.RunResults;
  b: Results.RunResults;
  changedFiles?: string[];
  now?: Date;
}

/** Compares run b against baseline a. Both must be runs of the same story. */
export function diffRuns({ a, b, changedFiles: files, now = new Date() }: DiffInput): Diff.RunDiff {
  if (a.run_id === b.run_id) {
    throw new RunError('pick two different runs to compare');
  }
  if (a.story_id !== b.story_id) {
    throw new RunError(
      `run ${a.run_id} is for story "${a.story_id}" and run ${b.run_id} for "${b.story_id}"; compare runs of the same story`,
    );
  }
  // A rerun only repeats some of the baseline's tests; the others were not dropped.
  const rerunOnly = b.rerun_of === a.run_id;
  const testsA = new Map(a.tests.map((t) => [t.test_id, t]));
  const testsB = new Map(b.tests.map((t) => [t.test_id, t]));
  const ids = rerunOnly
    ? [...testsB.keys()]
    : [...testsA.keys(), ...[...testsB.keys()].filter((id) => !testsA.has(id))];

  const tests: Diff.TestDiff[] = ids.map((id) => {
    const ta = testsA.get(id);
    const tb = testsB.get(id);
    const change = classify(ta?.status, tb?.status);
    return {
      test_id: id,
      change,
      ...(ta === undefined ? {} : { status_a: ta.status }),
      ...(tb === undefined ? {} : { status_b: tb.status }),
      ...(ta?.failure === undefined ? {} : { failing_step_a: ta.failure.step_index }),
      ...(tb?.failure === undefined ? {} : { failing_step_b: tb.failure.step_index }),
      ...(ta?.duration_ms !== undefined && tb?.duration_ms !== undefined
        ? { duration_delta_ms: tb.duration_ms - ta.duration_ms }
        : {}),
    };
  });

  const count = (change: Change) => tests.filter((t) => t.change === change).length;
  const diff: Diff.RunDiff = {
    version: 1,
    run_a: a.run_id,
    run_b: b.run_id,
    story_id: a.story_id,
    created_at: now.toISOString(),
    ...(a.environment.commit === undefined ? {} : { commit_a: a.environment.commit }),
    ...(b.environment.commit === undefined ? {} : { commit_b: b.environment.commit }),
    ...(a.environment.dirty === undefined ? {} : { dirty_a: a.environment.dirty }),
    ...(b.environment.dirty === undefined ? {} : { dirty_b: b.environment.dirty }),
    ...(rerunOnly ? { rerun_only: true } : {}),
    ...(files === undefined ? {} : { changed_files: files }),
    summary: {
      fixed: count('fixed'),
      regressed: count('regressed'),
      still_failing: count('still-failing'),
      still_passing: count('still-passing'),
      added: count('added'),
      removed: count('removed'),
      changed_other: count('changed-other'),
    },
    tests,
  };
  const checked = validate('run-diff', diff);
  if (!checked.ok) {
    throw new RunError(
      `diff does not match run-diff.schema.json: ${checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  return checked.value;
}

/** diffs/<a>__<b>, the file stem for a diff's JSON and HTML. */
export function diffStem(runA: string, runB: string): string {
  return `${runA}__${runB}`;
}
