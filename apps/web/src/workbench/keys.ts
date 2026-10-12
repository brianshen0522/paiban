/**
 * Workbench shortcuts (docs/09-sync-workbench.md, "Keyboard shortcuts"). Pure: the component turns a
 * KeyboardEvent into a KeyInput and runs what comes back.
 */

export type BenchKey =
  | { kind: 'toggle-play' }
  | { kind: 'seek'; by: number }
  | { kind: 'nudge'; by: number }
  | { kind: 'select'; by: -1 | 1 }
  | { kind: 'anchor' }
  | { kind: 'auto' }
  | { kind: 'next-checkpoint' }
  | { kind: 'original'; down: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' };

export type KeyInput = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** What has focus: a text field / select ignores every shortcut; a button keeps Space and Enter. */
  target: 'field' | 'button' | 'other';
};

export function targetKind(el: EventTarget | null): KeyInput['target'] {
  if (!(el instanceof Element)) return 'other';
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return 'field';
  if (el.closest('button, summary, a[href]')) return 'button';
  return 'other';
}

export function keyAction(e: KeyInput): BenchKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target === 'field') return null;
  if (e.target === 'button' && (e.key === ' ' || e.key === 'Enter')) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case ' ':
      return { kind: 'toggle-play' };
    case 'ArrowLeft':
      return { kind: 'seek', by: e.shiftKey ? -5 : -1 };
    case 'ArrowRight':
      return { kind: 'seek', by: e.shiftKey ? 5 : 1 };
    case 'ArrowUp':
      return { kind: 'select', by: -1 };
    case 'ArrowDown':
      return { kind: 'select', by: 1 };
    // Shift turns , and . into < and > on most layouts.
    case ',':
    case '<':
      return { kind: 'nudge', by: e.shiftKey || key === '<' ? -0.5 : -0.05 };
    case '.':
    case '>':
      return { kind: 'nudge', by: e.shiftKey || key === '>' ? 0.5 : 0.05 };
    case 'Enter':
      return { kind: 'anchor' };
    case 'a':
      return { kind: 'auto' };
    case 'n':
      return { kind: 'next-checkpoint' };
    case 'o':
      return e.repeat ? null : { kind: 'original', down: true };
    case 'z':
      return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
    default:
      return null;
  }
}
