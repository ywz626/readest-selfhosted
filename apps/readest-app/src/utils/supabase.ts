import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getRuntimeConfig } from '@/services/runtimeConfig';

/**
 * Self-hosted mode toggle. When set (`NEXT_PUBLIC_SELFHOSTED=1`), the app talks
 * to a self-hosted Readest sync server (code login + JWT) instead of Supabase.
 * The official Supabase path is preserved when this is off.
 */
export const SELFHOSTED = process.env['NEXT_PUBLIC_SELFHOSTED'] === '1';

// In self-hosted mode the Supabase client is never used, so we skip resolving
// the default base64 env vars (which may be absent and would crash atob() at
// module load). The official path still reads them normally when SELFHOSTED off.
const b64Url = process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64'];
const b64Key = process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64'];
const supabaseUrl = SELFHOSTED
  ? ''
  : getRuntimeConfig()?.supabaseUrl ||
    process.env['SUPABASE_URL'] ||
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    (b64Url ? atob(b64Url) : '');
const supabaseAnonKey = SELFHOSTED
  ? ''
  : getRuntimeConfig()?.supabaseAnonKey ||
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    (b64Key ? atob(b64Key) : '');

// supabase-js persists the session under a key derived from the URL's first
// host label. Readest Cloud keeps the key from its original host so moving the
// client to another of its hosts doesn't sign everyone out.
const READEST_CLOUD_HOSTS = [
  'readest.supabase.co',
  'vbsyxfusjjqdxkjqlysc.supabase.co',
  'auth.readest.com',
];

export const supabase: SupabaseClient | null = createSupabaseClientSafe();

// Avoid calling createClient with empty url/key (which throws at module load
// when the Supabase env vars are absent). The official path requires those vars
// at runtime; if missing, callsites using `supabase!` will fail loudly.
function createSupabaseClientSafe(): SupabaseClient | null {
  if (SELFHOSTED) return null;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return createClient(
    supabaseUrl,
    supabaseAnonKey,
    READEST_CLOUD_HOSTS.includes(new URL(supabaseUrl).hostname)
      ? { auth: { storageKey: 'sb-readest-auth-token' } }
      : undefined,
  );
}

export const createSupabaseClient = (accessToken?: string) => {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {},
    },
  });
};

export const createSupabaseAdminClient = () => {
  const supabaseAdminKey = process.env['SUPABASE_ADMIN_KEY'] || '';
  return createClient(supabaseUrl, supabaseAdminKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};
