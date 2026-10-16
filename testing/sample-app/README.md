# Tessa sample app

A small ticket tracker with three roles. It is the app Tessa tests during development, so it is
deliberately simple. It is not an example of production practice.

- React Router (framework mode) on Node, Postgres 17 in Docker.
- Everything binds to `127.0.0.1` only: the dev server on port 5173, Postgres on port 5433.

## Run it

```bash
cp testing/sample-app/.env.example testing/sample-app/.env   # then fill in local-only values
npm install
npm run sample                               # starts Postgres, then the dev server
```

The first `docker compose up` creates the database and applies the `default` seed profile.
Open <http://127.0.0.1:5173> and sign in as `viewer`, `editor` or `admin` with the value of
`SAMPLE_APP_PASSWORD` from your `.env`.

## Roles

| Role     | Read tickets | Create tickets | Close/reopen tickets | Manage user roles |
| -------- | ------------ | -------------- | -------------------- | ----------------- |
| `viewer` | yes          | no             | no                   | no                |
| `editor` | yes          | yes            | yes                  | no                |
| `admin`  | yes          | yes            | yes                  | yes               |

The `inactive` user exists but cannot sign in.

## Pages

| Route                | Who           | What                                                  |
| -------------------- | ------------- | ----------------------------------------------------- |
| `/login`             | anyone        | Sign-in form                                          |
| `/tickets`           | all roles     | Ticket list with a status filter                      |
| `/tickets/new`       | editor, admin | Create a ticket                                       |
| `/tickets/:ticketId` | all roles     | Ticket detail; editors and admins can close or reopen |
| `/settings`          | all roles     | Theme setting and the current user's permissions      |
| `/admin/users`       | admin         | Change other users' roles                             |

Feature flags live in the `feature_flags` table. `ticket_priority` (on by default) shows the
priority column and field.

## Seed profiles

```bash
npm run db:seed -w testing/sample-app                 # default: one user per role
npm run db:seed -w testing/sample-app -- admin-heavy  # several admins and one viewer
```

Each profile starts with `scripts/seed/base.sql`, which drops and recreates every table. The seed
script refuses any `DATABASE_URL` whose host is not `localhost`, `127.0.0.1` or `::1`.

## Sign-in in this app

Seeded users have no stored password. Every active user signs in with the shared local test
password from `SAMPLE_APP_PASSWORD`, so no credential or hash is ever committed. This is a
simplification for a local test target only. Sessions are signed cookies (`SESSION_SECRET`).

## Other scripts

| Script                                     | Action                              |
| ------------------------------------------ | ----------------------------------- |
| `npm run db:up -w testing/sample-app`      | Start Postgres only                 |
| `npm run db:down -w testing/sample-app`    | Stop Postgres, keep data            |
| `npm run db:destroy -w testing/sample-app` | Stop Postgres and delete its volume |
| `npm run build -w testing/sample-app`      | Production build                    |
| `npm run start -w testing/sample-app`      | Serve the production build          |
