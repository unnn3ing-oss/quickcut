// 剪輯匯出在真的 Chromium 裡的流程測試：載入 index.html，把 render.compose／seekSource／renderAudio、core.projectDuration
// 換成替身（compose 畫出帶影格編號的色塊、renderAudio 回傳 440Hz 正弦），透過匯出對話框匯出，再用 ffprobe／ffmpeg 檢查檔案。
// 沙盒的 Chromium 沒有 H.264／AAC 編碼器，所以這裡走 VP9（或 AV1）＋Opus；H.264＋AAC 的封裝由 test/edit-mp4.test.js 用 ffmpeg 交叉驗證。
// 需要 playwright 與 ffmpeg：NODE_PATH=<有 playwright 的 node_modules> node --test test/edit-export.e2e.js
// 匯出的檔案預設放在暫存資料夾、測完刪掉；設 ED_EXPORT_OUT=<資料夾> 會保留檔案和截圖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const hasFF = ['ffmpeg', 'ffprobe'].every(c => spawnSync(c, ['-version']).status === 0);
const skip = !chromium ? '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）' : !hasFF ? '沒有 ffmpeg／ffprobe' : false;

const ROOT = path.join(__dirname, '..');
const KEEP = process.env.ED_EXPORT_OUT;
let OUT, browser, server, BASE;

// WebCodecs 需要安全環境：用 localhost 開一個最小的靜態伺服器
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
function serve() {
  return new Promise(res => {
    server = http.createServer((req, rsp) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rsp);
    }).listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${server.address().port}/`; res(); });
  });
}

test.before(async () => {
  if (skip) return;
  OUT = KEEP ? path.resolve(KEEP) : fs.mkdtempSync(path.join(os.tmpdir(), 'ed-export-'));
  fs.mkdirSync(OUT, { recursive: true });
  await serve();
  browser = await chromium.launch();
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (OUT && !KEEP) fs.rmSync(OUT, { recursive: true, force: true });
});

// ---- 替身 -------------------------------------------------------------------------------
function installStubs() {
  const Q = window.QPTEdit = window.QPTEdit || {};
  const T = window.__t = { sourceFrames: [], audioCalls: [], failAt: -1, closed: { video: 0, audio: 0 }, composeCalls: 0, released: 0 };
  for (const [E, k] of [[VideoEncoder, 'video'], [AudioEncoder, 'audio']]) {
    const oc = E.prototype.close;
    E.prototype.close = function () { T.closed[k]++; return oc.call(this); };
  }
  // 每一格：底色由影格編號決定（R = 7f mod 256、G = 3f mod 256、B = 128），左上角畫來源畫格，中間寫影格編號
  const compose = (ctx, p, frame, getSource) => {
    T.composeCalls++;
    if (frame === T.failAt) throw new Error('替身 compose 故意失敗');
    const W = p.width, H = p.height;
    ctx.fillStyle = `rgb(${(frame * 7) % 256}, ${(frame * 3) % 256}, 128)`;
    ctx.fillRect(0, 0, W, H);
    const clip = Object.values(p.clips)[0];
    const src = clip && getSource(clip, frame / p.fps);
    if (src) ctx.drawImage(src, 0, 0, Math.round(W / 4), Math.round(H / 4));
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(Math.min(W, H) / 5)}px sans-serif`;
    ctx.fillText(String(frame), W * 0.3, H * 0.55);
  };
  const seekSource = async (mediaId, t) => {
    await new Promise(r => setTimeout(r, 0));
    const c = new OffscreenCanvas(64, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#ff0'; g.fillRect(0, 0, 64, 64);
    const f = new VideoFrame(c, { timestamp: Math.round(t * 1e6) });
    T.sourceFrames.push(f);
    return f;
  };
  const renderAudio = async (p, { sampleRate, channels, from, to }) => {
    T.audioCalls.push({ sampleRate, channels, from, to });
    const len = Math.round((to - from) / p.fps * sampleRate);
    const buf = new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate });
    for (let c = 0; c < channels; c++) {
      const d = buf.getChannelData(c);
      // 時間軸前 0.5 秒靜音，之後 440Hz：用來檢查聲音起點有沒有和畫面對齊
      for (let i = 0; i < len; i++) {
        const n = i + from / p.fps * sampleRate;
        d[i] = n < sampleRate / 2 ? 0 : 0.5 * Math.sin(2 * Math.PI * 440 * n / sampleRate);
      }
    }
    return buf;
  };
  Q.render = { compose, seekSource, renderAudio, releaseSeekers: () => { T.released++; } };
  Q.core = Object.assign({}, Q.core, { projectDuration: p => Math.max(0, ...Object.values(p.clips).map(c => c.start + c.duration)) });
}
const project = (w, h, frames, extra = {}) => Object.assign({
  version: 1, fps: 30, aspect: 'source', width: w, height: h, bgColor: '#000000',
  tracks: [{ id: 't1', kind: 'video', name: 'V1' }, { id: 't2', kind: 'audio', name: 'A1' }],
  clips: { c1: { id: 'c1', trackId: 't1', type: 'media', mediaId: 'm1', start: 0, duration: frames, srcIn: 0, speed: 1 } },
  transitions: {}, markers: [], inPoint: null, outPoint: null, nextId: 2,
}, extra);

async function openPage(t) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**', r => r.abort());
  await page.goto(BASE + 'index.html');
  await page.evaluate(installStubs);
  return { page, errors };
}

// 透過對話框匯出，回傳下載檔路徑與對話框訊息
async function exportViaDialog(page, proj, name, { quality, shot, ext = 'mp4', setup } = {}) {
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), proj);
  await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent));
  await page.fill('#edExName', name);
  if (quality) await page.click(`#edExQuality button[data-v="${quality}"]`);
  if (setup) { await setup(page); await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent)); }
  const dl = page.waitForEvent('download', { timeout: 180000 });
  await page.click('#edExGo');
  if (shot) {
    await page.waitForFunction(() => document.getElementById('edExBar').value > 0.3, null, { timeout: 120000 });
    await page.locator('#edExportDialog').screenshot({ path: path.join(OUT, `${shot}-progress.png`) });
  }
  const d = await dl;
  assert.equal(d.suggestedFilename(), `${name}.${ext}`);
  const file = path.join(OUT, `${name}.${ext}`);
  await d.saveAs(file);
  await page.waitForFunction(() => !window.QPTEdit.exporter.busy);
  const msg = await page.locator('#edExMsg').textContent();
  const ok = await page.locator('#edExMsg').evaluate(e => e.classList.contains('is-ok'));
  if (shot) await page.locator('#edExportDialog').screenshot({ path: path.join(OUT, `${shot}-done.png`) });
  return { file, msg, ok };
}

const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', file]).toString());
const decodeErrors = file => spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim();
// 第 n 格右下角的平均顏色（避開左上角的來源畫格和中間的數字）
function pixel(file, n) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vf', `select=eq(n\\,${n}),crop=iw/8:ih/8:iw*7/8:ih*7/8,scale=1:1`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return Array.from(raw.subarray(0, 3));
}
function checkFile(t, file, { w, h, frames, codec = 'vp9', audio = 'opus' }) {
  const info = probe(file);
  const v = info.streams.find(s => s.codec_type === 'video'), a = info.streams.find(s => s.codec_type === 'audio');
  const secs = frames / 30;
  t.diagnostic(`${path.basename(file)}：${v.codec_name} ${v.width}×${v.height} ${v.r_frame_rate} 影格 ${v.nb_read_frames} 長度 ${v.duration}s｜${a && a.codec_name} ${a && a.sample_rate}Hz ${a && a.channels}ch 長度 ${a && a.duration}s｜檔案 ${info.format.duration}s ${info.format.size} bytes`);
  assert.equal(v.codec_name, codec);
  assert.equal(v.width, w);
  assert.equal(v.height, h);
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(+v.nb_read_frames, frames);
  // WebM（Matroska）的 ffprobe 不回報各串流長度，只看整個檔案的長度
  if (v.duration !== undefined) assert.ok(Math.abs(+v.duration - secs) < 0.01, `影像長度 ${v.duration}`);
  if (audio === null) { assert.equal(a, undefined, '不該有聲音'); assert.equal(decodeErrors(file), ''); return info; }
  assert.ok(a, '沒有音訊串流');
  assert.equal(a.codec_name, audio);
  assert.equal(a.channels, 2);
  if (a.duration !== undefined) assert.ok(Math.abs(+a.duration - secs) < 0.03, `聲音長度 ${a.duration}`);
  assert.ok(Math.abs(+info.format.duration - secs) < 0.03, `檔案長度 ${info.format.duration}`);
  assert.equal(decodeErrors(file), '', 'ffmpeg 解碼有錯誤');
  return info;
}
// 聲音第一個超過 0.1 的樣本位置（48kHz）
function audioOnset(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-']);
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  return x.findIndex(v => Math.abs(v) > 0.1);
}
const near = (got, want, tol = 14) => got.every((g, i) => Math.abs(g - want[i]) <= tol);
const colorOf = f => [(f * 7) % 256, (f * 3) % 256, 128];

test('9:16（1080×1920@30）3 秒：對話框匯出 → 90 格、3 秒、有 Opus 聲音，畫面順序正確', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  const proj = project(1080, 1920, 90);
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), proj);
  await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent));
  assert.equal(await page.locator('#edExSize').textContent(), '1080×1920．30 fps（依專案設定）');
  const codec = await page.locator('#edExCodec').textContent();
  assert.match(codec, /^VP9＋Opus/);
  assert.match(codec, /不支援 H\.264／AAC 編碼/);
  assert.equal(await page.locator('#edExRange button[data-v="io"]').isDisabled(), true);   // 沒有 In／Out
  if (KEEP) await page.locator('#edExportDialog').screenshot({ path: path.join(OUT, '916-open.png') });

  const { file, msg, ok } = await exportViaDialog(page, proj, 'e2e-916', { shot: KEEP ? '916' : null });
  assert.ok(ok, msg);
  assert.match(msg, /已匯出：e2e-916\.mp4/);
  checkFile(t, file, { w: 1080, h: 1920, frames: 90 });
  for (const n of [0, 45, 89]) assert.ok(near(pixel(file, n), colorOf(n)), `第 ${n} 格顏色 ${pixel(file, n)} ≠ ${colorOf(n)}`);
  // 聲音在 0.5 秒（第 24000 個樣本）開始；Opus 的 pre-skip 有被 edit list 跳過的話，誤差只有幾個樣本
  const onset = audioOnset(file);
  t.diagnostic(`聲音起點：第 ${onset} 個樣本（預期 24000）`);
  assert.ok(Math.abs(onset - 24000) < 48, `聲音起點 ${onset}`);
  const T = await page.evaluate(() => ({ calls: window.__t.audioCalls, n: window.__t.sourceFrames.length, open: window.__t.sourceFrames.filter(f => f.format !== null).length }));
  assert.deepEqual(T.calls, [{ sampleRate: 48000, channels: 2, from: 0, to: 90 }]);
  assert.equal(T.n, 90);                // 每格向 seekSource 要一次來源
  // 沒有 sourcesAt：每格先試畫一次再正式畫；匯出完釋放 seekSource 的 <video>
  assert.deepEqual(await page.evaluate(() => [window.__t.composeCalls, window.__t.released]), [180, 1]);
  assert.equal(T.open, 0);              // 用完都關掉了
  assert.deepEqual(errors, []);
});

test('16:9（1920×1080）與 4:5（1080×1350）各 2 秒；畫質「小」', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  // render 有 renderFrame 時直接用它（它自己備好來源再合成）
  await page.evaluate(() => {
    const R = window.QPTEdit.render, T = window.__t;
    T.renderFrames = 0;
    R.renderFrame = async (ctx, p, frame) => { T.renderFrames++; const s = await R.seekSource('m1', frame / p.fps); try { R.compose(ctx, p, frame, () => s); } finally { s.close(); } };
  });
  for (const [w, h, name] of [[1920, 1080, 'e2e-169'], [1080, 1350, 'e2e-45']]) {
    const { file, msg, ok } = await exportViaDialog(page, project(w, h, 60), name, { quality: 'small' });
    assert.ok(ok, msg);
    checkFile(t, file, { w, h, frames: 60 });
    assert.ok(near(pixel(file, 30), colorOf(30)), `${name} 第 30 格顏色`);
  }
  assert.deepEqual(await page.evaluate(() => [window.__t.renderFrames, window.__t.composeCalls]), [120, 120]);
  assert.deepEqual(errors, []);
});

test('In／Out：預設只匯出 In～Out（30～75 格），聲音也只混那一段', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  const proj = project(640, 360, 120, { inPoint: 30, outPoint: 75 });
  // render 有 sourcesAt 時直接用它決定要哪些來源，每格只合成一次
  await page.evaluate(() => { window.QPTEdit.render.sourcesAt = (p, f) => [{ clip: p.clips.c1, mediaId: 'm1', time: f / p.fps }]; });
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), proj);
  assert.equal(await page.locator('#edExRange button.active').getAttribute('data-v'), 'io');
  assert.match(await page.locator('#edExRangeHint').textContent(), /^00:00:01:00 ～ 00:00:02:15，共 1\.5 秒（45 格）$/);
  const { file, msg, ok } = await exportViaDialog(page, proj, 'e2e-io');
  assert.ok(ok, msg);
  checkFile(t, file, { w: 640, h: 360, frames: 45 });
  assert.ok(near(pixel(file, 0), colorOf(30)), '第一格應該是時間軸第 30 格');
  assert.deepEqual(await page.evaluate(() => window.__t.audioCalls), [{ sampleRate: 48000, channels: 2, from: 30, to: 75 }]);
  assert.deepEqual(await page.evaluate(() => [window.__t.composeCalls, window.__t.sourceFrames.length, window.__t.sourceFrames.filter(f => f.format !== null).length]), [45, 45, 0]);
  assert.deepEqual(errors, []);
});

test('AV1：用 run() 指定 AV1，也能產出正確的 MP4', { skip, timeout: 300000 }, async t => {
  const { page } = await openPage(t);
  const res = await page.evaluate(async p => {
    const r = await window.QPTEdit.exporter.run({ project: p, from: 0, to: 60, quality: 'medium', prefer: { video: 'av1' } });
    const b = new Uint8Array(await r.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { b64: btoa(s), codecs: r.codecs };
  }, project(640, 360, 60));
  assert.equal(res.codecs.label, 'AV1＋Opus');
  const file = path.join(OUT, 'e2e-av1.mp4');
  fs.writeFileSync(file, Buffer.from(res.b64, 'base64'));
  checkFile(t, file, { w: 640, h: 360, frames: 60, codec: 'av1' });
});

test('快照：匯出途中改專案不影響成品；open() 沒指定專案時回到目前的剪輯專案', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  const res = await page.evaluate(async p => {
    const Q = window.QPTEdit, comp = Q.render.compose, seen = [];
    Q.render.compose = (ctx, pp, frame, gs) => {
      seen.push(Object.keys(pp.clips).length);
      if (frame === 5) { p.clips = {}; p.width = 64; }      // 匯出途中把原本的專案改掉
      return comp(ctx, pp, frame, gs);
    };
    try {
      const r = await Q.exporter.run({ project: p, from: 0, to: 30, quality: 'small' });
      return { frames: r.frames, seen, mutated: Object.keys(p.clips).length === 0 };
    } finally { Q.render.compose = comp; }
  }, project(320, 240, 30));
  assert.equal(res.mutated, true);
  assert.equal(res.frames, 30);
  // （沒有 renderFrame 時每格會 compose 兩次：先收集要的來源、再真的畫）
  assert.ok(res.seen.length >= 30 && res.seen.every(n => n === 1), '每一格都要用按下匯出時的專案（快照）：' + JSON.stringify(res.seen));
  // open({ project }) 指定過一次後，下次 open() 不能還黏著那個專案
  const size = await page.evaluate(p => {
    const E = window.QPTEdit.exporter, dlg = document.getElementById('edExportDialog');
    E.open({ project: p });
    const a = document.getElementById('edExSize').textContent;
    dlg.close();
    E.open();
    const b = document.getElementById('edExSize').textContent, u = window.QPTEdit.ui.state.project;
    dlg.close();
    return { a, b, want: `${u.width}×${u.height}` };
  }, project(322, 242, 30));
  assert.ok(size.a.startsWith('322×242'), size.a);
  assert.ok(size.b.startsWith(size.want), JSON.stringify(size));
  assert.deepEqual(errors, []);
});

test('取消：匯出中按「取消匯出」→ 關閉編碼器、釋放畫格、不下載、介面恢復', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), project(1080, 1920, 600));
  await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent));
  await page.click('#edExGo');
  await page.waitForFunction(() => document.getElementById('edExBar').value > 0.08, null, { timeout: 120000 });
  assert.equal(await page.locator('#edExClose').textContent(), '取消匯出');
  assert.equal(await page.locator('#edExGo').isDisabled(), true);
  // 匯出中按 Esc 不會關掉對話框
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('edExportDialog').open), true);
  await page.click('#edExClose');
  await page.waitForFunction(() => !window.QPTEdit.exporter.busy, null, { timeout: 30000 });
  assert.equal(await page.locator('#edExMsg').textContent(), '已取消匯出');
  assert.equal(await page.locator('#edExGo').isDisabled(), false);
  assert.equal(await page.locator('#edExClose').textContent(), '關閉');
  const T = await page.evaluate(() => ({ closed: window.__t.closed, open: window.__t.sourceFrames.filter(f => f.format !== null).length, n: window.__t.sourceFrames.length }));
  assert.deepEqual(T.closed, { video: 1, audio: 1 });   // 聲音編完就關；影像在取消時關
  assert.ok(T.n > 0 && T.n < 600);
  assert.equal(T.open, 0);
  await page.waitForTimeout(500);
  assert.deepEqual(downloads, []);
  assert.deepEqual(errors, []);
});

test('失敗：compose 出錯 → 繁中錯誤訊息、介面恢復，可以再匯出一次', { skip, timeout: 300000 }, async t => {
  const { page } = await openPage(t);
  await page.evaluate(() => { window.__t.failAt = 10; });
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), project(320, 240, 30));
  await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent));
  await page.click('#edExGo');
  await page.waitForFunction(() => !window.QPTEdit.exporter.busy && document.getElementById('edExMsg').textContent);
  assert.equal(await page.locator('#edExMsg').textContent(), '第 10 格畫面合成失敗：替身 compose 故意失敗');
  assert.equal(await page.locator('#edExMsg').evaluate(e => e.classList.contains('is-error')), true);
  assert.equal(await page.locator('#edExGo').isDisabled(), false);
  await page.evaluate(() => { window.__t.failAt = -1; });
  const { file, ok, msg } = await exportViaDialog(page, project(320, 240, 30), 'e2e-retry');
  assert.ok(ok, msg);
  checkFile(t, file, { w: 320, h: 240, frames: 30 });
});

// =====================================================================================
// 匯出面板：封裝格式、尺寸、自訂位元率、不含聲音、快速匯出（社群平台）
// =====================================================================================
const pick = (sel, v) => async page => { await page.selectOption(sel, v); };

test('WebM：選封裝格式 WebM → VP9＋Opus 的 .webm，畫面與聲音正確', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  const proj = project(640, 360, 60);
  const { file, msg, ok } = await exportViaDialog(page, proj, 'e2e-webm', { ext: 'webm', setup: pick('#edExContainer', 'webm') });
  assert.ok(ok, msg);
  assert.match(msg, /已匯出：e2e-webm\.webm/);
  const info = checkFile(t, file, { w: 640, h: 360, frames: 60 });
  assert.match(info.format.format_name, /webm/);
  for (const n of [0, 30, 59]) assert.ok(near(pixel(file, n), colorOf(n)), `第 ${n} 格顏色`);
  const onset = audioOnset(file);
  t.diagnostic(`WebM 聲音起點：第 ${onset} 個樣本（預期 24000）`);
  assert.ok(Math.abs(onset - 24000) < 48, `聲音起點 ${onset}（Opus 的 CodecDelay 有沒有生效）`);
  assert.match(await page.locator('#edExCodec').textContent(), /^VP9＋Opus．WebM/);
  assert.equal(await page.locator('#edExExt').textContent(), '.webm');
  assert.deepEqual(errors, []);
});

test('尺寸：1080×1920 的專案選 720p → 720×1280；自訂 2 Mbps＋不含聲音', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  const proj = project(1080, 1920, 45);
  const { file, msg, ok } = await exportViaDialog(page, proj, 'e2e-720', { setup: async pg => {
    await pg.selectOption('#edExSizeSel', '720');
    await pg.click('#edExQuality button[data-v="custom"]');
    await pg.fill('#edExMbps', '2'); await pg.press('#edExMbps', 'Tab');
    await pg.selectOption('#edExAudio', 'none');
  } });
  assert.ok(ok, msg);
  assert.match(await page.locator('#edExSize').textContent(), /^720×1280．30 fps（從專案 1080×1920 縮小）/);
  assert.match(await page.locator('#edExRate').textContent(), /^影像 2\.0 Mbps$/);
  assert.match(await page.locator('#edExCodec').textContent(), /不含聲音/);
  checkFile(t, file, { w: 720, h: 1280, frames: 45, audio: null });
  assert.deepEqual(await page.evaluate(() => window.__t.audioCalls), [], '不含聲音時不混音');
  assert.ok(near(pixel(file, 20), colorOf(20)), '第 20 格顏色');
  assert.deepEqual(errors, []);
});

test('快速匯出：選 Instagram Reels 帶入建議值；改任何一項變回自訂；設定會記住', { skip, timeout: 300000 }, async t => {
  const { page, errors } = await openPage(t);
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), project(1920, 1080, 30));
  await page.click('[data-preset="igreels"]');
  await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent));
  const v = await page.evaluate(() => ({ size: edExSizeSel.value, mbps: edExMbps.value, ak: edExAkbps.value, ct: edExContainer.value, vid: edExVideo.value, au: edExAudio.value,
    active: document.querySelector('.ed-ex-preset.active').dataset.preset, q: document.querySelector('#edExQuality .active').dataset.v }));
  assert.deepEqual(v, { size: '1080', mbps: '5', ak: '192', ct: 'mp4', vid: 'h264', au: 'aac', active: 'igreels', q: 'custom' });
  assert.match(await page.locator('#edExSize').textContent(), /^1920×1080/);
  // 專案是 16:9：提示建議 9:16；指定了別的專案時不提供「改專案比例」的按鈕
  assert.match(await page.locator('#edExAdvice').textContent(), /Instagram Reels 建議 9:16，目前專案是 1920×1080/);
  assert.equal(await page.locator('#edExFixAspect').count(), 0);
  // 沙盒的 Chromium 沒有 H.264／AAC：說明改用了什麼
  const codec = await page.locator('#edExCodec').textContent();
  const hasH264 = await page.evaluate(async () => (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 5e6, framerate: 30 })).supported);
  if (!hasH264) assert.match(codec, /此瀏覽器不支援 H\.264 編碼，改用 VP9/);
  else assert.match(codec, /^H\.264/);
  // 改一項 → 自訂
  await page.selectOption('#edExSizeSel', '720');
  assert.equal(await page.locator('.ed-ex-preset.active').getAttribute('data-preset'), 'custom');
  assert.equal(await page.locator('#edExAdvice').isHidden(), true);
  // 記在 localStorage，重新整理再打開還是一樣
  await page.reload();
  await page.evaluate(installStubs);
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), project(1920, 1080, 30));
  assert.equal(await page.locator('#edExSizeSel').inputValue(), '720');
  assert.equal(await page.locator('#edExMbps').inputValue(), '5');
  assert.deepEqual(errors, []);
});

test('快速匯出：比例不同時一鍵把目前的剪輯專案改成建議比例', { skip, timeout: 120000 }, async t => {
  const { page, errors } = await openPage(t);
  // 用真的剪輯介面（不指定專案）：預設 1920×1080
  await page.evaluate(() => window.QPTEdit.exporter.open());
  await page.click('[data-preset="fbreels"]');
  assert.match(await page.locator('#edExAdvice').textContent(), /Facebook Reels 建議 9:16/);
  await page.click('#edExFixAspect');
  assert.deepEqual(await page.evaluate(() => { const p = window.QPTEdit.ui.state.project; return [p.aspect, p.width, p.height]; }), ['9:16', 1080, 1920]);
  assert.equal(await page.locator('#edExAdvice').isHidden(), true);
  assert.match(await page.locator('#edExSize').textContent(), /^1080×1920/);
  assert.deepEqual(errors, []);
});

test('MOV：瀏覽器沒有 H.264 時選項停用並說明；WebM＋AV1 用 run() 也正確', { skip, timeout: 300000 }, async t => {
  const { page } = await openPage(t);
  await page.evaluate(p => window.QPTEdit.exporter.open({ project: p }), project(640, 360, 30));
  await page.waitForFunction(() => !/偵測中/.test(document.getElementById('edExCodec').textContent));
  const mov = await page.evaluate(() => { const o = document.querySelector('#edExContainer option[value="mov"]'); return { disabled: o.disabled, text: o.textContent }; });
  const hasH264 = await page.evaluate(async () => (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 640, height: 360, bitrate: 1e6, framerate: 30 })).supported);
  t.diagnostic(`MOV 選項：${JSON.stringify(mov)}（H.264 ${hasH264 ? '可用' : '不可用'}）`);
  assert.equal(mov.disabled, !hasH264);
  if (!hasH264) assert.match(mov.text, /此瀏覽器沒有 H\.264 編碼/);
  const res = await page.evaluate(async p => {
    const r = await window.QPTEdit.exporter.run({ project: p, from: 0, to: 30, quality: 'small', container: 'webm', prefer: { video: 'av1' } });
    const b = new Uint8Array(await r.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { b64: btoa(s), codecs: r.codecs, type: r.blob.type, filename: r.filename };
  }, project(640, 360, 30));
  assert.equal(res.codecs.label, 'AV1＋Opus');
  assert.equal(res.type, 'video/webm');
  const file = path.join(OUT, 'e2e-av1.webm');
  fs.writeFileSync(file, Buffer.from(res.b64, 'base64'));
  const info = checkFile(t, file, { w: 640, h: 360, frames: 30, codec: 'av1' });
  assert.match(info.format.format_name, /webm/);
});
