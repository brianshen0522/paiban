import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assToCues,
  cuesToTraditional,
  decodeSubtitle,
  detectLanguage,
  normalizeCues,
  parseSrt,
  parseSubtitleFile,
  parseVtt,
  toTraditional,
} from './text.js';

// Ported from reference/subtitles/text.test.mjs (same cases and expected values), plus the cue
// readers and the normalization rules of docs/07-subtitle-providers.md, "Download and processing (`subtitle.resolve` downloads; `subtitle.fetch` / `subtitle.ingest` process)".
const FIX = (p: string) => fileURLToPath(new URL(`../../../../fixtures/${p}`, import.meta.url));
const bytes = (p: string) => readFileSync(FIX(p));
const utf8 = (p: string) => readFileSync(FIX(p), 'utf8');

describe('decoding', () => {
  it('recognises each encoding and decodes to the same text', () => {
    const traditional = utf8('late.zh-TW.srt');
    for (const [file, encoding, expected] of [
      ['late.zh-TW.srt', 'utf-8', traditional],
      ['late.zh-TW.big5.srt', 'big5', traditional],
      ['late.zh-TW.utf16le-bom.srt', 'utf-16le', traditional],
      ['late.zh-CN.gb18030.srt', 'gb18030', utf8('late.zh-CN.srt')],
      ['truth.en.srt', 'utf-8', utf8('truth.en.srt')],
    ] as const) {
      const d = decodeSubtitle(bytes(file));
      expect(d.encoding, file).toBe(encoding);
      expect(d.text, file).toBe(expected);
      expect(d.confident, file).toBe(true);
    }
  });

  it('does not mistake Western legacy text for Chinese', () => {
    const french = Buffer.from(
      '1\n00:00:01,000 --> 00:00:02,000\nÇa va très bien, merci. Où est le café déjà ?\n',
      'latin1',
    );
    expect(decodeSubtitle(french).encoding).toBe('windows-1252');
    expect(decodeSubtitle(french).text).toMatch(/Ça va très bien/);
  });
});

describe('language', () => {
  it('comes from the content', () => {
    expect(detectLanguage(utf8('late.zh-TW.srt'))).toBe('zh-Hant');
    expect(detectLanguage(utf8('late.zh-CN.srt'))).toBe('zh-Hans');
    expect(detectLanguage(utf8('truth.en.srt'))).toBe('en');
    expect(detectLanguage('1\n00:00:01,000 --> 00:00:02,000\n...\n')).toBe('und');
  });

  it('converts Simplified to the Traditional text people in Taiwan expect', () => {
    expect(toTraditional(utf8('late.zh-CN.srt'))).toBe(utf8('late.zh-CN.to-zh-TW.expected.srt'));
    expect(toTraditional('这个软件的鼠标有问题')).toBe('這個軟體的滑鼠有問題');
    expect(toTraditional('这个软件的鼠标有问题', 'tw')).toBe('這個軟件的鼠標有問題');
  });
});

describe('ASS', () => {
  it('becomes plain cues: drawings, comments and tags are dropped', () => {
    const parsed = parseSubtitleFile('late.bilingual.ass', bytes('late.bilingual.ass'));
    const cues = parsed?.cues ?? [];
    expect(cues.length).toBe(26);
    expect(cues[0]?.text).toBe('你進來之後有把門鎖上嗎?\nDid you lock the door behind you?');
    expect(Math.abs((cues[0]?.start ?? 0) - 5.35)).toBeLessThan(0.011);
    expect(Math.abs((cues[0]?.end ?? 0) - 7.636)).toBeLessThan(0.011);
    expect(cues.map((c) => c.id)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(parsed?.format).toBe('ass');
    expect(parsed?.bilingual).toBe(true);
    expect(
      assToCues('[Events]\nFormat: Layer, Start, End, Text\nDialogue: 0,0:00:01.00,0:00:02.00,{\\p1}m 0 0 l 1 1\n'),
    ).toEqual([]);
  });
});

describe('every fixture', () => {
  const truth = parseSrt(utf8('truth.zh-TW.srt'));
  const late = normalizeCues(parseSrt(utf8('late.zh-TW.srt')));

  it.each([
    ['late.zh-TW.srt', 'utf-8', 'zh-Hant', 'srt'],
    ['late.zh-TW.big5.srt', 'big5', 'zh-Hant', 'srt'],
    ['late.zh-TW.utf16le-bom.srt', 'utf-16le', 'zh-Hant', 'srt'],
    ['late.zh-CN.srt', 'utf-8', 'zh-Hans', 'srt'],
    ['late.zh-CN.gb18030.srt', 'gb18030', 'zh-Hans', 'srt'],
    ['late.bilingual.ass', 'utf-8', 'zh-Hant', 'ass'],
    ['late.en.vtt', 'utf-8', 'en', 'vtt'],
    ['truth.en.srt', 'utf-8', 'en', 'srt'],
    ['rate.zh-TW.srt', 'utf-8', 'zh-Hant', 'srt'],
    ['cut.zh-TW.srt', 'utf-8', 'zh-Hant', 'srt'],
  ] as const)('%s → 26 cues, %s, %s, %s', (file, encoding, language, format) => {
    const p = parseSubtitleFile(file, bytes(file));
    expect(p).not.toBeNull();
    expect(p?.cues.length).toBe(26);
    expect(p?.encoding).toBe(encoding);
    expect(p?.language).toBe(language);
    expect(p?.format).toBe(format);
    expect(p?.cues.map((c) => c.id)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(p?.cues.every((c) => c.end > c.start && c.text === c.text.trim() && !c.text.includes('\r'))).toBe(true);
  });

  it('gives the same times whatever the encoding or format', () => {
    for (const file of ['late.zh-TW.big5.srt', 'late.zh-TW.utf16le-bom.srt', 'late.en.vtt', 'late.bilingual.ass']) {
      const cues = parseSubtitleFile(file, bytes(file))?.cues ?? [];
      // ASS keeps centiseconds only.
      const tol = file.endsWith('.ass') ? 0.011 : 0.0005;
      cues.forEach((c, i) => {
        expect(Math.abs(c.start - (late[i]?.start ?? 0)), `${file} #${i}`).toBeLessThan(tol);
        expect(Math.abs(c.end - (late[i]?.end ?? 0)), `${file} #${i}`).toBeLessThan(tol);
      });
    }
    expect(truth.length).toBe(26);
  });

  it('converts the Simplified fixture into exactly the expected Traditional file', () => {
    const simplified = parseSubtitleFile('late.zh-CN.gb18030.srt', bytes('late.zh-CN.gb18030.srt'))?.cues ?? [];
    const expected = parseSubtitleFile('x.srt', bytes('late.zh-CN.to-zh-TW.expected.srt'))?.cues ?? [];
    expect(cuesToTraditional(simplified)).toEqual(expected);
    expect(
      detectLanguage(
        cuesToTraditional(simplified)
          .map((c) => c.text)
          .join('\n'),
      ),
    ).toBe('zh-Hant');
  });
});

describe('normalization', () => {
  it('trims, drops empty cues, clamps, repairs ends, sorts and numbers', () => {
    expect(
      normalizeCues([
        { start: 5, end: 6, text: '  later \r\nline ' },
        { start: -1, end: 0.5, text: 'clamped' },
        { start: 3, end: 2, text: 'backwards' },
        { start: 4, end: 5, text: '   ' },
        { start: 3, end: 3.5, text: '<i>kept</i>' },
      ]),
    ).toEqual([
      { id: 1, start: 0, end: 0.5, text: 'clamped' },
      { id: 2, start: 3, end: 4, text: 'backwards' },
      { id: 3, start: 3, end: 3.5, text: '<i>kept</i>' },
      { id: 4, start: 5, end: 6, text: 'later \nline' },
    ]);
  });

  it('reads WebVTT without hours, with settings, NOTE blocks and no index', () => {
    expect(
      parseVtt(
        'WEBVTT\n\nNOTE a comment\n\n01:02.500 --> 01:04.000 align:start\nHello\n\nid-2\n00:01:05.000 --> 00:01:06.000\nAgain',
      ),
    ).toEqual([
      { start: 62.5, end: 64, text: 'Hello' },
      { start: 65, end: 66, text: 'Again' },
    ]);
  });

  it('reads SRT with dots, missing indexes and stray blank lines', () => {
    expect(parseSrt('\n\n1\n00:00:01.5 --> 00:00:02,000\nA\n\n\n00:00:03,000 --> 00:00:04,000\nB\nC\n')).toEqual([
      { start: 1.5, end: 2, text: 'A' },
      { start: 3, end: 4, text: 'B\nC' },
    ]);
  });

  it('fails a file without a single cue', () => {
    expect(parseSubtitleFile('empty.srt', Buffer.from(''))).toBeNull();
    expect(parseSubtitleFile('blank.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n   \n'))).toBeNull();
    expect(parseSubtitleFile('readme.txt', Buffer.from('just some notes'))).toBeNull();
  });
});
