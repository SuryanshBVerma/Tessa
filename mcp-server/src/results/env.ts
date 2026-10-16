import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedConfig } from '../config/index.js';
import type { Results } from '../schemas/generated/index.js';
import { validateDefinition, type SchemaIssue } from '../schemas/index.js';

const run = promisify(execFile);

export interface GitState {
  commit: string;
  branch?: string;
  dirty: boolean;
}

/** HEAD commit, branch and dirty flag, or null outside a Git repository. */
export async function readGitState(workspace: string): Promise<GitState | null> {
  const git = async (...args: string[]) =>
    (await run('git', args, { cwd: workspace, windowsHide: true, timeout: 10_000 })).stdout.trim();
  try {
    const commit = await git('rev-parse', 'HEAD');
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    // Tessa's run output is gitignored, so a run never marks its own tree dirty.
    const status = await git('status', '--porcelain', '--untracked-files=normal');
    return {
      commit,
      ...(branch === 'HEAD' ? {} : { branch }),
      dirty: status !== '',
    };
  } catch {
    return null;
  }
}

/** What the executor saw in the app for this persona. Data only, never instructions. */
export interface Observed {
  role?: string;
  permissions?: string[];
  settings?: Record<string, string | number | boolean>;
  feature_flags?: Record<string, boolean>;
  build?: string;
}

export interface EnvCapture {
  env_state: Results.EnvState;
  environment: {
    app_url: string;
    commit?: string;
    branch?: string;
    dirty?: boolean;
    host?: Results.RunEnvironment['host'];
  };
  /** Where seed_profile came from. */
  seed_profile_source: 'seeded-this-session' | 'persona-config';
  captured_at: string;
}

export type CaptureResult =
  { ok: true; capture: EnvCapture } | { ok: false; issues: SchemaIssue[] };

export async function captureEnvState(
  config: ResolvedConfig,
  workspace: string,
  input: {
    persona: string;
    observed?: Observed;
    host?: Results.RunEnvironment['host'];
    lastSeededProfile?: string | null;
  },
): Promise<CaptureResult> {
  const persona = config.personas.find((p) => p.name === input.persona);
  if (persona === undefined) {
    return {
      ok: false,
      issues: [
        {
          path: '/persona',
          message: `unknown persona "${input.persona}"; defined: ${config.personas.map((p) => p.name).join(', ')}`,
        },
      ],
    };
  }

  const seeded = input.lastSeededProfile ?? null;
  const envState: Results.EnvState = {
    persona: persona.name,
    seed_profile: seeded ?? persona.seed_profile,
    ...input.observed,
  };
  const checked = validateDefinition<Results.EnvState>('results', 'envState', envState);
  if (!checked.ok) {
    return { ok: false, issues: checked.issues };
  }

  const git = await readGitState(workspace);
  return {
    ok: true,
    capture: {
      env_state: checked.value,
      environment: {
        app_url: config.app.url,
        ...(git === null ? {} : git),
        ...(input.host === undefined ? {} : { host: input.host }),
      },
      seed_profile_source: seeded === null ? 'persona-config' : 'seeded-this-session',
      captured_at: new Date().toISOString(),
    },
  };
}
