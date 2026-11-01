// =====================================================================================
// 剪輯介面（edit-ui.js）的瀏覽器流程測試：開真的 index.html，匯入素材，
// 然後用真的滑鼠與快捷鍵操作每一個主要功能，每一步都用 Q.ui.state.project 斷言結果，
// 並檢查 core.checkInvariants 為空、頁面沒有 console error、沒有 CSP 違規。最後呼叫匯出。
//
// 執行：node test/edit-ui.e2e.js
//   （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//   EDIT_FIXTURES=<資料夾>   測試素材（放 landscape-720p-6s.webm、portrait-720x1280-4s.webm、noaudio-25fps-3s.webm、music-8s.webm、still.png）；
//                            沒指定或缺檔就用 ffmpeg 產生到暫存資料夾（VP9／Opus＋PNG）
//   SHOTS=<資料夾>           截圖輸出位置（沒設就不存圖）
//   CHROMIUM=<路徑>          瀏覽器執行檔（沒設時用 /opt/pw-browsers/chromium，再沒有就用 playwright 預設）
//   EDIT_VIEWPORTS=1600x1000,1280x800   要跑的視窗大小（逗號分隔）
// =====================================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const VIEWPORTS = (process.env.EDIT_VIEWPORTS || '1600x1000,1280x800').split(',').map(s => s.split('x').map(Number));
const FILES = { land: 'landscape-720p-6s.webm', port: 'portrait-720x1280-4s.webm', mute: 'noaudio-25fps-3s.webm', music: 'music-8s.webm', still: 'still.png' };

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } return !!cond; }
function eq(a, b, msg) { const r = JSON.stringify(a) === JSON.stringify(b); if (!r) console.log('       期望', JSON.stringify(b), '實際', JSON.stringify(a)); return ok(r, msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 素材 ------------------------------------------------------------------------------
function ffmpeg(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' }); }
function fixturesDir() {
  const want = process.env.EDIT_FIXTURES;
  const all = Object.values(FILES);
  if (want && all.every(f => fs.existsSync(path.join(want, f)))) return want;
  const dir = path.join(os.tmpdir(), 'qc-ui-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const has = f => fs.existsSync(path.join(dir, f)), out = f => path.join(dir, f);
  if (!has(FILES.land)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
    '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest', out(FILES.land)]);
  if (!has(FILES.port)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4:sample_rate=48000',
    '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '800k', '-c:a', 'libopus', '-shortest', out(FILES.port)]);
  if (!has(FILES.mute)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-c:v', 'libvpx-vp9', '-b:v', '500k', out(FILES.mute)]);
  if (!has(FILES.music)) ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', out(FILES.music)]);
  if (!has(FILES.still)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', out(FILES.still)]);
  return dir;
}

// ---- 本機伺服器（WebCodecs 需要 localhost 這種安全來源）-----------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
function serve() {
  return new Promise(res => {
    const server = http.createServer((req, rsp) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${server.address().port}/index.html` }));
  });
}

// ---- 頁面端的小工具 --------------------------------------------------------------------
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
// 專案摘要：[{ id, t（軌道名）, s（start）, d（duration）, in（srcIn）, kind, link }]，依軌道、start 排序
const clips = page => page.evaluate(() => {
  const Q = window.QPTEdit, p = Q.ui.state.project;
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  return Object.values(p.clips).sort((a, b) => order.get(a.trackId) - order.get(b.trackId) || a.start - b.start)
    .map(c => ({ id: c.id, t: p.tracks.find(t => t.id === c.trackId).name, s: c.start, d: c.duration, in: Math.round(c.srcIn * 1000) / 1000, type: c.type, sp: c.speed, fr: c.freeze, rv: c.reverse, link: c.linkId, name: c.name }));
});
const on = (list, track) => list.filter(c => c.t === track);
const proj = (page, fn, arg) => page.evaluate(new Function('arg', `const p = window.QPTEdit.ui.state.project, Q = window.QPTEdit; return (${fn.toString()})(p, Q, arg);`), arg);
const invariants = page => page.evaluate(() => window.QPTEdit.core.checkInvariants(window.QPTEdit.ui.state.project));
// 時間軸上某個影格的螢幕 x、某個片段的外框
const frameX = (page, f) => page.evaluate(f => { const r = document.querySelector('.ed-tl-inner').getBoundingClientRect(); return r.left + 150 + f * window.QPTEdit.ui.ppf; }, f);
const clipBox = (page, id) => page.evaluate(id => { const e = document.querySelector(`.ed-clip[data-clip="${id}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, id);
const laneBox = (page, name) => page.evaluate(name => {
  const p = window.QPTEdit.ui.state.project, t = p.tracks.find(x => x.name === name);
  const e = document.querySelector(`.ed-lane[data-track="${t.id}"]`), r = e.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}, name);
// 第 f 格的 SRT 時間碼（HH:MM:SS,mmm）
const srtTc = (f, fps = 30) => { const ms = Math.round(Math.round(f) * 1000 / fps), p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
async function drag(page, a, b, o = {}) {
  const mods = o.mods || [];
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const n = o.steps || 8;
  for (let i = 1; i <= n; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n); await sleep(8); }
  if (o.hold) await sleep(o.hold);
  if (o.cancel) { await page.keyboard.press('Escape'); }
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await settle(page);
}
const statusText = page => page.evaluate(() => document.getElementById('edStatus').textContent);
const state = (page, key) => page.evaluate(k => window.QPTEdit.ui.state[k], key);

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

// =====================================================================================
async function runViewport(browser, base, fix, [W, H]) {
  const tag = `${W}x${H}`;
  console.log(`\n==== 視窗 ${tag} ====`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });   /* 這裡測「下載」的匯出流程（headless 沒有存檔視窗） */ });
  await page.goto(base);

  // ---------------------------------------------------------------- 空狀態
  console.log('空狀態');
  await settle(page);
  ok(await page.isVisible('#editApp'), '剪輯畫面顯示');
  ok(await page.isVisible('#edEmpty'), '檢視器有「拖入影片」的空狀態提示');
  ok((await page.textContent('#edEmpty')).includes('拖進來'), '空狀態文字是繁體中文提示');
  ok(await page.isVisible('#edTimeline .ed-tl-empty'), '時間軸有空狀態提示');
  const wrapW = await page.evaluate(() => document.querySelector('.wrap').getBoundingClientRect().width);
  ok(wrapW > 1180 && wrapW >= W - 70, `滿版寬（.wrap ${Math.round(wrapW)}px，視窗 ${W}px）`);
  await shot(page, `${tag}-1-empty`);
  // 空的時候亂按快捷鍵：不能出錯，要給提示
  await page.keyboard.press('F12');
  ok((await statusText(page)).includes('媒體庫'), '沒有素材時按 F12：提示先匯入（' + (await statusText(page)) + '）');
  for (const k of ['F9', 'F10', 'F11', 'Delete', 'Backspace', 'Control+b', 'Control+r', 'Shift+r', 'Space', 'j', 'l', 'k', 'x', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Control+z', 'Control+Shift+z', 'Alt+x', 'Control+a', 'Escape']) await page.keyboard.press(k);
  await settle(page);
  eq([await state(page, 'playhead'), await page.evaluate(() => QPTEdit.ui.player.playing), Object.keys(await proj(page, p => p.clips)).length], [0, false, 0], '空時間軸亂按快捷鍵：沒有任何改動、也不會播放');

  // ---------------------------------------------------------------- 匯入
  console.log('匯入：拖放、貼上、錯誤訊息、選檔');
  const b64 = fs.readFileSync(path.join(fix, FILES.still)).toString('base64');
  const fileEvent = (kind, name, type, data) => page.evaluate(({ kind, name, type, data }) => {
    const bin = atob(data), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], name, { type }));
    const ev = kind === 'drop' ? new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }) : new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    (kind === 'drop' ? document.getElementById('edViewer') : document.body).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, { kind, name, type, data });
  ok(await fileEvent('drop', 'notes.txt', 'text/plain', btoa('hello')), '拖進一個文字檔：事件被接手（瀏覽器不會把它開起來）');
  await page.waitForSelector('#edMsgs .ed-msg.err');
  ok((await page.textContent('#edMsgs')).includes('notes.txt') && (await page.textContent('#edMsgs')).includes('不是支援的格式'), '不支援的檔案：顯示繁中錯誤訊息（' + (await page.textContent('#edMsgs')).slice(0, 60) + '…）');
  await page.click('#edMsgs .ed-msg-x');
  ok(!(await page.isVisible('#edMsgs .ed-msg')), '錯誤訊息可以關掉');
  await fileEvent('drop', 'dropped.png', 'image/png', b64);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 1, null, { timeout: 30000 });
  await fileEvent('paste', 'pasted.png', 'image/png', b64);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 2, null, { timeout: 30000 });
  eq(await page.evaluate(() => QPTEdit.render.media.list().map(m => m.name)), ['dropped.png', 'pasted.png'], '拖放與 Ctrl+V 貼上都能匯入圖片');
  await page.evaluate(() => { for (const m of QPTEdit.render.media.list()) { document.querySelector(`.ed-mitem[data-media="${m.id}"] .ed-mdel`).click(); } });
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.render.media.list().length), 0, '× 移除素材（沒被用到時）');
  console.log('匯入');
  await page.setInputFiles('#edFile', [FILES.land, FILES.port, FILES.mute, FILES.music, FILES.still].map(f => path.join(fix, f)));
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 5 && document.querySelectorAll('.ed-mitem').length === 5, null, { timeout: 90000 });
  await settle(page);
  eq(await proj(page, p => Object.keys(p.mediaInfo).length), 5, '5 個素材都登錄到專案');
  eq(await proj(page, p => p.fps), 30, '專案影格率由第一支影片決定（30）');
  eq(await proj(page, p => [p.width, p.height]), [1280, 720], '輸出尺寸依第一支影片（1280×720）');
  ok((await page.textContent('#edMList')).includes('landscape-720p-6s.webm'), '媒體庫列出素材名稱');
  ok((await page.textContent('#edMList')).includes('1280×720'), '媒體庫顯示解析度');
  await shot(page, `${tag}-2-imported`);
  // 媒體庫：列表／網格
  eq(await page.textContent('#edMCount'), '5 個素材', '媒體庫上方顯示素材數量');
  ok((await page.getAttribute('[data-mview="list"]', 'aria-pressed')) === 'true', '預設是列表顯示');
  await page.click('[data-mview="grid"]'); await settle(page);
  ok(await page.evaluate(() => document.getElementById('edMList').classList.contains('grid')), '按「網格」：媒體庫改成網格');
  const gtops = await page.evaluate(() => [...document.querySelectorAll('.ed-mitem')].map(e => Math.round(e.getBoundingClientRect().top)));
  ok(gtops[0] === gtops[1], `網格：前兩個素材在同一排（${gtops.slice(0, 3)}）`);
  eq(await page.evaluate(() => localStorage.getItem('qc-mview')), 'grid', '顯示方式記在 localStorage');
  await shot(page, `${tag}-2b-media-grid`);
  await page.click('[data-mview="list"]'); await settle(page);
  ok(!(await page.evaluate(() => document.getElementById('edMList').classList.contains('grid'))), '切回列表');
  const ids = await page.evaluate(() => Object.fromEntries(QPTEdit.render.media.list().map(m => [m.name, m.id])));
  const M = k => ids[FILES[k]];
  const pickMedia = async k => { await page.click(`.ed-mitem[data-media="${M(k)}"]`); await settle(page); };

  // ---------------------------------------------------------------- 放上時間軸
  console.log('放上時間軸：加到結尾按鈕、F10、F9');
  await pickMedia('land');
  await page.click('#edAppend');
  await settle(page);
  let cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 180]], '加到結尾：V1 有 6 秒影片（0～180 格）');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 180]], '同時放上連結的音訊（A1）');
  ok(on(cl, 'V1')[0].link && on(cl, 'V1')[0].link === on(cl, 'A1')[0].link, '影像與聲音有連結');
  eq(await invariants(page), [], '不變式 OK');
  ok((await page.evaluate(() => document.querySelectorAll('.ed-clip').length)) === 2, '時間軸畫出 2 個片段');
  eq(await state(page, 'playhead'), 0, '加到結尾後播放頭回到新片段開頭');

  await pickMedia('mute');
  await page.keyboard.press('End');
  await settle(page);
  eq(await state(page, 'playhead'), 180, 'End 鍵：播放頭移到結尾');
  await page.keyboard.press('F10');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 180], [180, 90]], 'F10 覆蓋：無聲影片接在 180（3 秒＝90 格）');
  eq(on(cl, 'A1').length, 1, '無聲影片沒有音訊片段');
  eq(await state(page, 'playhead'), 270, '覆蓋後播放頭移到新片段結尾');

  await pickMedia('music');
  await page.click('.ed-th[data-track] >> text=A2');
  await page.keyboard.press('Home');
  await page.keyboard.press('Home');
  await settle(page);
  const before = await proj(page, p => Q.core.projectDuration(p));
  await page.evaluate(() => window.QPTEdit.ui.seekTimeline(90));
  await page.keyboard.press('F9');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'A2').map(c => [c.s, c.d]), [[90, 240]], 'F9 插入：音樂放到目的軌道 A2 的 90 格，長度 8 秒（240 格）');
  eq(await proj(page, p => Q.core.projectDuration(p)), before + 240, '插入讓後面的內容往後推 240 格');
  eq(await invariants(page), [], '不變式 OK');
  await shot(page, `${tag}-3-placed`);

  // 回到空時間軸（順便測復原堆疊）
  await page.evaluate(() => { const h = QPTEdit.ui.state.history; while (h.canUndo) h.undo(); });
  await settle(page);
  eq(Object.keys(await proj(page, p => p.clips)).length, 0, '全部復原後時間軸是空的');
  eq(await proj(page, p => Object.keys(p.mediaInfo).length), 5, '復原後素材資訊仍在（ensureMediaInfo）');


  // ---------------------------------------------------------------- 刀片、波紋刪除、復原／重做
  console.log('刀片、波紋刪除、復原／重做');
  await page.click('.ed-th-name:text-is("A1")');
  await pickMedia('land');
  await page.click('#edAppend');
  await settle(page);
  await page.evaluate(() => QPTEdit.ui.seekTimeline(90));
  await page.keyboard.press('b');
  eq(await state(page, 'tool'), 'blade', 'B 切到刀片工具');
  ok((await page.getAttribute('#edToolBlade', 'aria-pressed')) === 'true', '工具列的刀片鈕呈按下狀態');
  cl = await clips(page);
  let vb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.move(await frameX(page, 90), vb.y + vb.h / 2);
  await settle(page);
  ok(await page.isVisible('.ed-bladeline'), '刀片工具：游標跟著一條切線');
  await page.mouse.click(await frameX(page, 90), vb.y + vb.h / 2);
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '刀片：V1 在 90 切成兩段');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '刀片：連結的 A1 一起切');
  eq(on(cl, 'V1')[1].in, 3, '右半的來源起點是 3 秒');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('a');
  vb = await clipBox(page, on(cl, 'V1')[1].id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await settle(page);
  eq(await proj(page, p => Q.ui.state.selection.size), 2, '點右半：連結的音訊一起被選取（連結選取開啟）');
  await page.keyboard.press('Shift+Delete');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90]], 'Shift+Delete 波紋刪除：右半（影像）消失');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 90]], '波紋刪除：連結的聲音也消失');
  ok((await page.textContent('#edUndoLab')).includes('波紋刪除'), '復原鈕顯示動作名稱（波紋刪除）');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(on(await clips(page), 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], 'Ctrl+Z 復原：右半回來');
  await page.keyboard.press('Control+Shift+z');
  await settle(page);
  eq(on(await clips(page), 'V1').length, 1, 'Ctrl+Shift+Z 重做：再次刪除');
  await page.click('#edUndo');
  await settle(page);
  eq(on(await clips(page), 'V1').length, 2, '工具列「復原」鈕也能復原');

  // ---------------------------------------------------------------- 拖曳移動、修剪邊緣
  console.log('拖曳移動、修剪邊緣');
  await page.keyboard.press('a');
  cl = await clips(page);
  const right = on(cl, 'V1')[1];
  vb = await clipBox(page, right.id);
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2 + 90, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '拖曳移動：右半往右 45 格（90px）');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '連結的聲音跟著移動');
  eq(await invariants(page), [], '不變式 OK');
  ok((await page.textContent('#edUndoLab')).includes('移動'), '復原鈕：移動片段');
  // Esc 取消拖曳：不留下任何改動
  vb = await clipBox(page, right.id);
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2 + 120, y: vb.y + vb.h / 2 }, { cancel: true });
  eq(on(await clips(page), 'V1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '拖曳中按 Esc：回到原位');
  // 拖到另一條影片軌（往上）
  vb = await clipBox(page, right.id);
  const v2 = await laneBox(page, 'V2');
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2, y: v2.y + v2.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d]), [[135, 90]], '拖到上面一條軌：右半換到 V2');
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90]], 'V1 只剩左半');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原兩次：右半回到 90');
  // 片段畫布重用：只移動位置時沿用同一張畫好的畫布（不重畫），內容改了（修剪）才重畫
  const cvInfo = id => page.evaluate(id => {
    const e = document.querySelector(`.ed-clip[data-clip="${id}"]`), cv = e && e.firstChild;
    if (!cv || cv.tagName !== 'CANVAS') return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) lit++;
    return { mark: cv.__g1 || 0, w: cv.width, ew: e.offsetWidth, lit: lit / (d.length / 4) };
  }, id);
  const movId = on(cl, 'V1')[1].id;
  await page.evaluate(id => { document.querySelector(`.ed-clip[data-clip="${id}"]`).firstChild.__g1 = 1; }, movId);
  vb = await clipBox(page, movId);
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2 + 40, y: vb.y + vb.h / 2 });
  let ci = await cvInfo(movId);
  ok(ci && ci.mark === 1 && ci.lit > 0.9, `移動後沿用同一張畫布且有內容 ${JSON.stringify(ci)}`);
  await page.keyboard.press('Control+z'); await settle(page);
  cl = await clips(page);
  // 拖曳中按 Ctrl+Z／Delete：要被擋掉，放開後只多一筆「移動」，復原一次就回到拖曳前
  vb = await clipBox(page, on(cl, 'V1')[1].id);
  await page.mouse.move(vb.x + vb.w / 2, vb.y + vb.h / 2); await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(vb.x + vb.w / 2 + i * 18, vb.y + vb.h / 2); await sleep(8); }
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Delete');
  await page.mouse.up(); await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '拖曳中按 Ctrl+Z／Delete 被擋：片段照樣移到 135、沒被刪');
  ok((await page.textContent('#edUndoLab')).includes('移動'), '拖曳中按的快捷鍵沒有吃掉這筆「移動」');
  await page.keyboard.press('Control+z'); await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '再復原一次：回到拖曳前');
  eq(await invariants(page), [], '不變式 OK');
  // 修剪邊緣（選取工具拖片段邊緣）
  vb = await clipBox(page, on(cl, 'V1')[0].id);
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 70], [90, 90]], '拖左半的右邊緣 -20 格：一般修剪（不推動後面）');
  ci = await cvInfo(on(cl, 'V1')[0].id);
  ok(ci && Math.abs(ci.w - ci.ew) <= 2 && ci.lit > 0.9, `修剪後畫布重畫成新寬度 ${JSON.stringify(ci)}`);
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 70], [90, 90]], '連結的聲音一起修剪');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 拖頭尾修剪時，拖的那一側邊緣旁顯示目前的時間碼；放開後消失
  {
    const fpsE = await proj(page, p => p.fps), tcE = f => { const s = Math.floor(f / fpsE), p2 = n => String(n).padStart(2, '0'); return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}:${p2(f % fpsE)}`; };
    const tipE = () => page.evaluate(() => { const e = document.querySelector('.ed-edgetc'); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { t: e.textContent, l: r.left, r: r.right, y: r.top + r.height / 2 }; });
    for (const [edge, idx, dx, want] of [['end', 0, -40, 70], ['start', 1, 40, 110]]) {
      cl = await clips(page);
      const cb0 = await clipBox(page, on(cl, 'V1')[idx].id), x = edge === 'end' ? cb0.x + cb0.w - 2 : cb0.x + 2, y = cb0.y + cb0.h / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(x + dx * i / 8, y); await sleep(8); }
      await settle(page);
      const tp = await tipE(), ex = await frameX(page, want);
      const wantTc = tcE(edge === 'end' ? want - 1 : want);
      eq(tp && tp.t, wantTc, `拖${edge === 'end' ? '尾端（顯示最後一格）' : '開頭'}：邊緣旁顯示時間碼 ${wantTc}`);
      ok(tp && (edge === 'end' ? tp.l >= ex - 1 && tp.l - ex < 12 : tp.r <= ex + 1 && ex - tp.r < 12) && Math.abs(tp.y - y) < 4, `時間碼貼在${edge === 'end' ? '右' : '左'}側邊緣外、跟片段同高（${JSON.stringify(tp)}，邊緣 x=${ex.toFixed(1)}）`);
      await page.mouse.up(); await settle(page);
      eq(await tipE(), null, '放開後時間碼消失');
      await page.keyboard.press('Control+z'); await settle(page);
    }
  }

  // ---------------------------------------------------------------- 修剪工具：滾動／滑移／滑動／波紋
  console.log('修剪工具（T）：滾動、滑移、滑動、波紋');
  await page.keyboard.press('t');
  eq(await state(page, 'tool'), 'trim', 'T 切到修剪工具');
  cl = await clips(page);
  const L0 = on(cl, 'V1')[0], R0 = on(cl, 'V1')[1];
  vb = await clipBox(page, R0.id);
  const jx = await frameX(page, 90), my = vb.y + vb.h / 2;
  await page.mouse.move(jx + 1, my);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('滾動修剪'), '游標在兩片段交界：工具列顯示「滾動修剪」');
  await drag(page, { x: jx + 1, y: my }, { x: jx + 1 + 20, y: my });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 100], [100, 80]], '滾動修剪：交界右移 10 格，總長不變');
  eq([on(cl, 'V1')[0].in, on(cl, 'V1')[1].in], [0, Math.round((3 + 10 / 30) * 1000) / 1000], '滾動修剪：左半來源不變，右半 srcIn +10 格');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 100], [100, 80]], '連結的聲音一起滾動');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 滑移：片段中段上半部
  vb = await clipBox(page, R0.id);
  await page.mouse.move(vb.x + vb.w / 2, vb.y + 8);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('滑移'), '片段上半部：工具列顯示「滑移」');
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + 8 }, { x: vb.x + vb.w / 2 + 30, y: vb.y + 8 });
  cl = await clips(page);
  eq([on(cl, 'V1')[1].s, on(cl, 'V1')[1].d, on(cl, 'V1')[1].in], [90, 90, 2.5], '滑移：位置與長度不變，srcIn 3 → 2.5（往右拖 15 格＝看到較早的畫面）');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 滑動：片段中段下半部
  vb = await clipBox(page, R0.id);
  await page.mouse.move(vb.x + vb.w / 2, vb.y + vb.h - 6);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('滑動'), '片段下半部：工具列顯示「滑動」');
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h - 6 }, { x: vb.x + vb.w / 2 + 20, y: vb.y + vb.h - 6 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 100], [100, 90]], '滑動：右半整個右移 10 格、左鄰居變長 10 格');
  eq([on(cl, 'V1')[1].in], [3], '滑動：內容（srcIn）不變');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 波紋修剪：先在後面放一段，確認它被推動
  await pickMedia('mute');
  await page.keyboard.press('End');
  await page.keyboard.press('F10');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90], [180, 90]], '後面放了一段無聲影片（180～270）');
  vb = await clipBox(page, L0.id);
  await page.mouse.move(vb.x + 2, vb.y + vb.h / 2);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('波紋修剪'), '片段開頭邊緣（前面沒有鄰居）：工具列顯示「波紋修剪」');
  const lastId = on(cl, 'V1')[2].id;
  vb = await clipBox(page, lastId);
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90], [180, 70]], '波紋修剪：最後一段尾端縮短 20 格');
  vb = await clipBox(page, L0.id);
  await drag(page, { x: vb.x + 2, y: vb.y + vb.h / 2 }, { x: vb.x + 2 + 20, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 80], [80, 90], [170, 70]], '波紋修剪開頭：第一段縮短 10 格，後面的片段全部往前補');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 80], [80, 90]], '音訊軌也一起波紋（保持同步）');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原回到兩個相鄰的半段');
  await page.keyboard.press('a');

  // ---------------------------------------------------------------- 多選一起修剪
  console.log('多選一起修剪');
  await page.keyboard.press('a');
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  vb = await clipBox(page, R0.id);
  await page.keyboard.down('Shift');
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await page.keyboard.up('Shift');
  await settle(page);
  ok((await page.evaluate(() => [...window.QPTEdit.ui.state.selection])).includes(L0.id), 'Shift 點兩段：兩段都選取');
  await page.keyboard.press('t');
  vb = await clipBox(page, L0.id);
  await page.mouse.move(vb.x + vb.w - 2, vb.y + vb.h / 2);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('波紋修剪（所有選取的片段）'), '修剪工具＋多選：邊緣顯示「波紋修剪（所有選取的片段）」，不是滾動');
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 70], [70, 70]], '多選波紋修剪：拉第一段尾端 -20 格，兩段都縮短 20 格、不留空隙');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 70], [70, 70]], '連結的聲音一起');
  const selNow = await page.evaluate(() => [...window.QPTEdit.ui.state.selection]);
  ok(selNow.includes(L0.id) && selNow.includes(R0.id), '拖完後兩段仍然是選取狀態');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z'); await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '整個多選拖曳只記一筆復原');
  await page.keyboard.press('a');
  vb = await clipBox(page, R0.id);
  await page.mouse.move(vb.x + vb.w - 2, vb.y + vb.h / 2);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('一般修剪（所有選取的片段）'), '選取工具＋多選：邊緣顯示「一般修剪（所有選取的片段）」');
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 70], [90, 70]], '多選一般修剪：拉第二段尾端 -20 格，兩段都縮短 20 格、不推動（留空隙）');
  await shot(page, `${tag}-multi-trim`);
  await page.keyboard.press('Control+z'); await settle(page);
  await page.keyboard.press('Escape'); await settle(page);
  eq((await page.evaluate(() => window.QPTEdit.ui.state.selection.size)), 0, 'Esc 取消選取');
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await settle(page);
  vb = await clipBox(page, L0.id);
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 70], [90, 90]], '只選一段時照舊只修剪那一段');
  await page.keyboard.press('Control+z'); await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原回到兩個相鄰的半段');

  // ---------------------------------------------------------------- 轉場
  console.log('轉場');
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await settle(page);
  await page.click('.ed-tab[data-tab="trans"]');
  ok(await page.isVisible('#edTransList .ed-gitem'), '轉場分頁：列出轉場縮圖');
  eq(await page.evaluate(() => document.querySelectorAll('#edTransList .ed-gitem').length), 21, '列出 21 種轉場（8 種基本＋11 種 WebGL＋4.20 的負片閃、光線劃開）');
  await page.click('#edTransAdd');
  await settle(page);
  let trs = await proj(page, p => Object.values(p.transitions));
  eq(trs.length, 1, '「加到結尾」：新增 1 個轉場');
  eq([trs[0].type, trs[0].leftClipId === L0.id, trs[0].rightClipId === R0.id], ['crossDissolve', true, true], '轉場在左半與右半之間（交叉疊化）');
  ok(await page.isVisible('.ed-trans'), '時間軸上畫出轉場方塊');
  ok(await page.isVisible('.ed-sec[data-sec="fx-transition"]'), '點選轉場後檢查器顯示「轉場」區段');
  ok((await page.textContent('#edInspHead')).includes('轉場'), '檢查器標題顯示轉場');
  // 拖轉場右側把手改長度
  const tb = await page.evaluate(() => { const r = document.querySelector('.ed-trans-h.r').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await drag(page, tb, { x: await frameX(page, 110), y: tb.y });
  trs = await proj(page, p => Object.values(p.transitions));
  eq(trs[0].duration, 40, '拖轉場邊緣：長度改成 40 格（置中對齊，左右各 20）');
  // 用檢查器改類型
  await page.selectOption('.ed-sec[data-sec="fx-transition"] select >> nth=0', 'wipe');
  await settle(page);
  eq(await proj(page, p => Object.values(p.transitions)[0].type), 'wipe', '檢查器改類型：擦拭');
  // 從轉場庫拖一個到剪接點
  await page.locator('#edTransList .ed-gitem[data-trans="push"]').scrollIntoViewIfNeeded();
  const gi = await page.evaluate(() => { const r = document.querySelector('#edTransList .ed-gitem[data-trans="push"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const v1y = await laneBox(page, 'V1');
  await drag(page, gi, { x: await frameX(page, 90) + 3, y: v1y.y + v1y.h / 2 }, { steps: 14 });
  trs = await proj(page, p => Object.values(p.transitions));
  eq([trs.length, trs[0].type], [1, 'push'], '把轉場拖到剪接點：取代成「推擠」（同一個剪接點只有一個轉場）');
  eq(await invariants(page), [], '不變式 OK');
  await shot(page, `${tag}-4a-transition`);
  await page.keyboard.press('Delete');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 0, '選取轉場後按 Delete：刪除轉場');

  // ---------------------------------------------------------------- 單邊轉場（轉場屬於片段邊緣）
  console.log('單邊轉場：修剪拉開後保留、加到開頭、拖到片段開頭、聲音交叉淡化、復原重做');
  const layoutKey = () => page.evaluate(() => { const p = QPTEdit.ui.state.project; return JSON.stringify([p.clips, p.transitions]); });
  const before4b = await layoutKey();
  const trOf = () => proj(page, p => Object.values(p.transitions).map(x => ({ id: x.id, l: x.leftClipId, r: x.rightClipId, type: x.type, d: x.duration, side: Q.core.transitionSide(x) })).sort((a, b) => (a.id < b.id ? -1 : 1)));
  const transCenter = id => page.evaluate(id => { const r = document.querySelector(`.ed-trans[data-trans="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await page.click('.ed-tab[data-tab="trans"]');
  await page.click('#edTransList .ed-gitem[data-trans="crossDissolve"]');
  await page.click('#edTransAdd');
  await settle(page);
  let st = await trOf();
  eq(st.map(x => [x.l === L0.id, x.r === R0.id, x.side]), [[true, true, 'both']], '先在剪接點加交叉疊化（兩片段之間）');
  const tr4b = st[0].id;
  // 選取工具拖右半的左邊緣（片段上半部；轉場方塊在下半部）往右 15 格
  vb = await clipBox(page, R0.id);
  const px15 = (await frameX(page, 105)) - (await frameX(page, 90));
  await drag(page, { x: vb.x + 2, y: vb.y + 8 }, { x: vb.x + 2 + px15, y: vb.y + 8 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [105, 75]], '拖右半的左邊緣 +15 格：剪接點拉開');
  st = await trOf();
  eq(st.map(x => [x.id, x.l, x.r === R0.id, x.side]), [[tr4b, null, true, 'in']], '轉場沒有被刪掉：跟著被修剪的右半開頭，變成開頭淡入');
  ok(await page.isVisible(`.ed-trans.in[data-trans="${tr4b}"]`), '時間軸畫出開頭淡入的轉場方塊');
  eq(await invariants(page), [], '不變式 OK');
  // 點選 → 檢查器編輯
  await page.mouse.click(...Object.values(await transCenter(tr4b)));
  await settle(page);
  ok(await page.isVisible('.ed-sec[data-sec="fx-transition"]'), '點選單邊轉場：檢查器顯示「轉場」區段');
  ok((await page.textContent('#edInspHead')).includes('開頭淡入'), '檢查器標題標示「開頭淡入」');
  eq(await page.evaluate(() => [...document.querySelectorAll('.ed-sec[data-sec="fx-transition"] .ed-fx-row')].filter(r => !r.hidden).map(r => (r.querySelector('.ed-fx-lab') || {}).textContent).includes('對齊')), false, '單邊轉場不顯示「對齊」');
  eq(await page.evaluate(id => [...document.querySelectorAll(`.ed-trans[data-trans="${id}"] .ed-trans-h`)].map(h => h.dataset.side), tr4b), ['r'], '開頭淡入只有右側把手（左側貼著片段開頭）');
  // 拖右側把手改長度
  const hr = await page.evaluate(id => { const r = document.querySelector(`.ed-trans[data-trans="${id}"] .ed-trans-h.r`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, tr4b);
  await drag(page, hr, { x: await frameX(page, 130), y: hr.y });
  st = await trOf();
  eq([st[0].side, st[0].d], ['in', 25], '拖開頭淡入的右側把手：長度改成 25 格');
  await page.selectOption('.ed-sec[data-sec="fx-transition"] select >> nth=0', 'dipToColor');
  await settle(page);
  st = await trOf();
  eq([st[0].side, st[0].type], ['in', 'dipToColor'], '檢查器改類型：浸入顏色');
  // 復原三次回到兩片段之間，重做三次回來
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await settle(page);
  st = await trOf();
  eq(st.map(x => [x.id, x.side, x.type, x.d]), [[tr4b, 'both', 'crossDissolve', 15]], '復原三次：回到剪接點上的交叉疊化');
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原後片段接回去');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+z');
  await settle(page);
  st = await trOf();
  eq(st.map(x => [x.id, x.side, x.type, x.d]), [[tr4b, 'in', 'dipToColor', 25]], '重做三次：開頭淡入、浸入顏色、25 格');
  // 加到開頭（左半在時間軸起點）、加到結尾（左半後面現在是空隙 → 尾端淡出）
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + 8);
  await page.click('#edTransList .ed-gitem[data-trans="fadeToBlack"]');
  ok(await page.isVisible('#edTransAddIn'), '轉場分頁有「加到開頭」按鈕');
  await page.click('#edTransAddIn');
  await settle(page);
  st = await trOf();
  const headL = st.find(x => x.r === L0.id && !x.l);
  ok(headL && headL.type === 'fadeToBlack' && headL.side === 'in', '「加到開頭」：左半開頭（時間軸起點）加上淡入');
  ok((await statusText(page)).includes('加在片段開頭（淡入）'), '狀態列提示「加在片段開頭（淡入）」');
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + 8);
  await page.click('#edTransList .ed-gitem[data-trans="crossDissolve"]');
  await page.click('#edTransAdd');
  await settle(page);
  st = await trOf();
  const tailL = st.find(x => x.l === L0.id && !x.r);
  ok(tailL && tailL.side === 'out', '「加到結尾」：左半後面是空隙 → 尾端淡出');
  eq(st.length, 3, '時間軸上有 3 個單邊轉場');
  ok(await page.isVisible('.ed-trans.out') && (await page.locator('.ed-trans.in').count()) === 2, '時間軸畫出尾端淡出與兩個開頭淡入');
  // 截圖：放大時間軸，看清楚貼在片段邊緣的單邊轉場（截完恢復原本的縮放）
  const zoom4b = await state(page, 'zoom');
  const zoomShot = async (name, f0) => {
    await page.evaluate(() => QPTEdit.ui.setZoom(QPTEdit.ui.state.zoom * 3.2, false));
    await page.evaluate(f => { const s = document.querySelector('.ed-tl-scroll') || document.querySelector('.ed-tl-inner').parentElement; s.scrollLeft = Math.max(0, f * QPTEdit.ui.ppf); }, f0);
    await settle(page);
    await shot(page, name);
    await page.evaluate(z => QPTEdit.ui.setZoom(z, false), zoom4b);
    await settle(page);
  };
  await page.evaluate(() => QPTEdit.ui.seekTimeline(8));
  await page.evaluate(id => QPTEdit.ui.selectTransition(id), headL.id);
  await zoomShot(`${tag}-4b-single-transitions`, 0);
  // 從轉場庫拖到片段開頭（前面是空隙）：先刪掉右半的開頭淡入，再把「擦拭」拖到右半開頭
  await page.mouse.click(...Object.values(await transCenter(tr4b)));
  await page.keyboard.press('Delete');
  await settle(page);
  eq((await trOf()).length, 2, '刪掉右半的開頭淡入');
  await page.locator('#edTransList .ed-gitem[data-trans="wipe"]').scrollIntoViewIfNeeded();
  const gw = await page.evaluate(() => { const r = document.querySelector('#edTransList .ed-gitem[data-trans="wipe"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const v1l = await laneBox(page, 'V1');
  await drag(page, gw, { x: await frameX(page, 105) + 3, y: v1l.y + v1l.h / 2 }, { steps: 14 });
  st = await trOf();
  const headR = st.find(x => x.r === R0.id && !x.l);
  ok(headR && headR.type === 'wipe' && headR.side === 'in', '把轉場拖到片段開頭（前面是空隙）：加上開頭淡入（擦拭）');
  eq(await invariants(page), [], '不變式 OK');
  // 接回去：把右半的開頭拖回 90（拖過頭會被夾住）→ 剪接點兩側各有一個單邊 → 保留左側（左半的尾端淡出）變雙邊
  vb = await clipBox(page, R0.id);
  await drag(page, { x: vb.x + 2, y: vb.y + 8 }, { x: (await frameX(page, 86)), y: vb.y + 8 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '右半開頭拖回 90：片段接回去（不會蓋到左半）');
  st = await trOf();
  eq(st.map(x => [x.id, x.side]).sort(), [[headL.id, 'in'], [tailL.id, 'both']].sort(), '保留左側的轉場並轉成雙邊，右側的開頭淡入移除');
  eq(st.find(x => x.id === tailL.id).r, R0.id, '雙邊轉場接到右半');
  // 交叉淡化時的音訊片段：A1 上畫出淡出＋淡入兩條曲線（起點淡入只有一條）
  const xfs = await page.evaluate(() => { const p = QPTEdit.ui.state.project, a1 = p.tracks.find(t => t.name === 'A1'); return [...document.querySelectorAll(`.ed-lane[data-track="${a1.id}"] .ed-xfade`)].map(e => e.className.replace('ed-xfade ', '')).sort(); });
  eq(xfs, ['in', 'in', 'out'], '音訊軌畫出聲音淡化：剪接點交叉淡化（淡出＋淡入）、開頭淡入');
  const plan = await proj(page, (p, Q) => Q.core.audioTransitionPlan(p));
  ok(Object.values(plan).some(e => e.fades.some(f => f.dir === 'out')) && Object.values(plan).filter(e => e.fades.some(f => f.dir === 'in')).length === 2, '聲音計畫：左段淡出、右段淡入、左段開頭淡入');
  await page.evaluate(id => QPTEdit.ui.selectTransition(id), tailL.id);
  await page.evaluate(() => QPTEdit.ui.seekTimeline(82));
  await zoomShot(`${tag}-4c-audio-crossfade`, 30);
  // 復原：回到拉開的狀態（3 個單邊）；重做：接回去
  await page.keyboard.press('Control+z');
  await settle(page);
  eq((await trOf()).map(x => x.side).sort(), ['in', 'in', 'out'], '復原：回到拉開時的三個單邊轉場');
  await page.keyboard.press('Control+y');
  await settle(page);
  eq((await trOf()).map(x => x.side).sort(), ['both', 'in'], '重做：再接回去');
  eq(await invariants(page), [], '不變式 OK');
  // 回到這一段開始前的狀態（後面的測試沿用）
  await page.evaluate(want => {
    const Q = window.QPTEdit, key = () => { const p = Q.ui.state.project; return JSON.stringify([p.clips, p.transitions]); };
    for (let i = 0; i < 40 && key() !== want && Q.ui.state.history.canUndo; i++) Q.ui.undo();
  }, before4b);
  await settle(page);
  eq(await layoutKey(), before4b, '全部復原：回到這一段開始前');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- 字幕
  console.log('字幕');
  await page.click('.ed-tab[data-tab="title"]');
  eq(await page.evaluate(() => document.querySelectorAll('#edTitleList .ed-gitem').length), 7, '字幕分頁：列出 7 種樣式（含 4.20 黑底小字幕）');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(30));
  await page.click('#edTitleAdd');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d, c.type]), [[30, 90, 'title']], '在播放頭新增字幕：放在最上層的 V2，3 秒');
  ok(await page.isVisible('.ed-sec[data-sec="fx-title"]'), '選取字幕：檢查器出現「字幕」區段');
  const ta = page.locator('.ed-sec[data-sec="fx-title"] textarea');
  await ta.fill('測試字幕');
  await ta.press('Tab');
  await settle(page);
  eq(await proj(page, p => Object.values(p.clips).find(c => c.type === 'title').title.text), '測試字幕', '在檢查器改字幕文字');
  // 拖字幕樣式到 V2
  await page.locator('#edTitleList .ed-gitem[data-title="lowerThird"]').scrollIntoViewIfNeeded();
  const gt = await page.evaluate(() => { const r = document.querySelector('#edTitleList .ed-gitem[data-title="lowerThird"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const v2l = await laneBox(page, 'V2');
  await drag(page, gt, { x: await frameX(page, 150), y: v2l.y + v2l.h / 2 }, { steps: 14 });
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d]), [[30, 90], [150, 90]], '把字幕樣式拖到 V2 的 150 格');
  eq(await proj(page, p => Object.values(p.clips).filter(c => c.type === 'title').map(c => c.title.preset).sort()), ['lowerThird', 'static'], '字幕樣式正確（靜態、下三分之一條）');
  eq(await invariants(page), [], '不變式 OK');

  // ---------------------------------------------------------------- 字幕樣式、字體特效
  console.log('字幕樣式、字體特效');
  const heads = () => page.evaluate(() => [...document.querySelectorAll('.ed-panel:not([hidden]) .ed-ghead')].map(h => h.textContent));
  eq(await page.textContent('.ed-tab[data-tab="trans"]'), '特效', '分頁「轉場」改名為「特效」');
  eq(await heads(), ['字幕清單', '字幕過場', '字幕樣式'], '字幕分頁分成「字幕清單」「字幕過場」「字幕樣式」');
  eq(await page.evaluate(() => document.querySelectorAll('#edTStyleList .ed-gitem').length), 9, '列出 9 種字幕樣式（基本＋4 種附圖樣式＋4.20 的 4 種）');
  const [tA, tB] = on(await clips(page), 'V2');
  const tOf = id => proj(page, (p, Q, id) => p.clips[id].title, id);
  const selClip = async id => { const b = await clipBox(page, id); await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2); await settle(page); };
  // 按鈕套用：選第一個字幕 → 選「黑邊青框」→ 套用
  await selClip(tA.id);
  await page.click('#edTStyleList .ed-gitem[data-tstyle="blackCyan"]');
  await page.click('#edTStyleApply');
  await settle(page);
  let tt = await tOf(tA.id);
  eq([tt.stroke.color, tt.outlines[0].on, tt.outlines[0].color, tt.text], ['#111111', true, '#3fd8d8', '測試字幕'], '按鈕套用「黑邊青框」：黑描邊＋青色外框，文字不變');
  ok((await page.textContent('#edUndoLab')).includes('字幕樣式'), '套用樣式記一筆復原（字幕樣式）');
  // 拖曳套用：「黑邊強調紅」拖到第二個字幕上
  const dragOnto = async (sel, id) => {
    await page.locator(sel).scrollIntoViewIfNeeded();
    const g = await page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const b = await clipBox(page, id);
    await drag(page, g, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, { steps: 14 });
    await settle(page);
  };
  await dragOnto('#edTStyleList .ed-gitem[data-tstyle="redAccent"]', tB.id);
  tt = await tOf(tB.id);
  eq([tt.accent, tt.skew, tt.stroke.color], ['#e5141b', 10, '#141414'], '把「黑邊強調紅」拖到字幕片段上：套用強調紅、斜體');
  eq(on(await clips(page), 'V2').length, 2, '拖樣式到字幕上不會新增片段');
  // 拖到影片片段上：不套用、顯示錯誤
  const clipsBefore = await proj(page, p => JSON.stringify(p.clips));
  await dragOnto('#edTStyleList .ed-gitem[data-tstyle="purple3d"]', on(await clips(page), 'V1')[0].id);
  eq(await proj(page, p => JSON.stringify(p.clips)), clipsBefore, '拖樣式到影片片段：不改任何東西');
  // 字體特效（在「特效」分頁）
  await page.click('.ed-tab[data-tab="trans"]');
  eq(await heads(), ['轉場特效', '字體特效'], '特效分頁分成「轉場特效」「字體特效」');
  eq(await page.evaluate(() => [...document.querySelectorAll('#edTextFxList .ed-gitem')].map(i => i.dataset.textfx)), ['none', 'pop', 'popLine', 'popChar', 'jump', 'jumpLine', 'jumpChar', 'fade', 'fadeLine', 'fadeChar', 'blurIn', 'echo', 'smear'], '字體特效：無／彈出／逐行彈出／逐字彈出／下往上跳起／逐行跳起／逐字跳起＋4.20 的淡入／逐行淡入／逐字淡入／模糊浮現／殘影／拖影上衝');
  await selClip(tA.id);
  await page.click('#edTextFxList .ed-gitem[data-textfx="jumpChar"]');
  await page.click('#edTextFxApply');
  await settle(page);
  eq((await tOf(tA.id)).textFx, 'jumpChar', '按鈕套用「逐字跳起」');
  ok((await page.textContent('#edUndoLab')).includes('字體特效'), '套用字體特效記一筆復原');
  await dragOnto('#edTextFxList .ed-gitem[data-textfx="pop"]', tB.id);
  eq((await tOf(tB.id)).textFx, 'pop', '把「彈出」拖到字幕片段上');
  // 詳細內容：選字幕 → 文字／外觀／動畫／變形／資訊 分頁
  await selClip(tA.id);
  eq(await page.evaluate(() => [...document.querySelectorAll('#edInspTabs .ed-itab')].map(b => b.textContent)), ['文字', '外觀', '動畫', '變形', '資訊'], '選取字幕：詳細內容分頁＝文字／外觀／動畫／變形／資訊');
  await page.click('.ed-itab[data-itab="text"]');
  ok(await page.isVisible('.ed-sec[data-sec="fx-title"]') && !(await page.isVisible('.ed-sec[data-sec="fx-titleLook"]')), '「文字」分頁只顯示文字相關欄位');
  // 選字變色：點「測」「試」變紅（一筆復原）
  const chipB = async ch => { const b = await page.locator('.ed-sec[data-sec="fx-title"] .ed-fx-ch', { hasText: ch }).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  await drag(page, await chipB('測'), await chipB('試'), { steps: 4 });
  await settle(page);
  eq((await tOf(tA.id)).text, '*測試*字幕', '選字變色：拖過「測試」→ 文字加上強調標記');
  ok((await page.textContent('#edUndoLab')).includes('字幕文字'), '選字變色記一筆復原');
  await page.click('.ed-itab[data-itab="look"]');
  ok(await page.isVisible('.ed-sec[data-sec="fx-titleLook"]') && !(await page.isVisible('.ed-sec[data-sec="fx-title"]')), '切到「外觀」分頁');
  await page.click('.ed-itab[data-itab="anim"]');
  eq(await page.inputValue('.ed-sec[data-sec="fx-titleAnim"] .ed-fx-row:has-text("進場") select'), 'jumpChar', '「動畫」分頁顯示這個字幕的字體特效');
  await page.selectOption('.ed-sec[data-sec="fx-titleAnim"] .ed-fx-row:has-text("進場") select', 'jumpLine');
  await settle(page);
  eq((await tOf(tA.id)).textFx, 'jumpLine', '在詳細內容改成逐行跳起');
  await shot(page, `${tag}-4c-insp-tabs`);
  await selClip(tB.id);
  ok(await page.isVisible('.ed-sec[data-sec="fx-titleAnim"]'), '換選另一個字幕：停在同一個分頁（動畫）');
  await page.click('.ed-itab[data-itab="text"]');
  // 點時間軸空白處：取消選取，播放頭不動
  await page.evaluate(() => QPTEdit.ui.seekTimeline(40));
  await settle(page);
  const v2e = await laneBox(page, 'V2');
  await page.mouse.click(await frameX(page, 400), v2e.y + v2e.h / 2);
  await settle(page);
  eq([await page.evaluate(() => QPTEdit.ui.state.selection.size), await page.evaluate(() => QPTEdit.ui.state.playhead)], [0, 40], '點軌道空白處：取消選取，播放頭不動');
  ok(!(await page.isVisible('#edInspTabs')) && await page.isVisible('.ed-sec[data-sec="project"]'), '沒選東西：詳細內容回到專案資訊');
  await selClip(tB.id);
  const below = await page.evaluate(() => { const s = document.querySelector('.ed-tl-scroll'), r = s.getBoundingClientRect(), lanes = [...document.querySelectorAll('.ed-lane')].map(l => l.getBoundingClientRect().bottom); return { x: r.left + r.width / 2, y: Math.max(...lanes) + 12, ok: Math.max(...lanes) + 12 < r.top + s.clientHeight }; });
  if (below.ok) {
    await page.mouse.click(below.x, below.y);
    await settle(page);
    eq([await page.evaluate(() => QPTEdit.ui.state.selection.size), await page.evaluate(() => QPTEdit.ui.state.playhead)], [0, 40], '點軌道下方的空白：也取消選取，播放頭不動');
  }
  const rl = await page.evaluate(() => { const r = document.querySelector('.ed-ruler').getBoundingClientRect(); return { y: r.top + r.height / 2 }; });
  await page.mouse.click(await frameX(page, 60), rl.y);
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.state.playhead), 60, '點時間尺：播放頭才移動');

  // ---------------------------------------------------------------- 字幕清單：V 標記、輸入文字、SRT 匯入
  console.log('字幕清單：V 標記、SRT 匯入');
  const baseSnap = await proj(page, p => JSON.stringify([p.clips, p.tracks]));
  const fps = await proj(page, p => p.fps);
  const subs = () => proj(page, p => Object.values(p.clips).filter(c => c.type === 'title' && c.title.sub).sort((a, b) => a.start - b.start).map(c => ({ s: c.start, d: c.duration, t: c.title.text, tr: p.tracks.find(x => x.id === c.trackId).name })));
  await page.evaluate(() => QPTEdit.ui.selectClips([]));
  await page.click('.ed-tab[data-tab="title"]');
  ok(await page.isVisible('#edSubMark'), '字幕分頁：播放控制列右側出現「V」');
  await page.click('.ed-tab[data-tab="media"]');
  ok(!(await page.isVisible('#edSubMark')), '媒體分頁、沒選字幕：不顯示 V');
  await page.click('.ed-tab[data-tab="title"]');
  await page.evaluate(() => { QPTEdit.ui.seekTimeline(30); document.activeElement && document.activeElement.blur(); });
  await page.keyboard.press('v');
  await settle(page);
  eq(await subs(), [{ s: 30, d: 10 * fps, t: '', tr: '字幕' }], '按 V：在播放頭加一段字幕（10 秒），放在新的「字幕」軌');
  ok(await page.isVisible('.ed-itab.active[data-itab="subs"]') && await page.isVisible('.ed-sec[data-sec="subs"]'), '詳細內容切到「字幕清單」');
  eq(await page.evaluate(() => document.querySelectorAll('.ed-subrow').length), 1, '字幕清單多一行');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(90));
  await page.click('#edSubMark');
  await settle(page);
  eq((await subs()).map(x => [x.s, x.d]), [[30, 60], [90, 10 * fps]], '在第一段播放中按 V：第一段改成在 89 格結束（新的一段減 1 格）');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(60));
  await page.click('#edSubMark');
  await settle(page);
  eq((await subs()).map(x => [x.s, x.d]), [[30, 30], [60, 30], [90, 10 * fps]], '插在兩段中間：前一段縮短、新的一段碰到後一段就停');
  eq(await page.evaluate(() => document.querySelectorAll('.ed-subrow').length), 3, '字幕清單共 3 行（依時間排序）');
  // 一行一行輸入：Enter 跳下一行
  const rows = page.locator('.ed-subrow .ed-subtxt');
  await rows.nth(0).click();
  await page.keyboard.type('第一句');
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => document.activeElement === document.querySelectorAll('.ed-subrow .ed-subtxt')[1]), 'Enter：跳到下一行');
  await page.keyboard.type('第二句');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('換行');
  await page.keyboard.press('Escape');
  await settle(page);
  eq((await subs()).map(x => x.t), ['第一句', '第二句\n換行', ''], '字幕清單輸入的文字寫進字幕片段（Shift＋Enter 換行）');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(45));
  await settle(page);
  await shot(page, `${tag}-4d-subtitle-list`);
  // 刪除一行
  await page.locator('.ed-subrow').nth(2).locator('.ed-subdel').click();
  await settle(page);
  eq((await subs()).length, 2, '按 × 刪除那一段字幕');
  // 復原回到標記前
  for (let i = 0; i < 12 && (await proj(page, p => JSON.stringify([p.clips, p.tracks]))) !== baseSnap; i++) { await page.keyboard.press('Control+z'); await settle(page); }
  eq(await proj(page, p => JSON.stringify([p.clips, p.tracks])), baseSnap, '復原：字幕與「字幕」軌都拿掉');
  // SRT 匯入（UTF-8，含重疊）
  const srtText = '1\n00:00:00,500 --> 00:00:02,000\n大家好\n\n2\n00:00:01,500 --> 00:00:03,000\n歡迎收看\n第二行\n';
  await page.setInputFiles('#edSrtFile', { name: 'demo.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(srtText, 'utf8') });
  await settle(page);
  for (let i = 0; i < 20 && (await subs()).length < 2; i++) await page.waitForTimeout(100);
  eq((await subs()).map(x => [x.s, x.d, x.t, x.tr]), [[Math.round(0.5 * fps), Math.round(1.5 * fps) - Math.round(0.5 * fps), '大家好', '字幕'], [Math.round(1.5 * fps), Math.round(3 * fps) - Math.round(1.5 * fps), '歡迎收看\n第二行', '字幕']], '匯入 SRT：每段一個字幕片段，重疊的前一段結束在下一段前一格');
  eq(await page.evaluate(() => [...document.querySelectorAll('.ed-subrow .ed-subtxt')].map(t => t.value)), ['大家好', '歡迎收看\n第二行'], '匯入後字幕清單列出每一段');
  ok((await page.textContent('#edUndoLab')).includes('匯入 SRT'), '匯入 SRT 一筆復原');
  // 匯出 SRT：攔下下載，檢查檔名與內容（再匯入會得到一樣的時間）
  await page.evaluate(() => {
    window.__dl = [];
    window.__dlRestore = [URL.createObjectURL, HTMLAnchorElement.prototype.click];
    const mk = URL.createObjectURL.bind(URL), blobs = new Map();
    URL.createObjectURL = b => { const u = mk(b); blobs.set(u, b); return u; };
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push({ name: this.download, blob: blobs.get(this.href) }); };
  });
  await page.click('.ed-tab[data-tab="title"]');
  await page.click('#edSrtExport');
  const srtDl = await page.evaluate(async () => { const d = window.__dl.pop(); return d && { name: d.name, type: d.blob.type, text: await d.blob.text() }; });
  ok(srtDl && /^字幕_\d{10}\.srt$/.test(srtDl.name), '匯出 SRT：檔名「字幕_日期時間.srt」（' + (srtDl && srtDl.name) + '）');
  eq(srtDl && srtDl.text, `1\n${srtTc(0.5 * fps, fps)} --> ${srtTc(1.5 * fps, fps)}\n大家好\n\n2\n${srtTc(1.5 * fps, fps)} --> ${srtTc(3 * fps, fps)}\n歡迎收看\n第二行\n`, '匯出 SRT：內容是字幕清單的每一段');
  await page.click('#edSubsExport');
  eq(await page.evaluate(() => window.__dl.length), 1, '詳細內容「清單」分頁的匯出 SRT 按鈕也能匯出');
  await page.evaluate(() => { [URL.createObjectURL, HTMLAnchorElement.prototype.click] = window.__dlRestore; });
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, p => JSON.stringify([p.clips, p.tracks])), baseSnap, '復原匯入');
  // 拖進來的 .srt 走字幕匯入（不會被當成不支援的素材）；Big5 編碼也讀得懂（「字幕」＝A6 72 B9 F5）
  const big5 = [...Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'ascii'), 0xA6, 0x72, 0xB9, 0xF5, 0x0A];
  await page.evaluate(b => QPTEdit.ui.importFiles([new File([new Uint8Array(b)], 'old.SRT', { type: '' })]), big5);
  for (let i = 0; i < 20 && !(await subs()).length; i++) await page.waitForTimeout(100);
  eq((await subs()).map(x => [x.s, x.t]), [[fps, '字幕']], '拖進 .srt（Big5 編碼）：匯入成字幕');
  ok(!(await page.isVisible('#edMsgs .ed-msg.err')), '沒有「不支援的格式」錯誤');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, p => JSON.stringify([p.clips, p.tracks])), baseSnap, '復原');
  eq(await invariants(page), [], '不變式 OK');
  // 預覽動畫：逐字跳起開頭 0.1 秒的畫面跟 1 秒時不同（字還在往上跳）
  await page.evaluate(() => QPTEdit.ui.seekTimeline(33));
  await settle(page);
  await shot(page, `${tag}-4a-textfx-mid`);
  await page.evaluate(() => QPTEdit.ui.seekTimeline(70));
  await settle(page);
  await shot(page, `${tag}-4b-title-styles`);
  // 新字幕套用目前選取的樣式
  await page.click('.ed-tab[data-tab="title"]');
  await page.click('#edTStyleList .ed-gitem[data-tstyle="purple3d"]');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(260));
  await page.click('#edTitleAdd');
  await settle(page);
  const nt = on(await clips(page), 'V2').find(c => c.id !== tA.id && c.id !== tB.id);
  eq(nt && (await tOf(nt.id)).extrude.depth, 16, '新增字幕：用目前選取的樣式（紫色立體）');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(on(await clips(page), 'V2').length, 2, '復原新增的字幕');
  await page.click('#edTStyleList .ed-gitem[data-tstyle="plain"]');
  if (await page.isVisible('#edMsgs .ed-msg')) await page.evaluate(() => document.querySelectorAll('#edMsgs .ed-msg-x').forEach(b => b.click()));
  eq(await invariants(page), [], '不變式 OK');
  // 截圖用：多軌片段＋轉場＋字幕同時出現
  const l0box = await clipBox(page, L0.id);
  await page.mouse.click(l0box.x + l0box.w / 2, l0box.y + l0box.h - 8);
  await page.click('.ed-tab[data-tab="trans"]');
  await page.click('#edTransList .ed-gitem[data-trans="crossDissolve"]');
  await page.click('#edTransAdd');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 1, '再加一個交叉疊化（截圖用）');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(90));
  await settle(page);
  await shot(page, `${tag}-4-multitrack`);
  await page.keyboard.press('Delete');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 0, '刪除轉場');
  await page.click('.ed-tab[data-tab="title"]');


  // ---------------------------------------------------------------- 檢查器：變形、音訊（增益、淡入淡出、EQ）
  console.log('檢查器：變形、音訊');
  cl = await clips(page);
  const v1a = on(cl, 'V1')[0], a1 = on(cl, 'A1')[0];
  let cb = await clipBox(page, v1a.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await settle(page);
  if (!(await page.isVisible('.ed-sec[data-sec="fx-transform"]'))) console.log('       DEBUG', JSON.stringify(await page.evaluate(() => ({ sel: [...QPTEdit.ui.state.selection], prim: QPTEdit.ui.state.primary, tr: QPTEdit.ui.state.selTransition, secs: [...document.querySelectorAll('.ed-sec')].map(s => s.dataset.sec + ':' + s.hidden), head: document.getElementById('edInspHead').textContent }))), JSON.stringify(cb));
  ok(await page.isVisible('.ed-sec[data-sec="fx-transform"]'), '選取影片片段：檢查器出現「變形」區段');
  eq(await page.evaluate(() => [...document.querySelectorAll('#edInspTabs .ed-itab')].map(b => b.textContent)), ['變形', '裁切', '音訊', '速度', '資訊'], '選取影片片段：詳細內容分頁＝變形／裁切／音訊／速度／資訊');
  ok(!(await page.isVisible('.ed-sec[data-sec="info"]')) && !(await page.isVisible('.ed-sec[data-sec="audio"]')), '一次只顯示一個分頁的內容');
  await page.click('.ed-itab[data-itab="info"]');
  ok(await page.isVisible('.ed-sec[data-sec="info"]') && !(await page.isVisible('.ed-sec[data-sec="fx-transform"]')), '檢查器：切到「資訊」分頁看片段資訊');
  await page.click('.ed-itab[data-itab="xform"]');
  const zl = page.locator('.ed-sec[data-sec="fx-transform"] .ed-fx-lab:text-is("縮放 X")');
  await zl.scrollIntoViewIfNeeded();
  const zb = await zl.boundingBox();
  await drag(page, { x: zb.x + zb.width / 2, y: zb.y + zb.height / 2 }, { x: zb.x + zb.width / 2 + 100, y: zb.y + zb.height / 2 });
  const tf = await proj(page, (p, Q, id) => p.clips[id].video.transform, v1a.id);
  ok(Math.abs(tf.zoomX - 1.5) < 0.02 && Math.abs(tf.zoomY - 1.5) < 0.02, `在標籤上左右拖曳：縮放 X／Y 連動變成 1.5（${tf.zoomX}）`);
  ok((await page.textContent('#edUndoLab')).includes('變形'), '拖曳整段只記一筆復原（調整變形）');
  await shot(page, `${tag}-5-inspector-transform`);
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].video.transform.zoomX, v1a.id), 1, '一次復原就回到 1（拖曳過程沒有留下中間步驟）');

  // 音訊
  let ab = await clipBox(page, a1.id);
  await page.mouse.click(ab.x + ab.w / 2, ab.y + ab.h - 8);
  await settle(page);
  ok(await page.isVisible('.ed-sec[data-sec="audio"]'), '選取音訊片段：檢查器出現音訊區');
  const gain = page.locator('.ed-sec[data-sec="audio"] input[aria-label="增益"]');
  await gain.fill('-6');
  await gain.press('Tab');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.gainDb, a1.id), -6, '增益改成 -6 dB');
  const panLab = page.locator('.ed-sec[data-sec="audio"] .ed-fx-lab:text-is("Pan")');
  await panLab.scrollIntoViewIfNeeded();
  const pb = await panLab.boundingBox();
  await drag(page, { x: pb.x + 5, y: pb.y + pb.height / 2 }, { x: pb.x + 55, y: pb.y + pb.height / 2 });
  ok(Math.abs((await proj(page, (p, Q, id) => p.clips[id].audio.pan, a1.id)) - 0.25) < 0.011, 'Pan：標籤往右拖 50px → +25%');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.pan, a1.id), 0, 'Pan 拖曳是一筆復原');
  // 淡入淡出：拖上緣兩端的圓點
  ab = await clipBox(page, a1.id);
  const hin = await page.evaluate(id => { const r = document.querySelector(`.ed-clip[data-clip="${id}"] .ed-fade-h.in`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, a1.id);
  await drag(page, hin, { x: await frameX(page, a1.s + 20), y: hin.y });
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.fadeIn, a1.id), 20, '拖淡入把手：淡入 20 格');
  const hout = await page.evaluate(id => { const r = document.querySelector(`.ed-clip[data-clip="${id}"] .ed-fade-h.out`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, a1.id);
  await drag(page, hout, { x: await frameX(page, a1.s + a1.d - 15), y: hout.y });
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.fadeOut, a1.id), 15, '拖淡出把手：淡出 15 格');
  ok((await page.locator(`.ed-clip[data-clip="${a1.id}"] .ed-fade-line`).count()) === 2, '時間軸畫出淡入、淡出曲線');
  await page.fill('.ed-sec[data-sec="audio"] input[aria-label="淡入曲線"]', '50');
  await page.press('.ed-sec[data-sec="audio"] input[aria-label="淡入曲線"]', 'Tab');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.fadeInCurve, a1.id), 0.5, '檢查器改淡入曲線 50%');
  // EQ
  await page.locator('.ed-sec[data-sec="audio"]').getByLabel('啟用 EQ').check();
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.eq.enabled, a1.id), true, '啟用 EQ');
  const g3 = page.locator('input[aria-label="第 3 段增益"]');
  await g3.fill('6');
  await g3.press('Tab');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.eq.bands[2].gain, a1.id), 6, '第 3 段（500 Hz）增益 +6 dB');
  const resp = await page.evaluate(id => QPTEdit.render.eqResponse(QPTEdit.ui.state.project.clips[id].audio.eq, [500])[0], a1.id);
  ok(resp > 5 && resp < 7, `EQ 頻率響應在 500 Hz 約 +6 dB（${resp.toFixed(2)}）`);
  const eqPix = await page.evaluate(() => {
    // 曲線顏色是 --ed-accent（深色／淺色不同），從 CSS 變數讀出來再數畫布上接近它的像素
    const probe = document.createElement('span'); probe.style.color = getComputedStyle(document.getElementById('editApp')).getPropertyValue('--ed-accent').trim(); document.body.appendChild(probe);
    const m = getComputedStyle(probe).color.match(/\d+/g).map(Number); probe.remove();
    const c = document.getElementById('edEqGraph'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - m[0]) + Math.abs(d[i + 1] - m[1]) + Math.abs(d[i + 2] - m[2]) < 60) n++;
    return n;
  });
  ok(eqPix > 200, `頻率響應圖有畫出強調色曲線（${eqPix} 個像素）`);
  await page.locator('#edEqGraph').scrollIntoViewIfNeeded();
  await shot(page, `${tag}-6-inspector-audio-eq`);
  await page.locator('#edEqReset').click();
  await settle(page);
  eq(await invariants(page), [], '不變式 OK');

  // ---------------------------------------------------------------- 變速 50%、定格
  console.log('變速與定格');
  cl = await clips(page);
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await settle(page);
  const beforeRight = on(cl, 'V1')[1].s;
  await page.keyboard.press('Control+r');
  await settle(page);
  ok(await page.isVisible('#edSpeedPct'), 'Ctrl+R 開啟變速視窗');
  await page.fill('#edSpeedPct', '50');
  await page.click('#edSpeedOk');
  await settle(page);
  cl = await clips(page);
  eq([on(cl, 'V1')[0].sp, on(cl, 'V1')[0].d], [0.5, 180], '變速 50%（波紋）：長度 90 → 180 格');
  eq([on(cl, 'A1')[0].sp, on(cl, 'A1')[0].d], [0.5, 180], '連結的聲音一起變速');
  eq(on(cl, 'V1')[1].s, beforeRight + 90, '後面的片段被往後推 90 格');
  ok((await page.locator('.ed-clip.video .ed-badge:text-is("50%")').count()) >= 1, '片段上顯示速度標籤「50%」');
  eq(await invariants(page), [], '不變式 OK');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(30));
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await page.keyboard.press('Shift+r');
  await settle(page);
  ok(await page.isVisible('#edFreezeSec'), 'Shift+R 開啟定格視窗');
  eq(await page.inputValue('#edFreezeSec'), '2', '定格預設長度 2 秒');
  await page.click('#edFreezeIns');
  await settle(page);
  cl = await clips(page);
  const fz = on(cl, 'V1').filter(c => c.fr);
  eq(fz.map(c => [c.s, c.d]), [[30, 60]], '插入定格：在播放頭（30）插入 60 格定格片段');
  ok((await page.locator('.ed-clip.freeze .ed-badge:text-is("定格")').count()) >= 1, '定格片段顯示「定格」標籤');
  eq(await invariants(page), [], '不變式 OK');

  // ---------------------------------------------------------------- 輸出比例
  console.log('輸出比例');
  await page.selectOption('#edAspect', '9:16');
  await settle(page);
  eq(await proj(page, p => [p.aspect, p.width, p.height]), ['9:16', 1080, 1920], '改成 9:16：輸出 1080×1920');
  await page.waitForFunction(() => document.getElementById('edCanvas').height === 1280, null, { timeout: 5000 }).catch(() => {});
  eq(await page.evaluate(() => [document.getElementById('edCanvas').width, document.getElementById('edCanvas').height]), [720, 1280], '檢視器畫布跟著變成直式（預覽縮小到長邊 1280）');
  ok((await page.textContent('#edVDims')).includes('1080×1920'), '檢視器上方顯示輸出尺寸');
  await shot(page, `${tag}-6b-aspect-916`);
  // 3.30 一鍵比例轉換：橫式素材放進 9:16 → 問要怎麼放
  const mm = await proj(page, p => QPTEdit.core.aspectMismatch(p).count);
  ok(mm > 0, '橫式素材放進 9:16：偵測到比例不合的片段 ' + mm);
  ok(await page.isVisible('#edFitPop'), '換比例後跳出「要怎麼放進新的畫面」');
  eq(await page.$$eval('#edFitPop .ed-fitopt', bs => bs.map(b => b.dataset.fit)), ['blur', 'fill', 'fit'], '三個選項：模糊背景／填滿裁切／保持黑邊');
  await shot(page, `${tag}-6c-fit-pop`);
  await page.click('#edFitPop .ed-fitopt[data-fit="blur"]');
  await settle(page);
  ok(!(await page.isVisible('#edFitPop')), '選了之後小視窗關閉');
  const fits = await proj(page, p => Object.values(p.clips).filter(c => c.type === 'media' && c.video && p.mediaInfo[c.mediaId] && p.mediaInfo[c.mediaId].kind !== 'audio').map(c => c.video.fit));
  ok(fits.length > 0 && fits.every(f => f === 'blur'), '所有影片／圖片片段改成模糊背景 ' + JSON.stringify(fits));
  eq(await proj(page, p => QPTEdit.core.aspectMismatch(p).count), 0, '套用後沒有會留黑邊的片段');
  ok((await page.textContent('#edUndoLab')).includes('畫面符合'), '整批只算一步復原（畫面符合）');
  await shot(page, `${tag}-6d-fit-blur`);
  await page.keyboard.press('Control+z');
  await settle(page);
  ok((await proj(page, p => Object.values(p.clips).filter(c => c.type === 'media' && c.video).map(c => c.video.fit))).every(f => f === 'fit'), '復原：回到原本的「符合」');
  ok(await page.$eval('#edAspect', s => [...s.options].some(o => o.value === '1:1')), '輸出比例有 1:1 方形');

  // ---------------------------------------------------------------- 直式版面（有素材、播放中切換）
  console.log('直式版面：改成 9:16 後預設開啟、播放中切換不中斷');
  ok(await page.isVisible('#edVert'), '9:16 直式專案：出現「直式版面」按鈕');
  ok(await page.evaluate(() => document.getElementById('editApp').classList.contains('ed-vert')), '直式專案預設開啟直式版面');
  await page.evaluate(() => QPTEdit.ui.player.seek(10));
  await settle(page);
  await page.evaluate(() => QPTEdit.ui.player.play());
  await sleep(250);
  const vJson = await page.evaluate(() => JSON.stringify(QPTEdit.ui.state.project));
  const vf0 = await page.evaluate(() => QPTEdit.ui.player.frame);
  await page.click('#edVert');
  await sleep(300);
  ok(await page.evaluate(() => QPTEdit.ui.player.playing), '播放中切換直式版面：播放沒有中斷');
  ok((await page.evaluate(() => QPTEdit.ui.player.frame)) > vf0, '播放中切換直式版面：播放頭仍在前進');
  await page.click('#edVert');
  await sleep(200);
  ok(await page.evaluate(() => QPTEdit.ui.player.playing), '再切回去：播放仍在進行');
  await page.evaluate(() => QPTEdit.ui.player.pause());
  eq(await page.evaluate(() => JSON.stringify(QPTEdit.ui.state.project)), vJson, '切換直式版面不會改到專案資料');
  await settle(page);
  await shot(page, `${tag}-6b2-vertical-layout`);
  await page.click('#edVert');       // 關掉：回到一般版面，後面的測試維持原本的版面
  await settle(page);
  ok(!(await page.evaluate(() => document.getElementById('editApp').classList.contains('ed-vert'))), '關閉直式版面：回到一般版面');

  // ---------------------------------------------------------------- 來源模式與來源 In／Out
  console.log('來源模式');
  await page.click('.ed-tab[data-tab="media"]');
  await page.dblclick(`.ed-mitem[data-media="${M('land')}"]`);
  await settle(page);
  eq(await state(page, 'mode'), 'source', '雙擊素材：檢視器切到來源模式');
  ok((await page.getAttribute('#edModeSource', 'aria-pressed')) === 'true', '「來源」鈕呈作用中');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('o');
  await settle(page);
  const sio = await state(page, 'sourceInOut');
  ok(sio && sio.mediaId === M('land') && Math.abs(sio.srcIn - 1) < 1e-6 && Math.abs(sio.srcOut - 61 / 30) < 1e-6, `來源 In／Out：1.00 秒 – 2.03 秒（${JSON.stringify(sio)}）`);
  ok((await page.textContent('#edSrcIO')).includes('來源 In'), '來源 In／Out 列顯示範圍');
  await shot(page, `${tag}-6c-source-mode`);
  await page.click('#edAppend');
  await settle(page);
  cl = await clips(page);
  ok(cl.some(c => c.t === 'V1' && c.in === 1 && c.d === 31), '加到結尾：只放來源 In～Out 這一段（31 格，srcIn 1 秒）');
  await page.click('#edModeTimeline');
  await settle(page);
  eq(await state(page, 'mode'), 'timeline', '按「時間軸」切回時間軸模式');

  // ---------------------------------------------------------------- 標記、旗標
  console.log('標記與旗標');
  await page.keyboard.press('Escape');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(45));
  await page.keyboard.press('m');
  await settle(page);
  eq(await proj(page, p => p.markers.map(m => m.frame)), [45], 'M：在播放頭加時間軸標記');
  await page.fill('.ed-pop input[aria-label="標記名稱"]', '重點');
  await page.press('.ed-pop input[aria-label="標記名稱"]', 'Enter');
  await settle(page);
  eq(await proj(page, p => p.markers[0].name), '重點', '標記視窗：改名稱');
  await page.click('.ed-mk');
  await settle(page);
  await page.click('.ed-pop .ed-swatch[data-color="red"]');
  await settle(page);
  eq(await proj(page, p => p.markers[0].color), 'red', '點標記開啟視窗，改顏色（紅）');
  await page.click('.ed-mk');
  await page.fill('.ed-pop textarea', '這裡要補畫面');
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 700);
  await settle(page);
  eq(await proj(page, p => p.markers[0].note), '這裡要補畫面', '標記備註（關閉視窗時存檔）');
  const mk0 = await page.evaluate(() => { const r = document.querySelector('.ed-mk').getBoundingClientRect(); return { x: r.left + 4, y: r.top + 6 }; });
  await drag(page, mk0, { x: mk0.x + 40, y: mk0.y });
  eq(await proj(page, p => p.markers[0].frame), 65, '拖曳標記：移到 65 格');
  // 旗標
  cl = await clips(page);
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await page.click('#edFlag');
  await page.click('.ed-pop .ed-swatch[data-color="green"]');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].flags, on(cl, 'V1')[0].id), ['green'], '旗標：加綠色');
  ok((await page.locator(`.ed-clip[data-clip="${on(cl, 'V1')[0].id}"] .ed-cflags i`).count()) === 1, '片段上顯示旗標色條');
  await page.keyboard.press('Escape');
  // 片段標記：選取的片段在播放頭下時 M 加片段標記
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await page.keyboard.press('m');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].markers.map(m => m.offset), on(cl, 'V1')[0].id), [10], '選取片段後按 M：加片段標記');
  ok(await page.isVisible('[data-cmarker]'), '片段上畫出標記');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- In／Out、三點剪輯、替換
  console.log('In／Out、三點剪輯、替換');
  await page.keyboard.press('Escape');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(30));
  await page.keyboard.press('i');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(59));
  await page.keyboard.press('o');
  await settle(page);
  eq(await proj(page, p => [p.inPoint, p.outPoint]), [30, 60], 'I／O：時間軸 In＝30、Out＝60（Out 是最後一格＋1）');
  ok(await page.isVisible('.ed-io-tint') && await page.isVisible('.ed-io-band'), 'In／Out 範圍有底色（時間尺色帶＋軌道底色）');
  await pickMedia('mute');
  await page.keyboard.press('F10');
  await settle(page);
  cl = await clips(page);
  ok(cl.some(c => c.t === 'V1' && c.s === 30 && c.d === 30 && c.name === FILES.mute), '三點剪輯：F10 依時間軸 In～Out 放 30 格（30～60）');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Alt+x');
  await settle(page);
  eq(await proj(page, p => [p.inPoint, p.outPoint]), [null, null], 'Alt+X：清除 In／Out');
  // 替換：用另一個素材取代播放頭下的片段（長度不變）
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await pickMedia('port');
  const vAt = p => Object.values(p.clips).filter(c => c.start <= 10 && c.start + c.duration > 10 && p.tracks.find(t => t.id === c.trackId).kind === 'video').map(c => [c.mediaId, c.duration]);
  const mbefore = await page.evaluate(`(${vAt.toString()})(QPTEdit.ui.state.project)`);
  await page.keyboard.press('F11');
  await settle(page);
  const mafter = await page.evaluate(`(${vAt.toString()})(QPTEdit.ui.state.project)`);
  eq(mafter.map(x => x[0]), [M('port')], 'F11 替換：播放頭下的影片片段換成另一個素材');
  eq(mafter.map(x => x[1]), mbefore.map(x => x[1]), '替換：片段長度不變');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z');
  await settle(page);

  // ---------------------------------------------------------------- 右鍵選單、吸附、空白鍵不會重按按鈕
  console.log('右鍵選單、吸附');
  cl = await clips(page);
  const rc = on(cl, 'V1')[0];
  cb = await clipBox(page, rc.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8, { button: 'right' });
  await page.waitForSelector('.ed-menu');
  ok((await page.textContent('.ed-menu')).includes('波紋刪除') && (await page.textContent('.ed-menu')).includes('取消連結'), '片段右鍵選單：切開／刪除／波紋刪除／連結／變速／定格…');
  await page.click('.ed-menu-item:has-text("取消連結")');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].linkId, rc.id), null, '右鍵「取消連結」：片段不再連結');
  await page.keyboard.press('Control+z');
  await settle(page);
  ok(!!(await proj(page, (p, Q, id) => p.clips[id].linkId, rc.id)), '復原後恢復連結');
  // 連結選取關閉：單獨移動影像會不同步，片段上出現紅字偏移
  await page.keyboard.press('Control+Shift+l');
  eq(await state(page, 'linkedSelection'), false, 'Ctrl+Shift+L：連結選取關閉');
  cl = await clips(page);
  const vv = on(cl, 'V1').find(c => c.link);
  const aaB = cl.find(c => c.link === vv.link && c.t.startsWith('A'));
  cb = await clipBox(page, vv.id);
  await drag(page, { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 }, { x: cb.x + cb.w / 2 + 20, y: cb.y + cb.h / 2 });
  cl = await clips(page);
  const vv2 = cl.find(c => c.id === vv.id), aa = cl.find(c => c.link === vv.link && c.t.startsWith('A'));
  eq([vv2.s - vv.s, aa.s - aaB.s], [10, 0], '連結選取關閉：只有影像往右 10 格，聲音沒動');
  ok((await page.locator('.ed-clip .ed-badge.bad').count()) >= 1, '不同步的片段顯示紅色偏移數字');
  eq(await invariants(page), [], '不變式 OK（連結選取關閉時允許不同步）');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+l');
  eq(await state(page, 'linkedSelection'), true, '再按一次：連結選取開啟');
  // 吸附：把片段拖到離播放頭 1 格的位置，吸附開著會貼齊；關掉就停在拖到的位置
  await page.keyboard.press('Escape');
  cl = await clips(page);
  const mv = on(cl, 'V1').filter(c => c.type === 'media').pop();
  const ph = mv.s - 50, wantStart = ph + 1;
  await page.evaluate(f => QPTEdit.ui.seekTimeline(f), ph);
  await settle(page);
  eq(await state(page, 'playhead'), ph, `播放頭放在 ${ph}`);
  cb = await clipBox(page, mv.id);
  await drag(page, { x: cb.x + 20, y: cb.y + cb.h / 2 }, { x: cb.x + 20 + (wantStart - mv.s) * 2, y: cb.y + cb.h / 2 }, { hold: 40 });
  eq(on(await clips(page), 'V1').find(c => c.id === mv.id).s, ph, `吸附開啟：靠近播放頭（相差 1 格）時貼齊到 ${ph}`);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('n');
  await settle(page);
  eq(await state(page, 'snapping'), false, 'N：關閉吸附');
  cb = await clipBox(page, mv.id);
  await drag(page, { x: cb.x + 20, y: cb.y + cb.h / 2 }, { x: cb.x + 20 + (wantStart - mv.s) * 2, y: cb.y + cb.h / 2 });
  eq(on(await clips(page), 'V1').find(c => c.id === mv.id).s, wantStart, `吸附關閉：停在拖到的位置（${wantStart}）`);
  await page.keyboard.press('Control+z');
  await settle(page);
  // 點了工具列按鈕之後按空白鍵：播放／暫停，不會再「點」一次那顆按鈕
  await page.click('#edToggleSnap');
  eq(await state(page, 'snapping'), true, '工具列「吸附」鈕：開啟');
  await page.keyboard.press('Space');
  await sleep(200);
  eq([await state(page, 'snapping'), await page.evaluate(() => QPTEdit.ui.player.playing)], [true, true], '點過按鈕後按空白鍵：播放，而且不會再切換吸附');
  await page.keyboard.press('Space');
  await settle(page);

  // ---------------------------------------------------------------- 縮放
  console.log('時間軸縮放');
  const z0 = await state(page, 'zoom');
  await page.evaluate(() => { const r = document.getElementById('edZoom'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page);
  const z1 = await state(page, 'zoom');
  ok(z1 > z0, `縮放滑桿：放大（${Math.round(z0)} → ${Math.round(z1)} px/秒）`);
  cl = await clips(page);
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  ok(Math.abs(cb.w - on(cl, 'V1')[0].d * z1 / 30) < 1.5, `片段寬度跟著縮放（${Math.round(cb.w)}px）`);
  await page.keyboard.press('-');
  ok((await state(page, 'zoom')) < z1, '「-」縮小');
  await page.keyboard.press('=');
  const sbx = await page.evaluate(() => { const r = document.querySelector('.ed-tl-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height - 12 }; });
  await page.mouse.move(sbx.x, sbx.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await settle(page);
  ok((await state(page, 'zoom')) > z1 * 1.2, 'Ctrl＋滾輪：放大');
  await page.keyboard.press('Shift+z');
  await settle(page);
  const fit = await page.evaluate(() => { const Q = QPTEdit, p = Q.ui.state.project, sc = document.querySelector('.ed-tl-scroll'); return Q.core.projectDuration(p) * Q.ui.ppf <= sc.clientWidth - 150; });
  ok(fit, 'Shift+Z：全部顯示（整個時間軸剛好放進視窗）');

  // ---------------------------------------------------------------- 點軌道標頭：選取整條軌
  console.log('點軌道標頭：選取整條軌');
  {
    const ids = (page, name) => proj(page, (p, Q, n) => { const t = p.tracks.find(x => x.name === n); return Q.core.clipsOnTrack(p, t.id).map(c => c.id); }, name);
    const sel = page => page.evaluate(() => [...QPTEdit.ui.state.selection].sort());
    const a1Ids = await ids(page, 'A1'), v1Ids = await ids(page, 'V1');
    ok(a1Ids.length >= 2 && v1Ids.length >= 2, `A1、V1 各有好幾個片段（${a1Ids.length}、${v1Ids.length}）`);
    await page.keyboard.press('Escape'); await settle(page);
    // 點標頭的空白處（不是名稱）
    const thBox = await page.locator('.ed-th[data-track] >> text=A1').locator('xpath=ancestor::div[contains(@class,"ed-th")][1]').boundingBox();
    await page.mouse.click(thBox.x + thBox.width - 6, thBox.y + 4);
    await settle(page);
    eq(await sel(page), [...a1Ids].sort(), '點 A1 標頭：選取 A1 上所有片段（不展開連結的影像）');
    eq(await page.evaluate(() => QPTEdit.ui.state.primary), a1Ids[0], '詳細內容顯示這條軌最前面的片段');
    ok(await page.evaluate(() => document.querySelector('.ed-th.audio.sel .ed-th-name').textContent === 'A1'), 'A1 標頭標示為「整條選取」');
    ok(await page.evaluate(() => document.querySelector('.ed-th.audio.target .ed-th-name').textContent === 'A1'), 'A1 也設為目的軌道');
    ok((await page.textContent('#edStatus')).includes(`已選取「A1」軌的 ${a1Ids.length} 個片段`), '狀態列說明選了幾個');
    if (!(await page.isVisible('.ed-sec[data-sec="audio"]'))) await page.click('.ed-itab[data-itab="audio"]');
    ok(await page.isVisible('.ed-sec[data-sec="audio"]'), '詳細內容出現音訊的調整項目');
    ok((await page.textContent('#edInspHead')).includes(`已選取 ${a1Ids.length} 個片段`), `詳細內容標題寫出選了幾個（${await page.textContent('#edInspHead')}）`);
    // 改一個數值：整條軌的片段一起改，而且只記一筆復原
    const g = page.locator('.ed-sec[data-sec="audio"] input[aria-label="增益"]');
    const before = await proj(page, (p, Q, xs) => xs.map(id => p.clips[id].audio.gainDb), a1Ids);
    await g.fill('-3'); await g.press('Tab'); await settle(page);
    eq(await proj(page, (p, Q, xs) => xs.map(id => p.clips[id].audio.gainDb), a1Ids), a1Ids.map(() => -3), '詳細內容改增益 -3 dB：A1 每個片段都改了');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());   // 焦點還在輸入框時 Ctrl+Z 是給文字用的
    await page.keyboard.press('Control+z'); await settle(page);
    eq(await proj(page, (p, Q, xs) => xs.map(id => p.clips[id].audio.gainDb), a1Ids), before, 'Ctrl+Z 一次：整條軌一起還原');
    // Shift 加選、再按一次取消
    await page.click('.ed-th-name:text-is("V1")', { modifiers: ['Shift'] }); await settle(page);
    eq(await sel(page), [...a1Ids, ...v1Ids].sort(), 'Shift＋點 V1：加選 V1 的片段');
    eq(await page.evaluate(() => QPTEdit.ui.state.primary), v1Ids[0], '加選後詳細內容換成 V1 的第一個片段');
    await page.click('.ed-th-name:text-is("V1")', { modifiers: ['Shift'] }); await settle(page);
    eq(await sel(page), [...a1Ids].sort(), '再 Shift＋點 V1：取消 V1，A1 保留');
    ok(a1Ids.includes(await page.evaluate(() => QPTEdit.ui.state.primary)), '取消後詳細內容回到還被選取的片段');
    // 標頭上的按鈕不會觸發選取
    await page.keyboard.press('Escape'); await settle(page);
    await page.click('.ed-th.audio .ed-thb.mute >> nth=0'); await settle(page);
    eq((await sel(page)).length, 0, '按標頭的 M（靜音）：不會選取片段');
    await page.click('.ed-th.audio .ed-thb.mute >> nth=0'); await settle(page);
    // 右鍵選單也有
    await page.click('.ed-th-name:text-is("V1")', { button: 'right' });
    await page.click('.ed-menu-item:has-text("選取這條軌的所有片段")'); await settle(page);
    eq(await sel(page), [...v1Ids].sort(), '右鍵「選取這條軌的所有片段」');
    eq(await invariants(page), [], '不變式 OK');
    await page.keyboard.press('Escape'); await settle(page);
  }

  // ---------------------------------------------------------------- 軌道：鎖定、靜音、獨奏、新增、改名、刪除
  console.log('軌道控制');
  const v1id = await proj(page, p => p.tracks.find(t => t.name === 'V1').id);
  await page.click(`.ed-th[data-track="${v1id}"] .ed-thb.lock`);
  await settle(page);
  eq(await proj(page, p => p.tracks.find(t => t.name === 'V1').locked), true, '鎖定 V1');
  cl = await clips(page);
  const beforeLocked = JSON.stringify(await clips(page));
  cb = await clipBox(page, on(cl, 'V1')[1].id);
  await drag(page, { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 }, { x: cb.x + cb.w / 2 + 60, y: cb.y + cb.h / 2 });
  eq(JSON.stringify(await clips(page)), beforeLocked, '鎖定的軌道上拖曳移動：沒有任何改動');
  ok((await statusText(page)).includes('鎖定'), '狀態列說明原因：' + (await statusText(page)));
  await page.click(`.ed-th[data-track="${v1id}"] .ed-thb.lock`);
  await page.click('.ed-th.audio .ed-thb.mute >> nth=0');
  await page.click('.ed-th.audio .ed-thb.solo >> nth=1');
  await settle(page);
  eq(await proj(page, p => [p.tracks.find(t => t.name === 'A1').muted, p.tracks.find(t => t.name === 'A2').solo]), [true, true], '靜音 A1、獨奏 A2');
  await page.click('.ed-th.video .ed-thb.hide >> nth=0');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.hidden).length), 1, '隱藏一條影片軌');
  await page.click('.ed-th.video .ed-thb.hide >> nth=0');
  await page.click('.ed-th.audio .ed-thb.mute >> nth=0');
  await page.click('.ed-th.audio .ed-thb.solo >> nth=1');
  await page.click('#edAddV');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').map(t => t.name)), ['V1', 'V2', 'V3'], '＋影片軌：新增 V3');
  eq(await page.evaluate(() => document.querySelector('.ed-th .ed-th-name').textContent), 'V3', 'V3 顯示在最上面');
  await page.dblclick('.ed-th.video .ed-th-name >> nth=0');
  await page.fill('.ed-th-input', 'B-roll');
  await page.press('.ed-th-input', 'Enter');
  await settle(page);
  eq(await proj(page, p => p.tracks.find(t => t.id === p.tracks.filter(x => x.kind === 'video')[2].id).name), 'B-roll', '雙擊軌道名稱：改名');
  await page.click('.ed-th.video .ed-th-name >> nth=0', { button: 'right' });
  await page.click('.ed-menu-item:has-text("刪除這條軌道")');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 2, '右鍵刪除空軌道');
  await page.click('#edAddA');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'audio').length), 3, '＋音訊軌');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'audio').length), 2, '復原：音訊軌回到 2 條');

  // ---------------------------------------------------------------- 播放與鍵盤
  console.log('播放與鍵盤');
  await page.keyboard.press('Home');
  await settle(page);
  eq(await state(page, 'playhead'), 0, 'Home：回到開頭');
  await page.keyboard.press('ArrowRight');
  eq(await state(page, 'playhead'), 1, '→：往後一格');
  await page.keyboard.press('Shift+ArrowRight');
  eq(await state(page, 'playhead'), 31, 'Shift+→：往後一秒（30 格）');
  await page.keyboard.press('ArrowLeft');
  eq(await state(page, 'playhead'), 30, '←：往前一格');
  await page.keyboard.press('ArrowDown');
  ok((await state(page, 'playhead')) > 30, '↓：跳到下一個剪輯點（' + (await state(page, 'playhead')) + '）');
  const rb = await page.evaluate(() => { const r = document.querySelector('.ed-ruler').getBoundingClientRect(); return { y: r.top + 14 }; });
  await page.mouse.click(await frameX(page, 60), rb.y);
  eq(await state(page, 'playhead'), 60, '點時間尺：播放頭移到 60 格');
  await page.keyboard.press('Space');
  await sleep(900);
  const playing = await page.evaluate(() => [QPTEdit.ui.player.playing, QPTEdit.ui.state.playhead]);
  ok(playing[0] && playing[1] > 62, `空白鍵播放：播放頭前進（${playing[1]}）`);
  await page.keyboard.press('Space');
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.player.playing), false, '再按一次空白鍵：暫停');
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  eq(await page.evaluate(() => QPTEdit.ui.player.rate), 2, 'L 連按兩次：2 倍速');
  await page.keyboard.press('k');
  eq(await page.evaluate(() => QPTEdit.ui.player.playing), false, 'K：停止');
  await page.keyboard.press('Space');
  await sleep(150);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.player.playing), false, '瀏覽器分頁切到背景：暫停播放');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await settle(page);

  // ---------------------------------------------------------------- 匯出
  console.log('匯出');
  await page.evaluate(() => { const Q = QPTEdit; Q.ui.state.history.run('設 In／Out', p => Q.core.setInOut(p, 0, 30)); });
  await settle(page);
  ok(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), '有未匯出的改動：關閉頁面會提醒（beforeunload）');
  await page.click('#edExportBtn');
  await page.waitForSelector('#edExportDialog[open]');
  await settle(page);
  ok((await page.textContent('#edExportDialog')).includes('匯出影片'), '匯出對話框打開');
  await shot(page, `${tag}-7-export-dialog`);
  await page.click('#edExQuality button[data-v="small"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#edExGo')]);
  const outFile = path.join(os.tmpdir(), `qc-ui-${process.pid}-${tag}.mp4`);
  await dl.saveAs(outFile);
  await page.waitForFunction(() => /已匯出/.test(document.getElementById('edExMsg').textContent), null, { timeout: 60000 });
  ok(fs.statSync(outFile).size > 2000, `匯出成功：${dl.suggestedFilename()}（${fs.statSync(outFile).size} bytes）`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', outFile]).toString());
  const vs = probe.streams.find(x => x.codec_type === 'video'), as = probe.streams.find(x => x.codec_type === 'audio');
  eq([vs && vs.width, vs && vs.height], [1080, 1920], '輸出影片 1080×1920（9:16）');
  eq(vs && +vs.nb_frames, 30, '輸出剛好 30 格（In～Out 1 秒）');
  ok(!!as, '輸出有聲音軌');
  try { execFileSync('ffmpeg', ['-v', 'error', '-i', outFile, '-f', 'null', '-'], { stdio: 'pipe' }); ok(true, 'ffmpeg 解碼沒有錯誤'); } catch (e) { ok(false, 'ffmpeg 解碼失敗：' + e.stderr); }
  fs.rmSync(outFile, { force: true });
  ok(!(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })), '匯出完成後關閉頁面不再提醒');
  await shot(page, `${tag}-7b-export-done`);
  await page.click('#edExClose');
  await settle(page);

  // ---------------------------------------------------------------- 版面：滿版、沒有橫向捲動
  console.log('版面');
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('.wrap')).maxWidth), 'none', '.wrap 沒有寬度限制（滿版）');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '頁面沒有橫向捲動');
  ok((await clips(page)).length > 5, '時間軸內容還在');
  eq(await page.evaluate(() => window.__csp), [], '沒有 CSP 違規');


  // ---------------------------------------------------------------- 其他操作：拖放素材、框選、片尾淡出轉場、檢查器變速、刪除有片段的軌道
  console.log('其他操作');
  await page.evaluate(() => { const h = QPTEdit.ui.state.history; while (h.canUndo) h.undo(); });
  await settle(page);
  eq(Object.keys(await proj(page, p => p.clips)).length, 0, '全部復原：時間軸清空');
  eq(await proj(page, p => p.aspect), 'source', '復原也把輸出比例還原');
  await page.evaluate(() => { QPTEdit.ui.setZoom(60, false); document.querySelector('.ed-tl-scroll').scrollLeft = 0; });
  await settle(page);
  await page.click('.ed-tab[data-tab="media"]');
  ok((await page.textContent(`.ed-mitem[data-media="${M('land')}"]`)).includes('In／Out'), '媒體庫的素材上顯示它設定過的來源 In／Out 範圍');
  await page.dblclick(`.ed-mitem[data-media="${M('land')}"]`);
  await page.click('#edSrcIO >> text=清除');
  await page.click('#edModeTimeline');
  eq(await state(page, 'sourceInOut'), null, '清除來源 In／Out');
  await page.click('.ed-th-name:text-is("V1")');
  await page.click('.ed-th-name:text-is("A1")');
  await pickMedia('land');
  await page.click('#edAppend');
  await settle(page);
  const dragFromLib = async (key, toFrame, trackName) => {
    const sel = `.ed-mitem[data-media="${M(key)}"]`;
    await page.locator(sel).scrollIntoViewIfNeeded();
    const r = await page.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
    const lane = await laneBox(page, trackName);
    await drag(page, r, { x: await frameX(page, toFrame), y: lane.y + lane.h / 2 }, { steps: 16 });
  };
  await dragFromLib('still', 30, 'V2');
  await dragFromLib('music', 0, 'A2');
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d]), [[30, 150]], '把圖片拖到 V2 的 30 格：預設 5 秒（150 格）');
  eq(on(cl, 'A2').map(c => [c.s, c.d]), [[0, 240]], '把音樂拖到 A2：8 秒（240 格）');
  await dragFromLib('mute', 0, 'A1');
  ok(/沒有聲音/.test(await statusText(page)), '把沒有聲音的影片拖到音訊軌：狀態列說明原因（' + (await statusText(page)) + '）');
  eq(on(await clips(page), 'A1').length, 1, '沒有放進去');
  eq(await invariants(page), [], '不變式 OK');
  // 框選（選取工具，在空白處拖出矩形）與 Ctrl+A
  await page.keyboard.press('Escape');
  const lv2 = await laneBox(page, 'V2'), la2 = await laneBox(page, 'A2');
  await drag(page, { x: await frameX(page, 450), y: lv2.y + 4 }, { x: await frameX(page, 5), y: la2.y + la2.h - 4 }, { steps: 12 });
  eq(await proj(page, p => Q.ui.state.selection.size), 4, '框選：拖出矩形選到 4 個片段');
  await page.keyboard.press('Escape');
  eq(await proj(page, p => Q.ui.state.selection.size), 0, 'Esc：取消選取');
  await page.keyboard.press('Control+a');
  eq(await proj(page, p => Q.ui.state.selection.size), 4, 'Ctrl+A：全選');
  await page.keyboard.press('Escape');
  // 框選拖到邊緣自動捲動：框的起點跟著內容走，捲進來的片段也選得到
  const zoom0 = await state(page, 'zoom');
  await page.evaluate(() => { QPTEdit.ui.setZoom(QPTEdit.ui.state.zoom * 4, false); const sc = document.querySelector('.ed-tl-scroll'); sc.scrollLeft = sc.scrollWidth; });
  await settle(page);
  const scr = await page.evaluate(() => { const r = document.querySelector('.ed-tl-scroll').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  const lv2b = await laneBox(page, 'V2'), la2b = await laneBox(page, 'A2');
  ok(await page.evaluate(() => document.querySelector('.ed-tl-scroll').scrollLeft > 0), '放大後時間軸捲到右邊（前段片段在畫面外）');
  await drag(page, { x: scr.r - 60, y: lv2b.y + 4 }, { x: scr.l + 30, y: la2b.y + la2b.h - 4 }, { steps: 12, hold: 2500 });
  eq(await page.evaluate(() => document.querySelector('.ed-tl-scroll').scrollLeft), 0, '框選拖到左邊：自動捲到最前面');
  eq(await proj(page, p => Q.ui.state.selection.size), 4, '框選＋自動捲動：捲進來的片段也選到（4 個）');
  await page.keyboard.press('Escape');
  await page.evaluate(z => { QPTEdit.ui.setZoom(z, false); document.querySelector('.ed-tl-scroll').scrollLeft = 0; }, zoom0);
  await settle(page);
  // 從軌道下方的空白開始框選
  const under = await page.evaluate(() => {
    const sc = document.querySelector('.ed-tl-scroll'), r = sc.getBoundingClientRect(), lanes = [...document.querySelectorAll('.ed-lane')];
    const lb = Math.max(...lanes.map(l => l.getBoundingClientRect().bottom));
    return { y: lb + 8, room: r.top + sc.clientHeight - lb };
  });
  if (under.room > 16) {   // 視窗矮的時候軌道會填滿，下方沒有空白
    const lv2c = await laneBox(page, 'V2');
    await drag(page, { x: await frameX(page, 450), y: under.y }, { x: await frameX(page, 5), y: lv2c.y + 4 }, { steps: 12 });
    eq(await proj(page, p => Q.ui.state.selection.size), 4, '從軌道下方的空白拖出框：一樣選得到片段');
    ok(await page.isHidden('.ed-marquee'), '放開後框消失');
    await page.mouse.click(await frameX(page, 450), under.y);
    await settle(page);
    eq(await proj(page, p => Q.ui.state.selection.size), 0, '軌道下方點一下：取消選取');
  }
  // 片尾淡出轉場（最後一個片段後面沒有片段）
  cl = await clips(page);
  const lastV = on(cl, 'V1')[0];
  cb = await clipBox(page, lastV.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await page.click('.ed-tab[data-tab="trans"]');
  await page.click('#edTransList .ed-gitem[data-trans="fadeToBlack"]');
  await page.click('#edTransAdd');
  await settle(page);
  trs = await proj(page, p => Object.values(p.transitions));
  eq([trs.length, trs[0].type, trs[0].rightClipId, trs[0].align], [1, 'fadeToBlack', null, 'end'], '片段結尾加「淡出到黑」：沒有右片段，對齊在結尾');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 1, '沒選到轉場時，Delete 不會誤刪別的東西（沒有選取：只提示）');
  // 檢查器：倒播、速度標籤拖曳
  cb = await clipBox(page, lastV.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await settle(page);
  await page.click('.ed-itab[data-itab="speed"]');
  ok(await page.isVisible('.ed-sec[data-sec="speed"]'), '選取影片片段：檢查器有「速度」分頁');
  await page.locator('.ed-sec[data-sec="speed"]').getByLabel('倒播').check();
  await settle(page);
  cl = await clips(page);
  eq([on(cl, 'V1')[0].rv, on(cl, 'A1')[0].rv], [true, true], '檢查器勾選倒播：影像與連結的聲音都倒播');
  ok((await page.locator('.ed-clip .ed-badge:text-is("倒播")').count()) >= 1, '片段上顯示「倒播」標籤');
  await page.keyboard.press('Control+z');
  await settle(page);
  const spLab = page.locator('.ed-sec[data-sec="speed"] .ed-fx-lab:text-is("速度")');
  await spLab.scrollIntoViewIfNeeded();
  const sb = await spLab.boundingBox();
  await drag(page, { x: sb.x + 5, y: sb.y + sb.height / 2 }, { x: sb.x + 55, y: sb.y + sb.height / 2 });
  cl = await clips(page);
  ok(Math.abs(on(cl, 'V1')[0].sp - 1.5) < 0.011, `拖曳「速度」標籤：+50px → 150%（${on(cl, 'V1')[0].sp}）`);
  eq(on(cl, 'V1')[0].d, 120, '波紋變速：長度 180 → 120 格');
  if (on(cl, 'V1')[0].d !== 120) console.log('       DEBUG', JSON.stringify(cl));
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(on(await clips(page), 'V1')[0].sp, 1, '速度拖曳也只記一筆復原');
  eq(await invariants(page), [], '不變式 OK');
  // 刪除有片段的軌道：要先確認，可以復原
  for (const [how, act] of [['取消', () => page.click('#confirmCancelBtn')], ['Esc', () => page.keyboard.press('Escape')]]) {
    await page.click('.ed-th.video .ed-th-name >> nth=0', { button: 'right' });
    await page.click('.ed-menu-item:has-text("刪除這條軌道")');
    await page.waitForSelector('#confirmOverlay.open');
    ok((await page.textContent('#confirmTitle')).includes('軌'), `確認對話框標題：${await page.textContent('#confirmTitle')}`);
    await act();
    await settle(page);
    ok(!(await page.isVisible('#confirmOverlay')), `按${how}：對話框關閉`);
    eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 2, `按${how}：軌道沒被刪掉`);
  }
  await page.click('.ed-th.video .ed-th-name >> nth=0', { button: 'right' });
  await page.click('.ed-menu-item:has-text("刪除這條軌道")');
  await page.waitForSelector('#confirmOverlay.open');
  await page.click('#confirmOkBtn');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 1, '右鍵刪除有片段的軌道（確認後）：V2 不見了');
  eq(await proj(page, p => Object.values(p.clips).filter(c => c.type === 'media' && p.mediaInfo[c.mediaId].kind === 'image').length), 0, '軌道上的圖片片段一起被刪掉');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 2, 'Ctrl+Z：軌道與片段都回來');
  eq(await invariants(page), [], '不變式 OK');
  eq(await page.evaluate(() => window.__csp), [], '沒有 CSP 違規（最終）');

  console.log('問題清單：', problems.length ? problems : '無');
  await ctx.close();
  return problems;
}


// =====================================================================================
// 外觀與版面（不需要素材，每個測試開新的 context，所以 localStorage 互不影響）：
//   工具列單排可捲動、其他工具按鈕、深色／淺色、直式版面
// =====================================================================================
// 預覽框：拖曳字幕、安全框、「詳細內容」名稱（不需要素材，只放字幕）
async function runStageTests(browser, base, [W, H]) {
  const tag = `${W}x${H}`;
  console.log(`\n==== 預覽框：字幕拖曳與安全框 ${tag} ====`);
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.goto(base);
  await settle(page);
  ok((await page.textContent('#edInspHead')).startsWith('詳細內容'), '右側面板標題改為「詳細內容」');
  eq(await page.getAttribute('#edInspector', 'aria-label'), '詳細內容', '右側面板的 aria-label 也改名');
  await page.selectOption('#edAspect', '9:16');
  await page.click('.ed-tab[data-tab="title"]');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await page.click('#edTitleAdd');
  await settle(page);
  const tpos = () => proj(page, p => { const c = Object.values(p.clips).find(x => x.type === 'title'); return [Math.round(c.title.x * 1000) / 1000, Math.round(c.title.y * 1000) / 1000]; });
  eq(await tpos(), [0.5, 0.5], '新增的靜態字幕在畫面正中央');
  ok(await page.isVisible('#edGizmo'), '選取的字幕在預覽上有控制框');
  ok(await page.evaluate(() => document.getElementById('edGizmo').classList.contains('title')), '字幕的控制框是黃色（.title）');
  const ov = await page.evaluate(() => { const r = document.getElementById('edOverlay').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  ok(Math.abs(ov.w / ov.h - 1080 / 1920) < 0.01, `疊圖對齊 9:16 的畫面（${Math.round(ov.w)}×${Math.round(ov.h)}）`);
  const tb = await page.evaluate(() => { const r = document.querySelector('#edGizmo .ed-gz-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  ok(Math.abs(tb.x - (ov.x + ov.w / 2)) < 2 && Math.abs(tb.y - (ov.y + ov.h / 2)) < 2, '控制框在畫面中央');
  await page.mouse.move(tb.x, tb.y);
  eq(await page.evaluate(() => document.getElementById('edCanvas').style.cursor), 'move', '游標移到字幕上變成移動');
  await drag(page, tb, { x: tb.x + ov.w * 0.2, y: tb.y - ov.h * 0.25 }, { steps: 10 });
  let pos = await tpos();
  ok(Math.abs(pos[0] - 0.7) < 0.01 && Math.abs(pos[1] - 0.25) < 0.01, `在預覽上拖曳字幕：x／y 改成約 0.7／0.25（${pos}）`);
  ok((await page.textContent('#edUndoLab')).includes('移動字幕'), '復原標籤是「移動字幕」（整次拖曳一筆）');
  const tb2 = await page.evaluate(() => { const r = document.querySelector('#edGizmo .ed-gz-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  ok(Math.abs(tb2.x - (ov.x + ov.w * 0.7)) < 3 && Math.abs(tb2.y - (ov.y + ov.h * 0.25)) < 3, '控制框跟著移動');
  await drag(page, tb2, { x: ov.x + ov.w * 0.5 + 4, y: tb2.y }, { steps: 6 });
  pos = await tpos();
  eq(pos[0], 0.5, '拖到中線附近會吸附到正中');
  const tb3 = await page.evaluate(() => { const r = document.querySelector('#edGizmo .ed-gz-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await drag(page, tb3, { x: tb3.x + 4, y: tb3.y }, { steps: 6, mods: ['Alt'] });
  pos = await tpos();
  ok(pos[0] !== 0.5, `按住 Alt 不吸附（${pos[0]}）`);
  await page.keyboard.press('Control+z'); await settle(page);
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await tpos(), [0.7, 0.25], '復原兩次：回到第一次拖曳後的位置');
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await tpos(), [0.5, 0.5], '再復原：回到中央');
  // 字型：仙人掌明體（用到才下載）
  const fontSel = page.locator('.ed-sec[data-sec="fx-title"] select:has(option[value="cactus"])');
  ok(await fontSel.count() === 1, '字型選單有「仙人掌明體」');
  ok(!(await page.evaluate(() => QPTEdit.fx.fontIsLoaded('cactus'))), '還沒選之前不下載仙人掌明體');
  await fontSel.selectOption('cactus');
  await page.waitForFunction(() => QPTEdit.fx.fontIsLoaded('cactus'), null, { timeout: 30000 });
  await settle(page);
  eq(await proj(page, p => Object.values(p.clips).find(c => c.type === 'title').title.font), 'cactus', '字幕字型改成 cactus');
  ok(await page.evaluate(() => document.fonts.check('40px "Cactus Classical Serif"', '字幕')), '仙人掌明體已載入到 document.fonts');
  ok((await statusText(page)).includes('仙人掌明體」已載入'), '狀態列提示字型已載入');
  const diff = await page.evaluate(() => {
    const Q = QPTEdit, draw = font => {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 320, 180);
      Q.fx.drawTitle(g, { id: 't', type: 'title', duration: 90, title: { ...Q.fx.makeTitle('static', '仙人掌明體'), font }, video: Q.fx.defaultVideo() }, 320, 180, 0, 30);
      return g.getImageData(0, 0, 320, 180).data;
    };
    const a = draw('WHZ-Heavy'), b = draw('cactus');
    let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 60) n++;
    return n;
  });
  ok(diff > 300, `換字型後畫出來的字不一樣（${diff} 個像素不同）`);
  await page.evaluate(() => QPTEdit.ui.seekTimeline(20)); await settle(page);
  await shot(page, `${tag}-S0-cactus-font`);
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await proj(page, p => Object.values(p.clips).find(c => c.type === 'title').title.font), 'WHZ-Heavy', '復原：字型回到預設');
  // 不在字幕上按：不會動到字幕
  await drag(page, { x: ov.x + 20, y: ov.y + ov.h - 30 }, { x: ov.x + 60, y: ov.y + ov.h - 80 });
  eq(await tpos(), [0.5, 0.5], '在字幕以外的地方拖：字幕不動');
  // 安全框
  ok(await page.isVisible('#edSafe'), '9:16：檢視器上方有「安全框」按鈕');
  ok(!(await page.isVisible('.ed-safe')), '預設不顯示安全框');
  await page.click('#edSafe'); await settle(page);
  ok(await page.isVisible('.ed-safe'), '按下後顯示安全框');
  eq(await page.getAttribute('#edSafe', 'aria-pressed'), 'true', '按鈕顯示為開啟');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await settle(page);
  await shot(page, `${tag}-S1-safe-zone`);
  await page.keyboard.press('Control+z'); await settle(page);   // 新增字幕也復原掉，截一張只有安全框的
  await page.selectOption('#edAspect', '16:9'); await settle(page);
  ok(!(await page.isVisible('#edSafe')) && !(await page.isVisible('.ed-safe')), '16:9：安全框按鈕與疊圖都隱藏');
  await page.selectOption('#edAspect', '9:16'); await settle(page);
  ok(await page.isVisible('.ed-safe'), '切回 9:16：記得安全框是開的');
  await page.reload(); await settle(page);
  await page.selectOption('#edAspect', '9:16'); await settle(page);
  ok(await page.isVisible('.ed-safe'), '重新載入後仍記得安全框開關');

  // 預覽控制框：色塊（一般素材）在預覽上點選、移動、縮放、旋轉
  console.log('預覽控制框：點選、移動、縮放、旋轉、拉桿');
  await page.click('#edSafe'); await settle(page);
  const sid = await page.evaluate(() => {
    const Q = QPTEdit, h = Q.ui.state.history, t = Q.ui.state.project.tracks.find(x => x.kind === 'video');
    h.run('加色塊', q => Q.core.addClip(q, { type: 'solid', trackId: t.id, start: 0, duration: 90, solidColor: '#e0457b' }));
    const c = Object.values(Q.ui.state.project.clips).find(x => x.type === 'solid');
    h.run('縮小', q => Q.core.setClipProps(q, c.id, { video: { transform: { zoomX: 0.5, zoomY: 0.5 } } }));
    Q.ui.selectClips([]); Q.ui.seekTimeline(10);
    return c.id;
  });
  await settle(page);
  const stf = () => page.evaluate(id => { const t = QPTEdit.ui.state.project.clips[id].video.transform; return { x: t.posX, y: t.posY, zx: t.zoomX, zy: t.zoomY, r: t.rotation }; }, sid);
  const gbox = () => page.evaluate(() => { const r = document.querySelector('#edGizmo .ed-gz-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
  const ctr = sel => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  ok(!(await page.isVisible('#edGizmo')), '沒有選取：預覽上沒有控制框');
  const ov2 = await page.evaluate(() => { const r = document.getElementById('edOverlay').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.move(ov2.x + ov2.w / 2, ov2.y + ov2.h / 2);
  eq(await page.evaluate(() => document.getElementById('edCanvas').style.cursor), 'move', '游標移到素材上變成移動');
  await page.mouse.click(ov2.x + ov2.w / 2, ov2.y + ov2.h / 2); await settle(page);
  eq(await page.evaluate(() => [...QPTEdit.ui.state.selection]), [sid], '在預覽上點素材：時間軸選取該片段');
  ok(await page.isVisible('#edGizmo'), '選取後出現控制框');
  let gb = await gbox();
  ok(Math.abs(gb.w - ov2.w * 0.5) < 3 && Math.abs(gb.h - ov2.h * 0.5) < 3, `控制框大小對應縮放 50%（${Math.round(gb.w)}×${Math.round(gb.h)}）`);
  await drag(page, gb, { x: gb.x + ov2.w * 0.1, y: gb.y + ov2.h * 0.1 }, { steps: 10 });
  let t = await stf();
  ok(Math.abs(t.x - 108) < 3 && Math.abs(t.y - 192) < 3, `拖曳素材：位置改成約 108, 192 px（${t.x}, ${t.y}）`);
  ok((await page.textContent('#edUndoLab')).includes('移動素材'), '復原標籤是「移動素材」（整次拖曳一筆）');
  gb = await gbox();
  ok(Math.abs(gb.x - (ov2.x + ov2.w * 0.6)) < 3, '控制框跟著移動');
  await drag(page, gb, { x: ov2.x + ov2.w / 2 + 4, y: ov2.y + ov2.h / 2 - 3 }, { steps: 8 });
  t = await stf();
  eq([t.x, t.y], [0, 0], '拖到畫面中心附近會吸附到正中');
  gb = await gbox();
  await drag(page, gb, { x: gb.x + 40, y: gb.y }, { steps: 6, cancel: true });
  t = await stf();
  eq([t.x, t.y], [0, 0], '拖曳中按 Esc：取消，位置不變');
  // 縮放：拖右下角到離中心兩倍遠
  const br = await page.evaluate(() => { const r = document.querySelectorAll('#edGizmo .ed-gz-corner')[2].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  gb = await gbox();
  await page.mouse.move(br.x, br.y);
  eq(await page.evaluate(() => document.getElementById('edCanvas').style.cursor), 'nwse-resize', '游標移到角點變成縮放');
  await drag(page, br, { x: gb.x + (br.x - gb.x) * 1.6, y: gb.y + (br.y - gb.y) * 1.6 }, { steps: 10 });
  t = await stf();
  ok(Math.abs(t.zx - 0.8) < 0.02 && t.zx === t.zy, `拖角點等比縮放：50% → 約 80%（${t.zx} / ${t.zy}）`);
  ok((await page.textContent('#edUndoLab')).includes('縮放素材'), '復原標籤是「縮放素材」');
  // 旋轉：上方圓點繞中心拖 90°，按 Shift 每 15° 一格
  const rp = await ctr('#edGizmo .ed-gz-rot');
  gb = await gbox();
  ok(rp.y < gb.y - gb.h / 2, '旋轉點在控制框上緣外側');
  const d = gb.y - rp.y;
  await drag(page, rp, { x: gb.x + d, y: gb.y + 3 }, { steps: 12, mods: ['Shift'] });
  t = await stf();
  eq(t.r, 90, '拖旋轉點（Shift）：旋轉 90°');
  ok((await page.textContent('#edUndoLab')).includes('旋轉素材'), '復原標籤是「旋轉素材」');
  await shot(page, `${tag}-S2-gizmo`);
  // 詳細內容的拉桿：縮放、位置
  const rng = page.locator('.ed-sec[data-sec="fx-transform"] .ed-fx-range');
  ok(await rng.count() >= 4, `變形區有拉桿（縮放 X／Y、位置 X／Y，共 ${await rng.count()} 個）`);
  ok(await page.locator('.ed-sec[data-sec="fx-transform"] .ed-fx-numbox').count() >= 4, '拉桿後面保留可輸入數值的框');
  await page.evaluate(() => { const r = document.querySelector('.ed-sec[data-sec="fx-transform"] .ed-fx-range'); r.value = '1.5'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(page);
  t = await stf();
  eq([t.zx, t.zy], [1.5, 1.5], '拉縮放拉桿：縮放 X／Y 一起改成 1.5');
  gb = await gbox();
  ok(Math.abs(gb.w - ov2.h * 1.5) < 4 && Math.abs(gb.h - ov2.w * 1.5) < 4, `預覽控制框跟著拉桿更新（轉 90° 後 ${Math.round(gb.w)}×${Math.round(gb.h)}）`);
  const rp2 = await ctr('#edGizmo .ed-gz-rot'), st2 = await page.evaluate(() => { const r = document.getElementById('edStage').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; });
  ok(rp2.x > st2.x && rp2.x < st2.r && rp2.y > st2.y && rp2.y < st2.b, `素材超出畫面時，旋轉點仍放在預覽區看得到的位置（${Math.round(rp2.x)}, ${Math.round(rp2.y)}）`);
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Control+z'); await settle(page); }
  t = await stf();
  eq([t.x, t.y, t.zx, t.r], [0, 0, 0.5, 0], '復原五次：回到原本的位置／縮放／旋轉');
  // 疊在上面的字幕優先被點到
  await page.click('.ed-tab[data-tab="title"]');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await page.click('#edTitleAdd'); await settle(page);
  await page.evaluate(() => QPTEdit.ui.selectClips([])); await settle(page);
  await page.mouse.click(ov2.x + ov2.w / 2, ov2.y + ov2.h / 2); await settle(page);
  const selType = await page.evaluate(() => [...QPTEdit.ui.state.selection].map(id => QPTEdit.ui.state.project.clips[id].type));
  ok(selType.length === 1 && selType[0] === 'title', `素材和字幕重疊時，點到的是上層的字幕（${selType}）`);
  await page.mouse.click(ov2.x + ov2.w / 2, ov2.y + ov2.h * 0.25 + 12); await settle(page);
  eq(await page.evaluate(() => [...QPTEdit.ui.state.selection]), [sid], '點字幕以外、色塊範圍內：改選色塊');
  await ctx.close();
  return problems;
}

async function runLayoutTests(browser, base, [W, H]) {
  const tag = `${W}x${H}`;
  console.log(`\n==== 外觀與版面 ${tag} ====`);
  const problems = [];
  const open = async (init) => {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
    if (init) await page.addInitScript(init);
    await page.goto(base);
    return { ctx, page };
  };
  const goEdit = async page => { await page.waitForSelector('#editApp'); await settle(page); };
  const attr = page => page.evaluate(() => document.documentElement.getAttribute('data-ed-theme'));
  const lum = (page, sel) => page.evaluate(sel => {
    const c = getComputedStyle(document.querySelector(sel)).backgroundColor.match(/[\d.]+/g).map(Number);
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  }, sel);
  const rect = (page, sel) => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
  const isVert = page => page.evaluate(() => document.getElementById('editApp').classList.contains('ed-vert'));
  // 畫面實際顯示的區域（canvas 是 object-fit: contain）：依專案比例在 #edStage 裡置中縮放
  const shown = page => page.evaluate(() => {
    const st = document.getElementById('edStage').getBoundingClientRect(), p = QPTEdit.ui.state.project, a = p.width / p.height;
    const w = Math.min(st.width, st.height * a);
    return { w, h: w / a };
  });

  // ---------------------------------------------------------------- 工具列：單排、可捲動
  console.log('工具列：單排、左右捲動、復原／重做在最右');
  {
    const { ctx, page } = await open();
    await goEdit(page);
    const tops = await page.evaluate(() => [...document.querySelectorAll('#edToolbar button')].map(b => Math.round(b.getBoundingClientRect().top)));
    ok(tops.length >= 15 && new Set(tops).size === 1, `工具列所有按鈕（${tops.length} 個）在同一排（top 都是 ${tops[0]}）`);
    const sc = await page.evaluate(() => { const t = document.getElementById('edToolbar'); return { sw: t.scrollWidth, cw: t.clientWidth, ov: getComputedStyle(t).overflowX, wrap: getComputedStyle(t).flexWrap, h: t.getBoundingClientRect().height }; });
    ok(sc.sw > sc.cw, `工具列內容比寬度寬，可以捲動（scrollWidth ${sc.sw} > clientWidth ${sc.cw}）`);
    ok(sc.ov === 'auto' && sc.wrap === 'nowrap' && sc.h < 70, `工具列 overflow-x:auto、不換行，高度只有一排（${Math.round(sc.h)}px）`);
    const act = await rect(page, '#edAction');
    ok(act.w >= 150, `狀態標籤不會被壓窄（${Math.round(act.w)}px）`);
    // 捲到最左：左邊沒遮罩、右邊有遮罩；滑鼠滾輪在工具列上轉成橫向捲動
    await page.evaluate(() => { document.getElementById('edToolbar').scrollLeft = 0; });
    await settle(page);
    let fade = await page.evaluate(() => { const c = document.getElementById('edToolbar').classList; return [c.contains('fade-l'), c.contains('fade-r')]; });
    eq(fade, [false, true], '捲到最左：只有右邊顯示漸層遮罩');
    const tb = await rect(page, '#edToolbar');
    await page.mouse.move(tb.x + tb.w / 2, tb.y + tb.h / 2);
    const y0 = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 240);
    await sleep(120);
    const x1 = await page.evaluate(() => document.getElementById('edToolbar').scrollLeft);
    ok(x1 > 100, `滑鼠滾輪（直向）在工具列上：轉成橫向捲動（scrollLeft ${Math.round(x1)}）`);
    eq(await page.evaluate(() => scrollY), y0, '滾輪轉橫向時頁面不會跟著直向捲動');
    await page.mouse.wheel(240, 0);
    await sleep(120);
    ok((await page.evaluate(() => document.getElementById('edToolbar').scrollLeft)) > x1, '橫向滾動（觸控板）也能捲');
    await page.mouse.wheel(0, -2000);
    await sleep(120);
    eq(await page.evaluate(() => document.getElementById('edToolbar').scrollLeft), 0, '反方向滾輪可以捲回最左');
    // 捲到最右：復原／重做看得到、而且是這一排最右邊的兩顆
    await page.evaluate(() => { const t = document.getElementById('edToolbar'); t.scrollLeft = t.scrollWidth; });
    await settle(page);
    fade = await page.evaluate(() => { const c = document.getElementById('edToolbar').classList; return [c.contains('fade-l'), c.contains('fade-r')]; });
    eq(fade, [true, false], '捲到最右：只有左邊顯示漸層遮罩');
    const pos = await page.evaluate(() => {
      const t = document.getElementById('edToolbar').getBoundingClientRect(), u = document.getElementById('edUndo').getBoundingClientRect(), r = document.getElementById('edRedo').getBoundingClientRect();
      const others = [...document.querySelectorAll('#edToolbar button')].filter(b => b.id !== 'edUndo' && b.id !== 'edRedo').map(b => b.getBoundingClientRect().right);
      return { undoL: u.left, redoR: r.right, tbL: t.left, tbR: t.right, maxOther: Math.max(...others), redoTop: r.top, undoTop: u.top, firstTop: document.getElementById('edToolSelect').getBoundingClientRect().top };
    });
    ok(pos.redoR <= pos.tbR + 1 && pos.undoL >= pos.tbL, `捲到最右：復原／重做都在工具列範圍內（重做右緣 ${Math.round(pos.redoR)} ≤ ${Math.round(pos.tbR)}）`);
    ok(pos.redoR > pos.maxOther && pos.undoL > pos.maxOther - 1 && pos.tbR - pos.redoR < 30, '復原／重做是這一排最右側的兩顆，貼在尾端');
    eq([Math.round(pos.redoTop), Math.round(pos.undoTop)], [Math.round(pos.firstTop), Math.round(pos.firstTop)], '復原／重做和其他按鈕在同一排');
    await shot(page, `${tag}-L1-toolbar-scrolled-end`);
    // 鍵盤移到被捲出去的按鈕：瀏覽器會自動捲進來
    await page.evaluate(() => { document.getElementById('edToolbar').scrollLeft = 0; const bs = [...document.querySelectorAll('#edToolbar button')].filter(x => !x.disabled); bs[bs.length - 1].focus(); });
    await settle(page);
    ok((await page.evaluate(() => document.getElementById('edToolbar').scrollLeft)) > 0, '鍵盤移到最右邊的按鈕：工具列自動捲過去');
    await ctx.close();
  }

  // ---------------------------------------------------------------- 深色／淺色
  console.log('深色／淺色');
  {
    const { ctx, page } = await open();
    await goEdit(page);
    ok(await page.isVisible('#edThemeBtn'), '頁首有深色／淺色開關');
    const ic = await page.evaluate(() => { const i = document.querySelector('h1.topbar-title .brand-ic'); return i && { ok: i.complete && i.naturalWidth > 0, w: Math.round(i.getBoundingClientRect().width), src: i.getAttribute('src') }; });
    ok(ic && ic.ok && ic.w === 30 && ic.src === 'favicon.svg', `頁首標題旁有場記板圖示（${JSON.stringify(ic)}）`);
    eq(await attr(page), 'dark', '預設深色（data-ed-theme=dark）');
    eq(await page.getAttribute('#edThemeBtn', 'aria-pressed'), 'true', '開關 aria-pressed=true（深色）');
    ok((await page.getAttribute('#edThemeBtn', 'title')).includes('深色'), '開關有 title');
    for (const sel of ['body', 'header.topbar', '#editApp .ed-media', '#editApp .ed-inspector', '#edToolbar', '#edTimeline', '.ed-tl-scroll']) { const l = await lum(page, sel); ok(l < 0.25, `深色：${sel} 底色是深灰（亮度 ${l.toFixed(2)}）`); }
    ok((await lum(page, 'body')) > 0.03, '深色不是純黑（頁面背景亮度 > 0.03）');
    await shot(page, `${tag}-L2-dark-empty`);

    // 對比：文字與實際底色（往上層疊合半透明底）至少 4.5:1
    const contrast = (sels) => page.evaluate(sels => {
      const parse = c => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
      const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const L = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const bgOf = el => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
        let base = { r: 255, g: 255, b: 255 };
        for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
        return base;
      };
      return sels.map(sel => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true };
        const fg = parse(getComputedStyle(el).color), bg = bgOf(el);
        const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
        const a = L(f), b = L(bg);
        return { sel, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    }, sels);
    const SELS = ['h1.topbar-title', '#edThemeBtn', '.ed-tab.active', '.ed-tab:not(.active)', '.ed-mempty', '#edToolBlade', '#edToolSelect', '#edInsert', '.ed-action',
      '#edTc', '#edTcDur', '#edExportBtn', '.ed-vdims', '.ed-zoomlab', '.ed-th-name', '.ed-tick span', '.ed-ph', '.ed-tl-empty', '.ed-segbtn.active', '.ed-segbtn:not(.active)', '#edAspect'];
    await sleep(600);        // 頁首按鈕的顏色有 0.2 秒的漸變，等它停下來再量
    for (const r of await contrast(SELS)) {
      if (r.missing) { console.log('       略過（找不到）', r.sel); continue; }
      ok(r.ratio >= 4.5, `深色對比 ${r.sel}：${r.ratio.toFixed(2)}:1 ≥ 4.5`);
    }
    // 右鍵選單也要是深色
    await page.click('.ed-th-name >> nth=0', { button: 'right' });
    await page.waitForSelector('.ed-menu');
    ok((await lum(page, '.ed-menu')) < 0.25, '深色：右鍵選單底色是深色');
    for (const r of await contrast(['.ed-menu-item'])) ok(r.missing || r.ratio >= 4.5, `深色對比 ${r.sel}：${r.missing ? '無' : r.ratio.toFixed(2)}`);
    await shot(page, `${tag}-L2b-dark-menu`);
    await page.keyboard.press('Escape');

    // 切換：變淺色、aria-pressed 變 false、記住
    await page.click('#edThemeBtn');
    await sleep(600);
    eq(await attr(page), 'light', '按下開關：變淺色');
    eq(await page.getAttribute('#edThemeBtn', 'aria-pressed'), 'false', '淺色：aria-pressed=false');
    ok((await lum(page, 'body')) > 0.8 && (await lum(page, '#edTimeline')) > 0.8, '淺色：頁面與時間軸都是淺色');
    // 淺色是原本的配色（次要文字 #6b7890 等沿用 base.css），不在這次的對比要求內，只確認主要文字
    for (const r of await contrast(['h1.topbar-title', '#edToolBlade', '.ed-action', '#edTc', '.ed-th-name', '#edExportBtn'])) { if (!r.missing) ok(r.ratio >= 4.5, `淺色對比 ${r.sel}：${r.ratio.toFixed(2)}:1 ≥ 4.5`); }
    await shot(page, `${tag}-L3-light-empty`);
    eq(await page.evaluate(() => localStorage.getItem('qc-theme')), 'light', '選擇記在 localStorage');
    await page.reload();
    await goEdit(page);
    eq(await attr(page), 'light', '重新載入後仍是淺色（記住選擇）');
    eq(await page.getAttribute('#edThemeBtn', 'aria-pressed'), 'false', '重新載入後開關狀態也對');
    await page.click('#edThemeBtn');
    await settle(page);
    eq(await attr(page), 'dark', '再按一次：回到深色');
    ok((await lum(page, 'body')) < 0.25, '回到深色：頁面背景是深色');
    await ctx.close();
  }
  {
    // localStorage 丟錯：讀不到就用深色，切換也不能出錯
    const { ctx, page } = await open(() => {
      const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; Storage.prototype.removeItem = boom;
    });
    const before = problems.length;
    await goEdit(page);
    // 讀不到 localStorage → 開始畫面會出現（記不住「不要再顯示」），先關掉
    if (await page.$('#edStart')) { await page.keyboard.press('Escape'); await settle(page); }
    await page.evaluate(() => { const t = document.getElementById('edTip'); if (t) t.remove(); });
    eq(await attr(page), 'dark', 'localStorage 讀取丟錯：仍是深色');
    await page.click('#edThemeBtn');
    await settle(page);
    eq(await attr(page), 'light', 'localStorage 寫入丟錯：切換仍然有效（只是不記住）');
    ok(await page.isVisible('#editApp'), 'localStorage 丟錯時剪輯畫面正常');
    eq(problems.slice(before), [], 'localStorage 丟錯：沒有 console error／頁面例外');
    await ctx.close();
  }

  // ---------------------------------------------------------------- 直式版面
  console.log('直式版面');
  {
    const { ctx, page } = await open();
    await goEdit(page);
    ok(await page.isVisible('#edVert'), '橫式專案：「直式版面」按鈕也一直顯示');
    eq(await page.getAttribute('#edVert', 'aria-pressed'), 'false', '橫式專案預設關閉');
    ok(!(await isVert(page)), '橫式專案：版面是原本的樣子');
    const normalH = await rect(page, '#edViewer'), app0 = await rect(page, '#editApp');
    ok(normalH.h < app0.h * 0.8, `橫式：檢視器只佔上排（${Math.round(normalH.h)} < ${Math.round(app0.h)}）`);
    const lay0 = await page.evaluate(() => { const g = id => document.getElementById(id).getBoundingClientRect(); return { media: g('edMedia').left, viewer: g('edViewer').left, insp: g('edInspector').left }; });
    ok(lay0.media < lay0.viewer && lay0.viewer < lay0.insp, '橫式：媒體庫｜檢視器｜檢查器 由左到右');

    await page.selectOption('#edAspect', '9:16');
    await settle(page);
    ok(await page.isVisible('#edVert'), '改成 9:16：出現「直式版面」按鈕');
    eq(await page.getAttribute('#edVert', 'aria-pressed'), 'true', '直式專案預設開啟（aria-pressed=true）');
    ok((await page.getAttribute('#edVert', 'title')).includes('左側'), '按鈕 title 說明放到左側');
    ok(await isVert(page), '直式版面：#editApp 有 ed-vert');
    const app1 = await rect(page, '#editApp'), vw = await rect(page, '#edViewer');
    ok(Math.abs(vw.y - app1.y) <= 2 && Math.abs(vw.b - app1.b) <= 2, `檢視器從頂端延伸到底部（高 ${Math.round(vw.h)}，#editApp 高 ${Math.round(app1.h)}）`);
    const lay1 = await page.evaluate(() => { const g = id => document.getElementById(id).getBoundingClientRect(); return { viewerR: g('edViewer').right, media: g('edMedia').left, insp: g('edInspector').left, mediaB: g('edMedia').bottom, tlTop: g('edTimeline').top, tlL: g('edTimeline').left, tbL: g('edToolbar').left, tlR: g('edTimeline').right, appR: g('editApp').right }; });
    ok(vw.x <= app1.x + 1 && lay1.viewerR <= lay1.media + 1, '檢視器在最左欄，媒體庫在它右邊');
    ok(lay1.media < lay1.insp && lay1.mediaB <= lay1.tlTop, '右側：媒體庫｜檢查器 一排，下面是工具列與時間軸');
    ok(Math.abs(lay1.tlL - lay1.media) <= 1 && Math.abs(lay1.tbL - lay1.media) <= 1 && Math.abs(lay1.tlR - lay1.appR) <= 1, '工具列與時間軸跨滿右側');
    const big = await shown(page);
    // 1280×800 也要可用：右側時間軸看得到 2 條影片軌＋2 條音訊軌；工具列仍是單排
    const trk = await page.evaluate(() => {
      const sc = document.querySelector('.ed-tl-scroll').getBoundingClientRect(), tr = [...document.querySelectorAll('.ed-track')].map(e => e.getBoundingClientRect());
      return { n: tr.length, lastB: Math.max(...tr.map(r => r.bottom)), scB: sc.bottom, scH: sc.height };
    });
    ok(trk.n >= 4 && trk.lastB <= trk.scB + 1, `直式版面：時間軸看得到全部 ${trk.n} 條軌道（2 影片＋2 音訊；捲動區高 ${Math.round(trk.scH)}px）`);
    const tops = await page.evaluate(() => [...document.querySelectorAll('#edToolbar button')].map(b => Math.round(b.getBoundingClientRect().top)));
    ok(new Set(tops).size === 1, '直式版面：工具列仍是單排');
    ok((await rect(page, '#edAction')).w >= 150, '直式版面：狀態標籤沒被壓窄');
    ok(await page.evaluate(() => { const v = document.getElementById('edViewer'); return v.scrollWidth <= v.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; }), '直式版面：檢視器內容與頁面沒有橫向溢出');
    await shot(page, `${tag}-L6-vert-on-dark-empty`);
    // 一般版面（關掉）量畫面顯示尺寸，比較
    await page.click('#edVert');
    await settle(page);
    eq(await page.getAttribute('#edVert', 'aria-pressed'), 'false', '按下按鈕：aria-pressed=false');
    ok(!(await isVert(page)), '關閉後回到一般版面');
    const small = await shown(page);
    ok(big.h > small.h * 1.4 && big.w > small.w * 1.4, `直式版面的畫面比一般版面大（${Math.round(big.w)}×${Math.round(big.h)} vs ${Math.round(small.w)}×${Math.round(small.h)}）`);
    ok((await rect(page, '#edViewer')).h < app1.h * 0.8, '一般版面：檢視器又只佔上排');
    eq(await page.evaluate(() => localStorage.getItem('qc-vert')), '0', '選擇記在 localStorage');
    await shot(page, `${tag}-L5-vert-off-dark-empty`);
    // 記住：重新載入、改成 9:16 後仍是關
    await page.reload();
    await goEdit(page);
    await page.selectOption('#edAspect', '9:16');
    await settle(page);
    eq(await page.getAttribute('#edVert', 'aria-pressed'), 'false', '重新載入後（9:16）仍記得關閉');
    ok(!(await isVert(page)), '重新載入後版面是一般版面');
    // 切 16:9：按鈕消失、一般版面；切回 9:16：仍是記住的選擇（關）
    await page.selectOption('#edAspect', '16:9');
    await settle(page);
    ok(await page.isVisible('#edVert'), '切 16:9：按鈕仍顯示');
    eq(await page.getAttribute('#edVert', 'aria-pressed'), 'false', '切 16:9：顯示橫式自己的選擇（關）');
    ok(!(await isVert(page)), '切 16:9：一般版面');
    await page.selectOption('#edAspect', '9:16');
    await settle(page);
    ok(!(await isVert(page)), '切回 9:16：恢復記住的選擇（關）');
    await page.click('#edVert');
    await settle(page);
    // 開啟狀態下切 16:9 自動回一般版面，再切 9:16 恢復開啟
    ok(await isVert(page), '重新開啟直式版面');
    await page.selectOption('#edAspect', '16:9');
    await settle(page);
    ok(!(await isVert(page)), '開啟狀態下切 16:9：用橫式自己的選擇（預設關），回到一般版面');
    ok(Math.abs((await rect(page, '#edViewer')).h - normalH.h) < 3, '回到一般版面：檢視器高度與最初相同');
    await page.selectOption('#edAspect', '4:5');
    await settle(page);
    ok(await isVert(page), '切 4:5（也是直式）：恢復直式版面');
    await page.selectOption('#edAspect', '9:16');
    await settle(page);
    await page.click('#edThemeBtn');
    await settle(page);
    await shot(page, `${tag}-L7-vert-on-light-empty`);
    await page.reload();
    await goEdit(page);
    await page.selectOption('#edAspect', '9:16');
    await settle(page);
    ok((await isVert(page)) && (await attr(page)) === 'light', '重新載入：直式版面（開）與淺色都記住');
    await ctx.close();
  }

  // ---------------------------------------------------------------- 上排欄寬、橫式也能用直式版面
  console.log('上排欄寬分隔條、橫式切換直式版面');
  {
    const { ctx, page } = await open();
    await goEdit(page);
    const m0 = await rect(page, '#edMedia'), i0 = await rect(page, '#edInspector'), v0 = await rect(page, '#edViewer');
    const L = await rect(page, '#edColL'), Rr = await rect(page, '#edColR');
    ok(L.x >= m0.r - 1 && L.r <= v0.x + 1 && Rr.x >= v0.r - 1 && Rr.r <= i0.x + 1, '兩條分隔條分別在 媒體庫｜檢視器、檢視器｜詳細內容 之間');
    const mid = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await drag(page, mid(L), { x: mid(L).x + 80, y: mid(L).y });
    const m1 = await rect(page, '#edMedia');
    ok(Math.abs(m1.w - m0.w - 80) <= 2, `拖左分隔條：媒體庫變寬 80px（${Math.round(m0.w)} → ${Math.round(m1.w)}）`);
    const R1 = await rect(page, '#edColR');
    await drag(page, mid(R1), { x: mid(R1).x - 60, y: mid(R1).y });
    const i1 = await rect(page, '#edInspector');
    ok(Math.abs(i1.w - i0.w - 60) <= 2, `拖右分隔條：詳細內容變寬 60px（${Math.round(i0.w)} → ${Math.round(i1.w)}）`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '調整欄寬後頁面沒有橫向溢出');
    const cols = await page.evaluate(() => JSON.parse(localStorage.getItem('qc-cols')));
    ok(cols.mw > 0 && cols.iw > 0, `欄寬記在 localStorage（${JSON.stringify(cols)}）`);
    await shot(page, `${tag}-L8-cols-resized`);
    await page.reload(); await goEdit(page);
    ok(Math.abs((await rect(page, '#edMedia')).w - m1.w) <= 1 && Math.abs((await rect(page, '#edInspector')).w - i1.w) <= 1, '重新載入：欄寬維持');
    await page.dblclick('#edColL'); await settle(page);
    ok(Math.abs((await rect(page, '#edMedia')).w - m0.w) <= 1, '雙擊左分隔條：媒體庫恢復預設寬度');
    await page.dblclick('#edColR'); await settle(page);
    ok(Math.abs((await rect(page, '#edInspector')).w - i0.w) <= 1, '雙擊右分隔條：詳細內容恢復預設寬度');
    // 橫式專案也能切直式版面
    await page.click('#edVert'); await settle(page);
    ok(await isVert(page), '16:9 按「直式版面」：檢視器放到左側');
    eq(await page.evaluate(() => localStorage.getItem('qc-vert-h')), '1', '橫式的選擇另外記（qc-vert-h）');
    const app2 = await rect(page, '#editApp'), vv = await rect(page, '#edViewer');
    ok(Math.abs(vv.y - app2.y) <= 2 && Math.abs(vv.b - app2.b) <= 2, '橫式直式版面：檢視器從頂端延伸到底部');
    const VL = await rect(page, '#edColL');
    ok(VL.x >= vv.r - 1, '直式版面：左分隔條在預覽欄右邊');
    await drag(page, mid(VL), { x: mid(VL).x + 60, y: mid(VL).y });
    const vv2 = await rect(page, '#edViewer');
    ok(Math.abs(vv2.w - vv.w - 60) <= 2, `直式版面拖左分隔條：預覽欄變寬 60px（${Math.round(vv.w)} → ${Math.round(vv2.w)}）`);
    const VR = await rect(page, '#edColR'), mm = await rect(page, '#edMedia');
    ok(VR.x >= mm.r - 1, '直式版面：右分隔條在媒體庫和詳細內容之間');
    await drag(page, mid(VR), { x: mid(VR).x - 40, y: mid(VR).y });
    const mm2 = await rect(page, '#edMedia');
    ok(Math.abs(mm.w - mm2.w - 40) <= 2, `直式版面拖右分隔條：媒體庫變窄 40px（${Math.round(mm.w)} → ${Math.round(mm2.w)}）`);
    await drag(page, mid(await rect(page, '#edColR')), { x: mid(VR).x + 2000, y: mid(VR).y });
    ok((await rect(page, '#edInspector')).w >= 259, '往右拖到底：詳細內容仍保留最小寬度');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '直式版面調整欄寬後頁面沒有橫向溢出');
    await shot(page, `${tag}-L9-landscape-vert`);
    await page.selectOption('#edAspect', '9:16'); await settle(page);
    ok(await isVert(page), '切 9:16：直式的選擇（預設開）');
    await page.selectOption('#edAspect', '16:9'); await settle(page);
    await page.click('#edVert'); await settle(page);
    ok(!(await isVert(page)), '再按一次：16:9 回到一般版面');
    await ctx.close();
  }
  return problems;
}

// 關鍵影格與節拍（3.40）：◇ 加／刪關鍵影格、移動播放頭改值自動加關鍵影格、一鍵動畫、預覽拖曳、
// 節拍偵測（合成的 120 BPM 鼓聲）、打拍子、卡點、清除
function drumWav(bpm, sec) {
  const SR = 22050, n = SR * sec, x = new Float32Array(n);
  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let t = 0.25; t < sec - 0.2; t += 60 / bpm) {
    const s0 = Math.round(t * SR);
    for (let j = 0; j < SR * 0.12 && s0 + j < n; j++) x[s0 + j] += 0.7 * Math.exp(-j / (SR * 0.03)) * Math.sin(2 * Math.PI * 60 * j / SR);
    const h0 = Math.round((t + 30 / bpm) * SR);
    for (let j = 0; j < SR * 0.03 && h0 + j < n; j++) x[h0 + j] += 0.25 * Math.exp(-j / (SR * 0.005)) * rnd();
  }
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return b;
}
async function runAnimBeatTests(browser, base, fix, [W, H]) {
  console.log(`\n==== 關鍵影格與節拍 ${W}x${H} ====`);
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.goto(base);
  await settle(page);
  await page.setInputFiles('#edFile', [{ name: FILES.still, mimeType: 'image/png', buffer: fs.readFileSync(path.join(fix, FILES.still)) }, { name: 'drums.wav', mimeType: 'audio/wav', buffer: drumWav(120, 10) }]);
  await page.waitForFunction(() => QPTEdit.render.media.list().length === 2, null, { timeout: 30000 });
  await page.waitForFunction(() => QPTEdit.render.media.list().every(m => m.duration > 0 || m.kind === 'image'), null, { timeout: 30000 });
  await settle(page);
  // 圖片 4 段（各 2 秒）在 V1，鼓聲在 A1
  await page.evaluate(() => {
    const Q = QPTEdit, U = Q.uiParts, C = Q.core, p = Q.ui.state.project;
    const L = Q.render.media.list(), img = L.find(m => m.kind === 'image'), wav = L.find(m => m.kind === 'audio');
    const V = C.tracksOf(p, 'video')[0].id, A = C.tracksOf(p, 'audio')[0].id;
    for (let i = 0; i < 4; i++) U.op('放', q => C.editToTimeline(q, { mode: 'overwrite', mediaId: img.id, frame: i * 60, srcIn: 0, srcOut: 2, trackIds: { video: V, audio: null } }));
    U.op('放', q => C.editToTimeline(q, { mode: 'overwrite', mediaId: wav.id, frame: 0, srcIn: 0, srcOut: 10, trackIds: { video: null, audio: A } }));
  });
  const vclips = () => proj(page, (p, Q) => Object.values(p.clips).filter(c => c.video && c.type === 'media').sort((a, b) => a.start - b.start).map(c => c.id));
  const ids = await vclips();
  eq(ids.length, 4, '放了 4 段圖片');
  // ---- 關鍵影格
  await page.evaluate(id => { QPTEdit.ui.selectClips([id]); QPTEdit.ui.seekTimeline(10); }, ids[0]);
  await settle(page);
  await page.evaluate(() => { const b = document.querySelector('.ed-itab[data-itab="xform"]'); if (b) b.click(); });
  await settle(page);
  const kfRow = label => page.locator('.ed-fx-row', { has: page.locator('.ed-fx-lab', { hasText: new RegExp('^' + label + '$') }) });
  const kfCls = label => kfRow(label).locator('.ed-kf').getAttribute('class');
  eq(await kfCls('位置 X'), 'ed-kf', '位置 X 的 ◇ 一開始是空心（沒有動畫）');
  ok(!(await page.isVisible('.ed-kfnav')), '沒有關鍵影格時不顯示上一個／下一個');
  await kfRow('位置 X').locator('.ed-kf').click(); await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].keyframes['video.transform.posX'].map(k => [k.f, k.v]), ids[0]), [[10, 0]], '按 ◇：在播放頭（片段內第 10 格）加關鍵影格');
  eq(await kfCls('位置 X'), 'ed-kf on', '◇ 變實心（這格有關鍵影格）');
  ok((await page.textContent('#edUndoLab')).includes('加關鍵影格'), '復原標籤：加關鍵影格');
  // 移到第 40 格改數值 → 自動加關鍵影格
  await page.evaluate(() => QPTEdit.ui.seekTimeline(40)); await settle(page);
  eq(await kfCls('位置 X'), 'ed-kf anim', '播放頭不在關鍵影格上：◇ 半實心');
  await kfRow('位置 X').locator('input[type=number]').fill('300');
  await kfRow('位置 X').locator('input[type=number]').press('Enter');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].keyframes['video.transform.posX'].map(k => [k.f, k.v]), ids[0]), [[10, 0], [40, 300]], '有動畫的參數改數值：自動在播放頭加關鍵影格');
  eq(await proj(page, (p, Q, id) => p.clips[id].video.transform.posX, ids[0]), 0, '靜態值不變');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(25)); await settle(page);
  eq(await kfRow('位置 X').locator('input[type=number]').inputValue(), '150', '數值跟著播放頭顯示內插後的值（第 25 格＝150）');
  ok(await page.isVisible('.ed-kfnav'), '有關鍵影格時顯示上一個／下一個');
  await page.click('.ed-kf-next'); await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.state.playhead), 40, '▶：跳到下一個關鍵影格');
  await page.click('.ed-kf-prev'); await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.state.playhead), 10, '◀：跳到上一個關鍵影格');
  await page.selectOption('.ed-kf-interp', 'ease'); await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].keyframes['video.transform.posX'][0].interp, ids[0]), 'ease', '走法改成緩入緩出');
  ok(await page.locator(`.ed-clip[data-clip="${ids[0]}"] .ed-ckf i`).count() === 2, '時間軸片段上畫出 2 個關鍵影格');
  // 預覽上拖曳：有動畫的位置改成打關鍵影格
  await page.evaluate(() => QPTEdit.ui.seekTimeline(50)); await settle(page);
  const ovb = await page.evaluate(() => { const r = document.getElementById('edOverlay').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await drag(page, { x: ovb.x - 40, y: ovb.y }, { x: ovb.x - 10, y: ovb.y }, { steps: 6 });
  eq(await proj(page, (p, Q, id) => p.clips[id].keyframes['video.transform.posX'].map(k => k.f), ids[0]), [10, 40, 50], '預覽上拖曳有動畫的片段：在播放頭加關鍵影格');
  // 再按 ◇：刪掉這格
  await kfRow('位置 X').locator('.ed-kf').click(); await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].keyframes['video.transform.posX'].map(k => k.f), ids[0]), [10, 40], '在關鍵影格上按 ◇：刪除');
  page.once('dialog', d => d.accept());
  await page.click('.ed-kf-clear'); await settle(page);
  eq(await proj(page, (p, Q, id) => Object.keys(p.clips[id].keyframes), ids[0]), [], '清除：所有關鍵影格拿掉');
  // 一鍵動畫：多選一起套
  await page.evaluate(ids => QPTEdit.ui.selectClips(ids), ids); await settle(page);
  await page.click('.ed-kf-preset[data-preset="zoomIn"]'); await settle(page);
  eq(await proj(page, (p, Q, ids) => ids.map(id => (p.clips[id].keyframes['video.transform.zoomX'] || []).map(k => k.v)), ids), ids.map(() => [1, 1.15]), '一鍵「慢慢放大」：多選的 4 段都加上');
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await proj(page, (p, Q, ids) => ids.filter(id => p.clips[id].keyframes['video.transform.zoomX']).length, ids), 0, '復原一次：4 段的動畫一起拿掉');
  await page.click('.ed-kf-preset[data-preset="zoomIn"]'); await settle(page);
  await page.click('button:has-text("重設變形")'); await settle(page);
  eq(await proj(page, (p, Q, id) => Object.keys(p.clips[id].keyframes), ids[0]), [], '重設變形：關鍵影格也清掉');
  // ---- 節拍
  await page.evaluate(() => QPTEdit.ui.selectClips([])); await settle(page);
  await page.click('#edBeat'); await settle(page);
  ok((await page.textContent('.ed-pop.beat')).includes('drums.wav'), '節拍視窗：自動找到音訊軌上的音樂');
  await page.click('#edBeatDetect');
  await page.waitForFunction(() => /BPM/.test((document.getElementById('edBeatOut') || {}).textContent || ''), null, { timeout: 20000 });
  ok(/約 120 BPM/.test(await page.textContent('#edBeatOut')), `偵測出約 120 BPM（${await page.textContent('#edBeatOut')}）`);
  const beats = await proj(page, (p, Q) => Q.core.beatFrames(p));
  ok(beats.length >= 18 && beats.every((f, i) => !i || Math.abs(f - beats[i - 1] - 15) <= 1), `節拍標記每 15 格一個（30fps、120 BPM）：${beats.slice(0, 6)}…`);
  ok(Math.abs(beats[0] - 8) <= 1, `第一拍在 0.25 秒（第 ${beats[0]} 格）`);
  // 卡點：4 段圖片每 2 拍
  await page.keyboard.press('Escape');
  await page.evaluate(ids => QPTEdit.ui.selectClips(ids), ids); await settle(page);
  await page.click('#edBeat'); await settle(page);
  await page.selectOption('#edBeatEvery', '2');
  await page.click('#edBeatFit'); await settle(page);
  const spans = await proj(page, (p, Q, ids) => ids.map(id => [p.clips[id].start, p.clips[id].duration]), ids);
  ok(spans.slice(1).every(([s, d], i) => d === 30 && beats.includes(s) && s === spans[i][0] + spans[i][1]), `卡點：第 2 段起每段 2 拍（30 格）、接在節拍上：${JSON.stringify(spans)}`);
  eq(await invariants(page), [], '卡點後專案沒有問題');
  // 打拍子
  await page.click('#edBeat'); await settle(page);
  await page.click('#edBeatClear'); await settle(page);
  eq(await proj(page, (p, Q) => Q.core.beatFrames(p).length), 0, '清除節拍標記');
  await page.click('#edBeat'); await settle(page);
  await page.click('#edBeatTap'); await settle(page);
  ok(await page.evaluate(() => QPTEdit.ui.state.beatTap && QPTEdit.uiParts.player.playing), '開始打拍子：開始播放');
  for (let i = 0; i < 3; i++) { await sleep(350); await page.keyboard.press('m'); }
  await page.keyboard.press(' ');
  await settle(page);
  eq(await proj(page, (p, Q) => Q.core.beatFrames(p).length), 3, '播放中按三次 M：加三個節拍標記（不開小視窗）');
  ok(!(await page.isVisible('.ed-pop')), '打拍子時沒有跳出標記視窗');
  ok(!(await page.evaluate(() => QPTEdit.ui.state.beatTap)), '停止播放就結束打拍子');
  await ctx.close();
  return problems;
}

async function runRetimeTests(browser, base, fix, [W, H]) {
  console.log(`\n==== 曲線變速 ${W}x${H} ====`);
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.goto(base);
  await settle(page);
  await page.setInputFiles('#edFile', [{ name: FILES.land, mimeType: 'video/webm', buffer: fs.readFileSync(path.join(fix, FILES.land)) }, { name: FILES.still, mimeType: 'image/png', buffer: fs.readFileSync(path.join(fix, FILES.still)) }]);
  await page.waitForFunction(() => QPTEdit.render.media.list().length === 2 && QPTEdit.render.media.list().every(m => m.duration > 0 || m.kind === 'image'), null, { timeout: 30000 });
  await settle(page);
  // 影片 2 秒（0.5~2.5 秒，連結聲音）在 [0,60)，後面接一張圖 [60,120)
  const [vid, aud, img] = await page.evaluate(() => {
    const Q = QPTEdit, U = Q.uiParts, C = Q.core, p = Q.ui.state.project;
    const L = Q.render.media.list(), v = L.find(m => m.kind === 'video'), im = L.find(m => m.kind === 'image');
    const V = C.tracksOf(p, 'video')[0].id, A = C.tracksOf(p, 'audio')[0].id;
    const r = U.op('放', q => C.editToTimeline(q, { mode: 'overwrite', mediaId: v.id, frame: 0, srcIn: 0.5, srcOut: 2.5, trackIds: { video: V, audio: A } }));
    const r2 = U.op('放', q => C.editToTimeline(q, { mode: 'overwrite', mediaId: im.id, frame: 60, srcIn: 0, srcOut: 2, trackIds: { video: V, audio: null } }));
    const ids = r.ids.slice().sort((a, b) => (p.clips[a].video ? -1 : 1));
    return [ids[0], ids[1], r2.ids[0]];
  });
  await page.evaluate(id => { QPTEdit.ui.selectClips([id]); QPTEdit.ui.seekTimeline(5); }, vid);
  await settle(page);
  await page.keyboard.press('Control+r'); await settle(page);
  eq(await page.locator('#edRetimeGrid .ed-rt-opt').count(), 7, '變速視窗：7 個曲線選項（不用曲線＋6 個預設）');
  eq(await page.getAttribute('#edRetimeGrid .ed-rt-opt[data-preset="none"]', 'aria-pressed'), 'true', '一開始是「不用曲線」');
  ok(!(await page.isVisible('#edRetimeStr')), '不用曲線時不顯示強度');
  await page.click('#edRetimeGrid .ed-rt-opt[data-preset="slowMid"]'); await settle(page);
  ok(await page.isVisible('#edRetimeStr'), '選了曲線：出現強度滑桿');
  ok(await page.isDisabled('#edSpeedRev'), '選了曲線：倒播不能勾');
  ok((await page.textContent('.ed-pop.speed')).includes('基準速度'), '選了曲線：「速度」改叫「基準速度」');
  await page.check('#edSpeedRipple');
  await page.click('#edSpeedOk'); await settle(page);
  const st = await proj(page, (p, Q, [v, a, i]) => ({ v: p.clips[v], a: p.clips[a], i: p.clips[i], probs: Q.core.checkInvariants(p) }), [vid, aud, img]);
  eq([st.v.retime && st.v.retime.preset, st.a.retime && st.a.retime.preset], ['slowMid', 'slowMid'], '套用「中段慢動作」：影片和連結的聲音都有曲線');
  ok(st.v.duration > 60 && st.v.duration === st.a.duration, `波紋：慢動作讓片段變長（60 → ${st.v.duration} 格），聲音同長`);
  eq(st.i.start, st.v.duration, '後面的圖片被推到影片結尾');
  eq(st.probs, [], '專案沒有問題');
  ok((await page.locator(`.ed-clip[data-clip="${vid}"] .ed-badge.rt`).count()) === 1, '時間軸片段上顯示「曲線」標籤');
  ok((await page.textContent('#edUndoLab')).includes('曲線變速'), '復原標籤：曲線變速');
  // 預覽：暫停時畫面停在 sourceTimeAt；播放時影片速度跟著曲線變
  const mid = Math.floor(st.v.duration / 2);
  await page.evaluate(f => QPTEdit.ui.seekTimeline(f), mid); await settle(page);
  const seekOk = await page.evaluate(([id, f]) => { const C = QPTEdit.core, p = QPTEdit.ui.state.project; const t = C.sourceTimeAt(p, p.clips[id], f); return t > 1.0 && t < 2.0; }, [vid, mid]);
  ok(seekOk, '中間那一格看到的是來源中段的畫面');
  // 檢查器：速度區塊有說明、倒播不能勾
  await page.evaluate(() => { const b = document.querySelector('.ed-itab[data-itab="speed"]'); if (b) b.click(); }); await settle(page);
  ok((await page.textContent('#edInspector')).includes('曲線變速中'), '檢查器速度分頁：顯示曲線變速中');
  ok(await page.locator('#edInspector .ed-fx-chk', { hasText: '倒播' }).locator('input').isDisabled(), '檢查器：曲線變速時倒播不能勾');
  // 再開視窗：記得目前的曲線與強度；換成強度 50%
  await page.keyboard.press('Control+r'); await settle(page);
  eq(await page.getAttribute('#edRetimeGrid .ed-rt-opt[data-preset="slowMid"]', 'aria-pressed'), 'true', '再開視窗：選著目前的曲線');
  await page.fill('#edSpeedPct', '100');
  await page.evaluate(() => { const s = document.getElementById('edRetimeStr'); s.value = 50; s.dispatchEvent(new Event('input')); });
  await page.click('#edSpeedOk'); await settle(page);
  const d50 = await proj(page, (p, Q, v) => [p.clips[v].retime.strength, p.clips[v].duration], vid);
  ok(d50[0] === 0.5 && d50[1] < st.v.duration && d50[1] > 60, `強度 50%：慢動作變短（${st.v.duration} → ${d50[1]} 格）`);
  // 取消曲線：回到 100%、60 格
  await page.keyboard.press('Control+r'); await settle(page);
  await page.click('#edRetimeGrid .ed-rt-opt[data-preset="none"]'); await settle(page);
  await page.click('#edSpeedOk'); await settle(page);
  eq(await proj(page, (p, Q, [v, a]) => [p.clips[v].retime, p.clips[a].retime, p.clips[v].speed, p.clips[v].duration], [vid, aud]), [null, null, 1, 60], '選「不用曲線」：取消曲線，回到 100%、60 格');
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await proj(page, (p, Q, v) => [p.clips[v].retime && p.clips[v].retime.strength, p.clips[v].duration], vid), d50, '復原：曲線回來');
  // 切開：兩半都還是曲線、畫面不跳
  const before = await page.evaluate(id => { const C = QPTEdit.core, p = QPTEdit.ui.state.project, c = p.clips[id]; const a = []; for (let f = c.start; f < c.start + c.duration; f++) a.push(C.sourceTimeAt(p, c, f)); return a; }, vid);
  await page.evaluate(f => QPTEdit.ui.seekTimeline(f), Math.floor(d50[1] / 3)); await settle(page);
  await page.evaluate(() => QPTEdit.ui.selectClips([]));
  await page.keyboard.press('Control+b'); await settle(page);
  const after = await page.evaluate(() => {
    const C = QPTEdit.core, p = QPTEdit.ui.state.project, V = C.tracksOf(p, 'video')[0].id;
    const cs = Object.values(p.clips).filter(c => c.trackId === V && c.type === 'media' && c.retime).sort((a, b) => a.start - b.start);
    const a = []; for (const c of cs) for (let f = c.start; f < c.start + c.duration; f++) a.push(C.sourceTimeAt(p, c, f));
    return { n: cs.length, a };
  });
  eq(after.n, 2, '在播放頭切開（Ctrl+B）：兩半都保留曲線');
  ok(after.a.length === before.length && after.a.every((x, i) => Math.abs(x - before[i]) < 1e-6), '切開後每一格的畫面都和切之前一樣');
  eq(await invariants(page), [], '切開後專案沒有問題');
  await ctx.close();
  return problems;
}

(async () => {
  const fix = fixturesDir();
  const { server, base } = await serve();
  const browser = require('./e2e-pro.js')(await chromium.launch(EXE ? { executablePath: EXE } : {}));
  let all = [];
  try {
    for (const vp of VIEWPORTS) all = all.concat(await runLayoutTests(browser, base, vp));
    for (const vp of VIEWPORTS) all = all.concat(await runStageTests(browser, base, vp));
    all = all.concat(await runAnimBeatTests(browser, base, fix, VIEWPORTS[0]));
    all = all.concat(await runRetimeTests(browser, base, fix, VIEWPORTS[0]));
    for (const vp of VIEWPORTS) all = all.concat(await runViewport(browser, base, fix, vp));
  } catch (e) { failed++; console.log('  FAIL 測試中斷：', e && e.stack || e); }
  ok(all.length === 0, '整段流程沒有 console error／頁面例外／CSP 違規' + (all.length ? '：' + all.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
})();
