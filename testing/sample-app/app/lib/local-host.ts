// The sample app only ever talks to a database on this machine. This guard is shared by the
// app's connection pool and its seed script.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return false;
  }
  // A `host` query parameter overrides the URL host in libpq-style connection strings.
  const hostOverride = url.searchParams.get('host');
  if (hostOverride !== null && !LOCAL_HOSTS.has(hostOverride)) {
    return false;
  }
  return LOCAL_HOSTS.has(url.hostname);
}

export function assertLocalDatabaseUrl(databaseUrl: string): void {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(
      'DATABASE_URL must point to a local Postgres host (localhost, 127.0.0.1, ::1).',
    );
  }
}
