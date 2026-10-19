import type { extractModule } from '../extractors/jsx.js';
import type { RouteNode } from '../types.js';
import { angularAdapter } from './angular.js';
import { reactRouterAdapter } from './react-router.js';

export type Extraction = ReturnType<typeof extractModule> & {
  /** Files the extraction read besides the module, relative to the workspace. */
  assets?: string[];
};

/**
 * A stack adapter knows where a framework keeps its routes, and optionally how to read its
 * modules. Without its own extract(), modules are read by the shared JSX/TS extractor.
 */
export interface StackAdapter {
  name: string;
  findRoutes(workspace: string): {
    routes: RouteNode[];
    /** The file the routes came from, relative to the workspace. */
    routeConfig: string | null;
    /** A module that wraps every route, such as React Router's root.tsx. */
    rootModule?: string | null;
    warnings: string[];
  };
  /**
   * Reads one module. readAsset returns another workspace file's text (or null), for files such
   * as an Angular templateUrl; every file read this way must be listed in assets.
   */
  extract?(file: string, source: string, readAsset: (path: string) => string | null): Extraction;
}

export const ADAPTERS: Record<string, StackAdapter> = {
  [reactRouterAdapter.name]: reactRouterAdapter,
  [angularAdapter.name]: angularAdapter,
};

export function adapterFor(name: string): StackAdapter | undefined {
  return ADAPTERS[name];
}
