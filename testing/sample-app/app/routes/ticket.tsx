import { data, Form, Link } from 'react-router';
import { requirePermission } from '../lib/auth.server';
import { query } from '../lib/db.server';
import { getFlags } from '../lib/flags.server';
import { can } from '../lib/permissions';
import type { Route } from './+types/ticket';

interface TicketRow {
  id: number;
  title: string;
  description: string;
  status: 'open' | 'closed';
  priority: 'low' | 'medium' | 'high';
  author: string;
  created_at: Date;
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw data('Ticket not found.', { status: 404 });
  }
  return id;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requirePermission(request, 'tickets:read');
  const id = parseId(params.ticketId);
  const [rows, flags] = await Promise.all([
    query<TicketRow>(
      `SELECT t.id, t.title, t.description, t.status, t.priority, t.created_at,
              u.display_name AS author
         FROM tickets t JOIN users u ON u.id = t.created_by
        WHERE t.id = $1`,
      [id],
    ),
    getFlags(),
  ]);
  const ticket = rows[0];
  if (ticket === undefined) {
    throw data('Ticket not found.', { status: 404 });
  }
  return {
    ticket: { ...ticket, createdAt: ticket.created_at.toISOString() },
    showPriority: flags.ticket_priority === true,
    canClose: can(user.role, 'tickets:close'),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  await requirePermission(request, 'tickets:close');
  const id = parseId(params.ticketId);
  const form = await request.formData();
  const intent = form.get('intent');
  if (intent !== 'close' && intent !== 'reopen') {
    throw data('Unknown action.', { status: 400 });
  }
  await query('UPDATE tickets SET status = $1 WHERE id = $2', [
    intent === 'close' ? 'closed' : 'open',
    id,
  ]);
  return { updated: true };
}

export default function Ticket({ loaderData }: Route.ComponentProps) {
  const { ticket, showPriority, canClose } = loaderData;
  return (
    <article aria-labelledby="ticket-heading" data-testid="ticket-detail">
      <p>
        <Link to="/tickets">← All tickets</Link>
      </p>
      <h1 id="ticket-heading">
        #{ticket.id} {ticket.title}
      </h1>
      <dl className="meta">
        <dt>Status</dt>
        <dd>
          <span className={`badge ${ticket.status}`} data-testid="ticket-status">
            {ticket.status}
          </span>
        </dd>
        {showPriority ? (
          <>
            <dt>Priority</dt>
            <dd data-testid="ticket-priority-value">{ticket.priority}</dd>
          </>
        ) : null}
        <dt>Author</dt>
        <dd>{ticket.author}</dd>
        <dt>Created</dt>
        <dd>
          <time dateTime={ticket.createdAt}>{new Date(ticket.createdAt).toLocaleString()}</time>
        </dd>
      </dl>
      <p data-testid="ticket-description-value">{ticket.description || 'No description.'}</p>
      {canClose ? (
        <Form method="post">
          <button
            type="submit"
            name="intent"
            value={ticket.status === 'open' ? 'close' : 'reopen'}
            data-testid="ticket-toggle-status"
          >
            {ticket.status === 'open' ? 'Close ticket' : 'Reopen ticket'}
          </button>
        </Form>
      ) : null}
    </article>
  );
}
