import { type Lang, type Me, POSTER_REGIONS, type Session, type User, type UserPrefs } from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Banner, Chip, Field, PageHead, Skeleton, Switch } from '../components/Bits';
import { useToast } from '../components/Toasts';
import { browserLocale, isLocale, LOCALES, setLocale, t } from '../copy';
import { ApiFailure, del, get, patch, post } from '../lib/api';
import { relative } from '../lib/format';
import { keys } from '../lib/queries';

const LANGS: Lang[] = ['zh-Hant', 'zh-Hans', 'en'];

/** docs/11-pages.md, "Profile (13)": name, appearance, preferences (saved as they change), password, devices. */
export function ProfilePage() {
  const me = useOutletContext<Me>();
  return (
    <>
      <PageHead title={t.profile.title} lead={t.profile.lead} />
      <NameCard me={me} />
      <LanguageCard prefs={me.user.prefs} />
      <PosterCard prefs={me.user.prefs} />
      <PrefsCard prefs={me.user.prefs} />
      <PasswordCard />
      <DevicesCard />
    </>
  );
}

function useSetMe() {
  const qc = useQueryClient();
  return (user: User) => qc.setQueryData<Me>(keys.me, (m) => (m ? { ...m, user } : m));
}

function NameCard({ me }: { me: Me }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [name, setName] = useState(me.user.displayName);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v) return setError(t.register.nameRequired);
    if ([...v].length > 20) return setError(t.register.nameTooLong);
    setError(null);
    try {
      setMe(await patch<User>('/api/me', { displayName: v }));
      toast(t.profile.nameSaved);
    } catch {
      setError(t.common.unknownError);
    }
  };
  return (
    <section className="card">
      <h2>{t.profile.basics}</h2>
      <form className="frow align-end" onSubmit={save} noValidate>
        <Field label={t.profile.displayName} help={t.register.displayNameHelp} error={error}>
          {(id, note) => (
            <input
              id={id}
              aria-describedby={note}
              aria-invalid={!!error}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" disabled={name.trim() === me.user.displayName}>
          {t.profile.saveName}
        </button>
      </form>
    </section>
  );
}

/**
 * The interface language (Brian, 2026-10-08), kept with the account: 繁體中文, English, or the
 * browser's. It also names what the server writes for this person (AI translations, MKV tracks).
 */
function LanguageCard({ prefs }: { prefs: UserPrefs }) {
  const setMe = useSetMe();
  const [failed, setFailed] = useState(false);
  const choose = async (value: string) => {
    const next = isLocale(value) ? value : null;
    setFailed(false);
    try {
      const user = await patch<User>('/api/me', { prefs: { locale: next } });
      setMe(user);
      setLocale(next ?? browserLocale());
    } catch {
      setFailed(true);
    }
  };
  return (
    <section className="card">
      <h2>{t.locale.title}</h2>
      <Field label={t.locale.label} help={t.locale.help}>
        {(id, note) => (
          <select
            id={id}
            aria-describedby={note}
            value={prefs.locale ?? ''}
            onChange={(e) => void choose(e.target.value)}
          >
            <option value="">{t.locale.follow}</option>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t.locale.names[l]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {failed && <Banner tone="bad">{t.common.unknownError}</Banner>}
    </section>
  );
}

/** Which country's posters this person sees (Brian, 2026-10-10); none follows the interface language. */
function PosterCard({ prefs }: { prefs: UserPrefs }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [failed, setFailed] = useState(false);
  const choose = async (value: string) => {
    const next = POSTER_REGIONS.find((r) => r === value) ?? null;
    setFailed(false);
    try {
      setMe(await patch<User>('/api/me', { prefs: { posterRegion: next } }));
      toast(t.posters.saved);
    } catch {
      setFailed(true);
    }
  };
  return (
    <section className="card">
      <h2>{t.posters.title}</h2>
      <Field label={t.posters.label} help={t.posters.help}>
        {(id, note) => (
          <select
            id={id}
            aria-describedby={note}
            value={prefs.posterRegion ?? ''}
            onChange={(e) => void choose(e.target.value)}
          >
            <option value="">{t.posters.follow}</option>
            {POSTER_REGIONS.map((r) => (
              <option key={r} value={r}>
                {t.posters.regions[r]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {failed && <Banner tone="bad">{t.common.unknownError}</Banner>}
    </section>
  );
}

function PrefsCard({ prefs }: { prefs: UserPrefs }) {
  const setMe = useSetMe();
  const [langError, setLangError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const save = async (next: Partial<UserPrefs>) => {
    setFailed(false);
    try {
      setMe(await patch<User>('/api/me', { prefs: next }));
    } catch {
      setFailed(true);
    }
  };
  const toggleLang = (l: Lang, on: boolean) => {
    const langs = on ? [...prefs.langs, l] : prefs.langs.filter((x) => x !== l);
    if (langs.length === 0) return setLangError(t.profile.keepOneLang);
    setLangError(null);
    void save({ langs: LANGS.filter((x) => langs.includes(x)) });
  };
  return (
    <section className="card">
      <h2>{t.profile.subtitles}</h2>
      <fieldset className="radios">
        <legend>{t.profile.langs}</legend>
        <div className="frow">
          {LANGS.map((l) => (
            <label className="chk" key={l}>
              <input
                type="checkbox"
                checked={prefs.langs.includes(l)}
                onChange={(e) => toggleLang(l, e.target.checked)}
              />
              {t.langs[l]}
            </label>
          ))}
        </div>
        {langError && (
          <small className="err" role="alert">
            {langError}
          </small>
        )}
      </fieldset>
      <Switch
        checked={prefs.convertToTraditional}
        onChange={(v) => void save({ convertToTraditional: v })}
        label={t.profile.s2t}
      />
      <Switch checked={prefs.secondLine} onChange={(v) => void save({ secondLine: v })} label={t.profile.secondLine} />
      <Field label={t.profile.quality} help={t.profile.qualityHelp}>
        {(id, note) => (
          <select
            id={id}
            aria-describedby={note}
            value={prefs.quality}
            onChange={(e) => void save({ quality: e.target.value as UserPrefs['quality'] })}
          >
            {(['720p', '1080p', '2160p'] as const).map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        )}
      </Field>
      {failed && <Banner tone="bad">{t.common.unknownError}</Banner>}
    </section>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [v, setV] = useState({ current: '', next: '', next2: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof v, string>>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!v.current) found.current = t.profile.needCurrent;
    if (v.next.length < 8) found.next = t.profile.nextShort;
    else if (v.next !== v.next2) found.next2 = t.profile.nextMismatch;
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await post('/api/me/password', { current: v.current, next: v.next });
      setV({ current: '', next: '', next2: '' });
      toast(t.profile.passwordChanged);
    } catch (err) {
      setErrors(
        err instanceof ApiFailure && err.code === 'WRONG_PASSWORD'
          ? { current: t.profile.wrongCurrent }
          : { current: t.common.unknownError },
      );
    } finally {
      setBusy(false);
    }
  };
  const input = (k: keyof typeof v, label: string, auto: string, help?: string) => (
    <Field label={label} help={help} error={errors[k] ?? null}>
      {(id, note) => (
        <input
          id={id}
          type="password"
          autoComplete={auto}
          aria-describedby={note}
          aria-invalid={!!errors[k]}
          value={v[k]}
          onChange={(e) => setV({ ...v, [k]: e.target.value })}
        />
      )}
    </Field>
  );
  return (
    <section className="card">
      <h2>{t.profile.password}</h2>
      <form className="stack narrow" onSubmit={submit} noValidate>
        {input('current', t.profile.current, 'current-password')}
        {input('next', t.profile.next, 'new-password', t.register.passwordHelp)}
        {input('next2', t.profile.next2, 'new-password')}
        <div>
          <button type="submit" disabled={busy}>
            {t.profile.changePassword}
          </button>
        </div>
      </form>
    </section>
  );
}

function DevicesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['me', 'sessions'], queryFn: () => get<Session[]>('/api/me/sessions') });
  const signOut = async (id: string) => {
    await del(`/api/me/sessions/${id}`);
    toast(t.profile.deviceSignedOut);
    void qc.invalidateQueries({ queryKey: ['me', 'sessions'] });
  };
  const name = (s: Session) =>
    s.os || s.browser ? [s.os, s.browser].filter(Boolean).join(' · ') : t.profile.unknownDevice;
  return (
    <section className="card">
      <h2>{t.profile.devices}</h2>
      {list.isError ? (
        <Banner tone="bad">{t.common.unknownError}</Banner>
      ) : !list.data ? (
        <Skeleton lines={2} />
      ) : (
        <div className="tw">
          <table>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td>{name(s)}</td>
                  <td className="sub">{t.profile.lastUsed(relative(s.lastSeenAt))}</td>
                  <td className="act">
                    {s.current ? (
                      <Chip tone="ok">{t.profile.thisDevice}</Chip>
                    ) : (
                      <button type="button" onClick={() => signOut(s.id)}>
                        {t.profile.signOutDevice}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data.length === 1 && <p className="sub">{t.profile.noOtherDevices}</p>}
        </div>
      )}
    </section>
  );
}
