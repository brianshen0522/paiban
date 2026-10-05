(function () {
  'use strict';
  const D = window.DEMO, C = window.Core, SC = window.SCENARIOS;
  const sp = C.makeSpeech(D), truth = D.cues, DUR = D.duration, PPS = D.peaksPerSec;
  const $ = (id) => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), listEl = $('list'), tl = $('tl'), ov = $('overview'), logEl = $('log');
  const peaks = (() => { const bin = atob(D.peaks), a = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; })();
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const pct = (v) => Math.round(v * 100) + '%';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const IDENTITY = { segments: [{ from: 0, scale: 1, offset: 0 }], edits: {} };

  // timeline geometry (CSS px)
  const WAVE_Y = 22, WAVE_H = 58, SP_Y = 88, SP_H = 10, LANE_Y = 112, LANE_H = 40;

  const st = { scenario: null, base: [], doc: null, cps: [], history: [], future: [], sel: 0, cpCur: -1, mode: 'sync', bilingual: false,
    showOrig: false, confirmed: false, query: '', mapped: [], orig: [], score: 0, now: -1 };
  const view = { t0: 0, dur: DUR };
  let K = {}, dirty = true, range = null, drag = null, shownCue = -2, lastT = -1, lastPlaying = null, textSession = false;

  /* ---------- media clock: the video when it loads, a silent timer when it cannot ---------- */
  const clock = (() => {
    let fake = false, t = 0, playing = false, last = 0, rate = 1;
    // The clip is tried as a file next to the page, then as the copy embedded in the page.
    const sources = ['clip.mp4', window.CLIP]; let tried = 0;
    const useFake = () => { if (fake) return; fake = true; t = 0; $('media-tag').textContent = '無聲模式:影片無法載入'; dirty = true; };
    const nextSource = () => { tried += 1; if (tried < sources.length) { video.src = sources[tried]; video.load(); } else useFake(); };
    video.addEventListener('error', nextSource);
    const api = {
      start() { video.src = sources[0]; },
      get t() {
        if (!fake) return video.currentTime;
        if (playing) { const n = performance.now(); t = Math.min(DUR, t + (n - last) / 1000 * rate); last = n; if (t >= DUR) playing = false; }
        return t;
      },
      get playing() { return fake ? playing : !video.paused && !video.ended; },
      play() {
        if (fake) { if (t >= DUR - 0.05) t = 0; playing = true; last = performance.now(); return; }
        const p = video.play();
        if (p && p.catch) p.catch((err) => { if (err && err.name === 'NotSupportedError' && tried >= sources.length - 1) { useFake(); api.play(); } });
      },
      pause() { if (fake) playing = false; else video.pause(); },
      seek(x) { x = Math.max(0, Math.min(DUR - 0.05, x)); if (fake) { t = x; last = performance.now(); } else video.currentTime = x; dirty = true; },
      setRate(r) { rate = r; video.playbackRate = r; }
    };
    return api;
  })();

  /* ---------- state helpers ---------- */
  const activeSeg = () => C.segIndex(st.doc, st.sel);
  const segRange = (k) => [st.doc.segments[k].from, k + 1 < st.doc.segments.length ? st.doc.segments[k + 1].from : st.base.length];
  const snapshot = () => JSON.stringify({ doc: st.doc, cps: st.cps });
  const commit = () => { st.history.push(snapshot()); if (st.history.length > 100) st.history.shift(); st.future = []; };
  const restore = (s) => { const o = JSON.parse(s); st.doc = o.doc; st.cps = o.cps; };
  const clearAnchors = (k) => { st.doc.anchors = st.doc.anchors.filter((a) => C.segIndex(st.doc, a.cue) !== k); };
  // A timing change invalidates what was checked by ear in that part of the film.
  const changed = (k) => {
    const r = k == null ? [0, st.base.length] : segRange(k);
    st.cps.forEach((c) => { if (c.cue >= r[0] && c.cue < r[1]) c.status = 'todo'; });
    st.confirmed = false;
  };
  const cueClass = (v) => (v >= 0.5 ? 'good' : v >= 0.25 ? 'warn' : 'bad');

  function loadScenario(id) {
    const sc = SC.filter((s) => s.id === id)[0];
    st.scenario = sc;
    st.base = truth.map((c, i) => ({ id: c.id, start: sc.f(c.start, i), end: sc.f(c.end, i), zh: c.zh, en: c.en }));
    st.doc = { segments: [{ from: 0, scale: 1, offset: 0 }], edits: {}, anchors: [] };
    st.cps = C.pickCheckpoints(st.base, 5);
    st.history = []; st.future = []; st.sel = 0; st.cpCur = -1; st.confirmed = false; range = null;
    $('hint-title').textContent = sc.label + '。';
    $('hint').textContent = sc.hint;
    $('summary').hidden = true;
  }

  function recompute() {
    st.mapped = C.mapCues(st.base, st.doc);
    st.orig = C.mapCues(st.base, IDENTITY);
    st.score = C.totalScore(sp, st.mapped);
  }
  function refresh() { recompute(); renderList(); renderTools(); renderStatus(); shownCue = -2; updateOverlay(); dirty = true; }

  function say(text, actions) {
    logEl.textContent = '';
    const line = el('span');
    text.split('*').forEach((part, i) => { if (part) line.appendChild(i % 2 ? el('b', '', part) : document.createTextNode(part)); });
    logEl.appendChild(line);
    (actions || []).forEach((a) => { const b = el('button', '', a.label); b.type = 'button'; b.addEventListener('click', a.run); logEl.appendChild(b); });
  }

  /* ---------- line list ---------- */
  function rowActions(m) {
    const box = el('div', 'row-extra');
    [['playline', '播放這句'], ['anchor', '對到現在'], ['split', '從這句分段']].forEach(([act, label]) => {
      const b = el('button', '', label); b.type = 'button'; b.dataset.act = act; box.appendChild(b);
    });
    return box;
  }
  function rowEditor(m) {
    const box = el('div', 'row-extra');
    const ta = el('textarea'); ta.id = 'edit-text'; ta.rows = 2; ta.value = m.zh; ta.setAttribute('aria-label', '第 ' + (m.i + 1) + ' 句的文字');
    box.appendChild(ta);
    [['開始', 's'], ['結束', 'e']].forEach(([label, side]) => {
      const g = el('span', 'grp', label);
      [['-', '−50'], ['+', '+50'], ['=', '設為現在']].forEach(([op, text]) => { const b = el('button', '', text); b.type = 'button'; b.dataset.ed = side + op; g.appendChild(b); });
      box.appendChild(g);
    });
    const del = el('button', '', m.deleted ? '還原這句' : '刪除這句'); del.type = 'button'; del.dataset.ed = 'del'; box.appendChild(del);
    const play = el('button', '', '播放這句'); play.type = 'button'; play.dataset.act = 'playline'; box.appendChild(play);
    return box;
  }
  function renderList() {
    const q = st.query.trim().toLowerCase(), frag = document.createDocumentFragment(), cues = st.showOrig ? st.orig : st.mapped;
    let shown = 0;
    cues.forEach((c) => {
      const m = st.mapped[c.i];
      if (q && (m.zh + ' ' + m.en).toLowerCase().indexOf(q) < 0) return;
      shown += 1;
      const li = el('li', 'row' + (c.i === st.sel ? ' sel' : '') + (c.i === st.now ? ' now' : '') + (m.deleted ? ' del' : ''));
      li.dataset.i = c.i;
      li.appendChild(el('span', 'n mono', String(c.i + 1)));
      const t = el('button', 't mono', C.shortTc(c.start)); t.type = 'button'; t.title = '跳到這句'; t.dataset.seek = '1'; li.appendChild(t);
      const x = el('span', 'x', m.zh); if (st.bilingual) x.appendChild(el('small', '', m.en)); li.appendChild(x);
      const v = C.cueScore(sp, c), d = el('i', 'dot ' + cueClass(v)); d.title = '與人聲重疊 ' + pct(v); li.appendChild(d);
      if (c.i === st.sel) li.appendChild(st.mode === 'edit' ? rowEditor(m) : rowActions(m));
      frag.appendChild(li);
    });
    listEl.textContent = '';
    if (shown) listEl.appendChild(frag); else listEl.appendChild(el('li', 'empty', '找不到含有「' + st.query + '」的台詞。'));
  }
  function revealRow(i) {
    const row = listEl.querySelector('.row[data-i="' + i + '"]');
    if (!row) return;
    const r = row.getBoundingClientRect(), L = listEl.getBoundingClientRect();
    if (r.top < L.top) listEl.scrollTop -= L.top - r.top + 8; else if (r.bottom > L.bottom) listEl.scrollTop += r.bottom - L.bottom + 8;
  }
  function select(i, reveal) { st.sel = i; renderList(); renderTools(); dirty = true; if (reveal) revealRow(i); }
  function setNow(i) {
    if (i === st.now) return;
    const old = listEl.querySelector('.row.now'); if (old) old.classList.remove('now');
    st.now = i;
    const cur = i >= 0 ? listEl.querySelector('.row[data-i="' + i + '"]') : null;
    if (cur) { cur.classList.add('now'); if (clock.playing && !listEl.contains(document.activeElement)) revealRow(i); }
  }

  /* ---------- tool readouts ---------- */
  function renderTools() {
    const k = activeSeg(), seg = st.doc.segments[k], multi = st.doc.segments.length > 1, r = segRange(k);
    $('scope').textContent = multi ? '第 ' + (k + 1) + ' 段,第 ' + (r[0] + 1) + '–' + r[1] + ' 句' : '全片';
    if (document.activeElement !== $('offset')) $('offset').value = seg.offset.toFixed(2);
    const sel = $('rate'); sel.textContent = '';
    let matched = false;
    C.RATES.forEach((x) => {
      const o = new Option(x.label + (x.scale === 1 ? '' : '(×' + x.scale.toFixed(4) + ')'), x.id);
      if (Math.abs(x.scale - seg.scale) < 1e-6) { o.selected = true; matched = true; }
      sel.add(o);
    });
    if (!matched) { const o = new Option('自訂(×' + seg.scale.toFixed(4) + ')', 'custom'); o.selected = true; sel.add(o); }

    const segs = $('segs'); segs.textContent = '';
    if (multi) st.doc.segments.forEach((s, j) => {
      const rr = segRange(j);
      segs.appendChild(el('span', 'chip ' + 'abc'[j % 3] + (j === k ? ' cur' : ''), '第 ' + (rr[0] + 1) + '–' + rr[1] + ' 句 ' + C.signed(s.offset, 2) + ' 秒'));
    });
    $('merge').hidden = !(multi && k > 0);
    const n = st.doc.anchors.filter((a) => C.segIndex(st.doc, a.cue) === k).length;
    $('anchor-note').textContent = n >= 2 ? '這一段有 ' + n + ' 個對齊點,速率由它們算出。'
      : n === 1 ? '這一段有 1 個對齊點。再對一句相隔遠的,就能一併算出速率。'
      : '暫停在某句開口的瞬間,選取那句,再按「對到現在」。';

    const dots = $('cp-dots'); dots.textContent = '';
    st.cps.forEach((c, j) => {
      const b = el('button', (c.status === 'ok' ? 'ok' : c.status === 'bad' ? 'bad' : '') + (j === st.cpCur ? ' cur' : ''), String(j + 1));
      b.type = 'button'; b.dataset.cp = j;
      b.setAttribute('aria-label', '檢查點 ' + (j + 1) + ',第 ' + (c.cue + 1) + ' 句,' + (c.status === 'ok' ? '已確認' : c.status === 'bad' ? '不準' : '還沒聽'));
      dots.appendChild(b);
    });
    const s = $('score'); s.textContent = pct(st.score); s.className = st.score >= 0.7 ? 'good' : st.score >= 0.55 ? 'warn' : 'bad';
  }
  function renderStatus() {
    const p = $('status'); p.textContent = st.confirmed ? '已確認' : '草稿'; p.className = 'pill' + (st.confirmed ? ' done' : '');
    if (!st.confirmed) $('summary').hidden = true;
  }

  /* ---------- subtitle over the picture ---------- */
  function updateOverlay() {
    const t = clock.t, cues = st.showOrig ? st.orig : st.mapped;
    let cur = -1;
    for (let i = 0; i < cues.length; i++) if (!st.mapped[i].deleted && t >= cues[i].start && t < cues[i].end) { cur = i; break; }
    if (cur !== shownCue) {
      overlay.textContent = '';
      if (cur >= 0) { overlay.appendChild(document.createTextNode(st.mapped[cur].zh)); if (st.bilingual) overlay.appendChild(el('span', 'en', st.mapped[cur].en)); }
      shownCue = cur;
    }
    setNow(cur);
  }

  /* ---------- canvases ---------- */
  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    K = { line: v('--line'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), panel2: v('--panel-2'), wave: v('--wave'), speech: v('--speech'),
      segs: [v('--seg-a'), v('--seg-b'), v('--seg-c')], good: v('--good'), warn: v('--warn'), bad: v('--bad'), playhead: v('--playhead'),
      accent: v('--accent-fill'), accentInk: v('--accent-ink'), ui: getComputedStyle(document.body).fontFamily, mono: v('--font-mono') };
    dirty = true;
  }
  function fit(c) {
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }
  function box(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function tick(t) { const m = Math.floor(t / 60), s = t - m * 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + (Number.isInteger(s) ? s : s.toFixed(1)); }

  function drawTimeline() {
    const { g, w: W, h: H } = fit(tl), pps = W / view.dur, t0 = view.t0, t1 = t0 + view.dur, cues = st.showOrig ? st.orig : st.mapped;
    g.clearRect(0, 0, W, H);
    // ruler
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60]; let step = 60;
    for (const s of steps) if (s * pps >= 64) { step = s; break; }
    g.font = '11.5px ' + K.mono; g.textBaseline = 'top'; g.lineWidth = 1;
    for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-6; t += step) {
      const x = Math.round((t - t0) * pps) + 0.5;
      g.strokeStyle = K.line; g.beginPath(); g.moveTo(x, 15); g.lineTo(x, H); g.stroke();
      g.fillStyle = K.ink3; g.fillText(tick(t), x + 4, 1);
    }
    // waveform
    const mid = WAVE_Y + WAVE_H / 2;
    g.fillStyle = K.wave;
    for (let x = 0; x < W; x++) {
      const a = Math.floor((t0 + x / pps) * PPS), b = Math.max(a + 1, Math.floor((t0 + (x + 1) / pps) * PPS));
      let lo = 127, hi = -128;
      for (let p = Math.max(0, a); p < b && p * 2 + 1 < peaks.length; p++) { if (peaks[p * 2] < lo) lo = peaks[p * 2]; if (peaks[p * 2 + 1] > hi) hi = peaks[p * 2 + 1]; }
      if (hi < lo) continue;
      g.fillRect(x, mid - (hi / 128) * (WAVE_H / 2), 1, Math.max(1, ((hi - lo) / 128) * (WAVE_H / 2)));
    }
    // detected speech
    g.fillStyle = K.speech;
    sp.segs.forEach((s) => { if (s[1] < t0 || s[0] > t1) return; g.fillRect((s[0] - t0) * pps, SP_Y, Math.max(1, (s[1] - s[0]) * pps), SP_H); });
    // subtitle lane
    g.fillStyle = K.panel2; g.fillRect(0, LANE_Y - 5, W, LANE_H + 10);
    st.doc.segments.forEach((s, k) => {
      if (!k || st.showOrig) return;
      const x = Math.round((st.mapped[s.from].start - t0) * pps) - 5.5;
      if (x < 0 || x > W) return;
      g.strokeStyle = K.ink3; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, SP_Y - 4); g.lineTo(x, LANE_Y + LANE_H + 8); g.stroke(); g.setLineDash([]);
      g.fillStyle = K.ink3; g.font = '11.5px ' + K.ui; g.textBaseline = 'top'; g.fillText('第 ' + (k + 1) + ' 段', x + 5, LANE_Y + LANE_H + 8);
    });
    cues.forEach((c) => {
      const m = st.mapped[c.i];
      if (m.deleted || c.end < t0 || c.start > t1) return;
      const xa = (c.start - t0) * pps, w = Math.max(2, (c.end - c.start) * pps), col = K.segs[m.seg % 3];
      g.globalAlpha = c.i === st.now ? 0.62 : 0.3; g.fillStyle = col; box(g, xa, LANE_Y, w, LANE_H, 4); g.fill(); g.globalAlpha = 1;
      g.strokeStyle = c.i === st.sel ? K.ink : col; g.lineWidth = c.i === st.sel ? 2 : 1; box(g, xa + 0.5, LANE_Y + 0.5, w - 1, LANE_H - 1, 4); g.stroke(); g.lineWidth = 1;
      if (C.cueScore(sp, c) < 0.25 && w > 6) { g.fillStyle = K.bad; g.fillRect(xa + 3, LANE_Y + LANE_H - 5, w - 6, 3); }
      if (w >= 18) {
        g.save(); g.beginPath(); g.rect(xa, LANE_Y, w - 3, LANE_H); g.clip();
        g.fillStyle = K.ink; g.font = '12px ' + K.ui; g.textBaseline = 'middle';
        g.fillText(String(c.i + 1) + (w >= 96 ? '  ' + m.zh : ''), xa + 6, LANE_Y + LANE_H / 2 + 1);
        g.restore();
      }
    });
    // checkpoints sit above their line; pins sit below at the moment they were set
    st.cps.forEach((cp, j) => {
      const c = cues[cp.cue], x = (c.start - t0) * pps + 6;
      if (x < -6 || x > W + 6) return;
      g.beginPath(); g.arc(x, LANE_Y - 11, 4.5, 0, Math.PI * 2);
      if (cp.status === 'todo') { g.strokeStyle = K.ink3; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1; } else { g.fillStyle = cp.status === 'ok' ? K.good : K.bad; g.fill(); }
      if (j === st.cpCur) { g.strokeStyle = K.accent; g.lineWidth = 2; g.beginPath(); g.arc(x, LANE_Y - 11, 7.5, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1; }
    });
    if (!st.showOrig) st.doc.anchors.forEach((a) => {
      const x = (a.t - t0) * pps; if (x < -6 || x > W + 6) return;
      g.fillStyle = K.accentInk; g.beginPath(); g.moveTo(x, LANE_Y + LANE_H + 6); g.lineTo(x - 5, LANE_Y + LANE_H + 15); g.lineTo(x + 5, LANE_Y + LANE_H + 15); g.closePath(); g.fill();
    });
    // playhead
    const px = Math.round((clock.t - t0) * pps) + 0.5;
    if (px >= 0 && px <= W) {
      g.strokeStyle = K.playhead; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, 14); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
      g.fillStyle = K.playhead; g.beginPath(); g.moveTo(px - 5, 8); g.lineTo(px + 5, 8); g.lineTo(px, 16); g.closePath(); g.fill();
    }
  }

  function drawOverview() {
    const { g, w: W, h: H } = fit(ov), pps = W / DUR, cues = st.showOrig ? st.orig : st.mapped;
    g.clearRect(0, 0, W, H);
    g.fillStyle = K.panel2; box(g, 0, 0, W, H, 6); g.fill();
    g.save(); box(g, 0, 0, W, H, 6); g.clip();
    g.globalAlpha = 0.55; g.fillStyle = K.speech;
    sp.segs.forEach((s) => g.fillRect(s[0] * pps, 6, Math.max(1, (s[1] - s[0]) * pps), 9));
    g.globalAlpha = 1;
    cues.forEach((c) => { if (st.mapped[c.i].deleted) return; g.fillStyle = K[cueClass(C.cueScore(sp, c))]; g.fillRect(c.start * pps, 20, Math.max(2, (c.end - c.start) * pps - 1), 12); });
    g.restore();
    if (view.dur < DUR - 0.01) { g.strokeStyle = K.ink2; g.lineWidth = 1.5; box(g, view.t0 * pps + 1, 1, view.dur * pps - 2, H - 2, 5); g.stroke(); g.lineWidth = 1; }
    const px = Math.round(clock.t * pps) + 0.5;
    g.strokeStyle = K.playhead; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
  }

  function setView(centre, dur) {
    dur = Math.max(8, Math.min(DUR, dur));
    view.dur = dur; view.t0 = Math.max(0, Math.min(DUR - dur, centre - dur / 2)); dirty = true;
  }

  /* ---------- actions ---------- */
  function setOffset(k, v) { commit(); st.doc.segments[k].offset = round3(v); clearAnchors(k); changed(k); refresh(); }
  function nudge(d) {
    const k = activeSeg(); setOffset(k, st.doc.segments[k].offset + d);
    say('字幕' + (d < 0 ? '提前 ' : '延後 ') + Math.round(Math.abs(d) * 1000) + ' 毫秒,目前位移 *' + C.signed(st.doc.segments[k].offset, 2) + ' 秒*。');
  }
  function doAuto() {
    commit();
    const before = st.score, r = C.autoAlign(sp, st.base, { allowSplit: $('allow-split').checked, radius: 30 });
    st.doc.segments = r.segments; st.doc.anchors = []; changed(null); refresh();
    const parts = r.segments.map((s, k) => {
      const rr = segRange(k);
      return (r.segments.length > 1 ? '第 ' + (rr[0] + 1) + '–' + rr[1] + ' 句' : '') + '位移 *' + C.signed(s.offset, 2) + ' 秒*' + (s.scale !== 1 ? '、速率 *×' + s.scale.toFixed(4) + '*' : '');
    });
    say('自動對齊完成:' + parts.join(';') + '。對齊分數 ' + pct(before) + ' → *' + pct(st.score) + '*。接著用檢查點聽幾句確認。');
  }
  function doSnap() {
    const k = activeSeg(), seg = st.doc.segments[k], r = segRange(k), idxs = [];
    for (let i = r[0]; i < r[1]; i++) idxs.push(i);
    const b = C.bestLinear(sp, st.base, idxs, [seg.scale], seg.offset, 1.5, 0.01), d = b.offset - seg.offset;
    if (Math.abs(d) < 0.005) { say('已經貼齊人聲,沒有移動。'); return; }
    commit(); seg.offset = round3(b.offset); clearAnchors(k); changed(k); refresh();
    say('吸附到人聲:字幕' + (d < 0 ? '提前 ' : '延後 ') + Math.round(Math.abs(d) * 1000) + ' 毫秒,目前位移 *' + C.signed(seg.offset, 2) + ' 秒*。');
  }
  function doAnchor() {
    const i = st.sel, k = C.segIndex(st.doc, i), t = round3(clock.t);
    commit();
    st.doc.anchors = st.doc.anchors.filter((a) => a.cue !== i); st.doc.anchors.push({ cue: i, t });
    const mine = st.doc.anchors.filter((a) => C.segIndex(st.doc, a.cue) === k), f = C.fitAnchors(st.base, st.doc.segments[k], mine);
    st.doc.segments[k].scale = f.scale; st.doc.segments[k].offset = f.offset; changed(k); refresh();
    say('第 ' + (i + 1) + ' 句對到 ' + C.shortTc(t) + ':位移 *' + C.signed(f.offset, 2) + ' 秒*' + (mine.length >= 2 ? '、速率 *×' + f.scale.toFixed(4) + '*(由 ' + mine.length + ' 個對齊點算出)' : '') + '。');
  }
  function doSplit() {
    const i = st.sel;
    if (i === 0) { say('第 1 句已經是一段的開頭。請選取要另起一段的那一句。'); return; }
    if (st.doc.segments.some((s) => s.from === i)) { say('第 ' + (i + 1) + ' 句已經是一段的開頭。'); return; }
    commit();
    const k = C.segIndex(st.doc, i), s = st.doc.segments[k];
    st.doc.segments.splice(k + 1, 0, { from: i, scale: s.scale, offset: s.offset }); st.confirmed = false; refresh();
    say('從第 ' + (i + 1) + ' 句開始另成一段。現在的位移和速率只會動這一段。');
  }
  function doMerge() {
    const k = activeSeg(); if (k === 0) return;
    commit(); st.doc.segments.splice(k, 1); changed(null); refresh(); say('已併回前一段,沿用前一段的位移和速率。');
  }
  function playRange(a, b) { range = { end: b }; clock.seek(Math.max(0, a)); clock.play(); }
  function playLine(i) { const m = st.mapped[i]; playRange(m.start - 1, m.end + 0.4); }
  function cpGo(j) {
    st.cpCur = j; const cp = st.cps[j]; select(cp.cue, true); const m = st.mapped[cp.cue];
    if (view.dur < DUR) setView(m.start, view.dur);
    playRange(m.start - 1.5, m.end + 0.5);
    say('檢查點 ' + (j + 1) + '/' + st.cps.length + ':第 ' + (cp.cue + 1) + ' 句。聽它是不是在開口的瞬間出現。');
  }
  function cpNext() {
    const n = st.cps.length;
    for (let j = 1; j <= n; j++) { const c = (st.cpCur + j + n) % n; if (st.cps[c].status !== 'ok') { cpGo(c); return; } }
    say('五個檢查點都確認過了,可以按「確認同步」。');
  }
  function cpMark(status) {
    if (st.cpCur < 0) { say('先按「聽下一個」,聽完再標記。'); return; }
    commit(); st.cps[st.cpCur].status = status; st.confirmed = false; refresh();
    if (status === 'bad') { say('第 ' + (st.cps[st.cpCur].cue + 1) + ' 句標為不準。用位移、吸附或「對到現在」調整後,再聽一次。'); return; }
    if (st.cps.every((c) => c.status === 'ok')) say('五個檢查點都確認過了,可以按「確認同步」。'); else cpNext();
  }
  function undo() {
    if (!st.history.length) { say('沒有可以復原的動作。'); return; }
    st.future.push(snapshot()); restore(st.history.pop()); st.confirmed = false; refresh(); say('已復原上一個動作。');
  }
  function redo() {
    if (!st.future.length) { say('沒有可以重做的動作。'); return; }
    st.history.push(snapshot()); restore(st.future.pop()); st.confirmed = false; refresh(); say('已重做。');
  }
  function resetAll() {
    commit(); st.doc = { segments: [{ from: 0, scale: 1, offset: 0 }], edits: {}, anchors: [] };
    st.cps = C.pickCheckpoints(st.base, 5); st.cpCur = -1; st.confirmed = false; refresh();
    say('已回到下載時的原始字幕。可以按「復原」取消這次重設。');
  }
  function setOrig(on) { if (st.showOrig === on) return; st.showOrig = on; $('orig-tag').hidden = !on; renderList(); shownCue = -2; updateOverlay(); dirty = true; }

  function doConfirm(force) {
    const left = st.cps.filter((c) => c.status !== 'ok').length;
    if (left && !force) {
      say('還有 *' + left + ' 個檢查點*沒有確認。', [{ label: '仍要確認', run: () => doConfirm(true) }, { label: '聽下一個檢查點', run: cpNext }]);
      return;
    }
    st.confirmed = true; renderStatus(); renderSummary();
    say('已確認。下面是同步結果。');
    $('summary').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function renderSummary() {
    const box2 = $('summary'); box2.textContent = ''; box2.hidden = false;
    const okN = st.cps.filter((c) => c.status === 'ok').length, edited = st.mapped.filter((c) => c.edited && !c.deleted).length, removed = st.mapped.filter((c) => c.deleted).length;
    box2.appendChild(el('h2', '', '已確認的同步結果'));
    box2.appendChild(el('p', '', '對齊分數 ' + pct(st.score) + ' · 檢查點 ' + okN + '/' + st.cps.length + ' · 修改 ' + edited + ' 句 · 刪除 ' + removed + ' 句'));
    const wrap = el('div', 'tablewrap'), table = el('table'), head = el('tr');
    ['分段', '句數', '速率', '位移'].forEach((h) => head.appendChild(el('th', '', h)));
    const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    const body = el('tbody');
    st.doc.segments.forEach((s, k) => {
      const r = segRange(k), tr = el('tr');
      [st.doc.segments.length > 1 ? '第 ' + (k + 1) + ' 段' : '全片', '第 ' + (r[0] + 1) + '–' + r[1] + ' 句', '×' + s.scale.toFixed(4), C.signed(s.offset, 3) + ' 秒']
        .forEach((v, j) => tr.appendChild(el('td', j > 1 ? 'mono' : '', v)));
      body.appendChild(tr);
    });
    table.appendChild(body); wrap.appendChild(table); box2.appendChild(wrap);
    box2.appendChild(el('p', '', '正式版的下一步是「匯出 MKV」:伺服器把這份時間套到字幕,再和影片封裝在一起。下面是套用後的字幕內容。'));
    const pre = el('pre', '', C.toSrt(st.mapped, st.bilingual)); pre.id = 'srt'; pre.tabIndex = 0; box2.appendChild(pre);
    const row = el('div', 'ctl'), copy = el('button', '', '複製字幕內容'), note = el('span', 'note', '');
    copy.type = 'button'; copy.id = 'copy-srt';
    copy.addEventListener('click', () => {
      const pick = () => { const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); note.textContent = '已選取全文,請按 Ctrl+C 或 ⌘C 複製。'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.textContent).then(() => { note.textContent = '已複製。'; }, pick); else pick();
    });
    row.style.display = 'flex'; row.style.gap = '10px'; row.style.alignItems = 'center'; row.style.flexWrap = 'wrap';
    row.appendChild(copy); row.appendChild(note); box2.appendChild(row);
  }

  /* ---------- per-line editing ---------- */
  function editCue(i, fn) {
    const id = st.base[i].id, e = st.doc.edits[id] || (st.doc.edits[id] = {});
    fn(e, st.base[i]);
    if (!e.dStart && !e.dEnd && e.zh == null && !e.deleted) delete st.doc.edits[id];
    st.cps.forEach((c) => { if (c.cue === i) c.status = 'todo'; });
    st.confirmed = false;
  }
  function onEdit(i, op) {
    const seg = st.doc.segments[C.segIndex(st.doc, i)], t = clock.t;
    commit();
    editCue(i, (e, b) => {
      const s0 = b.start * seg.scale + seg.offset, e0 = b.end * seg.scale + seg.offset;
      if (op === 's-') e.dStart = round3((e.dStart || 0) - 0.05);
      if (op === 's+') e.dStart = round3((e.dStart || 0) + 0.05);
      if (op === 's=') e.dStart = round3(t - s0);
      if (op === 'e-') e.dEnd = round3((e.dEnd || 0) - 0.05);
      if (op === 'e+') e.dEnd = round3((e.dEnd || 0) + 0.05);
      if (op === 'e=') e.dEnd = round3(t - e0);
      if (op === 'del') e.deleted = !e.deleted;
    });
    refresh();
    const m = st.mapped[i];
    say(op === 'del' ? (m.deleted ? '第 ' + (i + 1) + ' 句已刪除,匯出時不會包含。' : '第 ' + (i + 1) + ' 句已還原。')
      : '第 ' + (i + 1) + ' 句現在是 *' + C.shortTc(m.start) + ' → ' + C.shortTc(m.end) + '*。');
  }

  /* ---------- wiring ---------- */
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.row'); if (!row || e.target.closest('textarea')) return;
    const i = Number(row.dataset.i), act = e.target.closest('[data-act]'), ed = e.target.closest('[data-ed]');
    if (e.target.closest('[data-seek]')) { st.sel = i; clock.seek(st.mapped[i].start); if (view.dur < DUR) setView(st.mapped[i].start, view.dur); renderList(); renderTools(); return; }
    if (act) { if (act.dataset.act === 'playline') playLine(i); if (act.dataset.act === 'anchor') doAnchor(); if (act.dataset.act === 'split') doSplit(); return; }
    if (ed) { onEdit(i, ed.dataset.ed); return; }
    if (i !== st.sel) select(i);
  });
  listEl.addEventListener('input', (e) => {
    if (e.target.id !== 'edit-text') return;
    if (!textSession) { commit(); textSession = true; }
    const i = st.sel, v = e.target.value;
    editCue(i, (ed, b) => { if (v === b.zh) delete ed.zh; else ed.zh = v; });
    recompute(); shownCue = -2; updateOverlay(); renderStatus(); dirty = true;
  });
  listEl.addEventListener('focusout', (e) => { if (e.target.id === 'edit-text') textSession = false; });

  $('play').addEventListener('click', () => { range = null; if (clock.playing) clock.pause(); else clock.play(); });
  $('back').addEventListener('click', () => clock.seek(clock.t - 1));
  $('fwd').addEventListener('click', () => clock.seek(clock.t + 1));
  $('speed').addEventListener('change', (e) => clock.setRate(Number(e.target.value)));
  $('bilingual').addEventListener('change', (e) => { st.bilingual = e.target.checked; refresh(); if (st.confirmed) renderSummary(); });
  $('search').addEventListener('input', (e) => { st.query = e.target.value; renderList(); });
  $('mode-sync').addEventListener('click', () => setMode('sync'));
  $('mode-edit').addEventListener('click', () => setMode('edit'));
  function setMode(m) {
    st.mode = m; $('mode-sync').setAttribute('aria-pressed', String(m === 'sync')); $('mode-edit').setAttribute('aria-pressed', String(m === 'edit'));
    renderList(); revealRow(st.sel);
    say(m === 'edit' ? '逐句編輯:改文字、單獨調整一句的開始和結束,或刪掉廣告行。在時間軸上拖曳字幕區塊只會動那一句。' : '同步:位移和速率會一起移動整段字幕。');
  }
  $('scenario').addEventListener('change', (e) => { clock.pause(); loadScenario(e.target.value); clock.seek(0); setView(0, DUR); refresh(); say('已換成另一份字幕。按「播放」聽聽看,或直接按「自動對齊」。'); });
  $('auto').addEventListener('click', doAuto);
  $('snap').addEventListener('click', doSnap);
  document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => nudge(Number(b.dataset.nudge))));
  $('offset').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) { say('位移要填秒數,例如 -2.4。'); renderTools(); return; }
    const k = activeSeg(); setOffset(k, v); say('位移設為 *' + C.signed(st.doc.segments[k].offset, 2) + ' 秒*。');
  });
  $('rate').addEventListener('change', (e) => {
    const r = C.RATES.filter((x) => x.id === e.target.value)[0]; if (!r) return;
    const k = activeSeg(), seg = st.doc.segments[k], rr = segRange(k), piv = st.sel >= rr[0] && st.sel < rr[1] ? st.sel : rr[0];
    commit();
    const keep = st.base[piv].start * seg.scale + seg.offset;
    seg.scale = r.scale; seg.offset = round3(keep - st.base[piv].start * r.scale); clearAnchors(k); changed(k); refresh();
    say('速率改為 *×' + r.scale.toFixed(4) + '*,第 ' + (piv + 1) + ' 句的位置不變。');
  });
  $('anchor').addEventListener('click', doAnchor);
  $('split').addEventListener('click', doSplit);
  $('merge').addEventListener('click', doMerge);
  $('cp-next').addEventListener('click', cpNext);
  $('cp-ok').addEventListener('click', () => cpMark('ok'));
  $('cp-bad').addEventListener('click', () => cpMark('bad'));
  $('cp-dots').addEventListener('click', (e) => { const b = e.target.closest('[data-cp]'); if (b) cpGo(Number(b.dataset.cp)); });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('reset').addEventListener('click', resetAll);
  $('confirm').addEventListener('click', () => doConfirm(false));
  const origBtn = $('orig');
  origBtn.addEventListener('pointerdown', () => setOrig(true));
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((ev) => origBtn.addEventListener(ev, () => setOrig(false)));
  origBtn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') setOrig(true); });
  origBtn.addEventListener('keyup', () => setOrig(false));

  $('zoom-in').addEventListener('click', () => setView(clock.t, view.dur / 2));
  $('zoom-out').addEventListener('click', () => setView(clock.t, view.dur * 2));
  $('zoom-fit').addEventListener('click', () => setView(DUR / 2, DUR));

  // timeline: drag the subtitle lane to slide the subtitle, anywhere else to scrub
  const pt = (c, e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width }; };
  const cueAt = (t) => { for (let i = 0; i < st.mapped.length; i++) if (!st.mapped[i].deleted && t >= st.mapped[i].start && t <= st.mapped[i].end) return i; return -1; };
  tl.addEventListener('pointerdown', (e) => {
    const p = pt(tl, e), pps = p.w / view.dur, t = view.t0 + p.x / pps;
    tl.setPointerCapture(e.pointerId);
    if (p.y >= LANE_Y - 5 && p.y <= LANE_Y + LANE_H + 5) {
      const hit = cueAt(t);
      if (st.mode === 'edit' && hit >= 0) { const ed = st.doc.edits[st.base[hit].id] || {}; drag = { kind: 'cue', i: hit, x0: p.x, pps, t, moved: false, s0: ed.dStart || 0, e0: ed.dEnd || 0 }; }
      else { const k = hit >= 0 ? st.mapped[hit].seg : activeSeg(); drag = { kind: 'offset', k, hit, x0: p.x, pps, t, moved: false, off0: st.doc.segments[k].offset }; }
    } else { drag = { kind: 'scrub' }; range = null; clock.seek(t); }
    e.preventDefault();
  });
  tl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(tl, e);
    if (drag.kind === 'scrub') { clock.seek(view.t0 + p.x / (p.w / view.dur)); return; }
    const dx = p.x - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3) return;
    if (!drag.moved) { drag.moved = true; commit(); }
    const dt = Math.round((dx / drag.pps) * 100) / 100;
    if (drag.kind === 'offset') { st.doc.segments[drag.k].offset = round3(drag.off0 + dt); clearAnchors(drag.k); changed(drag.k); }
    else editCue(drag.i, (ed) => { ed.dStart = round3(drag.s0 + dt); ed.dEnd = round3(drag.e0 + dt); });
    refresh();
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'scrub') return;
    if (!d.moved) { range = null; clock.seek(d.t); if (d.hit >= 0 || d.kind === 'cue') select(d.kind === 'cue' ? d.i : d.hit, true); return; }
    if (d.kind === 'offset') say('拖曳後的位移是 *' + C.signed(st.doc.segments[d.k].offset, 2) + ' 秒*。對齊分數 *' + pct(st.score) + '*。');
    else say('第 ' + (d.i + 1) + ' 句移到 *' + C.shortTc(st.mapped[d.i].start) + '*。');
  };
  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', endDrag);
  let ovDown = false;
  const ovSeek = (e) => { const p = pt(ov, e), t = Math.max(0, Math.min(DUR, (p.x / p.w) * DUR)); range = null; clock.seek(t); if (view.dur < DUR) setView(t, view.dur); };
  ov.addEventListener('pointerdown', (e) => { ovDown = true; ov.setPointerCapture(e.pointerId); ovSeek(e); e.preventDefault(); });
  ov.addEventListener('pointermove', (e) => { if (ovDown) ovSeek(e); });
  ['pointerup', 'pointercancel'].forEach((ev) => ov.addEventListener(ev, () => { ovDown = false; }));

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tgt = e.target;
    if (tgt.closest && tgt.closest('input, textarea, select')) return;
    if (tgt.closest && tgt.closest('button, summary, a') && (e.key === ' ' || e.key === 'Enter')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let used = true;
    if (key === ' ') { range = null; if (clock.playing) clock.pause(); else clock.play(); }
    else if (key === 'ArrowLeft') clock.seek(clock.t - (e.shiftKey ? 5 : 1));
    else if (key === 'ArrowRight') clock.seek(clock.t + (e.shiftKey ? 5 : 1));
    else if (key === 'ArrowUp') select(Math.max(0, st.sel - 1), true);
    else if (key === 'ArrowDown') select(Math.min(st.base.length - 1, st.sel + 1), true);
    else if (key === ',' || key === '<') nudge(e.shiftKey ? -0.5 : -0.05);
    else if (key === '.' || key === '>') nudge(e.shiftKey ? 0.5 : 0.05);
    else if (key === 'Enter') doAnchor();
    else if (key === 'a') doAuto();
    else if (key === 'n') cpNext();
    else if (key === 'o') { if (!e.repeat) setOrig(true); }
    else if (key === 'z') { if (e.shiftKey) redo(); else undo(); }
    else used = false;
    if (used) e.preventDefault();
  });
  document.addEventListener('keyup', (e) => { if (e.key && e.key.toLowerCase() === 'o') setOrig(false); });

  /* ---------- frame loop ---------- */
  function frame() {
    const t = clock.t, playing = clock.playing;
    if (range && t >= range.end) { clock.pause(); range = null; }
    if (playing !== lastPlaying) { $('play').textContent = playing ? '暫停' : '播放'; lastPlaying = playing; }
    if (t !== lastT || dirty) {
      $('clock').textContent = C.tc(t);
      updateOverlay();
      if (playing && $('follow').checked && view.dur < DUR && (t < view.t0 || t > view.t0 + view.dur * 0.85)) setView(t + view.dur * 0.3, view.dur);
      drawTimeline(); drawOverview();
      lastT = t; dirty = false;
    }
    requestAnimationFrame(frame);
  }

  /* ---------- start ---------- */
  SC.forEach((s) => $('scenario').add(new Option(s.label, s.id)));
  readTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', () => { dirty = true; });
  if (window.ResizeObserver) new ResizeObserver(() => { dirty = true; }).observe(tl);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(readTheme);
  clock.start();
  loadScenario(SC[0].id);
  refresh();
  say('準備好了。按「播放」聽聽看字幕差多少,或直接按「自動對齊」。');
  requestAnimationFrame(frame);

  window.__bench = { st, clock, view, Core: C };
})();
