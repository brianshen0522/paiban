/* Platform prototype, part 4: router, actions, and event wiring. */

const VIEWS = { search: vSearch, movie: vMovie, downloads: vDownloads, library: vLibrary, work: vWork, storage: vStorage, profile: vProfile,
  'a-overview': aOverview, 'a-users': aUsers, 'a-storage': aStorage, 'a-sources': aSources, 'a-downloads': aDownloads, 'a-system': aSystem, 'a-audit': aAudit };
const BENCH_FOR = { 'zh-Hant': 'late', en: 'rate', 'zh-Hans': 'cut' };

function toast(text, action) {
  const box = $('#toasts'), t = document.createElement('div');
  t.className = 'toast'; t.appendChild(document.createTextNode(text));
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.addEventListener('click', () => { t.remove(); go(action.go[0], action.go[1]); }); t.appendChild(b); }
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), 5200);
}

function stashBench() {
  const b = $('#bench');
  if (b.parentNode !== document.body) document.body.appendChild(b);
  b.hidden = true;
  if (window.__bench) window.__bench.clock.pause();
}
function go(name, params) {
  const p = params || {}, prevTid = S.route.tid;
  S.route = Object.assign({ name }, p);
  S.confirm = null; S.pop = null; S.blocked = null;
  if (name === 'work') S.ws.tab = p.tab || (p.tid === prevTid ? S.ws.tab : 'subs');
  if (name === 'a-storage') S.limitDraft = null;
  if (name === 'a-downloads') S.draft = null;
  if (name === 'a-sources') S.src = null;
  render();
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + name); } catch (e) { /* the viewer may not allow it */ }
}
function render() {
  const root = $('#root');
  if (!DB.me) { stashBench(); root.innerHTML = S.route.name === 'invite' ? vInvite() : vLogin(); return; }
  if (!$('.shell')) {
    root.innerHTML = '<div class="shell"><header class="top" id="top"></header><nav class="side" id="side" aria-label="主選單"></nav><main class="main"><div id="view"></div><div id="bench-slot"></div><p class="foot">原型:電影、使用者與字幕都是示範資料,用的是公有領域的老片。搜尋、下載與匯出是模擬的;同步頁可以實際操作。</p></main></div>';
    $('#bench-slot').appendChild($('#bench'));
  }
  renderTop(); renderSide(); renderView();
}
function renderView() {
  const name = S.route.name, fn = VIEWS[name];
  $('#view').innerHTML = !fn ? vMissing() : name.indexOf('a-') === 0 && !isAdmin() ? vForbidden() : fn();
  const show = name === 'work' && S.ws.tab === 'sync' && !!$('#ws-sub'), b = $('#bench');
  if (show && S.ws.benchSub !== S.ws.sub && window.__bench) {
    const s = DB.subs.find((x) => x.id === S.ws.sub);
    window.__bench.load(BENCH_FOR[s.lang] || 'late'); S.ws.benchSub = S.ws.sub;
  }
  if (b.hidden === show) { b.hidden = !show; if (!show && window.__bench) window.__bench.clock.pause(); }
  const drop = $('#drop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) addUpload(e.dataTransfer.files[0]); });
  }
}
// Re-render without losing the caret in the field being typed in.
function soft(all) {
  const a = document.activeElement, id = a && a.id, pos = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  if (all) { renderTop(); renderSide(); }
  renderView();
  const n = id && document.getElementById(id);
  if (n && n !== document.activeElement) { n.focus(); if (pos) { try { n.setSelectionRange(pos[0], pos[1]); } catch (e) { /* not a text field */ } } }
}
const onRoute = (name, tid) => !!DB.me && S.route.name === name && (tid == null || S.route.tid === tid);

/* ---------- simulated searches ---------- */
function runSearch(q) {
  S.q = q; S.qApplied = q; S.searching = true;
  if (S.route.name === 'search') { S.pop = null; renderTop(); renderSide(); renderView(); } else go('search');
  setTimeout(() => { S.searching = false; if (onRoute('search')) soft(); }, 550);
}
function subSearch(t) {
  const ss = searchState(t), all = candidatesFor(t), on = (k) => DB.settings.prov[k].on;
  ss.st = 'run'; ss.cands = []; ss.scores = {}; ss.ranked = false; ss.prov = {};
  ['js', 'yify', 'assrt'].forEach((k) => { if (on(k)) ss.prov[k] = { st: 'run' }; });
  if (!Object.keys(ss.prov).length) { ss.st = 'done'; toast('所有自動來源都被停用了。'); return; }
  const finish = (k, delay, fail) => setTimeout(() => {
    if (!ss.prov[k]) return;
    if (fail) ss.prov[k] = { st: 'err', msg: fail };
    else { const got = all.filter((c) => c.p === k); ss.cands = ss.cands.filter((c) => c.p !== k).concat(got); ss.prov[k] = { st: 'ok', n: got.length }; }
    if (Object.keys(ss.prov).every((p) => ss.prov[p].st !== 'run')) ss.st = 'done';
    if (onRoute('work', t.id) && S.ws.tab === 'subs') soft();
  }, delay);
  finish('js', 500); finish('yify', 1100); finish('assrt', 1700, DB.sim.assrtLimited ? '超過每分鐘 20 次的上限' : null);
}
function subRank(t) {
  const ss = searchState(t), list = ss.cands.concat(ss.uploads);
  if (ss.ranking) return;
  ss.ranking = true; ss.ranked = false; ss.scores = {};
  list.forEach((c, i) => setTimeout(() => {
    ss.scores[c.id] = Math.max(31, Math.min(88, c.base + ((c.rel.length * 7 + i * 3) % 5) - 2));
    if (i === list.length - 1) { ss.ranking = false; ss.ranked = true; DB.jobs.unshift({ type: '自動對齊', item: movie(t.m).title + ' · ' + list.length + ' 條候選字幕', st: 'done', note: '用時 ' + (list.length * 0.9).toFixed(1) + ' 秒' }); }
    if (onRoute('work', t.id) && S.ws.tab === 'subs') soft();
  }, 260 * (i + 1)));
}
function addUpload(file) {
  const t = tor(S.route.tid), ss = searchState(t), ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['srt', 'ass', 'ssa', 'vtt', 'zip', 'rar', '7z'].indexOf(ext) < 0) { toast('不支援這種檔案。請上傳 .srt、.ass、.vtt,或 .zip、.rar、.7z 壓縮檔。'); return; }
  const push = (tags, note) => { ss.uploads.push({ id: newId('up'), p: 'upload', lang: '?', label: '', rel: file.name, by: '', tags, base: 64 }); toast(note); soft(); };
  if (['zip', 'rar', '7z'].indexOf(ext) >= 0) { push(['archive'], '已收到 ' + file.name + '。正式版會在伺服器解壓,列出裡面的每一條字幕。'); return; }
  const r = new FileReader();
  r.onload = () => { const text = String(r.result), n = ext === 'ass' || ext === 'ssa' ? (text.match(/^Dialogue:/gm) || []).length : (text.match(/-->/g) || []).length; push([], '已讀取 ' + file.name + ':' + n + ' 句。'); };
  r.onerror = () => toast('讀不到這個檔案,請再試一次。');
  r.readAsText(file);
}

/* ---------- actions ---------- */
function dropHold(t, who) {
  t.holders = t.holders.filter((h) => h !== who);
  if (t.holders.length) return false;
  DB.torrents = DB.torrents.filter((x) => x !== t);
  DB.subs = DB.subs.filter((s) => s.t !== t.id);
  return true;
}
const ACT = {
  'quick-login'(d) { DB.me = d.user; audit('登入', '原型捷徑'); S.pop = null; go('search'); toast('以 ' + me().name + '(' + (isAdmin() ? '管理員' : '成員') + ')的身分進入。'); },
  logout() { audit('登出', ''); stashBench(); DB.me = null; S.route = { name: 'login' }; S.auth.error = ''; render(); window.scrollTo(0, 0); },
  'reset-demo'() { const keep = DB.me; DB = seed(); DB.me = user(keep) ? keep : 'brian'; Object.assign(S, { subSearch: {}, exp: {}, draft: null, src: null, limitDraft: null, flash: {}, blocked: null, q: '', qApplied: '' }); S.ws.benchSub = null; go('search'); toast('示範資料已回到一開始的狀態。'); },
  pop(d) { S.pop = S.pop === d.pop ? null : d.pop; renderTop(); },
  'read-all'() { DB.activity.forEach((a) => { if (a.to === DB.me) a.unread = false; }); renderTop(); },
  'open-activity'(d) { const a = DB.activity[Number(d.i)]; a.unread = false; if (a.go[0] === 'work' && !(tor(a.go[1]) && tor(a.go[1]).holders.includes(DB.me))) go('library'); else go(a.go[0], a.go[1] ? { tid: a.go[1] } : {}); },
  'search-retry'() { runSearch(S.q); },
  'search-clear'() { S.filters = { quality: 'all', genre: 'all', rating: '0', sort: 'new' }; runSearch(''); },
  download(d) {
    const m = movie(d.m), v = m.v[Number(d.v)], u = usage(), need = needFor(m, v);
    if (u.used + need > u.limit + 1e-9) { S.blocked = { m: m.id, v: v.i, need: u.used + need - u.limit }; renderView(); return; }
    const t = { id: newId('t'), m: m.id, v: v.i, status: 'queued', progress: 0, holders: [DB.me], by: DB.me, when: '剛剛' };
    DB.torrents.push(t); schedule(); audit(t.status === 'downloading' ? '開始下載' : '排入下載', tname(t)); S.blocked = null; soft(true);
    toast(t.status === 'downloading' ? '開始下載 ' + tname(t) + '。' : tname(t) + ' 已排入下載,前面還有其他下載。', { label: '查看下載', go: ['downloads'] });
  },
  join(d) { const t = DB.torrents.find((x) => x.m === d.m && x.v === Number(d.v)); if (!t.holders.includes(DB.me)) t.holders.push(DB.me); audit('加入片庫', tname(t)); soft(true); toast('已加入你的片庫,不佔額外空間。'); },
  unblock() { S.blocked = null; renderView(); },
  retry(d) { const t = tor(d.tid), v = tv(t); if (!fits(needFor(movie(t.m), v) - (t.partial || 0))) { toast('空間不足,無法重試。先到儲存空間刪除不需要的檔案。'); return; } if (v.seeds === 0) v.seeds = 14; t.status = 'queued'; t.error = ''; t.partial = 0; schedule(); audit('重試下載', tname(t)); soft(true); toast('已重新排入下載。'); },
  pause(d) { const t = tor(d.tid); t.status = 'paused'; schedule(); soft(true); },
  resume(d) { const t = tor(d.tid); t.status = 'queued'; schedule(); soft(true); if (t.status === 'queued') toast('已排回佇列,等其他下載完成後繼續。'); },
  'cancel-ask'(d) { S.confirm = 'cancel:' + d.tid; renderView(); },
  cancel(d) { const t = tor(d.tid), name = tname(t), gone = dropHold(t, DB.me); S.confirm = null; schedule(); audit(gone ? '取消下載' : '放棄下載', name); soft(true); toast(gone ? '已取消,空間已釋放。' : '已從你的清單移除,其他人的下載不受影響。'); },
  confirm(d) { S.confirm = d.key; renderView(); },
  'confirm-off'() { S.confirm = null; renderView(); },
  unhold(d) {
    const t = tor(d.tid), v = tv(t), name = tname(t), freed = v.gb + (t.proxy ? t.proxy.gb : 0), gone = dropHold(t, DB.me);
    S.confirm = null; audit(gone ? '刪除影片' : '從片庫移除', name);
    if (S.route.name === 'work') go('library'); else soft(true);
    toast(gone ? '已刪除,釋放 ' + gb(freed) + '。' : '已從你的片庫移除。其他人還持有,空間沒有變化。');
  },
  'lib-filter'(d) { S.lib.filter = d.k; renderView(); },
  'ws-tab'(d) { S.ws.tab = d.tab; S.confirm = null; renderView(); window.scrollTo(0, 0); },
  'sub-lang'(d) { const ss = searchState(tor(S.route.tid)), i = ss.langs.indexOf(d.k); if (i >= 0 && ss.langs.length > 1) ss.langs.splice(i, 1); else if (i < 0) ss.langs.push(d.k); else toast('至少要選一種語言。'); renderView(); },
  'sub-search'() { subSearch(tor(S.route.tid)); renderView(); },
  'sub-retry'(d) {
    const t = tor(S.route.tid), ss = searchState(t); ss.prov[d.k] = { st: 'run' }; ss.st = 'run'; renderView();
    setTimeout(() => { DB.sim.assrtLimited = false; DB.health.assrt = ['ok', '剛剛', '']; const got = candidatesFor(t).filter((c) => c.p === d.k); ss.cands = ss.cands.filter((c) => c.p !== d.k).concat(got); ss.prov[d.k] = { st: 'ok', n: got.length }; ss.st = 'done'; if (onRoute('work', t.id)) soft(); }, 900);
  },
  'sub-rank'() { subRank(tor(S.route.tid)); renderView(); },
  'sub-add'(d) {
    const t = tor(S.route.tid), ss = searchState(t), c = ss.cands.concat(ss.uploads).find((x) => x.id === d.c), p = me().prefs || { s2t: true };
    let lang = c.lang, note = '已加入。';
    if (lang === 'zh') { lang = 'zh-Hant'; note = '已加入。依內容判斷是繁體中文。'; }
    else if (lang === '?') { lang = /\b(en|eng|english)\b/i.test(c.rel) ? 'en' : 'zh-Hant'; note = '已加入。依內容判斷是' + LANG[lang] + '。'; }
    else if (lang === 'zh-Hans' && p.s2t !== false) { lang = 'zh-Hant'; note = '已加入,並從簡體轉成繁體。'; }
    DB.subs.push({ id: newId('s'), t: t.id, p: c.p, lang, rel: c.rel, status: 'draft', score: ss.scores[c.id] != null ? ss.scores[c.id] : null, by: DB.me });
    audit('加入字幕', movie(t.m).title + ' · ' + LANG[lang]); renderView(); toast(note + ' 下一步是同步。');
  },
  'sync-sub'(d) { S.ws.sub = d.s; S.ws.tab = 'sync'; renderView(); window.scrollTo(0, 0); },
  'sub-del'(d) { const s = DB.subs.find((x) => x.id === d.s); DB.subs = DB.subs.filter((x) => x !== s); S.confirm = null; audit('移除字幕', movie(tor(s.t).m).title + ' · ' + LANG[s.lang]); renderView(); toast('字幕已移除。'); },
  'zmk-open'() { toast('原型不會真的開啟外部網站。正式版會在新分頁開啟字幕庫對這部片的搜尋結果。'); },
  'exp-start'() {
    const t = tor(S.route.tid), d = expDraft(t), v = tv(t), pick = DB.subs.filter((s) => s.t === t.id && s.status === 'confirmed' && d.on[s.id]), name = d.name.trim();
    d.err = '';
    if (!pick.length) { toast('至少要選一條已確認的字幕。還沒有的話,先去同步。'); return; }
    if (!/\.mkv$/i.test(name) || /[\\/:*?"<>|]/.test(name)) { d.err = '檔名要以 .mkv 結尾,而且不能有 / \\ : * ? " < > | 這些字元。'; renderView(); return; }
    if (!fits(v.gb)) { renderView(); toast('空間不足,不能匯出。'); return; }
    pick.sort((a, b) => (b.id === d.def) - (a.id === d.def));
    DB.exports.unshift({ id: newId('e'), t: t.id, by: DB.me, name, gb: v.gb, tracks: pick.map((s) => LANG[s.lang]), when: '剛剛', status: 'running', p: 0 });
    audit('匯出 MKV', movie(t.m).title); soft(true); toast('開始封裝。影音不重新編碼,通常不到一分鐘。');
  },
  'exp-get'() { toast('原型沒有真的檔案可以下載。正式版會開始下載,中斷後可以續傳。'); },
  'exp-del'(d) { const e = DB.exports.find((x) => x.id === d.e); DB.exports = DB.exports.filter((x) => x !== e); S.confirm = null; audit('刪除匯出檔', e.name); soft(true); toast('已刪除,釋放 ' + gb(e.gb) + '。'); },
  'device-out'(d) { me().devices.splice(Number(d.i), 1); renderView(); toast('那台裝置已登出。'); },
  copy(d) { const done = () => toast('已複製。'), fail = () => toast('這裡不能自動複製,請手動選取那段文字。'); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.text).then(done, fail); else fail(); },
  'flash-off'(d) { delete S.flash[d.k]; renderView(); },
  /* admin */
  'user-role'(d) { const u = user(d.u); u.role = u.role === 'admin' ? 'member' : 'admin'; audit('變更角色', u.name + ' → ' + (u.role === 'admin' ? '管理員' : '成員')); renderView(); toast(u.name + ' 現在是' + (u.role === 'admin' ? '管理員' : '成員') + '。'); },
  'user-toggle'(d) { const u = user(d.u); u.disabled = !u.disabled; audit(u.disabled ? '停用帳號' : '啟用帳號', u.name); renderView(); toast(u.disabled ? u.name + ' 已停用,不能登入;他的檔案不會被動。' : u.name + ' 已啟用。'); },
  'user-reset'(d) { S.flash.reset = { id: d.u, link: 'https://paiban.home.example/reset/' + Math.random().toString(36).slice(2, 12) }; audit('產生重設密碼連結', uname(d.u)); renderView(); },
  'user-del'(d) { const u = user(d.u); DB.users = DB.users.filter((x) => x !== u); DB.torrents.forEach((t) => { t.holders = t.holders.filter((h) => h !== u.id); }); S.confirm = null; audit('移除帳號', u.name); renderView(); toast(u.name + ' 的帳號已移除。'); },
  'invite-revoke'(d) { DB.invites = DB.invites.filter((i) => i.code !== d.code); audit('撤銷邀請', d.code); renderView(); toast('邀請已移除,連結不能再用。'); },
  rescan() { toast('已重新掃描磁碟,實際用量和紀錄一致。'); },
  'force-del'(d) {
    const [kind, id] = d.key.split(':'); let freed = 0, what = '';
    if (kind === 'tor') { const t = tor(id), v = tv(t); what = tname(t); freed = (t.status === 'done' ? v.gb : t.status === 'failed' ? t.partial : 0) + (t.proxy ? t.proxy.gb : 0); DB.torrents = DB.torrents.filter((x) => x !== t); DB.subs = DB.subs.filter((s) => s.t !== id); schedule(); }
    if (kind === 'proxy') { const t = tor(id); what = tname(t) + ' 的預覽檔'; freed = t.proxy.gb; delete t.proxy; }
    if (kind === 'exp') { const e = DB.exports.find((x) => x.id === id); what = e.name; freed = e.gb; DB.exports = DB.exports.filter((x) => x !== e); }
    S.confirm = null; audit('管理員刪除', what); soft(true); toast('已刪除' + (freed ? ',釋放 ' + gb(freed) : '') + '。');
  },
  test(d) {
    const k = d.k; S.flash['test:' + k] = { run: true }; soft();
    setTimeout(() => {
      const r = { yts: DB.sim.ytsDown ? [false, '連線逾時'] : [true, '回應 200 · 0.4 秒'], tmdb: [true, '金鑰有效'], js: [true, '英文回傳 30 筆'], yify: [true, '網頁可以解析'], assrt: [true, '配額正常'], port: [true, '外部可以連入'] }[k];
      S.flash['test:' + k] = { ok: r[0], text: r[1] };
      if (k === 'assrt') DB.health.assrt = ['ok', '剛剛', ''];
      if (DB.me && (S.route.name === 'a-sources' || S.route.name === 'a-downloads')) soft();
    }, 800);
  },
  'save-secret'(d, el) {
    const input = el.closest('.card').querySelector('input[type="password"]');
    if (!input.value.trim()) { toast('沒有輸入新的值,維持原設定。'); return; }
    if (d.k.indexOf('TMDB') === 0) DB.settings.tmdbKey = true; else if (d.k.indexOf('SubDL') === 0) DB.settings.prov.js.subdlKey = true; else DB.settings.prov.assrt.token = true;
    audit('更新金鑰', d.k); renderView(); toast(d.k + '已儲存。之後不會再顯示內容。');
  },
  'health-clear'(d) { DB.health[d.k] = ['ok', '剛剛', '']; DB.sim.assrtLimited = false; renderView(); },
  'ds-revert'() { S.draft = null; renderView(); },
  'job-retry'(d) { const j = DB.jobs[Number(d.i)]; j.st = 'done'; j.note = '重試後完成,用時 1.3 秒'; renderView(); toast('已重試並完成。'); }
};

/* ---------- field changes ---------- */
const CHANGE = {
  'exp-on'(d, el) { const x = expDraft(tor(S.route.tid)); x.on[d.s] = el.checked; soft(); },
  'exp-def'(d) { expDraft(tor(S.route.tid)).def = d.s; soft(); },
  'pref-lang'(d, el) { const p = me().prefs, i = p.langs.indexOf(d.k); if (el.checked && i < 0) p.langs.push(d.k); else if (!el.checked && p.langs.length > 1) p.langs.splice(i, 1); else if (!el.checked) toast('至少要保留一種語言。'); soft(); },
  pref(d, el) { me().prefs[d.k] = el.checked; toast('已儲存。'); },
  'prov-on'(d, el) { DB.settings.prov[d.k].on = el.checked; audit(el.checked ? '啟用字幕來源' : '停用字幕來源', PROVIDERS[d.k].name); toast(PROVIDERS[d.k].name + (el.checked ? ' 已啟用。' : ' 已停用,字幕頁不會再查它。')); },
  'sim-yts'(d, el) { DB.sim.ytsDown = el.checked; soft(); toast(el.checked ? '現在搜尋頁會顯示連不上 YTS 的狀態。' : 'YTS 恢復正常。'); },
  'ds-seed'(d, el) { S.draft.seed = el.value; S.draft.dirty = true; soft(); },
  'ds-flag'(d, el) { S.draft[d.k] = el.checked; S.draft.dirty = true; soft(); },
  'pick-sub'(d, el) { S.ws.sub = el.value; renderView(); },
  'pref-quality'(d, el) { me().prefs.quality = el.value; toast('已儲存。'); },
  'js-mode'(d, el) { DB.settings.prov.js.mode = el.value; audit('變更 JustSubtitles 查詢方式', el.value === 'js' ? 'JustSubtitles 介面' : 'SubDL 官方 API'); toast(el.value === 'subdl' && !DB.settings.prov.js.subdlKey ? '已切換,但還沒有 SubDL 金鑰,查詢會失敗。' : '已切換查詢方式。'); },
  'ds-res'(d, el) { S.draft.proxyRes = el.value; S.draft.dirty = true; soft(); },
  'audit-user'(d, el) { S.auditFilter.u = el.value; soft(); }
};
const BIND = {
  'exp-name'(v) { expDraft(tor(S.route.tid)).name = v; },
  limit(v) { S.limitDraft = v; soft(); },
  'inv-role'(v) { S.newInvite.role = v; }, 'inv-days'(v) { S.newInvite.days = v; },
  'src-ytsBase'(v) { S.src.ytsBase = v; }, 'src-yifyBase'(v) { S.src.yifyBase = v; }, 'src-cacheH'(v) { S.src.cacheH = v; }
};

/* ---------- forms ---------- */
const FORM = {
  login(f) {
    const id = f.user.value.trim().toLowerCase(), pass = f.pass.value, u = user(id);
    S.auth.user = f.user.value; S.auth.pass = pass;
    S.auth.error = !id ? '請輸入帳號。' : !pass ? '請輸入密碼。' : !u ? '帳號或密碼不正確。' : u.disabled ? '這個帳號已被停用,請聯絡管理員。' : '';
    if (S.auth.error) { render(); return; }
    DB.me = id; audit('登入', 'MacBook Air · Chrome'); go('search');
  },
  register(f) {
    const r = S.reg, e = r.errors = {}, inv = DB.invites.find((i) => i.code === f.code.value.trim().toUpperCase());
    ['code', 'name', 'user', 'pass', 'pass2'].forEach((k) => { r[k] = f[k].value; });
    if (!inv) e.code = '找不到這個邀請碼,請確認有沒有打錯。'; else if (inv.state === 'expired') e.code = '這個邀請碼已經過期,請管理員再給你一個新的。'; else if (inv.state === 'used') e.code = '這個邀請碼已經用過了。';
    if (!r.name.trim()) e.name = '請填顯示名稱。'; else if (r.name.trim().length > 20) e.name = '顯示名稱最多 20 個字。';
    if (!/^[A-Za-z0-9_]{3,}$/.test(r.user.trim())) e.user = '帳號要是英文、數字或底線,至少 3 個字。'; else if (user(r.user.trim().toLowerCase())) e.user = '這個帳號已經有人用了。';
    if (r.pass.length < 8) e.pass = '密碼至少要 8 個字。';
    if (r.pass2 !== r.pass) e.pass2 = '兩次輸入的密碼不一樣。';
    if (Object.keys(e).length) { render(); const bad = document.querySelector('.auth .err'); if (bad) bad.closest('.field').querySelector('input').focus(); return; }
    const id = r.user.trim().toLowerCase();
    DB.users.push({ id, name: r.name.trim(), role: inv.role, disabled: false, last: '現在', devices: [['這台裝置', '這台裝置']] });
    inv.state = 'used'; inv.expires = '由 ' + r.name.trim() + ' 使用'; DB.me = id; audit('用邀請碼註冊', inv.code);
    S.reg = { code: '', name: '', user: '', pass: '', pass2: '', errors: {} }; go('search'); toast('歡迎,' + me().name + '。先搜尋一部電影試試。');
  },
  gsearch(f) { runSearch(f.q.value.trim()); },
  search(f) { runSearch(f.q.value.trim()); },
  'profile-name'(f) { const v = f.name.value.trim(); if (!v || v.length > 20) { toast('顯示名稱要 1 到 20 個字。'); return; } me().name = v; soft(true); toast('名稱已更新。'); },
  password(f) {
    const e = S.pw.errors = {};
    if (!f.old.value) e.old = '請輸入目前的密碼。';
    if (f.neu.value.length < 8) e.neu = '新密碼至少要 8 個字。';
    if (f.neu2.value !== f.neu.value) e.neu2 = '兩次輸入的新密碼不一樣。';
    if (Object.keys(e).length) { renderView(); return; }
    audit('變更密碼', ''); renderView(); toast('密碼已變更。其他裝置需要重新登入。');
  },
  'invite-new'() {
    const n = S.newInvite, abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', part = () => Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
    DB.invites.unshift({ code: part() + '-' + part(), role: n.role, by: DB.me, expires: n.days + ' 天後到期', state: 'open' });
    audit('建立邀請', (n.role === 'admin' ? '管理員' : '成員') + ' · ' + n.days + ' 天有效'); renderView(); toast('邀請連結已建立。複製後私下傳給對方。');
  },
  limit() {
    const s = DB.settings, d = (S.limitDraft != null ? S.limitDraft : String(s.limitGB)).trim(), v = Number(d), max = s.physicalGB - s.reserveGB;
    if (!/^\d+$/.test(d) || v < 1 || v > max) { $('#limit').focus(); return; }
    if (v === s.limitGB) { toast('上限沒有變。'); return; }
    audit('變更容量上限', gb(s.limitGB) + ' → ' + gb(v)); s.limitGB = v; S.limitDraft = null; soft(true);
    toast(usage().over ? '上限已改成 ' + gb(v) + '。目前超過上限,下載與匯出會被擋下。' : '上限已改成 ' + gb(v) + '。');
  },
  'src-yts'() {
    const d = S.src, v = d.ytsBase.trim(); d.err = {};
    if (!/^https:\/\/[^\s/]+\.[^\s/]+\/?$/.test(v)) { d.err.ytsBase = '請填完整的網址,以 https:// 開頭,例如 https://yts.example。'; renderView(); $('#yts-base').focus(); return; }
    DB.settings.ytsBase = v.replace(/\/$/, ''); d.ytsBase = DB.settings.ytsBase; audit('更新 YTS 網址', DB.settings.ytsBase); renderView(); toast('YTS 網址已儲存。按「測試連線」確認能不能用。');
  },
  'src-yify'() { const d = S.src, v = d.yifyBase.trim(); if (!/^https:\/\/\S+\.\S+$/.test(v)) { toast('請填以 https:// 開頭的完整網址。'); return; } DB.settings.prov.yify.base = v; audit('更新 YIFY Subtitles 網址', v); toast('網址已儲存。'); },
  'src-common'() { const d = S.src, v = d.cacheH.trim(); d.err = {}; if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 168) { d.err.cacheH = '請填 1 到 168 之間的整數。'; renderView(); $('#cache-h').focus(); return; } DB.settings.cacheH = Number(v); audit('變更快取時間', v + ' 小時'); renderView(); toast('已儲存。'); },
  'dl-settings'() {
    const d = S.draft, e = d.err = {}, int = (k, lo, hi, msg) => { const v = d[k].trim(); if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) e[k] = msg; return Number(v); };
    const a = int('maxActive', 1, 5, '請填 1 到 5 之間的整數。'), p = int('maxPerUser', 1, 5, '請填 1 到 5 之間的整數。');
    if (!e.maxPerUser && !e.maxActive && p > a) e.maxPerUser = '不能大於全站上限(' + a + ')。';
    const dn = int('downKB', 0, 1000000, '請填 0 以上的整數,0 表示不限。'), up = int('upKB', 0, 1000000, '請填 0 以上的整數,0 表示不限。'), port = int('port', 1024, 65535, '連入埠要在 1024 到 65535 之間。');
    if (Object.keys(e).length) { renderView(); const bad = $('#view .err'); if (bad) bad.closest('.field').querySelector('input').focus(); return; }
    Object.assign(DB.settings, { maxActive: a, maxPerUser: p, downKB: dn, upKB: up, port, seed: d.seed, proxyAuto: d.proxyAuto, proxyRes: d.proxyRes, analyze: d.analyze });
    S.draft = null; schedule(); audit('變更下載設定', '同時 ' + a + ' 部 · 每人 ' + p + ' 部'); soft(true); toast('下載設定已儲存。');
  }
};

/* ---------- event wiring ---------- */
document.addEventListener('click', (e) => {
  if (e.target.closest('#bench')) return;
  const el = e.target.closest('[data-go],[data-act]');
  if (!el) { if (S.pop && !e.target.closest('.pop')) { S.pop = null; if (DB.me) renderTop(); } return; }
  if (el.getAttribute('aria-disabled') === 'true') { toast('還沒有已確認的字幕。先到「同步」確認一條。'); return; }
  const d = el.dataset;
  if (d.act) { if (ACT[d.act]) ACT[d.act](d, el); return; }
  const p = {}; if (d.id) p.id = d.id; if (d.tid) p.tid = d.tid; if (d.tab) p.tab = d.tab;
  go(d.go, p);
});
document.addEventListener('change', (e) => {
  const el = e.target, d = el.dataset;
  if (el.closest('#bench')) return;
  if (el.id === 'sub-file') { if (el.files[0]) addUpload(el.files[0]); el.value = ''; return; }
  if (d.filter) { S.filters[d.filter] = el.value; soft(); return; }
  if (d.toggle === 'dl.all') { S.dl.all = el.checked; soft(); return; }
  const k = d.actChange || d.change;
  if (k && CHANGE[k]) CHANGE[k](d, el);
});
document.addEventListener('input', (e) => {
  const el = e.target, d = el.dataset;
  if (el.closest('#bench')) return;
  if (el.id === 'sq' || el.id === 'gq') { S.q = el.value; return; }
  if (!d.bind) return;
  if (d.bind.indexOf('ds-') === 0) { S.draft[d.bind.slice(3)] = el.value; if (!S.draft.dirty) { S.draft.dirty = true; soft(); } return; }
  if (BIND[d.bind]) BIND[d.bind](el.value);
});
document.addEventListener('submit', (e) => {
  const f = e.target; if (f.closest('#bench')) return;
  e.preventDefault();
  if (FORM[f.dataset.form]) FORM[f.dataset.form](f.elements);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !DB.me) return;
  if (S.pop) { S.pop = null; renderTop(); } else if (S.confirm) { S.confirm = null; renderView(); }
});
document.addEventListener('bench:status', (e) => {
  if (!DB.me || !onRoute('work') || S.ws.tab !== 'sync') return;
  const s = DB.subs.find((x) => x.id === S.ws.sub);
  if (!s || !e.detail.confirmed || s.status === 'confirmed') return;
  const t = tor(s.t);
  s.status = 'confirmed'; s.score = Math.round(e.detail.score * 100); s.by = DB.me;
  audit('確認字幕同步', movie(t.m).title + ' · ' + LANG[s.lang]);
  others(t).forEach((h) => notify(h, me().name + ' 把 ' + movie(t.m).title + ' 的' + LANG[s.lang] + '字幕對好了', ['work', t.id]));
  renderView(); toast(LANG[s.lang] + '字幕已確認,可以匯出了。', { label: '前往匯出', go: ['work', { tid: t.id, tab: 'export' }] });
});

/* ---------- simulated clock ---------- */
setInterval(() => {
  const structural = tick();
  if (!DB.me) return;
  renderMeter();
  const n = S.route.name;
  if (structural) { renderSide(); if (['downloads', 'library', 'movie', 'storage', 'a-overview', 'a-storage', 'a-system'].indexOf(n) >= 0 || (n === 'work' && S.ws.tab !== 'subs')) soft(); return; }
  if (n === 'downloads') DB.torrents.forEach((t) => {
    if (t.status !== 'downloading') return;
    const bar = document.getElementById('bar-' + t.id), meta = document.getElementById('meta-' + t.id);
    if (bar) bar.style.width = Math.round(t.progress * 100) + '%';
    if (meta) meta.textContent = Math.round(t.progress * 100) + '% · ' + t.speed.toFixed(1) + ' MB/s · ' + t.peers + ' 個節點 · ' + etaText(t);
  });
  if (n === 'work') DB.exports.forEach((x) => {
    if (x.status !== 'running') return;
    const bar = document.getElementById('ebar-' + x.id), meta = document.getElementById('emeta-' + x.id);
    if (bar) bar.style.width = Math.round(x.p * 100) + '%';
    if (meta) meta.textContent = '封裝中 ' + Math.round(x.p * 100) + '%';
  });
}, 1000);

/* ---------- start ---------- */
(() => {
  const h = (location.hash || '').replace('#', '');
  if (h === 'invite') S.route = { name: 'invite' };
  render();
})();
