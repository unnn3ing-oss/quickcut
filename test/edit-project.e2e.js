// =====================================================================================
// 專案存檔／開檔、自動暫存、重新連結素材（edit-project.js）的瀏覽器流程測試。
//
// 執行：node test/edit-project.e2e.js
//   （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//   EDIT_FIXTURES=<資料夾>   測試素材（和 edit-ui.e2e.js 共用；沒有就用 ffmpeg 產生到暫存資料夾）
//   SHOTS=<資料夾>           截圖輸出位置（沒設就不存圖）
//   CHROMIUM=<路徑>          瀏覽器執行檔（沒設時用 /opt/pw-browsers/chromium）
//
// 「記住檔案位置」（FileSystemFileHandle＋權限）需要真的檔案挑選視窗，自動化測不到，要手動確認；
// 這裡用假的 showDirectoryPicker 測「選擇資料夾」的配對流程。
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
const FILES = { land: 'landscape-720p-6s.webm', music: 'music-8s.webm', still: 'still.png' };

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } return !!cond; }
function eq(a, b, msg) { const r = JSON.stringify(a) === JSON.stringify(b); if (!r) console.log('       期望', JSON.stringify(b), '實際', JSON.stringify(a)); return ok(r, msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ffmpeg(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' }); }
function fixturesDir() {
  const want = process.env.EDIT_FIXTURES;
  if (want && Object.values(FILES).every(f => fs.existsSync(path.join(want, f)))) return want;
  const dir = path.join(os.tmpdir(), 'qc-ui-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const has = f => fs.existsSync(path.join(dir, f)), out = f => path.join(dir, f);
  if (!has(FILES.land)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
    '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest', out(FILES.land)]);
  if (!has(FILES.music)) ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', out(FILES.music)]);
  if (!has(FILES.still)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', out(FILES.still)]);
  return dir;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webm': 'video/webm' };
function serve() {
  return new Promise(res => {
    const server = http.createServer((req, rsp) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}

const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
const proj = (page, fn, arg) => page.evaluate(new Function('arg', `const p = window.QPTEdit.ui.state.project, Q = window.QPTEdit; return (${fn.toString()})(p, Q, arg);`), arg);
const invariants = page => page.evaluate(() => window.QPTEdit.core.checkInvariants(window.QPTEdit.ui.state.project));
const statusText = page => page.evaluate(() => document.getElementById('edStatus').textContent);
// 專案摘要：每個片段的 軌道:開始+長度:素材檔名（素材不在就是 ?檔名）
const summary = page => page.evaluate(() => {
  const Q = window.QPTEdit, p = Q.ui.state.project;
  return Object.values(p.clips).sort((a, b) => a.trackId.localeCompare(b.trackId) || a.start - b.start).map(c => {
    const t = p.tracks.find(x => x.id === c.trackId).name;
    if (c.type !== 'media') return `${t}:${c.start}+${c.duration}:${c.type}`;
    const m = Q.render.media.get(c.mediaId);
    return `${t}:${c.start}+${c.duration}:${m ? m.name : '?' + (p.mediaInfo[c.mediaId] || {}).name}`;
  });
});
const autosaveRec = page => page.evaluate(() => new Promise(res => {
  const rq = indexedDB.open('quickcut', 1);
  rq.onupgradeneeded = () => { for (const s of ['kv', 'handles']) rq.result.createObjectStore(s); };
  rq.onsuccess = () => { const g = rq.result.transaction('kv').objectStore('kv').get('autosave'); g.onsuccess = () => res(g.result ? { clips: g.result.clips, media: g.result.media, len: g.result.text.length } : null); g.onerror = () => res(null); };
  rq.onerror = () => res(null);
}));
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
function watch(page, problems) {
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  return page.addInitScript(() => {
    window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    // headless Chromium 對非 ASCII 的下載檔名一律回報「download」：改記 <a download> 的值
    window.__dl = []; const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push(this.download); return click.call(this); };
  });
}
const lastDl = page => page.evaluate(() => window.__dl[window.__dl.length - 1] || '');
async function exportTry(page) {
  await page.click('#edExportBtn');
  await page.waitForSelector('#edExportDialog[open]');
  await page.click('#edExQuality button[data-v="small"]');
}

async function main() {
  const fix = fixturesDir();
  const { server, base } = await serve();
  const browser = await chromium.launch({ executablePath: EXE });
  const problems = [];
  let saved = null;

  // ---------------------------------------------------------------- 剪一段、儲存專案
  console.log('剪一段、儲存專案');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  let page = await ctx.newPage(); cur = page;
  await watch(page, problems);
  await page.goto(base);
  await settle(page);
  ok(!(await page.isVisible('#confirmOverlay.open')), '第一次打開：沒有「還原上次的剪輯？」');
  ok(await page.isVisible('#edSaveBtn') && await page.isVisible('#edOpenBtn'), '頁首有「開啟專案」「儲存專案」');
  ok(await page.isHidden('#edRelink'), '沒有缺少素材的提示');
  await page.setInputFiles('#edFile', [FILES.land, FILES.music, FILES.still].map(f => path.join(fix, f)));
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 3, null, { timeout: 60000 });
  await settle(page);
  const idOf = name => page.evaluate(n => window.QPTEdit.render.media.list().find(m => m.name === n).id, name);
  for (const k of ['land', 'still', 'land']) { await page.click(`.ed-mitem[data-media="${await idOf(FILES[k])}"]`); await page.click('#edAppend'); await settle(page); }
  await page.evaluate(() => { const Q = window.QPTEdit, p = Q.ui.state.project; const a2 = Q.core.tracksOf(p, 'audio')[1].id; const m = Q.render.media.list().find(x => x.kind === 'audio');
    Q.ui.state.history.run('放音樂', q => Q.core.addClip(q, { type: 'media', mediaId: m.id, trackId: a2, start: 30, duration: 120 })); });
  await page.evaluate(() => window.QPTEdit.ui.addTitle());
  await settle(page);
  await page.evaluate(() => window.QPTEdit.ui.seekTimeline(75));
  const before = await summary(page);
  ok(before.length >= 6, `時間軸有 ${before.length} 個片段`);
  eq(await invariants(page), [], '不變式 OK');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#edSaveBtn')]);
  ok(/^剪輯專案_\d{8}-\d{4}\.qcut$/.test(await lastDl(page)), `檔名：${await lastDl(page)}`);
  const savePath = path.join(os.tmpdir(), `qc-project-${process.pid}.qcut`);
  await dl.saveAs(savePath);
  saved = fs.readFileSync(savePath, 'utf8');
  ok(saved.length < 30000, `專案檔很小：${saved.length} bytes（不含素材）`);
  const sv = JSON.parse(saved);
  eq([sv.format, sv.version, sv.view.playhead], ['quickcut-project', 1, 75], '格式、版本、播放頭');
  eq(Object.keys(sv.project.clips).length, before.length, '片段都存進去了');
  ok(Object.values(sv.project.mediaInfo).every(m => m.size > 0 && m.name), '每個素材都記了檔名與大小');
  ok((await statusText(page)).includes('已儲存專案'), '狀態列：已儲存專案');
  ok(!(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })), '存檔後關頁不再提醒');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  ok(dl2 && /\.qcut$/.test(await lastDl(page)) && (await page.evaluate(() => window.__dl.length)) === 2, 'Ctrl+S 也會儲存專案');

  // ---------------------------------------------------------------- 自動暫存 → 重新整理 → 還原
  console.log('自動暫存與還原');
  let rec = null;
  for (let i = 0; i < 40 && !(rec = await autosaveRec(page)); i++) await sleep(100);
  ok(rec && rec.clips === before.length && rec.media === 3, `自動暫存寫進 IndexedDB（${JSON.stringify(rec)}）`);
  await page.reload();
  await page.waitForSelector('#confirmOverlay.open', { timeout: 10000 });
  ok((await page.textContent('#confirmTitle')).includes('還原上次的剪輯'), '重新整理後問要不要還原');
  eq(await page.textContent('#confirmCancelBtn'), '開新專案', '另一個選項是「開新專案」');
  await shot(page, 'P1-restore-ask');
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => window.QPTEdit.project.ready);
  await settle(page);
  const restored = await summary(page);
  eq(restored.length, before.length, '還原後片段數量一樣');
  ok(restored.every(s => /:\?|:title$/.test(s)), '素材都還沒接回來（以 ? 標示）');
  eq(await page.evaluate(() => window.QPTEdit.ui.state.playhead), 75, '播放頭回到存檔時的位置');
  ok(await page.isVisible('#edRelink'), '媒體庫上方出現「缺少素材」提示');
  ok((await page.textContent('#edRelink')).includes('缺少 3 個素材'), `提示內容：${(await page.textContent('#edRelink')).slice(0, 40)}…`);
  const lostLabels = await page.evaluate(() => [...document.querySelectorAll('.ed-clip')].filter(e => e.textContent.includes('（缺少素材）')).length);
  eq(lostLabels, before.filter(s => !s.endsWith(':title')).length, `每個缺素材的片段都標示「缺少素材」（${lostLabels} 個）`);
  ok((await page.textContent('#edMList')).includes('重新連結後會出現在這裡'), '媒體庫的空白提示改成「重新連結後會出現」');
  eq(await invariants(page), [], '不變式 OK（缺素材也不會壞）');
  await shot(page, 'P2-missing');
  // 匯出被擋下
  await exportTry(page);
  await page.click('#edExGo');
  await settle(page);
  ok((await page.textContent('#edExMsg')).includes('沒有重新連結'), `匯出被擋下：${await page.textContent('#edExMsg')}`);
  await page.click('#edExClose');
  // 手動選檔重新連結（多選一個不相干的也沒關係）
  await page.setInputFiles('#edRelinkFile', [FILES.music, FILES.land].map(f => path.join(fix, f)));
  await page.waitForFunction(() => window.QPTEdit.project.missing().length === 1, null, { timeout: 60000 });
  await settle(page);
  ok((await statusText(page)).includes('已重新連結 2 個素材'), `狀態列：${await statusText(page)}`);
  ok((await page.textContent('#edRelink')).includes('缺少 1 個素材'), '剩下 1 個（圖片）');
  await page.setInputFiles('#edFile', [path.join(fix, FILES.still)]);    // 一般匯入也會自動配對
  await page.waitForFunction(() => window.QPTEdit.project.missing().length === 0, null, { timeout: 30000 });
  await settle(page);
  ok(await page.isHidden('#edRelink'), '全部接回來：提示消失');
  eq(await summary(page), before, '片段、位置、素材都和存檔前一樣');
  eq(await page.evaluate(() => window.QPTEdit.render.media.list().length), 3, '媒體庫沒有多出重複的素材');
  eq(await invariants(page), [], '不變式 OK');
  await shot(page, 'P3-relinked');
  // 接回來之後可以匯出（只匯出前 15 格）
  await page.evaluate(() => { const Q = window.QPTEdit; Q.ui.state.history.run('In／Out', p => Q.core.setInOut(p, 0, 15)); });
  await exportTry(page);
  const [mp4] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#edExGo')]);
  ok(mp4 && /\.mp4$/.test(await lastDl(page)), `接回素材後可以匯出：${await lastDl(page)}`);
  await page.waitForFunction(() => /已匯出/.test(document.getElementById('edExMsg').textContent), null, { timeout: 60000 });
  await page.click('#edExClose');

  // ---------------------------------------------------------------- 開新專案：清掉暫存
  console.log('拒絕還原');
  await sleep(1800);       // 等自動暫存寫進去
  await page.reload();
  await page.waitForSelector('#confirmOverlay.open', { timeout: 10000 });
  await page.click('#confirmCancelBtn');
  await page.waitForFunction(() => window.QPTEdit.project.ready);
  eq(await page.evaluate(() => Object.keys(window.QPTEdit.ui.state.project.clips).length), 0, '選「開新專案」：空白專案');
  eq(await autosaveRec(page), null, '暫存被清掉');
  await page.reload();
  await settle(page); await sleep(300);
  ok(!(await page.isVisible('#confirmOverlay.open')), '再重新整理：不會再問');
  await ctx.close();

  // ---------------------------------------------------------------- 另一台電腦：開專案檔＋選資料夾自動配對
  console.log('開啟專案檔、選資料夾配對');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx2.newPage(); cur = page;
  await watch(page, problems);
  // 假的資料夾挑選器：素材/（still.png）＋ 素材/sub/（影片、音樂、不相干的檔案）。
  // 頁面的 CSP 不准連網路（fetch 會被擋），所以檔案內容由 node 讀好、用 base64 傳進頁面（window.__fx）
  await page.addInitScript(() => {
    const file = (name, key) => ({ kind: 'file', name, getFile: async () => new File([window.__fx[key]], name, { lastModified: 1 }) });
    const dir = (name, kids) => ({ kind: 'directory', name, values: async function* () { for (const k of kids) yield k; } });
    window.showDirectoryPicker = async () => { window.__dirPicked = (window.__dirPicked || 0) + 1; return dir('素材', [
      file('still.png', 'still'), dir('.cache', [file('landscape-720p-6s.webm', 'still')]),
      dir('sub', [file('landscape-720p-6s.webm', 'land'), file('music-8s.webm', 'music'), file('notes.txt', 'still')]),
    ]); };
  });
  await page.goto(base);
  await settle(page);
  await page.evaluate(fx => { window.__fx = {}; for (const [k, b64] of Object.entries(fx)) window.__fx[k] = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]); },
    Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, fs.readFileSync(path.join(fix, f)).toString('base64')])));
  ok(!(await page.isVisible('#confirmOverlay.open')), '新的瀏覽器：沒有暫存可還原');
  await page.setInputFiles('#edProjFile', { name: 'demo.qcut', mimeType: 'application/json', buffer: Buffer.from(saved, 'utf8') });
  await page.waitForFunction(() => window.QPTEdit.project.missing().length === 3, null, { timeout: 10000 });
  await settle(page);
  eq((await summary(page)).length, before.length, '開啟專案檔：片段都在');
  ok(await page.isVisible('#edRelinkDir'), '有「選擇資料夾」按鈕');
  ok(!(await page.isVisible('#edRelinkGrant')), '沒有記住的檔案位置：不顯示「允許存取」');
  await page.click('#edRelinkDir');
  await page.waitForFunction(() => window.QPTEdit.project.missing().length === 0, null, { timeout: 60000 });
  await settle(page);
  eq(await summary(page), before, '選資料夾：子資料夾裡的素材也自動配對，片段全部接回');
  eq(await page.evaluate(() => window.QPTEdit.render.media.list().map(m => m.name).sort()), [FILES.land, FILES.still, FILES.music].sort(), '只讀進需要的檔案（略過 notes.txt 和 .cache）');
  // 新匯入的素材不會拿到存檔裡的 id
  await page.setInputFiles('#edFile', [path.join(fix, FILES.still)]);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 4, null, { timeout: 30000 });
  ok(await page.evaluate(() => { const ids = window.QPTEdit.render.media.list().map(m => m.id); return new Set(ids).size === ids.length; }), '再匯入的素材 id 不會和專案裡的重複');
  eq(await invariants(page), [], '不變式 OK');

  // ---------------------------------------------------------------- 把專案檔拖進畫面＝開啟（目前沒存的剪輯要先確認）
  console.log('拖進專案檔');
  await page.evaluate(() => { const Q = window.QPTEdit; const c = Object.values(Q.ui.state.project.clips)[0]; Q.ui.state.history.run('改名', p => Q.core.setClipProps(p, [c.id], { name: '改過' })); });
  await page.evaluate(text => {
    const dt = new DataTransfer(); dt.items.add(new File([text], '拖進來.qcut', { type: '' }));
    document.getElementById('editApp').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, saved);
  await page.waitForSelector('#confirmOverlay.open', { timeout: 5000 });
  ok((await page.textContent('#confirmMessage')).includes('還沒儲存'), '有沒存的改動：先問要不要取代');
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => window.QPTEdit.project.missing().length === 0 && !Object.values(window.QPTEdit.ui.state.project.clips).some(c => c.name === '改過'), null, { timeout: 60000 });
  await settle(page);
  eq(await summary(page), before, '開檔前在媒體庫的素材直接沿用，不用再連結');
  eq(await invariants(page), [], '不變式 OK');
  // 不是專案檔
  await page.setInputFiles('#edProjFile', { name: 'bad.qcut', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await sleep(300);
  ok((await statusText(page)).includes('不是 QuickCut 的專案檔'), '壞掉的專案檔：顯示原因，不動目前的專案');
  eq((await summary(page)).length, before.length, '目前的專案還在');

  eq(problems, [], '沒有 console error／頁面例外');
  eq(await page.evaluate(() => window.__csp), [], '沒有 CSP 違規');
  await ctx2.close();
  await browser.close();
  server.close();
  fs.rmSync(savePath, { force: true });
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
}

let cur = null;            // 目前的頁面：測試中斷時印出狀態幫忙除錯
main().catch(async e => {
  console.error(e);
  if (cur) try { console.error('頁面狀態', JSON.stringify(await cur.evaluate(() => ({ status: document.getElementById('edStatus').textContent, missing: window.QPTEdit.project.missing().map(x => x.name), media: window.QPTEdit.render.media.list().map(m => m.id + ':' + m.name), confirm: document.querySelector('#confirmOverlay.open') ? document.getElementById('confirmTitle').textContent : null, msgs: document.getElementById('edMsgs').textContent })))); } catch (_) { /* 頁面已關 */ }
  process.exit(1);
});
