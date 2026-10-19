// Import path aliases from the workspace's tsconfig ("paths" with "baseUrl"), so the map can
// follow imports such as "@app/tickets/list" as well as relative ones.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

export interface Alias {
  /** The part before "*", e.g. "@app/". A pattern without "*" must match exactly. */
  prefix: string;
  wildcard: boolean;
  /** Workspace-relative targets with "*" where the matched part goes. */
  targets: string[];
}

const TSCONFIGS = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

/** Reads "paths" from the first tsconfig that has them. Unreadable configs give no aliases. */
export function loadAliases(workspace: string): Alias[] {
  for (const name of TSCONFIGS) {
    const file = join(workspace, name);
    if (!existsSync(file)) continue;
    const parsed = ts.parseConfigFileTextToJson(name, readFileSync(file, 'utf8'));
    const options = (
      parsed.config as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined
    )?.compilerOptions;
    const paths = options?.paths;
    if (paths === undefined || paths === null || typeof paths !== 'object') continue;
    const baseUrl = typeof options?.baseUrl === 'string' ? options.baseUrl : '.';
    const aliases: Alias[] = [];
    for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const wildcard = pattern.endsWith('*');
      aliases.push({
        prefix: wildcard ? pattern.slice(0, -1) : pattern,
        wildcard,
        targets: targets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => posix.normalize(posix.join(baseUrl, t)))
          // A target outside the workspace is never followed.
          .filter((t) => !t.startsWith('..') && !posix.isAbsolute(t)),
      });
    }
    // Longest prefix first, as TypeScript matches.
    return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  return [];
}

/** Workspace-relative base paths (without extension) an aliased specifier may point to. */
export function aliasCandidates(aliases: readonly Alias[], specifier: string): string[] {
  for (const alias of aliases) {
    if (alias.wildcard ? specifier.startsWith(alias.prefix) : specifier === alias.prefix) {
      const rest = alias.wildcard ? specifier.slice(alias.prefix.length) : '';
      return alias.targets.map((t) => posix.normalize(t.replace('*', rest)));
    }
  }
  return [];
}
