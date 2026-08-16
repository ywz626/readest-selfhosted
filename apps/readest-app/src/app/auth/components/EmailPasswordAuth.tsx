import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useTranslation } from '@/hooks/useTranslation';
import { SELFHOSTED } from '@/utils/supabase';
import { selfhostedLogin, jwtToUser, saveLoginCode } from '@/services/selfhostedAuth';
import type { SelfhostedUser } from '@/services/selfhostedAuth';
import { getSelfhostedServerUrl, saveSelfhostedServerUrl } from '@/services/selfhostedServerUrl';

type AuthView = 'sign_in' | 'sign_up' | 'magic_link' | 'forgotten_password';

interface EmailPasswordAuthProps {
  supabaseClient: SupabaseClient | null;
  redirectTo?: string;
  magicLink?: boolean;
  // Self-hosted mode: called with the JWT issued by the sync server.
  onSelfhostedLogin?: (accessToken: string, user: SelfhostedUser) => void;
}

const FORM_IDS: Record<AuthView, string> = {
  sign_in: 'auth-sign-in',
  sign_up: 'auth-sign-up',
  magic_link: 'auth-magic-link',
  forgotten_password: 'auth-forgot-password',
};

const LINK_CLASS =
  'text-base-content/70 hover:text-base-content underline underline-offset-2 transition-colors duration-150';

export default function EmailPasswordAuth({
  supabaseClient,
  redirectTo,
  magicLink = false,
  onSelfhostedLogin,
}: EmailPasswordAuthProps) {
  const _ = useTranslation();
  const [view, setView] = useState<AuthView>('sign_in');
  const [defaultEmail, setDefaultEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [keyboardInset, setKeyboardInset] = useState(0);
  // Self-hosted mode: server address entered at runtime (persisted) instead of
  // baked in at build time, so a shared installer works for any user.
  const [serverUrl, setServerUrl] = useState(() => getSelfhostedServerUrl());

  const hasPassword = view === 'sign_in' || view === 'sign_up';

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const layoutH = document.documentElement.clientHeight;
      const offset = layoutH - vv.height - vv.offsetTop;
      setKeyboardInset(offset > 1 ? offset : 0);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // The Android WebView does not resize with the keyboard, and Chromium
  // resets the visual-viewport pan when the IME advances focus (keyboard
  // Next) without re-scrolling the newly focused editable. The keyboard
  // spacer gives the page scroller enough range, and the focus handler
  // scrolls the input back into the visible area above the keyboard.
  const keepAboveKeyboard = (event: React.FocusEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    setTimeout(() => {
      if (document.activeElement === input) {
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 300);
  };

  const switchView = (next: AuthView) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const form = event.currentTarget.form;
    if (form) {
      const email = new FormData(form).get('email');
      if (typeof email === 'string' && email) {
        setDefaultEmail(email);
      }
    }
    setError('');
    setMessage('');
    setView(next);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Read credentials from the form's DOM state: Android/iOS password
    // managers fill WebView inputs without events React state can track.
    const formData = new FormData(event.currentTarget);
    // In self-hosted mode the shared login code is the only credential and is
    // entered into the password field; the email field is hidden.
    const password = String(formData.get('password') || '');
    const email = SELFHOSTED ? '' : String(formData.get('email') || '').trim();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      // Self-hosted mode: a single shared code is used instead of email/password.
      if (SELFHOSTED) {
        try {
          saveSelfhostedServerUrl(serverUrl);
          const { access_token } = await selfhostedLogin(password);
          const user = jwtToUser(access_token);
          if (!user) throw new Error('invalid token');
          // Persist the code so an expired JWT can be refreshed without
          // re-prompting (mirrors Supabase's persisted refresh_token).
          saveLoginCode(password);
          // The caller (`onSelfhostedLogin`) is responsible for logging in AND
          // navigating away (via SPA router.push) so the behavior matches the
          // OAuth path on every platform (Tauri / iOS / Android / Web) without
          // triggering a full WebView reload.
          onSelfhostedLogin?.(access_token, user);
        } catch (e) {
          const err = e as Error & {
            status?: number;
            lockedUntil?: number;
            reason?: string;
          };
          if (err.reason === 'network') {
            // 连不上服务端：URL 没配对 / 服务端没启动 / 防火墙 / CORS
            setError(
              _(
                'Cannot connect to the sync server. Check that the server is running and the server address is correctly configured in the app.',
              ),
            );
          } else if (err.reason === 'no-url') {
            setError(_('Please enter your sync server address above before signing in.'));
          } else if (err.reason === 'server') {
            setError(
              _(
                'The sync server encountered an internal error. Please check the server logs and try again later.',
              ),
            );
          } else if (err.reason === 'locked' || err.status === 429) {
            // 兜底：旧版本错误可能没有 reason 字段，仍按 429 处理
            if (err.lockedUntil) {
              const mins = Math.max(1, Math.ceil((err.lockedUntil - Date.now()) / 60000));
              setError(
                _(
                  'Too many failed attempts. This device is locked. Try again in {{minutes}} min.',
                  { minutes: mins },
                ),
              );
            } else {
              setError(_('Too many failed attempts. This device is temporarily locked.'));
            }
          } else {
            setError(_('Invalid login code'));
          }
        }
        return;
      }
      if (!supabaseClient) throw new Error('No backend connected');
      if (view === 'sign_in') {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) setError(error.message);
      } else if (view === 'sign_up') {
        const {
          data: { user, session },
          error,
        } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) setError(error.message);
        else if (user && !session) setMessage(_('Check your email for the confirmation link'));
      } else if (view === 'magic_link') {
        const { error } = await supabaseClient.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) setError(error.message);
        else setMessage(_('Check your email for the magic link'));
      } else {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) setError(error.message);
        else setMessage(_('Check your email for the password reset link'));
      }
    } finally {
      setLoading(false);
    }
  };

  const buttonLabel = {
    sign_in: loading ? _('Signing in...') : _('Sign in'),
    sign_up: loading ? _('Signing up...') : _('Sign up'),
    magic_link: loading ? _('Signing in...') : _('Sign in'),
    forgotten_password: loading
      ? _('Sending reset instructions ...')
      : _('Send reset password instructions'),
  }[view];

  return (
    <form
      key={view}
      id={FORM_IDS[view]}
      method='post'
      onSubmit={handleSubmit}
      className='w-full space-y-4'
    >
      {SELFHOSTED && (
        <div className='form-control'>
          <label className='label' htmlFor='server-url'>
            <span className='label-text'>{_('Sync server address')}</span>
          </label>
          <input
            id='server-url'
            name='server-url'
            type='url'
            inputMode='url'
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={_('https://sync.your-server.com')}
            autoComplete='url'
            className='input input-bordered eink-bordered w-full rounded-lg placeholder:text-sm'
            disabled={loading}
            onFocus={keepAboveKeyboard}
          />
        </div>
      )}
      {!SELFHOSTED && (
        <div className='form-control'>
          <label className='label' htmlFor='email'>
            <span className='label-text'>{_('Email address')}</span>
          </label>
          <input
            id='email'
            name='email'
            type='email'
            required
            defaultValue={defaultEmail}
            placeholder={_('Your email address')}
            autoComplete={hasPassword ? 'username' : 'email'}
            className='input input-bordered eink-bordered w-full rounded-lg placeholder:text-sm'
            disabled={loading}
            onFocus={keepAboveKeyboard}
          />
        </div>
      )}
      {hasPassword && (
        <div className='form-control'>
          <label className='label' htmlFor='password'>
            <span className='label-text'>
              {SELFHOSTED
                ? _('Login code')
                : view === 'sign_in'
                  ? _('Your Password')
                  : _('Create a Password')}
            </span>
          </label>
          <input
            id='password'
            name='password'
            type={SELFHOSTED ? 'text' : 'password'}
            required
            placeholder={SELFHOSTED ? _('Your login code') : _('Your password')}
            autoComplete={
              SELFHOSTED ? 'off' : view === 'sign_in' ? 'current-password' : 'new-password'
            }
            className='input input-bordered eink-bordered w-full rounded-lg placeholder:text-sm'
            disabled={loading}
            onFocus={keepAboveKeyboard}
          />
        </div>
      )}
      <button type='submit' className='btn btn-primary w-full rounded-lg' disabled={loading}>
        {loading && <span className='loading loading-spinner loading-sm' aria-hidden='true' />}
        {buttonLabel}
      </button>
      {message && (
        <div className='eink-bordered border-base-200 bg-base-200/40 text-base-content/80 rounded-lg border px-3 py-2.5 text-center text-sm leading-relaxed'>
          {message}
        </div>
      )}
      {error && (
        <div className='eink-bordered border-error/30 bg-error/5 text-error rounded-lg border px-3 py-2.5 text-center text-sm leading-relaxed'>
          {error}
        </div>
      )}
      <div className='flex flex-col items-center gap-2.5 pt-1 text-sm'>
        {!SELFHOSTED && view === 'sign_in' && (
          <>
            {magicLink && (
              <button type='button' className={LINK_CLASS} onClick={switchView('magic_link')}>
                {_('Send a magic link email')}
              </button>
            )}
            <button type='button' className={LINK_CLASS} onClick={switchView('forgotten_password')}>
              {_('Forgot your password?')}
            </button>
            <button type='button' className={LINK_CLASS} onClick={switchView('sign_up')}>
              {_("Don't have an account? Sign up")}
            </button>
          </>
        )}
        {!SELFHOSTED && view !== 'sign_in' && (
          <button type='button' className={LINK_CLASS} onClick={switchView('sign_in')}>
            {_('Already have an account? Sign in')}
          </button>
        )}
      </div>
      {keyboardInset > 0 && (
        <div data-keyboard-spacer='' aria-hidden='true' style={{ height: `${keyboardInset}px` }} />
      )}
    </form>
  );
}
