import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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
  try {
    realRoot = realpathSync.native(root);
  } catch {
    // The workspace itself does not exist (yet); nothing on disk can redirect the path.
    return target;
  }
  // The target may not exist yet, but a parent folder may be a symlink out of the workspace:
  // resolve the nearest part that exists and check where it really is.
  let existing = target;
  for (;;) {
    let isLink: boolean;
    try {
      isLink = lstatSync(existing).isSymbolicLink();
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return target;
      existing = parent;
      continue;
    }
    let real: string;
    try {
      real = realpathSync.native(existing);
    } catch {
      // A dangling link: writing through it would create its target, wherever that is.
      if (isLink) throw new PathEscapeError(requested);
      return target;
    }
    if (!isInside(realRoot, real)) {
      throw new PathEscapeError(requested);
    }
    return target;
  }
}
