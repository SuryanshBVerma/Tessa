import { existsSync } from 'node:fs';

// Load sample-app/.env when present. Values already set in the environment win.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
