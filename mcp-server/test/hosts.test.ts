import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { resolveConfig } from '../src/config/index.js';
import type { TessaConfig } from '../src/schemas/generated/index.js';
import { modelsForRun, resolveModel, resolveModels } from '../src/hosts/models.js';
import { SCHEMAS_DIR } from '../src/schemas/index.js';
import { call, connect, tempWorkspace } from './helpers.js';

const BASE: TessaConfig = {
  version: 1,
  app: { start: 'npm run dev', url: 'http://127.0.0.1:5173', stack: 'react-router' },
  db: { allowed_hosts: ['127.0.0.1'], profiles: { default: ['seed.sql'] } },
  auth: { mode: 'manual', login_path: '/login' },
  personas: [
    { name: 'viewer', seed_profile: 'default' },
    { name: 'editor', seed_profile: 'default' },
  ],
};

describe('model resolution', () => {
  it('maps auto to Claude Code aliases by role', () => {
    const config = resolveConfig(BASE);
    expect(
      Object.fromEntries(resolveModels(config, 'claude-code').map((c) => [c.role, c.model])),
    ).toEqual({
      orchestrator: 'inherit',
      context_builder: 'sonnet',
      planner: 'opus',
      executor: 'sonnet',
      triage: 'opus',
      exporter: 'sonnet',
    });
  });

  it('leaves auto out for VS Code, so the picker model is inherited', () => {
    const choice = resolveModel(resolveConfig(BASE), 'planner', 'vscode-agent');
    expect(choice).toEqual({
      role: 'planner',
      model: null,
      source: 'auto',
      label: 'host default (auto: strongest)',
    });
  });

  it('uses configured models as written, with default filling the rest', () => {
    const config = resolveConfig({
      ...BASE,
      models: { default: 'claude-sonnet-5-5', planner: 'claude-opus-5-5' },
    });
    expect(resolveModel(config, 'planner', 'vscode-agent')).toMatchObject({
      model: 'claude-opus-5-5',
      source: 'config',
    });
    expect(resolveModel(config, 'triage', 'claude-code').model).toBe('claude-sonnet-5-5');
  });

  it('labels run models from config and overlays what agents reported', () => {
    const models = modelsForRun(resolveConfig(BASE), 'claude-code', {
      executor: 'claude-sonnet-5-5',
    });
    expect(models.planner).toBe('opus (auto: strongest)');
    expect(models.executor).toBe('claude-sonnet-5-5 (reported)');
    expect(modelsForRun(resolveConfig(BASE), 'other').planner).toBe('auto');
  });
});

describe('models in runs', () => {
  it('records models at begin_run and keeps them through capture_env_state', async () => {
    const workspace = tempWorkspace({
      '.tessa/config.yaml': stringify(BASE),
      'seed.sql': '',
      'ai-test-artifacts/plans/create-ticket/tests.json': readFileSync(
        new URL('examples/tests.example.json', SCHEMAS_DIR),
        'utf8',
      ),
    });
    const client = await connect(workspace);
    await call(client, 'approve_plan', { story: 'create-ticket' });
    const begun = await call(client, 'begin_run', {
      story: 'create-ticket',
      host: 'claude-code',
      models: { executor: 'claude-sonnet-5-5' },
    });
    expect(begun.isError, JSON.stringify(begun.data)).toBe(false);
    const runId = begun.data.run_id as string;
    await call(client, 'capture_env_state', { persona: 'editor', run_id: runId });
    await call(client, 'write_results', { run_id: runId });
    const results = JSON.parse(
      readFileSync(join(workspace, 'ai-test-artifacts', 'runs', runId, 'results.json'), 'utf8'),
    );
    expect(results.environment.models).toMatchObject({
      planner: 'opus (auto: strongest)',
      executor: 'claude-sonnet-5-5 (reported)',
    });
  });
});
