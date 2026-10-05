// npm ci && npm test        (needs iconv-lite and opencc-js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeSubtitle, detectLanguage, toTraditional, assToCues } from './text.mjs';

const FIX = new URL('../../fixtures/', import.meta.url);
const bytes = (p) => fs.readFileSync(new URL(p, FIX));
const utf8 = (p) => fs.readFileSync(new URL(p, FIX), 'utf8');

test('encodings are recognised and decode to the same text', () => {
  const traditional = utf8('late.zh-TW.srt');
  for (const [file, encoding, expected] of [
    ['late.zh-TW.srt', 'utf-8', traditional],
    ['late.zh-TW.big5.srt', 'big5', traditional],
    ['late.zh-TW.utf16le-bom.srt', 'utf-16le', traditional],
    ['late.zh-CN.gb18030.srt', 'gb18030', utf8('late.zh-CN.srt')],
    ['truth.en.srt', 'utf-8', utf8('truth.en.srt')],
  ]) {
    const d = decodeSubtitle(bytes(file));
    assert.equal(d.encoding, encoding, file);
    assert.equal(d.text, expected, file);
    assert.equal(d.confident, true, file);
  }
});

test('Western legacy text is not mistaken for Chinese', () => {
  const french = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nÇa va très bien, merci. Où est le café déjà ?\n', 'latin1');
  assert.equal(decodeSubtitle(french).encoding, 'windows-1252');
  assert.match(decodeSubtitle(french).text, /Ça va très bien/);
});

test('language and script come from the content', () => {
  assert.equal(detectLanguage(utf8('late.zh-TW.srt')), 'zh-Hant');
  assert.equal(detectLanguage(utf8('late.zh-CN.srt')), 'zh-Hans');
  assert.equal(detectLanguage(utf8('truth.en.srt')), 'en');
  assert.equal(detectLanguage('1\n00:00:01,000 --> 00:00:02,000\n...\n'), 'und');
});

test('Simplified converts to the Traditional text people in Taiwan expect', () => {
  assert.equal(toTraditional(utf8('late.zh-CN.srt')), utf8('late.zh-CN.to-zh-TW.expected.srt'));
  assert.equal(toTraditional('这个软件的鼠标有问题'), '這個軟體的滑鼠有問題');
  assert.equal(toTraditional('这个软件的鼠标有问题', 'tw'), '這個軟件的鼠標有問題');
});

test('ASS becomes plain cues: drawings, comments and tags are dropped', () => {
  const cues = assToCues(decodeSubtitle(bytes('late.bilingual.ass')).text);
  assert.equal(cues.length, 26);
  assert.equal(cues[0].text, '你進來之後有把門鎖上嗎?\nDid you lock the door behind you?');
  assert.ok(Math.abs(cues[0].start - 5.35) < 0.011 && Math.abs(cues[0].end - 7.636) < 0.011, 'times survive at centisecond precision');
  assert.deepEqual(cues.map((c) => c.id), Array.from({ length: 26 }, (_, i) => i + 1));
});
