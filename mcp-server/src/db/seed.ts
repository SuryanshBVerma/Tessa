import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import type { ResolvedConfig } from '../config/index.js';
import { resolveInside } from '../util/paths.js';
import { assertSeedable, type DatabaseTarget } from './guard.js';

const MAX_SEED_BYTES = 10 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 60_000;

export type UrlSource = 'environment' | `${string}/.env`;

/**
 * Reads the database URL from the environment variable named by db.url_env, falling back to a
 * gitignored .env file in app.cwd, then in the workspace root. The URL is never returned to the
 * agent.
 */
export function resolveDatabaseUrl(
  config: ResolvedConfig,
  workspace: string,
): { url: string; source: UrlSource } {
  const name = config.db.url_env;
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { url: fromEnv, source: 'environment' };
  }
  for (const dir of new Set([config.app.cwd, '.'])) {
    const file = resolveInside(workspace, join(dir, '.env'));
    if (existsSync(file)) {
      const value = parseEnv(readFileSync(file, 'utf8'))[name];
      if (value !== undefined && value !== '') {
        return { url: value, source: `${dir === '.' ? '' : `${dir}/`}.env` as UrlSource };
      }
    }
  }
  throw new Error(
    `${name} is not set. Export it, or add it to a gitignored .env in the app directory.`,
  );
}

export interface SeedResult {
  profile: string;
  files: string[];
  target: DatabaseTarget;
  url_source: UrlSource;
  duration_ms: number;
}

export class SeedError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(message);
    this.name = 'SeedError';
  }
}

function readSeedFiles(config: ResolvedConfig, workspace: string, profile: string) {
  const files = config.db.profiles[profile];
  if (files === undefined) {
    throw new SeedError(
      `unknown seed profile "${profile}"; defined: ${Object.keys(config.db.profiles).join(', ')}`,
    );
  }
  // Only files listed in config ever run: the profile is the allowlist.
  return files.map((file) => {
    if (!file.endsWith('.sql')) {
      throw new SeedError(`seed files must be .sql files`, file);
    }
    const absolute = resolveInside(workspace, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new SeedError(`seed file does not exist`, file);
    }
    if (statSync(absolute).size > MAX_SEED_BYTES) {
      throw new SeedError(`seed file is larger than 10 MB`, file);
    }
    return { file, sql: readFileSync(absolute, 'utf8') };
  });
}

/** Applies a seed profile's files in order, in one transaction. */
export async function seedProfile(
  config: ResolvedConfig,
  workspace: string,
  profile: string,
): Promise<SeedResult> {
  const { url, source } = resolveDatabaseUrl(config, workspace);
  const target = assertSeedable(url, config.db.allowed_hosts);
  const scripts = readSeedFiles(config, workspace, profile);

  const started = performance.now();
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'tessa-mcp',
  });
  try {
    await client.connect();
  } catch (error) {
    throw new SeedError(
      `could not connect to ${target.host}:${String(target.port)}/${target.database}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let current: string | undefined;
  try {
    await client.query('BEGIN');
    for (const script of scripts) {
      current = script.file;
      await client.query(script.sql);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new SeedError(
      `seed failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      current,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
  return {
    profile,
    files: scripts.map((s) => s.file),
    target,
    url_source: source,
    duration_ms: Math.round(performance.now() - started),
  };
}
