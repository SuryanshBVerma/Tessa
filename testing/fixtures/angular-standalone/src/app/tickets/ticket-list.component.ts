import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '@core';
import { TicketService } from './ticket.service';

@Component({
  selector: 'app-ticket-list',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './ticket-list.component.html',
})
export class TicketListComponent {
  protected readonly auth = inject(AuthService);
  protected readonly tickets = inject(TicketService).list();
}
