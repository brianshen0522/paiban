import { afterEach, describe, expect, it } from 'vitest';
import { readTheme, setTheme } from './theme';

afterEach(() => setTheme('system'));

describe('theme choice', () => {
  it('forces light or dark on <html> and remembers it', () => {
    setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(readTheme()).toBe('dark');
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
  it('follows the system by removing the attribute', () => {
    setTheme('dark');
    setTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(readTheme()).toBe('system');
  });
});
