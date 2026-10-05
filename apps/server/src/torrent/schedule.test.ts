import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mainVideo, pathsAreSafe, pickToStart, stalled } from './schedule.js';

describe('scheduling (docs/06, "排程")', () => {
  const c = (id: string, requestedBy: string | null, requesterHolds = true) => ({ id, requestedBy, requesterHolds });

  it('stops at the site-wide limit', () => {
    expect(
      pickToStart([c('a', 'u1'), c('b', 'u2'), c('c', 'u3')], new Map(), 1, { maxActive: 2, maxPerUser: 2 }),
    ).toEqual(['a']);
  });

  it('skips a person at their limit and takes the next one', () => {
    const active = new Map([['u1', 1]]);
    expect(pickToStart([c('a', 'u1'), c('b', 'u2')], active, 1, { maxActive: 3, maxPerUser: 1 })).toEqual(['b']);
  });

  it('counts downloads started in the same pass', () => {
    expect(
      pickToStart([c('a', 'u1'), c('b', 'u1'), c('c', 'u2')], new Map(), 0, { maxActive: 3, maxPerUser: 1 }),
    ).toEqual(['a', 'c']);
  });

  it('lets a download whose requester is gone or left count only site-wide', () => {
    const active = new Map([['u1', 1]]);
    expect(pickToStart([c('a', null), c('b', 'u1', false)], active, 1, { maxActive: 3, maxPerUser: 1 })).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('metadata checks', () => {
  it('finds the largest video file', () => {
    const files = [
      { path: 'Film/Film.mp4', length: 900 },
      { path: 'Film/sample.mkv', length: 50 },
      { path: 'Film/poster.jpg', length: 2000 },
    ];
    expect(mainVideo(files)?.path).toBe('Film/Film.mp4');
    expect(mainVideo([{ path: 'readme.txt', length: 1 }])).toBeNull();
  });

  it('refuses paths that leave the download folder', () => {
    expect(pathsAreSafe('/data/torrents/x', [{ path: 'Film/a.mp4' }], resolve, sep)).toBe(true);
    expect(pathsAreSafe('/data/torrents/x', [{ path: '../../etc/passwd' }], resolve, sep)).toBe(false);
    expect(pathsAreSafe('/data/torrents/x', [{ path: '/etc/passwd' }], resolve, sep)).toBe(false);
  });
});

describe('stalls', () => {
  const min = 60_000;
  it('gives up on metadata after five minutes', () => {
    expect(stalled(4 * min, 0, 0, false, 30)).toBeNull();
    expect(stalled(6 * min, 0, 0, false, 30)).toBe('METADATA_TIMEOUT');
  });
  it('fails a download without new data for the configured time', () => {
    expect(stalled(100 * min, 0, 71 * min, true, 30)).toBeNull();
    expect(stalled(100 * min, 0, 69 * min, true, 30)).toBe('STALLED');
  });
});
