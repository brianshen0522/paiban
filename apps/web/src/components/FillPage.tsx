import type { ReactNode } from 'react';

/**
 * A page whose main content is one list (Brian, 2026-10-06: lists scroll inside their own box, the
 * page itself does not). The page fills the space under the top bar; what comes before the list
 * keeps its height and the list (`ScrollList`) takes the rest and scrolls on its own.
 */
export function FillPage({ children }: { children: ReactNode }) {
  return <div className="page-fill">{children}</div>;
}

/** The part of a FillPage that scrolls. A region with a name, and focusable, so keys can scroll it. */
export function ScrollList({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
    <section className="list-scroll" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
