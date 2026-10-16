import { describe, expect, it } from 'vitest';
import { can, isRole, type Permission, type Role } from '../app/lib/permissions';

const MATRIX: [Role, Permission, boolean][] = [
  ['viewer', 'tickets:read', true],
  ['viewer', 'tickets:create', false],
  ['viewer', 'tickets:close', false],
  ['viewer', 'users:manage', false],
  ['editor', 'tickets:read', true],
  ['editor', 'tickets:create', true],
  ['editor', 'tickets:close', true],
  ['editor', 'users:manage', false],
  ['admin', 'tickets:read', true],
  ['admin', 'tickets:create', true],
  ['admin', 'tickets:close', true],
  ['admin', 'users:manage', true],
];

describe('can', () => {
  it.each(MATRIX)('%s / %s → %s', (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });
});

describe('isRole', () => {
  it('accepts known roles only', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
