// 剪輯 fx 的瀏覽器檢查：像素比對（轉場端點／中段、變形、裁切柔邊）＋字幕畫面＋檢查器拖曳
// 執行：CHROMIUM=/opt/pw-browsers/chromium SHOTS=<截圖資料夾> node test/edit-fx.e2e.js
// （沒設 CHROMIUM 就用 playwright 預設瀏覽器；CI 的 node --test 只跑 *.test.js，不會跑這支）
const fs = require('fs'), os = require('os'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'edfx-'));
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const html = path.join(SHOTS, 'edit-fx-page.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"WHZ-Heavy";src:url("file://${ROOT}/whz-heavy.ttf") format("truetype")}
:root{--bg:#f2f6fc;--text:#1f2a3d;--muted:#6b7890;--border:rgba(0,74,173,.12);--accent:#004aad;--field-bg:#fff}
body{margin:0;padding:16px;font-family:system-ui,"Noto Sans TC",sans-serif;background:var(--bg);color:var(--text)}
#insp{width:300px;padding:12px;background:#fff;border:1px solid var(--border);border-radius:12px}
</style><body><div id="insp"></div>`);
  const browser = require('./e2e-pro.js')(await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}));
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + html);
  await page.addScriptTag({ path: path.join(ROOT, 'edit-fx.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'edit-fx-gl.js') });

  // ---------- 轉場：端點逐像素相同，中段合理 ----------
  console.log('轉場');
  const tr = await page.evaluate(async () => {
    const fx = window.QPTEdit.fx, W = 320, H = 180;
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const pattern = (a, b) => ctx => { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, a); g.addColorStop(1, b); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(40, 40, 60, 30); };
    const dA = pattern('#ff0000', '#ffaa00'), dB = pattern('#0000ff', '#00ffaa');
    const snap = fn => { const c = mk(), x = c.getContext('2d'); fn(x); return x.getImageData(0, 0, W, H).data; };
    const refA = snap(dA), refB = snap(dB);
    const same = (p, q) => { for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false; return true; };
    const out = { ends: {}, mid: {} };
    for (const type of Object.keys(fx.TRANSITIONS)) {
      for (const dir of ['left', 'right', 'up', 'down']) {
        const at = t => snap(x => fx.TRANSITIONS[type].draw(x, dA, dB, t, { type, direction: dir, color: '#00ff00', ease: 'easeInOut' }, W, H));
        out.ends[type + ':' + dir] = same(at(0), refA) && same(at(1), refB);
      }
    }
    // 純色 A=紅、B=藍 的中段取樣
    const solid = c => x => { x.fillStyle = c; x.fillRect(0, 0, W, H); };
    const px = (type, t, opts, xs, ys) => {
      const c = mk(), x = c.getContext('2d');
      fx.TRANSITIONS[type].draw(x, solid('#ff0000'), solid('#0000ff'), t, { type, ease: 'linear', ...opts }, W, H);
      return Array.from(x.getImageData(xs, ys, 1, 1).data);
    };
    out.mid.dissolve = px('crossDissolve', 0.5, {}, 160, 90);
    out.mid.dip = px('dipToColor', 0.5, { color: '#00ff00' }, 160, 90);
    out.mid.dipQuarter = px('dipToColor', 0.25, { color: '#00ff00' }, 160, 90);
    out.mid.wipeLeftL = px('wipe', 0.25, { direction: 'left' }, 100, 90);
    out.mid.wipeLeftR = px('wipe', 0.25, { direction: 'left' }, 300, 90);
    out.mid.wipeDownTop = px('wipe', 0.5, { direction: 'down' }, 160, 20);
    out.mid.wipeDownBottom = px('wipe', 0.5, { direction: 'down' }, 160, 160);
    out.mid.pushLeftL = px('push', 0.5, { direction: 'left' }, 80, 90);
    out.mid.pushLeftR = px('push', 0.5, { direction: 'left' }, 240, 90);
    out.mid.slideRightL = px('slide', 0.5, { direction: 'right' }, 80, 90);
    out.mid.slideRightR = px('slide', 0.5, { direction: 'right' }, 240, 90);
    out.mid.zoom = px('zoom', 0.5, {}, 160, 90);
    out.mid.blur = px('blur', 0.5, {}, 160, 90);
    out.mid.fadeBlack = px('fadeToBlack', 0.5, {}, 160, 90);
    out.mid.fadeSingle = (() => { const c = mk(), x = c.getContext('2d'); fx.TRANSITIONS.fadeToBlack.draw(x, solid('#ff0000'), () => {}, 0.75, { single: true, ease: 'linear' }, W, H); return Array.from(x.getImageData(160, 90, 1, 1).data); })();
    // 半透明 A／B 的疊化：結果 alpha 也應該是線性內插（A 不透明、B 全透明 → alpha = 1-t）
    out.mid.alphaLerp = (() => { const c = mk(), x = c.getContext('2d'); fx.TRANSITIONS.crossDissolve.draw(x, solid('#ff0000'), () => {}, 0.25, { ease: 'linear' }, W, H); return Array.from(x.getImageData(160, 90, 1, 1).data); })();
    return out;
  });
  for (const [k, v] of Object.entries(tr.ends)) if (!v) ok(false, `轉場端點 ${k} 與 A／B 逐像素相同`);
  ok(Object.values(tr.ends).every(Boolean), `${Object.keys(tr.ends).length / 4} 種轉場 × 4 方向，t=0 等於 A、t=1 等於 B（共 ${Object.keys(tr.ends).length} 組）`);
  const near = (p, q, tol = 3) => p.every((v, i) => Math.abs(v - q[i]) <= tol);
  const m = tr.mid;
  ok(near(m.dissolve, [128, 0, 128, 255], 4), '交叉疊化 t=.5 為紫 ' + m.dissolve);
  ok(near(m.dip, [0, 255, 0, 255]), '浸入顏色 t=.5 為純綠 ' + m.dip);
  ok(near(m.dipQuarter, [128, 128, 0, 255], 4) || (m.dipQuarter[0] > 100 && m.dipQuarter[1] > 100 && m.dipQuarter[2] < 5), '浸入顏色 t=.25 為紅綠各半 ' + m.dipQuarter);
  ok(near(m.wipeLeftL, [255, 0, 0, 255]) && near(m.wipeLeftR, [0, 0, 255, 255]), '擦拭向左：B 從右邊露出');
  ok(near(m.wipeDownTop, [0, 0, 255, 255]) && near(m.wipeDownBottom, [255, 0, 0, 255]), '擦拭向下：B 從上方長出來');
  ok(near(m.pushLeftL, [255, 0, 0, 255]) && near(m.pushLeftR, [0, 0, 255, 255]), '推擠向左：左半是 A、右半是 B');
  ok(near(m.slideRightL, [0, 0, 255, 255]) && near(m.slideRightR, [255, 0, 0, 255]), '滑入向右：B 從左邊進來蓋住 A');
  ok(m.zoom[0] > 30 && m.zoom[2] > 30, '縮放中段混合兩者 ' + m.zoom);
  ok(m.blur[0] > 30 && m.blur[2] > 30, '模糊中段混合兩者 ' + m.blur);
  ok(near(m.fadeBlack, [0, 0, 0, 255]), '淡出到黑 t=.5 全黑 ' + m.fadeBlack);
  ok(near(m.fadeSingle, [64, 0, 0, 255], 4), '淡出到黑（沒有 B）t=.75 為 25% 紅 ' + m.fadeSingle);
  ok(Math.abs(m.alphaLerp[3] - 191) <= 3, '疊化到透明：alpha 線性 ' + m.alphaLerp);

  // ---------- WebGL 轉場（3.20） ----------
  console.log('WebGL 轉場');
  const g = await page.evaluate(() => {
    const fx = window.QPTEdit.fx, fxgl = window.QPTEdit.fxgl, W = 320, H = 180;
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const solid = c => x => { x.fillStyle = c; x.fillRect(0, 0, W, H); };
    const none = () => {};
    const run = (type, t, opts, dB = solid('#0000ff')) => {
      const c = mk(), x = c.getContext('2d');
      fx.TRANSITIONS[type].draw(x, solid('#ff0000'), dB, t, { type, ease: 'linear', direction: 'left', color: '#000000', ...opts }, W, H);
      return (px, py) => Array.from(x.getImageData(px, py, 1, 1).data);
    };
    const out = { available: fxgl.available() };
    let r = run('doors', 0.5, { direction: 'left' }); out.doorsL = [r(20, 90), r(160, 90), r(300, 90)];
    r = run('doors', 0.5, { direction: 'up' }); out.doorsU = [r(160, 10), r(160, 90), r(160, 170)];
    r = run('flash', 0.5, { color: '#ffffff' }); out.flashW = r(160, 90);
    r = run('flash', 0.5, { color: '#00ff00' }); out.flashG = r(160, 90);
    r = run('cube', 0.5, { direction: 'left' }); out.cubeL = [r(100, 90), r(220, 90)];
    r = run('cube', 0.5, { direction: 'right' }); out.cubeR = [r(100, 90), r(220, 90)];
    r = run('cube', 0.5, { direction: 'up' }); out.cubeU = [r(160, 20), r(160, 160)];
    r = run('cube', 0.5, { direction: 'down' }); out.cubeD = [r(160, 20), r(160, 160)];
    r = run('blinds', 0.45, { direction: 'left' }); out.blindsL = [r(16, 90), r(304, 90)];
    r = run('blinds', 0.45, { direction: 'right' }); out.blindsR = [r(16, 90), r(304, 90)];
    r = run('pixelate', 0.2, {}); out.pix = r(160, 90);
    r = run('zoomPunch', 0.6, {}); out.zoomPunch = r(160, 90);
    r = run('lightLeak', 0.5, { color: '#ff7a2e' }); out.leak = r(160, 90);
    out.finite = ['whip', 'glitch', 'spin', 'flip'].map(k => { const q = run(k, 0.37, { direction: 'up' }); return q(160, 90).every(v => v >= 0 && v <= 255); }).every(Boolean);
    // 單邊（尾端淡出）：沒有 B 的那一側是透明，不是黑色
    r = run('cube', 0.5, { direction: 'left' }, none); out.cubeSingle = r(220, 90);
    // 沒有 WebGL：退回交叉疊化
    fxgl._disable(true);
    r = run('doors', 0.5, {}); out.fallback = r(160, 90);
    fxgl._disable(false);
    return out;
  });
  const red = p => p[0] > 150 && p[2] < 60, blue = p => p[2] > 150 && p[0] < 60;
  ok(g.available, '這個瀏覽器有 WebGL');
  ok(red(g.doorsL[0]) && blue(g.doorsL[1]) && red(g.doorsL[2]), '對開門（左右）：兩側是 A、中間露出 B ' + JSON.stringify(g.doorsL));
  ok(red(g.doorsU[0]) && blue(g.doorsU[1]) && red(g.doorsU[2]), '對開門（上下）：上下是 A、中間露出 B ' + JSON.stringify(g.doorsU));
  ok(near(g.flashW, [255, 255, 255, 255], 6), '閃光 t=.5 為白 ' + g.flashW);
  ok(near(g.flashG, [0, 255, 0, 255], 6), '閃光可換顏色（綠） ' + g.flashG);
  ok(red(g.cubeL[0]) && blue(g.cubeL[1]), '立方體向左：B 從右邊轉進來 ' + JSON.stringify(g.cubeL));
  ok(blue(g.cubeR[0]) && red(g.cubeR[1]), '立方體向右：B 從左邊轉進來 ' + JSON.stringify(g.cubeR));
  ok(red(g.cubeU[0]) && blue(g.cubeU[1]), '立方體向上：B 從下面轉上來 ' + JSON.stringify(g.cubeU));
  ok(blue(g.cubeD[0]) && red(g.cubeD[1]), '立方體向下：B 從上面轉下來 ' + JSON.stringify(g.cubeD));
  ok(red(g.blindsL[0]) && blue(g.blindsL[1]) && blue(g.blindsR[0]) && red(g.blindsR[1]), '百葉窗：向左從右邊先翻、向右從左邊先翻 ' + JSON.stringify([g.blindsL, g.blindsR]));
  ok(red(g.pix), '馬賽克前段仍是 A ' + g.pix);
  ok(blue(g.zoomPunch), '縮放衝刺後半是 B ' + g.zoomPunch);
  ok(g.leak[0] > 200 && g.leak[1] > 60, '光漏中段有暖色光 ' + g.leak);
  ok(g.finite, '甩鏡／故障／旋轉／卡片翻轉中段有正常輸出');
  ok(g.cubeSingle[3] < 10, '單邊轉場：沒有 B 的一側是透明 ' + g.cubeSingle);
  ok(near(g.fallback, [128, 0, 128, 255], 4), '沒有 WebGL 時退回交叉疊化 ' + g.fallback);

  // ---------- 模糊背景（3.30） ----------
  console.log('模糊背景');
  const bb = await page.evaluate(() => {
    const fx = window.QPTEdit.fx;
    const src = document.createElement('canvas'); src.width = 400; src.height = 200;
    const s = src.getContext('2d');
    s.fillStyle = '#e53935'; s.fillRect(0, 0, 200, 200); s.fillStyle = '#1e88e5'; s.fillRect(200, 0, 200, 200);
    const W = 180, H = 320;
    const run = (fit, extra = {}) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      const clip = { id: 'c', type: 'media', duration: 60, video: { transform: { ...fx.DEFAULT_TRANSFORM, ...(extra.tf || {}) }, crop: { ...fx.DEFAULT_CROP }, fit, ...(extra.v || {}) } };
      fx.drawClipVisual(x, clip, src, 400, 200, W, H, 0);
      return (px, py) => Array.from(x.getImageData(px, py, 1, 1).data);
    };
    const fit = run('fit'), blur = run('blur'), half = run('blur', { tf: { opacity: 0.5 } }), zoomed = run('blur', { tf: { zoomX: 0.5, zoomY: 0.5 } });
    return { fitTop: fit(20, 20), blurTopL: blur(20, 20), blurTopR: blur(160, 20), blurMidL: blur(20, 160), blurMidR: blur(160, 160), halfTop: half(20, 20), zoomCorner: zoomed(20, 300) };
  });
  ok(bb.fitTop[3] === 0, '符合：上方是空白（透明） ' + bb.fitTop);
  ok(bb.blurTopL[3] === 255 && bb.blurTopL[0] > bb.blurTopL[2] && bb.blurTopR[2] > bb.blurTopR[0], '模糊背景：上方補滿，左紅右藍延續畫面 ' + JSON.stringify([bb.blurTopL, bb.blurTopR]));
  ok(bb.blurMidL[0] > 200 && bb.blurMidL[2] < 80 && bb.blurMidR[2] > 200, '模糊背景：中間仍是清楚的本體 ' + JSON.stringify([bb.blurMidL, bb.blurMidR]));
  ok(bb.blurTopL[0] < 229, '背景有壓暗 ' + bb.blurTopL);
  ok(Math.abs(bb.halfTop[3] - 128) <= 3, '背景跟著不透明度 ' + bb.halfTop);
  ok(bb.zoomCorner[3] === 255, '背景不跟著縮放，縮小本體時四周仍蓋滿 ' + bb.zoomCorner);

  // ---------- 色彩還原＋LUT（4.50）：WebGL 和 CPU 結果一致、LUT 方向正確 ----------
  console.log('色彩還原與 LUT');
  await page.addScriptTag({ path: path.join(ROOT, 'edit-core.js') });
  const cg = await page.evaluate(() => {
    const Q = window.QPTEdit, fx = Q.fx, C = Q.core;
    const src = document.createElement('canvas'); src.width = 160; src.height = 90;
    const s = src.getContext('2d');
    const g = s.createLinearGradient(0, 0, 160, 0); g.addColorStop(0, 'rgb(70,80,120)'); g.addColorStop(1, 'rgb(170,175,230)');   // 偏藍、霧霧的
    s.fillStyle = g; s.fillRect(0, 0, 160, 90); s.fillStyle = 'rgb(200,60,40)'; s.fillRect(20, 20, 40, 40);
    const n = 9, lines = ['LUT_3D_SIZE ' + n];
    for (let b = 0; b < n; b++) for (let gg = 0; gg < n; gg++) for (let r = 0; r < n; r++) lines.push([gg, b, r].map(v => (v / (n - 1)).toFixed(4)).join(' '));   // R←G、G←B、B←R
    const lut = C.parseCube(lines.join('\n'), 'swap.cube');
    const p = C.createProject(); const a = C.addLut(p, lut);
    const clip = v => ({ id: 'c', type: 'media', duration: 60, video: Object.assign({ transform: { ...fx.DEFAULT_TRANSFORM }, crop: { ...fx.DEFAULT_CROP }, fit: 'fit' }, v) });
    const run = v => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 90; const x = c.getContext('2d');
      fx.drawClipVisual(x, clip(v), src, 160, 90, 160, 90, 0, 30, p);
      return x.getImageData(0, 0, 160, 90).data;
    };
    const glOk = !!Q.fxgl.grade(src, 160, 90, { rp: null, lut: null, lutAmt: 0 });
    const cases = [{ lut: a.id, lutAmt: 100 }, { restore: 100 }, { restore: 60, lut: a.id, lutAmt: 50 }];
    let glCalls = 0; const real = Q.fxgl.grade; Q.fxgl.grade = (...x) => { const r = real(...x); if (r) glCalls++; return r; };
    const gl = cases.map(run);
    Q.fxgl.grade = real;
    Q.fxgl._disable(true);
    const keep = Q.fxgl.grade; Q.fxgl.grade = () => null;
    const cpu = cases.map(run);
    Q.fxgl.grade = keep; Q.fxgl._disable(false);
    const diff = (A, B) => { let m = 0; for (let i = 0; i < A.length; i++) m = Math.max(m, Math.abs(A[i] - B[i])); return m; };
    const px = (d, X, Y) => Array.from(d.slice((Y * 160 + X) * 4, (Y * 160 + X) * 4 + 4));
    const orig = run({});
    const spread = d => { let lo = 255, hi = 0; for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } return hi - lo; };
    return { glOk, glCalls, diffs: gl.map((d, i) => diff(d, cpu[i])), red: px(gl[0], 40, 40), origRed: px(orig, 40, 40), spreadIn: spread(orig), spreadOut: spread(gl[1]),
      blueBias: [px(orig, 150, 80), px(gl[1], 150, 80)] };
  });
  ok(cg.glOk && cg.glCalls === 3, 'WebGL 調色可用，三種情況都走 WebGL ' + cg.glCalls);
  ok(cg.diffs.every(d => d <= 3), 'WebGL 和 CPU 的結果一致（每個像素差 ≤ 3） ' + cg.diffs);
  ok(cg.red[0] < 90 && cg.red[2] > 170, 'LUT（R←G、B←R）：紅色方塊變藍 ' + cg.red + ' 原本 ' + cg.origRed);
  ok(cg.spreadOut > cg.spreadIn + 40, `色彩還原：R 色版的範圍拉開（${cg.spreadIn} → ${cg.spreadOut}）`);
  ok(cg.blueBias[1][2] - cg.blueBias[1][0] < cg.blueBias[0][2] - cg.blueBias[0][0], '色彩還原：偏藍減少 ' + JSON.stringify(cg.blueBias));

  // ---------- 變形／裁切 ----------
  console.log('變形與裁切');
  const vis = await page.evaluate(() => {
    const fx = window.QPTEdit.fx;
    const src = document.createElement('canvas'); src.width = 400; src.height = 200;
    const s = src.getContext('2d');
    s.fillStyle = '#e53935'; s.fillRect(0, 0, 200, 100);      // 左上紅
    s.fillStyle = '#43a047'; s.fillRect(200, 0, 200, 100);    // 右上綠
    s.fillStyle = '#1e88e5'; s.fillRect(0, 100, 200, 100);    // 左下藍
    s.fillStyle = '#fdd835'; s.fillRect(200, 100, 200, 100);  // 右下黃
    const clip = (tr = {}, crop = {}, fit = 'fit') => ({ id: 'c', type: 'media', duration: 60, video: { transform: { ...fx.DEFAULT_TRANSFORM, ...tr }, crop: { ...fx.DEFAULT_CROP, ...crop }, fit } });
    const W = 400, H = 400;
    const cv = document.createElement('canvas'); cv.width = W * 3; cv.height = H * 2; cv.style.cssText = 'width:900px;border:1px solid #ccc;background:#222';
    const x = cv.getContext('2d');
    const cases = [
      ['預設 fit', clip()], ['旋轉 90°', clip({ rotation: 90 })], ['水平翻轉', clip({ flipH: true })],
      ['縮放 .6＋位移＋半透明', clip({ zoomX: 0.6, posX: 60, posY: -50, opacity: 0.5 })],
      ['裁切左 25%＋右 25%', clip({}, { left: 0.25, right: 0.25 }, 'fill')], ['裁切柔邊 50%', clip({}, { left: 0.25, top: 0.25, softness: 0.5 }, 'fill')],
    ];
    const px = [];
    cases.forEach(([name, c], i) => {
      x.save(); x.translate((i % 3) * W, Math.floor(i / 3) * H); x.beginPath(); x.rect(0, 0, W, H); x.clip();
      x.fillStyle = '#333'; x.fillRect(0, 0, W, H);
      fx.drawClipVisual(x, c, src, 400, 200, W, H, 0);
      x.fillStyle = '#fff'; x.font = '16px sans-serif'; x.fillText(name, 8, 20);
      x.restore();
    });
    const at = (i, X, Y) => Array.from(x.getImageData((i % 3) * W + X, Math.floor(i / 3) * H + Y, 1, 1).data);
    document.body.append(cv);
    return {
      base: [at(0, 100, 150), at(0, 300, 150), at(0, 100, 250), at(0, 300, 250), at(0, 100, 50)],   // 紅 綠 藍 黃 與黑邊（灰底 #333）
      rot: [at(1, 250, 100), at(1, 150, 100)],     // 轉 90°（順時針）：原本左上（紅）轉到右上，左下（藍）轉到左上
      flip: [at(2, 100, 150), at(2, 300, 150)],
      crop: [at(4, 5, 200), at(4, 395, 200), at(4, 200, 200)],
      soft: [at(5, 2, 200), at(5, 200, 2), at(5, 390, 390)],
    };
  });
  const bg = [51, 51, 51, 255];
  const isRGB = (p, r, g, b, t = 4) => Math.abs(p[0] - r) <= t && Math.abs(p[1] - g) <= t && Math.abs(p[2] - b) <= t;
  ok(isRGB(vis.base[0], 229, 57, 53) && isRGB(vis.base[1], 67, 160, 71) && isRGB(vis.base[2], 30, 136, 229) && isRGB(vis.base[3], 253, 216, 53), 'fit 四象限顏色正確');
  ok(isRGB(vis.base[4], 51, 51, 51), 'fit 上下留邊（底色）');
  ok(isRGB(vis.rot[0], 229, 57, 53) && isRGB(vis.rot[1], 30, 136, 229), '旋轉 90° 順時針：紅轉到右上、藍轉到左上 ' + vis.rot);
  ok(isRGB(vis.flip[0], 67, 160, 71) && isRGB(vis.flip[1], 229, 57, 53), '水平翻轉：左右互換');
  ok(isRGB(vis.crop[0], 67, 160, 71) === false && vis.crop[0][3] === 255, '裁切 fill 模式左緣已不是原圖最左欄 ' + vis.crop[0]);
  ok(vis.soft[0][0] < 70 && vis.soft[1][0] < 70, '柔邊：有裁切的邊緣羽化到幾乎透明 ' + vis.soft[0] + ' ' + vis.soft[1]);
  ok(isRGB(vis.soft[2], 253, 216, 53), '柔邊：沒裁切的邊緣不羽化 ' + vis.soft[2]);
  await page.locator('canvas').first().screenshot({ path: path.join(SHOTS, 'fx-transform.png') });

  // ---------- 字幕 ----------
  console.log('字幕');
  await page.evaluate(() => document.querySelector('canvas').remove());
  const tit = await page.evaluate(async () => {
    const fx = window.QPTEdit.fx;
    await fx.ready();
    const loaded = fx.fontLoaded && document.fonts.check('40px "WHZ-Heavy"');
    const W = 640, H = 360;
    const names = Object.keys(fx.TITLE_PRESETS);
    const cv = document.createElement('canvas'); cv.width = W * 3; cv.height = H * Math.ceil(names.length / 3); cv.style.cssText = 'width:900px;background:#223';
    const x = cv.getContext('2d');
    const text = '今天的天氣非常好，我們一起去公園散步吧！（含標點換行測試）';
    const nonEmpty = {};
    names.forEach((p, i) => {
      x.save(); x.translate((i % 3) * W, Math.floor(i / 3) * H); x.beginPath(); x.rect(0, 0, W, H); x.clip();
      const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#3a6ea5'); g.addColorStop(1, '#7a4a8c'); x.fillStyle = g; x.fillRect(0, 0, W, H);
      const t = fx.makeTitle(p, text); t.stroke.width = p === 'static' ? 3 : 0;
      const clip = { id: 't' + i, type: 'title', duration: 90, video: fx.defaultVideo(), title: t };
      const f = p === 'scroll' ? 45 : p === 'crawl' ? 30 : p === 'typewriter' ? 20 : 40;
      fx.drawTitle(x, clip, W, H, f, 30);
      x.restore();
      x.fillStyle = '#fff'; x.font = '12px sans-serif'; x.fillText(p + ' @' + f, (i % 3) * W + 6, Math.floor(i / 3) * H + 14);
      nonEmpty[p] = Array.from(x.getImageData((i % 3) * W, Math.floor(i / 3) * H + 20, W, H - 20).data).some((v, k) => k % 4 === 0 && v > 240);
    });
    document.body.append(cv);
    return { loaded, nonEmpty };
  });
  ok(tit.loaded, 'WHZ-Heavy 字型已載入（fx.ready）');
  ok(Object.values(tit.nonEmpty).every(Boolean), '每種字幕過場都有畫出白色文字 ' + JSON.stringify(tit.nonEmpty));
  await page.locator('canvas').first().screenshot({ path: path.join(SHOTS, 'fx-titles.png') });
  await page.evaluate(() => document.querySelector('canvas').remove());

  // ---------- 檢查器 ----------
  console.log('檢查器');
  await page.evaluate(() => {
    const fx = window.QPTEdit.fx;
    window.__clip = { id: 'c1', type: 'media', duration: 90, video: fx.defaultVideo() };
    window.__title = { id: 't1', type: 'title', duration: 90, video: fx.defaultVideo(), title: fx.makeTitle('lowerThird', '歡迎來到直播') };
    window.__tr = { id: 'x1', trackId: 'V1', leftClipId: 'c1', rightClipId: 'c2', type: 'dipToColor', duration: 15, align: 'center', color: '#000000', direction: 'left', ease: 'linear' };
    window.__log = [];
    window.__commit = (p, o) => window.__log.push({ p: JSON.parse(JSON.stringify(p)), live: !!o.live });
    window.__mount = (id, subj) => {
      const sec = fx.inspector.sections.find(s => s.id === id);
      let host = document.getElementById('sec-' + id);
      if (!host) { const wrap = document.createElement('div'); wrap.innerHTML = `<div style="font-weight:700;margin:10px 0 4px">${sec.title}</div>`; host = document.createElement('div'); host.id = 'sec-' + id; wrap.append(host); document.getElementById('insp').append(wrap); }
      sec.render(host, subj, window.__commit);
    };
    __mount('transform', __clip); __mount('crop', __clip); __mount('title', __title); __mount('titleLook', __title); __mount('titleAnim', __title); __mount('transition', __tr);
  });
  const rowCount = await page.evaluate(() => Object.fromEntries(['transform', 'crop', 'title', 'titleLook', 'titleAnim', 'transition'].map(id => [id, document.querySelectorAll('#sec-' + id + ' .ed-fx-row').length])));
  ok(rowCount.transform >= 12 && rowCount.crop === 6 && rowCount.title >= 8 && rowCount.titleLook >= 15 && rowCount.titleAnim >= 3 && rowCount.transition === 8, '四個區段都有畫出欄位 ' + JSON.stringify(rowCount));
  await page.screenshot({ path: path.join(SHOTS, 'fx-inspector.png'), fullPage: true });

  // 在「縮放 X」標籤上往右拖 40px：1 + 40*0.005 = 1.2；中途 live、放開 live:false
  const lab = page.locator('#sec-transform .ed-fx-row', { hasText: '縮放 X' }).locator('.ed-fx-lab');
  const box = await lab.boundingBox();
  await page.evaluate(() => { window.__log.length = 0; });
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + 50, box.y + box.height / 2, { steps: 4 });
  // 模擬外部在 live 提交後重畫（C 可能會這麼做）：不該打斷拖曳
  await page.evaluate(() => __mount('transform', __clip));
  await page.mouse.move(box.x + 50, box.y + box.height / 2);
  await page.mouse.up();
  const log = await page.evaluate(() => window.__log);
  const lives = log.filter(e => e.live), fin = log.filter(e => !e.live);
  ok(lives.length >= 2 && fin.length === 1, `拖曳中 live:true ×${lives.length}，放開 live:false ×${fin.length}`);
  const last = fin[0] && fin[0].p.video.transform;
  ok(last && Math.abs(last.zoomX - 1.2) < 1e-9 && Math.abs(last.zoomY - 1.2) < 1e-9, '連結縮放：X、Y 同步為 1.2 ' + JSON.stringify(last));
  ok(await page.inputValue('#sec-transform .ed-fx-row:has-text("縮放 X") input.ed-fx-numbox') === '1.2', '輸入框顯示跟著更新');
  ok(await page.inputValue('#sec-transform .ed-fx-row:has-text("縮放 X") input.ed-fx-range') === '1.2', '拉桿位置也跟著更新');
  // 重畫同一個對象 = 只更新數值，不重建 DOM
  const stable = await page.evaluate(() => { const a = document.querySelector('#sec-transform input'); __clip.video.transform.zoomX = 1.5; __mount('transform', __clip); return a === document.querySelector('#sec-transform input') && a.value === '1.5'; });
  ok(stable, '同一對象再次 render 只更新值');
  // 打字輸入
  await page.evaluate(() => { __log.length = 0; });
  await page.fill('#sec-transform .ed-fx-row:has-text("旋轉") input', '45');
  await page.press('#sec-transform .ed-fx-row:has-text("旋轉") input', 'Enter');
  await page.locator('#sec-transform .ed-fx-row:has-text("旋轉") input').blur();
  const typed = await page.evaluate(() => __log);
  ok(typed.length === 1 && !typed[0].live && typed[0].p.video.transform.rotation === 45, '輸入 45 → commit rotation:45 ' + JSON.stringify(typed));
  // 雙擊標籤重設
  await page.evaluate(() => { __log.length = 0; });
  await page.locator('#sec-transform .ed-fx-row:has-text("旋轉") .ed-fx-lab').dblclick();
  const dbl = await page.evaluate(() => __log);
  ok(dbl.length === 1 && dbl[0].p.video.transform.rotation === 0 && !dbl[0].live, '雙擊標籤重設為預設值');
  // 取消連結 → 縮放 Y 獨立
  await page.evaluate(() => { __log.length = 0; __clip.video.transform.zoomX = 1; });
  await page.locator('#sec-transform .ed-fx-chk:has-text("連結縮放") input').uncheck();
  ok((await page.evaluate(() => __log))[0].p.video.transform.zoomLinked === false, '取消連結縮放');
  // 字幕：文字 textarea、樣式切換套用預設
  await page.evaluate(() => { __log.length = 0; });
  await page.fill('#sec-title textarea', '新的字幕\n第二行');
  const typedTitle = await page.evaluate(() => __log);
  ok(typedTitle.some(e => e.live && e.p.title.text === '新的字幕\n第二行'), '字幕輸入中 live:true');
  await page.evaluate(() => { __log.length = 0; });
  await page.selectOption('#sec-titleAnim .ed-fx-row:has-text("字幕過場") select', 'crawl');
  const pre = (await page.evaluate(() => __log))[0].p.title;
  ok(pre.preset === 'crawl' && pre.align === 'left' && pre.y === 0.9 && pre.size === undefined, '切換樣式只套用位置／對齊／背景，不動字級 ' + JSON.stringify(pre));
  // 轉場：切到擦拭才出現方向、切到浸入顏色才出現顏色
  const vis2 = await page.evaluate(() => {
    const rowOf = t => [...document.querySelectorAll('#sec-transition .ed-fx-row')].find(r => r.querySelector('.ed-fx-lab').textContent === t);
    const st = [rowOf('顏色').hidden, rowOf('方向').hidden];
    __tr.type = 'wipe'; __mount('transition', __tr);
    return [st, [rowOf('顏色').hidden, rowOf('方向').hidden]];
  });
  ok(vis2[0][0] === false && vis2[0][1] === true && vis2[1][0] === true && vis2[1][1] === false, '轉場：顏色只在浸入顏色、方向只在擦拭／推擠／滑入顯示');
  // 3.20：方向／顏色依轉場類型顯示（甩鏡等四方向、旋轉＝逆／順時針、對開門＝左右／上下、閃光與光漏有顏色）
  const vis3 = await page.evaluate(() => {
    const look = type => {
      __tr.type = type; __mount('transition', __tr);
      const rows = [...document.querySelectorAll('#sec-transition .ed-fx-row')].filter(r => !r.hidden);
      const dir = rows.filter(r => r.querySelector('.ed-fx-lab').textContent === '方向').map(r => [...r.querySelectorAll('option')].map(o => o.textContent).join('/'));
      return { dir, color: rows.some(r => r.querySelector('.ed-fx-lab').textContent === '顏色') };
    };
    return Object.fromEntries(['whip', 'cube', 'spin', 'doors', 'flash', 'lightLeak', 'glitch'].map(k => [k, look(k)]));
  });
  ok(vis3.whip.dir.join() === '向左/向右/向上/向下' && vis3.cube.dir.join() === '向左/向右/向上/向下' && !vis3.whip.color, '甩鏡、立方體：四個方向 ' + JSON.stringify([vis3.whip, vis3.cube]));
  ok(vis3.spin.dir.join() === '逆時針/順時針' && vis3.doors.dir.join() === '左右打開/上下打開', '旋轉、對開門：各自的方向選項 ' + JSON.stringify([vis3.spin, vis3.doors]));
  ok(vis3.flash.color && vis3.lightLeak.color && !vis3.flash.dir.length && !vis3.glitch.color && !vis3.glitch.dir.length, '閃光、光漏有顏色；故障沒有方向與顏色 ' + JSON.stringify([vis3.flash, vis3.glitch]));
  // 外框（色框）：增加 → 4 格完整送出、第 1 格啟用；移除 → 剩下的往前補
  const outl = await page.evaluate(() => {
    const btn = t => [...document.querySelectorAll('#sec-titleLook button')].find(b => b.textContent.trim() === t);
    const shown = t => { const b = btn(t); return !!b && !b.closest('[hidden]'); };
    const click = t => { __log.length = 0; btn(t).click(); const e = __log[__log.length - 1]; __title.title.outlines = e.p.title.outlines; __mount('titleLook', __title); return e.p.title.outlines; };
    const r = { before: [shown('＋ 增加外框'), shown('移除外框 1')] };
    r.add1 = click('＋ 增加外框');
    r.add2 = click('＋ 增加外框');
    r.after2 = [shown('移除外框 1'), shown('移除外框 2'), shown('移除外框 3')];
    r.rm1 = click('移除外框 1');
    r.textFx = [...document.querySelectorAll('#sec-titleAnim .ed-fx-row')].some(row => row.textContent.includes('進場') && row.querySelector('select option[value="jumpLine"]'));
    return r;
  });
  ok(outl.before[0] && !outl.before[1], '一開始只有「＋ 增加外框」');
  ok(outl.add1.length === 4 && outl.add1[0].on && !outl.add1[1].on, '增加外框：送出完整 4 格、第 1 格啟用 ' + JSON.stringify(outl.add1));
  ok(outl.add2[1].on && outl.add2[0].color !== outl.add2[1].color && outl.after2[0] && outl.after2[1] && !outl.after2[2], '第二層外框顏色不同，出現兩組設定');
  ok(outl.rm1.length === 4 && outl.rm1[0].on && !outl.rm1[1].on && outl.rm1[0].color === outl.add2[1].color, '移除外框 1：外框 2 往前補 ' + JSON.stringify(outl.rm1));
  ok(outl.textFx, '字幕動畫有「字體特效 → 進場」選單（含逐行跳起）');
  // 選字變色：點「瘋」、從「狂」拖到「的」→ 一次送出，文字加上星號；再點「瘋」取消
  await page.evaluate(() => { __title.title.text = '進行瘋狂的編輯'; __mount('title', __title); __log.length = 0; });
  const chip = ch => page.locator('#sec-title .ed-fx-ch', { hasText: ch }).first();
  await chip('瘋').click();
  let lg = await page.evaluate(() => __log);
  ok(lg.length === 1 && !lg[0].live && lg[0].p.title.text === '進行*瘋*狂的編輯', '點一個字：變色 ' + JSON.stringify(lg.map(e => e.p.title.text)));
  await page.evaluate(() => { __title.title.text = __log[0].p.title.text; __mount('title', __title); __log.length = 0; });
  const b1 = await chip('狂').boundingBox(), b2 = await chip('的').boundingBox();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2); await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 5 }); await page.mouse.up();
  lg = await page.evaluate(() => __log);
  ok(lg.length === 1 && lg[0].p.title.text === '進行*瘋狂的*編輯', '拖過去一串：只送出一次 ' + JSON.stringify(lg.map(e => e.p.title.text)));
  await page.evaluate(() => { __title.title.text = __log[0].p.title.text; __mount('title', __title); __log.length = 0; });
  ok(await page.evaluate(() => [...document.querySelectorAll('#sec-title .ed-fx-ch.on')].map(e => e.textContent).join('')) === '瘋狂的', '已變色的字有標示');
  await chip('瘋').click();
  lg = await page.evaluate(() => __log);
  ok(lg[0] && lg[0].p.title.text === '進行瘋*狂的*編輯', '再點一次取消 ' + JSON.stringify(lg.map(e => e.p.title.text)));
  await page.locator('#sec-title').screenshot({ path: path.join(SHOTS, 'fx-accent-chips.png') });
  ok(errors.length === 0, '頁面沒有錯誤 ' + errors.join(' | '));

  await browser.close();
  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過', ' 截圖：' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
