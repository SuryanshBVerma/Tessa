export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Permission = 'tickets:read' | 'tickets:create' | 'tickets:close' | 'users:manage';

const PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ['tickets:read'],
  editor: ['tickets:read', 'tickets:create', 'tickets:close'],
  admin: ['tickets:read', 'tickets:create', 'tickets:close', 'users:manage'],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return PERMISSIONS[role];
}
