import { redirect } from 'react-router';
import { destroyUserSession } from '../lib/auth.server';
import type { Route } from './+types/logout';

export function loader() {
  throw redirect('/tickets');
}

export async function action({ request }: Route.ActionArgs) {
  return destroyUserSession(request);
}
