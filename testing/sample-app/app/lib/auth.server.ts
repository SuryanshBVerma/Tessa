import { createHash, timingSafeEqual } from 'node:crypto';
import { data, redirect } from 'react-router';
import { query } from './db.server';
import { requireEnv } from './env.server';
import { can, isRole, type Permission, type Role } from './permissions';
import { sessionStorage } from './session.server';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  theme: 'light' | 'dark';
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  theme: 'light' | 'dark';
}

function toUser(row: UserRow): User {
  if (!isRole(row.role)) {
    throw new Error('Unknown role in users table');
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    theme: row.theme,
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

// Sample-app simplification: every seeded user shares one local test password from the
// environment, so no credential or hash is ever committed. Not a pattern for real apps.
function passwordMatches(candidate: string): boolean {
  return timingSafeEqual(digest(candidate), digest(requireEnv('SAMPLE_APP_PASSWORD')));
}

export async function authenticate(username: string, password: string): Promise<User | null> {
  const rows = await query<UserRow>(
    'SELECT id, username, display_name, role, theme FROM users WHERE username = $1 AND active',
    [username],
  );
  const row = rows[0];
  // Compare even when the user is missing so response time does not reveal valid usernames.
  const matches = passwordMatches(password);
  return row !== undefined && matches ? toUser(row) : null;
}

export async function getUser(request: Request): Promise<User | null> {
  const session = await sessionStorage.getSession(request.headers.get('Cookie'));
  const userId = session.get('userId');
  if (userId === undefined) {
    return null;
  }
  const rows = await query<UserRow>(
    'SELECT id, username, display_name, role, theme FROM users WHERE id = $1 AND active',
    [userId],
  );
  const row = rows[0];
  return row === undefined ? null : toUser(row);
}

export async function requireUser(request: Request): Promise<User> {
  const user = await getUser(request);
  if (user === null) {
    const url = new URL(request.url);
    const params = new URLSearchParams({ redirectTo: url.pathname + url.search });
    throw redirect(`/login?${params.toString()}`);
  }
  return user;
}

export async function requirePermission(request: Request, permission: Permission): Promise<User> {
  const user = await requireUser(request);
  if (!can(user.role, permission)) {
    throw data('You do not have permission to view this page.', { status: 403 });
  }
  return user;
}

export async function createUserSession(userId: number, redirectTo: string): Promise<Response> {
  const session = await sessionStorage.getSession();
  session.set('userId', userId);
  return redirect(redirectTo, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}

export async function destroyUserSession(request: Request): Promise<Response> {
  const session = await sessionStorage.getSession(request.headers.get('Cookie'));
  return redirect('/login', {
    headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
  });
}
