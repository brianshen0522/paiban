import { describe, expect, it } from 'vitest';
import { setLocale } from '../copy';
import { bytes, eta, filmTitle, percent, posterColor, shortHash } from './format';

describe('numbers (docs/17-ui.md, "數字怎麼寫")', () => {
  it('writes sizes on base 1024 with the documented precision', () => {
    expect(bytes(1.6 * 1024 ** 3)).toBe('1.6 GB');
    expect(bytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(bytes(880 * 1024 ** 2)).toBe('880 MB');
    expect(bytes(884 * 1024 ** 2)).toBe('880 MB');
    expect(bytes(7.4 * 1024 ** 2)).toBe('7 MB');
    expect(bytes(0)).toBe('0 MB');
  });
  it('shortens a hash to its head and tail', () => {
    expect(shortHash('2a457de5aaaaaaaaaaaaaaaaaaaaaaaaaaaa7cd3')).toBe('2a457de5…7cd3');
  });
  it('rounds progress down so 100% means finished', () => {
    expect(percent(0.999)).toBe(99);
    expect(percent(1)).toBe(100);
  });
  it('writes the time left in minutes', () => {
    expect(eta(30)).toBe('剩不到 1 分鐘');
    expect(eta(12 * 60)).toBe('剩約 12 分鐘');
    expect(eta(null)).toBe('');
  });
  it('gives each title its own stable placeholder colour', () => {
    expect(posterColor('Charade')).toBe(posterColor('Charade'));
    expect(posterColor('Charade')).not.toBe(posterColor('Metropolis'));
  });
});

describe('film names in the interface language (Brian, 2026-10-08)', () => {
  it('puts the Chinese title first in Chinese and the original first in English', () => {
    const m = { title: 'Charade', titleZh: '謎中謎' };
    expect(filmTitle(m)).toEqual({ main: '謎中謎', other: 'Charade' });
    expect(filmTitle({ title: 'Charade', titleZh: null })).toEqual({ main: 'Charade', other: null });
    setLocale('en');
    try {
      expect(filmTitle(m)).toEqual({ main: 'Charade', other: '謎中謎' });
      expect(filmTitle({ title: 'Charade', titleZh: null })).toEqual({ main: 'Charade', other: null });
    } finally {
      setLocale('zh-TW');
    }
  });
});
