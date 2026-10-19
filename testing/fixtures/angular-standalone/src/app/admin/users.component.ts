import { Component } from '@angular/core';

@Component({
  selector: 'app-users',
  standalone: true,
  template: `
    <h1>Users</h1>
    <table data-testid="users-table">
      <tr><th>Name</th><th>Role</th></tr>
    </table>
  `,
})
export class UsersComponent {}
