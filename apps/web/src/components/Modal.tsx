import { type ReactNode, useEffect, useId, useRef } from 'react';

/**
 * A floating window over the page (docs/18-llm.md, "Floating window"): a native modal <dialog>, so the
 * page behind it is inert and focus stays inside. Esc closes it (unless `busy`); focus starts on
 * the first field and returns to the button that opened it.
 */
export function Modal({
  title,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const d = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    d?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button')?.focus();
    return () => {
      if (d?.open && typeof d.close === 'function') d.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal${wide ? ' wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busyRef.current) closeRef.current();
      }}
    >
      <div className="modal-body">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
