# Test plan: Close and reopen a ticket

Story `close-ticket` from stories/close-ticket.md. 4 test(s).

Generated from `tests.json` by tessa-mcp. Edit `tests.json`, not this file.

## Acceptance criteria

| ID   | Criterion                                                                                  | Tests                            |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| ac-1 | An editor can close an open ticket from its detail page; its status shows "closed".        | `editor-closes-ticket`           |
| ac-2 | An editor can reopen a closed ticket; its status shows "open" again.                       | `editor-reopens-ticket`          |
| ac-3 | A closed ticket appears under the "closed" filter of the ticket list and not under "open". | `closed-ticket-in-closed-filter` |
| ac-4 | A viewer can open a ticket's detail page but does not see a button to close or reopen it.  | `viewer-cannot-close`            |

## Tests

### Editor closes an open ticket

`editor-closes-ticket` · persona **editor** · seed `default` · starts at `/tickets/1`

Proves an editor can close an open ticket from its detail page and the status changes to closed.

1. Ticket #1 starts open _(assert testid `ticket-status` — text-equals `open`)_
2. Click Close ticket _(click role `button` "Close ticket")_
3. The status shows closed _(assert testid `ticket-status` — text-equals `closed`)_

### Editor reopens a closed ticket

`editor-reopens-ticket` · persona **editor** · seed `default` · starts at `/tickets/3`

Proves an editor can reopen a closed ticket and the status changes back to open.

1. Ticket #3 starts closed _(assert testid `ticket-status` — text-equals `closed`)_
2. Click Reopen ticket _(click role `button` "Reopen ticket")_
3. The status shows open _(assert testid `ticket-status` — text-equals `open`)_

### A closed ticket moves from the open filter to the closed filter

`closed-ticket-in-closed-filter` · persona **editor** · seed `default` · starts at `/tickets/2`

Proves the ticket list's status filter reflects a ticket that was just closed.

1. Close ticket #2 _(click testid `ticket-toggle-status`)_
2. Wait for the status to show closed _(wait testid `ticket-status` — text-equals `closed`)_
3. Open the ticket list _(navigate → `/tickets`)_
4. Filter to closed tickets _(select testid `status-filter` → `closed`)_
5. Ticket #2 is listed _(assert testid `ticket-row-2` — visible)_
6. Filter to open tickets _(select testid `status-filter` → `open`)_
7. Ticket #2 is not listed _(assert testid `ticket-row-2` — count-equals `0`)_

### Viewer sees a ticket but cannot close it

`viewer-cannot-close` · persona **viewer** · seed `default` · starts at `/tickets/1`

Proves a viewer can read a ticket's detail page but gets no close or reopen control.

1. The ticket detail is shown _(assert testid `ticket-detail` — visible)_
2. There is no close or reopen button _(assert testid `ticket-toggle-status` — count-equals `0`)_
