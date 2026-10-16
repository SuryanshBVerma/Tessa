import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { detectStack, loadConfig } from './config/index.js';
import { initWorkspace } from './init/index.js';
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

function failure(error: unknown): CallToolResult {
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

  return server;
}
