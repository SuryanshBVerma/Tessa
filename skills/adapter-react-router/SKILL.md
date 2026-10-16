---
name: adapter-react-router
description: Where React Router (framework mode) apps keep routes, guards, data loading and test hooks, and what Tessa's map does and does not capture for them. Use when planning or debugging tests for a react-router stack.
---

# React Router adapter

Tessa's `react-router` adapter reads framework-mode apps (React Router 7 and later).

## Where things live

| What              | Where                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes            | `app/routes.ts`: `route(path, file, [children])`, `index(file)`, `layout(file, [children])`, `...prefix(path, [children])`                     |
| App shell         | `app/root.tsx`, wrapping every route                                                                                                           |
| Data and guards   | Each route module's `loader` (reads, runs on GET) and `action` (writes, runs on POST)                                                          |
| Permission checks | Helpers such as `requireUser`, `requirePermission(request, '<perm>')` called in `loader`/`action`; `can(role, '<perm>')` for what the UI shows |
| Errors            | A thrown `data('...', { status: 403 })` or `redirect('/login')` in a loader; the nearest `ErrorBoundary` renders it                            |
| Test hooks        | `data-testid`, `role`, `aria-label`, `<label>` text on elements in route modules and their imports                                             |

## What the map captures

- The full route tree with URL patterns (`/tickets/:ticketId`) and layout nesting.
- Per module: exports, guards with their string arguments and where they run, links
  (`<Link to>`, `<NavLink to>`, `<a href>`, `<Form action>`, `redirect()`), fetches and HTTP
  client calls, flag reads (`flags.x`, `useFlag('x')`), and selectors, including both texts of
  a ternary such as `{open ? 'Close ticket' : 'Reopen ticket'}`.

## What it cannot see

- Values computed at runtime: a test id built from a variable shows as a pattern
  (`ticket-row-*`); a permission name passed in a variable is not captured.
- Routes added with `flatRoutes()` or other file-system conventions. Use explicit route
  helpers, or check routes in the browser.
- Components from packages (`node_modules`) or outside `context.static_map.include`; their
  test ids appear only in a runtime crawl.

## Testing tips

- A guard in `loader` protects the page (GET); a guard only in `action` protects the change
  (POST). Plan negative tests for both when the story is about permissions.
- `<Form method="post">` submits to the route's own `action` unless it has an `action` attribute.
- Native validation attributes (`required`, `minLength`) stop the browser before the
  server's validation runs; assert the input's state or the native message in that case.
