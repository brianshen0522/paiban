// Reference for the text side of subtitle intake. Verified against ../../fixtures.
//
// Order of work for every subtitle file, whatever its source:
//   bytes -> decodeSubtitle -> (ASS: assToCues | SRT/VTT: a parser) -> detectLanguage
//         -> optionally toTraditional -> store as UTF-8, LF line endings, no BOM.
import iconv from 'iconv-lite';
import * as OpenCC from 'opencc-js';

const LEGACY = ['big5', 'gb18030', 'shift_jis', 'euc-kr', 'windows-1252'];
// Characters that are very frequent in Chinese dialogue, in both scripts. A wrong decoding still
// yields valid-looking CJK, but almost none of these.
const COMMON_ZH = /[的是不了我你在有這这他們们來来個个嗎吗]/g;
const count = (s, re) => (s.match(re) || []).length;

/**
 * Bytes of a subtitle file -> text. Byte-order marks first, then strict UTF-8, then the legacy
 * encoding whose decoding looks most like language. Returns { text, encoding, confident }.
 */
export function decodeSubtitle(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return done(buf.subarray(3).toString('utf8'), 'utf-8', true);
  if (buf[0] === 0xff && buf[1] === 0xfe) return done(iconv.decode(buf.subarray(2), 'utf16le'), 'utf-16le', true);
  if (buf[0] === 0xfe && buf[1] === 0xff) return done(iconv.decode(buf.subarray(2), 'utf16be'), 'utf-16be', true);
  try {
    return done(new TextDecoder('utf-8', { fatal: true }).decode(buf), 'utf-8', true);
  } catch {
    /* not UTF-8 */
  }
  let best = null;
  for (const encoding of LEGACY) {
    const text = iconv.decode(buf, encoding);
    const bad = count(text, /�/g);
    const kana = count(text, /[぀-ヿ]/g);
    const hangul = count(text, /[가-힯]/g);
    const letters = count(text, /[A-Za-zÀ-ɏ]/g);
    // Chinese is recognised by its commonest characters; Japanese and Korean by their own
    // scripts; Western text by decoding cleanly into mostly letters.
    const score = encoding === 'windows-1252'
      ? (bad === 0 && count(text, /[\u0080-\u009f]/g) === 0 ? letters * 0.5 : -1)
      : encoding === 'shift_jis' ? kana * 2 - bad * 20
      : encoding === 'euc-kr' ? hangul - bad * 20
      : count(text, COMMON_ZH) * 3 - bad * 20 - kana * 2 - hangul;
    if (!best || score > best.score) best = { text, encoding, score };
  }
  return done(best.text, best.encoding, best.score > 5);
}
function done(text, encoding, confident) {
  return { text: text.replace(/\r\n?/g, '\n'), encoding, confident };
}

const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

/**
 * 'zh-Hant' | 'zh-Hans' | 'zh' (Chinese, script unclear) | 'en' | 'und'.
 * Decided from the text itself: provider language labels are unreliable (Traditional releases
 * are often filed under Simplified).
 */
export function detectLanguage(text) {
  const han = count(text, /[一-鿿]/g);
  const latin = count(text, /[A-Za-z]/g);
  if (han >= 20 && han * 4 >= latin) {
    // A character that changes when converted to the other script belongs to this one.
    const a = s2t(text), b = t2s(text);
    let simplified = 0, traditional = 0;
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

/** Simplified -> Traditional as written in Taiwan. 'twp' also swaps vocabulary (软件 -> 軟體); 'tw' changes characters only. */
export function toTraditional(text, variant = 'twp') {
  return OpenCC.Converter({ from: 'cn', to: variant })(text);
}

/**
 * ASS/SSA -> plain cues. Keeps Dialogue events only, drops drawings and override tags, turns
 * \N and \n into line breaks. Styles, positions and karaoke are lost: the app syncs and exports
 * plain text unless the "keep ASS styling" option is built (docs/09-sync-workbench.md).
 */
export function assToCues(text) {
  const time = (s) => {
    const m = s.trim().match(/^(\d+):(\d\d):(\d\d)[.:](\d\d)$/);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100 : NaN;
  };
  let format = null;
  const cues = [];
  let inEvents = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) { format = line.slice(7).split(',').map((f) => f.trim().toLowerCase()); continue; }
    if (!/^Dialogue:/i.test(line) || !format) continue;
    // The text field is last and may itself contain commas.
    const parts = line.slice(9).split(',');
    const fields = parts.slice(0, format.length - 1).concat(parts.slice(format.length - 1).join(','));
    const get = (name) => fields[format.indexOf(name)] ?? '';
    const body = get('text');
    if (/\{[^}]*\\p[1-9]/.test(body)) continue;                       // vector drawing, not dialogue
    const plain = body.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    const start = time(get('start')), end = time(get('end'));
    if (!plain || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text: plain });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues.map((c, i) => ({ id: i + 1, ...c }));
}
