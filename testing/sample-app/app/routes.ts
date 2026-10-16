import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/app-layout.tsx', [
    index('routes/home.tsx'),
    route('tickets', 'routes/tickets.tsx'),
    route('tickets/new', 'routes/ticket-new.tsx'),
    route('tickets/:ticketId', 'routes/ticket.tsx'),
    route('settings', 'routes/settings.tsx'),
    route('admin/users', 'routes/admin-users.tsx'),
  ]),
] satisfies RouteConfig;
