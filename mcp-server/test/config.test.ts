import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { DEFAULTS, detectStack, loadConfig } from '../src/config/index.js';
import { loadSchema, SCHEMAS_DIR } from '../src/schemas/index.js';
import { PathEscapeError, resolveInside } from '../src/util/paths.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_APP = join(REPO_ROOT, 'testing', 'sample-app');
const EXAMPLE = readFileSync(new URL('examples/config.example.yaml', SCHEMAS_DIR), 'utf8');

const workspaces: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tessa-config-'));
  workspaces.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const SEEDS = {
  'scripts/seed/base.sql': '',
  'scripts/seed/users.sql': '',
  'scripts/seed/admins.sql': '',
  'scripts/seed/tickets.sql': '',
};

function withConfig(config: string, extra: Record<string, string> = SEEDS): string {
  return workspace({ '.tessa/config.yaml': config, ...extra });
}

function messages(result: ReturnType<typeof loadConfig>): string[] {
  return result.issues.map((i) => `${i.severity} ${i.path}: ${i.message}`);
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('loads the example config and fills in defaults', () => {
    const result = loadConfig({ workspace: withConfig(EXAMPLE) });
    expect(messages(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.config.app.start_timeout_seconds).toBe(60);
    expect(result.config.app.cwd).toBe('.');
    expect(result.config.db.url_env).toBe('DATABASE_URL');
    expect(result.config.review.idle_timeout_minutes).toBe(30);
    expect(result.config.models.planner).toBe('auto');
    expect(result.config.context.knowledge_graph).toEqual({
      enabled: false,
      mode: 'builtin',
      max_staleness_commits: 20,
    });
  });

  it('lets models.default fill unset roles', () => {
    const config = EXAMPLE.replace(
      'models:\n  default: auto',
      'models:\n  default: big-model\n  executor: fast-model',
    );
    const result = loadConfig({ workspace: withConfig(config) });
    expect(result.ok && result.config.models).toMatchObject({
      planner: 'big-model',
      executor: 'fast-model',
    });
  });

  it('points to /tessa-init when there is no config', () => {
    const result = loadConfig({ workspace: workspace() });
    expect(result.ok).toBe(false);
    expect(messages(result)[0]).toMatch(/\/tessa-init/);
  });

  it('refuses a config path outside the workspace', () => {
    const result = loadConfig({ workspace: workspace(), file: '../elsewhere/config.yaml' });
    expect(messages(result)[0]).toMatch(/outside the workspace/);
  });

  it('rejects duplicate YAML keys', () => {
    const result = loadConfig({ workspace: withConfig(`${EXAMPLE}\nversion: 1\n`) });
    expect(result.ok).toBe(false);
    expect(messages(result)[0]).toMatch(/YAML/);
  });

  it('rejects alias expansion bombs', () => {
    const levels = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]'];
    for (let i = 1; i < 9; i++) {
      const prev = String.fromCharCode(96 + i);
      const next = String.fromCharCode(97 + i);
      levels.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(',')}]`);
    }
    const result = loadConfig({ workspace: withConfig(levels.join('\n')) });
    expect(result.ok).toBe(false);
    expect(messages(result)[0]).toMatch(/YAML/);
  });

  it('reports schema problems with paths', () => {
    const result = loadConfig({
      workspace: withConfig(
        EXAMPLE.replace("url: 'http://127.0.0.1:5173'", "url: 'https://staging.example.com'"),
      ),
    });
    expect(result.ok).toBe(false);
    expect(messages(result).some((m) => m.startsWith('error /app/url'))).toBe(true);
  });

  it('rejects a persona whose seed profile does not exist', () => {
    const result = loadConfig({
      workspace: withConfig(EXAMPLE.replace('seed_profile: admin-heavy', 'seed_profile: nope')),
    });
    expect(messages(result)).toContain(
      'error /personas/2/seed_profile: unknown seed profile "nope"; defined: default, admin-heavy',
    );
  });

  it('rejects duplicate persona names', () => {
    const result = loadConfig({
      workspace: withConfig(EXAMPLE.replace('- name: admin', '- name: viewer')),
    });
    expect(messages(result)).toContain('error /personas/2/name: duplicate persona "viewer"');
  });

  it('rejects seed files that do not exist', () => {
    const rest: Record<string, string> = { ...SEEDS };
    delete rest['scripts/seed/admins.sql'];
    const result = loadConfig({ workspace: withConfig(EXAMPLE, rest) });
    expect(messages(result)).toContain(
      'error /db/profiles/admin-heavy/1: file "scripts/seed/admins.sql" does not exist',
    );
  });

  it('warns, but loads, when no adapter exists for the stack', () => {
    const config = EXAMPLE.replace('stack: react-router', 'stack: svelte').replace(
      'adapter: react-router',
      'adapter: svelte',
    );
    const result = loadConfig({ workspace: withConfig(config) });
    expect(result.ok).toBe(true);
    expect(messages(result)[0]).toMatch(
      /^warning \/context\/static_map\/adapter: no built-in adapter/,
    );
  });

  it('accepts a minimal config', () => {
    const minimal = stringify({
      version: 1,
      app: { start: 'npm run dev', url: 'http://localhost:3000', stack: 'react-router' },
      db: { allowed_hosts: ['localhost'], profiles: { default: ['scripts/seed/base.sql'] } },
      auth: { mode: 'manual' },
      personas: [{ name: 'user', seed_profile: 'default' }],
    });
    const result = loadConfig({ workspace: withConfig(minimal) });
    expect(messages(result)).toEqual([]);
    expect(result.ok && result.config.context.static_map.adapter).toBe('react-router');
    expect(result.ok && result.config.context.hints).toBe('ai-test-artifacts/context/hints.md');
  });
});

describe('DEFAULTS', () => {
  it('match the default keywords in config.schema.json', () => {
    const schema = loadSchema('config') as { $defs: Record<string, any> };
    const d = schema.$defs;
    expect(d.app.properties.health_path.default).toBe(DEFAULTS.healthPath);
    expect(d.app.properties.start_timeout_seconds.default).toBe(DEFAULTS.startTimeoutSeconds);
    expect(d.db.properties.url_env.default).toBe(DEFAULTS.dbUrlEnv);
    expect(d.auth.properties.login_path.default).toBe(DEFAULTS.loginPath);
    expect(d.artifacts.properties.root.default).toBe(DEFAULTS.artifactsRoot);
    const kg = d.context.properties.knowledge_graph.properties;
    expect(kg.mode.default).toBe(DEFAULTS.kgMode);
    expect(kg.max_staleness_commits.default).toBe(DEFAULTS.kgMaxStaleness);
    const sm = d.context.properties.static_map.properties;
    expect(sm.include.default).toEqual(DEFAULTS.staticInclude);
    expect(sm.exclude.default).toEqual(DEFAULTS.staticExclude);
    const rc = d.context.properties.runtime_crawl.properties;
    expect(rc.enabled.default).toBe(DEFAULTS.crawlEnabled);
    expect(rc.max_depth.default).toBe(DEFAULTS.crawlMaxDepth);
    const rv = d.review.properties;
    expect(rv.mode.default).toBe(DEFAULTS.reviewMode);
    expect(rv.show_code_preview.default).toBe(DEFAULTS.showCodePreview);
    expect(rv.show_overlap.default).toBe(DEFAULTS.showOverlap);
    expect(rv.idle_timeout_minutes.default).toBe(DEFAULTS.idleTimeoutMinutes);
    const ex = d.export.properties;
    expect(ex.target.default).toBe(DEFAULTS.exportTarget);
    expect(ex.detect_from.default).toEqual(DEFAULTS.detectFrom);
    expect(ex.conventions.properties.adapt_to_codebase.default).toBe(DEFAULTS.adaptToCodebase);
    expect(ex.validate.properties.compile.default).toBe(DEFAULTS.validateCompile);
    expect(ex.validate.properties.run_once.default).toBe(DEFAULTS.validateRunOnce);
    expect(d.models.properties.default.default).toBe(DEFAULTS.model);
  });
});

describe('detectStack', () => {
  it('detects the sample app as react-router', () => {
    const report = detectStack(SAMPLE_APP);
    expect(report.stack).toMatchObject({ name: 'react-router', adapter_available: true });
    expect(report.start_command).toBe('npm run dev');
    expect(report.export_targets).toEqual([]);
  });

  it('prefers the more specific framework and flags ambiguous export targets', () => {
    const dir = workspace({
      'package.json': JSON.stringify({
        dependencies: { next: '15', 'react-router': '7' },
        devDependencies: { '@playwright/test': '1' },
        scripts: { start: 'next start' },
      }),
      'pnpm-lock.yaml': '',
      'tests/E2E/E2E.csproj':
        '<PackageReference Include="Microsoft.Playwright" Version="1.50.0" />',
    });
    const report = detectStack(dir);
    expect(report.stack).toMatchObject({ name: 'nextjs', adapter_available: false });
    expect(report.candidates.map((c) => c.name)).toEqual(['nextjs', 'react-router']);
    expect(report.export_targets.map((t) => t.name)).toEqual([
      'playwright-ts',
      'playwright-dotnet',
    ]);
    expect(report.export_target_ambiguous).toBe(true);
    expect(report.package_manager).toBe('pnpm');
    expect(report.start_command).toBe('pnpm start');
  });

  it('detects Selenium in a Maven project with no package.json', () => {
    const dir = workspace({
      'pom.xml': '<dependency><groupId>org.seleniumhq.selenium</groupId></dependency>',
    });
    const report = detectStack(dir);
    expect(report.stack).toBeNull();
    expect(report.package_manager).toBeNull();
    expect(report.export_targets.map((t) => t.name)).toEqual(['selenium-java']);
  });
});

describe('resolveInside', () => {
  it('resolves paths inside the workspace', () => {
    const dir = workspace();
    expect(resolveInside(dir, 'a/b.txt')).toBe(join(dir, 'a', 'b.txt'));
    expect(resolveInside(dir, '.')).toBe(dir);
  });

  it.each(['..', '../x', 'a/../../x', '/etc/passwd', 'C:\\Windows', 'a\0b'])(
    'refuses %j',
    (path) => {
      const dir = workspace();
      expect(() => resolveInside(dir, path)).toThrow(PathEscapeError);
    },
  );
});
