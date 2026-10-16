import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../runs/store.js';
import { resolveInside } from '../util/paths.js';
import type { Host } from './models.js';
import { MARKER, type RenderedFile } from './render.js';

export interface WriteOutcome {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'removed' | 'conflict';
  /** For a conflict: why the file was left alone, and what to do. */
  reason?: string;
  /** For a conflict in a JSON file: the entry to add by hand. */
  snippet?: string;
}

/** Folders a host's generated files live in, and how to recognise them, for removing stale ones. */
const OWNED: Record<Host, { dir: string; match: RegExp }[]> = {
  'claude-code': [
    { dir: '.claude/agents', match: /^tessa-.*\.md$/ },
    { dir: '.claude/commands', match: /^tessa-.*\.md$/ },
    { dir: '.claude/skills', match: /^SKILL\.md$/ },
  ],
  'vscode-agent': [
    { dir: '.github/agents', match: /^tessa-.*\.agent\.md$/ },
    { dir: '.github/prompts', match: /^tessa-.*\.prompt\.md$/ },
    { dir: '.github/skills', match: /^SKILL\.md$/ },
  ],
};

function generatedFiles(workspace: string, host: Host): string[] {
  const found: string[] = [];
  for (const { dir, match } of OWNED[host]) {
    const root = resolveInside(workspace, dir);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      // Skills are one folder each; look one level down for their SKILL.md.
      const candidates = entry.isDirectory()
        ? readdirSync(join(root, entry.name)).map((f) => `${dir}/${entry.name}/${f}`)
        : [`${dir}/${entry.name}`];
      for (const path of candidates) {
        const file = resolveInside(workspace, path);
        const name = path.slice(path.lastIndexOf('/') + 1);
        if (match.test(name) && readFileSync(file, 'utf8').includes(MARKER)) {
          found.push(path);
        }
      }
    }
  }
  return found;
}

function setKey(target: Record<string, unknown>, key: string[], value: unknown): void {
  let node = target;
  for (const part of key.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[key.at(-1) ?? ''] = value;
}

function getKey(source: unknown, key: string[]): unknown {
  let node = source;
  for (const part of key) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * Writes a host's files into the workspace. Markdown files are replaced only when they carry
 * Tessa's marker; JSON config files gain or update only Tessa's own entry. Generated files the
 * new set no longer contains are removed. With dryRun nothing is written.
 */
export function writeHostFiles(
  workspace: string,
  host: Host,
  files: readonly RenderedFile[],
  options: { dryRun?: boolean; overwrite?: boolean } = {},
): WriteOutcome[] {
  const outcomes: WriteOutcome[] = [];
  const write = (path: string, content: string) => {
    if (options.dryRun === true) return;
    const file = resolveInside(workspace, path);
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, content);
  };

  for (const rendered of files) {
    const file = resolveInside(workspace, rendered.path);
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, 'utf8') : null;

    if (rendered.kind === 'json') {
      const key = rendered.key ?? [];
      const value = getKey(JSON.parse(rendered.content), key);
      let data: Record<string, unknown> = {};
      if (current !== null) {
        try {
          data = JSON.parse(current) as Record<string, unknown>;
        } catch {
          outcomes.push({
            path: rendered.path,
            status: 'conflict',
            reason:
              'The file is not plain JSON (it may contain comments), so Tessa did not change it. Add the entry below by hand.',
            snippet: rendered.content,
          });
          continue;
        }
      }
      if (JSON.stringify(getKey(data, key)) === JSON.stringify(value)) {
        outcomes.push({ path: rendered.path, status: 'unchanged' });
        continue;
      }
      setKey(data, key, value);
      write(rendered.path, `${JSON.stringify(data, null, 2)}\n`);
      outcomes.push({ path: rendered.path, status: exists ? 'updated' : 'created' });
      continue;
    }

    if (current === rendered.content) {
      outcomes.push({ path: rendered.path, status: 'unchanged' });
    } else if (current !== null && !current.includes(MARKER) && options.overwrite !== true) {
      outcomes.push({
        path: rendered.path,
        status: 'conflict',
        reason:
          'A file Tessa did not write is already here. Rename or remove it, or pass overwrite to replace it.',
      });
    } else {
      write(rendered.path, rendered.content);
      outcomes.push({ path: rendered.path, status: exists ? 'updated' : 'created' });
    }
  }

  const produced = new Set(files.map((f) => f.path));
  for (const path of generatedFiles(workspace, host)) {
    if (produced.has(path)) continue;
    if (options.dryRun !== true) {
      const file = resolveInside(workspace, path);
      rmSync(file);
      const dir = dirname(file);
      if (path.split('/').length > 3 && readdirSync(dir).length === 0) rmdirSync(dir);
    }
    outcomes.push({ path, status: 'removed' });
  }
  return outcomes;
}
