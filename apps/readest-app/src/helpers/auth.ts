import { User } from '@supabase/supabase-js';
import { supabase, SELFHOSTED } from '@/utils/supabase';
import { jwtToUser, SelfhostedUser } from '@/services/selfhostedAuth';

interface UseAuthCallbackOptions {
  accessToken?: string | null;
  refreshToken?: string | null;
  login: (accessToken: string, user: User | SelfhostedUser) => void;
  navigate: (path: string) => void;
  type?: string | null;
  next?: string;
  error?: string | null;
  errorCode?: string | null;
  errorDescription?: string | null;
}

export interface OAuthCallbackParams {
  accessToken: string | null;
  refreshToken: string | null;
  type: string | null;
  next: string | null;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

// OAuth callbacks may carry data in the URL fragment (implicit flow tokens) or
// the query string (provider/GoTrue errors), so we read from both.
export function parseOAuthCallbackUrl(url: string): OAuthCallbackParams {
  const hashParams = new URLSearchParams(url.match(/#(.*)/)?.[1] ?? '');
  const queryParams = new URLSearchParams(url.match(/\?([^#]*)/)?.[1] ?? '');
  const getParam = (key: string) => hashParams.get(key) ?? queryParams.get(key);
  return {
    accessToken: getParam('access_token'),
    refreshToken: getParam('refresh_token'),
    type: getParam('type'),
    next: getParam('next'),
    error: getParam('error'),
    errorCode: getParam('error_code'),
    errorDescription: getParam('error_description'),
  };
}

export function handleAuthCallback({
  accessToken,
  refreshToken,
  login,
  navigate,
  type,
  next = '/',
  error,
}: UseAuthCallbackOptions) {
  async function finalizeSession() {
    if (error) {
      navigate('/auth/error');
      return;
    }

    if (!accessToken || !refreshToken) {
      navigate('/library');
      return;
    }

    // Self-hosted mode: the token is a JWT issued by the sync server. There is
    // no Supabase session to set; derive the user from the JWT `sub` claim and
    // log in directly. OAuth flows are not used in self-hosted mode.
    if (SELFHOSTED) {
      const user = jwtToUser(accessToken);
      if (!user) {
        console.error('Error deriving user from self-hosted token');
        navigate('/auth/error');
        return;
      }
      login(accessToken, user);
      navigate(next);
      return;
    }

    const { error: err } = await supabase!.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (err) {
      console.error('Error setting session:', err);
      navigate('/auth/error');
      return;
    }

    const {
      data: { user },
    } = await supabase!.auth.getUser();
    if (user) {
      login(accessToken, user);
      if (type === 'recovery') {
        navigate('/auth/recovery');
        return;
      }
      navigate(next);
    } else {
      console.error('Error fetching user data');
      navigate('/auth/error');
    }
  }

  finalizeSession();
}
