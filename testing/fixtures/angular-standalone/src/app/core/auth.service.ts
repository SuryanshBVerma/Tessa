import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private roles: string[] = [];

  signedIn(): boolean {
    return this.roles.length > 0;
  }

  hasAnyRole(roles: string[]): boolean {
    return roles.some((r) => this.roles.includes(r));
  }

  can(permission: string): boolean {
    return this.roles.includes(permission);
  }

  me() {
    return this.http.get<{ roles: string[] }>('/api/me');
  }
}
