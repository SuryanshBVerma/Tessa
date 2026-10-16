import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Folders Tessa ships beside the server: the JSON schemas, the config templates, and the
 * host-neutral agents, commands and skills. In the published package they sit in the package
 * root (copied there by the pack step); in this repository they sit one level above it.
 * This file is at src/assets.ts and dist/assets.js, so both depths match.
 */
export type AssetDir = 'schemas' | 'templates' | 'agents' | 'commands' | 'skills';

const PACKAGE_ROOT = new URL('../', import.meta.url);
const REPO_ROOT = new URL('../../', import.meta.url);

export function assetDir(name: AssetDir): URL {
  const packaged = new URL(`${name}/`, PACKAGE_ROOT);
  // mcp-server/templates holds the report templates, so "templates" must be told apart by a
  // file only the root templates folder has.
  const marker = name === 'templates' ? 'config.yaml' : '';
  if (existsSync(fileURLToPath(new URL(marker, packaged)))) {
    return packaged;
  }
  return new URL(`${name}/`, REPO_ROOT);
}
