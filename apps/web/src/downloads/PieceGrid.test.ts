import { describe, expect, it } from 'vitest';
import { cells } from './PieceGrid';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('piece grid cells', () => {
  it('one cell per piece for a small torrent: done, in flight, availability of the missing', () => {
    const list = cells({
      count: 4,
      size: 16384,
      have: b64([0b10000000]),
      active: b64([0b01000000]),
      availability: b64([1, 2, 0, 3]),
    });
    expect(list.map((c) => [c.done, c.active, c.availability])).toEqual([
      [1, false, 0],
      [0, true, 2],
      [0, false, 0],
      [0, false, 3],
    ]);
  });

  it('groups pieces when there are too many, keeping the share done', () => {
    const count = 4800;
    const have = new Array(count / 8).fill(0);
    for (let i = 0; i < count; i += 2) have[i >> 3] |= 0x80 >> (i & 7); // every other piece done
    const list = cells({
      count,
      size: 16384,
      have: b64(have),
      active: b64(new Array(count / 8).fill(0)),
      availability: b64(new Array(count).fill(1)),
    });
    expect(list).toHaveLength(2400);
    expect(list[0]).toMatchObject({ from: 0, to: 2, done: 0.5 });
  });
});
