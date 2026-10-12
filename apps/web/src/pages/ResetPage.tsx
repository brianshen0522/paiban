import { SITE_NAME } from '@paiban/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { LocaleToggle } from '../components/LocaleToggle';
import { ThemeToggle } from '../components/ThemeToggle';
import { useToast } from '../components/Toasts';
import { t } from '../copy';
import { ApiFailure, get, post } from '../lib/api';

/** docs/11-pages.md, "Reset password": the account name read-only, a new password twice. */
export function ResetPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const check = useQuery({
    queryKey: ['reset', token],
    queryFn: () => get<{ username: string }>(`/api/auth/reset/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<{ field: 'pw' | 'pw2' | 'form'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return setErr({ field: 'pw', text: t.register.passwordShort });
    if (pw !== pw2) return setErr({ field: 'pw2', text: t.register.passwordMismatch });
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/auth/reset/${encodeURIComponent(token)}`, { password: pw });
      toast(t.reset.done);
      navigate('/login', { replace: true });
    } catch (error) {
      setErr({
        field: 'form',
        text: error instanceof ApiFailure && error.code === 'RESET_INVALID' ? t.reset.invalid : t.common.unknownError,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="corner-tools">
        <LocaleToggle />
        <ThemeToggle />
      </div>
      <form className="box" onSubmit={submit} noValidate>
        <div className="mark">
          <i aria-hidden="true" />
          <h1>
            {SITE_NAME} · {t.reset.title}
          </h1>
        </div>
        {check.isPending ? (
          <p className="sub">{t.common.loading}</p>
        ) : check.isError ? (
          <>
            <p className="err" role="alert">
              {check.error instanceof ApiFailure && check.error.code === 'RESET_INVALID'
                ? t.reset.invalid
                : t.common.unknownError}
            </p>
            <Link className="btn" to="/login">
              {t.auth.submit}
            </Link>
          </>
        ) : (
          <>
            <p className="lead">{t.reset.lead(check.data.username)}</p>
            <input type="text" hidden readOnly autoComplete="username" value={check.data.username} />
            <div className="field">
              <label htmlFor="reset-pw">{t.reset.password}</label>
              <input
                id="reset-pw"
                type="password"
                autoComplete="new-password"
                aria-invalid={err?.field === 'pw'}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              {err?.field === 'pw' ? (
                <small className="err" role="alert">
                  {err.text}
                </small>
              ) : (
                <small>{t.register.passwordHelp}</small>
              )}
            </div>
            <div className="field">
              <label htmlFor="reset-pw2">{t.reset.password2}</label>
              <input
                id="reset-pw2"
                type="password"
                autoComplete="new-password"
                aria-invalid={err?.field === 'pw2'}
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
              {err?.field === 'pw2' && (
                <small className="err" role="alert">
                  {err.text}
                </small>
              )}
            </div>
            {err?.field === 'form' && (
              <p className="err" role="alert">
                {err.text}
              </p>
            )}
            <button type="submit" className="primary" disabled={busy}>
              {t.reset.submit}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
