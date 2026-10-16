import { data, Form, useNavigation } from 'react-router';
import { requireUser } from '../lib/auth.server';
import { query } from '../lib/db.server';
import { permissionsFor } from '../lib/permissions';
import type { Route } from './+types/settings';

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return { user, permissions: permissionsFor(user.role) };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const theme = (await request.formData()).get('theme');
  if (theme !== 'light' && theme !== 'dark') {
    return data({ saved: false }, { status: 400 });
  }
  await query('UPDATE users SET theme = $1 WHERE id = $2', [theme, user.id]);
  return { saved: true };
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { user, permissions } = loaderData;
  const navigation = useNavigation();
  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading">Settings</h1>
      <Form method="post" className="stack" data-testid="settings-form">
        <fieldset>
          <legend>Theme</legend>
          {(['light', 'dark'] as const).map((theme) => (
            <label key={theme} className="inline">
              <input
                type="radio"
                name="theme"
                value={theme}
                defaultChecked={user.theme === theme}
                data-testid={`theme-${theme}`}
              />
              {theme}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={navigation.state !== 'idle'} data-testid="settings-save">
          Save
        </button>
        {actionData?.saved ? (
          <p role="status" data-testid="settings-saved">
            Settings saved.
          </p>
        ) : null}
      </Form>
      <h2>Your permissions</h2>
      <ul data-testid="permission-list">
        {permissions.map((permission) => (
          <li key={permission}>{permission}</li>
        ))}
      </ul>
    </section>
  );
}
