import { Form, NavLink, Outlet } from 'react-router';
import { requireUser } from '../lib/auth.server';
import { can } from '../lib/permissions';
import type { Route } from './+types/app-layout';

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return {
    user,
    canCreateTickets: can(user.role, 'tickets:create'),
    canManageUsers: can(user.role, 'users:manage'),
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, canCreateTickets, canManageUsers } = loaderData;
  return (
    <div className="shell" data-theme={user.theme}>
      <header className="topbar">
        <nav aria-label="Main" data-testid="main-nav">
          <NavLink to="/tickets" end data-testid="nav-tickets">
            Tickets
          </NavLink>
          {canCreateTickets ? (
            <NavLink to="/tickets/new" data-testid="nav-new-ticket">
              New ticket
            </NavLink>
          ) : null}
          <NavLink to="/settings" data-testid="nav-settings">
            Settings
          </NavLink>
          {canManageUsers ? (
            <NavLink to="/admin/users" data-testid="nav-admin-users">
              Users
            </NavLink>
          ) : null}
        </nav>
        <div className="who">
          <span data-testid="current-user">
            {user.displayName} ({user.role})
          </span>
          <Form method="post" action="/logout">
            <button type="submit" className="link" data-testid="logout">
              Sign out
            </button>
          </Form>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
