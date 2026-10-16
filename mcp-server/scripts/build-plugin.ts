// Generates the Claude Code plugin in plugins/claude-code/ from the host-neutral agents, commands
// and skills, with auto models. Run after `npm run build`.
// Usage: node scripts/build-plugin.ts [--check]   (--check fails when the plugin is out of date)
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(pkg, '..');
const out = join(repo, 'plugins', 'claude-code');
const dist = (path: string) => new URL(`../dist/${path}`, import.meta.url).href;

const { renderClaudeCode, PLUGIN_NAME } = (await import(
  dist('hosts/render.js')
)) as typeof import('../src/hosts/render.js');
const { loadSources } = (await import(
  dist('hosts/sources.js')
)) as typeof import('../src/hosts/sources.js');
const { ROLES } = (await import(
  dist('hosts/models.js')
)) as typeof import('../src/hosts/models.js');
const { SERVER_VERSION } = (await import(dist('version.js'))) as typeof import('../src/version.js');

const { description } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
  description: string;
};
const models = Object.fromEntries([...ROLES, 'default'].map((r) => [r, 'auto']));
const files = new Map<string, string>();
// The plugin cannot know the user's platform; npx is started directly. Windows users who hit
// "spawn npx ENOENT" install per project instead (tessa-qa install), which writes cmd /c.
for (const file of renderClaudeCode(
  loadSources(),
  { models } as Parameters<typeof renderClaudeCode>[1],
  { mode: 'plugin', platform: 'linux' },
)) {
  files.set(file.path, file.content.endsWith('\n') ? file.content : `${file.content}\n`);
}
files.set(
  '.claude-plugin/plugin.json',
  `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: SERVER_VERSION,
      description,
      author: { name: 'Tessa contributors' },
      license: 'MIT',
      keywords: ['testing', 'qa', 'playwright', 'mcp'],
    },
    null,
    2,
  )}\n`,
);
files.set(
  'README.md',
  `# Tessa for Claude Code (plugin)

Generated from the repository's host-neutral \`agents/\`, \`commands/\` and \`skills/\` by
\`mcp-server/scripts/build-plugin.ts\`. Do not edit these files; change the sources and rebuild.

The plugin starts \`tessa-mcp\` with \`npx -y tessa-qa@${SERVER_VERSION} mcp\` and uses \`auto\` models.
For models from your \`.tessa/config.yaml\`, or on Windows, install per project instead:
\`npx tessa-qa@${SERVER_VERSION} install --host claude-code\`. See docs/INSTALL.md.
`,
);

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? listFiles(path)
      : [relative(out, path).replaceAll('\\', '/')];
  });
}

if (process.argv.includes('--check')) {
  const existing = listFiles(out);
  const stale = [
    ...[...files]
      .filter(
        ([path, content]) =>
          !existsSync(join(out, path)) || readFileSync(join(out, path), 'utf8') !== content,
      )
      .map(([p]) => p),
    ...existing.filter((path) => !files.has(path)),
  ];
  if (stale.length > 0) {
    console.error(
      `plugins/claude-code is out of date (${stale.join(', ')}). Run: npm run plugin:build`,
    );
    process.exit(1);
  }
  console.log(`plugins/claude-code is up to date (${String(files.size)} files)`);
} else {
  rmSync(out, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), content);
  }
  console.log(`Wrote ${String(files.size)} files to plugins/claude-code`);
}
