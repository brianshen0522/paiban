/**
 * Removes `<…>` and `{…}` spans from subtitle text, each replaced by `put`. An opener with no closer
 * after it stays as it is. Written out because subtitle files are untrusted: a regular expression
 * like `\{[^}]*\}` starts over at every `{` and takes minutes on one long line of them.
 */
export function dropSpans(text: string, pairs: Record<string, string>, put = ''): string {
  const unclosed = new Set<string>();
  let out = '';
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    const closer = pairs[text[i] as string];
    if (!closer || unclosed.has(closer)) continue;
    const end = text.indexOf(closer, i + 1);
    if (end < 0) {
      unclosed.add(closer);
      continue;
    }
    out += text.slice(copied, i) + put;
    copied = end + 1;
    i = end;
  }
  return out + text.slice(copied);
}
