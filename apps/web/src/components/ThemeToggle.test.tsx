import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { setTheme } from '../lib/theme';
import { ThemeToggle } from './ThemeToggle';

/** One button that rolls through light → dark → system (Brian, 2026-10-06). */
describe('the appearance button', () => {
  beforeEach(() => setTheme('light'));

  it('moves to the next choice on each press, and says what it is and what a press does', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe('外觀：淺色。按一下切換成深色');
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(button.getAttribute('aria-label')).toBe('外觀：深色。按一下切換成跟隨系統');
    fireEvent.click(button);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('paiban.theme')).toBeNull();
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
