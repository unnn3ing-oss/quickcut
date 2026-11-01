// 剪輯：畫面數學、轉場、字幕的純邏輯測試（node 內跑，畫面用記錄呼叫的假 ctx）
const test = require('node:test');
const assert = require('node:assert/strict');
require('../edit-core.js');   // 關鍵影格內插（core.keyframeValue）
const fx = require('../edit-fx.js');
const fxgl = require('../edit-fx-gl.js');   // 載入時把 WebGL 轉場加進 fx.TRANSITIONS（node 沒有 WebGL → 退回交叉疊化）

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearPt = (p, x, y, eps = 1e-6) => { near(p[0], x, eps); near(p[1], y, eps); };
const clipOf = (tr = {}, extra = {}) => ({ id: 'c1', type: 'media', duration: 90, video: { transform: { ...fx.DEFAULT_TRANSFORM, ...tr }, crop: { ...fx.DEFAULT_CROP }, fit: 'fit', ...extra } });

// 記錄呼叫的假 ctx：measureText 每個字寬 = 字級 px
function mockCtx() {
  const log = [];
  const state = { font: '10px sans-serif', globalAlpha: 1 };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === '__log') return log;
      if (k === 'measureText') return s => { const px = +/([\d.]+)px/.exec(state.font)[1]; return { width: Array.from(String(s)).length * px }; };
      if (k === 'createLinearGradient') return (...a) => { log.push(['createLinearGradient', ...a]); return { addColorStop() {} }; };
      if (k in state) return state[k];
      return (...a) => { log.push([k, ...a]); };
    },
    set(_, k, v) { state[k] = v; log.push(['set:' + k, v]); return true; },
  });
  return ctx;
}
const calls = (ctx, name) => ctx.__log.filter(e => e[0] === name);

// ---- fitRect ----
test('fitRect：fit／fill／stretch', () => {
  let r = fx.fitRect(200, 100, 100, 100, 'fit');
  assert.deepEqual([r.sx, r.sy, r.w, r.h], [0.5, 0.5, 100, 50]);
  r = fx.fitRect(200, 100, 100, 100, 'fill');
  assert.deepEqual([r.sx, r.sy, r.w, r.h], [1, 1, 200, 100]);
  r = fx.fitRect(200, 100, 100, 100, 'stretch');
  assert.deepEqual([r.sx, r.sy, r.w, r.h], [0.5, 1, 100, 100]);
  r = fx.fitRect(100, 200, 1080, 1920, undefined);       // 沒給模式 = fit
  near(r.sx, 9.6);
});

// ---- clipMatrix ----
test('clipMatrix：預設值 = 來源對到輸出（fit），中心對中心', () => {
  const m = fx.clipMatrix(clipOf(), 200, 100, 400, 400, 0);   // fit → 倍率 2，高 200
  nearPt(fx.applyMatrix(m, 100, 50), 200, 200);
  nearPt(fx.applyMatrix(m, 0, 0), 0, 100);
  nearPt(fx.applyMatrix(m, 200, 100), 400, 300);
});
test('clipMatrix：縮放／位置（位置單位是輸出像素、畫面中心為原點）', () => {
  const m = fx.clipMatrix(clipOf({ zoomX: 2, zoomY: 5, zoomLinked: true, posX: 30, posY: -20 }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(m, 50, 50), 80, 30);            // 中心 + 位移
  nearPt(fx.applyMatrix(m, 100, 50), 180, 30);          // 連結時 Y 也用 zoomX：右邊中點水平 +50*2
  const m2 = fx.clipMatrix(clipOf({ zoomX: 2, zoomY: 0.5, zoomLinked: false }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(m2, 100, 100), 150, 75);
});
test('clipMatrix：旋轉 90°（順時針）', () => {
  const m = fx.clipMatrix(clipOf({ rotation: 90 }), 200, 100, 200, 100, 0);
  nearPt(fx.applyMatrix(m, 0, 0), 150, -50);            // 左上角轉到右上角之外
  nearPt(fx.applyMatrix(m, 200, 0), 150, 150);
  nearPt(fx.applyMatrix(m, 100, 50), 100, 50);          // 中心不動
});
test('clipMatrix：水平／垂直翻轉', () => {
  let m = fx.clipMatrix(clipOf({ flipH: true }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(m, 0, 0), 100, 0);
  nearPt(fx.applyMatrix(m, 100, 100), 0, 100);
  m = fx.clipMatrix(clipOf({ flipV: true }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(m, 0, 0), 0, 100);
  m = fx.clipMatrix(clipOf({ flipH: true, rotation: 90 }), 100, 100, 100, 100, 0);   // 先翻轉再旋轉：右上 → 翻到左上 → 順轉到右上
  nearPt(fx.applyMatrix(m, 100, 0), 100, 0);
});
test('clipMatrix：錨點是縮放／旋轉的軸心，不縮不轉時改錨點影像不動', () => {
  const still = fx.clipMatrix(clipOf({ anchorX: 40, anchorY: -30 }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(still, 0, 0), 0, 0);
  nearPt(fx.applyMatrix(still, 100, 100), 100, 100);
  // 以影像中心右邊 50px（= 來源右緣）為錨點放大 2 倍：右緣不動，左緣往左伸
  const z = fx.clipMatrix(clipOf({ anchorX: 50, zoomX: 2 }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(z, 100, 50), 100, 50);
  nearPt(fx.applyMatrix(z, 0, 50), -100, 50);
  // 以右緣為軸心轉 90°：右緣中點不動，中心轉到它的上方／下方
  const r = fx.clipMatrix(clipOf({ anchorX: 50, rotation: 90 }), 100, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(r, 100, 50), 100, 50);
  nearPt(fx.applyMatrix(r, 50, 50), 100, 0);
});
test('clipMatrix：fill 與 stretch 的基準', () => {
  const m = fx.clipMatrix(clipOf({}, { fit: 'fill' }), 200, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(m, 0, 0), -50, 0);
  const s = fx.clipMatrix(clipOf({}, { fit: 'stretch' }), 200, 100, 100, 100, 0);
  nearPt(fx.applyMatrix(s, 200, 100), 100, 100);
});

// ---- cropRect ----
test('cropRect：比例換成來源像素；夾住不會吃光', () => {
  const c = clipOf(); c.video.crop = { left: 0.1, right: 0.2, top: 0.25, bottom: 0, softness: 0 };
  const r = fx.cropRect(c, 1000, 400);
  assert.deepEqual([r.sx, r.sy, r.sw, r.sh], [100, 100, 700, 300]);
  const d = clipOf(); d.video.crop = { left: 0.9, right: 0.9, top: 0, bottom: 0, softness: 0 };
  const e = fx.cropRect(d, 100, 100);
  assert.ok(e.sw >= 1 - 1e-9 && e.sx + e.sw <= 100 + 1e-9);
  assert.deepEqual(fx.cropRect({}, 50, 50), { sx: 0, sy: 0, sw: 50, sh: 50 });
});

// ---- getParam ----
test('getParam：靜態值、預設值、關鍵格內插', () => {
  const c = clipOf({ zoomX: 1.5 });
  assert.equal(fx.getParam(c, 'video.transform.zoomX', 10), 1.5);
  assert.equal(fx.getParam({}, 'video.transform.opacity', 0), 1);       // 沒有 video 也有預設
  assert.equal(fx.getParam(c, 'video.fit', 0), 'fit');
  c.keyframes = { 'video.transform.zoomX': [{ f: 30, v: 3 }, { f: 0, v: 1 }, { f: 60, v: 2, interp: 'hold' }] };
  assert.equal(fx.getParam(c, 'video.transform.zoomX', -5), 1);         // 之前 = 第一個
  near(fx.getParam(c, 'video.transform.zoomX', 15), 2);                 // 線性
  near(fx.getParam(c, 'video.transform.zoomX', 45), 2.5);
  assert.equal(fx.getParam(c, 'video.transform.zoomX', 99), 2);         // 之後 = 最後一個
  c.keyframes = { 'video.transform.flipH': [{ f: 0, v: false }, { f: 10, v: true }] };
  assert.equal(fx.getParam(c, 'video.transform.flipH', 5), false);      // 非數字 = hold
  c.keyframes = { 'video.transform.zoomX': [{ f: 0, v: 1, interp: 'hold' }, { f: 10, v: 5 }] };
  assert.equal(fx.getParam(c, 'video.transform.zoomX', 9), 1);
});
test('clipMatrix 透過 getParam 吃關鍵格', () => {
  const c = clipOf(); c.keyframes = { 'video.transform.posX': [{ f: 0, v: 0 }, { f: 10, v: 100 }] };
  const m = fx.clipMatrix(c, 100, 100, 100, 100, 5);
  nearPt(fx.applyMatrix(m, 50, 50), 100, 50);
});

// ---- 換行 ----
const mw = s => Array.from(s).length * 10;
test('wrapText：中文依寬度換行，行首不放標點', () => {
  const lines = fx.wrapText(mw, '一二三四五六七八九十，十一', 100);
  assert.deepEqual(lines, ['一二三四五六七八九', '十，十一']);          // 「，」不能在行首 → 把「十」一起帶下去
  for (const t of ['今天天氣很好，我們去公園玩！大家都很開心。', '「你好」他說：「再見！」', '一二三四五六七八九？？？']) {
    for (const l of fx.wrapText(mw, t, 100)) {
      assert.ok(mw(l) <= 110, l);                                       // 沒有超寬（最多容許標點掛一格的情況）
      assert.ok(!/^[，。、！？；：）」』】》…]/.test(l), '行首不得是標點：' + l);
      assert.ok(!/[（「『【《]$/.test(l), '行尾不得是開括號：' + l);
    }
  }
});
test('wrapText：開括號不留在行尾；英數單字不拆；超長單字硬拆；保留手動換行', () => {
  assert.deepEqual(fx.wrapText(mw, '一二三四五六七八九「十」', 100), ['一二三四五六七八九', '「十」']);
  assert.deepEqual(fx.wrapText(mw, 'ab cd efgh ij', 70), ['ab cd', 'efgh ij']);
  assert.deepEqual(fx.wrapText(mw, '12345678901234', 60), ['123456', '789012', '34']);
  assert.deepEqual(fx.wrapText(mw, '第一行\n\n第三行', 200), ['第一行', '', '第三行']);
  assert.deepEqual(fx.wrapText(mw, '', 100), ['']);
  assert.deepEqual(fx.wrapText(mw, 'abc', 5), ['a', 'b', 'c']);        // 比一個字還窄也要結束
});

// ---- 顏色 ----
test('parseColor／formatColor', () => {
  assert.deepEqual(fx.parseColor('#fa0'), { hex: '#ffaa00', a: 1 });
  assert.deepEqual(fx.parseColor('rgba(0,0,0,.6)'), { hex: '#000000', a: 0.6 });
  assert.deepEqual(fx.parseColor('rgba(255, 128, 0, 0)'), { hex: '#ff8000', a: 0 });
  assert.deepEqual(fx.parseColor('#11223380'), { hex: '#112233', a: 0.502 });
  assert.equal(fx.formatColor('#ff8000', 1), '#ff8000');
  assert.equal(fx.formatColor('#ff8000', 0.5), 'rgba(255,128,0,0.5)');
  assert.deepEqual(fx.parseColor(fx.formatColor('#123456', 0.25)), { hex: '#123456', a: 0.25 });
});

// ---- drawClipVisual / drawSolid ----
test('drawClipVisual：套矩陣、裁切來源、不透明度', () => {
  const ctx = mockCtx();
  const c = clipOf({ opacity: 0.5, zoomX: 2 });
  c.video.crop.left = 0.5;
  fx.drawClipVisual(ctx, c, { tag: 'src' }, 200, 100, 200, 100, 0);
  const [, ...args] = calls(ctx, 'transform')[0];
  assert.deepEqual(args.map(v => +v.toFixed(6)), [2, 0, 0, 2, -100, -50]);
  const [, , sx, sy, sw, sh] = calls(ctx, 'drawImage')[0];
  assert.deepEqual([sx, sy, sw, sh], [100, 0, 100, 100]);
  assert.ok(ctx.__log.some(e => e[0] === 'set:globalAlpha' && e[1] === 0.5));
  assert.ok(calls(ctx, 'save').length === calls(ctx, 'restore').length);
  const ctx2 = mockCtx();
  fx.drawClipVisual(ctx2, clipOf({ opacity: 0 }), {}, 10, 10, 10, 10, 0);
  assert.equal(calls(ctx2, 'drawImage').length, 0);
  fx.drawClipVisual(ctx2, clipOf(), null, 10, 10, 10, 10, 0);          // 沒有來源 = 不畫
  assert.equal(calls(ctx2, 'drawImage').length, 0);
});
test('drawClipVisual：模糊背景（fit＝blur）先畫蓋滿的小圖再畫本體，大小跟著 bgBlur', () => {
  const made = [];
  fx._setCanvasFactory((w, h) => { const cx = mockCtx(); const cv = { width: w, height: h, getContext: () => cx, cx }; made.push(cv); return cv; });
  let r = fx.fitRect(1920, 1080, 1080, 1920, 'blur');
  assert.deepEqual([+r.sx.toFixed(4), r.w], [0.5625, 1080]);          // 本體和 fit 一樣
  const c = clipOf(); c.video.fit = 'blur';
  const ctx = mockCtx();
  fx.drawClipVisual(ctx, c, { tag: 'src' }, 1920, 1080, 1080, 1920, 0);
  const bg = made[made.length - 1];
  assert.deepEqual([bg.width, bg.height], [Math.round(1080 * 0.066) + 6, Math.round(1920 * 0.066) + 6]);   // 預設 50：k = 0.066，四周各多 3px
  const di = calls(ctx, 'drawImage');
  assert.equal(di.length, 2, '背景＋本體');
  assert.equal(di[0][1], bg);
  assert.deepEqual(di[0].slice(2), [3, 3, bg.width - 6, bg.height - 6, 0, 0, 1080, 1920]);   // 取中間、蓋滿輸出
  assert.deepEqual(di[1][1], { tag: 'src' });
  // 小圖用 cover：1920×1080 放進直式小圖，高度剛好、寬度超出
  const sd = calls(bg.cx, 'drawImage')[0];
  assert.ok(Math.abs(sd[9] - bg.height) < 1e-6 && sd[8] > bg.width);
  // bgBlur 100 → 更小
  c.video.bgBlur = 100; made.length = 0;
  fx.drawClipVisual(mockCtx(), c, {}, 1920, 1080, 1080, 1920, 0);
  assert.deepEqual([made[0].width, made[0].height], [Math.round(1080 * 0.012) + 6, Math.round(1920 * 0.012) + 6]);
  // 一般 fit 不畫背景
  const ctx3 = mockCtx(); const c3 = clipOf();
  fx.drawClipVisual(ctx3, c3, {}, 1920, 1080, 1080, 1920, 0);
  assert.equal(calls(ctx3, 'drawImage').length, 1);
  // 不透明度 0：連背景都不畫
  const ctx4 = mockCtx(); const c4 = clipOf({ opacity: 0 }); c4.video.fit = 'blur';
  fx.drawClipVisual(ctx4, c4, {}, 1920, 1080, 1080, 1920, 0);
  assert.equal(calls(ctx4, 'drawImage').length, 0);
  assert.deepEqual(fx.FIT_OPTIONS.map(o => o[0]), ['fit', 'blur', 'fill', 'stretch']);
});
test('drawClipVisual：柔邊走離屏遮罩', () => {
  const made = [];
  fx._setCanvasFactory((w, h) => { const cx = mockCtx(); const cv = { width: w, height: h, getContext: () => cx, cx }; made.push(cv); return cv; });
  const ctx = mockCtx();
  const c = clipOf(); c.video.crop = { left: 0.2, right: 0, top: 0, bottom: 0.2, softness: 0.5 };
  fx.drawClipVisual(ctx, c, {}, 100, 100, 100, 100, 0);
  assert.equal(made.length, 1);
  assert.equal(calls(made[0].cx, 'createLinearGradient').length, 2);    // 只有有裁切的兩邊羽化
  assert.equal(calls(ctx, 'drawImage')[0][1], made[0]);
  fx.drawClipVisual(ctx, c, {}, 100, 100, 100, 100, 0);
  assert.equal(made.length, 1);                                          // 重複使用同一個離屏畫布
});
test('drawSolid：用純色填滿裁切後的矩形', () => {
  const ctx = mockCtx();
  fx.drawSolid(ctx, { solidColor: '#ff0000', video: fx.defaultVideo() }, 192, 108, 0);
  assert.ok(ctx.__log.some(e => e[0] === 'set:fillStyle' && e[1] === '#ff0000'));
  assert.deepEqual(calls(ctx, 'fillRect')[0].slice(1), [0, 0, 192, 108]);
});

// ---- 轉場 ----
test('轉場：t=0 只畫 A、t=1 只畫 B，中間兩者都畫', () => {
  fx._setCanvasFactory((w, h) => { const cx = mockCtx(); return { width: w, height: h, getContext: () => cx }; });
  const types = ['crossDissolve', 'dipToColor', 'fadeToBlack', 'wipe', 'push', 'slide', 'zoom', 'blur',
    'whip', 'flash', 'glitch', 'zoomPunch', 'spin', 'lightLeak', 'blinds', 'pixelate', 'flip', 'cube', 'doors'];
  assert.deepEqual(Object.keys(fx.TRANSITIONS).sort(), types.slice().sort());
  const run = (type, t, opts = {}) => {
    const hits = { A: 0, B: 0 };
    const ctx = mockCtx();
    fx.TRANSITIONS[type].draw(ctx, () => { hits.A++; }, () => { hits.B++; }, t, { type, color: '#ff00ff', direction: 'left', ease: 'linear', ...opts }, 320, 180);
    return { hits, ctx };
  };
  for (const type of types) {
    assert.ok(fx.TRANSITIONS[type].name, type + ' 要有中文名');
    for (const dir of ['left', 'right', 'up', 'down']) for (const easeK of ['linear', 'easeInOut']) {
      const a = run(type, 0, { direction: dir, ease: easeK }), b = run(type, 1, { direction: dir, ease: easeK });
      assert.deepEqual(a.hits, { A: 1, B: 0 }, `${type} t=0`);
      assert.deepEqual(b.hits, { A: 0, B: 1 }, `${type} t=1`);
      assert.equal(calls(a.ctx, 'drawImage').length + calls(a.ctx, 'fillRect').length, 0, `${type} t=0 不該多畫東西`);
    }
    const mid = run(type, 0.3);
    assert.ok(mid.hits.A >= 1, type + ' 中段要畫 A');
    if (type !== 'dipToColor' && type !== 'fadeToBlack') assert.ok(mid.hits.B >= 1, type + ' 中段要畫 B');
  }
  // 浸入顏色：前半 A、後半 B，中點顏色最濃
  assert.deepEqual(run('dipToColor', 0.25).hits, { A: 1, B: 0 });
  assert.deepEqual(run('dipToColor', 0.75).hits, { A: 0, B: 1 });
  // 沒有 B（淡出到黑）：全程畫 A，疊的黑色不透明度隨 t 增加
  const single = run('fadeToBlack', 0.8, { single: true });
  assert.deepEqual(single.hits, { A: 1, B: 0 });
  assert.ok(single.ctx.__log.some(e => e[0] === 'set:globalAlpha' && Math.abs(e[1] - 0.8) < 1e-9));
  const viaRight = run('dipToColor', 0.8, { rightClipId: null });
  assert.deepEqual(viaRight.hits, { A: 1, B: 0 });
  // 緩動不改變端點
  assert.equal(fx.ease(0, 'easeInOut'), 0); assert.equal(fx.ease(1, 'easeInOut'), 1);
  near(fx.ease(0.5, 'easeInOut'), 0.5); assert.ok(fx.ease(0.25, 'easeInOut') < 0.25);
});
test('轉場：推擠／滑入的位移方向', () => {
  fx._setCanvasFactory((w, h) => { const cx = mockCtx(); return { width: w, height: h, getContext: () => cx }; });
  const ctx = mockCtx();
  fx.TRANSITIONS.push.draw(ctx, () => {}, () => {}, 0.25, { direction: 'left' }, 400, 200);
  const d = calls(ctx, 'drawImage').map(a => a.map(v => v || 0));
  assert.deepEqual([d[0][2], d[0][3]], [-100, 0]);        // A 往左
  assert.deepEqual([d[1][2], d[1][3]], [300, 0]);         // B 從右邊進來
  const ctx2 = mockCtx();
  fx.TRANSITIONS.push.draw(ctx2, () => {}, () => {}, 0.5, { direction: 'down' }, 400, 200);
  const e = calls(ctx2, 'drawImage').map(a => a.map(v => v || 0));
  assert.deepEqual([e[0][2], e[0][3]], [0, 100]);
  assert.deepEqual([e[1][2], e[1][3]], [0, -100]);
  const ctx3 = mockCtx();
  fx.TRANSITIONS.wipe.draw(ctx3, () => {}, () => {}, 0.25, { direction: 'right' }, 400, 200);
  const rects = calls(ctx3, 'rect');
  assert.deepEqual(rects[0].slice(1), [100, 0, 300, 200]);   // A 剩下右邊
  assert.deepEqual(rects[1].slice(1), [0, 0, 100, 200]);     // B 從左邊長出來
});

test('WebGL 轉場：清單、選項欄位、和 core 的種類一致', () => {
  const core = require('../edit-core.js');
  const glTypes = Object.keys(fxgl.DEFS);
  assert.deepEqual(glTypes.sort(), ['blinds', 'cube', 'doors', 'flash', 'flip', 'glitch', 'lightLeak', 'pixelate', 'spin', 'whip', 'zoomPunch']);
  for (const k of Object.keys(fx.TRANSITIONS)) assert.ok(core.TRANSITION_TYPES.includes(k), k + ' 要在 core.TRANSITION_TYPES 裡');
  assert.equal(core.TRANSITION_TYPES.length, Object.keys(fx.TRANSITIONS).length);
  for (const k of glTypes) {
    const d = fx.TRANSITIONS[k];
    assert.ok(d.gl && d.name && typeof d.draw === 'function', k);
    assert.ok(d.dirs === null || ['four', 'spin', 'doors'].includes(d.dirs), k + ' dirs');
    assert.ok(d.thumbT > 0 && d.thumbT < 1, k + ' thumbT');
  }
  assert.deepEqual(['whip', 'blinds', 'flip', 'cube'].map(k => fx.TRANSITIONS[k].dirs), ['four', 'four', 'four', 'four']);
  assert.equal(fx.TRANSITIONS.spin.dirs, 'spin'); assert.equal(fx.TRANSITIONS.doors.dirs, 'doors');
  assert.deepEqual(Object.keys(fx.TRANSITIONS).filter(k => fx.TRANSITIONS[k].color).sort(), ['dipToColor', 'flash', 'lightLeak']);
  assert.deepEqual(['wipe', 'push', 'slide'].map(k => fx.TRANSITIONS[k].dirs), ['four', 'four', 'four']);
  // 每支著色器都要宣告 tr()（共用的 main 會呼叫它）
  for (const k of glTypes) assert.match(fxgl.DEFS[k].frag, /vec4 tr\(\)\{/, k);
});
test('WebGL 轉場：沒有 WebGL 時退回交叉疊化（中段 A、B 都畫，端點只畫一邊）', () => {
  fx._setCanvasFactory((w, h) => { const cx = mockCtx(); return { width: w, height: h, getContext: () => cx }; });
  assert.equal(fxgl.available(), false);
  const hits = { A: 0, B: 0 };
  const ctx = mockCtx();
  fx.TRANSITIONS.cube.draw(ctx, () => { hits.A++; }, () => { hits.B++; }, 0.4, { direction: 'up', ease: 'linear' }, 320, 180);
  assert.deepEqual(hits, { A: 1, B: 1 });
});

// ---- 字幕 ----
test('makeTitle／TITLE_PRESETS', () => {
  const t = fx.makeTitle('lowerThird', '哈囉');
  assert.equal(t.preset, 'lowerThird'); assert.equal(t.text, '哈囉'); assert.equal(t.font, 'WHZ-Heavy');
  assert.equal(t.align, 'left');
  assert.equal(fx.makeTitle('不存在').preset, 'static');
  assert.deepEqual(Object.keys(fx.TITLE_PRESETS), ['static', 'lowerThird', 'scroll', 'crawl', 'typewriter', 'fadeUp']);
  for (const k in fx.TITLE_PRESETS) assert.ok(fx.TITLE_PRESETS[k].name);
});
const titleClip = (preset, text, dur = 90, extra = {}) => ({ id: 't', type: 'title', duration: dur, video: fx.defaultVideo(), title: { ...fx.makeTitle(preset, text), ...extra } });
const texts = ctx => calls(ctx, 'fillText').map(e => e.slice(1));

test('drawTitle：static 置中、字級依短邊縮放、有描邊與陰影', () => {
  const ctx = mockCtx();
  fx.drawTitle(ctx, titleClip('static', '你好', 90, { stroke: { color: '#000', width: 4 } }), 1920, 1080, 0, 30);
  const [s, x, y] = texts(ctx)[0];
  assert.equal(s, '你好'); near(x, 960); near(y, 540);
  assert.equal(calls(ctx, 'strokeText').length, 1);
  assert.ok(ctx.__log.some(e => e[0] === 'set:font' && /80px "WHZ-Heavy"/.test(e[1])));
  const ctx2 = mockCtx();
  fx.drawTitle(ctx2, titleClip('static', '你好'), 960, 540, 0, 30);        // 一半大小的輸出，字級跟著減半
  assert.ok(ctx2.__log.some(e => e[0] === 'set:font' && /40px "WHZ-Heavy"/.test(e[1])));
  fx.drawTitle(ctx2, { id: 'x', duration: 5 }, 100, 100, 0, 30);          // 沒有 title 不畫也不丟錯
});
test('drawTitle：長句依寬度自動換行', () => {
  const ctx = mockCtx();
  fx.drawTitle(ctx, titleClip('static', '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'), 1000, 1000, 0, 30);   // 每字 ~74px，可用寬度 900
  const t = texts(ctx);
  assert.ok(t.length >= 3, '應換成多行：' + t.length);
  assert.equal(t.map(a => a[0]).join(''), '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十');
});
test('drawTitle：打字機逐字出現', () => {
  const n = f => { const ctx = mockCtx(); fx.drawTitle(ctx, titleClip('typewriter', '一二三四五六七八九十', 90), 1000, 1000, f, 30); return texts(ctx).map(a => a[0]).join('').length; };
  assert.equal(n(0), 0);
  const mid = n(10);
  assert.ok(mid > 0 && mid < 10, String(mid));
  assert.equal(n(80), 10);
  assert.ok(n(5) <= n(10) && n(10) <= n(20));
});
test('drawTitle：捲動由下往上、跑馬燈由右往左', () => {
  const yAt = f => { const ctx = mockCtx(); fx.drawTitle(ctx, titleClip('scroll', '字幕', 60), 1000, 1000, f, 30); return texts(ctx)[0][2]; };
  assert.ok(yAt(0) > 1000 - 1, '開始時在畫面下緣之外');
  assert.ok(yAt(30) < yAt(0) && yAt(59) < yAt(30));
  assert.ok(yAt(59) < 0 + 80, '結束時已經到畫面上緣');
  const xAt = f => { const ctx = mockCtx(); fx.drawTitle(ctx, titleClip('crawl', '跑馬燈文字', 60), 1000, 1000, f, 30); return texts(ctx)[0][1]; };
  assert.ok(xAt(0) >= 1000 - 1);
  assert.ok(xAt(30) < xAt(0) && xAt(59) < xAt(30));
});
test('drawTitle：淡入上移與下三分之一條在開頭是透明的', () => {
  const alphaAt = (preset, f) => { const ctx = mockCtx(); fx.drawTitle(ctx, titleClip(preset, '字幕', 90), 1000, 1000, f, 30); const a = ctx.__log.filter(e => e[0] === 'set:globalAlpha').map(e => e[1]); return a.length ? a[a.length - 1] : 1; };
  for (const p of ['fadeUp', 'lowerThird']) {
    assert.equal(alphaAt(p, 0), 0);
    assert.ok(alphaAt(p, 3) > 0 && alphaAt(p, 3) < 1);
    assert.equal(alphaAt(p, 45), 1);
    assert.ok(alphaAt(p, 89) < 1, p + ' 結尾淡出');
  }
});
test('drawTitle：不透明度為 0 不畫', () => {
  const ctx = mockCtx();
  const c = titleClip('static', '字'); c.video.transform.opacity = 0;
  fx.drawTitle(ctx, c, 100, 100, 0, 30);
  assert.equal(texts(ctx).length, 0);
});

// ---- 檢查器（資料面；DOM 部分在 e2e 測） ----
test('inspector.sections：id、標題與適用對象', () => {
  const s = fx.inspector.sections;
  assert.deepEqual(s.map(x => x.id), ['transform', 'crop', 'title', 'titleLook', 'titleAnim', 'transition']);
  assert.deepEqual(s.map(x => x.title), ['變形', '裁切', '字幕文字', '字幕外觀', '字幕動畫', '轉場']);
  const by = id => s.find(x => x.id === id);
  const media = { id: 'a', type: 'media', video: fx.defaultVideo() };
  const title = titleClip('static', 'x');
  const audioOnly = { id: 'b', type: 'media' };
  const tr = { id: 'tr1', trackId: 't', leftClipId: 'a', rightClipId: null, type: 'wipe', duration: 15 };
  assert.ok(by('transform').appliesTo(media) && by('transform').appliesTo(title) && !by('transform').appliesTo(audioOnly) && !by('transform').appliesTo(tr));
  assert.ok(by('crop').appliesTo(media) && !by('crop').appliesTo(tr));
  for (const id of ['title', 'titleLook', 'titleAnim']) assert.ok(by(id).appliesTo(title) && !by(id).appliesTo(media) && !by(id).appliesTo(tr), id);
  assert.ok(by('transition').appliesTo(tr) && !by('transition').appliesTo(media));
});

test('字幕：*星號* 強調、外框疊層、立體、漸層', () => {
  assert.deepEqual(fx.parseAccent('進行*瘋狂*的'), { text: '進行瘋狂的', mask: [false, false, true, true, false] });
  assert.deepEqual(fx.parseAccent('3*4'), { text: '3*4', mask: null }, '落單的星號保留');
  const n = fx.normTitle({ text: 'a', outlines: [{ on: true, color: '#f00' }], extrude: { depth: 4 } });
  assert.equal(n.outlines.length, 4); assert.equal(n.outlines[0].width, 6); assert.equal(n.extrude.color, '#3a2386');
  // 強調：逐字畫，強調的字用強調色
  const ctx = mockCtx();
  fx.drawTitle(ctx, titleClip('static', '進行*瘋狂*', 90, { accent: '#e5141b' }), 1000, 1000, 0, 30);
  assert.equal(texts(ctx).map(a => a[0]).join(''), '進行瘋狂', '星號不會畫出來');
  const fills = ctx.__log.filter(e => e[0] === 'set:fillStyle' || e[0] === 'fillText');
  const colorOf = ch => { let c = null; for (const e of fills) { if (e[0] === 'set:fillStyle') c = e[1]; else if (e[1] === ch) return c; } return null; };
  assert.equal(colorOf('瘋'), '#e5141b'); assert.equal(colorOf('進'), '#ffffff');
  // 外框：描邊 4 + 兩層外框 6、10 → 由外往內 lineWidth 40、16、8
  const c2 = mockCtx();
  fx.drawTitle(c2, titleClip('static', '字', 90, { stroke: { color: '#000', width: 4 }, outlines: [{ on: true, color: '#fff', width: 6 }, { on: true, color: '#00f', width: 10 }] }), 1080, 1080, 0, 30);
  assert.deepEqual(c2.__log.filter(e => e[0] === 'set:lineWidth').map(e => e[1]), [40, 20, 8]);
  assert.equal(calls(c2, 'strokeText').length, 3);
  // 立體：深度 16 → 16 層，在主體之前畫
  const c3 = mockCtx();
  fx.drawTitle(c3, titleClip('static', '字', 90, { extrude: { depth: 16, color: '#333', angle: 45 } }), 1080, 1080, 0, 30);
  assert.equal(texts(c3).length, 17);
  // 漸層
  const c4 = mockCtx();
  fx.drawTitle(c4, titleClip('static', '字', 90, { gradient: { on: true, color: '#8fd8ff' } }), 1080, 1080, 0, 30);
  assert.equal(calls(c4, 'createLinearGradient').length, 1);
});
test('字體特效：彈出、逐字跳起', () => {
  const run = (fxName, f) => { const ctx = mockCtx(); fx.drawTitle(ctx, titleClip('static', '一二三四', 90, { textFx: fxName, textFxDur: 0.5 }), 1000, 1000, f, 30); return ctx; };
  const scaleAt = f => { const s = calls(run('pop', f), 'scale'); return s.length ? s[0][1] : 1; };
  assert.equal(scaleAt(0), 0, '開頭縮放 0');
  assert.ok(scaleAt(10) > 1, '中途超過 1（彈一下）：' + scaleAt(10));
  assert.ok(Math.abs(scaleAt(15) - 1) < 1e-9, '動畫結束回到 1');
  // 逐字跳起：第 2 格時第一個字已經出現，最後一個字還沒
  const c = run('jumpChar', 2);
  const drawn = texts(c).map(a => a[0]);
  assert.ok(drawn.includes('一') && !drawn.includes('四'), '逐字錯開：' + drawn);
  const end = texts(run('jumpChar', 80)).map(a => a[0]).join('');
  assert.equal(end, '一二三四', '結束時每個字都在');
  assert.ok(Object.keys(fx.TITLE_STYLES).length >= 5 && fx.TEXT_FX.jump && fx.TEXT_FX.pop);
});
test('字體特效：逐行跳起、逐行彈出（整行一起動，一行一行錯開）', () => {
  const run = (fxName, f) => { const ctx = mockCtx(); fx.drawTitle(ctx, titleClip('static', '第一行\n第二行', 90, { textFx: fxName, textFxDur: 0.5 }), 1000, 1000, f, 30); return ctx; };
  // 第 2 格：第一行開始了、第二行（晚 0.15 秒＝4.5 格）還沒
  assert.deepEqual(texts(run('jumpLine', 2)).map(a => a[0]), ['第一行'], '整行一次畫、第二行還沒出現');
  assert.deepEqual(texts(run('jumpLine', 80)).map(a => a[0]), ['第一行', '第二行']);
  const sc = calls(run('popLine', 0), 'scale');
  assert.ok(!texts(run('popLine', 0)).length && !sc.length, '彈出開頭縮放 0：什麼都不畫');
  assert.equal(calls(run('popLine', 80), 'scale')[0][1], 1, '結束時縮放回到 1');
});
test('選字變色：buildAccent 是 parseAccent 的反向', () => {
  assert.equal(fx.buildAccent('進行瘋狂的', [false, false, true, true, false]), '進行*瘋狂*的');
  assert.equal(fx.buildAccent('一\n二', [true, true, true]), '*一*\n*二*', '跨行時每行各自包');
  assert.equal(fx.buildAccent('abc', null), 'abc');
  const r = fx.parseAccent(fx.buildAccent('a*b', [false, false, true]));
  assert.deepEqual([r.text, r.mask], ['a＊b', [false, false, true]], '原本的星號換成全形，不會被當成標記');
});
test('SRT 解析：時間碼、多行、標籤、BOM、CRLF、重疊', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>第一句</i>\r\n第二行\r\n\r\n2\r\n00:00:03,000 --> 00:00:05,000\r\n{\\an8}第二句\r\n\r\n3\n00:20.5 --> 00:22.000\nHello\n\n4\n00:00:30,000 --> 00:00:30,000\n長度 0 不要\n';
  const c = fx.parseSrt(srt, 30);
  assert.deepEqual(c, [
    { start: 30, end: 90, text: '第一句\n第二行' },     // 原本到 3.5 秒，跟第二段重疊 → 結束在第二段開始的前一格
    { start: 90, end: 150, text: '第二句' },
    { start: 615, end: 660, text: 'Hello' },            // 省略小時、句點分隔
  ]);
  assert.deepEqual(fx.parseSrt('不是字幕', 30), []);
  // 同一格開始的只留第一段
  assert.deepEqual(fx.fitCues([{ start: 10, end: 50, text: 'a' }, { start: 10, end: 40, text: 'b' }]).map(x => x.text), ['a']);
});
test('SRT 匯出：formatSrt 時間碼、星號、空白段、排序；可以再匯入回來', () => {
  const cues = [
    { start: 615, end: 660, text: 'Hello' },
    { start: 30, end: 90, text: '進行*瘋狂*的\n 第二行 ' },
    { start: 100, end: 120, text: '   ' },
    { start: 3600 * 30 + 1, end: 3600 * 30 + 31, text: '一小時後' },
  ];
  const s = fx.formatSrt(cues, 30);
  assert.equal(s, '1\n00:00:01,000 --> 00:00:03,000\n進行瘋狂的\n第二行\n\n2\n00:00:20,500 --> 00:00:22,000\nHello\n\n3\n01:00:00,033 --> 01:00:01,033\n一小時後\n');
  assert.deepEqual(fx.parseSrt(s, 30).map(c => [c.start, c.end, c.text]), [[30, 90, '進行瘋狂的\n第二行'], [615, 660, 'Hello'], [108001, 108031, '一小時後']]);
  assert.equal(fx.formatSrt([], 30), '');
});
test('V 標記：預設 10 秒、碰到下一段就停、前一段在這格前結束', () => {
  const subs = [{ id: 'a', start: 0, end: 300 }, { id: 'b', start: 400, end: 500 }];
  assert.deepEqual(fx.planSubtitleMark(subs, 90, 30, 10), { start: 90, end: 390, trimPrev: { id: 'a', end: 90 } }, '前一段 a 改成在 89 格結束；新段 10 秒');
  assert.deepEqual(fx.planSubtitleMark(subs, 350, 30, 10), { start: 350, end: 400, trimPrev: null }, '碰到 b：結束在 b 開始的前一格');
  assert.deepEqual(fx.planSubtitleMark([], 0, 25, 10), { start: 0, end: 250, trimPrev: null });
  assert.deepEqual(fx.planSubtitleMark(subs, 400, 30, 10), { existing: 'b' }, '剛好是某段開頭：不重複加');
});

test('getParam：關鍵影格內插走 core.keyframeValue（ease 緩入緩出、clipMatrix 也跟著）', () => {
  const c = clipOf();
  c.keyframes = { 'video.transform.posX': [{ f: 0, v: 0, interp: 'ease' }, { f: 100, v: 100 }] };
  near(fx.getParam(c, 'video.transform.posX', 50), 50);
  const q = fx.getParam(c, 'video.transform.posX', 25);
  assert.ok(q < 25 && q > 0, `緩入：四分之一處小於 25（${q}）`);
  const m = fx.clipMatrix(c, 1920, 1080, 1920, 1080, 25);
  near(m[4], fx.getParam(c, 'video.transform.posX', 25));
});

test('drawClipVisual：濾鏡先在離屏用混合模式調色、還原 alpha，再當來源畫（模糊背景也用調過的）', () => {
  const made = [];
  fx._setCanvasFactory((w, h) => { const cx = mockCtx(); const cv = { width: w, height: h, getContext: () => cx, cx }; made.push(cv); return cv; });
  const src = { tag: 'src' };
  // 原色：直接畫來源、不做離屏
  const c0 = clipOf({}, { look: 'none' });
  const ctx0 = mockCtx();
  fx.drawClipVisual(ctx0, c0, src, 320, 180, 320, 180, 0);
  assert.equal(calls(ctx0, 'drawImage')[0][1], src);
  // 黑白：saturation 塗灰、destination-in 還原 alpha，畫到輸出的是離屏畫布
  for (const [look, op] of [['mono', 'saturation'], ['warm', 'soft-light'], ['cool', 'soft-light']]) {
    made.length = 0;
    const c = clipOf({}, { look, lookAmt: 50 });
    const ctx = mockCtx();
    fx.drawClipVisual(ctx, c, src, 320, 180, 320, 180, 0);
    const lk = calls(ctx, 'drawImage')[0][1];
    assert.ok(lk !== src && lk.cx && lk.width === 320 && lk.height === 180, look + '：輸出畫的是 320×180 的離屏');
    const log = lk.cx.__log;
    const ops = log.filter(e => e[0] === 'set:globalCompositeOperation').map(e => e[1]);
    assert.ok(ops.includes(op) && ops.includes('destination-in'), `${look}：用 ${op} 調色、destination-in 還原 alpha：${ops}`);
    const alpha = log.find(e => e[0] === 'set:globalAlpha' && e[1] < 1);
    assert.ok(alpha && alpha[1] > 0 && alpha[1] <= 0.5, `${look}：強度 50% → 混合透明度減半（${alpha && alpha[1]}）`);
    lk.cx.__log.length = 0;
  }
  // 強度 0：等於原色
  const ctx2 = mockCtx();
  fx.drawClipVisual(ctx2, clipOf({}, { look: 'mono', lookAmt: 0 }), src, 320, 180, 320, 180, 0);
  assert.equal(calls(ctx2, 'drawImage')[0][1], src);
  // 模糊背景也用調過色的畫面
  made.length = 0;
  const ctx3 = mockCtx();
  fx.drawClipVisual(ctx3, clipOf({}, { look: 'mono', fit: 'blur' }), src, 320, 180, 180, 320, 0);
  const lk3 = calls(ctx3, 'drawImage')[1][1];
  const bg = calls(ctx3, 'drawImage')[0][1];
  assert.equal(calls(bg.cx, 'drawImage')[0][1], lk3);
});
