import { getSelfhostedServerUrl } from './selfhostedServerUrl';

export interface SelfhostedLoginResult {
  access_token: string;
  token_type: string;
}

export interface SelfhostedUser {
  id: string;
  email?: string;
  // Mirrors the Supabase `User` shape so UI code can read avatar/name metadata
  // from either auth backend through the same accessor.
  user_metadata?: Record<string, unknown>;
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
 * Self-hosted server base URL. Read lazily at call time from the runtime store
 * (set from the login form) so a pre-built installer works without per-user
 * rebuilds. In self-hosted mode this MUST point at the user's own sync server —
 * it never falls back to the official `web.readest.com`. If unset the login
 * call fails loudly instead of leaking the shared code to a third-party domain.
 */
const getSelfhostedBaseUrl = (): string => getSelfhostedServerUrl();

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
export type SelfhostedLoginErrorReason =
  | 'no-url' // 未配置服务端地址
  | 'network' // 连不上服务端（DNS/连接被拒/超时/CORS）
  | 'server' // 服务端 5xx 内部错误
  | 'locked' // 429 设备被限流锁定
  | 'invalid-code'; // 服务端明确拒绝：授权码错误

export class SelfhostedLoginError extends Error {
  reason: SelfhostedLoginErrorReason;
  status?: number;
  lockedUntil?: number;
  constructor(
    message: string,
    reason: SelfhostedLoginErrorReason,
    extra?: { status?: number; lockedUntil?: number },
  ) {
    super(message);
    this.name = 'SelfhostedLoginError';
    this.reason = reason;
    this.status = extra?.status;
    this.lockedUntil = extra?.lockedUntil;
  }
}

export async function selfhostedLogin(code: string): Promise<SelfhostedLoginResult> {
  const baseUrl = getSelfhostedBaseUrl();
  if (!baseUrl) {
    throw new SelfhostedLoginError('Self-hosted server URL is not configured', 'no-url');
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const deviceId = getDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  // The sync server registers its API surface under /api (see main.go); the
  // other clients (sync/storage/translate) already use ${base}/api via
  // getAPIBaseUrl, so the login endpoint must live on the same prefix.
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
    });
  } catch {
    // Network-level failure: DNS resolution, connection refused, timeout, or a
    // CORS/pre-flight rejection all surface here as a rejected promise rather
    // than a non-2xx response. Previously these were silently folded into
    // "invalid code", making it impossible to tell a bad password from a dead
    // server.
    throw new SelfhostedLoginError(`Cannot reach the sync server at ${baseUrl}`, 'network');
  }
  if (!res.ok) {
    const status = res.status;
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
      throw new SelfhostedLoginError('Too many failed attempts', 'locked', {
        status,
        lockedUntil,
      });
    }
    // 5xx = server-side error, not a credential problem.
    if (status >= 500) {
      throw new SelfhostedLoginError(
        `Sync server returned an internal error (${status})`,
        'server',
        { status },
      );
    }
    // Any other non-2xx (400/401/etc.) means the server rejected the code.
    throw new SelfhostedLoginError('invalid code', 'invalid-code', { status });
  }
  // Read the body as text first so a non-JSON response (HTML error page,
  // nginx default page, redirect body, stray prefix/BOM) doesn't surface as a
  // raw `SyntaxError: Unexpected non-whitespace character after JSON` with no
  // actionable context. A 2xx with an unparseable body means the server
  // contract changed or a proxy intercepted the response — report it clearly
  // instead of letting the raw exception leak to the console.
  const text = await res.text();
  let parsed: SelfhostedLoginResult;
  try {
    parsed = JSON.parse(text) as SelfhostedLoginResult;
  } catch {
    throw new SelfhostedLoginError(
      `Sync server returned a non-JSON response (HTTP ${res.status}); ` +
        `check the server URL and that ${baseUrl}/api/auth is reachable`,
      'server',
      { status: res.status },
    );
  }
  if (!parsed || typeof parsed.access_token !== 'string') {
    throw new SelfhostedLoginError(
      `Sync server response is missing 'access_token' (HTTP ${res.status})`,
      'server',
      { status: res.status },
    );
  }
  return parsed;
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
