import { createCookieSessionStorage } from 'react-router';
import { requireEnv } from './env.server';

interface SessionData {
  userId: number;
}

interface SessionFlashData {
  error: string;
}

export const sessionStorage = createCookieSessionStorage<SessionData, SessionFlashData>({
  cookie: {
    name: 'tessa_sample_session',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // The sample app runs on plain http://127.0.0.1 only.
    secure: false,
    maxAge: 60 * 60 * 8,
    secrets: [requireEnv('SESSION_SECRET')],
  },
});
