// Copies the folders the server reads at run time (schemas, init templates, agents, commands,
// skills) and the licence into this package before `npm pack` / `npm publish`, and removes the
// copies afterwards so development always reads the repository's own folders.
// Usage: node scripts/pack-assets.ts copy | clean
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(pkg, '..');

// Keep in step with PACKAGED_NAME in src/assets.ts.
const COPIES: [from: string, to: string][] = [
  ['schemas', 'schemas'],
  ['templates', 'init-templates'],
  ['agents', 'agents'],
  ['commands', 'commands'],
  ['skills', 'skills'],
  ['LICENSE', 'LICENSE'],
];

const mode = process.argv[2];
for (const [from, to] of COPIES) {
  const target = join(pkg, to);
  rmSync(target, { recursive: true, force: true });
  if (mode === 'copy') {
    const source = join(repo, from);
    if (!existsSync(source)) {
      console.error(`pack-assets: ${from} is missing`);
      process.exit(1);
    }
    // Schema examples are documentation, not needed at run time.
    cpSync(source, target, {
      recursive: true,
      filter: (path) => !/[\\/]examples([\\/]|$)/.test(path),
    });
  } else if (mode !== 'clean') {
    console.error('usage: node scripts/pack-assets.ts copy | clean');
    process.exit(2);
  }
}
console.log(
  `pack-assets: ${mode === 'copy' ? 'copied' : 'removed'} ${COPIES.map((c) => c[1]).join(', ')}`,
);
