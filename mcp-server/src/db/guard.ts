// The local-host guard for seed_db and reset_db. This check has tests and is never weakened:
// seeding scripts drop and recreate tables, so they must never reach a shared or production
// database.

/** The only hosts Tessa will ever seed, whatever the config says. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** libpq parameters that can redirect a connection away from the URL's host. */
const HOST_PARAMS = ['host', 'hostaddr'];

export class UnsafeDatabaseError extends Error {
  constructor(reason: string) {
    // Never include the URL: it may carry a password.
    super(`Refusing to seed: ${reason}`);
    this.name = 'UnsafeDatabaseError';
  }
}

export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
}

function normaliseHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host.toLowerCase();
}

/**
 * Throws unless the URL is a Postgres URL whose host is both local and listed in
 * db.allowed_hosts. Returns the target without credentials, safe to report.
 */
export function assertSeedable(
  databaseUrl: string,
  allowedHosts: readonly string[],
): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeDatabaseError('the database URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new UnsafeDatabaseError('only postgres:// URLs are supported');
  }

  const host = normaliseHost(url.hostname);
  if (host === '') {
    throw new UnsafeDatabaseError('the database URL has no host');
  }
  for (const param of HOST_PARAMS) {
    for (const value of url.searchParams.getAll(param)) {
      if (normaliseHost(value) !== host) {
        throw new UnsafeDatabaseError(`the "${param}" parameter points somewhere else`);
      }
    }
  }

  const allowed = new Set(allowedHosts.map(normaliseHost));
  if (!LOCAL_HOSTS.has(host)) {
    throw new UnsafeDatabaseError(`host "${host}" is not a local host`);
  }
  if (!allowed.has(host)) {
    throw new UnsafeDatabaseError(`host "${host}" is not in db.allowed_hosts`);
  }

  return {
    host,
    port: url.port === '' ? 5432 : Number(url.port),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(default)',
  };
}
