/* Platform prototype, part 2: app state, shell, and the pages every signed-in person sees. */

const S = {
  route: { name: 'login' },
  auth: { user: 'brian', pass: 'demo', error: '' },
  reg: { code: 'K7QF-2M9D', name: '', user: '', pass: '', pass2: '', errors: {} },
  q: '', qApplied: '', filters: { quality: 'all', genre: 'all', rating: '0', sort: 'new' }, searching: false,
  blocked: null, confirm: null, pop: null,
  lib: { filter: 'all' }, dl: { all: true },
  ws: { tab: 'subs', sub: null }, subSearch: {}, exp: {},
  draft: null, flash: {}, pw: { errors: {} }, newInvite: { role: 'member', days: '3' }, auditFilter: { u: 'all' }
};

const NAV = [['search', '搜尋'], ['downloads', '下載'], ['library', '片庫'], ['storage', '儲存空間'], ['profile', '個人設定']];
const ADMIN_NAV = [['a-overview', '總覽'], ['a-users', '使用者與邀請'], ['a-storage', '儲存空間管理'], ['a-sources', '來源設定'], ['a-downloads', '下載設定'], ['a-system', '系統狀態'], ['a-audit', '操作紀錄']];
const navKey = () => ({ movie: 'search', work: 'library' }[S.route.name] || S.route.name);

const st = (kind, text) => `<span class="st ${kind}">${esc(text)}</span>`;
const poster = (m, cls) => `<div class="poster ${cls || ''}" style="--p:${m.color}"><b>${esc(m.title)}</b><span>${m.year} · ${m.min} 分</span></div>`;
const thumb = (m) => `<div class="thumb" style="--p:${m.color}" aria-hidden="true"><span>${m.year}</span></div>`;
const opt = (value, label, cur) => `<option value="${esc(value)}"${String(cur) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
const confirmBox = (key, text, yes, act, data) => `<div class="confirm" role="alert"><span>${text}</span><span class="frow"><button class="danger" type="button" data-act="${act}" ${data || ''}>${esc(yes)}</button><button type="button" data-act="confirm-off">先不要</button></span></div>`;

function usageBar(u, big) {
  const seg = (cls, v) => (v > 0 ? `<i class="${cls}" style="width:${pctOf(v, Math.max(u.limit, u.used)).toFixed(2)}%"></i>` : '');
  return `<div class="usage${big ? ' big' : ''}" role="img" aria-label="已用 ${gb(u.used)},上限 ${gb(u.limit)}">${seg('u-mv', u.movies)}${seg('u-ex', u.exports)}${seg('u-px', u.proxies)}${seg('u-rs', u.reserved)}${seg('u-pt', u.partial)}</div>`;
}
function usageLegend(u) {
  const row = (cls, name, v) => `<li><i class="${cls}"></i>${name} <b class="mono">${gb(v)}</b></li>`;
  return `<ul class="ulegend">${row('u-mv', '影片', u.movies)}${row('u-ex', '匯出的 MKV', u.exports)}${row('u-px', '預覽檔', u.proxies)}${row('u-rs', '下載中預留', u.reserved)}${row('u-pt', '失敗下載的殘留', u.partial)}</ul>`;
}

/* ---------- signed-out pages ---------- */
function vLogin() {
  const a = S.auth;
  return `<div class="auth"><div class="box">
    <div class="mark"><i aria-hidden="true"></i><h1>拍板</h1></div>
    <p class="lead">登入後才能搜尋、下載與處理字幕。</p>
    <form data-form="login" class="stack" novalidate>
      <label class="field" for="login-user"><span>帳號</span><input id="login-user" name="user" autocomplete="username" value="${esc(a.user)}"></label>
      <label class="field" for="login-pass"><span>密碼</span><input id="login-pass" name="pass" type="password" autocomplete="current-password" value="${esc(a.pass)}"></label>
      ${a.error ? `<p class="err" role="alert">${esc(a.error)}</p>` : ''}
      <button class="primary" type="submit">登入</button>
    </form>
    <p class="alt">拿到邀請連結了?<button class="link" type="button" data-go="invite">用邀請碼註冊</button></p>
    <p class="alt">忘記密碼請找管理員,他可以產生一次性的重設連結。</p>
    <div class="demo"><h2>原型捷徑</h2><p>示範帳號的密碼填什麼都能登入。停用的帳號可以用 <span class="mono">yu</span> 試。</p>
      <div class="frow"><button type="button" data-act="quick-login" data-user="brian">以管理員 Brian 進入</button><button type="button" data-act="quick-login" data-user="mei">以成員 美玲 進入</button></div></div>
  </div></div>`;
}
function vInvite() {
  const r = S.reg, e = r.errors, f = (id, label, type, val, hint) => `<label class="field" for="reg-${id}"><span>${label}</span><input id="reg-${id}" name="${id}" type="${type}" value="${esc(val)}"${id === 'pass' || id === 'pass2' ? ' autocomplete="new-password"' : ''}>${e[id] ? `<small class="err" role="alert">${esc(e[id])}</small>` : hint ? `<small>${hint}</small>` : ''}</label>`;
  return `<div class="auth"><div class="box">
    <div class="mark"><i aria-hidden="true"></i><h1>加入拍板</h1></div>
    <p class="lead">這裡只開放受邀的人。邀請碼由管理員產生,用過一次就失效。</p>
    <form data-form="register" class="stack" novalidate>
      ${f('code', '邀請碼', 'text', r.code, '示範用的有效邀請碼已經填好;過期的可以用 B3TX-88LP 試。')}
      ${f('name', '顯示名稱', 'text', r.name, '其他人在共用的影片上會看到這個名字。')}
      ${f('user', '帳號', 'text', r.user, '英文或數字,至少 3 個字。')}
      ${f('pass', '密碼', 'password', r.pass, '至少 8 個字。')}
      ${f('pass2', '再輸入一次密碼', 'password', r.pass2, '')}
      <button class="primary" type="submit">建立帳號</button>
    </form>
    <p class="alt">已經有帳號?<button class="link" type="button" data-go="login">回到登入</button></p>
  </div></div>`;
}

/* ---------- shell ---------- */
function popBell() {
  const items = DB.activity.filter((a) => a.to === DB.me).slice(0, 6);
  return `<div class="pop" role="dialog" aria-label="通知"><div class="pop-head"><b>通知</b><button class="link" type="button" data-act="read-all">全部標為已讀</button></div>
    ${items.length ? items.map((a, i) => `<button class="pop-item${a.unread ? ' unread' : ''}" type="button" data-act="open-activity" data-i="${DB.activity.indexOf(a)}"><span>${esc(a.text)}</span><small>${esc(a.when)}</small></button>`).join('') : '<p class="sub pad">目前沒有通知。</p>'}</div>`;
}
function popUser() {
  const u = me(), other = u.role === 'admin' ? 'mei' : 'brian';
  return `<div class="pop" role="dialog" aria-label="帳號選單"><div class="pop-head"><b>${esc(u.name)}</b><span class="sub">${u.role === 'admin' ? '管理員' : '成員'}</span></div>
    <button class="pop-item" type="button" data-go="profile"><span>個人設定</span></button>
    <button class="pop-item" type="button" data-act="quick-login" data-user="${other}"><span>改用 ${esc(uname(other))}(${user(other).role === 'admin' ? '管理員' : '成員'})的身分看</span><small>原型捷徑</small></button>
    <button class="pop-item" type="button" data-act="reset-demo"><span>重設示範資料</span><small>原型捷徑</small></button>
    <button class="pop-item" type="button" data-act="logout"><span>登出</span></button></div>`;
}
function renderTop() {
  const u = usage(), unread = DB.activity.filter((a) => a.to === DB.me && a.unread).length;
  const cls = u.over || u.free < 0.5 ? 'bad' : u.free < 2 ? 'warn' : 'ok';
  $('#top').innerHTML = `
    <button class="brand" data-go="search" type="button"><i aria-hidden="true"></i>拍板</button>
    <form class="gsearch" data-form="gsearch" role="search">
      <input id="gq" type="search" name="q" placeholder="搜尋電影,例如 charade" aria-label="搜尋電影" value="${esc(S.q)}">
      <button type="submit">搜尋</button>
    </form>
    <div class="right">
      <button class="meter ${cls}" id="meter" data-go="storage" type="button" title="儲存空間"><span class="bar"><i id="meter-bar" style="width:${pctOf(u.used, u.limit).toFixed(1)}%"></i></span><span class="mono" id="meter-text">${gb(u.used)} / ${gb(u.limit)}</span></button>
      <button data-act="pop" data-pop="bell" type="button" aria-expanded="${S.pop === 'bell'}">通知${unread ? ` <span class="count">${unread}</span>` : ''}</button>
      <button class="avatar" data-act="pop" data-pop="user" type="button" aria-label="帳號選單" aria-expanded="${S.pop === 'user'}">${esc(me().name.slice(0, 1))}</button>
      ${S.pop === 'bell' ? popBell() : ''}${S.pop === 'user' ? popUser() : ''}
    </div>`;
}
function renderMeter() {
  const u = usage(), m = $('#meter'); if (!m) return;
  m.className = 'meter ' + (u.over || u.free < 0.5 ? 'bad' : u.free < 2 ? 'warn' : 'ok');
  $('#meter-bar').style.width = pctOf(u.used, u.limit).toFixed(1) + '%';
  $('#meter-text').textContent = gb(u.used) + ' / ' + gb(u.limit);
}
function renderSide() {
  const cur = navKey(), mineActive = DB.torrents.filter((t) => t.holders.includes(DB.me) && ['downloading', 'queued', 'paused', 'analyzing'].includes(t.status)).length;
  const link = ([k, label]) => `<button type="button" data-go="${k}"${cur === k ? ' aria-current="page"' : ''}><span>${label}</span>${k === 'downloads' && mineActive ? `<span class="count" id="dl-count">${mineActive}</span>` : ''}</button>`;
  $('#side').innerHTML = NAV.map(link).join('') + (isAdmin() ? '<h2>管理</h2>' + ADMIN_NAV.map(link).join('') : '');
}

/* ---------- search ---------- */
function searchMovies() {
  const raw = S.qApplied.trim(), q = raw.toLowerCase(), f = S.filters;
  const list = MOVIES.filter((m) => {
    if (q && !(m.title.toLowerCase().includes(q) || (m.zh && m.zh.includes(raw)) || String(m.year) === q)) return false;
    if (f.quality !== 'all' && !m.v.some((v) => v.q === f.quality)) return false;
    if (f.genre !== 'all' && !m.genres.includes(f.genre)) return false;
    return m.rating >= Number(f.rating);
  });
  const key = { new: (m) => m.order, rating: (m) => -m.rating, year: (m) => -m.year, seeds: (m) => -Math.max(...m.v.map((v) => v.seeds)) }[f.sort];
  return list.sort((a, b) => key(a) - key(b));
}
function movieMark(m) {
  const ts = DB.torrents.filter((t) => t.m === m.id && t.holders.includes(DB.me));
  if (ts.some((t) => t.status === 'done')) return st('ok', '已在片庫');
  if (ts.some((t) => ['downloading', 'queued', 'analyzing', 'paused'].includes(t.status))) return st('info', '下載中');
  return '';
}
function vSearch() {
  const f = S.filters;
  let body;
  if (DB.sim.ytsDown) {
    body = `<div class="banner bad" role="alert"><b>連不上 YTS。</b> 它的網域常常更換,可能又換了。${isAdmin() ? '到「來源設定」更新網址後再試。' : '請管理員到「來源設定」更新網址。'}
      <span class="frow"><button type="button" data-act="search-retry">再試一次</button>${isAdmin() ? '<button type="button" data-go="a-sources">前往來源設定</button>' : ''}</span></div>`;
  } else if (S.searching) {
    body = `<div class="mgrid" aria-busy="true">${Array.from({ length: 6 }, () => '<div class="mcard skel"><div class="poster"></div><span class="mt">&nbsp;</span><span class="ms">&nbsp;</span></div>').join('')}</div>`;
  } else {
    const list = searchMovies();
    body = list.length ? `<div class="mgrid">${list.map((m) => `<button class="mcard" type="button" data-go="movie" data-id="${m.id}">${poster(m)}
        <span class="mt">${esc(m.title)}</span><span class="ms">${m.zh ? esc(m.zh) + ' · ' : ''}${m.year} · <span class="mono">★ ${m.rating.toFixed(1)}</span></span>
        <span class="qs">${Array.from(new Set(m.v.map((v) => v.q))).map((q) => `<i>${q}</i>`).join('')}</span>${movieMark(m)}</button>`).join('')}</div>`
      : `<div class="empty"><b>找不到${S.qApplied ? '「' + esc(S.qApplied) + '」' : '符合條件的電影'}。</b><p>YTS 的片名是英文。試試英文片名、年份,或放寬篩選條件。</p><button type="button" data-act="search-clear">清除搜尋與篩選</button></div>`;
  }
  const n = DB.sim.ytsDown || S.searching ? '' : searchMovies().length + ' 部';
  return `<div class="head"><div><h1>搜尋</h1><p class="sub">片名來自 YTS,以英文為主;中文片名和年份也找得到。</p></div></div>
    <form class="filters" data-form="search" role="search">
      <input id="sq" type="search" name="q" value="${esc(S.q)}" placeholder="片名或年份,例如 charade、大都會、1963" aria-label="搜尋電影">
      <label class="chk" for="f-quality">畫質 <select id="f-quality" data-filter="quality">${opt('all', '全部', f.quality)}${opt('720p', '720p', f.quality)}${opt('1080p', '1080p', f.quality)}${opt('2160p', '2160p', f.quality)}</select></label>
      <label class="chk" for="f-genre">類型 <select id="f-genre" data-filter="genre">${opt('all', '全部', f.genre)}${GENRES.map((g) => opt(g, g, f.genre)).join('')}</select></label>
      <label class="chk" for="f-rating">評分 <select id="f-rating" data-filter="rating">${opt('0', '不限', f.rating)}${opt('6', '6 分以上', f.rating)}${opt('7', '7 分以上', f.rating)}${opt('8', '8 分以上', f.rating)}</select></label>
      <label class="chk" for="f-sort">排序 <select id="f-sort" data-filter="sort">${opt('new', '最新上架', f.sort)}${opt('rating', '評分', f.sort)}${opt('year', '年份', f.sort)}${opt('seeds', '做種數', f.sort)}</select></label>
      <button class="primary" type="submit">搜尋</button>
    </form>
    <div class="rhead"><h2>${S.qApplied ? '「' + esc(S.qApplied) + '」的結果' : '最新上架'}</h2><span class="sub">${n}${n ? ' · ' : ''}示範資料</span></div>
    ${body}`;
}

/* ---------- movie page ---------- */
function versionCell(m, v) {
  const t = DB.torrents.find((x) => x.m === m.id && x.v === v.i), d = `data-m="${m.id}" data-v="${v.i}"`;
  if (!t) return v.seeds === 0 ? `${st('warn', '目前沒有人做種')} <button ${d} data-act="download" type="button">仍要下載</button>` : `<button class="strong" ${d} data-act="download" type="button">下載</button>`;
  const mine = t.holders.includes(DB.me), who = t.holders.map(uname).join('、');
  if (t.status === 'done') return mine ? `${st('ok', '已在片庫')} <button data-go="work" data-tid="${t.id}" type="button">開啟</button>` : `${st('mute', who + ' 已下載')} <button ${d} data-act="join" type="button">加入我的片庫</button>`;
  if (t.status === 'failed') return `${st('bad', '下載失敗')}${mine ? ` <button data-act="retry" data-tid="${t.id}" type="button">重試</button>` : ''}`;
  const label = t.status === 'queued' ? '排隊中' : t.status === 'paused' ? '已暫停' : t.status === 'analyzing' ? '分析中' : '下載中 ' + Math.round(t.progress * 100) + '%';
  return mine ? `${st('info', label)} <button data-go="downloads" type="button">查看</button>` : `${st('info', who + ':' + label)} <button ${d} data-act="join" type="button">加入我的片庫</button>`;
}
function vMovie() {
  const m = movie(S.route.id); if (!m) return vMissing();
  const u = usage();
  const rows = m.v.map((v) => {
    const b = S.blocked && S.blocked.m === m.id && S.blocked.v === v.i ? S.blocked : null;
    return `<tr><td><b>${v.q}</b> <span class="sub">${v.src}</span><br><span class="mono hash" title="info hash">${v.hash.slice(0, 8)}…${v.hash.slice(-4)}</span></td>
      <td class="mono">${v.codec} · ${v.bit}-bit</td><td>${v.audio}</td><td class="num">${gb(v.gb)}</td><td class="num">${v.seeds} / ${v.peers}</td>
      <td>${v.direct ? st('ok', '可直接預覽') : st('warn', '需要轉預覽檔')}</td><td class="act">${versionCell(m, v)}</td></tr>
      ${b ? `<tr class="blocked"><td colspan="7"><div class="banner bad" role="alert"><b>空間不足。</b> 這個版本 ${gb(v.gb)}${proxyFor(m, v) ? ',加上預覽檔約 ' + gb(proxyFor(m, v)) : ''},目前剩 ${gb(u.free)},還差 ${gb(b.need)}。先刪掉不需要的影片或匯出檔,再回來下載。
        <span class="frow"><button type="button" data-go="storage">前往儲存空間</button><button type="button" data-act="unblock">知道了</button></span></div></td></tr>` : ''}`;
  }).join('');
  return `<div class="crumbs"><button class="link" type="button" data-go="search">← 回到搜尋</button></div>
    <section class="mhead">${poster(m, 'lg')}
      <div class="minfo"><h1>${esc(m.title)}</h1>
        <p class="sub">${m.zh ? esc(m.zh) + ' · ' : ''}${m.year} · ${m.min} 分鐘 · ${m.genres.map(esc).join('、')} · <span class="mono">★ ${m.rating.toFixed(1)}</span></p>
        <p class="plot">${esc(m.plot)}</p>
        <p class="sub">容量:已用 ${gb(u.used)},上限 ${gb(u.limit)},還能放 <b>${gb(u.free)}</b>。</p>${usageBar(u)}</div></section>
    <section class="card"><h2>可下載的版本</h2>
      <div class="tw"><table><thead><tr><th>畫質</th><th>編碼</th><th>音訊</th><th class="num">大小</th><th class="num">做種 / 下載</th><th>同步時的預覽</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="sub">已經有人下載過的版本可以直接加入你的片庫,不會多佔空間。x265 和 2160p 的版本瀏覽器不一定能播,下載後會另外轉一份預覽檔,只用來對字幕。</p></section>`;
}
function vMissing() { return `<div class="empty"><b>找不到這個頁面。</b><p>它可能已經被刪除。</p><button type="button" data-go="search">回到搜尋</button></div>`; }
function vForbidden() { return `<div class="empty"><b>這一頁只有管理員能看。</b><p>需要調整設定請找管理員。</p><button type="button" data-go="search">回到搜尋</button></div>`; }

/* ---------- downloads ---------- */
function dlRow(t) {
  const m = movie(t.m), v = tv(t), mine = t.holders.includes(DB.me), p = Math.round(t.progress * 100), b = (act, label) => `<button type="button" data-act="${act}" data-tid="${t.id}">${label}</button>`;
  let chip, meta, acts = '';
  if (t.status === 'downloading') { chip = st('info', '下載中'); meta = `${p}% · ${t.speed.toFixed(1)} MB/s · ${t.peers} 個節點 · ${etaText(t)}`; acts = b('pause', '暫停') + b('cancel-ask', '取消'); }
  else if (t.status === 'paused') { chip = st('mute', '已暫停'); meta = `${p}% · 暫停中,空間仍然保留`; acts = b('resume', '繼續') + b('cancel-ask', '取消'); }
  else if (t.status === 'queued') { chip = st('mute', '排隊中'); meta = `第 ${DB.torrents.filter((x) => x.status === 'queued').indexOf(t) + 1} 順位 · 全站同時最多下載 ${DB.settings.maxActive} 部`; acts = b('cancel-ask', '取消'); }
  else if (t.status === 'analyzing') { chip = st('info', '分析中'); meta = '下載完成,正在產生波形與人聲區段'; }
  else if (t.status === 'failed') { chip = st('bad', '失敗'); meta = `${t.error}。已下載的 ${gb(t.partial)} 還留在磁碟上,移除後才會釋放。`; acts = b('retry', '重試') + b('cancel-ask', '移除'); }
  else { chip = st('ok', '完成'); meta = `${t.when}完成` + (t.proxy ? (t.proxy.st === 'ready' ? ' · 預覽檔已就緒' : ` · 預覽檔轉檔中 ${Math.round(t.proxy.p * 100)}%,可以先用只有聲音的模式對字幕`) : ''); acts = `<button type="button" data-go="work" data-tid="${t.id}">開啟</button>`; }
  if (S.confirm === 'cancel:' + t.id) acts = confirmBox('', t.status === 'failed' ? `移除這筆紀錄並刪除殘留的 ${gb(t.partial)}?` : '取消下載並刪除已下載的部分?', t.status === 'failed' ? '移除' : '取消下載', 'cancel', `data-tid="${t.id}"`);
  if (!mine) acts = '';
  return `<article class="dl" data-tid="${t.id}">${thumb(m)}
    <div class="dl-main"><div class="dl-title"><b>${esc(m.title)}</b> <span class="sub">${esc(vline(v))}${isAdmin() && S.dl.all ? ' · ' + esc(t.holders.map(uname).join('、')) : ''}</span></div>
      ${t.status === 'done' ? '' : `<div class="prog${t.status === 'failed' ? ' bad' : ''}"><i id="bar-${t.id}" style="width:${p}%"></i></div>`}
      <div class="dl-meta" id="meta-${t.id}">${esc(meta)}</div></div>
    <div class="dl-act">${chip}${acts}</div></article>`;
}
function vDownloads() {
  const scope = (t) => (isAdmin() && S.dl.all) || t.holders.includes(DB.me);
  const all = DB.torrents.filter(scope), act = all.filter((t) => ['downloading', 'paused', 'queued', 'analyzing'].includes(t.status)), bad = all.filter((t) => t.status === 'failed'), done = all.filter((t) => t.status === 'done').slice(0, 6);
  const sec = (title, list, empty) => `<section class="card"><h2>${title}</h2>${list.length ? list.map(dlRow).join('') : `<p class="sub">${empty}</p>`}</section>`;
  return `<div class="head"><div><h1>下載</h1><p class="sub">全站同時最多下載 ${DB.settings.maxActive} 部,其餘排隊。原型裡的進度是加速模擬的。</p></div>
      ${isAdmin() ? `<label class="chk" for="dl-all"><input type="checkbox" id="dl-all" data-toggle="dl.all"${S.dl.all ? ' checked' : ''}> 顯示所有人的下載</label>` : ''}</div>
    ${sec('進行中與排隊', act, '目前沒有下載。到搜尋找一部電影開始。')}
    ${bad.length ? sec('需要處理', bad, '') : ''}
    ${sec('最近完成', done, '還沒有完成的下載。')}`;
}

/* ---------- library ---------- */
function libInfo(t) {
  const subs = DB.subs.filter((s) => s.t === t.id), ex = DB.exports.filter((e) => e.t === t.id);
  return { subs, conf: subs.filter((s) => s.status === 'confirmed').length, drafts: subs.filter((s) => s.status === 'draft').length, ex };
}
function vLibrary() {
  const mineAll = DB.torrents.filter((t) => t.status === 'done' && t.holders.includes(DB.me));
  const test = { all: () => true, nosub: (i) => !i.subs.length, draft: (i) => i.drafts > 0 && !i.conf, confirmed: (i) => i.conf > 0 && !i.ex.length, exported: (i) => i.ex.length > 0 }[S.lib.filter];
  const list = mineAll.filter((t) => test(libInfo(t)));
  const chips = [['all', '全部'], ['nosub', '還沒有字幕'], ['draft', '字幕還沒確認'], ['confirmed', '可以匯出'], ['exported', '已匯出']]
    .map(([k, label]) => `<button type="button" data-act="lib-filter" data-k="${k}" aria-pressed="${S.lib.filter === k}">${label} <span class="mono">${mineAll.filter((t) => ({ all: () => true, nosub: (i) => !i.subs.length, draft: (i) => i.drafts > 0 && !i.conf, confirmed: (i) => i.conf > 0 && !i.ex.length, exported: (i) => i.ex.length > 0 }[k])(libInfo(t))).length}</span></button>`).join('');
  const card = (t) => {
    const m = movie(t.m), v = tv(t), i = libInfo(t), o = others(t);
    const next = !i.subs.length ? ['subs', '找字幕'] : !i.conf ? ['sync', '同步字幕'] : !i.ex.length ? ['export', '匯出 MKV'] : ['export', '查看匯出檔'];
    const subText = !i.subs.length ? '還沒有字幕' : (i.conf ? i.conf + ' 條已確認' : '') + (i.conf && i.drafts ? '、' : '') + (i.drafts ? i.drafts + ' 條還沒確認' : '');
    const last = t.holders.length === 1;
    return `<article class="lib">${poster(m, 'sm')}
      <div class="lib-main"><h2><button class="link" type="button" data-go="work" data-tid="${t.id}">${esc(m.title)}</button></h2>
        <p class="sub">${m.zh ? esc(m.zh) + ' · ' : ''}${m.year} · ${esc(vline(v))}</p>
        <ol class="flow"><li class="done">影片已下載</li><li class="${i.conf ? 'done' : i.subs.length ? 'part' : 'todo'}">字幕:${subText}</li><li class="${i.ex.length ? 'done' : 'todo'}">${i.ex.length ? '已匯出 ' + i.ex.length + ' 個 MKV' : '還沒匯出'}</li></ol>
        ${o.length ? `<p class="sub">與 ${esc(o.map(uname).join('、'))} 共用,不重複佔空間。</p>` : ''}
        ${S.confirm === 'unhold:' + t.id ? confirmBox('', last ? `你是最後一位持有人。移除會刪除影片 ${gb(v.gb)}${t.proxy ? '和預覽檔 ' + gb(t.proxy.gb) : ''},字幕也會一起刪掉。匯出的 MKV 不受影響。` : `從你的片庫移除?${esc(o.map(uname).join('、'))} 還持有這部片,檔案不會刪除,也不會釋放空間。`, '移除', 'unhold', `data-tid="${t.id}"`) : ''}</div>
      <div class="lib-act"><button class="strong" type="button" data-go="work" data-tid="${t.id}" data-tab="${next[0]}">${next[1]}</button><button type="button" data-act="confirm" data-key="unhold:${t.id}">從片庫移除</button></div></article>`;
  };
  return `<div class="head"><div><h1>片庫</h1><p class="sub">你下載或加入的電影。每一部依序是:影片、字幕、匯出。</p></div></div>
    <div class="fchips" role="group" aria-label="篩選">${chips}</div>
    ${list.length ? `<div class="libs">${list.map(card).join('')}</div>` : mineAll.length ? '<div class="empty"><b>這個分類裡沒有電影。</b><p>換一個篩選條件看看。</p></div>'
      : '<div class="empty"><b>片庫還是空的。</b><p>到搜尋找一部電影,下載完成後會出現在這裡。</p><button type="button" data-go="search">前往搜尋</button></div>'}`;
}

/* ---------- one movie: subtitles, sync, export ---------- */
function searchState(t) {
  return S.subSearch[t.id] || (S.subSearch[t.id] = { st: 'idle', prov: {}, cands: [], scores: {}, ranked: false, ranking: false, langs: DB.settings.langs.slice(), uploads: [] });
}
function tabSubs(t) {
  const ss = searchState(t), added = DB.subs.filter((s) => s.t === t.id);
  const langBtn = (k) => `<button type="button" data-act="sub-lang" data-k="${k}" aria-pressed="${ss.langs.includes(k)}">${LANG[k]}</button>`;
  const provChip = (k) => {
    const p = ss.prov[k], on = DB.settings.prov[k] && DB.settings.prov[k].on;
    if (!on) return `<li>${st('mute', PROVIDERS[k].name + ':已停用')}</li>`;
    if (k === 'zmk') return `<li>${st('mute', '字幕庫:由你手動下載')}</li>`;
    if (!p) return `<li>${st('mute', PROVIDERS[k].name + ':還沒查')}</li>`;
    if (p.st === 'run') return `<li>${st('info', PROVIDERS[k].name + ':查詢中…')}</li>`;
    if (p.st === 'err') return `<li>${st('bad', PROVIDERS[k].name + ':' + p.msg)} <button type="button" data-act="sub-retry" data-k="${k}">重試</button></li>`;
    return `<li>${st('ok', PROVIDERS[k].name + ':' + p.n + ' 筆')}</li>`;
  };
  const show = (c) => (c.lang === '?' ? true : c.lang === 'zh' ? ss.langs.includes('zh-Hant') : ss.langs.includes(c.lang));
  let cands = ss.cands.concat(ss.uploads).filter(show);
  if (ss.ranked) cands = cands.slice().sort((a, b) => (ss.scores[b.id] || 0) - (ss.scores[a.id] || 0));
  const best = {}, group = (c) => (c.lang === 'zh' ? 'zh-Hant' : c.lang);
  if (ss.ranked) cands.forEach((c) => { if (!best[group(c)] && ss.scores[c.id] != null) best[group(c)] = c.id; });
  const row = (c) => {
    const has = added.some((s) => s.rel === c.rel), sc = ss.scores[c.id];
    return `<tr><td>${esc(PROVIDERS[c.p].name)}</td><td>${esc(LANG[c.lang])}${c.label ? ` <span class="sub mono">${esc(c.label)}</span>` : ''}</td>
      <td class="rel"><span class="mono">${esc(c.rel)}</span><br><span class="sub">${c.by ? esc(c.by) + ' 上傳' : ''}${c.tags.map((g) => ` <i class="tagx${g === 'yts' ? ' hit' : ''}">${TAGS[g]}</i>`).join('')}</span></td>
      <td class="num">${sc != null ? `<b class="mono ${sc >= 70 ? 'good' : sc >= 55 ? 'warn' : 'bad'}">${sc}%</b>${best[group(c)] === c.id ? ' ' + st('ok', '建議') : ''}` : ss.ranking ? '<span class="sub">計算中…</span>' : '<span class="sub">—</span>'}</td>
      <td class="act">${has ? st('ok', '已加入') : `<button type="button" data-act="sub-add" data-c="${c.id}">加入</button>`}</td></tr>`;
  };
  const addedRows = added.map((s) => `<tr><td>${esc(LANG[s.lang])}</td><td>${esc(PROVIDERS[s.p].name)}</td><td class="rel"><span class="mono">${esc(s.rel)}</span></td>
      <td>${s.status === 'confirmed' ? st('ok', '已確認' + (s.score ? ' · ' + s.score + '%' : '')) : st('warn', '還沒確認' + (s.score ? ' · ' + s.score + '%' : ''))} <span class="sub">${esc(uname(s.by))}</span></td>
      <td class="act">${S.confirm === 'sub-del:' + s.id ? confirmBox('', '移除這條字幕和它的同步結果?', '移除', 'sub-del', `data-s="${s.id}"`) : `<button class="strong" type="button" data-act="sync-sub" data-s="${s.id}">${s.status === 'confirmed' ? '重新同步' : '同步'}</button><button type="button" data-act="confirm" data-key="sub-del:${s.id}">移除</button>`}</td></tr>`).join('');
  return `<section class="card"><h2>這部片的字幕</h2>
      ${added.length ? `<div class="tw"><table><thead><tr><th>語言</th><th>來源</th><th>版本名稱</th><th>狀態</th><th></th></tr></thead><tbody>${addedRows}</tbody></table></div><p class="sub">同一部片的字幕和同步結果由所有持有人共用:有人對好了,其他人就不用再對一次。</p>`
        : '<p class="sub">還沒有加入任何字幕。從下面的來源找一條,或自己上傳。</p>'}</section>
    <section class="card"><h2>從所有來源找字幕</h2>
      <div class="frow"><span class="sub">語言</span><span class="fchips" role="group" aria-label="語言">${['zh-Hant', 'zh-Hans', 'en'].map(langBtn).join('')}</span>
        <button class="primary" type="button" data-act="sub-search"${ss.st === 'run' ? ' aria-busy="true"' : ''}>${ss.st === 'idle' ? '搜尋所有來源' : ss.st === 'run' ? '搜尋中…' : '重新搜尋'}</button>
        ${ss.cands.length ? `<button type="button" data-act="sub-rank">${ss.ranking ? '對齊中…' : ss.ranked ? '重新排名' : '全部自動對齊並排名'}</button>` : ''}</div>
      <ul class="provs">${['js', 'yify', 'assrt', 'zmk'].map(provChip).join('')}</ul>
      ${cands.length ? `<div class="tw"><table><thead><tr><th>來源</th><th>語言</th><th>版本名稱</th><th class="num">對齊分數</th><th></th></tr></thead><tbody>${cands.map(row).join('')}</tbody></table></div>
        <p class="sub">來源標的語言不一定準(繁體常被歸在簡體底下),下載後會依內容重新判斷。對齊分數要先按「全部自動對齊並排名」才會算。</p>`
        : ss.st === 'idle' ? '<p class="sub">會同時查 JustSubtitles、YIFY Subtitles 和射手網(偽);任何一個失敗都不影響其他來源。</p>' : ss.st === 'done' ? '<p class="sub">選取的語言沒有結果。換個語言,或自己上傳。</p>' : ''}</section>
    <section class="two">
      <div class="card"><h2>字幕庫</h2><p class="sub">字幕庫用驗證碼擋自動存取,所以這一步由你來:</p>
        <ol class="howto"><li>開啟它的搜尋頁,通過驗證後下載壓縮檔</li><li>把壓縮檔拖到右邊的上傳區</li></ol>
        <button type="button" data-act="zmk-open">開啟字幕庫的搜尋頁</button></div>
      <div class="card"><h2>自己上傳</h2>
        <label class="drop" id="drop" for="sub-file"><b>把字幕或壓縮檔拖到這裡</b><span class="sub">也可以點一下選檔。支援 .srt、.ass、.vtt、.zip、.rar、.7z</span>
          <input id="sub-file" type="file" accept=".srt,.ass,.ssa,.vtt,.zip,.rar,.7z" hidden></label></div>
    </section>`;
}
function tabSync(t) {
  const subs = DB.subs.filter((s) => s.t === t.id), v = tv(t);
  if (!subs.length) return `<div class="empty"><b>還沒有可以同步的字幕。</b><p>先到「字幕」分頁加入一條。</p><button type="button" data-act="ws-tab" data-tab="subs">前往字幕</button></div>`;
  if (!subs.some((s) => s.id === S.ws.sub)) S.ws.sub = (subs.find((s) => s.status === 'draft') || subs[0]).id;
  const cur = subs.find((s) => s.id === S.ws.sub);
  const prev = v.direct ? '這個版本瀏覽器可以直接播放。' : t.proxy && t.proxy.st === 'ready' ? `這個版本是 ${v.codec},預覽用的是另外轉好的 480p 預覽檔(${gb(t.proxy.gb)}),時間和原檔完全一致。` : `這個版本是 ${v.codec},預覽檔還在轉(${t.proxy ? Math.round(t.proxy.p * 100) : 0}%)。可以先用只有聲音的模式對字幕。`;
  return `<section class="card syncpick"><div class="frow"><label class="field" for="ws-sub"><span>正在同步的字幕</span>
        <select id="ws-sub" data-change="pick-sub">${subs.map((s) => opt(s.id, LANG[s.lang] + ' · ' + PROVIDERS[s.p].name + (s.status === 'confirmed' ? ' · 已確認' : ''), S.ws.sub)).join('')}</select></label>
        <span>${cur.status === 'confirmed' ? st('ok', '已確認' + (cur.score ? ' · ' + cur.score + '%' : '')) : st('warn', '還沒確認')}</span></div>
      <p class="sub">${prev} 在下面的工作台按「確認同步」後,這條字幕就會標成已確認,可以到「匯出」封裝。</p></section>`;
}
function expDraft(t) {
  const m = movie(t.m), v = tv(t);
  const d = S.exp[t.id] || (S.exp[t.id] = { on: {}, def: null, name: m.title.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '') + '.' + m.year + '.' + v.q + '.zh-TW.mkv', err: '' });
  const conf = DB.subs.filter((s) => s.t === t.id && s.status === 'confirmed');
  conf.forEach((s) => { if (d.on[s.id] == null) d.on[s.id] = true; });
  if (!conf.some((s) => s.id === d.def && d.on[s.id])) d.def = (conf.find((s) => d.on[s.id]) || {}).id || null;
  return d;
}
function tabExport(t) {
  const v = tv(t), d = expDraft(t), subs = DB.subs.filter((s) => s.t === t.id), conf = subs.filter((s) => s.status === 'confirmed'), u = usage(), ok = u.used + v.gb <= u.limit + 1e-9;
  const mine = DB.exports.filter((e) => e.t === t.id);
  const track = (s) => `<tr><td><label class="chk" for="tr-${s.id}"><input type="checkbox" id="tr-${s.id}" data-act-change="exp-on" data-s="${s.id}"${d.on[s.id] ? ' checked' : ''}> ${esc(LANG[s.lang])}</label></td><td>${esc(PROVIDERS[s.p].name)}</td>
      <td><span class="mono">${s.lang === 'en' ? 'en' : s.lang === 'zh-Hans' ? 'zh-CN' : 'zh-TW'}</span></td><td><label class="chk" for="def-${s.id}"><input type="radio" name="def" id="def-${s.id}" data-act-change="exp-def" data-s="${s.id}"${d.def === s.id ? ' checked' : ''}${d.on[s.id] ? '' : ' disabled'}> 預設顯示</label></td></tr>`;
  const exRow = (e) => `<tr><td class="rel"><span class="mono">${esc(e.name)}</span><br><span class="sub">${esc(e.tracks.join('、'))} · ${esc(uname(e.by))} · ${esc(e.when)}</span></td><td class="num">${gb(e.gb)}</td>
      <td>${e.status === 'running' ? `<div class="prog"><i id="ebar-${e.id}" style="width:${Math.round(e.p * 100)}%"></i></div><span class="sub" id="emeta-${e.id}">封裝中 ${Math.round(e.p * 100)}%</span>` : st('ok', '可以下載')}</td>
      <td class="act">${e.status !== 'done' ? '' : S.confirm === 'exp-del:' + e.id ? confirmBox('', `刪除這個匯出檔,釋放 ${gb(e.gb)}?`, '刪除', 'exp-del', `data-e="${e.id}"`) : `<button class="strong" type="button" data-act="exp-get" data-e="${e.id}">下載</button>${e.by === DB.me || isAdmin() ? `<button type="button" data-act="confirm" data-key="exp-del:${e.id}">刪除</button>` : ''}`}</td></tr>`;
  const pending = subs.filter((s) => s.status !== 'confirmed');
  return `<section class="card"><h2>要封裝的字幕軌</h2>
      ${conf.length ? `<div class="tw"><table><thead><tr><th>字幕</th><th>來源</th><th>語言標籤</th><th>預設</th></tr></thead><tbody>${conf.map(track).join('')}</tbody></table></div>` : '<p class="sub">還沒有已確認的字幕。只有確認過同步的字幕才能封裝。</p>'}
      ${pending.length ? `<p class="sub">還有 ${pending.length} 條字幕沒確認:${pending.map((s) => esc(LANG[s.lang])).join('、')}。<button class="link" type="button" data-act="ws-tab" data-tab="sync">去同步</button></p>` : ''}
      <label class="field" for="exp-name"><span>檔名</span><input id="exp-name" class="mono" data-bind="exp-name" value="${esc(d.name)}">${d.err ? `<small class="err" role="alert">${esc(d.err)}</small>` : '<small>影像和聲音直接複製,不重新編碼,畫質不變。</small>'}</label>
      <div class="banner ${ok ? 'info' : 'bad'}" role="${ok ? 'note' : 'alert'}">${ok ? `匯出檔約 ${gb(v.gb)},和原檔一樣大。目前剩 ${gb(u.free)},匯出後剩 ${gb(u.free - v.gb)}。` : `<b>空間不足,不能匯出。</b> 匯出檔約 ${gb(v.gb)},目前只剩 ${gb(u.free)},還差 ${gb(v.gb - u.free)}。<span class="frow"><button type="button" data-go="storage">前往儲存空間</button></span>`}</div>
      <div class="frow"><button class="primary" type="button" data-act="exp-start"${conf.length ? '' : ' aria-disabled="true"'}>開始匯出</button><span class="sub">匯出檔不會自動刪除,會一直算在容量上限裡,直到有人手動刪掉。</span></div></section>
    <section class="card"><h2>這部片的匯出檔</h2>
      ${mine.length ? `<div class="tw"><table><thead><tr><th>檔案</th><th class="num">大小</th><th>狀態</th><th></th></tr></thead><tbody>${mine.map(exRow).join('')}</tbody></table></div><p class="sub">下載連結支援續傳。下載到自己的電腦後,記得回來刪掉這裡的檔案。</p>` : '<p class="sub">還沒有匯出過。</p>'}</section>`;
}
function vWork() {
  const t = tor(S.route.tid);
  if (!t || !t.holders.includes(DB.me) || t.status !== 'done') return vMissing();
  const m = movie(t.m), v = tv(t), i = libInfo(t), o = others(t), tab = S.ws.tab;
  const tabBtn = (k, label, note) => `<button type="button" role="tab" data-act="ws-tab" data-tab="${k}" aria-selected="${tab === k}">${label}<small>${note}</small></button>`;
  return `<div class="crumbs"><button class="link" type="button" data-go="library">← 回到片庫</button></div>
    <section class="whead">${thumb(m)}<div><h1>${esc(m.title)}</h1><p class="sub">${m.zh ? esc(m.zh) + ' · ' : ''}${m.year} · ${esc(vline(v))}${o.length ? ' · 與 ' + esc(o.map(uname).join('、')) + ' 共用' : ''}</p></div></section>
    <div class="tabs" role="tablist" aria-label="處理步驟">${tabBtn('subs', '字幕', i.subs.length ? i.subs.length + ' 條' : '還沒有')}${tabBtn('sync', '同步', i.conf ? i.conf + ' 條已確認' : i.subs.length ? '還沒確認' : '—')}${tabBtn('export', '匯出', i.ex.length ? i.ex.length + ' 個 MKV' : '還沒匯出')}</div>
    ${tab === 'subs' ? tabSubs(t) : tab === 'sync' ? tabSync(t) : tabExport(t)}`;
}

/* ---------- storage (everyone) ---------- */
function vStorage() {
  const u = usage(), mine = DB.torrents.filter((t) => t.holders.includes(DB.me)), ex = DB.exports.filter((e) => e.by === DB.me);
  const rowT = (t) => {
    const m = movie(t.m), v = tv(t), o = others(t), size = t.status === 'failed' ? t.partial : v.gb;
    const kind = t.status === 'done' ? '影片' : t.status === 'failed' ? '失敗下載的殘留' : '下載中預留';
    const key = (t.status === 'done' ? 'unhold:' : 'cancel:') + t.id;
    return `<tr><td>${kind}</td><td><b>${esc(m.title)}</b> <span class="sub">${esc(vlabel(v))}${t.proxy ? ' · 另有預覽檔 ' + gb(t.proxy.gb) : ''}</span></td><td class="num">${gb(size)}</td><td>${o.length ? esc(o.map(uname).join('、')) : '只有你'}</td>
      <td class="act">${S.confirm === key ? confirmBox('', t.status !== 'done' ? '取消並刪除已下載的部分?' : o.length ? `從你的片庫移除?${esc(o.map(uname).join('、'))} 還持有,不會釋放空間。` : `刪除後釋放 ${gb(v.gb + (t.proxy ? t.proxy.gb : 0))},字幕也會一起刪掉。`, t.status === 'done' ? '移除' : '取消下載', t.status === 'done' ? 'unhold' : 'cancel', `data-tid="${t.id}"`)
        : `<button type="button" data-act="confirm" data-key="${key}">${t.status === 'done' ? (o.length ? '從片庫移除' : '刪除') : t.status === 'failed' ? '移除' : '取消下載'}</button>`}</td></tr>`;
  };
  const rowE = (e) => `<tr><td>匯出的 MKV</td><td><span class="mono">${esc(e.name)}</span></td><td class="num">${gb(e.gb)}</td><td>只有你</td>
      <td class="act">${e.status !== 'done' ? st('info', '封裝中') : S.confirm === 'exp-del:' + e.id ? confirmBox('', `刪除後釋放 ${gb(e.gb)}。`, '刪除', 'exp-del', `data-e="${e.id}"`) : `<button type="button" data-act="confirm" data-key="exp-del:${e.id}">刪除</button>`}</td></tr>`;
  const rows = mine.slice().sort((a, b) => tv(b).gb - tv(a).gb).map(rowT).join('') + ex.map(rowE).join('');
  return `<div class="head"><div><h1>儲存空間</h1><p class="sub">全站共用一個容量上限,由管理員設定。</p></div>${isAdmin() ? '<button type="button" data-go="a-storage">管理所有檔案與上限</button>' : ''}</div>
    ${u.over ? `<div class="banner bad" role="alert"><b>已超過容量上限。</b> 用量降到上限以下之前,所有人都不能下載或匯出。不會有任何檔案被自動刪除。</div>` : u.free < 2 ? `<div class="banner warn" role="status"><b>空間快滿了。</b> 只剩 ${gb(u.free)},大一點的版本已經放不下。</div>` : ''}
    <section class="card"><div class="ubig"><b class="mono">${gb(u.used)}</b><span>已用,上限 ${gb(u.limit)},還能放 <b>${gb(u.free)}</b></span></div>${usageBar(u, true)}${usageLegend(u)}</section>
    <section class="card"><h2>規則</h2><ul class="rules"><li>系統不會自動刪除任何檔案。要釋放空間,只能由人手動刪除。</li><li>用量加上新的影片會超過上限時,不能開始下載;匯出 MKV 也一樣要有空間。</li><li>下載一開始就以完整大小佔位,不會下載到一半才發現放不下。</li><li>多人共用的影片只佔一份空間,要所有人都移除才會真的刪檔。</li></ul></section>
    <section class="card"><h2>我持有的項目</h2>${rows ? `<div class="tw"><table><thead><tr><th>類型</th><th>項目</th><th class="num">大小</th><th>誰也持有</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="sub">你還沒有任何檔案。</p>'}</section>`;
}

/* ---------- profile ---------- */
function vProfile() {
  const u = me(), p = u.prefs || (u.prefs = { langs: ['zh-Hant', 'en'], s2t: true, bilingual: false, quality: '1080p' }), e = S.pw.errors;
  const langBox = (k) => `<label class="chk" for="pl-${k}"><input type="checkbox" id="pl-${k}" data-act-change="pref-lang" data-k="${k}"${p.langs.includes(k) ? ' checked' : ''}> ${LANG[k]}</label>`;
  return `<div class="head"><div><h1>個人設定</h1><p class="sub">只影響你自己的帳號。</p></div></div>
    <section class="card"><h2>基本資料</h2>
      <form data-form="profile-name" class="frow"><label class="field" for="pf-name"><span>顯示名稱</span><input id="pf-name" name="name" value="${esc(u.name)}"></label><button type="submit">儲存名稱</button></form></section>
    <section class="card"><h2>字幕偏好</h2>
      <div class="frow"><span>預設要找的語言</span>${['zh-Hant', 'zh-Hans', 'en'].map(langBox).join('')}</div>
      <label class="sw" for="pf-s2t"><input type="checkbox" id="pf-s2t" data-act-change="pref" data-k="s2t"${p.s2t ? ' checked' : ''}><i></i><span>簡體字幕自動轉成繁體</span></label>
      <label class="sw" for="pf-bi"><input type="checkbox" id="pf-bi" data-act-change="pref" data-k="bilingual"${p.bilingual ? ' checked' : ''}><i></i><span>同步頁預設顯示中英雙語</span></label>
      <label class="field" for="pf-q"><span>偏好的畫質</span><select id="pf-q" data-change="pref-quality">${['720p', '1080p', '2160p'].map((q) => opt(q, q, p.quality)).join('')}</select><small>只是在版本清單裡先標出來,不會自動下載。</small></label></section>
    <section class="card"><h2>變更密碼</h2>
      <form data-form="password" class="stack narrow" novalidate>
        <label class="field" for="pw-old"><span>目前的密碼</span><input id="pw-old" name="old" type="password" autocomplete="current-password">${e.old ? `<small class="err" role="alert">${esc(e.old)}</small>` : ''}</label>
        <label class="field" for="pw-new"><span>新密碼</span><input id="pw-new" name="neu" type="password" autocomplete="new-password">${e.neu ? `<small class="err" role="alert">${esc(e.neu)}</small>` : '<small>至少 8 個字。</small>'}</label>
        <label class="field" for="pw-new2"><span>再輸入一次新密碼</span><input id="pw-new2" name="neu2" type="password" autocomplete="new-password">${e.neu2 ? `<small class="err" role="alert">${esc(e.neu2)}</small>` : ''}</label>
        <div><button type="submit">變更密碼</button></div></form></section>
    <section class="card"><h2>登入中的裝置</h2>
      ${u.devices.length ? `<div class="tw"><table><tbody>${u.devices.map((d, i) => `<tr><td>${esc(d[0])}</td><td class="sub">${esc(d[1])}</td><td class="act">${i === 0 ? st('ok', '目前使用中') : `<button type="button" data-act="device-out" data-i="${i}">登出這台</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">沒有其他裝置。</p>'}</section>`;
}
