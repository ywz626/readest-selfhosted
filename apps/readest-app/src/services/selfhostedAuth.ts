export interface SelfhostedLoginResult {
  access_token: string;
  token_type: string;
}

export interface SelfhostedUser {
  id: string;
  email?: string;
}

const DEVICE_ID_KEY = 'selfhosted_device_id';
const LOGIN_CODE_KEY = 'selfhosted_login_code';

/**
 * Persist the shared login code so an expired JWT can be refreshed without
 * re-prompting the user. This mirrors the official Supabase path persisting
 * `refresh_token` in localStorage: the code is as sensitive as the token
 * itself, so treat the whole localStorage payload as the credential.
 */
export function saveLoginCode(code: string): void {
  if (typeof window === 'undefined') return;
  if (!code) {
    localStorage.removeItem(LOGIN_CODE_KEY);
    return;
  }
  localStorage.setItem(LOGIN_CODE_KEY, code);
}

export function getSavedLoginCode(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LOGIN_CODE_KEY) ?? '';
}

/**
 * Self-hosted server base URL. In self-hosted mode this MUST point at the
 * user's own sync server — it must never fall back to the official
 * `web.readest.com`. If unset the login call fails loudly instead of leaking
 * the shared code to a third-party domain.
 */
const SELFHOSTED_BASE_URL =
  process.env['NEXT_PUBLIC_API_BASE_URL'] || process.env['API_BASE_URL'] || '';

/**
 * A stable per-installation device id, persisted in localStorage. Sent to the
 * sync server as `X-Device-Id` so brute-force locks are bound to the device
 * rather than a shared NAT IP.
 */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : ((crypto as Crypto | undefined)?.randomUUID?.() ?? '');
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Login against a self-hosted Readest sync server using a shared static code.
 * The server validates the code and returns a JWT (`plan: pro`, `sub: owner`).
 */
export async function selfhostedLogin(code: string): Promise<SelfhostedLoginResult> {
  if (!SELFHOSTED_BASE_URL) {
    throw new Error('Self-hosted server URL is not configured');
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const deviceId = getDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  // The sync server registers its API surface under /api (see main.go); the
  // other clients (sync/storage/translate) already use ${base}/api via
  // getAPIBaseUrl, so the login endpoint must live on the same prefix.
  const res = await fetch(`${SELFHOSTED_BASE_URL}/api/auth`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = new Error('invalid code');
    const status = res.status;
    (err as Error & { status?: number; lockedUntil?: number }).status = status;
    // 429 = device locked after too many failures; surface the retry delay.
    if (status === 429) {
      const raw = res.headers.get('Retry-After') ?? '';
      const retryAfter = Number(raw);
      const lockedUntil =
        !Number.isNaN(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter * 1000
          : !Number.isNaN(Date.parse(raw))
            ? Date.parse(raw)
            : undefined;
      (err as Error & { status?: number; lockedUntil?: number }).lockedUntil = lockedUntil;
    }
    throw err;
  }
  return (await res.json()) as SelfhostedLoginResult;
}

/**
 * Decode a Base64URL JWT payload (the middle segment) into an object, with
 * UTF-8 safe handling so non-ASCII claims don't corrupt via `atob`.
 */
function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1];
    if (!b64) return null;
    // JWT payload 使用 Base64URL，转换为标准 Base64 以兼容 atob
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const binary = atob(padded);
    const json =
      typeof TextDecoder !== 'undefined'
        ? new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
        : decodeURIComponent(escape(binary));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Derive a minimal `User`-like object from a self-hosted JWT.
 *
 * SECURITY: client-side decoding is for UI/identity display only. Never use the
 * decoded `sub` or `plan` as a trust boundary — the self-hosted sync server
 * enforces authorization server-side in `middleware.RequireAuth` (HS256 verify).
 * Any client-side feature gate must be treated as cosmetic; the server is the
 * source of truth for access control.
 */
export function jwtToUser(token: string | null | undefined): SelfhostedUser | null {
  const payload = decodeJwtPayload(token);
  const sub = typeof payload?.['sub'] === 'string' ? payload['sub'] : null;
  if (!sub) return null;
  const email = typeof payload?.['email'] === 'string' ? payload['email'] : undefined;
  return { id: sub, email };
}

/**
 * Parse the `sub` claim from a JWT payload WITHOUT verifying the signature.
 * Thin wrapper over {@link jwtToUser} kept for callers that only need the id.
 *
 * SECURITY: see {@link jwtToUser} — client-side decoding is display-only.
 */
export function jwtSub(token: string | null | undefined): string | null {
  return jwtToUser(token)?.id ?? null;
}

/**
 * Whether a self-hosted JWT is missing or already past its `exp` claim.
 * Used by the auth refresh path to decide whether to re-login with the
 * persisted login code. A token without an `exp` claim is treated as
 * expired so the client re-validates against the server.
 */
export function isTokenExpired(token: string | null | undefined): boolean {
  const payload = decodeJwtPayload(token);
  const exp = typeof payload?.['exp'] === 'number' ? payload['exp'] : null;
  if (exp === null) return true;
  return Date.now() >= exp * 1000;
}
