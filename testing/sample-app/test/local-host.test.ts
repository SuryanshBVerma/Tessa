import { describe, expect, it } from 'vitest';
import { assertLocalDatabaseUrl, isLocalDatabaseUrl } from '../app/lib/local-host';

describe('isLocalDatabaseUrl', () => {
  it.each([
    'postgres://tessa:x@localhost:5433/tessa_sample',
    'postgres://tessa:x@127.0.0.1:5433/tessa_sample',
    'postgresql://tessa:x@[::1]:5433/tessa_sample',
  ])('accepts %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
  });

  it.each([
    'postgres://tessa:x@db.example.com:5432/prod',
    'postgres://tessa:x@10.0.0.5:5432/shared',
    'postgres://tessa:x@localhost.example.com/tessa',
    'postgres://tessa:x@127.0.0.1.nip.io/tessa',
    'postgres://tessa:x@localhost/tessa?host=db.example.com',
    'mysql://tessa:x@localhost/tessa',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });

  it('throws without echoing the connection string', () => {
    const url = 'postgres://tessa:supersecret@db.example.com/prod';
    expect(() => {
      assertLocalDatabaseUrl(url);
    }).toThrow(/local Postgres host/);
    expect(() => {
      assertLocalDatabaseUrl(url);
    }).not.toThrow(/supersecret/);
  });
});
