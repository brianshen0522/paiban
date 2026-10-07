import type { LlmProfile } from '@paiban/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, LlmProfileDialog, profileBody } from './LlmProfileDialog';

/** docs/18-llm.md, "設定檔": a key left empty stays, "clear" sends null, typing replaces it. */
const PROFILE: LlmProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '本機',
  provider: 'self-hosted',
  baseUrl: 'http://127.0.0.1:9/v1',
  apiVersion: '',
  model: 'qwen',
  priority: 1,
  weight: 1,
  enabled: true,
  params: { ...DEFAULT_PARAMS },
  keySet: true,
  coolingUntil: null,
  lastError: null,
  updatedAt: '2026-10-07T00:00:00Z',
};

describe('the profile form', () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
        return new Response(JSON.stringify(PROFILE), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('builds the body: key left out, null, or the typed text; Azure keeps its API version', () => {
    const form = { ...PROFILE, provider: 'openai' as const, apiVersion: 'x' };
    expect(profileBody(form, '', false)).not.toHaveProperty('key');
    expect(profileBody(form, '  ', false)).not.toHaveProperty('key');
    expect(profileBody(form, '', true).key).toBeNull();
    expect(profileBody(form, ' sk-test-not-real ', false).key).toBe('sk-test-not-real');
    expect(profileBody(form, '', false).apiVersion).toBe('');
    expect(profileBody({ ...form, provider: 'azure-openai', apiVersion: '2024-10-21' }, '', false).apiVersion).toBe(
      '2024-10-21',
    );
  });

  it('saves an edited profile without touching the stored key, and clears it when asked', async () => {
    const saved = vi.fn();
    render(<LlmProfileDialog profile={PROFILE} onClose={() => {}} onSaved={saved} />);
    fireEvent.click(screen.getByText('儲存'));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(sent[0]?.url).toBe(`/api/admin/llm/profiles/${PROFILE.id}`);
    expect(sent[0]?.body).not.toHaveProperty('key');
    fireEvent.click(screen.getByText('清除金鑰'));
    fireEvent.click(screen.getByText('儲存'));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body.key).toBeNull();
  });

  it('shows the service address only where it is needed', () => {
    render(<LlmProfileDialog profile={null} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByLabelText('服務網址')).toBeNull();
    fireEvent.change(screen.getByLabelText('供應商'), { target: { value: 'self-hosted' } });
    expect(screen.getByLabelText('服務網址')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('供應商'), { target: { value: 'azure-openai' } });
    expect((screen.getByLabelText('API 版本') as HTMLInputElement).value).toBe('2024-10-21');
  });
});
