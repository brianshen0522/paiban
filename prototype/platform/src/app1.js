/* Platform prototype, part 1: demo data, helpers, and the simulated back end. */
'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (v) => (v >= 0.995 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') + ' GB' : Math.max(0, Math.round(v * 1000 / 10) * 10) + ' MB');
const pctOf = (a, b) => Math.max(0, Math.min(100, (a / b) * 100));

/* ---------- demo data: public-domain classics, with the fields YTS returns ---------- */
// versions: [quality, source, codec, bit depth, audio, size GB, seeds, peers]
const MOVIES = [
  { id: 'notld', title: 'Night of the Living Dead', zh: '活死人之夜', year: 1968, min: 96, genres: ['恐怖'], rating: 7.8, color: '#3a2c2c',
    plot: '一群陌生人躲進鄉間農舍,門外是不斷聚集的活死人,屋裡的人卻先吵了起來。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.88, 412, 38], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.6, 655, 61], ['2160p', 'BluRay', 'x265', 10, 'AAC 5.1', 5.9, 188, 24]] },
  { id: 'charade', title: 'Charade', zh: '謎中謎', year: 1963, min: 113, genres: ['喜劇', '懸疑', '愛情'], rating: 7.9, color: '#7a2f3a',
    plot: '丈夫離奇身亡後,一筆失蹤的鉅款讓她被三個男人追著跑,唯一幫她的人身分卻一變再變。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.0, 301, 22], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.9, 498, 47], ['1080p', 'BluRay', 'x265', 10, 'AAC 5.1', 1.2, 96, 11]] },
  { id: 'hisgirl', title: 'His Girl Friday', zh: '小報妙冤家', year: 1940, min: 92, genres: ['喜劇', '愛情'], rating: 7.8, color: '#2f4a6b',
    plot: '報社主編想留住準備再婚的前妻兼王牌記者,最好的辦法就是丟給她一條大新聞。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.83, 144, 12], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.5, 207, 19]] },
  { id: 'lastman', title: 'The Last Man on Earth', zh: '地球最後一人', year: 1964, min: 86, genres: ['恐怖', '科幻'], rating: 6.7, color: '#4a4f39',
    plot: '瘟疫過後只剩他一個活人,白天獵殺、夜裡死守,日復一日過了三年。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.79, 88, 9], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.5, 131, 17]] },
  { id: 'metropolis', title: 'Metropolis', zh: '大都會', year: 1927, min: 153, genres: ['科幻', '劇情'], rating: 8.3, color: '#8a6a1f',
    plot: '未來都市分成地上的享樂者與地下的勞工,一個機器人被造出來挑起兩邊的衝突。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.3, 320, 26], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 2.7, 541, 52], ['2160p', 'BluRay', 'x265', 10, 'AAC 5.1', 6.8, 163, 30]] },
  { id: 'stranger', title: 'The Stranger', zh: '陌生人', year: 1946, min: 95, genres: ['犯罪', '黑色電影'], rating: 7.3, color: '#26323d',
    plot: '戰犯化名躲在小鎮當老師,追查他的調查員只有一條線索:他對鐘錶的著迷。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.87, 97, 8], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.7, 152, 14]] },
  { id: 'scarlet', title: 'Scarlet Street', zh: '血紅街道', year: 1945, min: 102, genres: ['黑色電影', '劇情'], rating: 7.7, color: '#8c2b22',
    plot: '中年出納員迷上年輕女子,被她和情人一步步騙走了畫作、積蓄與人生。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.93, 76, 7], ['1080p', 'BluRay', 'x265', 10, 'AAC 2.0', 1.1, 58, 9]] },
  { id: 'shop', title: 'The Little Shop of Horrors', zh: '恐怖小店', year: 1960, min: 72, genres: ['喜劇', '恐怖'], rating: 6.2, color: '#2f5a3c',
    plot: '花店小店員養的怪植物只吃一種東西,而且胃口越來越大。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.66, 64, 5], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.2, 91, 8]] },
  { id: 'plan9', title: 'Plan 9 from Outer Space', zh: '外太空九號計劃', year: 1957, min: 79, genres: ['科幻', '恐怖'], rating: 3.9, color: '#3d2f63',
    plot: '外星人為了阻止人類造出毀滅性武器,決定讓死人復活。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.72, 119, 10], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.3, 170, 16]] },
  { id: 'carnival', title: 'Carnival of Souls', zh: '', year: 1962, min: 78, genres: ['恐怖', '懸疑'], rating: 7.0, color: '#4b4b55',
    plot: '車禍中唯一生還的女子搬到新城市,卻不斷被一座廢棄遊樂場和一張蒼白的臉吸引。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.7, 83, 6], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.3, 126, 13]] },
  { id: 'haunted', title: 'House on Haunted Hill', zh: '', year: 1959, min: 75, genres: ['恐怖', '懸疑'], rating: 6.7, color: '#5a3d1e',
    plot: '富翁邀五個陌生人到鬧鬼的大宅過夜,撐到天亮的人各得一萬美元。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.69, 102, 9], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.3, 0, 2]] },
  { id: 'general', title: 'The General', zh: '將軍號', year: 1926, min: 78, genres: ['動作', '喜劇'], rating: 8.1, color: '#6b4a2a',
    plot: '南北戰爭中,火車司機單槍匹馬去追被搶走的火車頭,和車上的未婚妻。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.71, 211, 15], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.3, 344, 29]] },
  { id: 'nosferatu', title: 'Nosferatu', zh: '吸血鬼', year: 1922, min: 94, genres: ['恐怖', '奇幻'], rating: 7.8, color: '#1f3a3a',
    plot: '房地產經紀人遠赴古堡簽約,把一位不該請進城的伯爵帶回了家鄉。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.85, 266, 21], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.5, 389, 35]] },
  { id: 'doa', title: 'D.O.A.', zh: '', year: 1949, min: 83, genres: ['黑色電影', '懸疑'], rating: 7.2, color: '#2c2c33',
    plot: '他走進警局報案:被謀殺的人是他自己,毒發前只剩幾天找出兇手。',
    v: [['720p', 'BluRay', 'x264', 8, 'AAC 2.0', 0.76, 59, 4], ['1080p', 'BluRay', 'x264', 8, 'AAC 2.0', 1.4, 84, 7]] }
];
MOVIES.forEach((m, mi) => {
  m.order = mi;
  m.v = m.v.map((a, i) => {
    let h = 2166136261; const key = m.id + ':' + i + ':' + a[0] + a[2];
    for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 16777619) >>> 0;
    const hex = Array.from({ length: 40 }, () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return (h >>> 28).toString(16); }).join('');
    return { i, q: a[0], src: a[1], codec: a[2], bit: a[3], audio: a[4], gb: a[5], seeds: a[6], peers: a[7], hash: hex, direct: a[2] === 'x264' };
  });
});
const movie = (id) => MOVIES.find((m) => m.id === id);
const GENRES = Array.from(new Set(MOVIES.flatMap((m) => m.genres)));

const PROVIDERS = {
  js: { name: 'JustSubtitles', how: '用 TMDB ID 查它的 JSON 介面' },
  yify: { name: 'YIFY Subtitles', how: '用 IMDb ID 解析網頁' },
  assrt: { name: '射手網(偽)', how: '官方 API,每分鐘 20 次' },
  zmk: { name: '字幕庫', how: '有驗證碼,由你自己下載後拖進來' },
  upload: { name: '手動上傳', how: '' }
};
const LANG = { 'zh-Hant': '繁體中文', 'zh-Hans': '簡體中文', zh: '中文(待判斷)', en: 'English', '?': '語言待判斷' };

function seed() {
  return {
    me: null,
    users: [
      { id: 'brian', name: 'Brian', role: 'admin', disabled: false, last: '現在', devices: [['MacBook Air · Chrome', '這台裝置'], ['iPhone · Safari', '2 天前']] },
      { id: 'mei', name: '美玲', role: 'member', disabled: false, last: '20 分鐘前', devices: [['Windows · Edge', '這台裝置']] },
      { id: 'kai', name: '阿凱', role: 'member', disabled: false, last: '昨天', devices: [['iPad · Safari', '昨天']] },
      { id: 'yu', name: '小宇', role: 'member', disabled: true, last: '2 週前', devices: [] }
    ],
    invites: [
      { code: 'K7QF-2M9D', role: 'member', by: 'brian', expires: '3 天後到期', state: 'open' },
      { code: 'B3TX-88LP', role: 'member', by: 'brian', expires: '已於 4 天前過期', state: 'expired' }
    ],
    settings: {
      limitGB: 26, physicalGB: 32, reserveGB: 2, maxActive: 2, maxPerUser: 2, downKB: 0, upKB: 512, port: 51413, seed: 'stop', proxyAuto: true, proxyRes: '480p', analyze: true,
      ytsBase: 'https://yts.example', tmdbKey: true, langs: ['zh-Hant', 'en'], cacheH: 24,
      prov: { js: { on: true, mode: 'js', subdlKey: false }, yify: { on: true, base: 'https://yts-subs.com' }, assrt: { on: true, token: true }, zmk: { on: true } }
    },
    health: { yts: ['ok', '3 分鐘前', '回應 0.4 秒'], tmdb: ['ok', '3 分鐘前', ''], js: ['ok', '12 分鐘前', '快取 24 小時'], yify: ['ok', '12 分鐘前', ''], assrt: ['warn', '剛剛', '超過每分鐘 20 次的上限,已自動延後'], zmk: ['assist', '', '協助式,不自動連線'] },
    sim: { ytsDown: false, assrtLimited: true },
    torrents: [
      { id: 't1', m: 'notld', v: 1, status: 'done', progress: 1, holders: ['brian', 'mei'], by: 'brian', when: '5 天前', used: '昨天' },
      { id: 't2', m: 'charade', v: 1, status: 'done', progress: 1, holders: ['brian'], by: 'brian', when: '2 小時前', used: '2 小時前' },
      { id: 't3', m: 'hisgirl', v: 0, status: 'done', progress: 1, holders: ['mei'], by: 'mei', when: '上週', used: '6 天前' },
      { id: 't4', m: 'metropolis', v: 2, status: 'done', progress: 1, holders: ['kai'], by: 'kai', when: '上週', used: '3 天前', proxy: { st: 'ready', gb: 0.43, p: 1 } },
      { id: 't5', m: 'stranger', v: 1, status: 'done', progress: 1, holders: ['brian', 'kai'], by: 'kai', when: '4 天前', used: '3 天前' },
      { id: 't6', m: 'lastman', v: 1, status: 'downloading', progress: 0.43, holders: ['brian'], by: 'brian', when: '今天 09:14', speed: 11.8, peers: 37 },
      { id: 't7', m: 'scarlet', v: 1, status: 'downloading', progress: 0.12, holders: ['mei'], by: 'mei', when: '今天 08:57', speed: 6.4, peers: 19 },
      { id: 't8', m: 'carnival', v: 0, status: 'queued', progress: 0, holders: ['kai'], by: 'kai', when: '昨天' },
      { id: 't9', m: 'haunted', v: 1, status: 'failed', progress: 0.23, holders: ['brian'], by: 'brian', when: '昨天', error: '找不到可用的來源(做種數 0)', partial: 0.3 }
    ],
    subs: [
      { id: 's1', t: 't1', p: 'js', lang: 'zh-Hant', rel: 'Night.of.the.Living.Dead.1968.1080p.BluRay.x264.YIFY.cht', status: 'confirmed', score: 81, by: 'brian' },
      { id: 's2', t: 't1', p: 'yify', lang: 'en', rel: 'Night of the Living Dead 1968 1080p BluRay x264 [YTS.AG]', status: 'draft', score: 77, by: 'brian' },
      { id: 's3', t: 't2', p: 'assrt', lang: 'zh-Hant', rel: '謎中謎.Charade.1963.BluRay.1080p.繁體.srt', status: 'draft', score: null, by: 'brian' },
      { id: 's4', t: 't5', p: 'js', lang: 'zh-Hant', rel: 'The.Stranger.1946.1080p.BluRay.x264.YIFY.cht', status: 'confirmed', score: 79, by: 'kai' }
    ],
    exports: [
      { id: 'e1', t: 't1', by: 'brian', name: 'Night.of.the.Living.Dead.1968.1080p.zh-TW.mkv', gb: 1.6, tracks: ['繁體中文'], when: '昨天 22:41', status: 'done', p: 1 },
      { id: 'e2', t: 't5', by: 'kai', name: 'The.Stranger.1946.1080p.zh-TW.mkv', gb: 1.7, tracks: ['繁體中文'], when: '3 天前', status: 'done', p: 1 }
    ],
    jobs: [
      { type: '轉預覽檔', item: 'Metropolis · 2160p', st: 'done', note: '用時 12 分鐘' },
      { type: '分析波形與人聲', item: 'Charade · 1080p', st: 'done', note: '用時 41 秒' },
      { type: '自動對齊', item: 'The Stranger · 繁體中文', st: 'done', note: '用時 1.1 秒' },
      { type: '匯出 MKV', item: 'Night of the Living Dead', st: 'done', note: '用時 38 秒' },
      { type: '自動對齊', item: 'Charade · 繁體中文', st: 'failed', note: '音訊分析還沒完成,已排入重試' }
    ],
    activity: [
      { to: 'brian', text: '下載完成:Charade · 1080p', when: '2 小時前', unread: true, go: ['work', 't2'] },
      { to: 'brian', text: '下載失敗:House on Haunted Hill · 1080p', when: '昨天', unread: true, go: ['downloads'] },
      { to: 'brian', text: '匯出完成:Night of the Living Dead', when: '昨天', unread: false, go: ['work', 't1'] },
      { to: 'mei', text: 'Brian 把 Night of the Living Dead 的繁體中文字幕對好了', when: '昨天', unread: true, go: ['work', 't1'] },
      { to: 'mei', text: '下載完成:His Girl Friday · 720p', when: '上週', unread: false, go: ['work', 't3'] }
    ],
    audit: [
      { t: '今天 09:14', u: 'brian', a: '開始下載', o: 'The Last Man on Earth · 1080p' },
      { t: '今天 09:12', u: 'brian', a: '登入', o: 'MacBook Air · Chrome' },
      { t: '今天 08:57', u: 'mei', a: '開始下載', o: 'Scarlet Street · 1080p x265' },
      { t: '昨天 22:41', u: 'brian', a: '匯出 MKV', o: 'Night of the Living Dead' },
      { t: '昨天 22:30', u: 'brian', a: '確認字幕同步', o: 'Night of the Living Dead · 繁體中文' },
      { t: '昨天 21:05', u: 'brian', a: '變更容量上限', o: '22 GB → 26 GB' },
      { t: '昨天 18:20', u: 'kai', a: '排入下載', o: 'Carnival of Souls · 720p' },
      { t: '3 天前', u: 'kai', a: '匯出 MKV', o: 'The Stranger' },
      { t: '4 天前', u: 'brian', a: '停用帳號', o: '小宇' },
      { t: '5 天前', u: 'brian', a: '建立邀請', o: '成員 · 3 天有效' },
      { t: '6 天前', u: 'brian', a: '更新 YTS 網址', o: '來源設定' }
    ]
  };
}
let DB = seed();
let nextId = 100;
const newId = (p) => p + (nextId += 1);

const user = (id) => DB.users.find((u) => u.id === id);
const me = () => user(DB.me);
const isAdmin = () => !!me() && me().role === 'admin';
const uname = (id) => (user(id) ? user(id).name : id);
const tor = (id) => DB.torrents.find((t) => t.id === id);
const tv = (t) => movie(t.m).v[t.v];
const tname = (t) => movie(t.m).title + ' · ' + vlabel(tv(t));
const vlabel = (v) => v.q + (v.codec === 'x265' ? ' x265' : '');
const vline = (v) => v.q + ' · ' + v.src + ' · ' + v.codec + (v.bit === 10 ? ' 10-bit' : '') + ' · ' + gb(v.gb);
const others = (t) => t.holders.filter((h) => h !== DB.me);

/* ---------- storage rule: one limit, nothing is ever deleted automatically ---------- */
// A version the browser cannot play gets a low-resolution preview after download. Its size is
// estimated from the running time and reserved up front, so it can never push usage past the limit.
const proxyFor = (m, v) => (v.direct || !DB.settings.proxyAuto ? 0 : Math.round((m.min / 120) * (DB.settings.proxyRes === '720p' ? 0.8 : 0.34) * 100) / 100);
const needFor = (m, v) => v.gb + proxyFor(m, v);
function usage() {
  const u = { movies: 0, reserved: 0, partial: 0, proxies: 0, exports: 0 };
  DB.torrents.forEach((t) => {
    const size = tv(t).gb;
    if (t.status === 'done' || t.status === 'analyzing') u.movies += size;
    else if (t.status === 'failed') u.partial += t.partial || 0;
    else u.reserved += size;
    if (t.proxy) u.proxies += t.proxy.gb;
    else if (t.status !== 'done' && t.status !== 'failed') u.reserved += proxyFor(movie(t.m), tv(t));
  });
  DB.exports.forEach((e) => { u.exports += e.gb; });
  u.used = u.movies + u.reserved + u.partial + u.proxies + u.exports;
  u.limit = DB.settings.limitGB;
  u.free = Math.max(0, u.limit - u.used);
  u.over = u.used > u.limit + 1e-9;
  return u;
}
const fits = (size) => usage().used + size <= DB.settings.limitGB + 1e-9;

function audit(a, o) { DB.audit.unshift({ t: '剛剛', u: DB.me, a, o }); }
function notify(to, text, go) { DB.activity.unshift({ to, text, when: '剛剛', unread: true, go }); }

/* ---------- download queue ---------- */
function schedule() {
  const active = () => DB.torrents.filter((t) => t.status === 'downloading');
  const waiting = DB.torrents.filter((t) => t.status === 'queued');
  for (const t of waiting) {
    if (active().length >= DB.settings.maxActive) break;
    if (active().filter((x) => x.by === t.by).length >= DB.settings.maxPerUser) continue;
    t.status = 'downloading'; t.speed = 5 + Math.random() * 8; t.peers = 8 + Math.round(Math.random() * 30);
  }
}

// One simulated second of the back end. Downloads run about ten times faster than real ones.
const SPEEDUP = 10;
function tick() {
  let structural = false;
  DB.torrents.forEach((t) => {
    if (t.status === 'downloading') {
      const v = tv(t);
      t.speed = Math.max(2.5, Math.min(18, t.speed + (Math.random() - 0.5) * 2.4));
      t.peers = Math.max(4, Math.min(60, t.peers + Math.round((Math.random() - 0.5) * 6)));
      t.progress = Math.min(1, t.progress + (t.speed * SPEEDUP) / (v.gb * 1024));
      if (t.progress >= 1) {
        t.status = 'analyzing'; t.left = 4; structural = true;
        if (proxyFor(movie(t.m), v)) t.proxy = { st: 'running', gb: proxyFor(movie(t.m), v), p: 0 };
      }
    } else if (t.status === 'analyzing') {
      t.left -= 1;
      if (t.left <= 0) {
        t.status = 'done'; t.when = '剛剛'; t.used = '剛剛'; structural = true;
        DB.jobs.unshift({ type: '分析波形與人聲', item: tname(t), st: 'done', note: '用時 40 秒' });
        t.holders.forEach((h) => notify(h, '下載完成:' + tname(t), ['work', t.id]));
        if (t.holders.includes(DB.me)) toast('下載完成:' + tname(t), { label: '開啟', go: ['work', { tid: t.id }] });
      }
    }
    if (t.proxy && t.proxy.st === 'running' && t.status !== 'downloading') {
      t.proxy.p = Math.min(1, t.proxy.p + 0.07);
      if (t.proxy.p >= 1) { t.proxy.st = 'ready'; structural = true; DB.jobs.unshift({ type: '轉預覽檔', item: tname(t), st: 'done', note: '用時 9 分鐘' }); }
    }
  });
  DB.exports.forEach((e) => {
    if (e.status !== 'running') return;
    e.p = Math.min(1, e.p + 0.18);
    if (e.p >= 1) {
      e.status = 'done'; e.when = '剛剛'; structural = true;
      DB.jobs.unshift({ type: '匯出 MKV', item: movie(tor(e.t).m).title, st: 'done', note: '用時 36 秒' });
      notify(e.by, '匯出完成:' + movie(tor(e.t).m).title, ['work', e.t]);
      if (e.by === DB.me) toast('匯出完成:' + e.name);
    }
  });
  const before = DB.torrents.filter((t) => t.status === 'downloading').length;
  schedule();
  if (DB.torrents.filter((t) => t.status === 'downloading').length !== before) structural = true;
  return structural;
}

function etaText(t) {
  const v = tv(t), left = (1 - t.progress) * v.gb * 1024 / t.speed;
  return left < 60 ? '剩不到 1 分鐘' : '剩約 ' + Math.round(left / 60) + ' 分鐘';
}

/* ---------- subtitle candidates (what the provider adapters would return) ---------- */
function candidatesFor(t) {
  const m = movie(t.m), v = tv(t), dot = m.title.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  return [
    { id: 'js1', p: 'js', lang: 'zh-Hant', label: 'ZH_BG', rel: dot + '.' + m.year + '.' + v.q + '.' + v.src + '.x264.YIFY.cht', by: 'sub_tw', tags: ['yts'], base: 81 },
    { id: 'js2', p: 'js', lang: 'zh-Hans', label: 'ZH', rel: dot + '.' + m.year + '.BluRay.720p.x264-CHD.chs', by: 'lin_88', tags: ['s2t'], base: 57 },
    { id: 'js3', p: 'js', lang: 'en', label: 'EN', rel: dot + '.' + m.year + '.' + v.q + '.' + v.src + '.x264-[YTS.AG]', by: 'YTSDD', tags: ['yts'], base: 83 },
    { id: 'js4', p: 'js', lang: 'en', label: 'EN', rel: dot + '.' + m.year + '.REMASTERED.BluRay.x264-AMIABLE', by: 'movie_99', tags: ['hi'], base: 62 },
    { id: 'yf1', p: 'yify', lang: 'zh-Hant', label: 'Big 5 code', rel: m.title + ' ' + m.year + ' ' + v.q + ' BrRip x264 YIFY', by: 'geocity', tags: ['yts', 'big5'], base: 79 },
    { id: 'yf2', p: 'yify', lang: 'zh', label: 'Chinese', rel: m.title + ' ' + m.year + ' 720p BrRip x264 YIFY', by: 'sub', tags: ['detect'], base: 66 },
    { id: 'yf3', p: 'yify', lang: 'en', label: 'English', rel: m.title + ' ' + m.year + ' ' + v.q + ' BluRay x264 [YTS.AG]', by: 'sub', tags: ['yts'], base: 82 },
    { id: 'as1', p: 'assrt', lang: 'zh-Hant', label: '繁體、英文', rel: (m.zh ? m.zh + '.' : '') + dot + '.' + m.year + '.BluRay.1080p.繁英雙語.ass', by: '字幕組', tags: ['ass', 'bi'], base: 70 },
    { id: 'as2', p: 'assrt', lang: 'zh-Hans', label: '簡體', rel: dot + '.' + m.year + '.1080p.BluRay.x264.簡體.srt', by: '匿名', tags: ['s2t'], base: 48 }
  ];
}
const TAGS = { yts: '與 YTS 版本相符', hi: '聽障字幕', big5: 'Big5 已轉 UTF-8', s2t: '可轉成繁體', ass: 'ASS 特效', bi: '雙語', detect: '下載後再判斷繁簡', archive: '壓縮檔' };
