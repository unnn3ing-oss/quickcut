// =====================================================================================
// 一鍵成片（4.10）的瀏覽器流程測試：簡易工具列的入口、對話框裡加素材／音樂（不自動排到時間軸）、
// 點選順序、音樂／風格選項、產生（有音樂＋節奏感、不要音樂＋溫柔回憶）、整批一次復原、接在後面、
// Esc／取消／點背景關閉、專業模式下 UI.openAuto 也能用。
//
// 執行：node test/edit-auto.e2e.js
//   （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//   每個情境都從乾淨的 localStorage 開始（只先設 qc-tips＝done 略過教學）。
//   EDIT_FIXTURES=<資料夾>   測試素材（同 edit-ui.e2e.js）；沒指定或缺檔就用 ffmpeg 產生到暫存資料夾
//   SHOTS=<資料夾>           截圖輸出位置（沒設就不存圖）
//   CHROMIUM=<路徑>          瀏覽器執行檔（沒設時用 /opt/pw-browsers/chromium，再沒有就用 playwright 預設）
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
const FILES = { land: 'landscape-720p-6s.webm', port: 'portrait-720x1280-4s.webm', mute: 'noaudio-25fps-3s.webm', music: 'music-8s.webm', still: 'still.png' };

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } return !!cond; }
function eq(a, b, msg) { const r = JSON.stringify(a) === JSON.stringify(b); if (!r) console.log('       期望', JSON.stringify(b), '實際', JSON.stringify(a)); return ok(r, msg); }

// ---- 素材（和 edit-ui.e2e.js 共用同一個暫存資料夾）-------------------------------------
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

// ---- 本機伺服器 ------------------------------------------------------------------------
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
const proj = (page, fn, arg) => page.evaluate(new Function('arg', `const p = window.QPTEdit.ui.state.project, Q = window.QPTEdit; return (${fn.toString()})(p, Q, arg);`), arg);
const nClips = page => proj(page, p => Object.keys(p.clips).length);
const nTrans = page => proj(page, p => Object.keys(p.transitions).length);
const snapshot = page => page.evaluate(() => JSON.stringify(window.QPTEdit.ui.state.project));
const invariants = page => proj(page, (p, Q) => Q.core.checkInvariants(p));
// 各軌道上的片段（依 start 排序）：{ 軌道名: [{ id, s, d, name, kind, fit, look, kf, fadeOut }] }
const byTrack = page => proj(page, p => {
  const out = {};
  for (const t of p.tracks) out[t.name] = [];
  for (const c of Object.values(p.clips).sort((a, b) => a.start - b.start)) {
    const t = p.tracks.find(x => x.id === c.trackId), m = c.mediaId && p.mediaInfo[c.mediaId];
    out[t.name].push({ id: c.id, s: c.start, d: c.duration, name: m ? m.name : c.name, kind: m ? m.kind : c.type, fit: c.video ? c.video.fit : null,
      look: c.video ? c.video.look || null : null, kf: Object.keys(c.keyframes || {}).filter(k => (c.keyframes[k] || []).length).sort(),
      fadeOut: c.audio ? c.audio.fadeOut || 0 : null });
  }
  return out;
});
const transitions = page => proj(page, p => Object.values(p.transitions).map(t => ({ type: t.type, color: t.color || null, left: t.leftClipId || null, right: t.rightClipId || null, d: t.duration })));
// 媒體庫：名稱 → id
const mediaIds = page => page.evaluate(() => Object.fromEntries(window.QPTEdit.render.media.list().map(m => [m.name, m.id])));
// 對話框狀態
const dlgState = page => page.evaluate(() => {
  const d = document.getElementById('edAuto');
  if (!d) return null;
  const th = [...d.querySelectorAll('#edAutoMedia .ed-auto-th[data-media]')].map(b => ({ id: b.dataset.media, on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed'), ord: b.querySelector('.ed-auto-ord').textContent }));
  const sel = th.filter(t => t.on).sort((a, b) => Number(a.ord) - Number(b.ord)).map(t => t.id);
  const music = [...d.querySelectorAll('#edAutoMusic [data-music]')].map(b => ({ id: b.dataset.music, on: b.getAttribute('aria-checked') === 'true', cls: b.classList.contains('on') }));
  const style = [...d.querySelectorAll('#edAutoStyle [data-style]')].map(b => ({ id: b.dataset.style, on: b.getAttribute('aria-checked') === 'true', cls: b.classList.contains('on') }));
  return { th, sel, music, style, go: document.getElementById('edAutoGo').disabled, sum: document.getElementById('edAutoSum').textContent };
});
const checked = list => (list.find(x => x.on) || {}).id;
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }

// 透過對話框裡的按鈕（隱藏的 <input type=file>）選檔
async function chooseFiles(page, btn, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(btn)]);
  await fc.setFiles(files);
}
async function openDlg(page) {
  await page.click('#edSAuto');
  await page.waitForSelector('#edAuto');
  await settle(page);
}
async function generate(page) {
  await page.click('#edAutoGo');
  await page.waitForFunction(() => !document.getElementById('edAuto'), null, { timeout: 60000 });
  await settle(page);
}

async function fresh(browser, base, problems, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('qc-tips', 'done'); } catch (_) {}
    window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push(`[${tag}] pageerror: ` + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(`[${tag}] console.error: ` + m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.QPTEdit && window.QPTEdit.ui && window.QPTEdit.ui.state && window.QPTEdit.ui.state.project && document.getElementById('edUiMode'));
  await settle(page);
  return { ctx, page };
}
async function cspOf(page, problems, tag) {
  const v = await page.evaluate(() => window.__csp || []);
  for (const x of v) problems.push(`[${tag}] CSP: ${x}`);
}

// =====================================================================================
async function main() {
  const fix = fixturesDir();
  const F = k => path.join(fix, FILES[k]);
  const { server, base } = await serve();
  const browser = await chromium.launch({ executablePath: EXE });
  const problems = [];

  const A = await fresh(browser, base, problems, '主流程');
  const page = A.page;
  await page.click('#edStart [data-start="vertical"]'); await settle(page);
  eq(await proj(page, p => p.aspect), '9:16', '開始畫面選直式：專案 9:16');
  ok(!(await page.$('#edTip')), 'qc-tips＝done：不出現教學');

  // ---------------------------------------------------------------- 1. 入口＋空的媒體庫
  console.log('入口與空的媒體庫');
  ok(await page.isVisible('#edSimpleBar #edSAuto'), '簡易工具列有「一鍵成片」按鈕');
  ok((await page.textContent('#edSAuto')).includes('一鍵成片'), '按鈕文字：一鍵成片');
  ok(await page.evaluate(() => typeof window.QPTEdit.uiParts.openAuto === 'function'), 'UI.openAuto 存在');
  await openDlg(page);
  eq(await page.evaluate(() => { const d = document.getElementById('edAuto'); return [d.getAttribute('role'), d.getAttribute('aria-modal'), document.getElementById(d.getAttribute('aria-labelledby')).textContent]; }),
    ['dialog', 'true', '一鍵成片'], '對話框：role＝dialog、aria-modal、標題「一鍵成片」');
  let D = await dlgState(page);
  eq(D.th.length, 0, '媒體庫是空的：沒有素材縮圖');
  ok(D.go, '沒選素材：「產生影片」停用');
  ok(D.sum.includes('還沒選素材'), '摘要寫「還沒選素材」');
  eq(D.music.map(m => [m.id, m.on]), [['', true]], '沒有音樂：只有「不要音樂」且被選取');
  eq(checked(D.style), 'beat', '預設風格：節奏感');
  eq(D.style.map(s => s.id), ['beat', 'gentle', 'cinema'], '三種風格：節奏感／溫柔回憶／電影感');
  await shot(page, 'A1-empty');

  // ---------------------------------------------------------------- 2. 對話框裡加素材
  console.log('對話框裡加素材／音樂');
  await chooseFiles(page, '#edAutoAdd', [F('land'), F('port'), F('mute'), F('still')]);
  await page.waitForFunction(() => document.querySelectorAll('#edAutoMedia .ed-auto-th[data-media]').length === 4, null, { timeout: 90000 });
  await settle(page);
  let M = await mediaIds(page);
  const [land, port, mute, still] = [M[FILES.land], M[FILES.port], M[FILES.mute], M[FILES.still]];
  ok(land && port && mute && still, '四個素材都進了媒體庫');
  D = await dlgState(page);
  ok(D.th.every(t => t.on && t.pressed === 'true'), '加進來的素材自動選取（.on、aria-pressed）');
  eq(D.th.map(t => t.ord).sort(), ['1', '2', '3', '4'], '順序號碼 1～4');
  eq(D.sel.slice().sort(), [land, port, mute, still].sort(), '選取的就是剛加的四個');
  eq(await nClips(page), 0, '對話框裡加的素材「不」自動排到時間軸');
  eq(await page.evaluate(() => !!window.QPTEdit.ui.state.autoPicking), false, '匯入完 state.autoPicking 回到 false');
  ok(!D.go, '有素材：「產生影片」可以按');
  ok(D.sum.includes('4 段'), '摘要：4 段');
  ok(!(await page.$('#edAutoFile')), '暫時的檔案輸入框用完就移除');
  // 影片原聲可以當音樂，但目前「不要音樂」仍是選取
  eq(D.music.map(m => m.id), [land, port, ''], '有聲影片也列在音樂選項（沒聲音的、圖片不列）');
  eq(checked(D.music), '', '還沒加音樂：仍是「不要音樂」');

  await chooseFiles(page, '#edAutoAddMusic', [F('music')]);
  await page.waitForFunction(() => document.querySelectorAll('#edAutoMusic [data-music]').length === 4, null, { timeout: 60000 });
  await settle(page);
  M = await mediaIds(page);
  const music = M[FILES.music];
  D = await dlgState(page);
  eq(checked(D.music), music, '加音樂：新的音樂被選取（aria-checked）');
  ok(D.music.every(m => m.on === m.cls), '音樂選項 .on 與 aria-checked 一致');
  eq(D.music.map(m => m.id), [music, land, port, ''], '純音樂排在影片聲音前面、「不要音樂」最後');
  eq(D.th.length, 4, '加音樂不會出現在素材縮圖');
  eq(await nClips(page), 0, '加音樂也不自動排到時間軸');
  ok(D.sum.includes('跟著拍子'), '有音樂：摘要說跟著拍子換');
  ok(D.sum.includes('9:16'), '摘要寫輸出 9:16');
  await shot(page, 'A2-picked');

  // ---------------------------------------------------------------- 3. 點選切換順序
  console.log('點選切換順序');
  const order0 = D.sel.slice();
  const first = order0[0];
  await page.click(`#edAutoMedia [data-media="${first}"]`); await settle(page);
  D = await dlgState(page);
  const t1 = D.th.find(t => t.id === first);
  ok(!t1.on && t1.pressed === 'false' && t1.ord === '', '點一下：取消選取、沒有號碼');
  eq(D.sel, order0.slice(1), '其他素材的順序往前補');
  eq(D.th.filter(t => t.on).map(t => t.ord).sort(), ['1', '2', '3'], '號碼重新編成 1～3');
  ok(D.sum.includes('3 段'), '摘要：3 段');
  await page.click(`#edAutoMedia [data-media="${first}"]`); await settle(page);
  D = await dlgState(page);
  eq(D.sel, [...order0.slice(1), first], '再點一下：排到最後');
  eq(D.th.find(t => t.id === first).ord, '4', '號碼是 4');
  const chosen = D.sel.slice();
  // 全部取消 → 按鈕停用
  for (const id of chosen) await page.click(`#edAutoMedia [data-media="${id}"]`);
  await settle(page);
  D = await dlgState(page);
  ok(D.go && D.sum.includes('還沒選素材'), '全部取消：按鈕停用、摘要「還沒選素材」');
  for (const id of chosen) await page.click(`#edAutoMedia [data-media="${id}"]`);
  await settle(page);
  eq((await dlgState(page)).sel, chosen, '依序再點回來：順序照點的順序');

  // ---------------------------------------------------------------- 4. 風格／音樂選項
  console.log('風格與音樂選項');
  await page.click('#edAutoStyle [data-style="gentle"]'); await settle(page);
  D = await dlgState(page);
  eq(D.style.map(s => [s.id, s.on]), [['beat', false], ['gentle', true], ['cinema', false]], '點溫柔回憶：aria-checked 切過去');
  ok(D.style.every(s => s.on === s.cls), '風格 .on 與 aria-checked 一致');
  await page.click('#edAutoStyle [data-style="cinema"]'); await settle(page);
  eq(checked((await dlgState(page)).style), 'cinema', '點電影感');
  await page.click('#edAutoStyle [data-style="beat"]'); await settle(page);
  eq(checked((await dlgState(page)).style), 'beat', '點回節奏感');
  await page.click('#edAutoMusic [data-music=""]'); await settle(page);
  D = await dlgState(page);
  eq(D.music.filter(m => m.on).map(m => m.id), [''], '點「不要音樂」：只有它被選取');
  ok(D.sum.includes('每段約') && D.sum.includes('秒'), '不要音樂：摘要改說每段約幾秒');
  await page.click(`#edAutoMusic [data-music="${land}"]`); await settle(page);
  eq(checked((await dlgState(page)).music), land, '可以選影片的聲音當音樂');
  await page.click(`#edAutoMusic [data-music="${music}"]`); await settle(page);
  eq(checked((await dlgState(page)).music), music, '選回純音樂');
  eq((await dlgState(page)).sel, chosen, '換音樂／風格不影響素材選取');

  // ---------------------------------------------------------------- 5. 產生：音樂＋節奏感
  console.log('產生：音樂＋節奏感');
  await generate(page);
  ok(!(await page.$('#edAuto')), '產生後對話框關閉');
  let T = await byTrack(page);
  const fps = await proj(page, p => p.fps);
  const musicDur = await proj(page, (p, Q, id) => p.mediaInfo[id].duration, music);
  const vTracks = await proj(page, p => p.tracks.filter(t => t.kind === 'video').map(t => t.name));
  const aTracks = await proj(page, p => p.tracks.filter(t => t.kind === 'audio').map(t => t.name));
  const V1 = T[vTracks[0]], A1 = T[aTracks[0]], A2 = T[aTracks[1]];
  const nameOf = id => Object.keys(M).find(k => M[k] === id);
  eq(V1.map(c => c.name), chosen.map(nameOf), '影片軌：照選的順序排');
  ok(V1.every((c, i) => i === 0 ? c.s === 0 : c.s === V1[i - 1].s + V1[i - 1].d), '影片軌片段首尾相接、從 0 開始');
  ok(V1.every(c => c.d > 0), '每段長度 > 0');
  const end1 = V1[V1.length - 1].s + V1[V1.length - 1].d;
  eq(A1.length, 0, '有音樂：素材原聲不放到 A1');
  ok(A2 && A2.length === 1 && A2[0].name === FILES.music, '音樂放在第二條音訊軌');
  if (A2 && A2[0]) {
    eq(A2[0].s, 0, '音樂從 0 開始');
    eq(A2[0].d, Math.min(Math.floor(musicDur * fps + 1e-6), end1), `音樂長度＝影片結尾（音樂較短就到音樂結束）（${A2[0].d}）`);
    ok(A2[0].fadeOut > 0, `音樂最後淡出（fadeOut ${A2[0].fadeOut}）`);
  }
  eq(V1.map(c => [c.name, c.fit === 'blur']), V1.map(c => [c.name, c.name !== FILES.port]), '比例和 9:16 不同的自動模糊背景；直的不加');
  ok(V1.every(c => c.kf.includes('video.transform.zoomX') && c.kf.includes('video.transform.zoomY')), '每段都有縮放關鍵影格（放大縮小交替）');
  const zx = await proj(page, (p, Q, ids) => ids.map(id => p.clips[id].keyframes['video.transform.zoomX'].map(k => k.v)), V1.map(c => c.id));
  ok(zx.every((v, i) => v.length === 2 && (i % 2 === 0 ? v[0] < v[1] : v[0] > v[1])), `放大、縮小輪流 ${JSON.stringify(zx)}`);
  ok(V1.every(c => !c.look), '節奏感：不加濾鏡');
  let TR = await transitions(page);
  ok(TR.every(t => t.type === 'dipToColor' && String(t.color).toLowerCase() === '#ffffff'), `節奏感的轉場都是閃白（${TR.length} 個）`);
  ok(TR.every(t => V1.findIndex(c => c.id === t.left) % 2 === 1), '閃白每 2 個剪接點放一個（接在第 2、4…段後）');
  ok((await page.textContent('#edStatus')).includes('已產生'), `狀態列：${await page.textContent('#edStatus')}`);
  eq(await invariants(page), [], 'checkInvariants：沒有問題');
  eq(await page.evaluate(() => [...window.QPTEdit.ui.state.selection]), [], '產生後沒有選取');
  await shot(page, 'A3-beat');
  const snap1 = await snapshot(page);
  const n1 = await nClips(page), tr1 = await nTrans(page);

  await page.keyboard.press('Control+z'); await settle(page);
  eq([await nClips(page), await nTrans(page)], [0, 0], 'Ctrl+Z 一次：整批取消（片段 0、轉場 0）');
  await page.click('#edSRedo'); await settle(page);
  eq([await nClips(page), await nTrans(page)], [n1, tr1], '重做：整批回來');
  eq(await snapshot(page), snap1, '重做後專案和產生時一樣');
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await nClips(page), 0, '再復原：時間軸清空');

  // ---------------------------------------------------------------- 6. 不要音樂＋溫柔回憶
  console.log('產生：不要音樂＋溫柔回憶');
  await openDlg(page);
  D = await dlgState(page);
  eq(D.sel, await page.evaluate(() => window.QPTEdit.render.media.list().filter(m => m.kind === 'video' || m.kind === 'image').map(m => m.id)), '重新打開：全部素材依媒體庫順序選取');
  eq(checked(D.music), music, '重新打開：記得上次的音樂');
  eq(checked(D.style), 'beat', '重新打開：記得上次的風格');
  ok(!D.sum.includes('會接在'), '時間軸是空的：不提「接在後面」');
  const order2 = D.sel.slice();
  await page.click('#edAutoMusic [data-music=""]');
  await page.click('#edAutoStyle [data-style="gentle"]'); await settle(page);
  await generate(page);
  T = await byTrack(page);
  const V1b = T[vTracks[0]], A1b = T[aTracks[0]], A2b = T[aTracks[1]] || [];
  eq(V1b.map(c => c.name), order2.map(nameOf), '照順序排');
  ok(V1b.every((c, i) => i === 0 ? c.s === 0 : c.s === V1b[i - 1].s + V1b[i - 1].d), '首尾相接、從 0 開始');
  const segLen = Math.round(3 * fps);
  eq(V1b.filter(c => c.kind === 'image').map(c => c.d), [segLen], `照片每段固定 3 秒（${segLen} 格）`);
  ok(V1b.filter(c => c.kind === 'video').every(c => c.d <= segLen && c.d >= segLen - 3), '影片每段約 3 秒（素材不夠長就用整段）');
  ok(V1b.every(c => c.look === 'warm'), '溫柔回憶：濾鏡 warm');
  TR = await transitions(page);
  const cross = TR.filter(t => t.type === 'crossDissolve');
  eq(cross.map(t => t.left).sort(), V1b.slice(0, -1).map(c => c.id).sort(), '每個剪接點都有 crossDissolve');
  ok(TR.some(t => t.type === 'dipToColor' && t.right === V1b[0].id && !t.left), '開頭淡入（dipToColor 黑）');
  ok(TR.some(t => t.type === 'dipToColor' && t.left === V1b[V1b.length - 1].id && !t.right), '結尾淡出（dipToColor 黑）');
  const withAudio = V1b.filter(c => c.name === FILES.land || c.name === FILES.port);
  eq(A1b.map(c => [c.name, c.s, c.d]), withAudio.map(c => [c.name, c.s, c.d]), '不要音樂：有聲影片的原聲放 A1、和畫面對齊');
  eq(A2b.length, 0, '不要音樂：音樂軌是空的');
  eq(V1b.map(c => [c.name, c.fit === 'blur']), V1b.map(c => [c.name, c.name !== FILES.port]), '比例不同的自動模糊背景');
  ok(V1b.every(c => c.kf.length > 0), '每段都有動態關鍵影格');
  eq(await invariants(page), [], 'checkInvariants：沒有問題');
  await shot(page, 'A4-gentle');

  // ---------------------------------------------------------------- 7. 時間軸有東西：接在後面
  console.log('接在目前內容的後面');
  const end2 = await proj(page, p => Object.values(p.clips).reduce((m, c) => Math.max(m, c.start + c.duration), 0));
  const before7 = await proj(page, p => Object.keys(p.clips).sort());
  await openDlg(page);
  D = await dlgState(page);
  ok(D.sum.includes('會接在時間軸目前內容的後面'), '摘要提醒會接在後面');
  // 對話框開著：快捷鍵不能改到底下的時間軸
  await page.keyboard.press('Control+z'); await page.keyboard.press('Delete'); await settle(page);
  eq(await proj(page, p => Object.keys(p.clips).sort()), before7, '對話框開著按 Ctrl+Z／Delete：時間軸不變');
  ok(!!(await page.$('#edAuto')), '對話框還開著');
  // 取消選檔：暫時的輸入框不留下來
  await Promise.all([page.waitForEvent('filechooser'), page.click('#edAutoAdd')]);
  await page.evaluate(() => document.getElementById('edAutoFile').dispatchEvent(new Event('cancel')));
  ok(!(await page.$('#edAutoFile')), '取消選檔：暫時的檔案輸入框移除');
  // 已經選了音樂，再用「加音樂…」加一首：選剛加的那首
  const music2 = path.join(os.tmpdir(), 'qc-auto-music-2.webm');
  fs.copyFileSync(F('music'), music2);
  await chooseFiles(page, '#edAutoAddMusic', [music2]);
  await page.waitForFunction(() => [...document.querySelectorAll('#edAutoMusic [data-music] b')].some(b => b.textContent === 'qc-auto-music-2.webm'), null, { timeout: 60000 });
  await settle(page);
  D = await dlgState(page);
  const m2 = (await mediaIds(page))['qc-auto-music-2.webm'];
  eq(checked(D.music), m2, '加第二首音樂：選剛加的那首');
  for (const id of D.sel.filter(id => id !== still)) await page.click(`#edAutoMedia [data-media="${id}"]`);
  await page.click('#edAutoMusic [data-music=""]'); await settle(page);
  eq((await dlgState(page)).sel, [still], '只選照片');
  await generate(page);
  T = await byTrack(page);
  const added = T[vTracks[0]].filter(c => !before7.includes(c.id));
  eq(added.map(c => [c.name, c.s]), [[FILES.still, end2]], `新的一段從原本的結尾（${end2}）開始`);
  ok((await proj(page, (p, Q, ids) => ids.every(id => p.clips[id]), before7)), '原本的片段都還在');
  eq(await invariants(page), [], 'checkInvariants：沒有問題');
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await proj(page, p => Object.keys(p.clips).sort()), before7, 'Ctrl+Z：只取消這一批');

  // ---------------------------------------------------------------- 8. 關閉方式
  console.log('Esc／取消／點背景');
  const snap8 = await snapshot(page);
  await openDlg(page);
  await page.click(`#edAutoMedia [data-media="${land}"]`);
  await page.keyboard.press('Escape'); await settle(page);
  ok(!(await page.$('#edAuto')), 'Esc 關閉對話框');
  eq(await snapshot(page), snap8, 'Esc：專案沒變');
  await openDlg(page);
  await page.click('#edAuto .ed-auto-foot .ed-btn:not(.primary)'); await settle(page);
  ok(!(await page.$('#edAuto')), '「取消」關閉對話框');
  eq(await snapshot(page), snap8, '取消：專案沒變');
  await openDlg(page);
  await page.click('#edAuto .ed-auto-card h2'); await settle(page);
  ok(!!(await page.$('#edAuto')), '點卡片裡面不會關閉');
  await page.click('#edAuto', { position: { x: 5, y: 5 } }); await settle(page);
  ok(!(await page.$('#edAuto')), '點背景關閉對話框');
  eq(await snapshot(page), snap8, '點背景：專案沒變');
  // Esc 監聽已移除：之後的 Esc 不會出錯
  await page.keyboard.press('Escape'); await settle(page);
  // 關閉後一般匯入恢復自動排到時間軸
  const nBefore = await nClips(page);
  await page.setInputFiles('#edFile', [F('still')]);
  await page.waitForFunction(n => Object.keys(window.QPTEdit.ui.state.project.clips).length > n, nBefore, { timeout: 60000 });
  await settle(page);
  ok(await nClips(page) > nBefore, '對話框外的一般匯入：照常自動排到時間軸');

  // ---------------------------------------------------------------- 9. 專業模式
  console.log('專業模式');
  await page.click('#edUiMode [data-ui="pro"]'); await settle(page);
  ok(!(await page.isVisible('#edSAuto')), '專業模式：看不到簡易工具列的按鈕');
  ok(await page.evaluate(() => typeof window.QPTEdit.uiParts.openAuto === 'function'), '專業模式：UI.openAuto 仍可用');
  await page.evaluate(() => window.QPTEdit.uiParts.openAuto()); await settle(page);
  ok(await page.isVisible('#edAuto'), '專業模式呼叫 openAuto：對話框顯示');
  await page.keyboard.press('Escape'); await settle(page);
  ok(!(await page.$('#edAuto')), 'Esc 關閉');
  await page.click('#edUiMode [data-ui="simple"]'); await settle(page);
  ok(await page.isVisible('#edSAuto'), '切回簡易：按鈕又出現');
  await cspOf(page, problems, '主流程');
  await A.ctx.close();

  // ---------------------------------------------------------------- 10. 沒有錯誤
  eq(problems, [], '整個流程沒有 console error／頁面例外／CSP 違規');
  await browser.close();
  server.close();
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
