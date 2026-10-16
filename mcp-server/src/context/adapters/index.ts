import type { RouteNode } from '../types.js';
import { reactRouterAdapter } from './react-router.js';

/**
 * A stack adapter knows where a framework keeps its routes. Everything inside the modules
 * (selectors, guards, links) is read by the shared JSX extractor.
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
}

export const ADAPTERS: Record<string, StackAdapter> = {
  [reactRouterAdapter.name]: reactRouterAdapter,
};

export function adapterFor(name: string): StackAdapter | undefined {
  return ADAPTERS[name];
}
