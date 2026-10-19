import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADAPTERS } from '../context/adapters/index.js';

/** Stack adapters that ship with Tessa, from the adapter registry. */
export const KNOWN_ADAPTERS: readonly string[] = Object.keys(ADAPTERS);

export type ExportTarget =
  'playwright-ts' | 'playwright-dotnet' | 'cypress-ts' | 'selenium-csharp' | 'selenium-java';

export interface Detection<T extends string> {
  name: T;
  evidence: string[];
}

export interface StackReport {
  /** Best stack guess, or null when nothing matched. */
  stack: (Detection<string> & { adapter_available: boolean }) | null;
  /** Every stack that matched, in any folder. */
  candidates: Detection<string>[];
  /**
   * The folder the app is in, relative to the workspace: "." at the root, or a subfolder in a
   * monorepo (for example "frontend"). Becomes app.cwd, and the static map is read from there.
   */
  app_root: string;
  /** Backends found beside the app (dotnet, node, java). They must be running for a test run. */
  backends: Detection<string>[];
  export_targets: Detection<ExportTarget>[];
  package_manager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  /** Suggested app start command, from package.json scripts. */
  start_command: string | null;
  /** The stack's usual dev server URL, to suggest for app.url; the user confirms it. */
  url_hint: string | null;
  /** True when more than one export target matched and the user must choose. */
  export_target_ambiguous: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

// Ordered by specificity: frameworks built on React Router are checked before it.
const STACK_RULES: { name: string; packages: string[] }[] = [
  { name: 'nextjs', packages: ['next'] },
  { name: 'remix', packages: ['@remix-run/react'] },
  { name: 'react-router', packages: ['@react-router/dev', 'react-router', 'react-router-dom'] },
  { name: 'angular', packages: ['@angular/core'] },
  { name: 'vue', packages: ['vue'] },
  { name: 'svelte', packages: ['svelte'] },
];

/** Default dev server addresses: Vite for React Router, the Angular CLI's ng serve. */
const URL_HINTS: Record<string, string> = {
  'react-router': 'http://localhost:5173',
  angular: 'http://localhost:4200',
};

const NODE_EXPORT_RULES: { name: ExportTarget; packages: string[] }[] = [
  { name: 'playwright-ts', packages: ['@playwright/test'] },
  { name: 'cypress-ts', packages: ['cypress'] },
];

function readPackageJson(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function listFiles(dir: string, depth: number, matches: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name.startsWith('.') ||
        entry.name === 'bin' ||
        entry.name === 'obj'
      ) {
        continue;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory() && level < depth) {
        walk(full, level + 1);
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(dir, 0);
  return found;
}

function relativeTo(workspace: string, path: string): string {
  return path.slice(workspace.length + 1).replaceAll('\\', '/');
}

/** Folders searched for package.json files: the root, and up to four levels down. */
const PACKAGE_DEPTH = 4;

/** A package.json and the folder it is in ("." for the workspace root). */
interface PackageDir {
  dir: string;
  pkg: PackageJson;
  deps: Record<string, string>;
}

function packageDirs(workspace: string): PackageDir[] {
  const files = listFiles(workspace, PACKAGE_DEPTH, (name) => name === 'package.json');
  return files
    .map((file) => {
      const rel = relativeTo(workspace, file);
      const dir = rel === 'package.json' ? '.' : rel.slice(0, -'/package.json'.length);
      const pkg = readPackageJson(file);
      return pkg === null
        ? null
        : { dir, pkg, deps: { ...pkg.dependencies, ...pkg.devDependencies } };
    })
    .filter((p): p is PackageDir => p !== null)
    .sort((a, b) => (a.dir === '.' ? -1 : b.dir === '.' ? 1 : a.dir.localeCompare(b.dir)));
}

function where(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

/**
 * Backends next to the frontend. Tessa does not start or read them, but the user must have them
 * running for a test run, so /tessa-init mentions them.
 */
function detectBackends(workspace: string, packages: PackageDir[], appDir: string) {
  const backends: Detection<string>[] = [];
  for (const csproj of listFiles(workspace, PACKAGE_DEPTH, (name) => name.endsWith('.csproj'))) {
    if (/Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(readFileSync(csproj, 'utf8'))) {
      backends.push({
        name: 'dotnet',
        evidence: [`${relativeTo(workspace, csproj)}: Microsoft.NET.Sdk.Web`],
      });
    }
  }
  for (const p of packages) {
    if (p.dir === appDir) continue;
    const hits = ['@nestjs/core', 'express', 'fastify', 'koa', 'hono'].filter((n) =>
      Object.hasOwn(p.deps, n),
    );
    if (hits.length > 0) {
      backends.push({
        name: 'node',
        evidence: hits.map((h) => `${where(p.dir, 'package.json')}: ${h}`),
      });
    }
  }
  for (const pom of listFiles(workspace, PACKAGE_DEPTH, (name) => name === 'pom.xml')) {
    if (/spring-boot/.test(readFileSync(pom, 'utf8'))) {
      backends.push({ name: 'java', evidence: [`${relativeTo(workspace, pom)}: spring-boot`] });
    }
  }
  return backends;
}

export function detectStack(workspace: string): StackReport {
  const packages = packageDirs(workspace);

  // Every frontend found, in every folder; the app is the first one Tessa has an adapter for.
  // Every matching rule is a candidate; a folder's first match (rules run most specific first)
  // is what that folder is. A Next.js app that also depends on react-router is a Next.js app.
  const found: (Detection<string> & { dir: string; primary: boolean })[] = [];
  for (const p of packages) {
    let primary = true;
    for (const rule of STACK_RULES) {
      const hits = rule.packages.filter((name) => Object.hasOwn(p.deps, name));
      if (hits.length > 0) {
        found.push({
          name: rule.name,
          dir: p.dir,
          primary,
          evidence: hits.map((h) => `${where(p.dir, 'package.json')}: ${h}`),
        });
        primary = false;
      }
    }
  }
  const primaries = found.filter((f) => f.primary);
  const chosen =
    primaries.find((f) => KNOWN_ADAPTERS.includes(f.name)) ??
    primaries.find((f) => f.dir === '.') ??
    primaries[0];
  const appDir = chosen?.dir ?? '.';
  const app = packages.find((p) => p.dir === appDir);
  const root = packages.find((p) => p.dir === '.');
  const candidates: Detection<string>[] = found.map(({ name, evidence }) => ({ name, evidence }));

  const exportTargets: Detection<ExportTarget>[] = [];
  for (const p of packages) {
    for (const rule of NODE_EXPORT_RULES) {
      const hits = rule.packages.filter((name) => Object.hasOwn(p.deps, name));
      if (hits.length > 0) {
        exportTargets.push({
          name: rule.name,
          evidence: hits.map((h) => `${where(p.dir, 'package.json')}: ${h}`),
        });
      }
    }
  }

  for (const csproj of listFiles(workspace, 3, (name) => name.endsWith('.csproj'))) {
    const text = readFileSync(csproj, 'utf8');
    const where = relativeTo(workspace, csproj);
    if (/Include="Microsoft\.Playwright/i.test(text)) {
      exportTargets.push({
        name: 'playwright-dotnet',
        evidence: [`${where}: Microsoft.Playwright`],
      });
    }
    if (/Include="Selenium\.WebDriver"/i.test(text)) {
      exportTargets.push({ name: 'selenium-csharp', evidence: [`${where}: Selenium.WebDriver`] });
    }
  }
  for (const pom of listFiles(workspace, 3, (name) => name === 'pom.xml')) {
    if (/<groupId>org\.seleniumhq\.selenium<\/groupId>/.test(readFileSync(pom, 'utf8'))) {
      exportTargets.push({
        name: 'selenium-java',
        evidence: [`${relativeTo(workspace, pom)}: org.seleniumhq.selenium`],
      });
    }
  }

  const lockfiles: [StackReport['package_manager'], string][] = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['bun', 'bun.lockb'],
    ['npm', 'package-lock.json'],
  ];
  // The app's own lockfile, else the root's (a workspace monorepo has one at the root).
  const packageManager =
    lockfiles.find(([, file]) => existsSync(join(workspace, appDir, file)))?.[0] ??
    lockfiles.find(([, file]) => existsSync(join(workspace, file)))?.[0] ??
    (app === undefined && root === undefined ? null : 'npm');

  const scripts = (app ?? root)?.pkg.scripts ?? {};
  const script = ['dev', 'start'].find((name) => Object.hasOwn(scripts, name));
  const run = packageManager === 'npm' || packageManager === null ? 'npm run' : packageManager;
  const startCommand = script === undefined ? null : `${run} ${script}`;

  return {
    stack:
      chosen === undefined
        ? null
        : {
            name: chosen.name,
            evidence: chosen.evidence,
            adapter_available: KNOWN_ADAPTERS.includes(chosen.name),
          },
    candidates,
    app_root: appDir,
    backends: detectBackends(workspace, packages, appDir),
    export_targets: exportTargets,
    package_manager: packageManager,
    start_command: startCommand,
    url_hint: chosen === undefined ? null : (URL_HINTS[chosen.name] ?? null),
    export_target_ambiguous: new Set(exportTargets.map((t) => t.name)).size > 1,
  };
}
