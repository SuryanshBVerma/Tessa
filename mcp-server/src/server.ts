import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { AppManager, checkHealth } from './app/lifecycle.js';
import { UnsafeDatabaseError } from './db/guard.js';
import { SeedError, seedProfile, type SeedResult } from './db/seed.js';
import { detectStack, loadConfig, type ConfigIssue, type ResolvedConfig } from './config/index.js';
import { initWorkspace } from './init/index.js';
import { captureEnvState, readGitState, type Observed } from './results/env.js';
import { loadResults, renderReport } from './report/render.js';
import { buildSelection, readSelection, ReviewServer, writeSelection } from './report/server.js';
import { buildResults } from './runs/results.js';
import { importScreenshot } from './runs/screenshots.js';
import {
  artifactsDir,
  createRun,
  loadPlan,
  loadRun,
  RunError,
  saveRun,
  writeAtomic,
  type StepRecord,
} from './runs/store.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const EXPORT_TARGETS = [
  'auto',
  'playwright-ts',
  'playwright-dotnet',
  'cypress-ts',
  'selenium-csharp',
  'selenium-java',
] as const;

function result(data: object, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
    isError,
  };
}

class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super('Tessa config is missing or invalid. Run validate_config for details, or /tessa-init.');
    this.name = 'ConfigError';
  }
}

function failure(error: unknown): CallToolResult {
  if (error instanceof ConfigError) {
    return result({ ok: false, error: error.message, issues: error.issues }, true);
  }
  if (error instanceof UnsafeDatabaseError) {
    return result({ ok: false, refused: true, error: error.message }, true);
  }
  if (error instanceof RunError) {
    return result({ ok: false, error: error.message }, true);
  }
  if (error instanceof SeedError) {
    return result(
      {
        ok: false,
        error: error.message,
        ...(error.file === undefined ? {} : { file: error.file }),
      },
      true,
    );
  }
  // Only the message: stack traces can carry local paths and are no use to the agent.
  const message = error instanceof Error ? error.message : String(error);
  return result({ ok: false, error: message }, true);
}

export interface ServerOptions {
  /** Root of the repository under test. Every path the tools touch stays inside it. */
  workspace: string;
}

export function createServer({ workspace }: ServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const app = new AppManager(workspace);
  const review = new ReviewServer();
  // Never leave the app under test running after the host disconnects or the server exits.
  const onExit = () => {
    app.dispose();
  };
  process.once('exit', onExit);
  server.server.onclose = () => {
    process.off('exit', onExit);
    app.dispose();
    void review.stop();
  };

  let lastSeed: SeedResult | null = null;

  const requireConfig = (): ResolvedConfig => {
    const loaded = loadConfig({ workspace });
    if (!loaded.ok) {
      throw new ConfigError(loaded.issues);
    }
    return loaded.config;
  };

  const fileArg = {
    file: z
      .string()
      .optional()
      .describe('Config path relative to the workspace. Defaults to .tessa/config.yaml.'),
  };

  server.registerTool(
    'load_config',
    {
      title: 'Load Tessa config',
      description:
        'Read, validate and resolve .tessa/config.yaml. Returns the config with defaults filled in, or the issues that stop it loading.',
      inputSchema: fileArg,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ file }) => {
      try {
        const loaded = loadConfig({ workspace, ...(file === undefined ? {} : { file }) });
        return result(loaded, !loaded.ok);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'validate_config',
    {
      title: 'Validate Tessa config',
      description:
        'Check .tessa/config.yaml and list every error and warning with its JSON Pointer path. Does not return the config.',
      inputSchema: fileArg,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ file }) => {
      try {
        const loaded = loadConfig({ workspace, ...(file === undefined ? {} : { file }) });
        return result({ ok: loaded.ok, file: loaded.file, issues: loaded.issues });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'detect_stack',
    {
      title: 'Detect stack',
      description:
        'Inspect package.json, *.csproj and pom.xml to suggest the stack adapter, export targets, package manager and start command.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      try {
        return result(detectStack(workspace));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'init_workspace',
    {
      title: 'Scaffold Tessa files',
      description:
        'Create .tessa/config.yaml, the hints file and the managed .gitignore block. Never replaces hints; replaces an existing config only with overwrite. Use dry_run first to show the user what will be written.',
      inputSchema: {
        app: z
          .object({
            start: z.string().min(1).optional(),
            url: z.string().optional(),
            stack: z.string().optional(),
            cwd: z.string().optional(),
          })
          .optional(),
        seed_profiles: z
          .record(z.string(), z.array(z.string()).min(1))
          .optional()
          .describe('Profile name -> ordered SQL files, relative to the workspace.'),
        personas: z
          .array(
            z.object({
              name: z.string(),
              seed_profile: z.string(),
              description: z.string().optional(),
            }),
          )
          .min(1)
          .optional(),
        export_target: z.enum(EXPORT_TARGETS).optional(),
        artifacts_root: z.string().optional(),
        source_include: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Globs the static map reads, e.g. ["src/**"]. Defaults to src/ or app/.'),
        overwrite: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      try {
        // zod leaves absent keys undefined; drop them so optional fields stay absent.
        const options = JSON.parse(JSON.stringify(args)) as Parameters<typeof initWorkspace>[1];
        const initialised = initWorkspace(workspace, options);
        return result(initialised, !initialised.ok);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'start_app',
    {
      title: 'Start the app under test',
      description:
        'Start the app with app.start from config and wait until app.health_path responds. Does nothing if the app is already up. Returns the last lines of output when the start fails.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const started = await app.start(requireConfig());
        return result({ ok: started.status !== 'failed', ...started }, started.status === 'failed');
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'stop_app',
    {
      title: 'Stop the app under test',
      description:
        'Stop the app if Tessa started it. Never stops an app that was already running before start_app.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        if (!app.running && (await checkHealth(requireConfig())).healthy) {
          return result({
            ok: true,
            status: 'not_managed',
            message: 'The app is running but Tessa did not start it, so Tessa leaves it alone.',
          });
        }
        return result({ ok: true, ...(await app.stop()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'health_check',
    {
      title: 'Check the app is up',
      description:
        'Request app.url + app.health_path once. Any status below 500, including redirects, counts as healthy.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const health = await checkHealth(requireConfig());
        return result({
          ok: health.healthy,
          ...health,
          managed: app.running,
          ...(app.pid === undefined ? {} : { pid: app.pid }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'seed_db',
    {
      title: 'Seed the database',
      description:
        'Apply a seed profile from db.profiles, in order, in one transaction. Only the listed .sql files run, and only against a local host in db.allowed_hosts. The database URL comes from the db.url_env variable and is never returned.',
      inputSchema: {
        profile: z.string().min(1).describe('Seed profile name from db.profiles.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ profile }) => {
      try {
        lastSeed = await seedProfile(requireConfig(), workspace, profile);
        return result({ ok: true, ...lastSeed });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'reset_db',
    {
      title: 'Reset the database',
      description:
        'Return the database to a known state by re-applying a seed profile: the one given, else the last one seeded in this session, else "default". Same safety rules as seed_db.',
      inputSchema: {
        profile: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ profile }) => {
      try {
        const chosen = profile ?? lastSeed?.profile ?? 'default';
        lastSeed = await seedProfile(requireConfig(), workspace, chosen);
        return result({ ok: true, reset_to: chosen, ...lastSeed });
      } catch (error) {
        return failure(error);
      }
    },
  );

  const shortText = z.string().max(200);
  server.registerTool(
    'capture_env_state',
    {
      title: 'Capture environment state',
      description:
        'Record the environment a test runs in: persona, seed profile, app URL and Git commit/branch/dirty state, merged with what you observed in the app (role, permissions, settings, feature flags, build). Observed values are copied as data. Call once per persona before running its tests.',
      inputSchema: {
        persona: z.string().min(1),
        run_id: z
          .string()
          .optional()
          .describe('Run from begin_run. When given, the state is stored with the run.'),
        observed: z
          .object({
            role: shortText.optional(),
            permissions: z.array(shortText).max(200).optional(),
            settings: z.record(shortText, z.union([shortText, z.number(), z.boolean()])).optional(),
            feature_flags: z.record(shortText, z.boolean()).optional(),
            build: shortText.optional(),
          })
          .optional()
          .describe('What the app showed for this persona, e.g. on a settings or profile page.'),
        host: z.enum(['vscode-agent', 'claude-code', 'other']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ persona, run_id, observed, host }) => {
      try {
        const config = requireConfig();
        const captured = await captureEnvState(config, workspace, {
          persona,
          // zod leaves absent keys undefined; drop them so optional fields stay absent.
          ...(observed === undefined
            ? {}
            : { observed: JSON.parse(JSON.stringify(observed)) as Observed }),
          ...(host === undefined ? {} : { host }),
          lastSeededProfile: lastSeed?.profile ?? null,
        });
        if (!captured.ok) {
          return result({ ok: false, issues: captured.issues }, true);
        }
        if (run_id !== undefined) {
          const ctx = { config, workspace };
          const state = loadRun(ctx, run_id);
          state.env_states[persona] = captured.capture.env_state;
          const { host: capturedHost, ...environment } = captured.capture.environment;
          state.environment = environment;
          if (capturedHost !== undefined) {
            state.host = capturedHost;
          }
          saveRun(ctx, state);
          writeAtomic(
            artifactsDir(ctx, 'runs', run_id, 'env-state.json'),
            `${JSON.stringify(state.env_states, null, 2)}\n`,
          );
        }
        return result({ ok: true, ...captured.capture });
      } catch (error) {
        return failure(error);
      }
    },
  );

  const hostEnum = z.enum(['vscode-agent', 'claude-code', 'other']);

  server.registerTool(
    'begin_run',
    {
      title: 'Begin a run',
      description:
        'Start a run of an approved plan (plans/<story>/tests.json under the artifacts root). Creates runs/<run_id>/ and returns the run id and the tests to execute, with their steps indexed from 0.',
      inputSchema: {
        story: z.string().min(1).describe('Story id: the folder name under plans/.'),
        test_ids: z.array(z.string().min(1)).min(1).optional().describe('Run only these tests.'),
        host: hostEnum.optional().describe('The agent host running this session.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ story, test_ids, host }) => {
      try {
        const config = requireConfig();
        const ctx = { config, workspace };
        const plan = loadPlan(ctx, story);
        const git = await readGitState(workspace);
        const { state, tests } = createRun(
          ctx,
          plan,
          { app_url: config.app.url, ...(git ?? {}) },
          {
            ...(test_ids === undefined ? {} : { testIds: test_ids }),
            ...(host === undefined ? {} : { host }),
          },
        );
        return result({
          ok: true,
          run_id: state.run_id,
          run_dir: `${config.artifacts.root}/runs/${state.run_id}`,
          story: plan.story,
          app_url: config.app.url,
          login_path: config.auth.login_path,
          tests: tests.map((test) => ({
            ...test,
            steps: test.steps.map((step, index) => ({ index, ...step })),
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'record_step',
    {
      title: 'Record a step',
      description:
        'Record the outcome of one plan step. Attach the screenshot by absolute file path (where the host browser saved it) or as base64; only PNG, JPEG or WebP images under 10 MB are accepted. Recording the same test, attempt and index again replaces it.',
      inputSchema: {
        run_id: z.string(),
        test_id: z.string(),
        index: z.number().int().min(0).describe('Step index from begin_run.'),
        status: z.enum(['passed', 'failed', 'skipped']),
        attempt: z.number().int().min(1).max(10).optional().describe('1 unless this is a retry.'),
        duration_ms: z.number().int().min(0).optional(),
        expected: z.string().max(2000).optional(),
        actual: z.string().max(2000).optional(),
        error: z.string().max(2000).optional(),
        selector_used: z.string().max(500).optional(),
        screenshot: z
          .union([
            z.object({ path: z.string().min(1) }),
            z.object({ data_base64: z.string().min(1) }),
          ])
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      try {
        const ctx = { config: requireConfig(), workspace };
        const state = loadRun(ctx, args.run_id);
        const records = state.steps[args.test_id];
        if (records === undefined) {
          throw new RunError(`run ${args.run_id} has no test "${args.test_id}"`);
        }
        const plan = loadPlan(ctx, state.story_id);
        const test = plan.tests.find((t) => t.id === args.test_id);
        if (test === undefined || args.index >= test.steps.length) {
          throw new RunError(`test "${args.test_id}" has no step ${String(args.index)}`);
        }
        const attempt = args.attempt ?? 1;
        const record: StepRecord = {
          index: args.index,
          attempt,
          status: args.status,
          ...(args.duration_ms === undefined ? {} : { duration_ms: args.duration_ms }),
          ...(args.expected === undefined ? {} : { expected: args.expected }),
          ...(args.actual === undefined ? {} : { actual: args.actual }),
          ...(args.error === undefined ? {} : { error: args.error }),
          ...(args.selector_used === undefined ? {} : { selector_used: args.selector_used }),
        };
        if (args.screenshot !== undefined) {
          record.screenshot = importScreenshot(
            artifactsDir(ctx, 'runs', args.run_id),
            args.test_id,
            attempt,
            args.index,
            args.screenshot,
          );
        }
        const kept = records.filter((r) => !(r.attempt === attempt && r.index === args.index));
        state.steps[args.test_id] = [...kept, record];
        saveRun(ctx, state);
        return result({ ok: true, recorded: record });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'write_results',
    {
      title: 'Write run results',
      description:
        'Assemble runs/<run_id>/results.json from the recorded steps and environment state. Test status, failure details, attempts and quality signals are computed, not supplied. Safe to call again; it rewrites the file.',
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ run_id }) => {
      try {
        const ctx = { config: requireConfig(), workspace };
        const state = loadRun(ctx, run_id);
        const built = buildResults(state, loadPlan(ctx, state.story_id));
        if (!built.ok) {
          return result({ ok: false, issues: built.issues }, true);
        }
        writeAtomic(
          artifactsDir(ctx, 'runs', run_id, 'results.json'),
          `${JSON.stringify(built.results, null, 2)}\n`,
        );
        return result({
          ok: true,
          results_path: `${ctx.config.artifacts.root}/runs/${run_id}/results.json`,
          summary: built.results.summary,
          tests: built.results.tests.map((t) => ({
            test_id: t.test_id,
            status: t.status,
            ...(t.failure === undefined ? {} : { failure: t.failure }),
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'render_report',
    {
      title: 'Render the report',
      description:
        'Render runs/<run_id>/report.html from results.json and the plan, using the fixed report template. The file works opened from disk; serve_review also renders it.',
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ run_id }) => {
      try {
        return result({
          ok: true,
          ...renderReport({ config: requireConfig(), workspace }, run_id),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'serve_review',
    {
      title: 'Serve the review page',
      description:
        'Render the report and serve it on 127.0.0.1 at a random port behind a per-session token. Give the user the URL; they select tests and press Export, then call get_selection. The server stops after review.idle_timeout_minutes without requests, on stop_review, or when the session ends. Only one review is served at a time.',
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ run_id }) => {
      try {
        const info = await review.start({ config: requireConfig(), workspace }, run_id);
        return result({
          ok: true,
          ...info,
          note: 'The URL contains a session token. Open it only on this machine and do not share it.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_selection',
    {
      title: 'Get the reviewer selection',
      description:
        'Return the tests the reviewer selected for a run (selection.json). With wait_seconds, waits that long for the reviewer to press Export on the review page.',
      inputSchema: {
        run_id: z.string(),
        wait_seconds: z.number().int().min(0).max(120).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ run_id, wait_seconds }) => {
      try {
        const ctx = { config: requireConfig(), workspace };
        const existing = readSelection(ctx, run_id);
        if (existing !== null) {
          return result({ ok: true, status: 'received', selection: existing });
        }
        if (wait_seconds !== undefined && wait_seconds > 0 && review.active?.run_id === run_id) {
          const posted = await review.waitForSelection(wait_seconds * 1000);
          if (posted !== null) {
            return result({ ok: true, status: 'received', selection: posted });
          }
        }
        return result({
          ok: true,
          status: 'waiting',
          serving: review.active?.run_id === run_id,
          message: 'No selection yet. The reviewer has not pressed Export.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'record_selection',
    {
      title: 'Record a pasted selection',
      description:
        'Save a selection the user pasted from a report opened from disk (the static fallback). The test ids are checked against the run.',
      inputSchema: {
        run_id: z.string(),
        selected_test_ids: z.array(z.string().min(1)).min(1),
        target: z
          .enum([
            'playwright-ts',
            'playwright-dotnet',
            'cypress-ts',
            'selenium-csharp',
            'selenium-java',
          ])
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ run_id, selected_test_ids, target }) => {
      try {
        const ctx = { config: requireConfig(), workspace };
        const selection = buildSelection(
          loadResults(ctx, run_id),
          { selected_test_ids, ...(target === undefined ? {} : { target }) },
          'static',
        );
        writeSelection(ctx, selection);
        return result({ ok: true, selection });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'stop_review',
    {
      title: 'Stop the review server',
      description: 'Stop serving the review page. The report file stays on disk.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const stopped = await review.stop();
        return result({ ok: true, status: stopped ? 'stopped' : 'not_running' });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
