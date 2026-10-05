import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// jsdom has no layout, so the virtualiser would render nothing: render every row instead.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (o: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, i) => ({ index: i, key: i, start: i * 40, size: 40 })),
    getTotalSize: () => o.count * 40,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

import { CueList } from './CueList';

/** docs/12-auth.md checklist: subtitle text containing markup is shown as text, never run. */
describe('the line list', () => {
  it('never turns markup in a line into elements', () => {
    const text = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const cue = { id: 1, start: 1, end: 2, text, origStart: 1, origEnd: 2, seg: 0, deleted: false, edited: false };
    const noop = () => undefined;
    const { container } = render(
      <CueList
        shown={[cue] as never}
        mapped={[cue] as never}
        second={null}
        scores={null}
        query=""
        sel={0}
        playing={-1}
        isPlaying={false}
        reveal={0}
        mode="sync"
        onSelect={noop}
        onSeek={noop}
        onPlayLine={noop}
        onAnchor={noop}
        onSplit={noop}
        onEdit={noop}
        onText={noop}
        onTextFocus={noop}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // Tag-like markup is dropped from the display (subtitles use <i> for italics); what is left is text.
    expect(container.textContent).toContain('alert(1)');
  });
});
