import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assetDir } from '../assets.js';

/** A host-neutral agent, command or skill, as written in this repository's agents/, commands/ and skills/. */
export interface Source {
  kind: 'agent' | 'command' | 'skill';
  /** tessa-executor, tessa-run, browser-execution, ... */
  name: string;
  /** Path relative to the asset root, for the generated-file marker. */
  origin: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function parseSource(kind: Source['kind'], origin: string, text: string): Source {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    throw new Error(`${origin} has no frontmatter`);
  }
  const frontmatter = (parse(match[1] ?? '') ?? {}) as Record<string, unknown>;
  const fallback = origin.replace(/^.*\//, '').replace(/\.md$/, '');
  const name =
    typeof frontmatter.name === 'string'
      ? frontmatter.name
      : kind === 'skill'
        ? (origin.split('/').at(-2) ?? fallback)
        : fallback;
  return { kind, name, origin, frontmatter, body: text.slice(match[0].length).replace(/^\s+/, '') };
}

function readDir(kind: Source['kind'], dir: 'agents' | 'commands'): Source[] {
  const root = assetDir(dir);
  return readdirSync(fileURLToPath(root))
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => parseSource(kind, `${dir}/${file}`, readFileSync(new URL(file, root), 'utf8')));
}

export function loadSources(): Source[] {
  const skillsRoot = assetDir('skills');
  const skills = readdirSync(fileURLToPath(skillsRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((dir) =>
      parseSource(
        'skill',
        `skills/${dir}/SKILL.md`,
        readFileSync(new URL(`${dir}/SKILL.md`, skillsRoot), 'utf8'),
      ),
    );
  return [...readDir('agent', 'agents'), ...readDir('command', 'commands'), ...skills];
}

/** The frontmatter's tool list, split into MCP tools, built-in capabilities and agents. */
export function toolRefs(source: Source): {
  mcp: string[];
  builtin: ('read' | 'search' | 'browser')[];
  agents: string[];
} {
  const raw = Array.isArray(source.frontmatter.tools) ? source.frontmatter.tools : [];
  const refs = raw.filter((t): t is string => typeof t === 'string');
  const unknown = refs.filter(
    (t) => !t.startsWith('tessa-mcp/') && !t.startsWith('tessa-') && !BUILTIN.has(t),
  );
  if (unknown.length > 0) {
    throw new Error(`${source.origin} lists unknown tools: ${unknown.join(', ')}`);
  }
  return {
    mcp: refs.filter((t) => t.startsWith('tessa-mcp/')).map((t) => t.slice('tessa-mcp/'.length)),
    builtin: refs.filter((t): t is 'read' | 'search' | 'browser' => BUILTIN.has(t)),
    agents: refs.filter((t) => t.startsWith('tessa-') && !t.startsWith('tessa-mcp/')),
  };
}

const BUILTIN = new Set(['read', 'search', 'browser']);
