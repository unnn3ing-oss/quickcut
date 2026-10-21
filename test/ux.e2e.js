// =====================================================================================
// 介面可用性的瀏覽器流程測試：說明面板、窄視窗的「⋯」選單、確認框的焦點、點擊目標大小、矮螢幕版面。
//
// 執行：node test/ux.e2e.js
//   （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//   SHOTS=<資料夾>   截圖輸出位置（沒設就不存圖）
//   CHROMIUM=<路徑>  瀏覽器執行檔（沒設時用 /opt/pw-browsers/chromium，再沒有就用 playwright 預設）
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

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } return !!cond; }
function eq(a, b, msg) { const r = JSON.stringify(a) === JSON.stringify(b); if (!r) console.log('       期望', JSON.stringify(b), '實際', JSON.stringify(a)); return ok(r, msg); }

function fixture() {
  const dir = path.join(os.tmpdir(), 'qc-ui-fixtures'), f = path.join(dir, 'landscape-720p-6s.webm');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
      '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest', f], { stdio: 'inherit' });
  }
  return f;
}
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
    }).listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
const active = page => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName));
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }

async function main() {
  const { server, base } = await serve();
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.addInitScript(() => {
    window.__dl = []; const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push(this.download); return click.call(this); };
  });
  await page.goto(base);
  await settle(page);
  await page.setInputFiles('#edFile', [fixture()]);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 1, null, { timeout: 60000 });
  await page.click('.ed-mitem'); await page.click('#edAppend'); await settle(page);

  // ---------------------------------------------------------------- 說明面板
  console.log('說明面板');
  ok(await page.isVisible('#edHelpBtn'), '頁首有「說明」按鈕');
  await page.click('#edHelpBtn');
  ok(await page.evaluate(() => document.getElementById('edHelp').open), '按「說明」打開');
  const txt = await page.textContent('#edHelp');
  for (const w of ['基本流程', '快捷鍵', 'Shift', '加到結尾', '儲存專案', '自動暫存']) ok(txt.includes(w), `說明裡有「${w}」`);
  eq(await page.evaluate(() => [...document.querySelectorAll('#edHelp kbd')].filter(k => !k.textContent.trim()).length), 0, '沒有空白的按鍵框');
  eq(await active(page), 'edHelpClose', '焦點在「關閉」');
  await shot(page, 'U1-help');
  await page.keyboard.press('Escape');
  ok(!(await page.evaluate(() => document.getElementById('edHelp').open)), 'Esc 關閉');
  await page.keyboard.press('?');
  ok(await page.evaluate(() => document.getElementById('edHelp').open), '按 ? 也能打開');
  await page.click('#edHelpClose');
  await page.evaluate(() => { const i = document.createElement('input'); i.id = '__t'; document.body.appendChild(i); i.focus(); });
  await page.keyboard.press('?');
  ok(!(await page.evaluate(() => document.getElementById('edHelp').open)), '在輸入框裡打 ? 不會打開說明');
  await page.evaluate(() => document.getElementById('__t').remove());

  // ---------------------------------------------------------------- 確認框的焦點
  console.log('確認框的焦點');
  await page.focus('#edSaveBtn');
  await page.evaluate(() => { askConfirm({ title: '測試', message: '焦點測試' }); });
  eq(await active(page), 'confirmOkBtn', '打開時焦點在「確定」');
  const seq = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); seq.push(await active(page)); }
  eq(seq, ['confirmCancelBtn', 'confirmOkBtn', 'confirmCancelBtn', 'confirmOkBtn'], 'Tab 只在「取消」「確定」之間循環');
  await page.keyboard.press('Shift+Tab');
  eq(await active(page), 'confirmCancelBtn', 'Shift+Tab 也一樣');
  await page.keyboard.press('Escape');
  eq(await active(page), 'edSaveBtn', '關閉後焦點回到原本的按鈕');

  // ---------------------------------------------------------------- 點擊目標
  console.log('點擊目標（WCAG 2.5.8：至少 24×24）');
  await page.click('.ed-clip >> nth=0'); await settle(page);
  const small = await page.evaluate(() => [...document.querySelectorAll('button, select, input[type=range]')]
    .filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden')
    .map(e => { const r = e.getBoundingClientRect(); return { k: e.id || e.className, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => x.w < 24 || x.h < 24));
  eq(small, [], '看得到的按鈕、下拉選單、拉桿都至少 24×24');

  // ---------------------------------------------------------------- 矮螢幕
  console.log('矮螢幕版面');
  for (const [w, h] of [[1366, 768], [1280, 720], [1024, 700]]) {
    await page.setViewportSize({ width: w, height: h }); await settle(page);
    const m = await page.evaluate(() => { const tl = document.getElementById('edTimeline').getBoundingClientRect(); return { scroll: document.documentElement.scrollHeight - innerHeight, tlBottom: tl.bottom, tlH: tl.height, vh: innerHeight }; });
    ok(m.scroll <= 0 && m.tlBottom <= m.vh, `${w}×${h}：整頁不用捲動，時間軸完整在畫面內（高 ${Math.round(m.tlH)}px）`);
    ok(m.tlH >= 170, `${w}×${h}：時間軸至少 170px`);
    await shot(page, `U2-${w}x${h}`);
  }

  // ---------------------------------------------------------------- 窄視窗的「⋯」選單
  console.log('窄視窗的「⋯」選單');
  await page.setViewportSize({ width: 1440, height: 900 }); await settle(page);
  ok(!(await page.isVisible('#edMoreBtn')), '寬視窗：沒有「⋯」，按鈕都直接顯示');
  ok(await page.isVisible('#edSaveBtn') && await page.isVisible('#edHelpBtn'), '寬視窗：儲存專案、說明都在');
  await page.setViewportSize({ width: 900, height: 700 }); await settle(page);
  ok(await page.isVisible('#edMoreBtn') && await page.isVisible('#edExportBtn'), '窄視窗：顯示「匯出影片」和「⋯」');
  ok(!(await page.isVisible('#edSaveBtn')) && !(await page.isVisible('#edOpenBtn')) && !(await page.isVisible('#edThemeBtn')), '窄視窗：次要按鈕收起來');
  const head = await page.evaluate(() => document.querySelector('header.topbar').getBoundingClientRect().height);
  ok(head < 70, `窄視窗：頁首只有一行（高 ${Math.round(head)}px）`);
  await page.click('#edMoreBtn');
  eq(await page.getAttribute('#edMoreBtn', 'aria-expanded'), 'true', 'aria-expanded=true');
  eq(await page.evaluate(() => [...document.querySelectorAll('#edMoreMenu .ed-more-item')].map(b => b.textContent)), ['開啟專案', '儲存專案', '使用說明', '切換深色／淺色'], '選單內容');
  eq(await page.evaluate(() => document.activeElement.textContent), '開啟專案', '焦點在第一個項目');
  await page.keyboard.press('ArrowDown');
  eq(await page.evaluate(() => document.activeElement.textContent), '儲存專案', '↓ 移到下一個');
  await shot(page, 'U3-more');
  await page.keyboard.press('Enter');
  ok(await page.isHidden('#edMoreMenu'), '選了之後選單關閉');
  ok(/\.qcut$/.test(await page.evaluate(() => window.__dl[window.__dl.length - 1] || '')), '「儲存專案」有作用（下載 .qcut）');
  await page.click('#edMoreBtn');
  await page.keyboard.press('Escape');
  ok(await page.isHidden('#edMoreMenu'), 'Esc 關閉選單');
  eq(await active(page), 'edMoreBtn', '焦點回到「⋯」');
  const theme0 = await page.evaluate(() => document.documentElement.dataset.edTheme);
  await page.click('#edMoreBtn'); await page.click('.ed-more-item >> text=切換深色／淺色');
  ok(await page.evaluate(() => document.documentElement.dataset.edTheme) !== theme0, '「切換深色／淺色」有作用');
  await page.click('#edMoreBtn'); await page.click('.ed-more-item >> text=使用說明');
  ok(await page.evaluate(() => document.getElementById('edHelp').open), '「使用說明」有作用');
  await page.keyboard.press('Escape');

  eq(problems, [], '沒有 console error／頁面例外');
  await browser.close();
  server.close();
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
