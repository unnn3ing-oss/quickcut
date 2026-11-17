// =====================================================================================
// AI 剪輯（5.00）的瀏覽器流程測試：簡易／專業工具列的入口、素材清單與伽瑪選擇、S-Log3 要先選 LUT、
// 匯出素材摘要包（summary.json＋聯絡表 JPG：逐檔下載）、數據與格式說明、貼上腳本（錯的整份拒絕並列出原因；
// 對的照排：對拍、裁切、LUT、轉場、字幕）、整批一次復原。
//
// 執行：node test/edit-ai.e2e.js
//   EDIT_FIXTURES=<資料夾>   測試素材（同 edit-ui.e2e.js）；沒指定或缺檔就用 ffmpeg 產生到暫存資料夾
//   SHOTS=<資料夾>           截圖與匯出的聯絡表輸出位置（沒設就不存）
//   CHROMIUM=<路徑>          瀏覽器執行檔
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
const FILES = { land: 'landscape-720p-6s.webm', port: 'portrait-720x1280-4s.webm', mute: 'noaudio-25fps-3s.webm', music: 'music-8s.webm', still: 'still.png', beat: 'beat-120bpm-8s.webm' };

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
  if (!has(FILES.beat)) ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*60*t)*exp(-14*mod(t,0.5))':d=8:s=48000", '-ac', '2', '-c:a', 'libopus', out(FILES.beat)]);
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
const snapshot = page => page.evaluate(() => JSON.stringify(window.QPTEdit.ui.state.project));
const invariants = page => proj(page, (p, Q) => Q.core.checkInvariants(p));
const byTrack = page => proj(page, p => {
  const out = {};
  for (const t of p.tracks) out[t.name] = [];
  for (const c of Object.values(p.clips).sort((a, b) => a.start - b.start)) {
    const t = p.tracks.find(x => x.id === c.trackId), m = c.mediaId && p.mediaInfo[c.mediaId];
    out[t.name].push({ s: c.start, d: c.duration, name: m ? m.name : c.title ? c.title.text : c.name, fit: c.video ? c.video.fit : null, look: c.video ? c.video.look || null : null,
      lut: !!(c.video && c.video.lut), posX: c.video ? Math.round(c.video.transform.posX) : null, srcIn: c.srcIn });
  }
  return out;
});
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }

async function main() {
  const fix = fixturesDir();
  const F = k => path.join(fix, FILES[k]);
  const { server, base } = await serve();
  const browser = await chromium.launch({ executablePath: EXE });
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('qc-tips', 'done'); } catch (_) {}
    window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.QPTEdit && window.QPTEdit.ui && window.QPTEdit.ui.state && window.QPTEdit.ui.state.project && document.getElementById('edUiMode'));
  await page.click('#edStart [data-start="vertical"]'); await settle(page);

  // ---------------------------------------------------------------- 1. 入口
  console.log('入口與素材清單');
  ok(await page.isVisible('#edSimpleBar #edSAi'), '簡易工具列有「AI 剪輯」按鈕');
  await page.setInputFiles('#edFile', [F('land'), F('port'), F('mute'), F('still'), F('beat')]);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 5, null, { timeout: 90000 });
  await settle(page);
  await page.click('#edSAi'); await page.waitForSelector('#edAi'); await settle(page);
  eq(await page.evaluate(() => { const d = document.getElementById('edAi'); return [d.getAttribute('role'), d.getAttribute('aria-modal'), document.getElementById(d.getAttribute('aria-labelledby')).textContent]; }),
    ['dialog', 'true', 'AI 剪輯'], '對話框：role＝dialog、aria-modal、標題');
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#edAiMedia .ed-ai-row')].map(r => ({ code: r.querySelector('b').textContent, name: r.querySelector('.ed-ai-name').textContent, gamma: r.querySelector('select') ? r.querySelector('select').value : null })));
  eq(await rows(), [{ code: 'C01', name: FILES.land, gamma: 'std' }, { code: 'C02', name: FILES.port, gamma: 'std' }, { code: 'C03', name: FILES.mute, gamma: 'std' }, { code: 'C04', name: FILES.still, gamma: null }],
    '列出影片與照片、代號 C01～、影片可以選伽瑪（預設標準）、照片沒有');
  eq(await page.inputValue('#edAiMusic'), await page.evaluate(n => window.QPTEdit.render.media.list().find(m => m.name === n).id, FILES.beat), '配樂預設選媒體庫的音樂');
  ok(!(await page.$('#edAiLut')), '沒有 S-Log3 素材：不顯示 LUT 選項');

  // ---------------------------------------------------------------- 2. S-Log3 要先選 LUT
  console.log('S-Log3 與 LUT');
  await page.selectOption('#edAiMedia .ed-ai-row:nth-child(1) select', 'slog3'); await settle(page);
  ok(await page.isVisible('#edAiLut'), '有 S-Log3 素材：出現 LUT 選項');
  await page.evaluate(() => { window.QPTEdit.uiParts.aiNoPicker = true; });
  await page.click('#edAiExport'); await settle(page);
  ok((await page.evaluate(() => window.QPTEdit.uiParts.statusEl.textContent)).includes('LUT'), '還沒選 LUT：不匯出，提示要先選');
  await page.selectOption('#edAiLut', '__builtin'); await settle(page);

  // ---------------------------------------------------------------- 3. 匯出摘要包
  console.log('匯出素材摘要包');
  const before = await snapshot(page);
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.click('#edAiExport');
  await page.waitForFunction(() => (document.getElementById('edAiStatus') || {}).textContent.includes('已存到'), null, { timeout: 180000 });
  await settle(page);
  eq(downloads.map(d => d.suggestedFilename().replace(/^qc-pack-\d{6}-\d{4}-/, '')), ['summary.json', 'sheet-01.jpg'], '下載 summary.json＋一張聯絡表');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-ai-'));
  const saved = [];
  for (const d of downloads) { const f = path.join(SHOTS || tmp, 'pack-' + d.suggestedFilename().replace(/^qc-pack-\d{6}-\d{4}-/, '')); if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true }); await d.saveAs(f); saved.push(f); }
  const S = JSON.parse(fs.readFileSync(saved[0], 'utf8'));
  eq([S.qcSummary, S.project.aspect, S.sheets.interval, S.sheets.files], [1, '9:16', 1, ['sheet-01.jpg']], '摘要：版本、專案比例、聯絡表每秒一格');
  eq(S.media, { C01: FILES.land, C02: FILES.port, C03: FILES.mute, C04: FILES.still, M1: FILES.beat }, '素材對照表（代號 → 檔名）');
  ok(/qcScript/.test(S.forClaude) && /crossDissolve/.test(S.forClaude) && /fadeUp/.test(S.forClaude) && /reframe/.test(S.forClaude), '開頭附給 Claude 的格式說明（腳本格式、可用的轉場與字幕樣式）');
  const c1 = S.clips[0];
  eq([c1.code, c1.gamma, c1.gammaFrom, c1.width, c1.height, c1.series.step, c1.series.luma.length], ['C01', 'slog3', 'user', 1280, 720, 0.5, 12], 'C01：伽瑪、尺寸、每 0.5 秒一筆共 12 筆');
  ok(['over', 'under', 'sharp', 'panX', 'panY', 'shake', 'change'].every(k => c1.series[k].length === 12 && c1.series[k].every(Number.isFinite)), '每個數據都是 12 個數字');
  ok(c1.series.luma.every(v => v > 10 && v < 90) && Math.max(...c1.series.sharp) === 100, '亮度在合理範圍、清晰度最高＝100');
  ok(Array.isArray(c1.ranges), '有建議可用區間');
  eq([S.clips[3].kind, S.clips[3].series], ['image', undefined], '照片沒有數列');
  ok(S.music && S.music.code === 'M1' && Math.abs(S.music.bpm - 120) < 3 && S.music.beats.length >= 12 && S.music.energy.length === 16, `音樂：約 120 BPM（${S.music && S.music.bpm}）、拍點、每 0.5 秒的能量`);
  const jpg = fs.readFileSync(saved[1]);
  const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
  eq([jpg[0], jpg[1], jpg.readUInt16BE(sof + 7), jpg.readUInt16BE(sof + 5)], [0xff, 0xd8, 1568, 4 * 221], '聯絡表是 1568 寬的 JPG：6＋4＋3＋1＝14 格 → 4 列');
  ok(jpg.length > 30000, `聯絡表有內容（${Math.round(jpg.length / 1024)} KB）`);
  eq(await snapshot(page), before, '匯出不改專案（內建 LUT 只用來畫聯絡表）');
  eq(await page.evaluate(() => window.QPTEdit.uiParts.aiState.refs.C02 === window.QPTEdit.render.media.list()[1].id), true, '記住代號對應的素材');
  await shot(page, 'ai-1-exported');

  // ---------------------------------------------------------------- 4. 腳本：錯的整份拒絕
  console.log('貼上腳本');
  const script = {
    qcScript: 1, media: S.media, output: { aspect: '9:16' }, music: { ref: 'M1', in: 0, fadeOut: 1 }, grade: { look: 'warm', lookAmt: 30 }, fadeIn: 0.3,
    shots: [
      { ref: 'C01', in: 1, dur: { beats: 4 }, reframe: { x: 0.8 }, motion: 'zoomIn', note: '開場' },
      { ref: 'C02', in: 0.5, dur: { beats: 4 }, trans: { type: 'crossDissolve', sec: 0.4 } },
      { ref: 'C04', dur: { beats: 2 } },
      { ref: 'C03', in: 0, dur: { beats: 4 }, reframe: { from: 0.2, to: 0.8 } },
    ],
    titles: [{ text: '花蓮・清晨', atShot: 0, sec: 1.5, preset: 'fadeUp', y: 0.8 }],
  };
  const bad = JSON.parse(JSON.stringify(script)); bad.shots[1].trans.type = 'sparkle'; bad.shots[2].ref = 'C99';
  await page.fill('#edAiText', JSON.stringify(bad));
  await page.click('#edAiApply'); await settle(page);
  const errs = await page.$$eval('#edAiErrors li', l => l.map(x => x.textContent));
  ok(errs.length === 2 && /sparkle/.test(errs[0]) && /C99/.test(errs[1]), '錯的腳本：列出全部問題（不存在的轉場、找不到的素材）');
  eq(await snapshot(page), before, '錯的腳本：專案完全沒變');
  await page.fill('#edAiText', '這不是腳本'); await page.click('#edAiApply'); await settle(page);
  ok(/讀不出/.test(await page.textContent('#edAiErrors')), '不是 JSON：說讀不出來');

  // ---------------------------------------------------------------- 5. 腳本：照排
  await page.fill('#edAiText', '構想：先山後海，結尾收在腳架空景。\n\n```json\n' + JSON.stringify(script, null, 2) + '\n```\n\n要調整再跟我說。');
  await page.click('#edAiApply');
  await page.waitForFunction(() => !document.getElementById('edAi'), null, { timeout: 60000 });
  await settle(page);
  const T = await byTrack(page), fps = await proj(page, p => p.fps);
  const v1 = T[Object.keys(T).find(k => T[k].some(c => c.name === FILES.land))];
  eq(v1.map(c => c.name), [FILES.land, FILES.port, FILES.still, FILES.mute], '照腳本的順序排在影片軌');
  eq(v1.map(c => c.s), [0, 2 * fps, 4 * fps, 5 * fps], '切點對在拍子上（120 BPM：4 拍＝2 秒、2 拍＝1 秒）');
  eq([v1[0].fit, v1[0].lut, v1[0].look, v1[0].srcIn], ['fill', true, 'warm', 1], '第 1 段：裁切填滿、S-Log3 套 LUT、暖色、從 1 秒開始');
  ok(v1[0].posX < -500, `reframe x=0.8：畫面往左移（posX ${v1[0].posX}）`);
  eq([v1[1].fit, v1[1].lut], ['fit', false], '直拍素材比例相同：不裁切、不是 Log 不套 LUT');
  const all = Object.values(T).flat();
  ok(all.some(c => c.name === '花蓮・清晨' && c.s === 0 && c.d === Math.round(1.5 * fps)), '字幕放在第 1 段開頭 1.5 秒');
  ok(all.some(c => c.name === FILES.beat && c.s === 0 && c.d === 7 * fps), '音樂從頭放到影片結尾');
  eq(await proj(page, p => Object.values(p.transitions).map(t => t.type).sort()), ['crossDissolve', 'dipToColor'], '轉場：1→2 疊化＋開頭淡入');
  eq(await proj(page, p => Object.values(p.luts || {}).map(l => l.name)), ['S-Log3 → 709（內建近似）'], '內建 LUT 加進專案');
  eq(await invariants(page), [], '不變式成立');
  await page.evaluate(() => window.QPTEdit.uiParts.seekTimeline(15)); await settle(page);
  await shot(page, 'ai-2-applied');
  await page.keyboard.press('Control+z'); await settle(page);
  eq(await snapshot(page), before, '按一次復原：全部拿掉（含 LUT）');

  // ---------------------------------------------------------------- 6. 專業模式
  console.log('專業模式');
  await page.click('#edUiMode [data-ui="pro"]'); await settle(page);
  await page.click('#edAiBtn'); await settle(page);
  ok(await page.isVisible('#edAi'), '專業工具列的「AI 剪輯」開啟對話框');
  eq(await page.inputValue('#edAiMedia .ed-ai-row:nth-child(1) select'), 'slog3', '伽瑪選擇有記住');
  await page.keyboard.press('Escape'); await settle(page);
  ok(!(await page.$('#edAi')), 'Esc 關閉');

  const v = await page.evaluate(() => window.__csp || []);
  for (const x of v) problems.push('CSP: ' + x);
  eq(problems, [], '整個流程沒有 console error／頁面例外／CSP 違規');
  await browser.close();
  server.close();
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
