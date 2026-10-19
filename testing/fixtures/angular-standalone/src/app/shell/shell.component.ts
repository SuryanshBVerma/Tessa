import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterLink, RouterOutlet],
  template: `
    <nav aria-label="Main" data-testid="main-nav">
      <a routerLink="/tickets" data-testid="nav-tickets">Tickets</a>
      @if (auth.can('tickets:create')) {
        <a routerLink="/tickets/new" data-testid="nav-new-ticket">New ticket</a>
      }
      <a *appHasRole="'admin'" [routerLink]="['/admin', 'users']">Users</a>
      <button type="button" data-testid="sign-out"><mat-icon>logout</mat-icon> Sign out</button>
    </nav>
    <router-outlet />
  `,
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
}
