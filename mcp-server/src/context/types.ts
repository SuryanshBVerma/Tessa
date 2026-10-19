// The frontend map: what Tessa knows about the app's screens from its source code.
// Written to <artifacts>/context/frontend-map.json by build_static_map and read only by tessa-mcp.

export interface RouteNode {
  /** Stable id: the route module's path, plus "#index" for index routes. */
  id: string;
  /** Full URL pattern, e.g. "/tickets/:ticketId". Layout routes have the parent's path. */
  path: string;
  /** Route module, relative to the workspace. */
  file: string;
  kind: 'route' | 'index' | 'layout';
  parent?: string;
  children: string[];
  /**
   * Guards declared on the route itself rather than in its module, such as Angular's canActivate
   * and canMatch, and role or permission lists in the route's data.
   */
  guards?: Guard[];
}

export type SelectorKind = 'testid' | 'role' | 'aria-label' | 'label' | 'placeholder' | 'text';

export interface Selector {
  kind: SelectorKind;
  /** The value. For template literals, dynamic parts become "*", e.g. "ticket-row-*". */
  value: string;
  pattern: boolean;
  /** The JSX element the selector is on, e.g. "button" or "NavLink". */
  element: string;
  line: number;
  /** The file the selector is in, when it is not the module itself (an Angular templateUrl). */
  source?: string;
}

export interface Guard {
  /** The called function, e.g. "requirePermission" or "can". */
  call: string;
  /** String-literal arguments, usually the permission or role names. */
  args: string[];
  /**
   * Where it is called: a route export (loader, action, component) or another function; for a
   * route-level guard, the route hook (canActivate, canMatch, ...) or "route-data"; for an
   * Angular template, "template".
   */
  in: string;
  line: number;
}

export interface Link {
  kind: 'link' | 'redirect' | 'form';
  to: string;
  pattern: boolean;
  method?: string;
  line: number;
}

export interface ApiCall {
  kind: 'fetch' | 'http-client' | 'form';
  method?: string;
  url: string;
  pattern: boolean;
  line: number;
}

export interface FlagUse {
  name: string;
  line: number;
}

export interface ModuleInfo {
  file: string;
  /** Local modules this one imports, relative to the workspace. */
  imports: string[];
  /** Route-module exports present: loader, action, clientLoader, default... */
  exports: string[];
  selectors: Selector[];
  guards: Guard[];
  links: Link[];
  api: ApiCall[];
  flags: FlagUse[];
  /** Other files this module's extraction read, such as an Angular templateUrl. */
  assets?: string[];
}

export interface FrontendMap {
  version: 1;
  adapter: string;
  /** Extractor version; a map built by another version is fully re-parsed. */
  extractor_version: number;
  built_at: string;
  /** HEAD when the map was built; absent outside Git. */
  commit?: string;
  include: string[];
  exclude: string[];
  routes: RouteNode[];
  modules: Record<string, ModuleInfo>;
  /** SHA-256 per scanned file, so rebuilds only re-parse what changed. */
  files: Record<string, string>;
  /** Problems found while extracting, e.g. a route file that does not exist. */
  warnings: string[];
}
