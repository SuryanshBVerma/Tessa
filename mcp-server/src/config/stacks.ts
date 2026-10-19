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
  /** Every stack that matched, strongest first. */
  candidates: Detection<string>[];
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

export function detectStack(workspace: string): StackReport {
  const pkg = readPackageJson(join(workspace, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  const candidates: Detection<string>[] = [];
  for (const rule of STACK_RULES) {
    const hits = rule.packages.filter((name) => Object.hasOwn(deps, name));
    if (hits.length > 0) {
      candidates.push({ name: rule.name, evidence: hits.map((h) => `package.json: ${h}`) });
    }
  }

  const exportTargets: Detection<ExportTarget>[] = [];
  for (const rule of NODE_EXPORT_RULES) {
    const hits = rule.packages.filter((name) => Object.hasOwn(deps, name));
    if (hits.length > 0) {
      exportTargets.push({ name: rule.name, evidence: hits.map((h) => `package.json: ${h}`) });
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
  const packageManager =
    lockfiles.find(([, file]) => existsSync(join(workspace, file)))?.[0] ??
    (pkg === null ? null : 'npm');

  const scripts = pkg?.scripts ?? {};
  const script = ['dev', 'start'].find((name) => Object.hasOwn(scripts, name));
  const run = packageManager === 'npm' || packageManager === null ? 'npm run' : packageManager;
  const startCommand = script === undefined ? null : `${run} ${script}`;

  const best = candidates[0];
  return {
    stack:
      best === undefined
        ? null
        : { ...best, adapter_available: KNOWN_ADAPTERS.includes(best.name) },
    candidates,
    export_targets: exportTargets,
    package_manager: packageManager,
    start_command: startCommand,
    url_hint: best === undefined ? null : (URL_HINTS[best.name] ?? null),
    export_target_ambiguous: new Set(exportTargets.map((t) => t.name)).size > 1,
  };
}
