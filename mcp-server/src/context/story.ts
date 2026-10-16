// Story-scoped retrieval: the small part of the frontend map a story is about.
import { routeModules } from './build.js';
import { changedOnBranch } from './freshness.js';
import { linkedRoutes, permissionsForRoute, routesForFeature } from './query.js';
import type { FrontendMap, RouteNode } from './types.js';

export interface StoryContextOptions {
  /** The story text, or key terms from it. */
  text: string;
  /** Branch to diff against; defaults to develop, then main, then master. */
  base?: string;
  /** How far to expand from the matched routes: 0, 1 or 2 hops. */
  hops?: number;
}

const MAX_ROUTES = 12;
const MAX_SELECTORS_PER_ROUTE = 40;

export async function storyContext(
  map: FrontendMap,
  workspace: string,
  options: StoryContextOptions,
) {
  const reasons = new Map<string, Set<string>>();
  const note = (route: RouteNode, why: string) => {
    if (!reasons.has(route.id)) reasons.set(route.id, new Set());
    reasons.get(route.id)?.add(why);
  };

  // 1. Text matches on story terms.
  for (const match of routesForFeature(map, options.text, 8)) {
    const route = map.routes.find((r) => r.file === match.file && r.path === match.path);
    if (route !== undefined) note(route, `matches the story (${match.why.slice(0, 2).join('; ')})`);
  }

  // 2. Routes whose modules changed on this branch.
  const branch = await changedOnBranch(workspace, options.base);
  if (branch !== null) {
    const changed = new Set(branch.files);
    for (const route of map.routes) {
      if (route.kind === 'layout') continue;
      const hit = routeModules(map, route).find((f) => changed.has(f));
      if (hit !== undefined) note(route, `${hit} changed on this branch vs ${branch.base}`);
    }
  }

  // 3. Graph neighbours: routes linked from or to the matches.
  const hops = Math.max(0, Math.min(2, options.hops ?? 1));
  let frontier = [...reasons.keys()];
  for (let hop = 1; hop <= hops; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const route = map.routes.find((r) => r.id === id);
      if (route === undefined) continue;
      for (const neighbour of linkedRoutes(map, route)) {
        if (neighbour.kind === 'layout' || reasons.has(neighbour.id)) continue;
        note(neighbour, `linked from ${route.path} (${String(hop)} hop${hop === 1 ? '' : 's'})`);
        next.push(neighbour.id);
      }
    }
    frontier = next;
  }

  const routes = [...reasons.entries()]
    .map(([id, why]) => ({
      route: map.routes.find((r) => r.id === id) as RouteNode,
      why: [...why],
    }))
    // Direct matches and branch changes before neighbours.
    .sort(
      (a, b) =>
        Number(a.why.every((w) => w.startsWith('linked'))) -
        Number(b.why.every((w) => w.startsWith('linked'))),
    )
    .slice(0, MAX_ROUTES);

  return {
    terms_from: options.text.slice(0, 200),
    ...(branch === null
      ? {}
      : { branch_base: branch.base, branch_changed_files: branch.files.length }),
    routes: routes.map(({ route, why }) => {
      const modules = routeModules(map, route);
      const own = map.modules[route.file];
      const permissions = permissionsForRoute(map, route.id);
      return {
        path: route.path,
        file: route.file,
        why,
        guards: [
          ...new Set(
            [...(permissions?.enforced ?? []), ...(permissions?.visibility ?? [])].map(
              (g) => `${g.call}(${g.args.join(', ')}) in ${g.in}`,
            ),
          ),
        ],
        selectors: modules
          .flatMap((f) =>
            (map.modules[f]?.selectors ?? []).map((s) => ({
              kind: s.kind,
              value: s.value,
              element: s.element,
              file: f,
            })),
          )
          .filter((s) => s.kind !== 'text' || s.file === route.file)
          .slice(0, MAX_SELECTORS_PER_ROUTE),
        links: [...new Set((own?.links ?? []).map((l) => `${l.kind} ${l.to}`))],
        flags: [...new Set((own?.flags ?? []).map((f) => f.name))],
      };
    }),
  };
}
