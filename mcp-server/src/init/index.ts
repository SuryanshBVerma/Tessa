import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { assetDir } from '../assets.js';
import { checkSemantics, DEFAULT_CONFIG_PATH, type ConfigIssue } from '../config/load.js';
import { detectStack, type ExportTarget, type StackReport } from '../config/stacks.js';
import { validate } from '../schemas/index.js';
import { resolveInside } from '../util/paths.js';

export const TEMPLATES_DIR = assetDir('templates');

const GITIGNORE_START = '# >>> tessa';
const GITIGNORE_END = '# <<< tessa';
// Artifacts root goes into .gitignore, so keep it to plain path characters.
const SAFE_ROOT = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export interface InitOptions {
  app?: { start?: string; url?: string; stack?: string; cwd?: string };
  seed_profiles?: Record<string, string[]>;
  personas?: { name: string; seed_profile: string; description?: string }[];
  export_target?: ExportTarget | 'auto';
  artifacts_root?: string;
  /** Globs the static map reads. Defaults to the first of src/ or app/ that exists. */
  source_include?: string[];
  /** Replace an existing .tessa/config.yaml. Hints are never replaced. */
  overwrite?: boolean;
  /** Return what would be written without writing anything. */
  dry_run?: boolean;
}

export interface FileAction {
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  reason?: string;
  /** File content, only for dry runs. */
  preview?: string;
}

export interface InitResult {
  ok: boolean;
  dry_run: boolean;
  detected: StackReport;
  files: FileAction[];
  /** Schema errors block writing; other issues mean the config needs editing before use. */
  issues: ConfigIssue[];
}

function template(name: string): string {
  return readFileSync(new URL(name, TEMPLATES_DIR), 'utf8');
}

export function buildConfigText(
  options: InitOptions,
  detected: StackReport,
  workspace?: string,
): { text: string; data: unknown } {
  const doc = parseDocument(template('config.yaml'));
  const app = options.app ?? {};
  const set = (path: string[], value: unknown) => {
    if (value !== undefined) {
      doc.setIn(path, doc.createNode(value));
    }
  };

  set(['app', 'start'], app.start ?? detected.start_command ?? undefined);
  set(['app', 'url'], app.url);
  set(['app', 'stack'], app.stack ?? detected.stack?.name);
  set(['app', 'cwd'], app.cwd);
  set(['db', 'profiles'], options.seed_profiles);
  set(['personas'], options.personas);
  set(['artifacts', 'root'], options.artifacts_root);
  set(
    ['context', 'static_map', 'include'],
    options.source_include ?? guessSourceInclude(workspace),
  );

  const exportTarget =
    options.export_target ??
    (detected.export_targets.length === 1 ? detected.export_targets[0]?.name : undefined);
  set(['export', 'target'], exportTarget);

  return {
    text: doc.toString({ lineWidth: 100, flowCollectionPadding: false }),
    data: doc.toJS(),
  };
}

const SOURCE_DIRS = ['src', 'app'];

function guessSourceInclude(workspace: string | undefined): string[] | undefined {
  if (workspace === undefined) {
    return undefined;
  }
  const dir = SOURCE_DIRS.find((name) => existsSync(resolveInside(workspace, name)));
  return dir === undefined ? undefined : [`${dir}/**`];
}

export function buildGitignoreBlock(artifactsRoot: string): string {
  return template('gitignore').replaceAll('{{ARTIFACTS_ROOT}}', artifactsRoot);
}

export function mergeGitignore(existing: string, block: string): string {
  const start = existing.indexOf(GITIGNORE_START);
  const end = existing.indexOf(GITIGNORE_END);
  if (start !== -1 && end > start) {
    const afterEnd = existing.indexOf('\n', end);
    const tail = afterEnd === -1 ? '' : existing.slice(afterEnd + 1);
    return existing.slice(0, start) + block + tail;
  }
  if (existing === '') {
    return block;
  }
  return `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${block}`;
}

function writeFile(
  workspace: string,
  relPath: string,
  content: string,
  dryRun: boolean,
  existing: string | null,
): FileAction {
  if (existing === content) {
    return { path: relPath, action: 'unchanged' };
  }
  const action = existing === null ? 'created' : 'updated';
  if (dryRun) {
    return { path: relPath, action, preview: content };
  }
  const absolute = resolveInside(workspace, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return { path: relPath, action };
}

function readIfExists(workspace: string, relPath: string): string | null {
  const absolute = resolveInside(workspace, relPath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

export function initWorkspace(workspace: string, options: InitOptions = {}): InitResult {
  const dryRun = options.dry_run ?? false;
  const detected = detectStack(workspace);
  const files: FileAction[] = [];

  const artifactsRoot = options.artifacts_root ?? 'ai-test-artifacts';
  if (!SAFE_ROOT.test(artifactsRoot)) {
    return {
      ok: false,
      dry_run: dryRun,
      detected,
      files,
      issues: [
        {
          severity: 'error',
          path: '/artifacts/root',
          message: 'use letters, digits, ".", "_", "-" and "/" only',
        },
      ],
    };
  }

  const { text, data } = buildConfigText(options, detected, workspace);
  const checked = validate('config', data);
  if (!checked.ok) {
    return {
      ok: false,
      dry_run: dryRun,
      detected,
      files: [
        { path: DEFAULT_CONFIG_PATH, action: 'skipped', reason: 'invalid config', preview: text },
      ],
      issues: checked.issues.map((i) => ({ severity: 'error', path: i.path, message: i.message })),
    };
  }
  const issues = checkSemantics(checked.value, workspace);

  const existingConfig = readIfExists(workspace, DEFAULT_CONFIG_PATH);
  if (existingConfig !== null && existingConfig !== text && options.overwrite !== true) {
    files.push({
      path: DEFAULT_CONFIG_PATH,
      action: 'skipped',
      reason: 'config already exists; pass overwrite to replace it',
    });
  } else {
    files.push(writeFile(workspace, DEFAULT_CONFIG_PATH, text, dryRun, existingConfig));
  }

  const hintsPath = `${artifactsRoot}/context/hints.md`;
  const existingHints = readIfExists(workspace, hintsPath);
  if (existingHints === null) {
    files.push(writeFile(workspace, hintsPath, template('hints.md'), dryRun, null));
  } else {
    files.push({ path: hintsPath, action: 'unchanged', reason: 'hints are never replaced' });
  }

  const existingIgnore = readIfExists(workspace, '.gitignore');
  const mergedIgnore = mergeGitignore(existingIgnore ?? '', buildGitignoreBlock(artifactsRoot));
  files.push(writeFile(workspace, '.gitignore', mergedIgnore, dryRun, existingIgnore));

  return { ok: true, dry_run: dryRun, detected, files, issues };
}
