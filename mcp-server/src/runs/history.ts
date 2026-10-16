import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Results } from '../schemas/generated/index.js';
import { validate } from '../schemas/index.js';
import { artifactsDir, loadRun, RUN_ID, RunError, STORY_ID, type RunContext } from './store.js';

/** Orders run ids oldest first: by timestamp, then by the -N suffix for runs in the same second. */
export function compareRunIds(a: string, b: string): number {
  const [stampA = '', nA = '1'] = a.split('-');
  const [stampB = '', nB = '1'] = b.split('-');
  return stampA === stampB ? Number(nA) - Number(nB) : stampA < stampB ? -1 : 1;
}

export interface RunSummary {
  run_id: string;
  story_id: string;
  /** complete: results.json was written; in-progress: only run-state.json exists. */
  state: 'complete' | 'in-progress';
  started_at: string;
  finished_at?: string;
  rerun_of?: string;
  commit?: string;
  dirty?: boolean;
  summary?: Results.Summary;
  test_ids: string[];
}

/** Reads runs/<run_id>/results.json, or null when the run has none yet. */
export function readResults(ctx: RunContext, runId: string): Results.RunResults | null {
  if (!RUN_ID.test(runId)) {
    throw new RunError(`"${runId}" is not a run id`);
  }
  const file = artifactsDir(ctx, 'runs', runId, 'results.json');
  if (!existsSync(file)) {
    return null;
  }
  const checked = validate('results', JSON.parse(readFileSync(file, 'utf8')));
  if (!checked.ok) {
    throw new RunError(`results.json for ${runId} does not match results.schema.json`);
  }
  return checked.value;
}

function summarise(ctx: RunContext, runId: string): RunSummary | null {
  const results = readResults(ctx, runId);
  if (results !== null) {
    const env = results.environment;
    return {
      run_id: runId,
      story_id: results.story_id,
      state: 'complete',
      started_at: results.started_at,
      finished_at: results.finished_at,
      ...(results.rerun_of === undefined ? {} : { rerun_of: results.rerun_of }),
      ...(env.commit === undefined ? {} : { commit: env.commit }),
      ...(env.dirty === undefined ? {} : { dirty: env.dirty }),
      ...(results.summary === undefined ? {} : { summary: results.summary }),
      test_ids: results.tests.map((t) => t.test_id),
    };
  }
  if (!existsSync(artifactsDir(ctx, 'runs', runId, 'run-state.json'))) {
    return null;
  }
  const state = loadRun(ctx, runId);
  return {
    run_id: runId,
    story_id: state.story_id,
    state: 'in-progress',
    started_at: state.started_at,
    ...(state.rerun_of === undefined ? {} : { rerun_of: state.rerun_of }),
    ...(state.environment.commit === undefined ? {} : { commit: state.environment.commit }),
    test_ids: state.test_ids,
  };
}

/** Runs under the artifacts root, newest first. Folders that are not runs are ignored. */
export function listRuns(
  ctx: RunContext,
  options: { story?: string; limit?: number; completeOnly?: boolean } = {},
): RunSummary[] {
  if (options.story !== undefined && !STORY_ID.test(options.story)) {
    throw new RunError(`story id "${options.story}" must be lowercase letters, digits and dashes`);
  }
  const dir = artifactsDir(ctx, 'runs');
  if (!existsSync(dir)) {
    return [];
  }
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareRunIds)
    .reverse();
  const runs: RunSummary[] = [];
  for (const id of ids) {
    const run = summarise(ctx, id);
    if (
      run === null ||
      (options.story !== undefined && run.story_id !== options.story) ||
      (options.completeOnly === true && run.state !== 'complete')
    ) {
      continue;
    }
    runs.push(run);
    if (options.limit !== undefined && runs.length >= options.limit) {
      break;
    }
  }
  return runs;
}

/** The given run's results, or the newest complete run's (for the story, when given). */
export function resolveCompleteRun(
  ctx: RunContext,
  runId?: string,
  story?: string,
): Results.RunResults {
  if (runId !== undefined) {
    const results = readResults(ctx, runId);
    if (results === null) {
      throw new RunError(`run ${runId} has no results.json yet; call write_results first`);
    }
    if (story !== undefined && results.story_id !== story) {
      throw new RunError(`run ${runId} is for story "${results.story_id}", not "${story}"`);
    }
    return results;
  }
  const [latest] = listRuns(ctx, { completeOnly: true, limit: 1, ...(story ? { story } : {}) });
  const results = latest === undefined ? null : readResults(ctx, latest.run_id);
  if (results === null) {
    throw new RunError(
      story === undefined ? 'no completed runs yet' : `no completed runs for story "${story}"`,
    );
  }
  return results;
}

export interface FailedTest {
  test_id: string;
  status: 'failed' | 'error';
  step_index?: number;
  message?: string;
  triage?: Results.Triage;
}

/** Tests that failed or errored in a run, with where they failed. */
export function failedTests(results: Results.RunResults): FailedTest[] {
  return results.tests.flatMap((t) =>
    t.status === 'failed' || t.status === 'error'
      ? [
          {
            test_id: t.test_id,
            status: t.status,
            ...(t.failure?.step_index === undefined ? {} : { step_index: t.failure.step_index }),
            ...(t.failure === undefined ? {} : { message: t.failure.message }),
            ...(t.triage === undefined ? {} : { triage: t.triage }),
          },
        ]
      : [],
  );
}
