# Test plan: Manage user roles

Story `manage-roles` from stories/manage-roles.md. 4 test(s).

Generated from `tests.json` by tessa-mcp. Edit `tests.json`, not this file.

## Acceptance criteria

| ID   | Criterion                                                                                                     | Tests                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ac-1 | An admin can change another user's role from the Users page, and the new role is kept after the page reloads. | `admin-changes-role`                                       |
| ac-2 | An admin cannot change their own role; the controls for their own row are disabled.                           | `admin-cannot-change-own-role`                             |
| ac-3 | Editors and viewers do not see the Users link and get 403 on /admin/users.                                    | `editor-cannot-manage-users`, `viewer-cannot-manage-users` |

## Tests

### Admin promotes a viewer to editor

`admin-changes-role` · persona **admin** · seed `admin-heavy` · starts at `/admin/users`

Proves an admin can change another user's role and the change is saved, not just shown.

1. Set the viewer's role to editor _(select testid `role-select-viewer` → `editor`)_
2. Save the viewer's role _(click testid `role-save-viewer`)_
3. Reload the Users page _(navigate → `/admin/users`)_
4. The viewer's role is now editor _(assert testid `role-select-viewer` — value-equals `editor`)_

### Admin cannot change their own role

`admin-cannot-change-own-role` · persona **admin** · seed `admin-heavy` · starts at `/admin/users`

Proves the signed-in admin's own row cannot be edited, so an admin cannot demote themselves.

1. The admin's own role select is disabled _(assert testid `role-select-admin` — disabled)_
2. The admin's own Save button is disabled _(assert testid `role-save-admin` — disabled)_
3. Another admin's role can still be edited _(assert testid `role-select-admin2` — enabled)_

### Editor cannot reach the Users page

`editor-cannot-manage-users` · persona **editor** · seed `default` · starts at `/tickets`

Proves the manage-users permission is enforced for editors in navigation and on the server.

1. No Users link in the navigation _(assert testid `nav-admin-users` — count-equals `0`)_
2. Go to the Users page directly _(navigate → `/admin/users`)_
3. A permission error is shown _(assert role `alert` — text-contains `permission`)_

### Viewer cannot reach the Users page

`viewer-cannot-manage-users` · persona **viewer** · seed `default` · starts at `/tickets`

Proves the manage-users permission is enforced for viewers in navigation and on the server.

1. No Users link in the navigation _(assert testid `nav-admin-users` — count-equals `0`)_
2. Go to the Users page directly _(navigate → `/admin/users`)_
3. A permission error is shown _(assert role `alert` — text-contains `permission`)_
