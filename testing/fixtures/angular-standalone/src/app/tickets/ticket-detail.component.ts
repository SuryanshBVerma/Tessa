import { Component } from '@angular/core';

@Component({
  selector: 'app-ticket-detail',
  standalone: true,
  template: `
    <a routerLink="/tickets">All tickets</a>
    <h1 data-testid="ticket-title-heading">Ticket</h1>
    <button type="button" data-testid="close-ticket">Close ticket</button>
  `,
})
export default class TicketDetailComponent {}
