/**
 * Runtime, user-supplied self-hosted sync server URL.
 *
 * In self-hosted mode the server address is no longer baked in at build time —
 * the user enters it at login (persisted here) so a pre-built installer can be
 * shared on GitHub Releases without per-user rebuilds. All API clients
 * (sync / storage / translate / share / …) funnel through `getBaseUrl()` in
 * `services/environment.ts`, which consults this store first in self-hosted
 * mode; `selfhostedAuth` reads it for the login request too.
 */

const SERVER_URL_KEY = 'selfhosted_server_url';

/** Persist the user-entered sync server base URL (no trailing slash). */
export function saveSelfhostedServerUrl(url: string): void {
  if (typeof window === 'undefined') return;
  const normalized = url.trim().replace(/\/+$/, '');
  if (!normalized) {
    localStorage.removeItem(SERVER_URL_KEY);
    return;
  }
  localStorage.setItem(SERVER_URL_KEY, normalized);
}

/** Return the persisted sync server base URL, or '' if none set. */
export function getSelfhostedServerUrl(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(SERVER_URL_KEY) ?? '';
}

/**
 * Whether a self-hosted sync server URL has been configured at runtime.
 * Used by the login form to decide whether to show the address field.
 */
export function hasSelfhostedServerUrl(): boolean {
  return getSelfhostedServerUrl().length > 0;
}
