import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import type { ResolvedConfig } from '../config/index.js';
import { readGitState } from '../results/env.js';
import { writeAtomic } from '../runs/store.js';
import { resolveInside } from '../util/paths.js';
import { adapterFor } from './adapters/index.js';
import { aliasCandidates, loadAliases, type Alias } from './aliases.js';
import { EXTRACTOR_VERSION, extractModule } from './extractors/jsx.js';
import type { FrontendMap, ModuleInfo, RouteNode } from './types.js';

const SOURCE = /\.(tsx?|jsx?|mts|cts)$/;
const RESOLVE_SUFFIXES = [
  '',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '/index.tsx',
  '/index.ts',
  '/index.jsx',
  '/index.js',
];
const MAX_FILE_BYTES = 1024 * 1024;

export interface ContextCtx {
  config: ResolvedConfig;
  workspace: string;
}

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export function mapPath(ctx: ContextCtx, name = 'frontend-map.json'): string {
  return resolveInside(ctx.workspace, posix.join(ctx.config.artifacts.root, 'context', name));
}

export function loadMap(ctx: ContextCtx): FrontendMap | null {
  const file = mapPath(ctx);
  if (!existsSync(file)) return null;
  try {
    const map = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return map.version === 1 ? (map as FrontendMap) : null;
  } catch {
    return null;
  }
}

export function requireMap(ctx: ContextCtx): FrontendMap {
  const map = loadMap(ctx);
  if (map === null) {
    throw new ContextError(
      'no frontend map yet; call build_static_map (or run /tessa-refresh-context)',
    );
  }
  return map;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Resolves a relative or tsconfig-aliased import to a workspace file in the include set, or null. */
function resolveImport(
  from: string,
  specifier: string,
  included: Set<string>,
  aliases: readonly Alias[],
): string | null {
  const bases = specifier.startsWith('.')
    ? [posix.normalize(posix.join(posix.dirname(from), specifier))]
    : aliasCandidates(aliases, specifier);
  // TypeScript ESM code imports "./x.js" for "./x.ts".
  const stems = bases.flatMap((base) => [base, base.replace(/\.(m|c)?js$/, '')]);
  for (const stem of stems) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${stem}${suffix}`;
      if (included.has(candidate)) return candidate;
    }
  }
  return null;
}

export interface BuildResult {
  path: string;
  adapter: string;
  routes: number;
  modules: number;
  reparsed: number;
  reused: number;
  removed: number;
  commit?: string;
  warnings: string[];
}

/** Builds or refreshes <artifacts>/context/frontend-map.json from source. */
export async function buildStaticMap(
  ctx: ContextCtx,
  options: { force?: boolean } = {},
): Promise<BuildResult> {
  const { static_map: settings } = ctx.config.context;
  const adapter = adapterFor(settings.adapter);
  if (adapter === undefined) {
    throw new ContextError(`no built-in adapter for "${settings.adapter}"`);
  }
  const found = adapter.findRoutes(ctx.workspace);
  const warnings = [...found.warnings];

  const included = new Set(
    globSync(settings.include, {
      cwd: ctx.workspace,
      exclude: (file: string) =>
        settings.exclude.some((pattern) => posix.matchesGlob(toPosix(file), pattern)),
    })
      .map(toPosix)
      .filter((file) => SOURCE.test(file) && !file.split('/').includes('node_modules')),
  );

  const aliases = loadAliases(ctx.workspace);
  const cachedMap = options.force === true ? null : loadMap(ctx);
  const previous =
    cachedMap !== null &&
    cachedMap.extractor_version === EXTRACTOR_VERSION &&
    cachedMap.adapter === adapter.name
      ? cachedMap
      : null;
  const modules: Record<string, ModuleInfo> = {};
  const files: Record<string, string> = {};
  let reparsed = 0;
  let reused = 0;

  const queue = [
    ...new Set([
      ...(found.rootModule ? [found.rootModule] : []),
      ...found.routes.map((r) => r.file),
    ]),
  ];
  for (const file of queue) {
    if (!included.has(file)) {
      warnings.push(`${file} is a route module but not in context.static_map.include`);
    }
  }
  const seen = new Set<string>();
  // Files a module's extraction read besides itself (Angular templates), hashed like modules.
  const readText = (file: string): string | null => {
    try {
      const absolute = resolveInside(ctx.workspace, file);
      if (!existsSync(absolute)) return null;
      const text = readFileSync(absolute, 'utf8');
      return text.length > MAX_FILE_BYTES ? null : text;
    } catch {
      return null;
    }
  };
  const assetHash = (file: string): string | null => {
    const text = readText(file);
    return text === null ? null : sha256(text);
  };
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const absolute = resolveInside(ctx.workspace, file);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    if (source.length > MAX_FILE_BYTES) {
      warnings.push(`${file} is larger than 1 MB; skipped`);
      continue;
    }
    const hash = sha256(source);
    files[file] = hash;
    let info: ModuleInfo;
    const cached = previous?.modules[file];
    const assetsUnchanged = (cached?.assets ?? []).every(
      (asset) => previous?.files[asset] !== undefined && previous.files[asset] === assetHash(asset),
    );
    if (cached !== undefined && previous?.files[file] === hash && assetsUnchanged) {
      info = cached;
      reused++;
    } else {
      const { importSpecifiers, ...extracted } =
        adapter.extract === undefined
          ? extractModule(file, source)
          : adapter.extract(file, source, readText);
      info = {
        ...extracted,
        imports: [
          ...new Set(
            importSpecifiers
              .map((s) => resolveImport(file, s, included, aliases))
              .filter((s): s is string => s !== null),
          ),
        ],
      };
      reparsed++;
    }
    modules[file] = info;
    for (const asset of info.assets ?? []) {
      const h = assetHash(asset);
      if (h !== null) files[asset] = h;
    }
    for (const next of info.imports) if (!seen.has(next)) queue.push(next);
  }

  const removed =
    previous === null ? 0 : Object.keys(previous.files).filter((f) => !(f in files)).length;
  const git = await readGitState(ctx.workspace);
  const map: FrontendMap = {
    version: 1,
    adapter: adapter.name,
    extractor_version: EXTRACTOR_VERSION,
    built_at: new Date().toISOString(),
    ...(git === null ? {} : { commit: git.commit }),
    include: settings.include,
    exclude: settings.exclude,
    routes: found.routes,
    modules,
    files,
    warnings,
  };

  const out = mapPath(ctx);
  mkdirSync(dirname(out), { recursive: true });
  writeAtomic(out, `${JSON.stringify(map, null, 2)}\n`);
  writeAtomic(mapPath(ctx, 'frontend-map.md'), renderMapMarkdown(map));

  return {
    path: posix.join(ctx.config.artifacts.root, 'context', 'frontend-map.json'),
    adapter: adapter.name,
    routes: found.routes.length,
    modules: Object.keys(modules).length,
    reparsed,
    reused,
    removed,
    ...(git === null ? {} : { commit: git.commit }),
    warnings,
  };
}

/** Modules a route renders: its own module, its layout ancestors, and their local imports. */
export function routeModules(map: FrontendMap, route: RouteNode): string[] {
  const chain: string[] = [];
  let current: RouteNode | undefined = route;
  while (current !== undefined) {
    chain.unshift(current.file);
    current =
      current.parent === undefined ? undefined : map.routes.find((r) => r.id === current?.parent);
  }
  const result: string[] = [];
  const visit = (file: string, depth: number) => {
    if (result.includes(file) || depth > 3) return;
    result.push(file);
    for (const next of map.modules[file]?.imports ?? []) visit(next, depth + 1);
  };
  for (const file of chain) visit(file, 0);
  return result;
}

const ROUTE_HOOKS = new Set(['canActivate', 'canMatch', 'canActivateChild', 'canLoad']);

function md(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, '\\$1');
}

export function renderMapMarkdown(map: FrontendMap): string {
  const lines = [
    '# Frontend map',
    '',
    `Built ${map.built_at}${map.commit === undefined ? '' : ` at commit ${map.commit.slice(0, 7)}`} by the ${map.adapter} adapter. Generated by tessa-mcp; do not edit.`,
    '',
    '| Path | Kind | Module | Guards | Test ids |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const route of map.routes) {
    const info = map.modules[route.file];
    const guards = [
      ...new Set(
        [...(route.guards ?? []), ...(info?.guards ?? [])].flatMap((g) =>
          g.args.length > 0 ? g.args : ROUTE_HOOKS.has(g.in) ? [g.call] : [],
        ),
      ),
    ].join(', ');
    const testids = (info?.selectors ?? []).filter((s) => s.kind === 'testid').length;
    lines.push(
      `| \`${route.path}\` | ${route.kind} | \`${route.file}\` | ${md(guards) || '—'} | ${String(testids)} |`,
    );
  }
  if (map.warnings.length > 0) {
    lines.push('', '## Warnings', '', ...map.warnings.map((w) => `- ${md(w)}`));
  }
  lines.push('');
  return lines.join('\n');
}
