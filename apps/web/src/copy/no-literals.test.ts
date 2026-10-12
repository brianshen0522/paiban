import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AGENTS.md, "Language": components hold no strings in any language; every word and every piece
 * of Chinese punctuation comes from the copy files, so the English interface gets its own
 * (2026-10-12: a hard-coded "：" and "（…）" showed up in English).
 */
const SRC = join(import.meta.dirname, '..');
const CJK = /[　-〿㐀-鿿＀-￯]/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'copy' ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('component code', () => {
  it('has no Chinese characters or full-width punctuation outside comments', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/.*$/gm, '');
      for (const [i, line] of code.split('\n').entries())
        if (CJK.test(line)) found.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`);
    }
    expect(found).toEqual([]);
  });
});
