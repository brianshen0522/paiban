/* Pure sync logic: no DOM. Shared by the page and by the Node test. */
(function (root) {
  'use strict';

  // Subtitle-speed corrections that actually occur between releases of the same film.
  // Subtitle-speed corrections that actually occur between releases of the same film,
  // most common first: when two fit a short clip equally well, the commoner one wins.
  var RATES = [
    { id: 'same', label: '不變', scale: 1 },
    { id: '25to23', label: '字幕 25 fps → 影片 23.976', scale: 25 / 23.976 },
    { id: '23to25', label: '字幕 23.976 → 影片 25 fps', scale: 23.976 / 25 },
    { id: '24to23', label: '字幕 24 fps → 影片 23.976', scale: 24 / 23.976 },
    { id: '23to24', label: '字幕 23.976 → 影片 24 fps', scale: 23.976 / 24 },
    { id: '25to24', label: '字幕 25 fps → 影片 24', scale: 25 / 24 },
    { id: '24to25', label: '字幕 24 fps → 影片 25', scale: 24 / 25 }
  ];

  function makeSpeech(data) {
    var n = data.speechFrames, hz = data.speechHz, bits = new Uint8Array(n), pre = new Uint32Array(n + 1), i;
    data.speech.forEach(function (s) { bits.fill(1, s[0], s[1]); });
    for (i = 0; i < n; i++) pre[i + 1] = pre[i] + bits[i];
    return { n: n, hz: hz, bits: bits, pre: pre, segs: data.speech.map(function (s) { return [s[0] / hz, s[1] / hz]; }) };
  }

  // Number of 10 ms speech frames inside [a, b) seconds.
  function overlap(sp, a, b) {
    var i = Math.round(a * sp.hz), j = Math.round(b * sp.hz);
    if (i < 0) i = 0;
    if (j > sp.n) j = sp.n;
    return j > i ? sp.pre[j] - sp.pre[i] : 0;
  }

  function segIndex(doc, i) {
    var k = 0, s;
    for (s = 0; s < doc.segments.length; s++) if (doc.segments[s].from <= i) k = s;
    return k;
  }

  // Apply the sync document to the untouched subtitle. Per-line edits are stored
  // as deltas so they keep travelling with their segment when it is shifted.
  function mapCues(base, doc) {
    return base.map(function (c, i) {
      var k = segIndex(doc, i), seg = doc.segments[k], e = doc.edits[c.id] || {};
      var start = c.start * seg.scale + seg.offset + (e.dStart || 0);
      var end = c.end * seg.scale + seg.offset + (e.dEnd || 0);
      if (end < start + 0.2) end = start + 0.2;
      return { i: i, id: c.id, start: start, end: end, zh: e.zh != null ? e.zh : c.zh, en: c.en, seg: k,
        deleted: !!e.deleted, edited: !!(e.dStart || e.dEnd || e.zh != null) };
    });
  }

  function cueScore(sp, c) {
    var len = Math.max(1, Math.round((c.end - c.start) * sp.hz));
    return overlap(sp, c.start, c.end) / len;
  }

  function totalScore(sp, mapped) {
    var ov = 0, len = 0;
    mapped.forEach(function (c) {
      if (c.deleted) return;
      ov += overlap(sp, c.start, c.end);
      len += Math.max(1, Math.round((c.end - c.start) * sp.hz));
    });
    return len ? ov / len : 0;
  }

  // gain[k][o] = how well the first k cues fit at offset o (cumulative over cues),
  // for one speed. A cue earns its overlap with speech and loses half of any speech
  // in the 0.3 s just before it starts, which is what a late cue looks like.
  function gainTable(sp, base, idxs, scale, lo, step, count) {
    var rows = [new Float32Array(count)], k, o, prev, cur, a, b, off;
    for (k = 0; k < idxs.length; k++) {
      prev = rows[k]; cur = new Float32Array(count);
      a = base[idxs[k]].start * scale; b = base[idxs[k]].end * scale;
      for (o = 0; o < count; o++) {
        off = lo + o * step;
        cur[o] = prev[o] + overlap(sp, a + off, b + off) - 0.5 * overlap(sp, a + off - 0.3, a + off);
      }
      rows.push(cur);
    }
    return rows;
  }

  // Ties go to the later offset: a cue that could sit anywhere over a shorter
  // utterance should start with it and linger, not start early.
  function argmaxRange(top, bottom, count) {
    var best = -Infinity, at = 0, o, v;
    for (o = 0; o < count; o++) {
      v = top[o] - (bottom ? bottom[o] : 0);
      if (v >= best - 1e-6) { if (v > best) best = v; at = o; }
    }
    return { J: best, o: at };
  }

  // Linear fit for one run of cues, searched around a centre offset.
  function bestLinear(sp, base, idxs, scales, centre, radius, step) {
    var count = Math.round(2 * radius / step) + 1, lo = centre - radius, best = null;
    scales.forEach(function (s) {
      var rows = gainTable(sp, base, idxs, s, lo, step, count);
      var m = argmaxRange(rows[idxs.length], null, count);
      if (!best || m.J > best.J + 1e-6) best = { J: m.J, scale: s, offset: lo + m.o * step };
    });
    return best;
  }

  // Whole-subtitle alignment: every known speed, any offset within the radius, and
  // optionally one break where the offset changes (a scene the subtitle's cut lacks).
  function autoAlign(sp, base, opts) {
    var radius = opts.radius || 30, step = 0.01, count = Math.round(2 * radius / step) + 1, lo = -radius;
    var idxs = base.map(function (_, i) { return i; }), n = idxs.length;
    var penalty = (opts.splitPenalty != null ? opts.splitPenalty : 3) * sp.hz;
    var best = null, cands = [];
    RATES.forEach(function (r) {
      var rows = gainTable(sp, base, idxs, r.scale, lo, step, count);
      var whole = argmaxRange(rows[n], null, count);
      var cand = { J: whole.J, segments: [{ from: 0, scale: r.scale, offset: lo + whole.o * step }] };
      if (opts.allowSplit && n >= 8) {
        var k, L, R;
        for (k = 3; k <= n - 3; k++) {
          L = argmaxRange(rows[k], null, count);
          R = argmaxRange(rows[n], rows[k], count);
          if (L.J + R.J - penalty > cand.J && Math.abs(L.o - R.o) * step > 0.3) {
            cand = { J: L.J + R.J - penalty, segments: [
              { from: 0, scale: r.scale, offset: lo + L.o * step },
              { from: k, scale: r.scale, offset: lo + R.o * step }] };
          }
        }
      }
      cands.push(cand);
    });
    // A speed has to beat a commoner one by a clear margin (0.3 s of dialogue) to be chosen.
    var top = Math.max.apply(null, cands.map(function (c) { return c.J; }));
    best = cands.filter(function (c) { return c.J >= top - 0.3 * sp.hz; })[0];
    best.segments.forEach(function (s) { s.offset = Math.round(s.offset * 1000) / 1000; });
    return best;
  }

  // "This line belongs here": one pin sets the offset, two or more also set the speed.
  function fitAnchors(base, seg, anchors) {
    var n = anchors.length, sx = 0, sy = 0, sxx = 0, sxy = 0, scale = seg.scale, offset, i, x, y;
    if (!n) return { scale: seg.scale, offset: seg.offset };
    for (i = 0; i < n; i++) { x = base[anchors[i].cue].start; y = anchors[i].t; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    if (n >= 2 && n * sxx - sx * sx > 1) {
      scale = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      var near = RATES.slice().sort(function (a, b) { return Math.abs(scale - a.scale) - Math.abs(scale - b.scale); })[0];
      if (Math.abs(scale - near.scale) < 0.002) scale = near.scale;
      if (scale < 0.9 || scale > 1.1) scale = seg.scale;
    }
    offset = (sy - scale * sx) / n;
    return { scale: scale, offset: Math.round(offset * 1000) / 1000 };
  }

  // Lines worth checking by ear: spread over the film, each after a clear pause.
  function pickCheckpoints(base, count) {
    var n = base.length, out = [], used = {}, c, target, bestI, bestV, i, gap, v;
    for (c = 0; c < count; c++) {
      target = Math.round((n - 1) * (0.04 + 0.92 * c / (count - 1)));
      bestI = target; bestV = -Infinity;
      for (i = Math.max(0, target - 2); i <= Math.min(n - 1, target + 2); i++) {
        if (used[i]) continue;
        gap = i ? base[i].start - base[i - 1].end : 3;
        v = Math.min(gap, 3) + Math.min(base[i].end - base[i].start, 2.5) * 0.4 - Math.abs(i - target) * 0.3;
        if (v > bestV) { bestV = v; bestI = i; }
      }
      used[bestI] = true;
      out.push({ cue: bestI, status: 'todo' });
    }
    return out.sort(function (a, b) { return a.cue - b.cue; });
  }

  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function tc(t, sep) {
    var neg = t < 0, ms = Math.round(Math.abs(t) * 1000);
    var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return (neg ? '-' : '') + pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + (sep || ',') + pad(ms % 1000, 3);
  }
  function shortTc(t) {
    var neg = t < 0, ms = Math.round(Math.abs(t) * 1000);
    return (neg ? '-' : '') + pad(Math.floor(ms / 60000), 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + '.' + pad(ms % 1000, 3);
  }
  function signed(v, digits) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits); }

  function toSrt(mapped, bilingual) {
    var n = 0;
    return mapped.filter(function (c) { return !c.deleted; }).map(function (c) {
      n += 1;
      return n + '\n' + tc(Math.max(0, c.start)) + ' --> ' + tc(Math.max(0, c.end)) + '\n' + c.zh + (bilingual ? '\n' + c.en : '') + '\n';
    }).join('\n');
  }

  var api = { RATES: RATES, makeSpeech: makeSpeech, overlap: overlap, segIndex: segIndex, mapCues: mapCues, cueScore: cueScore,
    totalScore: totalScore, bestLinear: bestLinear, autoAlign: autoAlign, fitAnchors: fitAnchors, pickCheckpoints: pickCheckpoints,
    tc: tc, shortTc: shortTc, signed: signed, toSrt: toSrt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : this);
