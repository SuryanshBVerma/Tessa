import { data, Form, redirect } from 'react-router';
import { requirePermission } from '../lib/auth.server';
import { query } from '../lib/db.server';
import { getFlags } from '../lib/flags.server';
import { validateTicketInput } from '../lib/tickets';
import type { Route } from './+types/ticket-new';

export async function loader({ request }: Route.LoaderArgs) {
  await requirePermission(request, 'tickets:create');
  const flags = await getFlags();
  return { showPriority: flags.ticket_priority === true };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requirePermission(request, 'tickets:create');
  const result = validateTicketInput(await request.formData());
  if (!result.ok) {
    return data({ errors: result.errors }, { status: 400 });
  }
  const rows = await query<{ id: number }>(
    `INSERT INTO tickets (title, description, priority, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [result.value.title, result.value.description, result.value.priority, user.id],
  );
  const created = rows[0];
  if (created === undefined) {
    throw new Error('Ticket insert returned no row');
  }
  throw redirect(`/tickets/${String(created.id)}`);
}

export default function NewTicket({ loaderData, actionData }: Route.ComponentProps) {
  const errors = actionData?.errors ?? {};
  return (
    <section aria-labelledby="new-ticket-heading">
      <h1 id="new-ticket-heading">New ticket</h1>
      <Form method="post" className="stack" data-testid="ticket-form">
        <label>
          Title
          <input
            name="title"
            required
            minLength={3}
            maxLength={120}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'title-error' : undefined}
            data-testid="ticket-title"
          />
        </label>
        {errors.title ? (
          <p id="title-error" role="alert" className="error" data-testid="ticket-title-error">
            {errors.title}
          </p>
        ) : null}
        <label>
          Description
          <textarea name="description" rows={4} data-testid="ticket-description" />
        </label>
        {loaderData.showPriority ? (
          <label>
            Priority
            <select name="priority" defaultValue="medium" data-testid="ticket-priority">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
        ) : null}
        <button type="submit" data-testid="ticket-submit">
          Create ticket
        </button>
      </Form>
    </section>
  );
}
