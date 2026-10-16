// Checks a plan's targets and paths against the frontend map, so wrong routes and selectors
// are caught before the plan is approved, not during a run.
import { findRoute, patternMatch } from '../context/query.js';
import type { FrontendMap, Selector } from '../context/types.js';
import type { Plan } from '../schemas/generated/index.js';
import type { PlanWarning } from './plans.js';

function selectorsOf(map: FrontendMap, kind: Selector['kind'] | Selector['kind'][]): Selector[] {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return Object.values(map.modules).flatMap((m) =>
    m.selectors.filter((s) => kinds.includes(s.kind)),
  );
}

function includesText(haystack: string, needle: string, exact: boolean): boolean {
  const a = haystack.toLowerCase().trim();
  const b = needle.toLowerCase().trim();
  return exact ? a === b : a.includes(b) || b.includes(a);
}

/** Why a target is not in the map, or null when it is (or cannot be checked statically). */
export function targetProblem(map: FrontendMap, target: Plan.Target): string | null {
  const exact = target.exact === true;
  switch (target.strategy) {
    case 'testid': {
      const known = selectorsOf(map, 'testid');
      return known.some((s) => patternMatch(s.value, target.value) || s.value === target.value)
        ? null
        : `testid "${target.value}" is not in the frontend map`;
    }
    case 'label':
      return selectorsOf(map, ['label', 'aria-label']).some((s) =>
        includesText(s.value, target.value, exact),
      )
        ? null
        : `no label "${target.value}" in the frontend map`;
    case 'placeholder':
      return selectorsOf(map, 'placeholder').some((s) => includesText(s.value, target.value, exact))
        ? null
        : `no placeholder "${target.value}" in the frontend map`;
    case 'text':
      return selectorsOf(map, ['text', 'label']).some((s) =>
        includesText(s.value, target.value, exact),
      )
        ? null
        : `no visible text "${target.value}" in the frontend map`;
    case 'role': {
      // Implicit roles (button, link, textbox...) are not in the source; only the name is checked.
      if (target.name === undefined) return null;
      const name = target.name;
      return selectorsOf(map, ['text', 'label', 'aria-label']).some((s) =>
        s.pattern ? patternMatch(s.value, name) : includesText(s.value, name, exact),
      )
        ? null
        : `no element named "${name}" in the frontend map`;
    }
    case 'css':
      return null;
  }
}

/** Warnings for paths and targets that the frontend map does not know. */
export function mapWarnings(plan: Plan.TestPlan, map: FrontendMap): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  plan.tests.forEach((test, i) => {
    const start = test.preconditions.start_path;
    if (start !== undefined && findRoute(map, start.split('?')[0] ?? start) === undefined) {
      warnings.push({
        path: `/tests/${String(i)}/preconditions/start_path`,
        message: `test "${test.id}": start path ${start} matches no route`,
      });
    }
    test.steps.forEach((step, j) => {
      const where = `/tests/${String(i)}/steps/${String(j)}`;
      const label = `test "${test.id}" step ${String(j + 1)}`;
      if (step.action === 'navigate' && step.value !== undefined) {
        const path = step.value.split('?')[0] ?? step.value;
        if (findRoute(map, path) === undefined) {
          warnings.push({
            path: `${where}/value`,
            message: `${label}: path ${step.value} matches no route`,
          });
        }
      }
      if (step.target !== undefined) {
        const problem = targetProblem(map, step.target);
        if (problem !== null)
          warnings.push({ path: `${where}/target`, message: `${label}: ${problem}` });
      }
    });
  });
  return warnings;
}
