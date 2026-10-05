import { type ReactNode, useEffect, useId, useRef } from 'react';
import { t } from '../copy/zh-TW';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | '';

/** Status chip: a dot plus words, never colour alone (docs/17-ui.md, "無障礙"). */
export function Chip({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`st${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Banner({
  tone,
  children,
  role,
}: {
  tone: 'info' | 'warn' | 'bad';
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`banner ${tone}`} role={role ?? (tone === 'bad' ? 'alert' : undefined)}>
      {children}
    </div>
  );
}

export function Empty({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
}

export function Progress({ value, bad = false, label }: { value: number; bad?: boolean; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={`prog${bad ? ' bad' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * The in-place confirmation (docs/11-pages.md, "確認框的樣式"): a red box where the button was,
 * the consequences in words, a red button and "not now". Esc cancels; focus moves into it.
 */
export function ConfirmInline({
  text,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="confirm">
      <p>{text}</p>
      <div className="frow">
        <button type="button" className="danger" onClick={onConfirm} disabled={busy} ref={ref}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          {t.common.notNow}
        </button>
      </div>
    </div>
  );
}

export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, noteId)}
      {error ? (
        <small id={noteId} className="err" role="alert">
          {error}
        </small>
      ) : help ? (
        <small id={noteId}>{help}</small>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="sw">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function PageHead({ title, lead, children }: { title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="head">
      <div>
        <h1>{title}</h1>
        {lead && <p className="sub">{lead}</p>}
      </div>
      {children}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card skel-card" role="status" aria-busy="true" aria-label={t.common.loading}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <span key={i} className="skel-line" />
      ))}
    </div>
  );
}
