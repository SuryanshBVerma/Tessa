import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/index.js';
import type { Plan, Results } from '../schemas/generated/index.js';
import { validate } from '../schemas/index.js';
import { resolveInside } from '../util/paths.js';

export const RUN_ID = /^[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}

export interface StepRecord {
  index: number;
  attempt: number;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  screenshot?: string;
  expected?: string;
  actual?: string;
  error?: string;
  selector_used?: string;
}

export interface RunState {
  version: 1;
  run_id: string;
  story_id: string;
  /** Plan path relative to the artifacts root. */
  plan: string;
  started_at: string;
  test_ids: string[];
  host: Results.RunEnvironment['host'];
  environment: Omit<Results.RunEnvironment, 'host'>;
  env_states: Record<string, Results.EnvState>;
  steps: Record<string, StepRecord[]>;
}

export interface RunContext {
  config: ResolvedConfig;
  workspace: string;
}

export function artifactsDir(ctx: RunContext, ...parts: string[]): string {
  return resolveInside(ctx.workspace, join(ctx.config.artifacts.root, ...parts));
}

export function planPath(storyId: string): string {
  return `plans/${storyId}/tests.json`;
}

export function loadPlan(ctx: RunContext, storyId: string): Plan.TestPlan {
  if (!ID.test(storyId)) {
    throw new RunError(`story id "${storyId}" must be lowercase letters, digits and dashes`);
  }
  const file = artifactsDir(ctx, planPath(storyId));
  if (!existsSync(file)) {
    throw new RunError(`no plan at ${ctx.config.artifacts.root}/${planPath(storyId)}`);
  }
  const text = readFileSync(file, 'utf8');
  if (text.length > MAX_PLAN_BYTES) {
    throw new RunError('plan is larger than 2 MB');
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new RunError(`plan is not valid JSON: ${error instanceof Error ? error.message : ''}`);
  }
  const checked = validate('test-ir', data);
  if (!checked.ok) {
    throw new RunError(
      `plan does not match test-ir.schema.json:\n${checked.issues
        .map((i) => `  ${i.path}: ${i.message}`)
        .join('\n')}`,
    );
  }
  const personas = new Set(ctx.config.personas.map((p) => p.name));
  const profiles = new Set(Object.keys(ctx.config.db.profiles));
  const ids = new Set<string>();
  for (const test of checked.value.tests) {
    if (ids.has(test.id)) {
      throw new RunError(`plan has two tests with id "${test.id}"`);
    }
    ids.add(test.id);
    if (!personas.has(test.persona)) {
      throw new RunError(`test "${test.id}" uses unknown persona "${test.persona}"`);
    }
    if (!profiles.has(test.preconditions.seed_profile)) {
      throw new RunError(
        `test "${test.id}" uses unknown seed profile "${test.preconditions.seed_profile}"`,
      );
    }
  }
  return checked.value;
}

function timestampId(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function newRunId(ctx: RunContext, now = new Date()): string {
  const base = timestampId(now);
  let id = base;
  for (let n = 2; existsSync(artifactsDir(ctx, 'runs', id)); n++) {
    id = `${base}-${String(n)}`;
  }
  return id;
}

function statePath(ctx: RunContext, runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new RunError(`"${runId}" is not a run id`);
  }
  return artifactsDir(ctx, 'runs', runId, 'run-state.json');
}

export function loadRun(ctx: RunContext, runId: string): RunState {
  const file = statePath(ctx, runId);
  if (!existsSync(file)) {
    throw new RunError(`no run "${runId}"; start one with begin_run`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

/** Writes via a temp file and rename, so a crash never leaves half a file. */
export function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, file);
}

export function saveRun(ctx: RunContext, state: RunState): void {
  writeAtomic(statePath(ctx, state.run_id), `${JSON.stringify(state, null, 2)}\n`);
}

export function createRun(
  ctx: RunContext,
  plan: Plan.TestPlan,
  environment: Omit<Results.RunEnvironment, 'host'>,
  options: { testIds?: string[]; host?: Results.RunEnvironment['host'] } = {},
): { state: RunState; tests: Plan.Test[] } {
  const wanted = options.testIds;
  if (wanted !== undefined) {
    const known = new Set(plan.tests.map((t) => t.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new RunError(`plan has no tests: ${unknown.join(', ')}`);
    }
  }
  const tests = wanted === undefined ? plan.tests : plan.tests.filter((t) => wanted.includes(t.id));
  const runId = newRunId(ctx);
  mkdirSync(artifactsDir(ctx, 'runs', runId, 'screenshots'), { recursive: true });
  const state: RunState = {
    version: 1,
    run_id: runId,
    story_id: plan.story.id,
    plan: planPath(plan.story.id),
    started_at: new Date().toISOString(),
    test_ids: tests.map((t) => t.id),
    host: options.host ?? 'other',
    environment,
    env_states: {},
    steps: Object.fromEntries(tests.map((t) => [t.id, []])),
  };
  saveRun(ctx, state);
  return { state, tests };
}
