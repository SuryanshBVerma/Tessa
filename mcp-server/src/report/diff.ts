import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Diff, Plan, Results } from '../schemas/generated/index.js';
import { escapeHtml, fill, REPORT_TEMPLATE_DIR } from './render.js';

// Same relative depth from src/report and dist/report: mcp-server/templates/diff.
const DIFF_TEMPLATE_DIR = new URL('../../templates/diff/', import.meta.url);

type Change = Diff.TestDiff['change'];

/** Display order: what needs attention first, the unchanged passes last. */
const GROUPS: { change: Change; label: string }[] = [
  { change: 'regressed', label: 'Regressed' },
  { change: 'still-failing', label: 'Still failing' },
  { change: 'fixed', label: 'Fixed' },
  { change: 'changed-other', label: 'Changed' },
  { change: 'added', label: 'Added' },
  { change: 'removed', label: 'Removed' },
  { change: 'still-passing', label: 'Still passing' },
];

export interface DiffPageInput {
  diff: Diff.RunDiff;
  a: Results.RunResults;
  b: Results.RunResults;
  /** The current plan, for test titles and step descriptions; null when it cannot be read. */
  plan: Plan.TestPlan | null;
}

const e = escapeHtml;

function status(value: Results.TestResult['status'] | undefined): string {
  return value === undefined
    ? '<span class="status status-not-run">not run</span>'
    : `<span class="status status-${value}">${value}</span>`;
}

function seconds(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)} s`;
}

function shortCommit(commit: string | undefined, dirty: boolean | undefined): string {
  return commit === undefined
    ? ''
    : ` · ${commit.slice(0, 7)}${dirty === true ? ' (modified)' : ''}`;
}

function failureBlock(
  side: string,
  result: Results.TestResult | undefined,
  test: Plan.Test | undefined,
): string {
  const f = result?.failure;
  if (result === undefined || f === undefined) {
    return '';
  }
  const step = test?.steps[f.step_index];
  const where = ` at step ${String(f.step_index + 1)}${step === undefined ? '' : ` · ${step.description}`}`;
  const compare =
    f.expected !== undefined || f.actual !== undefined
      ? `<div class="compare"><div><span class="compare-label">Expected</span><p>${e(f.expected ?? '—')}</p></div><div><span class="compare-label">Actual</span><p>${e(f.actual ?? '—')}</p></div></div>`
      : '';
  return `<div class="callout" role="note"><p class="callout-title"><span class="side-label">${e(side)}</span> ${result.status === 'error' ? 'stopped' : 'failed'}${e(where)}</p><p class="callout-message">${e(f.message)}</p>${compare}</div>`;
}

function triageLine(result: Results.TestResult | undefined): string {
  const t = result?.triage;
  return t === undefined
    ? ''
    : `<p><span class="side-label">Triage</span> ${e(t.class)} (${e(t.confidence)} confidence) — ${e(t.rationale)}</p>`;
}

function testRow(
  entry: Diff.TestDiff,
  input: DiffPageInput,
  byId: { a: Map<string, Results.TestResult>; b: Map<string, Results.TestResult> },
  tests: Map<string, Plan.Test>,
): string {
  const test = tests.get(entry.test_id);
  const ra = byId.a.get(entry.test_id);
  const rb = byId.b.get(entry.test_id);
  const title = test?.name ?? entry.test_id;
  const summary = `<summary class="diff-row"><span><span class="test-name">${e(title)}</span><span class="test-id">${e(entry.test_id)}</span></span><span class="transition">${status(entry.status_a)}<span aria-label="to">→</span>${status(entry.status_b)}</span><span class="duration">${entry.duration_delta_ms === undefined ? '' : e(seconds(entry.duration_delta_ms))}</span></summary>`;
  const body = [
    entry.notes === undefined
      ? ''
      : `<p><span class="side-label">Notes</span> ${e(entry.notes)}</p>`,
    triageLine(rb ?? ra),
    failureBlock(`Run ${input.a.run_id}`, ra, test),
    failureBlock(`Run ${input.b.run_id}`, rb, test),
  ].join('');
  if (body === '') {
    // Nothing to expand: a plain row, with the summary markup kept for layout.
    return `<div class="test">${summary.replace('<summary', '<div').replace(/<\/summary>$/, '</div>')}</div>`;
  }
  return `<details class="test"${entry.change === 'regressed' ? ' open' : ''}>${summary}<div class="diff-body">${body}</div></details>`;
}

export function renderDiffHtml(input: DiffPageInput): string {
  const { diff, a, b, plan } = input;
  const tests = new Map((plan?.tests ?? []).map((t) => [t.id, t]));
  const byId = {
    a: new Map(a.tests.map((t) => [t.test_id, t])),
    b: new Map(b.tests.map((t) => [t.test_id, t])),
  };
  const storyTitle = plan?.story.title ?? diff.story_id ?? a.story_id;

  const stats = GROUPS.map(({ change, label }) => {
    const n = diff.tests.filter((t) => t.change === change).length;
    return n === 0
      ? ''
      : `<span class="stat" role="listitem"><strong>${String(n)}</strong>${e(label.toLowerCase())}</span>`;
  }).join('');

  const notes: string[] = [];
  if (diff.rerun_only === true) {
    notes.push(
      `Run ${b.run_id} reran only some tests of run ${a.run_id}; the tests it did not rerun are left out.`,
    );
  }
  if (diff.dirty_a === true || diff.dirty_b === true) {
    notes.push(
      'At least one run had uncommitted changes, so the commits do not fully describe the code that ran.',
    );
  }
  if (plan === null) {
    notes.push('The plan could not be read, so tests are shown by id.');
  }

  const groups = GROUPS.map(({ change, label }) => {
    const entries = diff.tests.filter((t) => t.change === change);
    if (entries.length === 0) {
      return '';
    }
    return `<section class="group group-${change}" aria-label="${e(label)}"><h2 class="group-title">${e(label)}<span class="count">${String(entries.length)}</span></h2><div class="list">${entries.map((entry) => testRow(entry, input, byId, tests)).join('')}</div></section>`;
  }).join('');

  const files =
    diff.changed_files === undefined
      ? ''
      : diff.changed_files.length === 0
        ? '<p class="footer-note">No committed file changes between the two runs.</p>'
        : `<details class="details group"><summary>Files changed between the two commits (${String(diff.changed_files.length)})</summary><ul class="files">${diff.changed_files.map((f) => `<li>${e(f)}</li>`).join('')}</ul></details>`;

  const body = `<header class="header"><p class="eyebrow">Tessa run diff</p><h1>${e(storyTitle)}</h1><p class="run-meta"><span>Baseline ${e(a.run_id)}${e(shortCommit(diff.commit_a, diff.dirty_a))}</span><span>Compared ${e(b.run_id)}${e(shortCommit(diff.commit_b, diff.dirty_b))}</span></p><div class="stats" role="list" aria-label="Summary">${stats}</div>${notes.length === 0 ? '' : `<div class="notes">${notes.map((n) => `<p>${e(n)}</p>`).join('')}</div>`}</header><main>${groups}${files}</main><p class="footer-note">Generated ${e(diff.created_at)}. Run output stays on this machine.</p>`;

  return fill(readFileSync(new URL('diff.html', DIFF_TEMPLATE_DIR), 'utf8'), {
    NONCE: randomBytes(16).toString('base64'),
    TITLE: e(`${storyTitle} · Tessa diff ${a.run_id} → ${b.run_id}`),
    STYLE: `${readFileSync(new URL('report.css', REPORT_TEMPLATE_DIR), 'utf8')}\n${readFileSync(new URL('diff.css', DIFF_TEMPLATE_DIR), 'utf8')}`,
    BODY: body,
  });
}
