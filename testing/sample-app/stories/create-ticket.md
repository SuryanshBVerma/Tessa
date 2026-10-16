# Create a ticket

**As an** editor, **I want to** create a ticket with a title and a priority, **so that** the
team can see and triage new work.

## Acceptance criteria

1. An editor can create a ticket with a title and priority.
2. A title shorter than 3 characters is rejected with a message.
3. A viewer does not see the New ticket link and gets 403 on /tickets/new.
