import { Link, useSearchParams } from 'react-router';
import { requirePermission } from '../lib/auth.server';
import { query } from '../lib/db.server';
import { getFlags } from '../lib/flags.server';
import { can } from '../lib/permissions';
import type { Route } from './+types/tickets';

interface TicketRow {
  id: number;
  title: string;
  status: 'open' | 'closed';
  priority: 'low' | 'medium' | 'high';
  author: string;
}

const STATUSES = ['all', 'open', 'closed'] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requirePermission(request, 'tickets:read');
  const status = new URL(request.url).searchParams.get('status') ?? 'all';
  const filter = status === 'open' || status === 'closed' ? status : null;
  const [tickets, flags] = await Promise.all([
    query<TicketRow>(
      `SELECT t.id, t.title, t.status, t.priority, u.display_name AS author
         FROM tickets t JOIN users u ON u.id = t.created_by
        WHERE $1::text IS NULL OR t.status = $1
        ORDER BY t.id`,
      [filter],
    ),
    getFlags(),
  ]);
  return {
    tickets,
    showPriority: flags.ticket_priority === true,
    canCreate: can(user.role, 'tickets:create'),
  };
}

export default function Tickets({ loaderData }: Route.ComponentProps) {
  const { tickets, showPriority, canCreate } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? 'all';
  return (
    <section aria-labelledby="tickets-heading">
      <div className="row">
        <h1 id="tickets-heading">Tickets</h1>
        {canCreate ? (
          <Link to="/tickets/new" className="button" data-testid="create-ticket">
            New ticket
          </Link>
        ) : null}
      </div>
      <label className="inline">
        Status
        <select
          value={status}
          onChange={(event) => {
            setSearchParams(event.target.value === 'all' ? {} : { status: event.target.value });
          }}
          data-testid="status-filter"
        >
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {tickets.length === 0 ? (
        <p data-testid="tickets-empty">No tickets match this filter.</p>
      ) : (
        <table data-testid="tickets-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              {showPriority ? <th scope="col">Priority</th> : null}
              <th scope="col">Author</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr key={ticket.id} data-testid={`ticket-row-${String(ticket.id)}`}>
                <td>{ticket.id}</td>
                <td>
                  <Link to={`/tickets/${String(ticket.id)}`}>{ticket.title}</Link>
                </td>
                <td>
                  <span className={`badge ${ticket.status}`}>{ticket.status}</span>
                </td>
                {showPriority ? <td>{ticket.priority}</td> : null}
                <td>{ticket.author}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
