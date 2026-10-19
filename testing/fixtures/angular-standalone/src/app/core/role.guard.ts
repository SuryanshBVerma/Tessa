import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

export function roleGuard(...roles: string[]): CanActivateFn {
  return () => inject(AuthService).hasAnyRole(roles);
}
