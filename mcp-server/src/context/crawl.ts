// Runtime map: what each persona actually saw when the agent crawled the app in the host
// browser, merged with the static map to find where code and runtime disagree.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAtomic } from '../runs/store.js';
import type { ContextCtx } from './build.js';
import { mapPath, requireMap, routeModules } from './build.js';
import { findRoute, patternMatch } from './query.js';
import type { FrontendMap } from './types.js';

export interface CrawledPage {
  path: string;
  title?: string;
  links: string[];
  testids: string[];
  roles: string[];
}

export interface RuntimeMap {
  version: 1;
  personas: Record<string, { crawled_at: string; pages: CrawledPage[] }>;
}

function loadRuntime(ctx: ContextCtx): RuntimeMap {
  const file = mapPath(ctx, 'runtime-map.json');
  if (!existsSync(file)) return { version: 1, personas: {} };
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeMap;
  } catch {
    return { version: 1, personas: {} };
  }
}

/** Keeps only same-origin paths: "/x" or "<app_url>/x". Anything else is dropped. */
export function toAppPath(ctx: ContextCtx, value: string): string | null {
  const origin = new URL(ctx.config.app.url).origin;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return url.pathname + url.search;
}

export function compare(map: FrontendMap, runtime: RuntimeMap) {
  const visited = new Map<string, Set<string>>();
  const unknownPages: { persona: string; path: string }[] = [];
  const runtimeOnlyTestids: { persona: string; path: string; testid: string }[] = [];

  for (const [persona, entry] of Object.entries(runtime.personas)) {
    for (const page of entry.pages) {
      const route = findRoute(map, page.path.split('?')[0] ?? page.path);
      if (route === undefined) {
        unknownPages.push({ persona, path: page.path });
        continue;
      }
      if (!visited.has(route.id)) visited.set(route.id, new Set());
      visited.get(route.id)?.add(persona);
      const known = routeModules(map, route).flatMap((f) =>
        (map.modules[f]?.selectors ?? []).filter((s) => s.kind === 'testid').map((s) => s.value),
      );
      for (const testid of page.testids) {
        if (!known.some((k) => patternMatch(k, testid))) {
          runtimeOnlyTestids.push({ persona, path: page.path, testid });
        }
      }
    }
  }
  const unreached = map.routes
    .filter((r) => r.kind !== 'layout' && !visited.has(r.id))
    .map((r) => ({ path: r.path, file: r.file }));
  return {
    reached: [...visited.entries()].map(([id, personas]) => ({
      path: map.routes.find((r) => r.id === id)?.path ?? id,
      personas: [...personas].sort(),
    })),
    unreached_routes: unreached,
    unknown_pages: unknownPages,
    runtime_only_testids: runtimeOnlyTestids.slice(0, 100),
  };
}

export function recordCrawl(ctx: ContextCtx, persona: string, pages: CrawledPage[]) {
  if (!ctx.config.personas.some((p) => p.name === persona)) {
    throw new Error(`unknown persona "${persona}"`);
  }
  const map = requireMap(ctx);
  const cleaned: CrawledPage[] = [];
  const dropped: string[] = [];
  for (const page of pages) {
    const path = toAppPath(ctx, page.path);
    if (path === null) {
      dropped.push(page.path);
      continue;
    }
    cleaned.push({
      path,
      ...(page.title === undefined ? {} : { title: page.title }),
      links: [
        ...new Set(page.links.map((l) => toAppPath(ctx, l)).filter((l): l is string => l !== null)),
      ],
      testids: [...new Set(page.testids)],
      roles: [...new Set(page.roles)],
    });
  }
  const runtime = loadRuntime(ctx);
  runtime.personas[persona] = { crawled_at: new Date().toISOString(), pages: cleaned };
  const file = mapPath(ctx, 'runtime-map.json');
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(runtime, null, 2)}\n`);
  return {
    persona,
    pages: cleaned.length,
    dropped_off_origin: dropped,
    path: `${ctx.config.artifacts.root}/context/runtime-map.json`,
    ...compare(map, runtime),
  };
}
