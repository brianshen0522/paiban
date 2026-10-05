import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SyncCore } from '@paiban/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitPairs, MIN_PAIRS, type Pair, pairSupport, pickWithPairs } from './fit.js';
import {
  anthropicMatcher,
  extractJson,
  LlmError,
  llmPairs,
  type Matcher,
  type MatchRequest,
  openAiCompatibleMatcher,
  renderRequest,
} from './llm.js';
import { type AsrTranscript, covered, pickWindows, similarity, textPairs, tokens } from './text.js';

type Cue = SyncCore.Cue;

/**
 * fixtures/film/film.json: a 21.5-minute synthetic film. `truth` is when every line is spoken;
 * `late`, `pal` and `cut` are the same subtitle wrong in the three usual ways.
 */
const film = JSON.parse(readFileSync(new URL('../../../../fixtures/film/film.json', import.meta.url), 'utf8')) as {
  speech: SyncCore.SpeechData;
  truth: Cue[];
  late: Cue[];
  pal: Cue[];
  cut: Cue[];
};
const sp = SyncCore.makeSpeech(film.speech);
const DURATION = 1290;

/** A deterministic stand-in for random numbers, so a failure can be reproduced. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * What recognition would hear in the windows: the true lines with their start a little off and
 * the odd word missing, as Whisper does.
 */
function hear(windows = pickWindows(DURATION), seed = 1): AsrTranscript {
  const r = rng(seed);
  const segments = film.truth
    .filter((c) => windows.some(([s, d]) => c.start >= s && c.start < s + d))
    .map((c) => {
      const words = c.text.split(' ');
      if (words.length > 4 && r() < 0.3) words.splice(Math.floor(r() * words.length), 1);
      return { start: c.start + (r() - 0.5) * 0.2, end: c.end, text: words.join(' ') };
    });
  return { language: 'en', model: 'test', windows, segments };
}

/** Largest error of an alignment against the truth, over every cue. */
function maxError(cues: Cue[], segments: SyncCore.Segment[]): number {
  const mapped = SyncCore.applyDoc(cues, { segments, edits: {} });
  return Math.max(...mapped.map((m, i) => Math.abs(m.start - film.truth[i].start)));
}

describe('text comparison', () => {
  it('drops markup and punctuation, folds case, splits Chinese into characters', () => {
    expect(tokens('<i>Hello</i>, WORLD! {\\an8}')).toEqual(['hello', 'world']);
    expect(tokens('你好，世界')).toEqual(['你', '好', '世', '界']);
    expect(tokens('ＡＢＣ　def')).toEqual(['abc', 'def']);
  });

  it('measures shared words against the shorter line, and refuses lines of very different length', () => {
    expect(similarity(tokens('we have ten minutes'), tokens('we have ten minutes left'))).toBe(1);
    expect(similarity(tokens('go go'), tokens('go go go now move your asses quickly'))).toBe(0);
    expect(covered(['a', 'a'], ['a'])).toBe(0.5);
  });
});

describe('listening windows (docs/08, "語音辨識")', () => {
  it('covers 40 % of a short film in evenly spread windows', () => {
    const w = pickWindows(734);
    expect(w).toHaveLength(10);
    expect(w[0][0]).toBeGreaterThan(0);
    expect(w[w.length - 1][0] + 30).toBeLessThan(734);
  });

  it('listens to at most six minutes of a long film', () => {
    const w = pickWindows(2 * 3600);
    expect(w.reduce((s, [, d]) => s + d, 0)).toBe(360);
    for (let k = 1; k < w.length; k++) expect(w[k][0]).toBeGreaterThan(w[k - 1][0] + 30);
  });

  it('takes a very short film whole and nothing from no film', () => {
    expect(pickWindows(45)).toEqual([[0, 45]]);
    expect(pickWindows(0)).toEqual([]);
  });
});

describe('pairing by text', () => {
  it('pairs the heard lines with the right cues even when the subtitle is far off', () => {
    const heard = hear();
    for (const version of [film.late, film.pal, film.cut]) {
      const pairs = textPairs(version, heard);
      expect(pairs.length).toBeGreaterThan(heard.segments.length * 0.6);
      const wrong = pairs.filter((p) => Math.abs(film.truth[p.cue].start - p.y) > 0.2);
      expect(wrong).toEqual([]);
    }
  });

  it('pairs nothing when the subtitle says other things', () => {
    const other = film.truth.map((c, i) => ({ ...c, text: `line number ${i} about something else entirely` }));
    expect(textPairs(other, hear())).toEqual([]);
  });
});

describe('fitting pairs', () => {
  for (const [name, version, segs] of [
    ['late', film.late, 1],
    ['pal', film.pal, 1],
    ['cut', film.cut, 2],
  ] as const) {
    it(`recovers the ${name} subtitle to within 0.2 s`, () => {
      const pairs = textPairs(version, hear());
      const fit = fitPairs(version, pairs, sp);
      expect(fit).not.toBeNull();
      expect(fit?.segments).toHaveLength(segs);
      expect(maxError(version, fit?.segments ?? [])).toBeLessThan(0.2);
    });
  }

  it('is not thrown by a third of the pairs being wrong', () => {
    const r = rng(7);
    const good = textPairs(film.cut, hear());
    const bad: Pair[] = good.slice(0, Math.floor(good.length / 2)).map((p) => ({
      cue: Math.floor(r() * film.cut.length),
      y: p.y,
    }));
    const fit = fitPairs(film.cut, [...good, ...bad], sp);
    expect(fit?.segments).toHaveLength(2);
    expect(maxError(film.cut, fit?.segments ?? [])).toBeLessThan(0.2);
  });

  it('gives up on too few pairs', () => {
    const pairs = textPairs(film.late, hear()).slice(0, MIN_PAIRS - 1);
    expect(fitPairs(film.late, pairs, sp)).toBeNull();
  });

  it('keeps one segment when splitting is not allowed', () => {
    const fit = fitPairs(film.cut, textPairs(film.cut, hear()), sp, false);
    expect(fit?.segments).toHaveLength(1);
  });
});

describe('choosing with pairs', () => {
  it('drops an alignment the heard words contradict, even when the speech detection likes it more', () => {
    const pairs = textPairs(film.late, hear());
    const right = fitPairs(film.late, pairs, sp);
    if (!right) throw new Error('no fit');
    // Wrong by a cut that is not there: its second half sits 30 s early.
    const wrong: SyncCore.Segment[] = [
      { from: 0, scale: 1, offset: -2.37 },
      { from: 120, scale: 1, offset: -32.37 },
    ];
    const picked = pickWithPairs(
      sp,
      film.late,
      [
        { method: 'core', segments: wrong },
        { method: 'asr', segments: right.segments },
      ],
      pairs,
    );
    expect(picked.best.method).toBe('asr');
    expect(picked.support).toBe(pairSupport(film.late, pairs, right.segments));
  });

  it('is pickAlignment when there are no pairs', () => {
    const cands = [{ method: 'core', segments: [{ from: 0, scale: 1, offset: -2.37 }] }];
    expect(pickWithPairs(sp, film.late, cands, []).best.method).toBe('core');
  });
});

describe('pairing through a language model', () => {
  const zh = film.late.map((c) => ({ ...c, text: `第${c.id}句` }));

  /** Answers like a model that knows the true pairing. */
  const knowing: Matcher = async (req) =>
    req.heard.flatMap((h) => {
      const truth = film.truth.findIndex((c) => Math.abs(c.start - h.t) < 0.2);
      return req.lines.some((l) => l.id === truth) ? [{ heard: h.id, line: truth }] : [];
    });

  it('asks once per window with the subtitle lines that could be there, and fits the answers', async () => {
    const asked: MatchRequest[] = [];
    const heard = hear();
    const { pairs, windows, failed } = await llmPairs(
      async (req) => {
        asked.push(req);
        return knowing(req);
      },
      zh,
      heard,
      'zh-Hant',
    );
    expect(windows).toBe(asked.length);
    expect(failed).toBe(0);
    expect(asked[0].subtitleLanguage).toBe('zh-Hant');
    expect(asked[0].heardLanguage).toBe('en');
    const fit = fitPairs(zh, pairs, sp);
    expect(maxError(zh, fit?.segments ?? [])).toBeLessThan(0.2);
  });

  it('ignores ids that were not in the question', async () => {
    const { pairs } = await llmPairs(
      async (req) => [
        { heard: 99999, line: req.lines[0].id },
        { heard: req.heard[0].id, line: -5 },
      ],
      zh,
      hear(),
      'zh-Hant',
    );
    expect(pairs).toEqual([]);
  });

  it('carries on past a failed window, and reports the error when every window fails', async () => {
    let n = 0;
    const flaky: Matcher = async (req) => {
      n++;
      if (n === 1) throw new LlmError('BAD_RESPONSE', 'garbled');
      return knowing(req);
    };
    const r = await llmPairs(flaky, zh, hear(), 'zh-Hant');
    expect(r.failed).toBe(1);
    expect(r.pairs.length).toBeGreaterThan(MIN_PAIRS);
    await expect(
      llmPairs(
        async () => {
          throw new LlmError('AUTH', 'refused');
        },
        zh,
        hear(),
        'zh-Hant',
      ),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('shows ids, times and words, one line each', () => {
    const text = renderRequest({
      heardLanguage: 'en',
      subtitleLanguage: 'zh-Hant',
      heard: [{ id: 3, t: 12.345, text: 'Hello there.' }],
      lines: [{ id: 7, t: 10, text: '你好\n朋友' }],
    });
    expect(text).toContain('H3 [12.3] Hello there.');
    expect(text).toContain('S7 [10.0] 你好 / 朋友');
  });

  it('finds the JSON in a chatty answer', () => {
    expect(extractJson('<think>hmm {"x":1}</think>Sure:\n```json\n{"matches":[]}\n```')).toEqual({ matches: [] });
    expect(() => extractJson('no idea')).toThrow(LlmError);
  });
});

describe('language model clients against a local stand-in', () => {
  let server: Server;
  let base = '';
  let last: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> } | null = null;
  let reply: (url: string) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => {
        raw += d;
      });
      req.on('end', () => {
        last = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} };
        const r = reply(req.url ?? '');
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  const req: MatchRequest = {
    heardLanguage: 'en',
    subtitleLanguage: 'fr',
    heard: [{ id: 0, t: 1, text: 'Hello' }],
    lines: [{ id: 4, t: 0, text: 'Bonjour' }],
  };

  it('OpenAI-compatible: sends the key and JSON mode, reads the answer', async () => {
    reply = () => ({
      status: 200,
      body: { choices: [{ message: { content: '<think>ok</think>{"matches":[{"heard":0,"line":4}]}' } }] },
    });
    const m = openAiCompatibleMatcher(`${base}/v1/`, 'test-key-not-real', 'qwen-test');
    expect(await m(req)).toEqual([{ heard: 0, line: 4 }]);
    expect(last?.url).toBe('/v1/chat/completions');
    expect(last?.headers.authorization).toBe('Bearer test-key-not-real');
    expect(last?.body).toMatchObject({ model: 'qwen-test', response_format: { type: 'json_object' } });
  });

  it('OpenAI-compatible: no key, no authorization header; a refused key is AUTH', async () => {
    reply = () => ({ status: 401, body: { error: 'no' } });
    await expect(openAiCompatibleMatcher(base, null, 'm')(req)).rejects.toMatchObject({ code: 'AUTH' });
    expect(last?.headers.authorization).toBeUndefined();
  });

  it('Claude: a structured answer is parsed; a refused key is AUTH', async () => {
    reply = () => ({
      status: 200,
      body: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"matches":[{"heard":0,"line":4}]}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const m = anthropicMatcher('test-key-not-real', 'claude-opus-5-5', base);
    expect(await m(req)).toEqual([{ heard: 0, line: 4 }]);
    expect(last?.url).toBe('/v1/messages?beta=true');
    expect(last?.headers['x-api-key']).toBe('test-key-not-real');
    expect(last?.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' });
    reply = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'x' } } });
    await expect(anthropicMatcher('test-key-not-real', 'claude-opus-5-5', base)(req)).rejects.toMatchObject({
      code: 'AUTH',
    });
  });
});
