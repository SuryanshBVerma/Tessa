---
name: adapter-angular
description: Where Angular apps keep routes, guards, templates, services and test hooks, what Tessa's map does and does not capture for them, and how to plan and run tests around Angular Material, reactive forms and a separate backend. Use when planning, running or debugging tests for an angular stack.
---

<!-- tessa-generated: written by tessa-qa 0.9.1 from skills/adapter-angular/SKILL.md. Edits are overwritten; change .tessa/config.yaml or the source instead. -->

# Angular adapter

Tessa's `angular` adapter reads Angular apps written with standalone components
(`provideRouter`) or NgModules (`RouterModule.forRoot` / `forChild`), Angular 14 and later.

## Where things live

| What              | Where                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Routes            | A `Routes` array, usually `src/app/app.routes.ts` or `app-routing.module.ts`; lazy parts behind `loadComponent` and `loadChildren`       |
| App shell         | `src/app/app.component.ts` (or `app.ts`), and any component route with `children`, which renders them in its `<router-outlet>`           |
| Route guards      | `canActivate`, `canMatch`, `canActivateChild` on the route: functional guards (`authGuard`, `roleGuard('admin')`) or guard classes       |
| Roles on a route  | Route `data`, such as `data: { roles: ['admin'] }`, read by a guard                                                                      |
| Visibility checks | Template conditions: `@if (auth.can('x'))`, `*ngIf="auth.hasRole('admin')"`, or a directive such as `*appHasRole="'admin'"`              |
| Data              | Services calling `HttpClient` (`this.http.get('/api/...')`); the backend is usually a separate app                                       |
| Test hooks        | `data-testid` or `[attr.data-testid]`, `role`, `aria-label`, `<label>` and `<mat-label>` text, button and heading text, in each template |

## What the map captures

- The route tree with full URL patterns (`/tickets/:id`), through lazy `loadComponent` and
  `loadChildren`, including NgModules that call `RouterModule.forChild`.
- Guards declared on each route and its ancestors, with their string arguments, and role or
  permission lists in route `data`. `permissions_for_route` reports them as enforced (by the
  router), and template checks as visibility.
- Per component: its template (inline or `templateUrl`), with test ids (bound ones as patterns,
  such as `ticket-row-*`), labels, visible text, `routerLink` targets (`['/tickets', id]` becomes
  `/tickets/*`), and permission checks. Selectors from a `templateUrl` carry `source`, the HTML
  file they are in.
- Services' `HttpClient` calls, and imports through `tsconfig` path aliases (`@app/...`).

## What it cannot see

- Routes built at runtime, string `loadChildren: 'path#Module'` (pre-Angular 8), and routes
  registered by libraries.
- Text produced by interpolation or pipes (`{{ 'KEY' | translate }}`): the map has no text
  selector for it. Prefer test ids, or read the text in the browser during a crawl.
- Child components that a template uses only through an NgModule's `declarations`, with no
  import from the parent component. Their selectors appear only in a runtime crawl.
- Whether the backend enforces a permission. Angular guards run in the browser; they stop
  navigation, not the API.

## Planning tips

- **Route guards are not security.** When a story says a role must not do something, plan the
  UI test (the link is hidden, the route redirects) and say in the plan that the API's own check
  is out of Tessa's reach.
- **Angular Material controls are not native.** For `mat-select`, plan a `click` on the select
  (by its test id or label) and then a `click` on the option (role `option` with its name);
  never the `select` action, which only works on `<select>`. The same goes for `mat-autocomplete`
  and date pickers.
- **Overlays render elsewhere.** Dialogs, menus, snack bars and select panels render in the
  CDK overlay container at the end of `<body>`, not inside the component. Target them by role
  (`dialog`, `menu`, `option`, `status`) and name, not by a parent test id.
- **Reactive form errors appear after touch.** `mat-error` and most validation messages show
  only once the field is touched or the form is submitted. Plan a step that leaves the field
  (click elsewhere) or submits before asserting the message. A button bound to
  `[disabled]="form.invalid"` cannot be clicked while the form is invalid: assert that it is
  disabled instead.
- **Lazy routes load on navigation.** After a `navigate` or a link click, wait for an element
  of the target page before asserting.

## Running tips

- `ng serve` (`npm start`) serves on `http://localhost:4200` by default. Set `app.url` to it and
  `app.health_path` to `/`.
- The backend usually runs separately. Start it yourself before the run, or point `app.start`
  at a single script that starts both (for example an npm script using `concurrently`);
  `app.start` cannot use `&&`. `start_app` only checks the frontend's health path.
- Single sign-on and token sign-in keep the session in the browser (cookies or
  `localStorage`); the host browser keeps it between tests. To switch persona, sign out in
  the app first.
- Seed the backend's database, not the Angular app: the seed profiles point at the backend's
  SQL scripts.
