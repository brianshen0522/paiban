import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Bottom-right confirmations of something just done (docs/11-pages.md, "外框"): at most three,
 * about five seconds each, optionally one action. Errors and decisions stay in the page.
 */
type Toast = { id: number; text: string; action?: { label: string; run: () => void } };
type Push = (text: string, action?: Toast['action']) => void;

const Ctx = createContext<Push>(() => undefined);
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<Push>((text, action) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, ...(action ? { action } : {}) }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div className="toast" key={x.id}>
            <span>{x.text}</span>
            {x.action && (
              <button
                type="button"
                onClick={() => {
                  x.action?.run();
                  setToasts((list) => list.filter((y) => y.id !== x.id));
                }}
              >
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
