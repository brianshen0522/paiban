// Writes the Simplified Chinese copy of late.zh-TW.srt and what converting it back should give.
// Uses the opencc-js that reference/subtitles installs (the same library the app uses):
//
//   (cd ../reference/subtitles && npm ci) && node make_simplified.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';

const here = (name) => new URL(name, import.meta.url);
const OpenCC = createRequire(here('../reference/subtitles/'))('opencc-js');

const tw = fs.readFileSync(here('late.zh-TW.srt'), 'utf8');
const cn = OpenCC.Converter({ from: 'tw', to: 'cn' })(tw);
fs.writeFileSync(here('late.zh-CN.srt'), cn);
fs.writeFileSync(here('late.zh-CN.to-zh-TW.expected.srt'), OpenCC.Converter({ from: 'cn', to: 'twp' })(cn));
console.log('round trip identical to the original:', OpenCC.Converter({ from: 'cn', to: 'twp' })(cn) === tw);
