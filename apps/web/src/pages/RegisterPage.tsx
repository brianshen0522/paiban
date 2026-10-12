import { type Me, SITE_NAME } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { LocaleToggle } from '../components/LocaleToggle';
import { ThemeToggle } from '../components/ThemeToggle';
import { useToast } from '../components/Toasts';
import { t } from '../copy';
import { ApiFailure, get, post } from '../lib/api';
import { keys } from '../lib/queries';

type Fields = 'code' | 'displayName' | 'username' | 'password' | 'password2';
type Errors = Partial<Record<Fields, string>>;

/** Read when used, not when the module loads: the language can change. */
const SERVER_FIELD = (): Record<string, Record<string, string>> => ({
  displayName: { REQUIRED: t.register.nameRequired, TOO_LONG: t.register.nameTooLong },
  username: {
    FORMAT: t.register.usernameFormat,
    TOO_LONG: t.register.usernameTooLong,
    TAKEN: t.register.usernameTaken,
  },
  password: { TOO_SHORT: t.register.passwordShort, TOO_LONG: t.register.passwordTooLong },
});
const INVITE_ERRORS = (): Record<string, string> => ({
  INVITE_NOT_FOUND: t.register.codeNotFound,
  INVITE_EXPIRED: t.register.codeExpired,
  INVITE_USED: t.register.codeUsed,
  RATE_LIMITED: t.register.rateLimited,
});

/** The same checks the server makes, so mistakes show before sending (docs/11-pages.md, "Register with an invite code (24)"). */
function check(v: Record<Fields, string>): Errors {
  const e: Errors = {};
  if (!v.code.trim()) e.code = t.register.codeRequired;
  const name = v.displayName.trim();
  if (!name) e.displayName = t.register.nameRequired;
  else if ([...name].length > 20) e.displayName = t.register.nameTooLong;
  const user = v.username.trim().toLowerCase();
  if (user.length > 32) e.username = t.register.usernameTooLong;
  else if (!/^[a-z0-9_]{3,32}$/.test(user)) e.username = t.register.usernameFormat;
  if (v.password.length < 8) e.password = t.register.passwordShort;
  else if (v.password.length > 200) e.password = t.register.passwordTooLong;
  if (!e.password && v.password !== v.password2) e.password2 = t.register.passwordMismatch;
  return e;
}

export function RegisterPage() {
  const { code: fromLink } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<Record<Fields, string>>({
    code: (fromLink ?? '').toUpperCase(),
    displayName: '',
    username: '',
    password: '',
    password2: '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // A code from the link is checked at once, so an expired one is said before anything is typed.
  useEffect(() => {
    if (!fromLink) return;
    get(`/api/invites/${encodeURIComponent(fromLink)}`).catch((err) => {
      if (err instanceof ApiFailure && INVITE_ERRORS()[err.code]) setErrors({ code: INVITE_ERRORS()[err.code] });
    });
  }, [fromLink]);

  const focusFirst = () =>
    setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = check(v);
    setErrors(found);
    if (Object.keys(found).length) return focusFirst();
    setBusy(true);
    try {
      const me = await post<Me>('/api/auth/register', {
        code: v.code.trim(),
        displayName: v.displayName.trim(),
        username: v.username.trim(),
        password: v.password,
      });
      qc.setQueryData(keys.me, me);
      toast(t.register.welcome(me.user.displayName));
      navigate('/search', { replace: true });
    } catch (err) {
      const next: Errors = {};
      if (err instanceof ApiFailure) {
        if (INVITE_ERRORS()[err.code]) next.code = INVITE_ERRORS()[err.code];
        else if (err.code === 'USERNAME_TAKEN') next.username = t.register.usernameTaken;
        else if (err.details && 'fields' in err.details)
          for (const [k, c] of Object.entries(err.details.fields)) {
            const msg = SERVER_FIELD()[k]?.[c];
            if (msg) next[k as Fields] = msg;
          }
      }
      if (!Object.keys(next).length)
        next.code = err instanceof ApiFailure && err.code === 'NETWORK' ? t.common.offline : t.common.unknownError;
      setErrors(next);
      focusFirst();
    } finally {
      setBusy(false);
    }
  };

  const field = (k: Fields, label: string, opts: { type?: string; help?: string; auto?: string } = {}) => (
    <div className="field">
      <label htmlFor={`reg-${k}`}>{label}</label>
      <input
        id={`reg-${k}`}
        type={opts.type ?? 'text'}
        autoComplete={opts.auto}
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={!!errors[k]}
        aria-describedby={`reg-${k}-note`}
        value={v[k]}
        onChange={(e) => setV({ ...v, [k]: e.target.value })}
      />
      {errors[k] ? (
        <small id={`reg-${k}-note`} className="err" role="alert">
          {errors[k]}
        </small>
      ) : opts.help ? (
        <small id={`reg-${k}-note`}>{opts.help}</small>
      ) : null}
    </div>
  );

  return (
    <div className="auth">
      <div className="corner-tools">
        <LocaleToggle />
        <ThemeToggle />
      </div>
      <form className="box" onSubmit={submit} noValidate ref={formRef}>
        <div className="mark">
          <i aria-hidden="true" />
          <h1>{t.register.title(SITE_NAME)}</h1>
        </div>
        <p className="lead">{t.register.lead}</p>
        {field('code', t.register.code, { auto: 'off' })}
        {field('displayName', t.register.displayName, { help: t.register.displayNameHelp, auto: 'nickname' })}
        {field('username', t.register.username, { help: t.register.usernameHelp, auto: 'username' })}
        {field('password', t.register.password, {
          type: 'password',
          help: t.register.passwordHelp,
          auto: 'new-password',
        })}
        {field('password2', t.register.password2, { type: 'password', auto: 'new-password' })}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t.register.submitting : t.register.submit}
        </button>
        <p className="alt">
          <Link to="/login">{t.register.backToLogin}</Link>
        </p>
      </form>
    </div>
  );
}
