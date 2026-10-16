# Test plan: Editors can create tickets; viewers cannot

Story `create-ticket` from stories/create-ticket.md. 3 test(s).

Generated from `tests.json` by tessa-mcp. Edit `tests.json`, not this file.

## Acceptance criteria

| ID   | Criterion                                                               | Tests                   |
| ---- | ----------------------------------------------------------------------- | ----------------------- |
| ac-1 | An editor can create a ticket with a title and priority.                | `editor-creates-ticket` |
| ac-2 | A title shorter than 3 characters is rejected with a message.           | `short-title-rejected`  |
| ac-3 | A viewer does not see the New ticket link and gets 403 on /tickets/new. | `viewer-cannot-create`  |

## Tests

### Editor creates a high-priority ticket

`editor-creates-ticket` · persona **editor** · seed `default` · starts at `/tickets` · flags ticket_priority=true

Proves an editor can create a ticket and lands on its detail page.

1. Click New ticket _(click testid `create-ticket`)_
2. Enter a title _(fill label `Title` → `Export button is misaligned`)_
3. Choose high priority _(select testid `ticket-priority` → `high`)_
4. Submit the form _(click role `button` "Create ticket")_
5. The ticket detail page opens _(assert — url-matches `^/tickets/[0-9]+$`)_
6. Priority shows high _(assert testid `ticket-priority-value` — text-equals `high`)_

### Short title is rejected

`short-title-rejected` · persona **editor** · seed `default`

Proves a title under 3 characters is rejected with a visible validation message.

1. Open the new ticket form _(navigate → `/tickets/new`)_
2. Enter a two-character title _(fill testid `ticket-title` → `ab`)_
3. Submit the form _(click testid `ticket-submit`)_
4. The title error message is shown _(assert testid `ticket-title-error` — text-contains `between 3 and 120`)_

### Viewer cannot open the new ticket form

`viewer-cannot-create` · persona **viewer** · seed `default` · starts at `/tickets`

Proves the create permission is enforced in navigation and on the server.

1. No New ticket link in the navigation _(assert testid `nav-new-ticket` — count-equals `0`)_
2. Go to the form directly _(navigate → `/tickets/new`)_
3. A permission error is shown _(assert role `alert` — text-contains `permission`)_
