// 示波器（edit-scope.js）統計函式的單元測試
const test = require('node:test');
const assert = require('node:assert');
const S = require('../edit-scope.js');

const fill = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; } return d; };

test('直方圖：純紅 R 全在 255，G／B 全在 0', () => {
  const h = S.scopeHistogram(fill(8, 8, () => [255, 0, 0]));
  assert.strictEqual(h[255], 64); assert.strictEqual(h[256 + 0], 64); assert.strictEqual(h[512 + 0], 64);
  assert.strictEqual(h[0], 0); assert.strictEqual(h[256 + 255], 0);
  assert.strictEqual(h[768 + 54], 64);   // 0.2126*255 ≈ 54
});

test('波形：上黑下白分到正確的列', () => {
  const w = 8, h = 8, rows = 11, cols = 4;
  const wf = S.scopeWaveform(fill(w, h, (x, y) => y < 4 ? [0, 0, 0] : [255, 255, 255]), w, h, cols, rows);
  let top = 0, bottom = 0, total = 0;
  for (let c = 0; c < cols; c++) { top += wf[0 * cols + c]; bottom += wf[(rows - 1) * cols + c]; }
  for (const v of wf) total += v;
  assert.strictEqual(top, 32);       // 白色（100%）在最上面一列
  assert.strictEqual(bottom, 32);    // 黑色（0%）在最下面一列
  assert.strictEqual(total, 64);
});

test('向量：純灰在中心，純紅靠近 R 目標', () => {
  const size = 101, m = size - 1;
  const g = S.scopeVector(fill(4, 4, () => [128, 128, 128]), size);
  assert.strictEqual(g[(m / 2) * size + m / 2], 16);
  const r = S.scopeVector(fill(4, 4, () => [255, 0, 0]), size);
  const idx = r.findIndex(v => v > 0), x = idx % size, y = Math.floor(idx / size);
  const t = S.vectorTargets(size).find(q => q.name === 'R');
  assert.ok(Math.abs(x - t.x) <= 1 && Math.abs(y - t.y) <= 1, `紅色在 (${x},${y})，目標 (${t.x.toFixed(1)},${t.y.toFixed(1)})`);
  assert.ok(y < m / 2 - 20, '紅色在向量圖上半部');
});
