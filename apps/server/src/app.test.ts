import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('GET /api/health', () => {
  it('answers ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
