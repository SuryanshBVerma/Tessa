import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadMap } from '../context/build.js';
import type { Plan } from '../schemas/generated/index.js';
import { mapWarnings } from './map-check.js';
import {
  artifactsDir,
  checkPlan,
  planPath,
  readPlanText,
  RunError,
  STORY_ID,
  writeAtomic,
  type RunContext,
} from '../runs/store.js';

export interface PlanWarning {
  path: string;
  message: string;
}

export interface Approval {
  version: 1;
  story_id: string;
  /** SHA-256 of tests.json's content (canonical JSON) as approved. Any later edit to a value makes the approval stale. */
  plan_sha256: string;
  approved_at: string;
  /** How approval was given. Always the user, in the chat with the agent. */
  approved_via: 'chat';
  note?: string;
}

export type ApprovalState = 'approved' | 'stale' | 'unapproved';

function approvalPath(storyId: string): string {
  return `plans/${storyId}/approval.json`;
}

/** JSON with object keys sorted at every level, so equal content always serialises the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash of the plan's content. Formatting (a formatter rewrapping arrays, line endings, key
 * order) never changes it, so approvals survive a repository's formatter; any changed value does.
 */
export function planHash(text: string): string {
  let content: string;
  try {
    content = canonicalJson(JSON.parse(text));
  } catch {
    content = text.replaceAll('\r\n', '\n');
  }
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function planText(plan: Plan.TestPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** Things worth showing the user before approval that do not make the plan invalid. */
export function planWarnings(plan: Plan.TestPlan): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const criteria = plan.story.acceptance_criteria ?? [];
  if (criteria.length === 0) {
    warnings.push({
      path: '/story/acceptance_criteria',
      message: 'story has no acceptance criteria',
    });
  }
  const covered = new Set(plan.tests.flatMap((t) => t.criteria ?? []));
  for (const c of criteria) {
    if (!covered.has(c.id)) {
      warnings.push({
        path: '/story/acceptance_criteria',
        message: `acceptance criterion ${c.id} is not covered by any test`,
      });
    }
  }
  plan.tests.forEach((test, i) => {
    if (!test.steps.some((s) => s.action === 'assert')) {
      warnings.push({
        path: `/tests/${String(i)}`,
        message: `test "${test.id}" has no assert step`,
      });
    }
    test.steps.forEach((step, j) => {
      if (step.target?.strategy === 'css') {
        warnings.push({
          path: `/tests/${String(i)}/steps/${String(j)}/target`,
          message: `test "${test.id}" step ${String(j + 1)} uses a CSS selector, which is fragile`,
        });
      }
    });
  });
  return warnings;
}

function describeTarget(step: Plan.Step): string {
  const t = step.target;
  if (t === undefined) return '';
  return t.strategy === 'role'
    ? ` role \`${t.role}\`${t.name === undefined ? '' : ` "${t.name}"`}`
    : ` ${t.strategy} \`${t.value}\``;
}

/** Escapes Markdown in story text and keeps it on one line. */
function md(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/** A human-readable view of the plan, rendered deterministically from tests.json. */
export function renderPlanMarkdown(plan: Plan.TestPlan, warnings: PlanWarning[]): string {
  const lines: string[] = [
    `# Test plan: ${md(plan.story.title)}`,
    '',
    `Story \`${plan.story.id}\`${plan.story.source === undefined ? '' : ` from ${md(plan.story.source)}`}. ${String(plan.tests.length)} test(s).`,
    '',
    'Generated from `tests.json` by tessa-mcp. Edit `tests.json`, not this file.',
    '',
  ];
  const criteria = plan.story.acceptance_criteria ?? [];
  if (criteria.length > 0) {
    lines.push('## Acceptance criteria', '', '| ID | Criterion | Tests |', '| --- | --- | --- |');
    for (const c of criteria) {
      const tests = plan.tests.filter((t) => t.criteria?.includes(c.id)).map((t) => `\`${t.id}\``);
      lines.push(
        `| ${c.id} | ${md(c.text)} | ${tests.length > 0 ? tests.join(', ') : '**none**'} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Tests', '');
  for (const test of plan.tests) {
    const pre = test.preconditions;
    const extras = [
      `seed \`${pre.seed_profile}\``,
      pre.start_path === undefined ? null : `starts at \`${pre.start_path}\``,
      pre.feature_flags === undefined
        ? null
        : `flags ${Object.entries(pre.feature_flags)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(', ')}`,
    ].filter((x) => x !== null);
    lines.push(
      `### ${md(test.name)}`,
      '',
      `\`${test.id}\` · persona **${test.persona}** · ${extras.join(' · ')}`,
      '',
      md(test.intent),
      '',
    );
    test.steps.forEach((step, i) => {
      const value =
        step.value_env !== undefined
          ? ` (value from \`$${step.value_env}\`)`
          : step.value === undefined
            ? ''
            : ` → \`${step.value.replaceAll('`', "'")}\``;
      const assertion =
        step.assertion === undefined
          ? ''
          : ` — ${step.assertion.kind}${'expected' in step.assertion ? ` \`${String(step.assertion.expected)}\`` : ''}`;
      lines.push(
        `${String(i + 1)}. ${md(step.description)} _(${step.action}${describeTarget(step)}${value}${assertion})_`,
      );
    });
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('## Check before approving', '');
    for (const w of warnings) lines.push(`- ${md(w.message)}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function readApproval(ctx: RunContext, storyId: string): Approval | null {
  const file = artifactsDir(ctx, approvalPath(storyId));
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Approval;
  } catch {
    return null;
  }
}

export function approvalState(ctx: RunContext, storyId: string): ApprovalState {
  const approval = readApproval(ctx, storyId);
  if (approval === null) return 'unapproved';
  return approval.plan_sha256 === planHash(readPlanText(ctx, storyId)) ? 'approved' : 'stale';
}

export interface SaveResult {
  story_id: string;
  plan_path: string;
  markdown_path: string;
  tests: number;
  warnings: PlanWarning[];
  /** Whether targets and paths were checked against the frontend map. */
  checked_against_map: boolean;
  approval: ApprovalState;
}

/** Validates and writes plans/<story>/tests.json and plan.md. */
export function savePlan(ctx: RunContext, data: unknown): SaveResult {
  const plan = checkPlan(ctx, data);
  const storyId = plan.story.id;
  if (!STORY_ID.test(storyId)) {
    throw new RunError(`story id "${storyId}" must be lowercase letters, digits and dashes`);
  }
  const text = planText(plan);
  const map = loadMap(ctx);
  const warnings = [...planWarnings(plan), ...(map === null ? [] : mapWarnings(plan, map))];
  const file = artifactsDir(ctx, planPath(storyId));
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, text);
  writeAtomic(artifactsDir(ctx, `plans/${storyId}/plan.md`), renderPlanMarkdown(plan, warnings));
  const root = ctx.config.artifacts.root;
  return {
    story_id: storyId,
    plan_path: `${root}/${planPath(storyId)}`,
    markdown_path: `${root}/plans/${storyId}/plan.md`,
    tests: plan.tests.length,
    warnings,
    checked_against_map: map !== null,
    approval: approvalState(ctx, storyId),
  };
}

/** Records the user's approval of the plan as it is on disk now. */
export function approvePlan(ctx: RunContext, storyId: string, note?: string): Approval {
  const text = readPlanText(ctx, storyId);
  checkPlan(ctx, JSON.parse(text));
  const approval: Approval = {
    version: 1,
    story_id: storyId,
    plan_sha256: planHash(text),
    approved_at: new Date().toISOString(),
    approved_via: 'chat',
    ...(note === undefined ? {} : { note }),
  };
  writeAtomic(artifactsDir(ctx, approvalPath(storyId)), `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

export function requireApproved(ctx: RunContext, storyId: string): void {
  const state = approvalState(ctx, storyId);
  if (state === 'unapproved') {
    throw new RunError(
      `the plan for "${storyId}" has not been approved. Show the user plan.md and call approve_plan only after they approve it.`,
    );
  }
  if (state === 'stale') {
    throw new RunError(
      `the plan for "${storyId}" changed after it was approved. Show the user the changes and ask them to approve it again.`,
    );
  }
}
