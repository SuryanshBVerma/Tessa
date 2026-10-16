import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { validate, type TessaConfig } from '../schemas/index.js';
import { PathEscapeError, resolveInside } from '../util/paths.js';
import { KNOWN_ADAPTERS } from './stacks.js';
import { resolveConfig, type ResolvedConfig } from './resolve.js';

export const DEFAULT_CONFIG_PATH = '.tessa/config.yaml';
const MAX_CONFIG_BYTES = 256 * 1024;

export interface ConfigIssue {
  severity: 'error' | 'warning';
  /** JSON Pointer into the config, or "/" for the file as a whole. */
  path: string;
  message: string;
}

export type LoadResult =
  | { ok: true; config: ResolvedConfig; file: string; issues: ConfigIssue[] }
  | { ok: false; file: string; issues: ConfigIssue[] };

export interface LoadOptions {
  /** Root of the repository under test. */
  workspace: string;
  /** Config path relative to the workspace. */
  file?: string;
}

function error(path: string, message: string): ConfigIssue {
  return { severity: 'error', path, message };
}

function warning(path: string, message: string): ConfigIssue {
  return { severity: 'warning', path, message };
}

export function parseConfigText(text: string): { data?: unknown; issues: ConfigIssue[] } {
  // uniqueKeys rejects duplicate keys; maxAliasCount bounds alias expansion ("billion laughs").
  // prettyErrors is off: it quotes the offending source line, which for a file that is not
  // really a config (a .env, say) would put secrets in the tool's output.
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      issues: doc.errors.map((e) => {
        const before = text.slice(0, e.pos[0]);
        const line = before.split('\n').length;
        const col = e.pos[0] - before.lastIndexOf('\n');
        return error(
          '/',
          `YAML: ${e.code.toLowerCase().replaceAll('_', ' ')} at line ${String(line)}, column ${String(col)}`,
        );
      }),
    };
  }
  try {
    return { data: doc.toJS({ maxAliasCount: 50 }), issues: [] };
  } catch (e) {
    return { issues: [error('/', `YAML: ${e instanceof Error ? e.message : String(e)}`)] };
  }
}

/** Checks the schema cannot express: references between sections and files on disk. */
export function checkSemantics(config: TessaConfig, workspace: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const profiles = config.db.profiles;

  const seen = new Set<string>();
  config.personas.forEach((persona, index) => {
    if (seen.has(persona.name)) {
      issues.push(error(`/personas/${String(index)}/name`, `duplicate persona "${persona.name}"`));
    }
    seen.add(persona.name);
    if (!Object.hasOwn(profiles, persona.seed_profile)) {
      issues.push(
        error(
          `/personas/${String(index)}/seed_profile`,
          `unknown seed profile "${persona.seed_profile}"; defined: ${Object.keys(profiles).join(', ')}`,
        ),
      );
    }
  });

  const checkPath = (pointer: string, relPath: string, kind: 'file' | 'dir', required: boolean) => {
    let absolute: string;
    try {
      absolute = resolveInside(workspace, relPath);
    } catch (e) {
      if (e instanceof PathEscapeError) {
        issues.push(error(pointer, `"${relPath}" is outside the workspace`));
        return;
      }
      throw e;
    }
    if (!existsSync(absolute)) {
      if (required) {
        issues.push(error(pointer, `${kind} "${relPath}" does not exist`));
      }
      return;
    }
    const isDir = statSync(absolute).isDirectory();
    if (kind === 'file' && isDir) {
      issues.push(error(pointer, `"${relPath}" is a directory, expected a file`));
    } else if (kind === 'dir' && !isDir) {
      issues.push(error(pointer, `"${relPath}" is a file, expected a directory`));
    }
  };

  for (const [name, files] of Object.entries(profiles)) {
    (files ?? []).forEach((file, index) => {
      checkPath(`/db/profiles/${name}/${String(index)}`, file, 'file', true);
    });
  }
  if (config.app.cwd !== undefined) {
    checkPath('/app/cwd', config.app.cwd, 'dir', true);
  }
  const mapping = config.context?.knowledge_graph?.query_mapping;
  if (config.context?.knowledge_graph?.enabled === true && mapping !== undefined) {
    checkPath('/context/knowledge_graph/query_mapping', mapping, 'file', true);
  }

  const adapter = config.context?.static_map?.adapter ?? config.app.stack;
  if (!KNOWN_ADAPTERS.includes(adapter)) {
    issues.push(
      warning(
        config.context?.static_map?.adapter === undefined
          ? '/app/stack'
          : '/context/static_map/adapter',
        `no built-in adapter for "${adapter}" yet; available: ${KNOWN_ADAPTERS.join(', ')}`,
      ),
    );
  }
  return issues;
}

export function loadConfig(options: LoadOptions): LoadResult {
  const file = options.file ?? DEFAULT_CONFIG_PATH;
  if (!/.ya?ml$/i.test(file)) {
    return {
      ok: false,
      file,
      issues: [error('/', 'the config file must be a .yaml or .yml file')],
    };
  }
  let absolute: string;
  try {
    absolute = resolveInside(options.workspace, file);
  } catch {
    return {
      ok: false,
      file,
      issues: [error('/', `config path "${file}" is outside the workspace`)],
    };
  }
  if (!existsSync(absolute)) {
    return {
      ok: false,
      file,
      issues: [error('/', `no config at ${file}. Run /tessa-init to create one.`)],
    };
  }
  if (statSync(absolute).size > MAX_CONFIG_BYTES) {
    return { ok: false, file, issues: [error('/', `config is larger than 256 KB`)] };
  }

  const parsed = parseConfigText(readFileSync(absolute, 'utf8'));
  if (parsed.data === undefined) {
    return { ok: false, file, issues: parsed.issues };
  }
  const checked = validate('config', parsed.data);
  if (!checked.ok) {
    return {
      ok: false,
      file,
      issues: checked.issues.map((i) => error(i.path, i.message)),
    };
  }
  const semantic = checkSemantics(checked.value, options.workspace);
  if (semantic.some((i) => i.severity === 'error')) {
    return { ok: false, file, issues: semantic };
  }
  return { ok: true, file, config: resolveConfig(checked.value), issues: semantic };
}

export function formatConfigIssues(file: string, issues: readonly ConfigIssue[]): string {
  return [
    `${file}:`,
    ...issues.map((i) => `  ${i.severity === 'error' ? 'error' : 'warn '} ${i.path}: ${i.message}`),
  ].join('\n');
}
