import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhTW } from './zh-TW';

const CJK = /[　-〿㐀-鿿＀-￯]/;
// The language switch names each language in its own words on purpose.
const ALLOWED_CJK = ['locale.names', 'locale.short'];

/** Every string reachable from `node`, with functions called on sample arguments (strings, which every sentence also accepts as numbers), keyed by path. */
function strings(node: unknown, path: string, out: [string, string][]): [string, string][] {
  if (typeof node === 'string') {
    out.push([path, node]);
  } else if (typeof node === 'function') {
    for (const sample of ['2', '1', '0', '']) {
      const args = Array.from({ length: node.length }, () => sample);
      strings((node as (...a: unknown[]) => unknown)(...args), path, out);
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function keyPaths(node: unknown, path: string, out: string[]): string[] {
  if (node && typeof node === 'object' && typeof node !== 'function') {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      out.push(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

describe('English copy', () => {
  it('has no Chinese left, outside the language names', () => {
    const left = strings(en, '', []).filter(([path, s]) => CJK.test(s) && !ALLOWED_CJK.some((a) => path.startsWith(a)));
    expect(left).toEqual([]);
  });

  it('has every key the Traditional Chinese copy has', () => {
    const mine = new Set(keyPaths(en, '', []));
    expect(keyPaths(zhTW, '', []).filter((p) => !mine.has(p))).toEqual([]);
  });
});
