import type { Plan, Results } from '../schemas/generated/index.js';
import { validate, type SchemaIssue } from '../schemas/index.js';
import type { RunState, StepRecord } from './store.js';

type TestStatus = Results.TestResult['status'];

/** Steps of one attempt, by plan step index. Later records for the same index win. */
function attemptSteps(records: readonly StepRecord[], attempt: number): StepRecord[] {
  const byIndex = new Map<number, StepRecord>();
  for (const record of records) {
    if (record.attempt === attempt) {
      byIndex.set(record.index, record);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function statusOf(steps: readonly StepRecord[], planSteps: number): TestStatus {
  if (steps.length === 0) {
    return 'skipped';
  }
  if (steps.some((s) => s.status === 'failed')) {
    return 'failed';
  }
  const passed = steps.filter((s) => s.status === 'passed').length;
  if (passed === planSteps) {
    return 'passed';
  }
  if (steps.every((s) => s.status === 'skipped')) {
    return 'skipped';
  }
  return 'error';
}

/** high: test IDs and roles only; medium: labels or placeholders; low: CSS or visible text. */
/** One string per step that identifies what it does, for comparing tests. */
function stepSignature(step: Plan.Step): string {
  const target =
    step.target === undefined
      ? ''
      : step.target.strategy === 'role'
        ? `role:${step.target.role}:${step.target.name ?? ''}`
        : `${step.target.strategy}:${step.target.value}`;
  return `${step.action}|${target}|${step.value ?? ''}|${JSON.stringify(step.assertion ?? null)}`;
}

export const OVERLAP_THRESHOLD = 0.8;

/**
 * For each test, the other tests for the same persona whose steps mostly match (Jaccard
 * similarity of step signatures at or above OVERLAP_THRESHOLD). The same steps run as a different
 * persona are a different test, usually a permission check, so they never count as overlap.
 */
export function overlaps(tests: readonly Plan.Test[]): Map<string, string[]> {
  const signatures = tests.map((t) => new Set(t.steps.map(stepSignature)));
  const result = new Map<string, string[]>(tests.map((t) => [t.id, []]));
  for (let i = 0; i < tests.length; i++) {
    for (let j = i + 1; j < tests.length; j++) {
      const a = signatures[i] ?? new Set<string>();
      const b = signatures[j] ?? new Set<string>();
      const shared = [...a].filter((sig) => b.has(sig)).length;
      const union = new Set([...a, ...b]).size;
      const ti = tests[i];
      const tj = tests[j];
      if (union > 0 && shared / union >= OVERLAP_THRESHOLD && ti?.persona === tj?.persona) {
        if (ti !== undefined && tj !== undefined) {
          result.get(ti.id)?.push(tj.id);
          result.get(tj.id)?.push(ti.id);
        }
      }
    }
  }
  return result;
}

export function selectorStability(test: Plan.Test): 'high' | 'medium' | 'low' {
  const strategies = test.steps.flatMap((step) =>
    step.target === undefined ? [] : [step.target.strategy],
  );
  if (strategies.some((s) => s === 'css' || s === 'text')) {
    return 'low';
  }
  if (strategies.some((s) => s === 'label' || s === 'placeholder')) {
    return 'medium';
  }
  return 'high';
}

function failureFor(
  status: TestStatus,
  steps: readonly StepRecord[],
  planSteps: number,
): Results.Failure | undefined {
  if (status !== 'failed' && status !== 'error') {
    return undefined;
  }
  const failed = steps.find((s) => s.status === 'failed');
  if (failed !== undefined) {
    return {
      step_index: failed.index,
      message: failed.error ?? failed.actual ?? 'Step failed',
      ...(failed.expected === undefined ? {} : { expected: failed.expected }),
      ...(failed.actual === undefined ? {} : { actual: failed.actual }),
      ...(failed.screenshot === undefined ? {} : { screenshot: failed.screenshot }),
    };
  }
  const recorded = new Set(steps.map((s) => s.index));
  let missing = 0;
  while (missing < planSteps && recorded.has(missing)) {
    missing++;
  }
  return {
    step_index: missing,
    message: `The executor stopped before recording step ${String(missing)}.`,
  };
}

function toStepResult(record: StepRecord): Results.StepResult {
  const step: Results.StepResult & { attempt?: number } = { ...record };
  delete step.attempt;
  return step;
}

export function buildResults(
  state: RunState,
  plan: Plan.TestPlan,
  finishedAt = new Date(),
): { ok: true; results: Results.RunResults } | { ok: false; issues: SchemaIssue[] } {
  const testsById = new Map(plan.tests.map((t) => [t.id, t]));
  const overlapping = overlaps(plan.tests);
  const tests: Results.TestResult[] = [];

  for (const testId of state.test_ids) {
    const test = testsById.get(testId);
    if (test === undefined) {
      continue;
    }
    const records = state.steps[testId] ?? [];
    const attempts = Math.max(1, ...records.map((r) => r.attempt));
    const finalSteps = attemptSteps(records, attempts);
    const status = statusOf(finalSteps, test.steps.length);
    const attemptStatuses = Array.from({ length: attempts }, (_, i) =>
      statusOf(attemptSteps(records, i + 1), test.steps.length),
    );
    const consistent = attemptStatuses.filter((s) => s === status).length;
    const duration = finalSteps.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
    const failure = failureFor(status, finalSteps, test.steps.length);

    tests.push({
      test_id: testId,
      status,
      ...(duration > 0 ? { duration_ms: duration } : {}),
      attempts,
      env_state: state.env_states[test.persona] ?? {
        persona: test.persona,
        seed_profile: test.preconditions.seed_profile,
      },
      steps: finalSteps.map(toStepResult),
      ...(failure === undefined ? {} : { failure }),
      quality: {
        selector_stability: selectorStability(test),
        rerun_consistency: Math.round((consistent / attempts) * 100) / 100,
        overlap_with: overlapping.get(testId) ?? [],
      },
    });
  }

  const count = (s: TestStatus) => tests.filter((t) => t.status === s).length;
  const started = Date.parse(state.started_at);
  const results: Results.RunResults = {
    version: 1,
    run_id: state.run_id,
    story_id: state.story_id,
    plan: state.plan,
    started_at: state.started_at,
    finished_at: finishedAt.toISOString(),
    environment: { ...state.environment, host: state.host },
    summary: {
      total: tests.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      error: count('error'),
      duration_ms: Math.max(0, finishedAt.getTime() - started),
    },
    tests,
  };

  const checked = validate('results', results);
  return checked.ok ? { ok: true, results: checked.value } : { ok: false, issues: checked.issues };
}
