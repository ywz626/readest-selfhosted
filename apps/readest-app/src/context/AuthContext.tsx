'use client';

import {
  createContext,
  useState,
  useContext,
  useCallback,
  useMemo,
  ReactNode,
  useEffect,
} from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/utils/supabase';
import {
  SelfhostedUser,
  selfhostedLogin,
  jwtToUser,
  getSavedLoginCode,
  isTokenExpired,
} from '@/services/selfhostedAuth';
import posthog from 'posthog-js';

interface AuthContextType {
  token: string | null;
  user: User | SelfhostedUser | null;
  login: (token: string, user: User | SelfhostedUser) => void;
  logout: () => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('token');
    }
    return null;
  });
  const [user, setUser] = useState<User | SelfhostedUser | null>(() => {
    if (typeof window !== 'undefined') {
      const userJson = localStorage.getItem('user');
      try {
        return userJson ? JSON.parse(userJson) : null;
      } catch {
        // Corrupted/legacy `user` payload must not crash the whole provider.
        return null;
      }
    }
    return null;
  });

  useEffect(() => {
    const syncSession = (
      session: { access_token: string; refresh_token: string; user: User } | null,
    ) => {
      if (session) {
        console.log('Syncing session');
        const { access_token, refresh_token, user } = session;
        localStorage.setItem('token', access_token);
        localStorage.setItem('refresh_token', refresh_token);
        localStorage.setItem('user', JSON.stringify(user));
        posthog.identify(user.id);
        setToken(access_token);
        setUser(user);
      } else {
        localStorage.removeItem('token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('user');
        setToken(null);
        setUser(null);
      }
    };
    // Self-hosted mode has no Supabase session to observe or refresh, so the
    // whole effect must be skipped — supabase is null in that mode. A local
    // const keeps the null-narrowing across the closures below.
    const client = supabase;
    if (!client) return;

    const refreshSession = async () => {
      try {
        await client.auth.refreshSession();
      } catch {
        syncSession(null);
      }
    };

    const { data: subscription } = client.auth.onAuthStateChange((_, session) => {
      syncSession(session);
    });

    refreshSession();
    return () => {
      subscription?.subscription.unsubscribe();
    };
  }, []);

  // setToken / setUser from useState are stable across renders, so the empty
  // deps array is correct. Wrapping in useCallback (and only including stable
  // refs in the deps) is what makes the useMemo below actually memoize the
  // context value — without this, login/logout/refresh would be recreated on
  // every render and the memo would always invalidate.
  const login = useCallback((newToken: string, newUser: User | SelfhostedUser) => {
    console.log('Logging in');
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser ?? {}));
    // 自托管模式无 refresh_token 概念；清除任何历史残留，避免混淆
    localStorage.removeItem('refresh_token');
  }, []);

  const logout = useCallback(async () => {
    console.log('Logging out');
    if (supabase) {
      try {
        await supabase.auth.refreshSession();
      } catch {
      } finally {
        await supabase.auth.signOut();
      }
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('selfhosted_login_code');
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!supabase) {
      // Self-hosted mode: the JWT is short-lived. Re-login with the persisted
      // login code once the current token has expired so the user stays
      // signed in; if the code is no longer valid the next API call will 401
      // and surface a re-login.
      const storedToken = localStorage.getItem('token');
      if (storedToken && !isTokenExpired(storedToken)) return;
      const code = getSavedLoginCode();
      if (!code) return;
      try {
        const { access_token } = await selfhostedLogin(code);
        const user = jwtToUser(access_token);
        if (user) login(access_token, user);
      } catch {
        // Keep the stale token; callers fall back to the login screen on 401.
      }
      return;
    }
    try {
      await supabase.auth.refreshSession();
    } catch {}
  }, [login]);

  const value = useMemo(
    () => ({ token, user, login, logout, refresh }),
    [token, user, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
