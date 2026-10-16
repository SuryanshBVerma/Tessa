import { data, Form } from 'react-router';
import { requirePermission } from '../lib/auth.server';
import { query } from '../lib/db.server';
import { isRole, ROLES } from '../lib/permissions';
import type { Route } from './+types/admin-users';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  active: boolean;
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUser = await requirePermission(request, 'users:manage');
  const users = await query<UserRow>(
    'SELECT id, username, display_name, role, active FROM users ORDER BY id',
  );
  return { users, currentUserId: currentUser.id };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUser = await requirePermission(request, 'users:manage');
  const form = await request.formData();
  const userId = Number(form.get('userId'));
  const role = form.get('role');
  if (!Number.isInteger(userId) || !isRole(role)) {
    return data({ error: 'Invalid role change.' }, { status: 400 });
  }
  // Admins cannot demote themselves, so the app always keeps at least the acting admin.
  if (userId === currentUser.id && role !== 'admin') {
    return data({ error: 'You cannot change your own role.' }, { status: 400 });
  }
  await query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
  return { error: null };
}

export default function AdminUsers({ loaderData, actionData }: Route.ComponentProps) {
  const { users, currentUserId } = loaderData;
  return (
    <section aria-labelledby="users-heading">
      <h1 id="users-heading">Users</h1>
      {actionData?.error ? (
        <p role="alert" className="error" data-testid="users-error">
          {actionData.error}
        </p>
      ) : null}
      <table data-testid="users-table">
        <thead>
          <tr>
            <th scope="col">Username</th>
            <th scope="col">Name</th>
            <th scope="col">Active</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} data-testid={`user-row-${user.username}`}>
              <td>{user.username}</td>
              <td>{user.display_name}</td>
              <td>{user.active ? 'yes' : 'no'}</td>
              <td>
                <Form method="post" className="inline">
                  <input type="hidden" name="userId" value={user.id} />
                  <select
                    name="role"
                    defaultValue={user.role}
                    aria-label={`Role for ${user.username}`}
                    disabled={user.id === currentUserId}
                    data-testid={`role-select-${user.username}`}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={user.id === currentUserId}
                    data-testid={`role-save-${user.username}`}
                  >
                    Save
                  </button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
