import type { Results } from '../schemas/generated/index.js';
import { validate } from '../schemas/index.js';
import { readResults } from './history.js';
import { artifactsDir, loadRun, RunError, saveRun, writeAtomic, type RunContext } from './store.js';

/** Whether a test result is something triage can explain: a failure, or a pass that needed retries. */
export function needsTriage(test: Results.TestResult): boolean {
  return (
    test.status === 'failed' ||
    test.status === 'error' ||
    (test.quality?.rerun_consistency !== undefined && test.quality.rerun_consistency < 1)
  );
}

/**
 * Stores a triage finding for one test, in run-state.json (so write_results keeps it) and in
 * results.json. The finding is the triage agent's judgment, stored as data.
 */
export function recordTriage(
  ctx: RunContext,
  runId: string,
  testId: string,
  triage: Results.Triage,
): Results.RunResults {
  const results = readResults(ctx, runId);
  if (results === null) {
    throw new RunError(`run ${runId} has no results.json yet; call write_results first`);
  }
  const test = results.tests.find((t) => t.test_id === testId);
  if (test === undefined) {
    throw new RunError(`run ${runId} has no test "${testId}"`);
  }
  if (!needsTriage(test)) {
    throw new RunError(
      `test "${testId}" passed on its first attempt; triage is for failures and flaky passes`,
    );
  }
  test.triage = triage;
  const checked = validate('results', results);
  if (!checked.ok) {
    throw new RunError(
      `triage does not match results.schema.json: ${checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  const state = loadRun(ctx, runId);
  state.triage = { ...state.triage, [testId]: triage };
  saveRun(ctx, state);
  writeAtomic(
    artifactsDir(ctx, 'runs', runId, 'results.json'),
    `${JSON.stringify(checked.value, null, 2)}\n`,
  );
  return checked.value;
}
