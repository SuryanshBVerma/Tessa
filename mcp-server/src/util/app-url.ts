/**
 * Joins a configured path (health_path, login_path) to app.url and refuses a result on any other
 * origin. "//host/x" and "/\host/x" are protocol-relative in URL parsing, so a repository's config
 * could otherwise send the health check, or the user's sign-in, to a host it chooses.
 */
export function appUrl(base: string, path: string): string {
  const origin = new URL(base).origin;
  const url = new URL(path, base);
  if (url.origin !== origin) {
    throw new Error(`"${path}" points away from the app (${origin}); use a path such as /login`);
  }
  return url.toString();
}
