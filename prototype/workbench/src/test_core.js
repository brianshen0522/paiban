const Core = require('./core.js'), SC = require('./scenarios.js'), data = require('./data.json');
const sp = Core.makeSpeech(data), truth = data.cues;
const doc0 = () => ({ segments: [{ from: 0, scale: 1, offset: 0 }], edits: {} });
const err = (mapped) => { const e = mapped.map((c, i) => Math.abs(c.start - truth[i].start)).sort((a, b) => a - b); return `median ${(e[e.length >> 1] * 1000).toFixed(0)} ms, max ${(e[e.length - 1] * 1000).toFixed(0)} ms`; };
console.log('correct subtitle score', (Core.totalScore(sp, Core.mapCues(truth, doc0())) * 100).toFixed(0) + '%');
for (const sc of SC) {
  const base = truth.map((c, i) => ({ ...c, start: sc.f(c.start, i), end: sc.f(c.end, i) }));
  const before = Core.totalScore(sp, Core.mapCues(base, doc0()));
  for (const allowSplit of [false, true]) {
    const t0 = Date.now(), r = Core.autoAlign(sp, base, { allowSplit, radius: 30 }), ms = Date.now() - t0;
    const mapped = Core.mapCues(base, { segments: r.segments, edits: {} });
    console.log(`${sc.id.padEnd(5)} split=${String(allowSplit).padEnd(5)} ${(before * 100).toFixed(0)}% -> ${(Core.totalScore(sp, mapped) * 100).toFixed(0)}% | ` +
      r.segments.map(s => `from cue ${s.from + 1}: x${s.scale.toFixed(4)} ${Core.signed(s.offset, 2)}s`).join(' ; ') + ` | ${err(mapped)} | ${ms} ms`);
  }
}
// two pins far apart should recover a frame-rate mismatch
const rate = truth.map((c, i) => ({ ...c, start: SC[1].f(c.start, i), end: SC[1].f(c.end, i) }));
const fit = Core.fitAnchors(rate, { scale: 1, offset: 0 }, [{ cue: 1, t: truth[1].start }, { cue: 24, t: truth[24].start }]);
console.log('two pins ->', fit.scale.toFixed(5), fit.offset, '(expected', (25 / 23.976).toFixed(5), (-0.8 * 25 / 23.976).toFixed(3) + ')');
console.log('checkpoints:', Core.pickCheckpoints(truth, 5).map(c => c.cue + 1).join(', '));
console.log(Core.toSrt(Core.mapCues(truth, doc0()).slice(0, 2), true));
