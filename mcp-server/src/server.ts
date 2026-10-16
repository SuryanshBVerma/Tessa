import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { AppManager, checkHealth } from './app/lifecycle.js';
import { UnsafeDatabaseError } from './db/guard.js';
import { SeedError, seedProfile, type SeedResult } from './db/seed.js';
import { detectStack, loadConfig, type ConfigIssue, type ResolvedConfig } from './config/index.js';
import { initWorkspace } from './init/index.js';
import { captureEnvState, type Observed } from './results/env.js';
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
  // Never leave the app under test running after the host disconnects or the server exits.
  const onExit = () => {
    app.dispose();
  };
  process.once('exit', onExit);
  server.server.onclose = () => {
    process.off('exit', onExit);
    app.dispose();
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
    async ({ persona, observed, host }) => {
      try {
        const captured = await captureEnvState(requireConfig(), workspace, {
          persona,
          // zod leaves absent keys undefined; drop them so optional fields stay absent.
          ...(observed === undefined
            ? {}
            : { observed: JSON.parse(JSON.stringify(observed)) as Observed }),
          ...(host === undefined ? {} : { host }),
          lastSeededProfile: lastSeed?.profile ?? null,
        });
        return captured.ok
          ? result({ ok: true, ...captured.capture })
          : result({ ok: false, issues: captured.issues }, true);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
