import { query } from './db.server';

export type Flags = Record<string, boolean>;

export async function getFlags(): Promise<Flags> {
  const rows = await query<{ name: string; enabled: boolean }>(
    'SELECT name, enabled FROM feature_flags',
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.enabled]));
}
