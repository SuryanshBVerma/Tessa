import { data, Form, redirect, useNavigation } from 'react-router';
import { authenticate, createUserSession, getUser } from '../lib/auth.server';
import { safeRedirect } from '../lib/redirect';
import type { Route } from './+types/login';

export async function loader({ request }: Route.LoaderArgs) {
  if ((await getUser(request)) !== null) {
    throw redirect('/tickets');
  }
  const redirectTo = new URL(request.url).searchParams.get('redirectTo');
  return { redirectTo: safeRedirect(redirectTo) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const username = form.get('username');
  const password = form.get('password');
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return data({ error: 'Enter your username and password.' }, { status: 400 });
  }
  const user = await authenticate(username.trim(), password);
  if (user === null) {
    // Same message for unknown user and wrong password.
    return data({ error: 'Invalid username or password.' }, { status: 401 });
  }
  return createUserSession(user.id, safeRedirect(form.get('redirectTo')));
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';
  return (
    <main className="page narrow">
      <h1>Sign in</h1>
      <Form method="post" className="stack" aria-label="Sign in" data-testid="login-form">
        <input type="hidden" name="redirectTo" value={loaderData.redirectTo} />
        <label>
          Username
          <input name="username" autoComplete="username" required data-testid="login-username" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            data-testid="login-password"
          />
        </label>
        {actionData?.error ? (
          <p role="alert" className="error" data-testid="login-error">
            {actionData.error}
          </p>
        ) : null}
        <button type="submit" disabled={submitting} data-testid="login-submit">
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </Form>
    </main>
  );
}
