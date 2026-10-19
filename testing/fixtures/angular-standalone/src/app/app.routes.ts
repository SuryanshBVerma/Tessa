import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { roleGuard } from './core/role.guard';
import { ShellComponent } from './shell/shell.component';
import { LoginComponent } from '@app/login/login.component';

export const routes: Routes = [
  { path: 'login', component: LoginComponent, title: 'Sign in' },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'tickets', pathMatch: 'full' },
      {
        path: 'tickets',
        loadComponent: () =>
          import('./tickets/ticket-list.component').then((m) => m.TicketListComponent),
      },
      {
        path: 'tickets/new',
        canActivate: [roleGuard('editor', 'admin')],
        loadComponent: () =>
          import('./tickets/ticket-new.component').then((m) => m.TicketNewComponent),
      },
      { path: 'tickets/:id', loadComponent: () => import('./tickets/ticket-detail.component') },
      {
        path: 'admin',
        canMatch: [roleGuard('admin')],
        data: { roles: ['admin'], title: 'Admin' },
        loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
