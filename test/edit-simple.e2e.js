// =====================================================================================
// 簡易模式（4.00）的瀏覽器流程測試：預設介面、開始畫面、三步教學、匯入自動排到時間軸、
// 快速調整（畫面／動態／轉場／速度／音量／濾鏡）、大按鈕工具列、簡易／專業切換、白話軌道名稱。
//
// 執行：node test/edit-simple.e2e.js
//   （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//   這支「不」用 e2e-pro.js：每個情境都從乾淨的 localStorage 開始，測的就是預設值。
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
const ls = (page, k) => page.evaluate(k => localStorage.getItem(k), k);
const uiMode = page => page.evaluate(() => document.getElementById('editApp').dataset.ui);
const pressed = page => page.evaluate(() => [...document.querySelectorAll('#edUiMode button')].map(b => [b.dataset.ui, b.getAttribute('aria-pressed')]));
// 各軌道上的片段（依 start 排序）：{ 軌道名: [{ id, s, d, media, kind, fit, link }] }
const byTrack = page => proj(page, p => {
  const out = {};
  for (const t of p.tracks) out[t.name] = [];
  for (const c of Object.values(p.clips).sort((a, b) => a.start - b.start)) {
    const t = p.tracks.find(x => x.id === c.trackId), m = c.mediaId && p.mediaInfo[c.mediaId];
    out[t.name].push({ id: c.id, s: c.start, d: c.duration, type: c.type, name: m ? m.name : c.name, fit: c.video ? c.video.fit : null, link: c.linkId || null });
  }
  return out;
});
// 快速調整：每個區段目前選中的 chip（data-k），以及 aria-checked 是否和 .on 一致
const quickState = page => page.evaluate(() => {
  const q = document.getElementById('edQuick'), out = { shown: !!q && !q.hidden, secs: {} , aria: true };
  if (!q) return out;
  for (const s of q.querySelectorAll('.ed-qsec')) {
    const on = [...s.querySelectorAll('.ed-qchip.on')].map(b => b.dataset.k);
    for (const b of s.querySelectorAll('.ed-qchip')) if ((b.getAttribute('aria-checked') === 'true') !== b.classList.contains('on')) out.aria = false;
    out.secs[s.id] = s.querySelector('.ed-qchip') ? (on[0] || null) : (s.querySelector('input[type=range]') || {}).value;
  }
  return out;
});
const chip = async (page, sec, k) => { await page.click(`#${sec} .ed-qchip[data-k="${k}"]`); await settle(page); };
const undoKey = async page => { await page.keyboard.press('Control+z'); await settle(page); };
const clip = (page, id) => proj(page, (p, Q, id) => p.clips[id] || null, id);
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }

// 每個情境一個新的 context（乾淨的 localStorage／IndexedDB）
async function fresh(browser, base, problems, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  const page = await ctx.newPage();
  watch(page, problems, tag);
  await open(page, base);
  return { ctx, page };
}
function watch(page, problems, tag) {
  page.on('pageerror', e => problems.push(`[${tag}] pageerror: ` + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(`[${tag}] console.error: ` + m.text()); });
}
async function open(page, base) {
  await page.goto(base);
  await page.waitForFunction(() => window.QPTEdit && window.QPTEdit.ui && window.QPTEdit.ui.state && window.QPTEdit.ui.state.project && document.getElementById('edUiMode'));
  await settle(page);
}
async function cspOf(page, problems, tag) {
  const v = await page.evaluate(() => window.__csp || []);
  for (const x of v) problems.push(`[${tag}] CSP: ${x}`);
}

// =====================================================================================
async function main() {
  const fix = fixturesDir();
  const { server, base } = await serve();
  const browser = await chromium.launch({ executablePath: EXE });
  const problems = [];

  // ---------------------------------------------------------------- 1. 預設＝簡易模式＋開始畫面
  console.log('預設介面');
  const A = await fresh(browser, base, problems, '主流程');
  let page = A.page;
  eq(await uiMode(page), 'simple', '沒選過：#editApp data-ui＝simple');
  ok(await page.isVisible('#edStart'), '空專案打開時顯示開始畫面');
  eq(await page.evaluate(() => [...document.querySelectorAll('#edStart [data-start]')].map(b => b.dataset.start)), ['vertical', 'landscape', 'pro'], '開始畫面三個選項：直式／橫式／自己來');
  eq(await page.evaluate(() => document.activeElement && document.activeElement.dataset.start), 'vertical', '焦點在「直式短影音」（推薦）');
  eq(await page.getAttribute('#edStart', 'role'), 'dialog', '開始畫面是 dialog');
  ok(await page.isVisible('#edSimpleBar'), '大按鈕工具列顯示');
  ok(!(await page.isVisible('#edToolbar')), '專業工具列隱藏');
  ok(await page.isVisible('#edUiMode'), '頁首有「簡易｜專業」切換');
  eq(await pressed(page), [['simple', 'true'], ['pro', 'false']], '切換鈕：簡易 aria-pressed＝true');
  eq(await page.evaluate(() => [...document.querySelectorAll('#edSimpleBar .ed-sbtn')].map(b => b.id)),
    ['edSAdd', 'edSCut', 'edSDel', 'edSUndo', 'edSRedo', 'edSText', 'edSMusic', 'edSBeat'], '大按鈕工具列的按鈕');
  eq(await ls(page, 'qc-ui'), null, '還沒切換過：不寫 qc-ui');
  eq(await proj(page, p => p.aspect), 'source', '專案一開始是「依素材」比例');
  await shot(page, 'S1-start');

  // ---------------------------------------------------------------- 2. 開始畫面：直式
  console.log('開始畫面：直式短影音');
  await page.click('#edStart [data-start="vertical"]'); await settle(page);
  ok(!(await page.$('#edStart')), '選了之後開始畫面移除');
  eq(await proj(page, p => [p.aspect, p.width, p.height]), ['9:16', 1080, 1920], '直式：專案 9:16、1080×1920');
  eq(await uiMode(page), 'simple', '仍是簡易模式');
  eq(await ls(page, 'qc-start-off'), null, '沒勾「下次不要再顯示」：不寫 qc-start-off');

  // ---------------------------------------------------------------- 3. 三步教學
  console.log('三步教學');
  ok(await page.isVisible('#edTip'), '選完開始畫面：出現教學泡泡');
  const tipTexts = [];
  for (let i = 0; i < 3; i++) {
    const t = await page.evaluate(() => { const e = document.getElementById('edTip'); return e ? { n: e.querySelector('.ed-tip-n').textContent, next: document.getElementById('edTipNext').textContent, focus: document.activeElement && document.activeElement.id } : null; });
    tipTexts.push(t);
    if (i === 0) await shot(page, 'S2-tip');
    await page.click('#edTipNext'); await settle(page);
  }
  eq(tipTexts.map(t => t && t.n), ['1', '2', '3'], '教學依序 1→2→3');
  ok(tipTexts[0] && tipTexts[0].next.includes('1／3') && tipTexts[2] && tipTexts[2].next === '開始剪輯', '按鈕文字：下一步（1／3）…最後一步「開始剪輯」');
  ok(tipTexts.every(t => t && t.focus === 'edTipNext'), '每一步焦點都在「下一步」');
  ok(!(await page.$('#edTip')), '三步走完：泡泡消失');
  eq(await ls(page, 'qc-tips'), 'done', '走完教學：qc-tips＝done');

  // ---------------------------------------------------------------- 4. 匯入：自動排到時間軸
  console.log('匯入素材自動排到時間軸');
  await page.setInputFiles('#edFile', [FILES.land, FILES.port, FILES.mute, FILES.still, FILES.music].map(f => path.join(fix, f)));
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 5 && Object.keys(window.QPTEdit.ui.state.project.clips).length >= 7, null, { timeout: 90000 });
  await settle(page);
  let T = await byTrack(page);
  eq(Object.keys(T), ['V1', 'V2', 'A1', 'A2'], '新專案本來就有 V1／V2／A1／A2，不會多加軌道');
  eq(T.V1.map(c => c.name), [FILES.land, FILES.port, FILES.mute, FILES.still], '影片／圖片依序排在 V1');
  ok(T.V1.every((c, i) => i === 0 ? c.s === 0 : c.s === T.V1[i - 1].s + T.V1[i - 1].d), 'V1 片段首尾相接、從 0 開始');
  eq(T.A1.map(c => c.name), [FILES.land, FILES.port], '有聲音的影片：聲音放 A1');
  eq(T.A1.map(c => c.s), T.V1.slice(0, 2).map(c => c.s), 'A1 的聲音和畫面對齊');
  eq(T.A2.map(c => [c.name, c.s]), [[FILES.music, 0]], '純音訊放到 A2（音樂軌）從 0 開始');
  eq(T.V1.map(c => c.fit), ['blur', 'fit', 'blur', 'blur'], '比例和 9:16 不同的（橫的影片、圖片）自動模糊背景；直的不變');
  const land = T.V1[0], port = T.V1[1], mute = T.V1[2], still = T.V1[3], music = T.A2[0], landA = T.A1[0];
  const selNow = () => page.evaluate(() => [...window.QPTEdit.ui.state.selection].sort());
  eq(await selNow(), [land.id, landA.id].sort(), '第一個新片段（含連結的聲音）被選取');
  ok((await page.textContent('#edStatus')).includes('模糊背景'), '狀態列說明加了模糊背景');

  // ---------------------------------------------------------------- 白話軌道名稱
  const thNames = () => page.evaluate(() => [...document.querySelectorAll('.ed-th')].map(h => {
    const p = window.QPTEdit.ui.state.project, t = p.tracks.find(x => x.id === h.dataset.track);
    return [t && t.name, h.querySelector('.ed-th-name').textContent];
  }));
  eq((await thNames()).sort(), [['A1', '原聲'], ['A2', '音樂'], ['V1', '影片'], ['V2', '畫中畫']], '簡易模式軌道名稱：V1 影片、V2 畫中畫、A1 原聲、A2 音樂');
  eq(await proj(page, p => p.tracks.map(t => t.name)), ['V1', 'V2', 'A1', 'A2'], '只改顯示：專案裡的軌道名稱不變');

  // ---------------------------------------------------------------- 5. 快速調整
  console.log('快速調整');
  let q = await quickState(page);
  ok(q.shown, '選取影片片段：顯示快速調整');
  ok(await page.evaluate(() => document.querySelector('.ed-insp-body').hidden), '詳細內容的一般區段藏起來');
  eq(Object.keys(q.secs), ['edQFit', 'edQMotion', 'edQTrans', 'edQSpeed', 'edQVol', 'edQLook'], '影片片段：畫面／動態／轉場／速度／音量／濾鏡');
  eq(q.secs, { edQFit: 'blur', edQMotion: 'none', edQTrans: 'none', edQSpeed: 'normal', edQVol: '100', edQLook: 'none' }, '目前值：模糊背景、不動、直接切、正常、100%、原色');
  ok(q.aria, '.on 與 aria-checked 一致');
  ok((await page.textContent('#edInspHead')).startsWith('快速調整'), '標題是「快速調整」');
  eq(await page.evaluate(() => [...document.querySelectorAll('#edQuick .ed-qsec')].map(s => [s.id, [...s.querySelectorAll('.ed-qchip')].map(b => b.dataset.k)]).filter(x => x[1].length)),
    [['edQFit', ['blur', 'fill', 'fit']], ['edQMotion', ['none', 'zoomIn', 'zoomOut', 'panLeft', 'panRight']], ['edQTrans', ['none', 'crossDissolve', 'push', 'flash', 'zoom']],
      ['edQSpeed', ['normal', 'slow', 'bullet', 'fast']], ['edQLook', ['none', 'warm', 'cool', 'mono']]], '各區段的選項');
  await shot(page, 'S3-quick');

  // 畫面
  await chip(page, 'edQFit', 'fill');
  eq((await clip(page, land.id)).video.fit, 'fill', '畫面：填滿畫面 → fit＝fill');
  q = await quickState(page); eq(q.secs.edQFit, 'fill', 'chip 跟著變成「填滿畫面」'); ok(q.aria, 'aria-checked 也更新');
  await undoKey(page);
  eq((await clip(page, land.id)).video.fit, 'blur', 'Ctrl+Z：回到模糊背景');
  eq((await quickState(page)).secs.edQFit, 'blur', 'Ctrl+Z 後 chip 也回來');

  // 動態
  const kf = async () => { const c = await clip(page, land.id), k = c.keyframes || {}; const v = x => (k[x] || []).map(f => f.v); return { zx: v('video.transform.zoomX'), px: v('video.transform.posX') }; };
  await chip(page, 'edQMotion', 'zoomIn');
  let K = await kf();
  ok(K.zx.length === 2 && K.zx[0] < K.zx[1], `動態：慢慢放大 → zoomX 關鍵影格由小到大 ${JSON.stringify(K.zx)}`);
  eq((await quickState(page)).secs.edQMotion, 'zoomIn', 'chip：慢慢放大');
  await chip(page, 'edQMotion', 'panLeft');
  K = await kf();
  ok(K.px.length === 2 && K.px[0] > K.px[1], `換成向左平移 → posX 由大到小 ${JSON.stringify(K.px)}`);
  eq((await quickState(page)).secs.edQMotion, 'panLeft', 'chip：向左平移');
  await chip(page, 'edQMotion', 'none');
  K = await kf();
  ok(K.zx.length === 0 && K.px.length === 0, '不動 → 清掉縮放／平移關鍵影格');
  eq((await clip(page, land.id)).video.transform.zoomX, 1, '不動 → zoomX 回到 1');
  await undoKey(page);
  eq((await quickState(page)).secs.edQMotion, 'panLeft', 'Ctrl+Z：回到向左平移（一次一筆）');
  await undoKey(page); await undoKey(page);
  K = await kf();
  ok(K.zx.length === 0 && K.px.length === 0, '再復原兩次：回到沒有動態');

  // 轉場（接下一段）
  const transOf = () => proj(page, (p, Q, id) => Object.values(p.transitions).filter(t => t.leftClipId === id).map(t => ({ type: t.type, color: t.color || null, right: t.rightClipId || null })), land.id);
  await chip(page, 'edQTrans', 'crossDissolve');
  let tr = await transOf();
  eq(tr.map(t => t.type), ['crossDissolve'], '轉場：淡化 → 和下一段之間加 crossDissolve');
  eq((await quickState(page)).secs.edQTrans, 'crossDissolve', 'chip：淡化');
  await chip(page, 'edQTrans', 'flash');
  tr = await transOf();
  eq(tr.map(t => [t.type, String(t.color).toLowerCase()]), [['dipToColor', '#ffffff']], '換成閃白 → dipToColor #ffffff（只留一個轉場）');
  eq((await quickState(page)).secs.edQTrans, 'flash', 'chip：閃白');
  await chip(page, 'edQTrans', 'none');
  eq(await transOf(), [], '直接切 → 移除轉場');
  await undoKey(page);
  eq((await transOf()).map(t => t.type), ['dipToColor'], 'Ctrl+Z：閃白回來');
  await undoKey(page); await undoKey(page);
  eq(await transOf(), [], '再復原兩次：沒有轉場');

  // 速度
  const sp = async () => { const c = await clip(page, land.id), a = await clip(page, landA.id); return { s: c.speed, d: c.duration, rt: c.retime ? c.retime.preset : null, as: a.speed, ad: a.duration, next: (await clip(page, port.id)).start }; };
  const sp0 = await sp();
  await chip(page, 'edQSpeed', 'slow');
  let S = await sp();
  ok(S.s === 0.5 && S.d === sp0.d * 2, `慢動作 → speed 0.5、長度加倍（${sp0.d}→${S.d}）`);
  ok(S.as === 0.5 && S.ad === S.d, '連結的聲音一起變速');
  eq(S.next, S.d, '後面的片段自動往後推（波紋）');
  eq((await quickState(page)).secs.edQSpeed, 'slow', 'chip：慢動作');
  await chip(page, 'edQSpeed', 'fast');
  S = await sp();
  ok(S.s === 2 && S.d === sp0.d / 2, `快轉 2× → speed 2、長度減半（${S.d}）`);
  await chip(page, 'edQSpeed', 'bullet');
  S = await sp();
  eq(S.rt, 'bullet', '子彈時間 → retime preset＝bullet');
  eq((await quickState(page)).secs.edQSpeed, 'bullet', 'chip：子彈時間');
  await chip(page, 'edQSpeed', 'normal');
  S = await sp();
  ok(S.s === 1 && S.rt === null && S.d === sp0.d, `正常 → 速度 1、清掉 retime、長度回原本（${sp0.d}→${S.d}）`);
  await undoKey(page);
  eq((await sp()).rt, 'bullet', 'Ctrl+Z：回到子彈時間');
  for (let i = 0; i < 3; i++) await undoKey(page);
  eq(await sp(), sp0, '復原到底：速度、長度、後面片段位置都回到原本');

  // 音量
  await page.evaluate(() => { const r = document.getElementById('edQVolR'); r.value = '50'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(page);
  const g = (await clip(page, landA.id)).audio.gainDb;
  ok(Math.abs(g - 20 * Math.log10(0.5)) < 0.01, `音量 50% → 連結聲音的 gainDb ≈ -6.02（${g}）`);
  eq((await quickState(page)).secs.edQVol, '50', '拉桿顯示 50');
  ok((await page.textContent('#edQVol')).includes('50%'), '標籤顯示 50%');
  await page.evaluate(() => { const r = document.getElementById('edQVolR'); r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(page);
  eq((await clip(page, landA.id)).audio.gainDb, -60, '音量 0 → -60 dB（靜音）');
  ok((await page.textContent('#edQVol')).includes('靜音'), '標籤顯示「靜音」');
  await page.click('#edSUndo'); await settle(page);
  ok(Math.abs((await clip(page, landA.id)).audio.gainDb - 20 * Math.log10(0.5)) < 0.01, '按「復原」：回到 50%');
  await page.click('#edSUndo'); await settle(page);
  eq((await clip(page, landA.id)).audio.gainDb, 0, '再按「復原」：回到 0 dB');

  // 濾鏡
  await chip(page, 'edQLook', 'mono');
  eq((await clip(page, land.id)).video.look, 'mono', '濾鏡：黑白 → video.look＝mono');
  eq((await quickState(page)).secs.edQLook, 'mono', 'chip：黑白');
  await chip(page, 'edQLook', 'warm');
  eq((await clip(page, land.id)).video.look, 'warm', '濾鏡：暖陽 → warm');
  await page.click('#edSUndo'); await settle(page);
  eq((await clip(page, land.id)).video.look, 'mono', '按「復原」：回到黑白');
  await page.click('#edSRedo'); await settle(page);
  eq((await clip(page, land.id)).video.look, 'warm', '按「重做」：又是暖陽');
  await page.click('#edSUndo'); await page.click('#edSUndo'); await settle(page);
  ok(['none', undefined, null].includes((await clip(page, land.id)).video.look), '復原兩次：回到原色');
  eq((await quickState(page)).secs.edQLook, 'none', 'chip：原色');

  // 其他種類的片段
  await page.click(`.ed-clip[data-clip="${still.id}"]`); await settle(page);
  q = await quickState(page);
  eq(Object.keys(q.secs), ['edQFit', 'edQMotion', 'edQTrans', 'edQLook'], '圖片：沒有速度、音量');
  await page.click(`.ed-clip[data-clip="${mute.id}"]`); await settle(page);
  eq(Object.keys((await quickState(page)).secs), ['edQFit', 'edQMotion', 'edQTrans', 'edQSpeed', 'edQLook'], '沒聲音的影片：沒有音量');
  await page.click(`.ed-clip[data-clip="${music.id}"]`); await settle(page);
  eq(Object.keys((await quickState(page)).secs), ['edQSpeed', 'edQVol'], '音樂：只有速度、音量');
  ok((await page.textContent('#edQVol')).includes('音量') && !(await page.textContent('#edQVol')).includes('原聲'), '音樂片段的標籤是「音量」');
  // 多選
  await page.evaluate(ids => window.QPTEdit.ui.selectClips(ids), [land.id, port.id]); await settle(page);
  ok((await page.textContent('#edInspHead')).includes('2 個片段'), '多選：標題顯示 2 個片段');
  await chip(page, 'edQLook', 'cool');
  eq([(await clip(page, land.id)).video.look, (await clip(page, port.id)).video.look], ['cool', 'cool'], '多選：濾鏡一起套用');
  await undoKey(page);
  ok([land.id, port.id].every(Boolean) && !['cool'].includes((await clip(page, land.id)).video.look) && (await clip(page, port.id)).video.look !== 'cool', '多選套用只要復原一次');

  // ---------------------------------------------------------------- 6. 大按鈕工具列
  console.log('大按鈕工具列');
  const nClips = () => proj(page, p => Object.keys(p.clips).length);
  const n0 = await nClips();
  await page.evaluate(([id, f]) => { window.QPTEdit.ui.selectClips([id]); window.QPTEdit.ui.seekTimeline(f); }, [port.id, port.s + 30]); await settle(page);
  await page.click('#edSCut'); await settle(page);
  T = await byTrack(page);
  eq(T.V1.length, 5, '分割：V1 從 4 段變 5 段');
  eq(T.A1.length, 3, '分割：連結的聲音一起切');
  ok(T.V1.some(c => c.s === port.s + 30), '切點在播放頭');
  await page.click('#edSUndo'); await settle(page);
  eq(await nClips(), n0, '復原：分割取消');
  await page.click('#edSRedo'); await settle(page);
  eq(await nClips(), n0 + 2, '重做：又切開');
  await page.click('#edSUndo'); await settle(page);
  await page.click(`.ed-clip[data-clip="${mute.id}"]`); await settle(page);
  await page.click('#edSDel'); await settle(page);
  T = await byTrack(page);
  ok(!T.V1.some(c => c.id === mute.id), '刪除：選取的片段不見了');
  eq(T.V1.find(c => c.id === still.id).s, mute.s, '刪除是波紋刪除：後面的往前補');
  eq(await selNow(), [], '刪除後沒有選取');
  await page.click('#edSUndo'); await settle(page);
  eq((await byTrack(page)).V1.map(c => c.id), [land.id, port.id, mute.id, still.id], '復原：刪掉的片段回來');
  await page.evaluate(() => window.QPTEdit.ui.seekTimeline(15)); await settle(page);
  await page.click('#edSText'); await settle(page);
  const titles = await proj(page, p => Object.values(p.clips).filter(c => c.type === 'title').map(c => ({ id: c.id, s: c.start, t: p.tracks.find(t => t.id === c.trackId).name })));
  eq(titles.map(t => [t.s, t.t]), [[15, 'V2']], '加字幕：在播放頭加一段字幕（V1 有東西 → 新增 V2）');
  eq(await selNow(), titles.map(t => t.id), '新字幕被選取');
  ok(!(await quickState(page)).shown && !(await page.evaluate(() => document.querySelector('.ed-insp-body').hidden)), '選到字幕：不顯示快速調整，改顯示詳細內容');
  ok((await thNames()).some(([n, l]) => n === 'V2' && l === '畫中畫'), '簡易模式 V2 顯示「畫中畫」');
  await page.click('#edSUndo'); await settle(page);
  eq(await proj(page, p => Object.values(p.clips).filter(c => c.type === 'title').length), 0, '復原：字幕移除');
  await shot(page, 'S4-simple-bar');

  // ---------------------------------------------------------------- 7. 簡易／專業切換
  console.log('簡易／專業切換');
  const before = await page.evaluate(() => JSON.stringify(window.QPTEdit.ui.state.project));
  await page.click(`.ed-clip[data-clip="${land.id}"]`); await settle(page);
  await page.click('#edUiMode [data-ui="pro"]'); await settle(page);
  eq(await uiMode(page), 'pro', '按「專業」：data-ui＝pro');
  eq(await pressed(page), [['simple', 'false'], ['pro', 'true']], '切換鈕的 aria-pressed 更新');
  ok(await page.isVisible('#edToolbar'), '專業：顯示專業工具列');
  ok(!(await page.isVisible('#edSimpleBar')), '專業：大按鈕工具列隱藏');
  ok(!(await quickState(page)).shown && !(await page.evaluate(() => document.querySelector('.ed-insp-body').hidden)), '專業：選到影片片段顯示詳細內容，不是快速調整');
  ok(!(await page.textContent('#edInspHead')).startsWith('快速調整'), '專業：標題不是「快速調整」');
  eq(await ls(page, 'qc-ui'), 'pro', '記住在 localStorage qc-ui＝pro');
  eq((await thNames()).sort(), [['A1', 'A1'], ['A2', 'A2'], ['V1', 'V1'], ['V2', 'V2']], '專業：軌道名稱顯示原本的 V1／V2／A1／A2');
  eq(await page.evaluate(() => JSON.stringify(window.QPTEdit.ui.state.project)), before, '切換模式不改專案內容');
  await shot(page, 'S5-pro');
  await page.click('#edUiMode [data-ui="simple"]'); await settle(page);
  eq(await uiMode(page), 'simple', '切回簡易');
  eq(await ls(page, 'qc-ui'), 'simple', 'qc-ui＝simple');
  ok((await quickState(page)).shown, '切回簡易：選取中的影片片段又顯示快速調整');
  eq((await thNames()).sort(), [['A1', '原聲'], ['A2', '音樂'], ['V1', '影片'], ['V2', '畫中畫']], '切回簡易：白話軌道名稱');
  // 快速調整裡的「切到專業模式」連結
  await page.click('#edQuick .ed-qpro .ed-linkbtn'); await settle(page);
  eq(await uiMode(page), 'pro', '快速調整的「切到專業模式」有作用');
  await page.click('#edUiMode [data-ui="simple"]'); await settle(page);
  await cspOf(page, problems, '主流程');
  await A.ctx.close();

  // ---------------------------------------------------------------- 開始畫面：橫式＋略過教學
  console.log('開始畫面：橫式影片、略過教學');
  const B = await fresh(browser, base, problems, '橫式');
  page = B.page;
  await page.click('#edStart [data-start="landscape"]'); await settle(page);
  eq(await proj(page, p => [p.aspect, p.width, p.height]), ['16:9', 1920, 1080], '橫式：專案 16:9、1920×1080');
  ok(!(await page.$('#edStart')), '開始畫面移除');
  ok(await page.isVisible('#edTip'), '出現教學');
  await page.click('#edTip .ed-linkbtn'); await settle(page);
  ok(!(await page.$('#edTip')), '「略過教學」：泡泡消失');
  eq(await ls(page, 'qc-tips'), 'done', '略過也會寫 qc-tips＝done');
  await open(page, base);
  ok(await page.isVisible('#edStart'), '重新整理：空專案仍顯示開始畫面');
  await page.click('#edStart [data-start="landscape"]'); await settle(page);
  ok(!(await page.$('#edTip')), '重新整理後再選：不再出現教學');
  await cspOf(page, problems, '橫式');
  await B.ctx.close();

  // ---------------------------------------------------------------- 開始畫面：自己來＋下次不要再顯示
  console.log('開始畫面：自己來、下次不要再顯示');
  const C = await fresh(browser, base, problems, '自己來');
  page = C.page;
  await page.check('#edStartOff');
  await page.click('#edStart [data-start="pro"]'); await settle(page);
  eq(await uiMode(page), 'pro', '自己來：切到專業模式');
  eq(await proj(page, p => p.aspect), 'source', '自己來：比例依素材');
  ok(!(await page.$('#edTip')), '專業模式不顯示教學');
  eq(await ls(page, 'qc-start-off'), '1', '勾了「下次不要再顯示」：qc-start-off＝1');
  eq(await ls(page, 'qc-ui'), 'pro', 'qc-ui＝pro');
  await open(page, base);
  ok(!(await page.$('#edStart')), '重新整理：不再顯示開始畫面');
  eq(await uiMode(page), 'pro', '重新整理：維持專業模式');
  ok(await page.isVisible('#edToolbar') && !(await page.isVisible('#edSimpleBar')), '重新整理：專業工具列');
  await cspOf(page, problems, '自己來');
  await C.ctx.close();

  // ---------------------------------------------------------------- 開始畫面：Esc
  console.log('開始畫面：Esc');
  const D = await fresh(browser, base, problems, 'Esc');
  page = D.page;
  await page.keyboard.press('Escape'); await settle(page);
  ok(!(await page.$('#edStart')), 'Esc 關閉開始畫面');
  eq(await proj(page, p => p.aspect), '9:16', 'Esc＝直式短影音（9:16）');
  eq(await uiMode(page), 'simple', 'Esc 後是簡易模式');
  ok(await page.isVisible('#edTip'), 'Esc 後也出現教學');
  eq(await proj(page, p => Object.keys(p.clips).length), 0, 'Esc 不會動到其他東西');
  // 沒有第二條音訊軌時：音樂會自動新增一條
  await page.evaluate(() => { const Q = window.QPTEdit, a2 = Q.core.tracksOf(Q.ui.state.project, 'audio')[1]; Q.uiParts.op('刪除軌道', p => Q.core.removeTrack(p, a2.id)); });
  await settle(page);
  eq(await proj(page, p => p.tracks.map(t => t.name)), ['V1', 'V2', 'A1'], '（先刪掉 A2）');
  if (await page.$('#edTip')) { await page.click('#edTip .ed-linkbtn'); await settle(page); }
  await page.setInputFiles('#edFile', [path.join(fix, FILES.music)]);
  await page.waitForFunction(() => Object.keys(window.QPTEdit.ui.state.project.clips).length === 1, null, { timeout: 60000 });
  await settle(page);
  const T2 = await byTrack(page);
  eq(Object.keys(T2).length, 4, '匯入音樂：自動新增第二條音訊軌');
  const at2 = await proj(page, p => p.tracks.filter(t => t.kind === 'audio').map(t => t.id));
  eq(await proj(page, p => Object.values(p.clips).map(c => c.trackId)), [at2[1]], '音樂放在新的第二條音訊軌，不放 A1');
  eq(await page.evaluate(() => [...document.querySelectorAll('.ed-th.audio .ed-th-name')].map(e => e.textContent)), ['原聲', '音樂'], '新軌道也顯示「音樂」');
  eq(await page.evaluate(() => [...window.QPTEdit.ui.state.selection]), await proj(page, p => Object.keys(p.clips)), '新的音樂片段被選取');
  eq(Object.keys((await quickState(page)).secs), ['edQSpeed', 'edQVol'], '音樂片段的快速調整：速度、音量');
  await cspOf(page, problems, 'Esc');
  await D.ctx.close();

  // ---------------------------------------------------------------- 8. 沒有錯誤
  eq(problems, [], '整個流程沒有 console error／頁面例外／CSP 違規');
  await browser.close();
  server.close();
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
