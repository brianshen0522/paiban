import { SITE_NAME } from '@paiban/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('placeholder page', () => {
  it('shows the site name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SITE_NAME);
  });
});
