import type { AlignModelCheck } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../http/context.js';
import { requireAdmin } from '../http/guards.js';
import { readSecret } from '../settings/secrets.js';
import { readSettings } from '../settings/settings.js';
import {
  anthropicMatcher,
  DEFAULT_ANTHROPIC_MODEL,
  LlmError,
  type MatchRequest,
  openAiCompatibleMatcher,
} from './llm.js';

/** Two lines heard in English, three subtitle lines in Chinese: the first two belong together. */
const QUESTION: MatchRequest = {
  heardLanguage: 'en',
  subtitleLanguage: 'zh-Hant',
  heard: [
    { id: 0, t: 61.2, text: 'Where did you put the keys?' },
    { id: 1, t: 64.0, text: 'I left them on the kitchen table.' },
  ],
  lines: [
    { id: 0, t: 40.1, text: '你把鑰匙放到哪裡去了？' },
    { id: 1, t: 43.0, text: '我放在廚房的桌子上。' },
    { id: 2, t: 47.5, text: '那我們走吧。' },
  ],
};

/** docs/13-settings.md, "測試連線": does the configured model answer, and answer sensibly? */
export function alignRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/api/admin/align/test', async (req): Promise<AlignModelCheck> => {
    requireAdmin(req);
    const { llm } = (await readSettings(deps.pool)).align;
    const key = await readSecret(deps, 'llmKey');
    if (llm.provider === 'none' || (llm.provider === 'anthropic' && !key))
      return { ok: false, code: 'NOT_CONFIGURED', ms: 0 };
    const matcher =
      llm.provider === 'anthropic'
        ? anthropicMatcher(key ?? '', llm.model || DEFAULT_ANTHROPIC_MODEL)
        : openAiCompatibleMatcher(llm.baseUrl, key, llm.model, 60_000);
    const started = Date.now();
    try {
      const m = await matcher(QUESTION, AbortSignal.timeout(60_000));
      const right = m.length === 2 && m.every((x) => x.heard === x.line);
      return { ok: right, code: right ? 'OK' : 'WRONG_ANSWER', ms: Date.now() - started };
    } catch (err) {
      const code = err instanceof LlmError ? err.code : 'TIMEOUT';
      return { ok: false, code, ms: Date.now() - started };
    }
  });
}
