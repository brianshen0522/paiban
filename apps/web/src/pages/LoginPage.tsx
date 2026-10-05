import { type Me, SITE_NAME } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ThemePicker } from '../components/ThemePicker';
import { t } from '../copy/zh-TW';
import { ApiFailure, post } from '../lib/api';
import { keys } from '../lib/queries';

/** docs/11-pages.md, "登入". One error line between the password and the button. */
export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError(t.auth.needUsername);
      userRef.current?.focus();
      return;
    }
    if (!password) {
      setError(t.auth.needPassword);
      passRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await post<Me>('/api/auth/login', { username, password });
      qc.setQueryData(keys.me, me);
      const next = params.get('next');
      navigate(next?.startsWith('/') && !next.startsWith('//') ? next : '/search', { replace: true });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'INVALID_CREDENTIALS') setError(t.auth.invalid);
      else if (err instanceof ApiFailure && err.code === 'ACCOUNT_DISABLED') setError(t.auth.disabled);
      else if (
        err instanceof ApiFailure &&
        err.code === 'RATE_LIMITED' &&
        err.details &&
        'retryAfterSeconds' in err.details
      )
        setError(t.auth.rateLimited(Math.max(1, Math.ceil(err.details.retryAfterSeconds / 60))));
      else if (err instanceof ApiFailure && err.code === 'NETWORK') setError(t.common.offline);
      else setError(t.common.unknownError);
      passRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="box" onSubmit={submit} noValidate>
        <div className="mark">
          <i aria-hidden="true" />
          <h1>{SITE_NAME}</h1>
        </div>
        <p className="lead">{t.auth.lead}</p>
        <div className="field">
          <label htmlFor="login-user">{t.auth.username}</label>
          <input
            id="login-user"
            ref={userRef}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-pass">{t.auth.password}</label>
          <input
            id="login-pass"
            ref={passRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t.auth.submitting : t.auth.submit}
        </button>
        <p className="alt">{t.auth.forgotHint}</p>
        <div className="auth-foot">
          <ThemePicker />
        </div>
      </form>
    </div>
  );
}
