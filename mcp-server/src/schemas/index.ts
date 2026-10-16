import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { RunDiff, RunResults, Selection, TessaConfig, TestPlan } from './generated/index.js';

export type { RunDiff, RunResults, Selection, TessaConfig, TestPlan };

export const SCHEMA_NAMES = ['config', 'test-ir', 'results', 'selection', 'run-diff'] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

interface SchemaTypes {
  config: TessaConfig;
  'test-ir': TestPlan;
  results: RunResults;
  selection: Selection;
  'run-diff': RunDiff;
}

// Same relative depth from src/schemas and dist/schemas: <repo>/schemas.
export const SCHEMAS_DIR = new URL('../../../schemas/', import.meta.url);

export function schemaUrl(name: SchemaName): URL {
  return new URL(`${name}.schema.json`, SCHEMAS_DIR);
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaUrl(name), 'utf8')) as Record<string, unknown>;
}

// Strict mode still rejects unknown keywords and formats. strictRequired and strictTypes are off
// because they reject standard idioms such as `if/then: { required }` and union types.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
  allowUnionTypes: true,
});
addFormats.default(ajv, ['date-time']);

const validators = new Map<SchemaName, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  let validate = validators.get(name);
  if (validate === undefined) {
    validate = ajv.compile(loadSchema(name));
    validators.set(name, validate);
  }
  return validate;
}

export interface SchemaIssue {
  /** JSON Pointer to the offending value, e.g. /personas/0/seed_profile. */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

function describe(error: ErrorObject): SchemaIssue {
  const path = error.instancePath === '' ? '/' : error.instancePath;
  switch (error.keyword) {
    case 'additionalProperties': {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      return { path, message: `unknown property "${extra}"` };
    }
    case 'required': {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      return { path, message: `missing required property "${missing}"` };
    }
    case 'enum': {
      const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
      return {
        path,
        message: `must be one of: ${allowed.map((v) => JSON.stringify(v)).join(', ')}`,
      };
    }
    case 'const': {
      const allowed = (error.params as { allowedValue: unknown }).allowedValue;
      return { path, message: `must be ${JSON.stringify(allowed)}` };
    }
    default:
      return { path, message: error.message ?? `failed ${error.keyword}` };
  }
}

// Keywords that only say "a sub-schema failed"; the specific errors underneath are kept.
const NOISE = new Set(['if', 'anyOf', 'oneOf', 'allOf', 'not']);

export function toIssues(errors: readonly ErrorObject[]): SchemaIssue[] {
  const specific = errors.filter((error) => !NOISE.has(error.keyword));
  const chosen = specific.length > 0 ? specific : errors;
  const seen = new Set<string>();
  const issues: SchemaIssue[] = [];
  for (const issue of chosen.map(describe)) {
    const key = `${issue.path}\u0000${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  }
  return issues;
}

export function validate<N extends SchemaName>(
  name: N,
  data: unknown,
): ValidationResult<SchemaTypes[N]> {
  const check = validatorFor(name);
  if (check(data)) {
    return { ok: true, value: data as SchemaTypes[N] };
  }
  return { ok: false, issues: toIssues(check.errors ?? []) };
}

export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
}
