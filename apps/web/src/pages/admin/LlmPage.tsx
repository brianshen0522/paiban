import type { LlmProfile, LlmSettings } from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Banner, Chip, ConfirmInline, Empty, Field, PageHead, Skeleton } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { intlLocale, t } from '../../copy';
import { asFailure, del, get, put } from '../../lib/api';
import { when } from './AuditPage';
import { LlmProfileDialog } from './LlmProfileDialog';

const c = () => t.llm;
export const LLM_KEY = ['admin', 'llm'] as const;

const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });

/** docs/18-llm.md: the profiles translation and auto-align share, the translation limit, recent use. */
export function LlmPage() {
  const q = useQuery({ queryKey: LLM_KEY, queryFn: () => get<LlmSettings>('/api/admin/llm') });
  // null: closed; 'new': a new profile; a profile: editing it.
  const [editing, setEditing] = useState<LlmProfile | 'new' | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <>
      <PageHead title={c().title} lead={c().lead}>
        <button type="button" className="primary" onClick={() => setEditing('new')}>
          {c().add}
        </button>
      </PageHead>
      {q.isError ? (
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => q.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      ) : !q.data ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <Profiles profiles={q.data.profiles} onEdit={setEditing} />
          <Limit value={q.data.translatePerHour} />
          <Usage data={q.data} />
        </>
      )}
      {editing && (
        <LlmProfileDialog
          profile={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast(c().saved);
            void qc.invalidateQueries({ queryKey: LLM_KEY });
          }}
        />
      )}
    </>
  );
}

function Profiles({ profiles, onEdit }: { profiles: LlmProfile[]; onEdit: (p: LlmProfile) => void }) {
  if (!profiles.length)
    return (
      <section className="card">
        <h2>{c().profiles}</h2>
        <Empty title={c().empty} hint={c().emptyHint} />
      </section>
    );
  const sorted = [...profiles].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  return (
    <section className="card">
      <h2>{c().profiles}</h2>
      <p className="sub">{c().howItWorks}</p>
      <div className="tw">
        <table className="rtable">
          <thead>
            <tr>
              <th>{c().cols.name}</th>
              <th>{c().cols.provider}</th>
              <th>{c().cols.model}</th>
              <th>{c().cols.order}</th>
              <th>{c().cols.state}</th>
              <th>{c().cols.key}</th>
              <th className="act">{c().cols.action}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <ProfileRow key={p.id} p={p} onEdit={() => onEdit(p)} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProfileRow({ p, onEdit }: { p: LlmProfile; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const cooling = p.coolingUntil && Date.parse(p.coolingUntil) > Date.now() ? p.coolingUntil : null;
  const remove = async () => {
    setBusy(true);
    setError(false);
    try {
      await del(`/api/admin/llm/profiles/${p.id}`);
      toast(c().removed);
      void qc.invalidateQueries({ queryKey: LLM_KEY });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <>
      <tr>
        <td className="lead">
          <b>{p.name}</b>
        </td>
        <td>{(c().providers[p.provider] ?? p.provider).replace(/\s*[\uFF08(].*$/, '')}</td>
        <td className="mono rel">{p.model || '—'}</td>
        <td>{c().orderValue(p.priority, p.weight)}</td>
        <td>
          {!p.enabled ? (
            <Chip>{c().stateOff}</Chip>
          ) : cooling ? (
            <Chip tone="warn">
              {c().stateCooling(hm(cooling), p.lastError ? (t.translate.errors[p.lastError] ?? p.lastError) : '')}
            </Chip>
          ) : (
            <Chip tone="ok">{c().stateOk}</Chip>
          )}
        </td>
        <td>{p.keySet ? c().keySet : c().keyNone}</td>
        <td className="act">
          <button type="button" onClick={onEdit}>
            {c().edit}
          </button>
          <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
            {c().remove}
          </button>
        </td>
      </tr>
      {(confirm || error) && (
        <tr className="blocked">
          <td colSpan={7}>
            {confirm && (
              <ConfirmInline
                text={c().confirmRemove(p.name)}
                confirmLabel={c().remove}
                busy={busy}
                onConfirm={remove}
                onCancel={() => setConfirm(false)}
              />
            )}
            {error && <Banner tone="bad">{t.common.unknownError}</Banner>}
          </td>
        </tr>
      )}
    </>
  );
}

function Limit({ value }: { value: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(String(value)), [value]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      setError(c().fields.RANGE);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await put('/api/admin/llm/settings', { translatePerHour: n });
      toast(c().perHourSaved);
      void qc.invalidateQueries({ queryKey: LLM_KEY });
    } catch (err) {
      const f = asFailure(err);
      setError(f.code === 'VALIDATION' ? c().fields.RANGE : t.common.unknownError);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="card">
      <h2>{c().limitTitle}</h2>
      <form className="frow align-end" onSubmit={save} noValidate>
        <Field label={c().perHour} help={c().perHourHelp} error={error}>
          {(id, note) => (
            <input
              id={id}
              aria-describedby={note}
              aria-invalid={!!error}
              className="narrow-input"
              type="number"
              min={0}
              max={100}
              step={1}
              value={v}
              onChange={(e) => setV(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" disabled={saving || v === String(value)}>
          {t.common.save}
        </button>
      </form>
    </section>
  );
}

function Usage({ data }: { data: LlmSettings }) {
  return (
    <section className="card">
      <h2>{c().usageTitle}</h2>
      {data.usage.length === 0 ? (
        <p className="sub">{c().usageEmpty}</p>
      ) : (
        <div className="tw">
          <table className="rtable">
            <thead>
              <tr>
                <th>{c().usageCols.at}</th>
                <th>{c().usageCols.profile}</th>
                <th>{c().usageCols.purpose}</th>
                <th>{c().usageCols.user}</th>
                <th>{c().usageCols.result}</th>
                <th className="num">{c().usageCols.ms}</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.map((u) => (
                <tr key={u.id}>
                  <td className="lead">{when(u.at)}</td>
                  <td>{u.profileName}</td>
                  <td>{c().purposes[u.purpose] ?? u.purpose}</td>
                  <td>{u.user?.displayName ?? '—'}</td>
                  <td>
                    {u.ok ? (
                      <Chip tone="ok">{c().resultOk}</Chip>
                    ) : (
                      <Chip tone="bad">
                        {t.translate.errors[u.errorCode ?? ''] ?? u.errorCode ?? t.common.unknownError}
                      </Chip>
                    )}
                  </td>
                  <td className="num">{c().seconds((u.ms / 1000).toFixed(1))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
