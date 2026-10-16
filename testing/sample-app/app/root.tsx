import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type LinksFunction,
} from 'react-router';
import type { Route } from './+types/root';
import stylesheet from './app.css?url';

export const links: LinksFunction = () => [{ rel: 'stylesheet', href: stylesheet }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Tessa Sample Tickets</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = 'Something went wrong';
  let message = 'An unexpected error occurred.';
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? 'Page not found' : `Error ${String(error.status)}`;
    message = typeof error.data === 'string' ? error.data : error.statusText;
  }
  return (
    <main className="page" data-testid="error-page">
      <h1>{title}</h1>
      <p role="alert">{message}</p>
      <a href="/tickets">Back to tickets</a>
    </main>
  );
}
