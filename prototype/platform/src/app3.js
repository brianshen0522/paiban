/* Platform prototype, part 3: administrator pages. */

const HEALTH_NAME = { yts: 'YTS(電影搜尋)', tmdb: 'TMDB(片名與編號對照)', js: 'JustSubtitles', yify: 'YIFY Subtitles', assrt: '射手網(偽)', zmk: '字幕庫' };
const healthChip = (h) => (h[0] === 'ok' ? st('ok', '正常') : h[0] === 'warn' ? st('warn', '有狀況') : h[0] === 'bad' ? st('bad', '連不上') : st('mute', '手動'));

function runningJobs() {
  const out = [];
  DB.torrents.forEach((t) => {
    if (t.status === 'analyzing') out.push({ type: '分析波形與人聲', item: tname(t), st: 'run', note: '進行中' });
    if (t.proxy && t.proxy.st === 'running') out.push({ type: '轉預覽檔', item: tname(t), st: t.status === 'downloading' ? 'wait' : 'run', note: t.status === 'downloading' ? '等下載完成' : Math.round(t.proxy.p * 100) + '%' });
  });
  DB.exports.forEach((e) => { if (e.status === 'running') out.push({ type: '匯出 MKV', item: movie(tor(e.t).m).title, st: 'run', note: Math.round(e.p * 100) + '%' }); });
  return out;
}

function aOverview() {
  const u = usage(), act = DB.torrents.filter((t) => t.status === 'downloading').length, q = DB.torrents.filter((t) => t.status === 'queued').length, jobs = runningJobs();
  const problems = [];
  if (u.over) problems.push(['bad', '用量超過容量上限,所有人都不能下載或匯出。', 'a-storage', '處理']);
  else if (u.free < 2) problems.push(['warn', `容量只剩 ${gb(u.free)}。`, 'a-storage', '查看']);
  DB.torrents.filter((t) => t.status === 'failed').forEach((t) => problems.push(['bad', `下載失敗:${tname(t)}(${uname(t.by)})。${t.error},殘留 ${gb(t.partial)}。`, 'downloads', '查看']));
  Object.keys(DB.health).forEach((k) => { const h = DB.health[k]; if (h[0] === 'warn' || h[0] === 'bad') problems.push([h[0], `${HEALTH_NAME[k]}:${h[2]}。`, 'a-sources', '查看']); });
  if (DB.sim.ytsDown) problems.push(['bad', 'YTS 連不上,搜尋頁目前無法使用。', 'a-sources', '更新網址']);
  DB.jobs.filter((j) => j.st === 'failed').forEach((j) => problems.push(['warn', `${j.type}失敗:${j.item}。${j.note}。`, 'a-system', '查看']));
  const tile = (label, value, note, go) => `<button class="tile" type="button" data-go="${go}"><small>${label}</small><b>${value}</b><span>${note}</span></button>`;
  return `<div class="head"><div><h1>總覽</h1><p class="sub">全站目前的狀況,以及需要你處理的事。</p></div></div>
    <div class="tiles">
      ${tile('容量', gb(u.used), '上限 ' + gb(u.limit) + ',剩 ' + gb(u.free), 'a-storage')}
      ${tile('下載中', act + ' / ' + DB.settings.maxActive, q ? q + ' 部在排隊' : '沒有排隊', 'downloads')}
      ${tile('使用者', DB.users.filter((x) => !x.disabled).length, DB.users.filter((x) => x.disabled).length + ' 個已停用 · ' + DB.invites.filter((i) => i.state === 'open').length + ' 個邀請待用', 'a-users')}
      ${tile('背景任務', jobs.length, jobs.length ? jobs[0].type + ':' + jobs[0].note : '目前沒有任務', 'a-system')}
    </div>
    <section class="card"><h2>需要處理</h2>${problems.length ? `<ul class="plist">${problems.map((p) => `<li>${st(p[0], p[0] === 'bad' ? '問題' : '注意')}<span>${esc(p[1])}</span><button type="button" data-go="${p[2]}">${p[3]}</button></li>`).join('')}</ul>` : '<p class="sub">目前沒有需要處理的事。</p>'}</section>
    <section class="two">
      <div class="card"><h2>來源狀況</h2><div class="tw"><table><tbody>${Object.keys(DB.health).map((k) => `<tr><td>${HEALTH_NAME[k]}</td><td>${k === 'yts' && DB.sim.ytsDown ? st('bad', '連不上') : healthChip(DB.health[k])}</td><td class="sub">${esc(DB.health[k][1])}</td></tr>`).join('')}</tbody></table></div><div><button type="button" data-go="a-sources">來源設定</button></div></div>
      <div class="card"><h2>最近的操作</h2><ul class="feed">${DB.audit.slice(0, 6).map((a) => `<li><span><b>${esc(uname(a.u))}</b> ${esc(a.a)}:${esc(a.o)}</span><small>${esc(a.t)}</small></li>`).join('')}</ul><div><button type="button" data-go="a-audit">全部紀錄</button></div></div>
    </section>`;
}

function aUsers() {
  const row = (u) => {
    const held = DB.torrents.filter((t) => t.holders.includes(u.id) && t.status === 'done').length, active = DB.torrents.filter((t) => t.holders.includes(u.id) && ['downloading', 'queued', 'paused'].includes(t.status)).length;
    const self = u.id === DB.me, sole = DB.torrents.filter((t) => t.holders.length === 1 && t.holders[0] === u.id).length;
    const reset = S.flash.reset && S.flash.reset.id === u.id ? `<div class="banner info" role="status">一次性重設連結,30 分鐘內有效:<span class="mono sel">${esc(S.flash.reset.link)}</span><span class="frow"><button type="button" data-act="copy" data-text="${esc(S.flash.reset.link)}">複製</button><button type="button" data-act="flash-off" data-k="reset">關閉</button></span></div>` : '';
    const acts = self ? '<span class="sub">不能變更自己的角色或停用自己</span>'
      : S.confirm === 'user-del:' + u.id ? confirmBox('', `移除 ${esc(u.name)} 的帳號?${sole ? `他獨自持有的 ${sole} 個項目會留在磁碟上,要到「儲存空間管理」手動刪除。` : '他沒有獨自持有的檔案。'}`, '移除帳號', 'user-del', `data-u="${u.id}"`)
      : `<button type="button" data-act="user-role" data-u="${u.id}">${u.role === 'admin' ? '改為成員' : '設為管理員'}</button><button type="button" data-act="user-toggle" data-u="${u.id}">${u.disabled ? '啟用' : '停用'}</button><button type="button" data-act="user-reset" data-u="${u.id}">重設密碼</button><button type="button" data-act="confirm" data-key="user-del:${u.id}">移除</button>`;
    return `<tr><td><b>${esc(u.name)}</b> <span class="sub mono">${esc(u.id)}</span>${self ? ' <span class="sub">(你)</span>' : ''}</td><td>${u.role === 'admin' ? '管理員' : '成員'}</td><td>${u.disabled ? st('mute', '已停用') : st('ok', '啟用中')}</td><td class="sub">${esc(u.last)}</td><td class="num">${held} 部${active ? ' · ' + active + ' 個下載' : ''}</td><td class="act">${acts}</td></tr>${reset ? `<tr class="blocked"><td colspan="6">${reset}</td></tr>` : ''}`;
  };
  const inv = (i) => `<tr><td class="mono">${esc(i.code)}</td><td>${i.role === 'admin' ? '管理員' : '成員'}</td><td>${i.state === 'open' ? st('ok', '可使用') : i.state === 'used' ? st('mute', '已使用') : st('mute', '已過期')} <span class="sub">${esc(i.expires)}</span></td><td class="sub">${esc(uname(i.by))}</td>
      <td class="act">${i.state === 'open' ? `<button type="button" data-act="copy" data-text="https://paiban.home.example/invite/${esc(i.code)}">複製連結</button><button type="button" data-act="invite-revoke" data-code="${esc(i.code)}">撤銷</button>` : `<button type="button" data-act="invite-revoke" data-code="${esc(i.code)}">清除</button>`}</td></tr>`;
  const n = S.newInvite;
  return `<div class="head"><div><h1>使用者與邀請</h1><p class="sub">只有拿到邀請連結的人能註冊。</p></div></div>
    <section class="card"><h2>使用者</h2><div class="tw"><table><thead><tr><th>使用者</th><th>角色</th><th>狀態</th><th>最近上線</th><th class="num">持有</th><th></th></tr></thead><tbody>${DB.users.map(row).join('')}</tbody></table></div>
      <p class="sub">停用的帳號不能登入,但他持有的檔案不會被動。</p></section>
    <section class="card"><h2>邀請</h2>
      <form data-form="invite-new" class="frow"><label class="chk" for="inv-role">角色 <select id="inv-role" data-bind="inv-role">${opt('member', '成員', n.role)}${opt('admin', '管理員', n.role)}</select></label>
        <label class="chk" for="inv-days">有效期限 <select id="inv-days" data-bind="inv-days">${opt('1', '1 天', n.days)}${opt('3', '3 天', n.days)}${opt('7', '7 天', n.days)}</select></label><button class="primary" type="submit">建立邀請連結</button></form>
      ${DB.invites.length ? `<div class="tw"><table><thead><tr><th>邀請碼</th><th>角色</th><th>狀態</th><th>建立者</th><th></th></tr></thead><tbody>${DB.invites.map(inv).join('')}</tbody></table></div>` : '<p class="sub">目前沒有邀請。</p>'}
      <p class="sub">每個連結只能用一次。把連結私下傳給對方就好。</p></section>`;
}

function aStorage() {
  const u = usage(), s = DB.settings, max = s.physicalGB - s.reserveGB, d = S.limitDraft != null ? S.limitDraft : String(s.limitGB), val = Number(d);
  const items = [];
  DB.torrents.forEach((t) => {
    const m = movie(t.m), v = tv(t);
    items.push({ key: 'tor:' + t.id, kind: t.status === 'done' ? '影片' : t.status === 'failed' ? '失敗下載的殘留' : '下載中預留', name: m.title, sub: vlabel(v), gb: t.status === 'failed' ? t.partial : v.gb, who: t.holders, used: t.used || t.when,
      warn: t.status === 'done' ? `${t.holders.length ? '會從 ' + t.holders.length + ' 位持有人的片庫移除,' : '目前沒有人持有。'}連同字幕${t.proxy ? '和預覽檔' : ''}一起刪掉,釋放 ${gb(v.gb + (t.proxy ? t.proxy.gb : 0))}。匯出的 MKV 不受影響。` : t.status === 'failed' ? `刪除殘留的 ${gb(t.partial)}。` : `取消 ${t.holders.map(uname).join('、')} 的下載並刪除已下載的部分。` });
    if (t.proxy) items.push({ key: 'proxy:' + t.id, kind: '預覽檔', name: m.title, sub: vlabel(v) + ' → 480p', gb: t.proxy.gb, who: t.holders, used: t.proxy.st === 'ready' ? (t.used || '剛剛') : '轉檔中', warn: '刪除預覽檔。之後有人要同步這部片時會重新轉檔。' });
  });
  DB.exports.forEach((e) => items.push({ key: 'exp:' + e.id, kind: '匯出的 MKV', name: e.name, sub: '', gb: e.gb, who: [e.by], used: e.when, warn: `刪除 ${uname(e.by)} 的匯出檔,釋放 ${gb(e.gb)}。`, mono: true }));
  items.sort((a, b) => b.gb - a.gb);
  let limitNote = `磁碟共 ${gb(s.physicalGB)},系統保留 ${gb(s.reserveGB)},所以上限最多 ${gb(max)}。`, cls = '';
  if (d !== String(s.limitGB)) {
    if (!/^\d+$/.test(d.trim()) || val < 1) { limitNote = '上限要填 1 以上的整數(GB)。'; cls = 'err'; }
    else if (val > max) { limitNote = `超過磁碟能提供的空間。上限最多 ${gb(max)}。`; cls = 'err'; }
    else if (val < u.used) { limitNote = `低於目前用量 ${gb(u.used)}。儲存後不會刪除任何檔案,但在用量降到 ${gb(val)} 以下之前,所有人都不能下載或匯出。`; cls = 'warnt'; }
    else limitNote = `儲存後還能放 ${gb(val - u.used)}。`;
  }
  const row = (it) => `<tr><td>${it.kind}</td><td class="rel">${it.mono ? `<span class="mono">${esc(it.name)}</span>` : `<b>${esc(it.name)}</b> <span class="sub">${esc(it.sub)}</span>`}</td><td class="num">${gb(it.gb)}</td><td>${it.who.length ? esc(it.who.map(uname).join('、')) : '<span class="sub">沒有人</span>'}</td><td class="sub">${esc(it.used)}</td>
      <td class="act">${S.confirm === 'force:' + it.key ? confirmBox('', esc(it.warn), '刪除', 'force-del', `data-key="${it.key}"`) : `<button type="button" data-act="confirm" data-key="force:${it.key}">刪除</button>`}</td></tr>`;
  return `<div class="head"><div><h1>儲存空間管理</h1><p class="sub">設定全站的容量上限,並檢視、刪除任何人的檔案。</p></div><button type="button" data-act="rescan">重新計算用量</button></div>
    <section class="card"><div class="ubig"><b class="mono">${gb(u.used)}</b><span>已用,上限 ${gb(u.limit)},還能放 <b>${gb(u.free)}</b></span></div>${usageBar(u, true)}${usageLegend(u)}</section>
    <section class="card"><h2>容量上限</h2>
      <form data-form="limit" class="frow" novalidate><label class="field" for="limit"><span>上限(GB)</span><input id="limit" class="mono" inputmode="numeric" data-bind="limit" value="${esc(d)}"></label><button class="primary" type="submit">${cls === 'warnt' ? '仍要儲存' : '儲存上限'}</button></form>
      <p class="${cls || 'sub'}" id="limit-note"${cls === 'err' ? ' role="alert"' : ''}>${limitNote}</p>
      <p class="sub">達到上限時,新的下載和匯出會被擋下。系統不會自動刪除任何檔案,要釋放空間只能在下面手動刪除。</p></section>
    <section class="card"><h2>所有檔案,由大到小</h2><div class="tw"><table><thead><tr><th>類型</th><th>項目</th><th class="num">大小</th><th>持有人</th><th>最後使用</th><th></th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div></section>`;
}

function aSources() {
  const s = DB.settings, d = S.src || (S.src = { ytsBase: s.ytsBase, yifyBase: s.prov.yify.base, mode: s.prov.js.mode, cacheH: String(s.cacheH), err: {} });
  const res = (k) => { const f = S.flash['test:' + k]; return f ? (f.run ? ' <span class="sub">測試中…</span>' : ' ' + st(f.ok ? 'ok' : 'bad', f.text)) : ''; };
  const sw = (k, label) => `<label class="sw" for="prov-${k}"><input type="checkbox" id="prov-${k}" data-act-change="prov-on" data-k="${k}"${s.prov[k].on ? ' checked' : ''}><i></i><span>${label}</span></label>`;
  const secret = (id, label, has, hint) => `<label class="field" for="${id}"><span>${label}</span><input id="${id}" class="mono" type="password" autocomplete="off" placeholder="${has ? '已設定,留空表示不變' : '還沒設定'}"><small>${hint}</small></label>`;
  return `<div class="head"><div><h1>來源設定</h1><p class="sub">電影搜尋和字幕各來源的連線設定。金鑰儲存後不會再顯示。</p></div></div>
    <section class="card"><h2>YTS ${DB.sim.ytsDown ? st('bad', '連不上') : healthChip(DB.health.yts)}</h2>
      <form data-form="src-yts" class="stack" novalidate>
        <label class="field" for="yts-base"><span>API 網址</span><input id="yts-base" class="mono" data-bind="src-ytsBase" value="${esc(d.ytsBase)}">${d.err.ytsBase ? `<small class="err" role="alert">${esc(d.err.ytsBase)}</small>` : '<small>YTS 的網域常常更換,冒牌站也很多。這裡由你手動填目前可用的網域,系統不會自己去找。</small>'}</label>
        <div class="frow"><button class="primary" type="submit">儲存網址</button><button type="button" data-act="test" data-k="yts">測試連線</button>${res('yts')}</div></form>
      <label class="chk proto" for="sim-yts"><input type="checkbox" id="sim-yts" data-act-change="sim-yts"${DB.sim.ytsDown ? ' checked' : ''}> 原型開關:模擬 YTS 連不上,看搜尋頁的錯誤狀態</label></section>
    <section class="card"><h2>TMDB ${healthChip(DB.health.tmdb)}</h2><p class="sub">用來把 YTS 給的 IMDb 編號換成 TMDB 編號(JustSubtitles 需要),並取得中文片名(射手網的關鍵字搜尋需要)。</p>
      ${secret('tmdb-key', 'API 金鑰', s.tmdbKey, '在 TMDB 帳號設定裡免費申請。')}<div class="frow"><button type="button" data-act="save-secret" data-k="TMDB 金鑰">儲存金鑰</button><button type="button" data-act="test" data-k="tmdb">測試</button>${res('tmdb')}</div></section>
    <section class="card"><h2>JustSubtitles ${healthChip(DB.health.js)}</h2>${sw('js', '啟用這個來源')}
      <label class="field" for="js-mode"><span>查詢方式</span><select id="js-mode" data-change="js-mode">${opt('js', 'JustSubtitles 的介面(不需要金鑰,需要 TMDB 編號)', s.prov.js.mode)}${opt('subdl', 'SubDL 官方 API(同一批字幕,需要金鑰,每天 2,000 次)', s.prov.js.mode)}</select>
        <small>JustSubtitles 的字幕來自 SubDL。它的介面沒有公開文件,隨時可能改;改了就切到 SubDL 官方 API。</small></label>
      ${secret('subdl-key', 'SubDL API 金鑰(備援用)', s.prov.js.subdlKey, '只有切到 SubDL 官方 API 時才會用到。')}
      <p class="sub">每種語言最多 30 筆,查詢結果快取 24 小時。語言代碼:<span class="mono">EN、ZH、ZH_BG</span>。</p>
      <div class="frow"><button type="button" data-act="save-secret" data-k="SubDL 金鑰">儲存金鑰</button><button type="button" data-act="test" data-k="js">測試</button>${res('js')}</div></section>
    <section class="card"><h2>YIFY Subtitles ${healthChip(DB.health.yify)}</h2>${sw('yify', '啟用這個來源')}
      <form data-form="src-yify" class="stack" novalidate><label class="field" for="yify-base"><span>網址</span><input id="yify-base" class="mono" data-bind="src-yifyBase" value="${esc(d.yifyBase)}"><small>沒有 API,是解析網頁。版面一改就要更新程式。</small></label>
        <div class="frow"><button type="submit">儲存網址</button><button type="button" data-act="test" data-k="yify">測試</button>${res('yify')}</div></form></section>
    <section class="card"><h2>射手網(偽) ${healthChip(DB.health.assrt)}</h2>${sw('assrt', '啟用這個來源')}
      ${secret('assrt-token', 'API token', s.prov.assrt.token, '在射手網(偽)註冊後,從使用者面板取得。')}
      <p class="sub">每個 token 每分鐘 20 次,超過會自動延後再查。它的使用條款要求標示來源,所以字幕清單會顯示「射手網(偽)」和連結。</p>
      ${DB.health.assrt[0] === 'warn' ? `<div class="banner warn" role="status">${esc(DB.health.assrt[2])}。<span class="frow"><button type="button" data-act="health-clear" data-k="assrt">知道了</button></span></div>` : ''}
      <div class="frow"><button type="button" data-act="save-secret" data-k="射手網 token">儲存 token</button><button type="button" data-act="test" data-k="assrt">測試</button>${res('assrt')}</div></section>
    <section class="card"><h2>字幕庫 ${st('mute', '手動')}</h2>${sw('zmk', '在字幕頁顯示字幕庫的入口')}
      <p class="sub">字幕庫用驗證碼擋自動存取,系統不會自動抓。字幕頁會提供它的搜尋連結,由使用者自己下載後上傳。</p></section>
    <section class="card"><h2>共用設定</h2>
      <form data-form="src-common" class="frow" novalidate><label class="field" for="cache-h"><span>查詢結果快取(小時)</span><input id="cache-h" class="mono" inputmode="numeric" data-bind="src-cacheH" value="${esc(d.cacheH)}">${d.err.cacheH ? `<small class="err" role="alert">${esc(d.err.cacheH)}</small>` : ''}</label><button type="submit">儲存</button></form>
      <p class="sub">新帳號預設要找的語言:${s.langs.map((l) => LANG[l]).join('、')}。每個人可以在個人設定裡改自己的。</p></section>`;
}

function aDownloads() {
  const s = DB.settings, d = S.draft || (S.draft = { maxActive: String(s.maxActive), maxPerUser: String(s.maxPerUser), downKB: String(s.downKB), upKB: String(s.upKB), port: String(s.port), seed: s.seed, proxyAuto: s.proxyAuto, proxyRes: s.proxyRes, analyze: s.analyze, err: {}, dirty: false });
  const num = (k, label, hint) => `<label class="field" for="ds-${k}"><span>${label}</span><input id="ds-${k}" class="mono" inputmode="numeric" data-bind="ds-${k}" value="${esc(d[k])}">${d.err[k] ? `<small class="err" role="alert">${esc(d.err[k])}</small>` : `<small>${hint}</small>`}</label>`;
  return `<div class="head"><div><h1>下載設定</h1><p class="sub">下載、做種與下載完成後的處理。</p></div></div>
    <form data-form="dl-settings" novalidate class="stackwide">
    <section class="card"><h2>數量與速度</h2><div class="fgrid">
      ${num('maxActive', '全站同時下載上限', '超過的會排隊。1 到 5。')}${num('maxPerUser', '每人同時下載上限', '不能大於全站上限。')}
      ${num('downKB', '下載限速(KB/s)', '0 表示不限。')}${num('upKB', '上傳限速(KB/s)', '0 表示不限。')}</div></section>
    <section class="card"><h2>連線</h2><div class="fgrid">${num('port', '連入埠(TCP 和 UDP)', 'Docker 和路由器都要開同一個埠,否則只能主動連出,速度會差。')}</div>
      <div class="frow"><button type="button" data-act="test" data-k="port">測試外部能不能連入</button>${(() => { const f = S.flash['test:port']; return f ? (f.run ? '<span class="sub">測試中…</span>' : st(f.ok ? 'ok' : 'bad', f.text)) : ''; })()}</div></section>
    <section class="card"><h2>做種</h2>
      <label class="chk" for="seed-stop"><input type="radio" name="seed" id="seed-stop" value="stop" data-act-change="ds-seed"${d.seed === 'stop' ? ' checked' : ''}> 下載完成就停止</label>
      <label class="chk" for="seed-ratio"><input type="radio" name="seed" id="seed-ratio" value="ratio" data-act-change="ds-seed"${d.seed === 'ratio' ? ' checked' : ''}> 做種到分享率 1.0 再停止</label>
      <p class="sub">下載過程中本來就會同時上傳給別人,這裡只決定完成後要不要繼續。</p>
      <p class="sub">${st('ok', '已鎖定')} 只接受搜尋結果裡的版本,不能貼上任意的磁力連結。</p></section>
    <section class="card"><h2>下載完成後</h2>
      <label class="sw" for="ds-analyze"><input type="checkbox" id="ds-analyze" data-act-change="ds-flag" data-k="analyze"${d.analyze ? ' checked' : ''}><i></i><span>自動產生波形與人聲區段(同步頁需要,約 40 秒)</span></label>
      <label class="sw" for="ds-proxy"><input type="checkbox" id="ds-proxy" data-act-change="ds-flag" data-k="proxyAuto"${d.proxyAuto ? ' checked' : ''}><i></i><span>瀏覽器不能直接播的版本,自動轉一份預覽檔</span></label>
      <label class="field" for="ds-res"><span>預覽檔解析度</span><select id="ds-res" data-change="ds-res">${opt('480p', '480p(每 2 小時約 340 MB)', d.proxyRes)}${opt('720p', '720p(每 2 小時約 800 MB)', d.proxyRes)}</select><small>預覽檔只用來對字幕,會算在容量上限裡。</small></label></section>
    <div class="frow savebar"><button class="primary" type="submit">儲存設定</button><button type="button" data-act="ds-revert">還原成目前的設定</button>${d.dirty ? '<span class="warnt">有還沒儲存的變更。</span>' : '<span class="sub">沒有未儲存的變更。</span>'}</div></form>`;
}

function aSystem() {
  const run = runningJobs(), jobs = run.concat(DB.jobs.slice(0, 10));
  const chip = (j) => (j.st === 'run' ? st('info', '進行中') : j.st === 'wait' ? st('mute', '等待') : j.st === 'failed' ? st('bad', '失敗') : st('ok', '完成'));
  const svc = [['api', '網站與 API', '運作中', '9 天'], ['torrent', '下載程式(WebTorrent 3.0.21)', '運作中', '9 天'], ['media', '影片處理(ffmpeg 6.1、ffsubsync 0.5.1)', '運作中', '2 天'], ['postgres', '資料庫(PostgreSQL)', '運作中', '9 天']];
  return `<div class="head"><div><h1>系統狀態</h1><p class="sub">各個服務與背景任務。</p></div></div>
    <section class="card"><h2>服務</h2><div class="tw"><table><thead><tr><th>容器</th><th>用途</th><th>狀態</th><th>已運作</th></tr></thead><tbody>${svc.map((x) => `<tr><td class="mono">${x[0]}</td><td>${x[1]}</td><td>${st('ok', x[2])}</td><td class="sub">${x[3]}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub">下載程式獨立一個容器:網站更新重啟時,下載不會中斷。</p></section>
    <section class="card"><h2>背景任務</h2><div class="tw"><table><thead><tr><th>任務</th><th>項目</th><th>狀態</th><th>說明</th><th></th></tr></thead><tbody>${jobs.map((j, i) => `<tr><td>${esc(j.type)}</td><td>${esc(j.item)}</td><td>${chip(j)}</td><td class="sub">${esc(j.note)}</td><td class="act">${j.st === 'failed' ? `<button type="button" data-act="job-retry" data-i="${i - run.length}">重試</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>磁碟</h2><p class="sub">資料磁碟共 ${gb(DB.settings.physicalGB)},系統保留 ${gb(DB.settings.reserveGB)}。容量上限設為 ${gb(DB.settings.limitGB)},目前用了 ${gb(usage().used)}。</p><div><button type="button" data-go="a-storage">儲存空間管理</button></div></section>`;
}

function aAudit() {
  const f = S.auditFilter, list = DB.audit.filter((a) => f.u === 'all' || a.u === f.u);
  return `<div class="head"><div><h1>操作紀錄</h1><p class="sub">誰在什麼時候做了什麼。在原型裡操作,這裡會跟著新增。</p></div>
      <label class="chk" for="audit-user">使用者 <select id="audit-user" data-change="audit-user">${opt('all', '全部', f.u)}${DB.users.map((u) => opt(u.id, u.name, f.u)).join('')}</select></label></div>
    <section class="card">${list.length ? `<div class="tw"><table><thead><tr><th>時間</th><th>使用者</th><th>動作</th><th>對象</th></tr></thead><tbody>${list.map((a) => `<tr><td class="sub">${esc(a.t)}</td><td>${esc(uname(a.u))}</td><td>${esc(a.a)}</td><td>${esc(a.o)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">這位使用者還沒有紀錄。</p>'}</section>`;
}
