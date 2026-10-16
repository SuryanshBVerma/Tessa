# Manage user roles

**As an** admin, **I want to** change other users' roles, **so that** people get the access
their job needs.

## Acceptance criteria

1. An admin can change another user's role from the Users page, and the new role is kept after
   the page reloads.
2. An admin cannot change their own role; the controls for their own row are disabled.
3. Editors and viewers do not see the Users link and get 403 on /admin/users.
