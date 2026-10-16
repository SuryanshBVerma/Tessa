import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SCHEMA_NAMES, SCHEMAS_DIR, validate, type SchemaName } from '../src/schemas/index.js';

function example(file: string): unknown {
  const text = readFileSync(new URL(`examples/${file}`, SCHEMAS_DIR), 'utf8');
  return file.endsWith('.yaml') ? parse(text) : JSON.parse(text);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const EXAMPLES: Record<SchemaName, string> = {
  config: 'config.example.yaml',
  'test-ir': 'tests.example.json',
  results: 'results.example.json',
  selection: 'selection.example.json',
  'run-diff': 'run-diff.example.json',
};

function issuesOf(name: SchemaName, data: unknown): string[] {
  const result = validate(name, data);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('schemas', () => {
  it.each(SCHEMA_NAMES)('%s schema compiles and accepts its example', (name) => {
    expect(issuesOf(name, example(EXAMPLES[name]))).toEqual([]);
  });
});

describe('config schema', () => {
  const base = example('config.example.yaml') as Record<string, any>;

  it('rejects unknown properties with a readable message', () => {
    const config = clone(base);
    config.app.strat = 'npm start';
    expect(issuesOf('config', config)).toContain('/app: unknown property "strat"');
  });

  it.each(['postgres.example.com', '10.0.0.5', '0.0.0.0'])(
    'rejects non-local allowed host %s',
    (host) => {
      const config = clone(base);
      config.db.allowed_hosts = ['localhost', host];
      expect(issuesOf('config', config).some((i) => i.startsWith('/db/allowed_hosts/1'))).toBe(
        true,
      );
    },
  );

  it.each(['https://staging.example.com', 'http://10.0.0.5:3000', 'http://localhost.example.com'])(
    'rejects non-local app url %s',
    (url) => {
      const config = clone(base);
      config.app.url = url;
      expect(issuesOf('config', config).some((i) => i.startsWith('/app/url'))).toBe(true);
    },
  );

  it.each(['../outside.sql', '/etc/passwd.sql', 'C:/seed.sql', 'scripts/../../x.sql', 'seed.txt'])(
    'rejects unsafe seed path %s',
    (path) => {
      const config = clone(base);
      config.db.profiles.default = [path];
      expect(issuesOf('config', config).length).toBeGreaterThan(0);
    },
  );

  it('only allows manual auth', () => {
    const config = clone(base);
    config.auth.mode = 'scripted';
    expect(issuesOf('config', config)).toContain('/auth/mode: must be "manual"');
  });

  it('requires mcp_server and query_mapping for an external knowledge graph', () => {
    const config = clone(base);
    config.context.knowledge_graph = { enabled: true, mode: 'external' };
    const issues = issuesOf('config', config);
    expect(issues).toContain('/context/knowledge_graph: missing required property "mcp_server"');
    expect(issues).toContain('/context/knowledge_graph: missing required property "query_mapping"');
  });
});

describe('test-ir schema', () => {
  const base = example('tests.example.json') as Record<string, any>;

  function withStep(step: unknown) {
    const plan = clone(base);
    plan.tests[0].steps = [step];
    return plan;
  }

  it('requires a target for click', () => {
    expect(issuesOf('test-ir', withStep({ action: 'click', description: 'Click' }))).toContain(
      '/tests/0/steps/0: missing required property "target"',
    );
  });

  it('requires navigate values to be paths', () => {
    const issues = issuesOf(
      'test-ir',
      withStep({ action: 'navigate', description: 'Go', value: 'https://example.com' }),
    );
    expect(issues.some((i) => i.startsWith('/tests/0/steps/0/value'))).toBe(true);
  });

  it('requires exactly one of value or value_env for fill', () => {
    const target = { strategy: 'testid', value: 'x' };
    expect(
      issuesOf('test-ir', withStep({ action: 'fill', description: 'Type', target })).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf(
        'test-ir',
        withStep({ action: 'fill', description: 'Type', target, value: 'a', value_env: 'A' }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf(
        'test-ir',
        withStep({ action: 'fill', description: 'Type', target, value_env: 'A' }),
      ),
    ).toEqual([]);
  });

  it('requires a target for element assertions but not page assertions', () => {
    expect(
      issuesOf(
        'test-ir',
        withStep({ action: 'assert', description: 'Shown', assertion: { kind: 'visible' } }),
      ),
    ).toContain('/tests/0/steps/0: missing required property "target"');
    expect(
      issuesOf(
        'test-ir',
        withStep({
          action: 'assert',
          description: 'On page',
          assertion: { kind: 'url-matches', expected: '^/x$' },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects role targets without a role', () => {
    const issues = issuesOf(
      'test-ir',
      withStep({ action: 'click', description: 'Click', target: { strategy: 'role' } }),
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('results schema', () => {
  const base = example('results.example.json') as Record<string, any>;

  it('requires failure details on failed tests', () => {
    const results = clone(base);
    delete results.tests[1].failure;
    expect(issuesOf('results', results)).toContain('/tests/1: missing required property "failure"');
  });

  it('rejects screenshot paths that escape the run directory', () => {
    const results = clone(base);
    results.tests[0].steps[0].screenshot = '../../secrets.png';
    expect(issuesOf('results', results).length).toBeGreaterThan(0);
  });
});

describe('selection schema', () => {
  it('rejects duplicate test ids', () => {
    const selection = clone(example('selection.example.json')) as Record<string, any>;
    selection.selected_test_ids = ['a', 'a'];
    expect(issuesOf('selection', selection).length).toBeGreaterThan(0);
  });

  it('has nowhere to put a session token', () => {
    const selection = clone(example('selection.example.json')) as Record<string, any>;
    selection.token = 'abc';
    expect(issuesOf('selection', selection)).toContain('/: unknown property "token"');
  });
});

describe('run-diff schema', () => {
  it('requires both statuses unless a test was added or removed', () => {
    const diff = clone(example('run-diff.example.json')) as Record<string, any>;
    delete diff.tests[0].status_b;
    expect(issuesOf('run-diff', diff)).toContain('/tests/0: missing required property "status_b"');
  });
});
