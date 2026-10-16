import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Folders Tessa ships beside the server: the JSON schemas, the config templates, and the
 * host-neutral agents, commands and skills. In the published package they sit in the package
 * root (copied there by scripts/pack-assets.ts); in this repository they sit one level above it.
 * This file is at src/assets.ts and dist/assets.js, so both depths match.
 */
export type AssetDir = 'schemas' | 'templates' | 'agents' | 'commands' | 'skills';

const PACKAGE_ROOT = new URL('../', import.meta.url);
const REPO_ROOT = new URL('../../', import.meta.url);

/** Where each folder goes in the package. The package's own templates/ holds the report templates. */
export const PACKAGED_NAME: Record<AssetDir, string> = {
  schemas: 'schemas',
  templates: 'init-templates',
  agents: 'agents',
  commands: 'commands',
  skills: 'skills',
};

export function assetDir(name: AssetDir): URL {
  const packaged = new URL(`${PACKAGED_NAME[name]}/`, PACKAGE_ROOT);
  if (existsSync(fileURLToPath(packaged))) {
    return packaged;
  }
  return new URL(`${name}/`, REPO_ROOT);
}
