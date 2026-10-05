import type { Cue, DetectedLang } from '@paiban/shared';
import iconv from 'iconv-lite';
import * as OpenCC from 'opencc-js';

/**
 * Turning the bytes of a subtitle file into UTF-8 cues (docs/07-subtitle-providers.md, "下載與處理",
 * steps 4 to 7). A port of reference/subtitles/text.mjs, plus the SRT and WebVTT readers and the
 * normalization rules. Pure functions: no files, no database.
 *
 *   bytes → decodeSubtitle → (ASS: assToCues | SRT/VTT: parseSrt / parseVtt) → normalizeCues
 *         → detectLanguage; Simplified → Traditional happens later, when a person adds it.
 */

export type SubtitleFormat = 'srt' | 'ass' | 'vtt';
export type RawCue = { start: number; end: number; text: string };
export type Decoded = { text: string; encoding: string; confident: boolean };

const LEGACY = ['big5', 'gb18030', 'shift_jis', 'euc-kr', 'windows-1252'] as const;
// Characters that are very frequent in Chinese dialogue, in both scripts. A wrong decoding still
// yields valid-looking CJK, but almost none of these.
const COMMON_ZH = /[的是不了我你在有這这他們们來来個个嗎吗]/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const done = (text: string, encoding: string, confident: boolean): Decoded => ({
  text: text.replace(/\r\n?/g, '\n'),
  encoding,
  confident,
});

/**
 * Bytes of a subtitle file → text. Byte-order marks first, then strict UTF-8, then the legacy
 * encoding whose decoding looks most like language.
 */
export function decodeSubtitle(buf: Buffer): Decoded {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return done(buf.subarray(3).toString('utf8'), 'utf-8', true);
  if (buf[0] === 0xff && buf[1] === 0xfe) return done(iconv.decode(buf.subarray(2), 'utf16le'), 'utf-16le', true);
  if (buf[0] === 0xfe && buf[1] === 0xff) return done(iconv.decode(buf.subarray(2), 'utf16be'), 'utf-16be', true);
  try {
    return done(new TextDecoder('utf-8', { fatal: true }).decode(buf), 'utf-8', true);
  } catch {
    // not UTF-8
  }
  let best: { text: string; encoding: string; score: number } | null = null;
  for (const encoding of LEGACY) {
    const text = iconv.decode(buf, encoding);
    const bad = count(text, /�/g);
    const kana = count(text, /[぀-ヿ]/g);
    const hangul = count(text, /[가-힯]/g);
    const letters = count(text, /[A-Za-zÀ-ɏ]/g);
    // Chinese is recognised by its commonest characters; Japanese and Korean by their own
    // scripts; Western text by decoding cleanly into mostly letters.
    const score =
      encoding === 'windows-1252'
        ? bad === 0 && count(text, /[\u0080-\u009f]/g) === 0
          ? letters * 0.5
          : -1
        : encoding === 'shift_jis'
          ? kana * 2 - bad * 20
          : encoding === 'euc-kr'
            ? hangul - bad * 20
            : count(text, COMMON_ZH) * 3 - bad * 20 - kana * 2 - hangul;
    if (!best || score > best.score) best = { text, encoding, score };
  }
  const b = best as { text: string; encoding: string; score: number };
  return done(b.text, b.encoding, b.score > 5);
}

const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });
const toTwp = OpenCC.Converter({ from: 'cn', to: 'twp' });

/**
 * 'zh-Hant' | 'zh-Hans' | 'zh' (Chinese, script unclear) | 'en' | 'und', from the text itself:
 * provider labels are unreliable (Traditional releases are often filed under Simplified).
 */
export function detectLanguage(text: string): DetectedLang {
  const han = count(text, /[一-鿿]/g);
  const latin = count(text, /[A-Za-z]/g);
  if (han >= 20 && han * 4 >= latin) {
    // A character that changes when converted to the other script belongs to this one.
    const a = s2t(text);
    const b = t2s(text);
    let simplified = 0;
    let traditional = 0;
    for (let i = 0; i < text.length; i++) {
      if (a[i] !== text[i]) simplified++;
      if (b[i] !== text[i]) traditional++;
    }
    if (simplified >= 3 && simplified > traditional * 2) return 'zh-Hans';
    if (traditional >= 3 && traditional > simplified * 2) return 'zh-Hant';
    return 'zh';
  }
  if (latin >= 40 && count(text, /\b(the|you|and|that|what|is|it|to)\b/gi) >= 5) return 'en';
  return 'und';
}

/** Simplified → Traditional as written in Taiwan. 'twp' also swaps vocabulary (软件 → 軟體); 'tw' changes characters only. */
export function toTraditional(text: string, variant: 'twp' | 'tw' = 'twp'): string {
  return variant === 'twp' ? toTwp(text) : s2t(text);
}

/** The same conversion over a cue list: only the text changes, ids and times stay. */
export function cuesToTraditional(cues: readonly Cue[]): Cue[] {
  return cues.map((c) => ({ ...c, text: toTwp(c.text) }));
}

/**
 * ASS/SSA → plain cues. Dialogue events only; drawings and override tags dropped; \N and \n
 * become line breaks (D34).
 */
export function assToCues(text: string): RawCue[] {
  const time = (s: string) => {
    const m = s.trim().match(/^(\d+):(\d\d):(\d\d)[.:](\d\d)$/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : Number.NaN;
  };
  let format: string[] | null = null;
  const cues: RawCue[] = [];
  let inEvents = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      format = line
        .slice(7)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line) || !format) continue;
    // The text field is last and may itself contain commas.
    const parts = line.slice(9).split(',');
    const fields = parts.slice(0, format.length - 1).concat(parts.slice(format.length - 1).join(','));
    const f = format;
    const get = (name: string) => fields[f.indexOf(name)] ?? '';
    const body = get('text');
    if (/\{[^}]*\\p[1-9]/.test(body)) continue; // vector drawing, not dialogue
    const plain = body
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    const start = time(get('start'));
    const end = time(get('end'));
    if (!plain || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text: plain });
  }
  return cues;
}

/** 01:02:03,456 / 01:02:03.456 / 02:03.456 (WebVTT may leave out the hours). */
function timecode(s: string): number {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return Number.NaN;
  const frac = (m[4] as string).padEnd(3, '0');
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(frac) / 1000;
}

const ARROW = /^\s*(\S+)\s+-->\s+(\S+)/;

/** SubRip. Blocks separated by blank lines; the index line is optional; text is kept as written. */
export function parseSrt(text: string): RawCue[] {
  const out: RawCue[] = [];
  for (const block of text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0 || at > 1) continue;
    const m = ARROW.exec(lines[at] as string) as RegExpExecArray;
    const start = timecode(m[1] as string);
    const end = timecode(m[2] as string);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      start,
      end,
      text: lines
        .slice(at + 1)
        .join('\n')
        .trimEnd(),
    });
  }
  return out;
}

/** WebVTT. NOTE, STYLE and REGION blocks are skipped; cue settings after the end time are dropped. */
export function parseVtt(text: string): RawCue[] {
  const out: RawCue[] = [];
  const blocks = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0] ?? '') && !ARROW.test(lines[0] ?? '')) continue;
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0 || at > 1) continue;
    const m = ARROW.exec(lines[at] as string) as RegExpExecArray;
    const start = timecode(m[1] as string);
    const end = timecode(m[2] as string);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      start,
      end,
      text: lines
        .slice(at + 1)
        .join('\n')
        .trimEnd(),
    });
  }
  return out;
}

const ms = (v: number) => Math.round(v * 1000) / 1000;

/**
 * docs/07, step 6: line breaks are \n, text trimmed, empty cues dropped; negative times clamped to
 * 0; an end not after its start becomes start + 1 s; sorted by start and numbered 1..n (that
 * number is Cue.id). The words themselves are not touched (<i> and the like stay).
 */
export function normalizeCues(raw: readonly RawCue[]): Cue[] {
  const kept = raw
    .map((c, order) => {
      const start = ms(Math.max(0, c.start));
      let end = ms(Math.max(0, c.end));
      if (end <= start) end = ms(start + 1);
      return { start, end, text: c.text.replace(/\r\n?/g, '\n').trim(), order };
    })
    .filter((c) => c.text !== '');
  kept.sort((a, b) => a.start - b.start || a.order - b.order);
  return kept.map((c, i) => ({ id: i + 1, start: c.start, end: c.end, text: c.text }));
}

/** The format from the file name, then from the content when the name says nothing useful. */
export function formatOf(fileName: string, text: string): SubtitleFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'srt') return 'srt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'vtt') return 'vtt';
  const head = text.replace(/^﻿/, '').trimStart();
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\[Script Info\]/i.test(head) || /^Dialogue:/im.test(head)) return 'ass';
  if (ARROW.test(head.split('\n').slice(0, 3).join('\n'))) return 'srt';
  return null;
}

export type ParsedSubtitle = {
  cues: Cue[];
  format: SubtitleFormat;
  encoding: string;
  language: DetectedLang;
  /** Two scripts in one cue (Chinese and Latin lines), for the "bilingual" flag. */
  bilingual: boolean;
};

/** One subtitle file, whole way: decode, parse, normalize, detect. Null when no cue survives (PARSE_FAILED). */
export function parseSubtitleFile(fileName: string, bytes: Buffer): ParsedSubtitle | null {
  const decoded = decodeSubtitle(bytes);
  const format = formatOf(fileName, decoded.text);
  if (!format) return null;
  const raw =
    format === 'ass' ? assToCues(decoded.text) : format === 'vtt' ? parseVtt(decoded.text) : parseSrt(decoded.text);
  const cues = normalizeCues(raw);
  if (cues.length === 0) return null;
  const all = cues.map((c) => c.text).join('\n');
  const both = cues.filter((c) => /[一-鿿]/.test(c.text) && /[A-Za-z]{3,}/.test(c.text)).length;
  return {
    cues,
    format,
    encoding: decoded.encoding,
    language: detectLanguage(all),
    bilingual: both >= Math.max(3, cues.length / 3),
  };
}
