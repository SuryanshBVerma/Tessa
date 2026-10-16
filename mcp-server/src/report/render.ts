import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ResolvedConfig } from '../config/index.js';
import type { Results } from '../schemas/generated/index.js';
import { validate } from '../schemas/index.js';
import { artifactsDir, loadPlan, RunError, RUN_ID, writeAtomic } from '../runs/store.js';

// Same relative depth from src/report and dist/report: mcp-server/templates/report.
export const REPORT_TEMPLATE_DIR = new URL('../../templates/report/', import.meta.url);

function template(name: string): string {
  return readFileSync(new URL(name, REPORT_TEMPLATE_DIR), 'utf8');
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * JSON that is safe inside <script type="application/json">: no "<" (so no "</script>" or
 * "<!--"), and no U+2028/U+2029, which some parsers treat as line ends.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/** Replaces {{NAME}} placeholders without interpreting "$" in the values. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Z]+)\}\}/g, (match, name: string) => values[name] ?? match);
}

export interface ReportContext {
  config: ResolvedConfig;
  workspace: string;
}

export function loadResults(ctx: ReportContext, runId: string): Results.RunResults {
  if (!RUN_ID.test(runId)) {
    throw new RunError(`"${runId}" is not a run id`);
  }
  const file = artifactsDir(ctx, 'runs', runId, 'results.json');
  if (!existsSync(file)) {
    throw new RunError(`run ${runId} has no results.json yet; call write_results first`);
  }
  const checked = validate('results', JSON.parse(readFileSync(file, 'utf8')));
  if (!checked.ok) {
    throw new RunError(`results.json for ${runId} does not match results.schema.json`);
  }
  return checked.value;
}

export function renderReportHtml(ctx: ReportContext, results: Results.RunResults): string {
  const plan = loadPlan(ctx, results.story_id);
  const ids = new Set(results.tests.map((t) => t.test_id));
  const nonce = randomBytes(16).toString('base64');
  const data = {
    story: plan.story,
    results,
    tests: plan.tests.filter((t) => ids.has(t.id)),
    options: {
      target: ctx.config.export.target,
      show_code_preview: ctx.config.review.show_code_preview,
      show_overlap: ctx.config.review.show_overlap,
    },
  };
  return fill(template('report.html'), {
    NONCE: nonce,
    TITLE: escapeHtml(`${plan.story.title} · Tessa report ${results.run_id}`),
    STYLE: template('report.css'),
    SCRIPT: template('report.js'),
    DATA: embedJson(data),
  });
}

/** Renders runs/<run_id>/report.html from results.json and the plan. */
export function renderReport(ctx: ReportContext, runId: string): { path: string; tests: number } {
  const results = loadResults(ctx, runId);
  const html = renderReportHtml(ctx, results);
  writeAtomic(artifactsDir(ctx, 'runs', runId, 'report.html'), html);
  return {
    path: `${ctx.config.artifacts.root}/runs/${runId}/report.html`,
    tests: results.tests.length,
  };
}
