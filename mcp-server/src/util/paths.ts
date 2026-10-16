import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(readonly requested: string) {
    super(`Path "${requested}" resolves outside the workspace.`);
    this.name = 'PathEscapeError';
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolves a workspace-relative path and refuses anything that lands outside the workspace,
 * including through symlinks that already exist on disk.
 */
export function resolveInside(workspace: string, requested: string): string {
  if (requested.includes('\0')) {
    throw new PathEscapeError(requested);
  }
  const root = resolve(workspace);
  const target = resolve(root, requested);
  if (!isInside(root, target)) {
    throw new PathEscapeError(requested);
  }
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync.native(root);
    realTarget = realpathSync.native(target);
  } catch {
    // Target does not exist yet; the lexical check above is all we can do.
    return target;
  }
  if (!isInside(realRoot, realTarget)) {
    throw new PathEscapeError(requested);
  }
  return target;
}
