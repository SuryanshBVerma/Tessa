// Built-in answers to the five context queries, computed from the frontend map.
import type { FrontendMap, Guard, ModuleInfo, RouteNode, Selector } from './types.js';
import { routeModules } from './build.js';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'can',
  'cannot',
  'with',
  'from',
  'that',
  'this',
  'when',
  'into',
  'their',
  'its',
  'should',
  'must',
  'not',
  'are',
  'was',
  'has',
  'have',
  'user',
  'users',
  'page',
  'want',
  'so',
]);

export function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
        // Crude singular form, so "tickets" matches "ticket".
        .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t)),
    ),
  ];
}

/** Whether a value matches a selector that may contain "*" for a dynamic part. */
export function patternMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.+')}$`).test(value);
}

/** Whether a link target such as "/tickets/4" or "/tickets/*" can reach a route path. */
export function pathMatches(routePath: string, target: string): boolean {
  const clean = (p: string) =>
    p.split(/[?#]/)[0]?.replace(/\/+$/, '').split('/').filter(Boolean) ?? [];
  const r = clean(routePath);
  const t = clean(target);
  if (r.length !== t.length) return false;
  return r.every(
    (seg, i) => seg.startsWith(':') || t[i] === '*' || t[i]?.includes('*') === true || seg === t[i],
  );
}

export function findRoute(map: FrontendMap, ref: string): RouteNode | undefined {
  // Prefer a real route over the layout or index that shares its path.
  const rank = (r: RouteNode) => (r.kind === 'route' ? 0 : r.kind === 'index' ? 1 : 2);
  const byId = map.routes.find((r) => r.id === ref || r.file === ref);
  if (byId !== undefined) return byId;
  const exact = map.routes.filter((r) => r.path === ref).sort((a, b) => rank(a) - rank(b));
  if (exact[0] !== undefined) return exact[0];
  return map.routes.filter((r) => pathMatches(r.path, ref)).sort((a, b) => rank(a) - rank(b))[0];
}

function modulesFor(
  map: FrontendMap,
  ref: { route?: string; file?: string },
): { route?: RouteNode; files: string[] } {
  if (ref.route !== undefined) {
    const route = findRoute(map, ref.route);
    if (route === undefined) return { files: [] };
    return { route, files: routeModules(map, route) };
  }
  if (ref.file !== undefined) {
    return map.modules[ref.file] === undefined ? { files: [] } : { files: [ref.file] };
  }
  return { files: [] };
}

function describeRoute(route: RouteNode) {
  return { id: route.id, path: route.path, kind: route.kind, file: route.file };
}

// 1. routes_for_feature

export interface RouteMatch {
  path: string;
  file: string;
  kind: RouteNode['kind'];
  score: number;
  why: string[];
}

export function routesForFeature(map: FrontendMap, query: string, limit = 10): RouteMatch[] {
  const wanted = terms(query);
  const matches: RouteMatch[] = [];
  for (const route of map.routes) {
    if (route.kind === 'layout') continue;
    const info = map.modules[route.file];
    const why: string[] = [];
    let score = 0;
    const has = (text: string) => wanted.filter((t) => text.toLowerCase().includes(t));
    for (const t of has(route.path)) {
      score += 5;
      why.push(`path contains "${t}"`);
    }
    for (const t of has(route.file.split('/').pop() ?? '')) {
      score += 3;
      why.push(`module name contains "${t}"`);
    }
    for (const s of info?.selectors ?? []) {
      for (const t of has(s.value)) {
        score += 1;
        why.push(`${s.kind} "${s.value}" contains "${t}"`);
      }
    }
    for (const g of info?.guards ?? []) {
      if (has(g.args.join(' ')).length > 0) {
        score += 2;
        why.push(`guard ${g.call}(${g.args.join(', ')})`);
      }
    }
    if (score > 0) {
      matches.push({ ...describeRoute(route), score, why: [...new Set(why)].slice(0, 6) });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

// 2. components_for_route

export function componentsForRoute(map: FrontendMap, route: string) {
  const { route: node, files } = modulesFor(map, { route });
  if (node === undefined) return null;
  return {
    route: describeRoute(node),
    layouts: files.filter((f) => map.routes.some((r) => r.kind === 'layout' && r.file === f)),
    modules: files.map((file) => ({ file, exports: map.modules[file]?.exports ?? [] })),
    children: node.children
      .map((id) => map.routes.find((r) => r.id === id))
      .filter((r) => r !== undefined)
      .map(describeRoute),
  };
}

// 3. permissions_for_route

/** Route hooks (Angular's canActivate, canMatch, ...) and route data checked by them. */
const ROUTE_LEVEL = new Set([
  'canActivate',
  'canMatch',
  'canActivateChild',
  'canLoad',
  'route-data',
]);

function classify(guard: Guard): 'enforced' | 'visibility' {
  // A guard on the route blocks navigation; a require*/ensure* call in a loader or action stops
  // the request; can()/has*() in a component or template decides what the UI shows.
  if (ROUTE_LEVEL.has(guard.in)) return 'enforced';
  return /^(require|ensure|assert|authorize)/.test(guard.call) &&
    guard.in !== 'component' &&
    guard.in !== 'template'
    ? 'enforced'
    : 'visibility';
}

/** Whether a guard is about being signed in at all, rather than a particular permission. */
function signInGuard(guard: Guard): boolean {
  return /^require/.test(guard.call) || /auth|login|signed|logged|session/i.test(guard.call);
}

export function permissionsForRoute(map: FrontendMap, route: string) {
  const { route: node, files } = modulesFor(map, { route });
  if (node === undefined) return null;
  // Only the route's own chain (layouts and the route module), not shared libraries, where guard
  // helpers are defined rather than used.
  const chain = files.filter((f) => map.routes.some((r) => r.file === f));
  const moduleGuards = chain.flatMap((file) =>
    (map.modules[file]?.guards ?? [])
      .filter((g) => g.args.length > 0 || signInGuard(g))
      .map((g) => ({ ...g, file, effect: classify(g) })),
  );
  // Guards declared on the route and its ancestors (Angular): a parent's guard gates its children.
  const routeGuards: (Guard & {
    file: string;
    route: string;
    effect: 'enforced' | 'visibility';
  })[] = [];
  for (let r: RouteNode | undefined = node; r !== undefined;) {
    for (const g of r.guards ?? []) {
      routeGuards.push({ ...g, file: r.file, route: r.path, effect: classify(g) });
    }
    const parentId: string | undefined = r.parent;
    r = parentId === undefined ? undefined : map.routes.find((x) => x.id === parentId);
  }
  const guards = [...routeGuards, ...moduleGuards];
  return {
    route: describeRoute(node),
    requires_sign_in: guards.some(signInGuard),
    enforced: guards.filter((g) => g.effect === 'enforced'),
    visibility: guards.filter((g) => g.effect === 'visibility'),
  };
}

// 4. api_calls_for_component

export function apiCallsForComponent(map: FrontendMap, ref: { route?: string; file?: string }) {
  const { route, files } = modulesFor(map, ref);
  if (files.length === 0) return null;
  const own =
    route === undefined
      ? files
      : files.filter((f) => f === route.file || !map.routes.some((r) => r.file === f));
  return {
    ...(route === undefined ? {} : { route: describeRoute(route) }),
    modules: own
      .map((file) => {
        const info = map.modules[file] as ModuleInfo;
        return {
          file,
          data_functions: info.exports.filter((e) =>
            /^(loader|action|clientLoader|clientAction)$/.test(e),
          ),
          calls: info.api,
        };
      })
      .filter((m) => m.data_functions.length > 0 || m.calls.length > 0),
  };
}

// 5. selectors_for_component

export function selectorsForComponent(map: FrontendMap, ref: { route?: string; file?: string }) {
  const { route, files } = modulesFor(map, ref);
  if (files.length === 0) return null;
  const selectors: (Selector & { file: string })[] = [];
  for (const file of files) {
    for (const s of map.modules[file]?.selectors ?? []) selectors.push({ ...s, file });
  }
  const order: Selector['kind'][] = [
    'testid',
    'role',
    'label',
    'aria-label',
    'placeholder',
    'text',
  ];
  return {
    ...(route === undefined ? {} : { route: describeRoute(route) }),
    note: 'Prefer testid, then role with a name, then label. Values with "*" are patterns: the dynamic part varies.',
    selectors: selectors.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
  };
}

/** Routes reachable from a route through links, redirects and forms in its modules. */
export function linkedRoutes(map: FrontendMap, route: RouteNode): RouteNode[] {
  const targets = routeModules(map, route).flatMap((f) => map.modules[f]?.links ?? []);
  const found = new Map<string, RouteNode>();
  for (const link of targets) {
    const target = findRoute(map, link.to);
    if (target !== undefined && target.id !== route.id) found.set(target.id, target);
  }
  return [...found.values()];
}
