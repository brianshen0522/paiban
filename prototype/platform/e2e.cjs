// Walks every page and the main flows of the platform prototype in headless Chromium.
// Run:  python3 build.py --webm && node e2e.cjs        (needs the `playwright` package and its Chromium)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const out = [];
const ok = (name, cond, extra) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra != null ? '  [' + String(extra).replace(/\s+/g, ' ').slice(0, 150) + ']' : ''));

(async () => {
  fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  // Expected noise: the font host may be unreachable, and the page first looks for clip.mp4 next to itself before using the embedded copy.
  const noise = ['ERR_TUNNEL', 'ERR_FILE_NOT_FOUND', 'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'clip.mp4'];
  page.on('console', (m) => { if (m.type() === 'error' && !noise.some((n) => m.text().includes(n))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, 'preview_webm.html'));
  const txt = (sel) => page.locator(sel).first().innerText();
  const shot = (name, full) => page.screenshot({ path: path.join(__dirname, 'screenshots', name + '.png'), fullPage: full !== false });
  const nav = (label) => page.locator('#side button', { hasText: label }).first().click();
  const toastText = async () => (await page.locator('.toast').allInnerTexts()).join(' | ');
  const B = (fn, arg) => page.evaluate(fn, arg);

  /* sign-in */
  ok('login page shows', (await txt('.auth h1')) === '拍板');
  await shot('01-login');
  await page.fill('#login-user', 'nobody'); await page.click('.auth button.primary');
  ok('unknown account is rejected', (await txt('.auth .err')).includes('不正確'), await txt('.auth .err'));
  await page.fill('#login-user', 'yu'); await page.click('.auth button.primary');
  ok('disabled account is rejected', (await txt('.auth .err')).includes('停用'));
  await page.fill('#login-user', 'brian'); await page.fill('#login-pass', ''); await page.click('.auth button.primary');
  ok('empty password is rejected', (await txt('.auth .err')).includes('請輸入密碼'));
  await page.fill('#login-pass', 'x'); await page.click('.auth button.primary');
  ok('admin signs in and lands on search', (await txt('#view h1')) === '搜尋' && (await page.locator('#side h2').count()) === 1);

  /* search */
  ok('search lists all demo films', (await page.locator('#view .mcard').count()) === 14);
  ok('storage meter in the top bar', (await txt('#meter-text')).includes('/ 26 GB'), await txt('#meter-text'));
  await shot('02-search');
  await page.fill('#sq', 'charade'); await page.click('#view .filters button.primary');
  await page.waitForTimeout(800);
  ok('search by title', (await page.locator('#view .mcard').count()) === 1 && (await txt('#view .rhead h2')).includes('charade'));
  await page.fill('#sq', '大都會'); await page.keyboard.press('Enter'); await page.waitForTimeout(800);
  ok('search by Chinese title', (await page.locator('#view .mcard').count()) === 1);
  await page.fill('#sq', 'zzz'); await page.keyboard.press('Enter'); await page.waitForTimeout(800);
  ok('empty result state', (await txt('#view .empty')).includes('找不到'));
  await page.locator('#view .empty button').click(); await page.waitForTimeout(800);
  await page.selectOption('#f-quality', '2160p');
  ok('quality filter', (await page.locator('#view .mcard').count()) === 2);
  await page.selectOption('#f-quality', 'all'); await page.selectOption('#f-sort', 'rating');
  ok('sort by rating puts Metropolis first', (await txt('#view .mcard .mt')) === 'Metropolis');
  await page.selectOption('#f-sort', 'new');

  /* movie page: blocked by the limit, then a download that fits */
  await page.locator('#view .mcard', { hasText: 'Night of the Living Dead' }).click();
  ok('movie page', (await txt('#view h1')) === 'Night of the Living Dead' && (await page.locator('#view tbody tr').count()) === 3);
  await shot('03-movie');
  await page.locator('#view tbody tr', { hasText: '2160p' }).locator('button', { hasText: '下載' }).click();
  ok('download over the limit is blocked', (await txt('#view tr.blocked')).includes('空間不足') && (await txt('#view tr.blocked')).includes('加上預覽檔'), await txt('#view tr.blocked'));
  await shot('04-movie-blocked', false);
  await page.locator('#view tbody tr', { hasText: '720p' }).locator('button', { hasText: '下載' }).click();
  ok('download that fits is queued behind two active ones', (await toastText()).includes('已排入下載'), await toastText());
  ok('version row reflects the new state', (await txt('#view tbody tr >> nth=0')).includes('排隊中'));

  /* downloads */
  await nav('下載');
  ok('downloads page lists active, failed and finished', (await page.locator('#view .dl').count()) >= 8, await page.locator('#view .dl').count());
  await shot('05-downloads');
  const w1 = await B(() => document.getElementById('bar-t6').style.width);
  await page.waitForTimeout(2300);
  const w2 = await B(() => { const b = document.getElementById('bar-t6'); return b ? b.style.width : 'done'; });
  ok('progress moves on its own', w1 !== w2, w1 + ' -> ' + w2);
  await page.locator('#view .dl[data-tid="t9"] button', { hasText: '重試' }).click();
  ok('failed download can be retried', (await toastText()).includes('重新排入'));
  const firstQueued = page.locator('#view .dl', { hasText: '排隊中' }).first();
  await firstQueued.locator('button', { hasText: '取消' }).click();
  ok('cancel asks first', (await page.locator('#view .confirm').count()) === 1);
  await page.locator('#view .confirm button', { hasText: '先不要' }).click();
  ok('cancel can be backed out', (await page.locator('#view .confirm').count()) === 0);

  /* library and one movie */
  await nav('片庫');
  ok('library shows the admin\'s three films', (await page.locator('#view .lib').count()) === 3, await page.locator('#view .lib').count());
  await shot('06-library');
  await page.locator('#view .fchips button', { hasText: '字幕還沒確認' }).click();
  ok('library filter', (await page.locator('#view .lib').count()) === 1 && (await txt('#view .lib h2')).includes('Charade'));
  await page.locator('#view .lib button', { hasText: 'Charade' }).click();
  ok('workspace opens on the subtitles tab', (await txt('#view h1')) === 'Charade' && (await page.locator('#view .tabs [aria-selected="true"]').innerText()).includes('字幕'));
  await page.locator('#view button', { hasText: '搜尋所有來源' }).click();
  await page.waitForTimeout(2100);
  ok('one source failing does not hide the others', (await page.locator('#view .provs .st.ok').count()) === 2 && (await page.locator('#view .provs .st.bad').count()) === 1 && (await page.locator('#view tbody tr').count()) >= 6, await txt('#view .provs'));
  await shot('07-subtitles-search');
  await page.locator('#view .provs button', { hasText: '重試' }).click(); await page.waitForTimeout(1200);
  ok('retry brings the third source in', (await page.locator('#view .provs .st.ok').count()) === 3);
  await page.locator('#view button', { hasText: '全部自動對齊並排名' }).click(); await page.waitForTimeout(2600);
  ok('ranking fills in scores and a suggestion', (await page.locator('#view td.num b').count()) >= 6 && (await page.locator('#view td.num .st.ok').count()) >= 1);
  await page.locator('#view section', { hasText: '從所有來源找字幕' }).locator('tbody tr').first().locator('button', { hasText: '加入' }).click();
  ok('adding a candidate', (await toastText()).includes('已加入') && (await page.locator('#view section', { hasText: '這部片的字幕' }).first().locator('tbody tr').count()) === 2);
  await page.setInputFiles('#sub-file', { name: 'my.zh.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n再見\n') });
  await page.waitForTimeout(300);
  ok('uploaded file is read', (await toastText()).includes('my.zh.srt:2 句'), await toastText());
  await shot('08-subtitles-ranked');

  /* sync inside the app */
  await page.locator('#view .tabs button', { hasText: '同步' }).click();
  ok('workbench appears in the sync tab', await page.locator('#bench').isVisible() && (await page.locator('#bench #list .row').count()) === 26);
  await shot('09-sync');
  await page.locator('#bench #auto').click();
  ok('auto-align runs inside the app', (await txt('#bench #score')) === '80%', await txt('#bench #score'));
  await page.locator('#bench #confirm').click();
  await page.locator('#bench #log button', { hasText: '仍要確認' }).click();
  await page.waitForTimeout(200);
  ok('confirming in the workbench marks the subtitle', (await txt('#view .syncpick')).includes('已確認') && (await toastText()).includes('可以匯出'), await toastText());
  await nav('片庫');
  ok('workbench is hidden on other pages', !(await page.locator('#bench').isVisible()));
  await page.keyboard.press('a');
  ok('workbench shortcuts are off elsewhere', (await txt('#view h1')) === '片庫');

  /* export */
  await page.locator('#view .fchips button', { hasText: '全部' }).click();
  await page.locator('#view .lib', { hasText: 'Charade' }).locator('.lib-act button').first().click();
  ok('library points to the next step', (await page.locator('#view .tabs [aria-selected="true"]').innerText()).includes('匯出'));
  await page.fill('#exp-name', 'bad/name.mkv'); await page.locator('#view button', { hasText: '開始匯出' }).click();
  ok('bad file name is explained', (await txt('#view .field .err')).includes('.mkv'));
  await page.fill('#exp-name', 'Charade.1963.1080p.zh-TW.mkv'); await page.locator('#view button', { hasText: '開始匯出' }).click();
  ok('export starts', (await page.locator('#view .prog').count()) === 1 && (await toastText()).includes('開始封裝'));
  await shot('10-export-running');
  await page.waitForTimeout(7000);
  ok('export finishes and can be downloaded', (await page.locator('#view td.act button', { hasText: '下載' }).count()) === 1);
  const freeAfter = await B(() => usage().free);
  await page.locator('#view button', { hasText: '開始匯出' }).click();
  ok('a second export no longer fits and is refused', (await txt('#view .banner.bad')).includes('空間不足'), 'free ' + freeAfter.toFixed(2));
  await shot('11-export-blocked');

  /* storage, profile */
  await nav('儲存空間');
  ok('storage page lists my items and the rules', (await page.locator('#view tbody tr').count()) >= 5 && (await txt('#view .rules')).includes('不會自動刪除'));
  await shot('12-storage');
  await page.locator('#view tbody tr', { hasText: 'Charade.1963.1080p.zh-TW.mkv' }).locator('button', { hasText: '刪除' }).click();
  await page.locator('#view .confirm button.danger').click();
  ok('deleting an export frees space', (await toastText()).includes('釋放 1.9 GB'));
  await nav('個人設定');
  await page.locator('#view form[data-form="password"] button').click();
  ok('password form validates', (await page.locator('#view form[data-form="password"] .err').count()) === 2);
  await page.fill('#pf-name', 'Brian S.'); await page.locator('#view form[data-form="profile-name"] button').click();
  ok('display name updates the avatar menu', (await toastText()).includes('名稱已更新'));
  await shot('13-profile');

  /* admin */
  await nav('總覽');
  ok('admin overview has tiles and problems', (await page.locator('#view .tile').count()) === 4 && (await page.locator('#view .plist li').count()) >= 1);
  await shot('14-admin-overview');
  await nav('使用者與邀請');
  await page.locator('#view form[data-form="invite-new"] button').click();
  ok('invite is created', (await page.locator('#view section', { hasText: '邀請' }).last().locator('tbody tr').count()) === 3);
  await page.locator('#view tbody tr', { hasText: '阿凱' }).locator('button', { hasText: '重設密碼' }).click();
  ok('reset link is shown once', (await txt('#view .banner.info')).includes('/reset/'));
  await page.locator('#view tbody tr', { hasText: '小宇' }).locator('button', { hasText: '啟用' }).click();
  ok('account can be re-enabled', (await toastText()).includes('已啟用'));
  ok('admin cannot change own role', (await txt('#view tbody tr >> nth=0')).includes('不能變更自己的角色'));
  await shot('15-admin-users');
  await nav('儲存空間管理');
  await page.fill('#limit', '40');
  ok('limit above the disk is refused', (await txt('#limit-note')).includes('最多 30 GB'));
  await page.fill('#limit', '12');
  ok('limit below usage warns but allows', (await txt('#limit-note')).includes('不會刪除任何檔案') && (await txt('#view form[data-form="limit"] button')).includes('仍要儲存'));
  await shot('16-admin-storage');
  await page.locator('#view form[data-form="limit"] button').click();
  ok('over-limit state reaches the top bar', (await page.locator('#meter.bad').count()) === 1 && (await toastText()).includes('超過上限'));
  await page.locator('#view tbody tr', { hasText: 'Metropolis' }).first().locator('button', { hasText: '刪除' }).click();
  ok('force delete explains the consequence', (await txt('#view .confirm')).includes('片庫移除'));
  await page.locator('#view .confirm button.danger').click();
  ok('force delete frees space', (await toastText()).includes('釋放 7.2 GB'), await toastText());
  await page.fill('#limit', '26'); await page.locator('#view form[data-form="limit"] button').click();
  await nav('來源設定');
  await page.fill('#yts-base', 'yts dot something'); await page.locator('#view form[data-form="src-yts"] button.primary').click();
  ok('bad YTS address is explained', (await txt('#view form[data-form="src-yts"] .err')).includes('https://'));
  await page.fill('#yts-base', 'https://yts.example'); await page.locator('#view form[data-form="src-yts"] button.primary').click();
  await page.locator('#view form[data-form="src-yts"] button', { hasText: '測試連線' }).click(); await page.waitForTimeout(1100);
  ok('connection test reports back', (await txt('#view form[data-form="src-yts"]')).includes('回應 200'));
  await shot('17-admin-sources');
  await page.check('#sim-yts');
  await nav('搜尋');
  ok('search shows the YTS outage with a way out', (await txt('#view .banner.bad')).includes('連不上 YTS') && (await page.locator('#view .banner.bad button', { hasText: '前往來源設定' }).count()) === 1);
  await shot('18-search-yts-down', false);
  await nav('來源設定'); await page.uncheck('#sim-yts');
  await nav('下載設定');
  await page.fill('#ds-maxActive', '9'); await page.fill('#ds-port', '80'); await page.locator('#view .savebar button.primary').click();
  ok('download settings validate each field', (await page.locator('#view .field .err').count()) === 2);
  await page.fill('#ds-maxActive', '3'); await page.fill('#ds-maxPerUser', '2'); await page.fill('#ds-port', '51413'); await page.locator('#view .savebar button.primary').click();
  ok('download settings save', (await toastText()).includes('下載設定已儲存') && (await B(() => DB.settings.maxActive)) === 3);
  await shot('19-admin-downloads');
  await nav('系統狀態');
  ok('system page lists services and jobs', (await page.locator('#view section').first().locator('tbody tr').count()) === 4);
  await shot('20-admin-system');
  await nav('操作紀錄');
  ok('audit log grew with what was just done', (await txt('#view tbody tr >> nth=0')).includes('變更下載設定'));
  await page.selectOption('#audit-user', 'mei');
  ok('audit filter', (await page.locator('#view tbody tr').count()) === 1);
  await shot('21-admin-audit');

  /* member view */
  await page.locator('.top .avatar').click();
  await shot('22-user-menu', false);
  await page.locator('.pop button', { hasText: '美玲' }).click();
  ok('member has no admin menu', (await page.locator('#side h2').count()) === 0 && (await page.locator('#side button').count()) === 5);
  await B(() => go('a-overview'));
  ok('admin page is refused for a member', (await txt('#view .empty')).includes('只有管理員'));
  await nav('片庫');
  ok('member sees own and shared films', (await page.locator('#view .lib').count()) >= 2);
  await B(() => go('movie', { id: 'stranger' }));
  await page.locator('#view tbody tr', { hasText: '1080p' }).locator('button', { hasText: '加入我的片庫' }).click();
  ok('joining an existing download costs no space', (await toastText()).includes('不佔額外空間'));
  await page.locator('.top button', { hasText: '通知' }).click();
  ok('notifications list', (await page.locator('.pop .pop-item').count()) >= 2);
  await shot('23-member-notifications', false);
  await page.keyboard.press('Escape');

  /* sign out, register with an invite */
  await page.locator('.top .avatar').click(); await page.locator('.pop button', { hasText: '登出' }).click();
  ok('sign out returns to login', (await txt('.auth h1')) === '拍板');
  await page.locator('.auth button', { hasText: '用邀請碼註冊' }).click();
  await page.fill('#reg-code', 'B3TX-88LP'); await page.locator('.auth button.primary').click();
  ok('expired invite and empty fields are explained', (await page.locator('.auth .err').count()) >= 4 && (await txt('.auth .err')).includes('過期'));
  await shot('24-invite-errors');
  await page.fill('#reg-code', 'K7QF-2M9D'); await page.fill('#reg-name', '怡君'); await page.fill('#reg-user', 'yijun'); await page.fill('#reg-pass', 'longenough'); await page.fill('#reg-pass2', 'longenough');
  await page.locator('.auth button.primary').click();
  ok('registration signs the new member in', (await txt('#view h1')) === '搜尋' && (await toastText()).includes('歡迎,怡君'));
  await nav('片庫');
  ok('new member starts with an empty library', (await txt('#view .empty')).includes('片庫還是空的'));
  await shot('25-empty-library');

  /* dark and phone */
  await B(() => { ACT['quick-login']({ user: 'brian' }); });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
  await nav('片庫'); await shot('30-dark-library');
  await B(() => go('work', { tid: 't1', tab: 'subs' })); await shot('31-dark-workspace');
  await page.setViewportSize({ width: 400, height: 860 });
  const pages = ['search', 'downloads', 'library', 'storage', 'profile', 'a-overview', 'a-users', 'a-storage', 'a-sources', 'a-downloads', 'a-system', 'a-audit'];
  const wide = [];
  for (const p of pages) { await B((n) => go(n), p); await page.waitForTimeout(120); const o = await B(() => document.documentElement.scrollWidth - window.innerWidth); if (o > 0) wide.push(p + ':' + o); }
  for (const r of [['movie', { id: 'notld' }], ['work', { tid: 't1', tab: 'subs' }], ['work', { tid: 't1', tab: 'sync' }], ['work', { tid: 't1', tab: 'export' }]]) {
    await B((x) => go(x[0], x[1]), r); await page.waitForTimeout(200); const o = await B(() => document.documentElement.scrollWidth - window.innerWidth); if (o > 0) wide.push(r[0] + '/' + (r[1].tab || '') + ':' + o);
  }
  ok('no page scrolls sideways at 400 px', wide.length === 0, wide.join(', '));
  await B(() => go('search')); await shot('32-phone-search');
  await B(() => go('a-storage')); await shot('33-phone-admin-storage');
  await page.emulateMedia({ colorScheme: 'light' });
  await B(() => go('downloads')); await shot('34-phone-downloads');

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' || '));
  console.log(out.join('\n'));
  await browser.close();
})().catch((e) => { console.log(out.join('\n')); console.error('SCRIPT ERROR', e.message.split('\n').slice(0, 8).join('\n')); process.exit(1); });
