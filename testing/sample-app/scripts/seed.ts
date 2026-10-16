// Resets the sample database and applies one seed profile.
// Usage: npm run db:seed -w sample-app -- [profile]   (default profile: "default")
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { assertLocalDatabaseUrl } from '../app/lib/local-host.ts';

// Profile names match the seed profiles in Tessa's config for this app.
const PROFILES: Record<string, readonly string[]> = {
  default: ['base.sql', 'users.sql', 'tickets.sql'],
  'admin-heavy': ['base.sql', 'admins.sql', 'tickets.sql'],
};

const SEED_DIR = join(import.meta.dirname, 'seed');

async function main(): Promise<void> {
  const profile = process.argv[2] ?? 'default';
  const files = PROFILES[profile];
  if (files === undefined) {
    throw new Error(
      `Unknown seed profile "${profile}". Known: ${Object.keys(PROFILES).join(', ')}.`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  assertLocalDatabaseUrl(databaseUrl);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) {
      await client.query(await readFile(join(SEED_DIR, file), 'utf8'));
    }
    await client.query('COMMIT');
    console.log(`Seeded profile "${profile}": ${files.join(', ')}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
