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

export function Progress({
  value,
  bad = false,
  live = false,
  label,
}: {
  value: number;
  bad?: boolean;
  /** Data is arriving: the filled part moves, so a stalled download looks different from a moving one. */
  live?: boolean;
  label: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={`prog${bad ? ' bad' : ''}${live ? ' live' : ''}`}
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
 * The confirmation before a destructive action (docs/11-pages.md, "確認框的樣式"): a modal dialog
 * over the page, so the list or card it came from keeps its size (Brian, 2026-10-06: a red box
 * opening inside a card made it grow). The consequences in words, a red button and "not now".
 * Focus starts on "not now", so Enter does not delete; Esc or a click outside cancels; focus goes
 * back to the button that opened it.
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
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const textId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const d = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    cancel.current?.focus();
    return () => {
      if (d?.open && typeof d.close === 'function') d.close();
      opener?.focus();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a pointer shortcut; the keyboard has Esc and "not now"
    <dialog
      ref={dialog}
      className="cdialog"
      aria-labelledby={textId}
      onCancel={(e) => {
        // Esc: the parent decides, by unmounting this.
        e.preventDefault();
        if (!busy) cancelRef.current();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget && !busy) cancelRef.current();
      }}
    >
      <div className="cdialog-body">
        <p id={textId}>{text}</p>
        <div className="cdialog-act">
          <button type="button" onClick={onCancel} ref={cancel} disabled={busy}>
            {t.common.notNow}
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
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
