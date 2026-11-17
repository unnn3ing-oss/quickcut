// AI 剪輯的純計算（edit-ai.js）：畫面數據、位移與晃動、建議區間、伽瑪偵測、S-Log3 LUT、聯絡表規劃、摘要包、讀腳本
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../edit-ai.js');

const W = ai.AW, H = ai.AH;
// 有紋理的灰階圖（可以平移）
function tex(ox = 0, oy = 0) {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x - ox, v = y - oy;
    g[y * W + x] = 128 + 60 * Math.sin(u * 0.31) * Math.cos(v * 0.23) + 40 * Math.sin((u + v) * 0.11);
  }
  return g;
}
const rgbaOf = fn => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const [r, g, b] = fn(i % W, Math.floor(i / W)); a.set([r, g, b, 255], i * 4); } return a; };

test('frameStats：亮度、過曝、死黑、清晰度', () => {
  const white = ai.frameStats(rgbaOf(() => [255, 255, 255]), W, H);
  assert.ok(white.luma > 0.98 && white.over === 1 && white.under === 0 && white.sharp === 0);
  const black = ai.frameStats(rgbaOf(() => [0, 0, 0]), W, H);
  assert.ok(black.under === 1 && black.luma === 0);
  const sharp = ai.frameStats(rgbaOf((x, y) => ((x + y) % 2 ? [220, 220, 220] : [30, 30, 30])), W, H);
  const soft = ai.frameStats(rgbaOf(x => { const v = 30 + x; return [v, v, v]; }), W, H);
  assert.ok(sharp.sharp > soft.sharp * 100, '棋盤格比漸層清晰');
  assert.ok(sharp.p99 > 0.8 && sharp.p1 < 0.15);
  assert.ok(ai.frameStats(rgbaOf(() => [255, 0, 0]), W, H).sat > 0.9);
});

test('shift：找得到整數與小數位移；純色偏好不動', () => {
  const a = tex();
  let s = ai.shift(a, tex(3, -2), W, H);
  assert.ok(Math.abs(s.dx - 3) < 0.3 && Math.abs(s.dy + 2) < 0.3, JSON.stringify(s));
  s = ai.shift(a, tex(-1.5, 0), W, H);
  assert.ok(Math.abs(s.dx + 1.5) < 0.4, JSON.stringify(s));
  s = ai.shift(new Uint8Array(W * H).fill(90), new Uint8Array(W * H).fill(90), W, H);
  assert.deepEqual([s.dx, s.dy], [0, 0]);
  assert.ok(ai.diff(a, a) === 0 && ai.diff(a, tex(5)) > 0.02);
});

test('finishSeries／suggestRanges：穩定運鏡不算晃，亂晃與過曝的段落排除', () => {
  const mk = (t, vx, o = {}) => Object.assign({ t, luma: 0.5, over: 0, under: 0, sharp: 100, vx, vy: 0, change: 0.01, p1: 0.02, p99: 0.95, sat: 0.3 }, o);
  const S = [];
  for (let i = 0; i < 6; i++) S.push(mk(i * 0.5, 8));                       // 0～3 秒：穩定往一邊搖
  for (let i = 6; i < 10; i++) S.push(mk(i * 0.5, i % 2 ? 15 : -15));       // 3～5 秒：亂晃
  for (let i = 10; i < 16; i++) S.push(mk(i * 0.5, 0));                     // 5～8 秒：腳架
  for (let i = 16; i < 20; i++) S.push(mk(i * 0.5, 0, { over: 0.6 }));      // 8～10 秒：過曝
  ai.finishSeries(S);
  assert.ok(S[2].shake < 1 && S[7].shake > 20);
  const r = ai.suggestRanges(S, 0.5, 10);
  assert.deepEqual(r, [{ in: 0, out: 2.5, motion: 'moving' }, { in: 5.5, out: 8, motion: 'static' }]);
  const pk = ai.packSeries(S, 0.5);
  assert.equal(pk.luma.length, 20); assert.equal(pk.panX[0], 8); assert.equal(pk.over[17], 60);
  assert.equal(ai.sampleStep(60), 0.5); assert.equal(ai.sampleStep(600), 2.5);
});

test('energy：每 0.5 秒一格，最大＝100', () => {
  const sr = 8000, x = new Float32Array(sr * 2);
  for (let i = sr; i < sr * 2; i++) x[i] = Math.sin(i * 0.3);
  const e = ai.energy([x], sr);
  assert.equal(e.length, 4); assert.ok(e[0] === 0 && e[3] === 100);
});

test('detectGamma：讀 Sony 內嵌的 CaptureGammaEquation；looksLog 從畫面猜', () => {
  const bytes = s => Uint8Array.from(Buffer.from(s, 'latin1'));
  const xml = v => `\0\0ftypXAVC<NonRealTimeMeta><Item name="CaptureGammaEquation" value="${v}"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/>`;
  assert.deepEqual(ai.detectGamma(bytes(xml('s-log3-cine'))), { gamma: 'slog3', raw: 's-log3-cine' });
  assert.equal(ai.detectGamma(bytes(xml('s-cinetone'))).gamma, 'scinetone');
  assert.equal(ai.detectGamma(bytes(xml('rec709'))).gamma, 'std');
  assert.equal(ai.detectGamma(bytes('moov....mdat')), null);
  assert.equal(ai.looksLog([{ p1: 0.1, p99: 0.6, sat: 0.08 }]), true);
  assert.equal(ai.looksLog([{ p1: 0.01, p99: 0.97, sat: 0.3 }]), false);
});

test('slog3Lut：18% 灰落在中間調、黑白單調遞增、中性灰不偏色；applyLut', () => {
  assert.ok(Math.abs(ai.slog3ToLinear(420 / 1023) - 0.18) < 1e-9);
  assert.ok(Math.abs(ai.slog3ToLinear(95 / 1023)) < 1e-9);
  const lut = ai.slog3Lut();
  assert.equal(lut.data.length, 33 ** 3 * 3);
  const mid = ai.sampleLut(lut, 420 / 1023, 420 / 1023, 420 / 1023);
  assert.ok(mid[0] > 100 && mid[0] < 135, '18% 灰 → 約 40～53%：' + mid[0]);
  assert.ok(Math.abs(mid[0] - mid[1]) <= 2 && Math.abs(mid[1] - mid[2]) <= 2, '灰階不偏色');
  let prev = -1;
  for (let i = 0; i <= 16; i++) { const v = ai.sampleLut(lut, i / 16, i / 16, i / 16)[0]; assert.ok(v >= prev); prev = v; }
  assert.ok(ai.sampleLut(lut, 0.09, 0.09, 0.09)[0] < 12 && ai.sampleLut(lut, 1, 1, 1)[0] > 245);
  const red = ai.sampleLut(lut, 0.55, 0.35, 0.35);
  assert.ok(red[0] > red[1] + 20, 'Log 的淡紅 → 飽和的紅');
  const px = ai.applyLut(new Uint8ClampedArray([107, 107, 107, 255]), lut);
  assert.ok(px[0] > 100 && px[3] === 255);
});

test('planSheets：每秒一格，太多就拉大間隔；短片至少 2 格、照片 1 格', () => {
  let p = ai.planSheets([{ code: 'C01', duration: 3.2 }, { code: 'C02', duration: 0 }, { code: 'C03', duration: 1.5 }]);
  assert.equal(p.interval, 1);
  assert.deepEqual(p.cells.map(c => `${c.code}@${c.t}`), ['C01@0', 'C01@1', 'C01@2', 'C01@3', 'C02@0', 'C03@0', 'C03@1']);
  p = ai.planSheets([{ code: 'C01', duration: 500 }, { code: 'C02', duration: 390 }], 300);
  assert.equal(p.interval, 3); assert.equal(p.cells.length, 167 + 130);
  assert.equal(ai.planSheets([{ code: 'C01', duration: 1.2 }]).cells.length, 2);
});

test('buildSummary：自我說明＋素材對照表＋數列；parseScriptText 讀整段回覆', () => {
  const caps = { aspects: ['9:16'], transitions: ['crossDissolve'], motions: ['zoomIn'], looks: ['none', 'warm'], cc: ['exposure'], fits: ['fit', 'fill'], letterboxes: ['none'], titlePresets: { static: '靜態字幕' } };
  const samples = [0, 0.5, 1, 1.5, 2].map(t => ({ t, luma: 0.5, over: 0, under: 0, sharp: 50, vx: 0, vy: 0, change: 0, p1: 0, p99: 1, sat: 0.3 }));
  const s = ai.buildSummary({ project: { aspect: '9:16', width: 1080, height: 1920, fps: 30 }, caps, interval: 1, sheets: ['sheet-01.jpg'],
    clips: [{ code: 'C01', name: 'A.MP4', kind: 'video', duration: 2.5, width: 3840, height: 2160, fps: 59.94, hasAudio: true, gamma: 'slog3', gammaFrom: 'file', samples, step: 0.5 },
      { code: 'C02', name: 'B.JPG', kind: 'image', width: 6000, height: 4000 }],
    music: { code: 'M1', name: 'song.mp3', duration: 30, bpm: 120, beats: [0.5, 1], energy: [10, 100] } });
  assert.equal(s.qcSummary, 1);
  assert.deepEqual(s.media, { C01: 'A.MP4', C02: 'B.JPG', M1: 'song.mp3' });
  assert.match(s.forClaude, /qcScript/); assert.match(s.forClaude, /crossDissolve/); assert.match(s.forClaude, /static（靜態字幕）/);
  assert.equal(s.clips[0].slowMoOk, true); assert.deepEqual(s.clips[0].ranges, [{ in: 0, out: 2.5, motion: 'static' }]);
  assert.equal(s.clips[1].series, undefined);
  assert.ok(JSON.stringify(s).length < 12000);

  const js = '{ "qcScript": 1, "shots": [] }';
  assert.ok(ai.parseScriptText(js).ok);
  assert.equal(ai.parseScriptText('構想：先山後海。\n```json\n' + js + '\n```\n需要再調整請說。').script.qcScript, 1);
  assert.equal(ai.parseScriptText('好的！' + js).script.qcScript, 1);
  assert.match(ai.parseScriptText('{ "qcSummary": 1 }').reason, /摘要包/);
  assert.match(ai.parseScriptText('亂寫').reason, /讀不出/);
  assert.equal(ai.parseScriptText('').ok, false);
});
