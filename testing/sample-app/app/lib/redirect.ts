// Only allow same-site relative redirects after login, to avoid open redirects.
export function safeRedirect(target: FormDataEntryValue | null, fallback = '/tickets'): string {
  if (typeof target !== 'string' || !target.startsWith('/')) {
    return fallback;
  }
  // `//host` and `/\host` are treated as protocol-relative URLs by browsers.
  if (target.startsWith('//') || target.startsWith('/\\')) {
    return fallback;
  }
  return target;
}
