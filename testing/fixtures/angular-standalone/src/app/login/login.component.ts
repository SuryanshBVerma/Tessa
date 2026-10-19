import { Component } from '@angular/core';

@Component({
  selector: 'app-login',
  standalone: true,
  template: `
    <form>
      <label for="username">Username</label>
      <input id="username" name="username" />
      <button type="submit">Sign in</button>
    </form>
  `,
})
export class LoginComponent {}
