import pg from 'pg';
import { requireEnv } from './env.server';
import { assertLocalDatabaseUrl } from './local-host';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool === undefined) {
    const databaseUrl = requireEnv('DATABASE_URL');
    assertLocalDatabaseUrl(databaseUrl);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  }
  return pool;
}

export async function query<Row extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const result = await getPool().query<Row>(text, values);
  return result.rows;
}
