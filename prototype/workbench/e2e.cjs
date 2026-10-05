// One scripted pass over the prototype in headless Chromium: real <video> playback (WebM test copy), every tool, three layouts.
// Run:  python3 build.py --webm && node e2e.cjs        (needs the `playwright` package and its Chromium)
const { chromium } = require('playwright');
const path = require('path');
const out = [];
const ok = (name, cond, extra) => { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra != null ? '  [' + extra + ']' : '')); };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const file = process.argv[2] || 'preview_webm.html';
  process.chdir(__dirname);
  await page.goto('file://' + path.resolve(__dirname, file));
  await page.waitForFunction(() => window.__bench && document.getElementById('list').children.length > 0);
  await page.waitForTimeout(600);
  const txt = (sel) => page.locator(sel).innerText();
  const B = (fn, arg) => page.evaluate(fn, arg);

  ok('initial score shows the late subtitle', (await txt('#score')) === '51%', await txt('#score'));
  ok('26 rows rendered', (await page.locator('#list .row').count()) === 26);
  const ready = await B(() => document.getElementById('video').readyState);
  ok('video loaded', ready >= 2, 'readyState ' + ready + ', tag: ' + (await txt('#media-tag')));
  await page.screenshot({ path: 'screenshots/shot_desktop_light.png', fullPage: true });

  // playback and the subtitle overlay
  await page.click('#play'); await page.waitForTimeout(1800);
  const t1 = await B(() => window.__bench.clock.t);
  ok('playback advances', t1 > 1.0, t1.toFixed(2));
  ok('play button turns into pause', (await txt('#play')) === '暫停');
  await page.click('#play');
  await B(() => window.__bench.clock.seek(6.0)); await page.waitForTimeout(200);
  ok('late subtitle shows line 1 while line 2 is spoken', (await txt('#overlay')).includes('門鎖上'), await txt('#overlay'));

  // automatic alignment, then the five checkpoints, then confirm
  await page.click('#auto');
  ok('auto-align fixes the offset', (await page.inputValue('#offset')) === '-2.36', await page.inputValue('#offset'));
  ok('score after auto-align', (await txt('#score')) === '80%', await txt('#score'));
  await page.waitForTimeout(150);
  ok('overlay now shows line 2 at 6.0 s', (await txt('#overlay')).includes('我以為'), await txt('#overlay'));
  await page.click('#confirm');
  ok('confirm warns about unchecked checkpoints', (await txt('#log')).includes('5 個檢查點'), await txt('#log'));
  for (let i = 0; i < 5; i++) { if (i === 0) await page.click('#cp-next'); await page.waitForTimeout(120); await page.click('#cp-ok'); }
  ok('all checkpoints marked', (await page.locator('#cp-dots .ok').count()) === 5);
  await page.waitForTimeout(100);
  const playingAfter = await B(() => window.__bench.clock.playing);
  await B(() => window.__bench.clock.pause());
  await page.click('#confirm');
  ok('status becomes confirmed', (await txt('#status')) === '已確認');
  ok('summary lists the offset', (await txt('#summary')).includes('−2.360 秒'), (await txt('#summary')).slice(0, 80).replace(/\n/g, ' | '));
  ok('srt output is retimed', (await txt('#srt')).startsWith('1\n00:00:02,990 --> 00:00:05,276'), (await txt('#srt')).split('\n').slice(0, 2).join(' / '));
  await page.screenshot({ path: 'screenshots/shot_confirmed.png', fullPage: true });

  // frame-rate scenario
  await page.selectOption('#scenario', 'rate');
  ok('scenario switch resets status', (await txt('#status')) === '草稿' && (await txt('#score')) === '66%', await txt('#score'));
  await page.keyboard.press('a');
  ok('auto-align finds the speed', (await page.locator('#rate option:checked').innerText()).includes('1.0427'), await page.locator('#rate option:checked').innerText());
  ok('score after speed fix', (await txt('#score')) === '80%');

  // two pins by hand recover the same speed
  await page.click('#reset');
  await page.locator('#list .row[data-i="1"]').click();
  await B(() => window.__bench.clock.seek(5.436)); await page.waitForTimeout(120);
  await page.click('#anchor');
  await page.locator('#list .row[data-i="24"]').click();
  await B(() => window.__bench.clock.seek(86.0)); await page.waitForTimeout(120);
  const truth24 = await B(() => window.DEMO.cues[24].start);
  await B((t) => window.__bench.clock.seek(t), truth24); await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  const seg = await B(() => window.__bench.st.doc.segments[0]);
  ok('two pins give speed and offset', Math.abs(seg.scale - 25 / 23.976) < 1e-6 && Math.abs(seg.offset + 0.834) < 0.03, seg.scale.toFixed(5) + ' ' + seg.offset);

  // different-cut scenario: split on and off, undo
  await page.selectOption('#scenario', 'cut');
  await page.click('#auto');
  ok('split alignment makes two segments', (await page.locator('#segs .chip').count()) === 2 && (await txt('#score')) === '80%', await txt('#segs'));
  await page.screenshot({ path: 'screenshots/shot_cut.png', fullPage: false });
  await page.uncheck('#allow-split'); await page.click('#auto');
  ok('without split only part fits', (await txt('#score')) === '62%', await txt('#score'));
  await page.keyboard.press('z');
  ok('undo restores two segments', (await page.locator('#segs .chip').count()) === 2);
  await page.check('#allow-split');

  // manual tools: nudge, keyboard, snap, drag on the timeline, merge, split
  await page.selectOption('#scenario', 'late');
  await page.click('[data-nudge="-0.5"]'); await page.click('[data-nudge="-0.5"]'); await page.click('[data-nudge="-0.5"]'); await page.click('[data-nudge="-0.5"]');
  ok('four nudges', (await page.inputValue('#offset')) === '-2.00');
  await page.keyboard.press('Shift+<');
  ok('keyboard nudge', (await page.inputValue('#offset')) === '-2.50', await page.inputValue('#offset'));
  await page.click('#snap');
  ok('snap lands on speech', Math.abs(parseFloat(await page.inputValue('#offset')) + 2.36) < 0.03, await page.inputValue('#offset'));
  const box = await page.locator('#tl').boundingBox();
  const before = parseFloat(await page.inputValue('#offset'));
  await page.mouse.move(box.x + 300, box.y + 130); await page.mouse.down(); await page.mouse.move(box.x + 360, box.y + 130, { steps: 6 }); await page.mouse.up();
  const DUR = await B(() => window.DEMO.duration);
  const after = parseFloat(await page.inputValue('#offset')), expect = 60 / (box.width / DUR);
  ok('dragging the lane shifts the subtitle', Math.abs(after - before - expect) < 0.03, (after - before).toFixed(2) + ' vs ' + expect.toFixed(2));
  await page.keyboard.press('z');
  await page.locator('#list .row[data-i="13"]').click(); await page.locator('#list .row[data-i="13"] [data-act="split"]').click();
  ok('manual split', (await page.locator('#segs .chip').count()) === 2 && (await txt('#scope')).includes('第 2 段'), await txt('#scope'));
  await page.click('#merge');
  ok('merge back', (await page.locator('#segs .chip').count()) === 0);
  await page.fill('#offset', '-2.4'); await page.locator('#offset').dispatchEvent('change');
  ok('typed offset', (await txt('#score')) === '80%', await txt('#score'));

  // hold to compare, search, bilingual
  await page.locator('#orig').dispatchEvent('pointerdown');
  ok('original tag while held', await page.locator('#orig-tag').isVisible());
  await page.locator('#orig').dispatchEvent('pointerup');
  ok('original tag gone on release', !(await page.locator('#orig-tag').isVisible()));
  await page.fill('#search', '電梯');
  ok('search narrows the list', (await page.locator('#list .row').count()) === 1);
  await page.fill('#search', 'zzz');
  ok('search empty state', (await txt('#list')).includes('找不到'));
  await page.fill('#search', '');
  await page.check('#bilingual');
  await B(() => window.__bench.clock.seek(3.6)); await page.waitForTimeout(150);
  ok('bilingual overlay', (await txt('#overlay')).includes('Did you lock'), (await txt('#overlay')).replace(/\n/g, ' / '));

  // per-line editing
  await page.click('#mode-edit');
  await page.locator('#list .row[data-i="0"]').click();
  await page.fill('#edit-text', '你有把門鎖好嗎?');
  await page.waitForTimeout(120);
  ok('edited text shows on the picture', (await txt('#overlay')).includes('鎖好'), (await txt('#overlay')).replace(/\n/g, ' / '));
  await page.locator('#list .row[data-i="0"] [data-ed="s+"]').click();
  const d = await B(() => window.__bench.st.doc.edits[1]);
  ok('line start nudged', d && Math.abs(d.dStart - 0.05) < 1e-9 && d.zh === '你有把門鎖好嗎?', JSON.stringify(d));
  await page.locator('#list .row[data-i="2"]').click(); await page.locator('#list .row[data-i="2"] [data-ed="del"]').click();
  ok('deleted line struck through', (await page.locator('#list .row.del').count()) === 1);
  const srt = await B(() => window.__bench.Core.toSrt(window.__bench.st.mapped, false));
  ok('deleted line leaves the export, numbering stays continuous', srt.split('\n\n').length === 25 && !srt.includes('十分鐘。'), srt.split('\n\n').length + ' cues');
  await page.keyboard.press('Shift+Z');
  await page.click('#mode-sync');

  // zoom + follow
  await page.click('#zoom-in'); await page.click('#zoom-in');
  const v = await B(() => window.__bench.view.dur);
  ok('zoom halves the window twice', Math.abs(v - DUR / 4) < 0.01, v.toFixed(2));
  await page.screenshot({ path: 'screenshots/shot_zoom.png', clip: { x: 0, y: 560, width: 1280, height: 340 } });
  await page.click('#zoom-fit');

  // dark theme and phone width
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250);
  await page.screenshot({ path: 'screenshots/shot_desktop_dark.png', fullPage: true });
  await page.setViewportSize({ width: 400, height: 860 }); await page.waitForTimeout(300);
  const overflow = await B(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('no sideways scroll at 400 px', overflow <= 0, overflow);
  await page.screenshot({ path: 'screenshots/shot_phone_dark.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(200);
  await page.screenshot({ path: 'screenshots/shot_phone_light.png', fullPage: true });

  // Expected noise: the font host may be unreachable, and the page first looks for clip.mp4 next to itself before using the embedded copy.
  const real = errors.filter((x) => !x.includes('ERR_TUNNEL_CONNECTION_FAILED') && !x.includes('ERR_FILE_NOT_FOUND') && !x.includes('ERR_INTERNET_DISCONNECTED') && !x.includes('ERR_NAME_NOT_RESOLVED'));
  ok('no console errors', real.length === 0, real.slice(0, 3).join(' || '));
  console.log(out.join('\n'));
  console.log('playing after last checkpoint mark:', playingAfter);
  await browser.close();
})().catch((e) => { console.log(out.join('\n')); console.error('SCRIPT ERROR', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
