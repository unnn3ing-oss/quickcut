// 節拍偵測（edit-beat.js）：用合成的鼓聲測速度與拍點位置
const test = require('node:test');
const assert = require('node:assert/strict');
const beat = require('../edit-beat.js');

const SR = 22050;
// 每拍一個大鼓（60Hz 衰減正弦）＋反拍 hi-hat（短雜訊）＋底噪
function drums(bpm, sec, start = 0.3) {
  const n = Math.round(SR * sec), x = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) x[i] = rnd() * 0.02;
  const per = 60 / bpm, beats = [];
  for (let t = start; t < sec - 0.2; t += per) {
    beats.push(t);
    const s0 = Math.round(t * SR);
    for (let j = 0; j < SR * 0.12 && s0 + j < n; j++) x[s0 + j] += 0.8 * Math.exp(-j / (SR * 0.03)) * Math.sin(2 * Math.PI * 60 * j / SR);
    const h0 = Math.round((t + per / 2) * SR);
    for (let j = 0; j < SR * 0.03 && h0 + j < n; j++) x[h0 + j] += 0.3 * Math.exp(-j / (SR * 0.005)) * rnd();
  }
  return { x, beats };
}

for (const bpm of [90, 120, 128, 150]) {
  test(`節拍偵測：${bpm} BPM 的速度與拍點（誤差 50ms 內）`, () => {
    const { x, beats } = drums(bpm, 20);
    const r = beat.detect([x], SR);
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `速度 ${r.bpm}`);
    const hit = beats.filter(b => r.beats.some(d => Math.abs(d - b) < 0.05)).length;
    assert.ok(hit >= beats.length - 1, `命中 ${hit}/${beats.length}`);
    assert.ok(r.confidence > 0.3);
    for (let i = 1; i < r.beats.length; i++) assert.ok(r.beats[i] > r.beats[i - 1], '拍點遞增');
  });
}

test('節拍偵測：只分析一段（from／to），結果落在範圍內；兩聲道平均', () => {
  const { x, beats } = drums(120, 20);
  const r = beat.detect([x, x], SR, { from: 5, to: 12 });
  assert.ok(Math.abs(r.bpm - 120) < 1.5, `速度 ${r.bpm}`);
  assert.ok(r.beats.every(t => t >= 5 && t <= 12));
  const inside = beats.filter(b => b >= 5.05 && b <= 11.95);
  assert.ok(inside.every(b => r.beats.some(d => Math.abs(d - b) < 0.05)));
});

test('節拍偵測：太短、沒有聲音時回傳空結果，不會出錯', () => {
  assert.deepStrictEqual(beat.detect([new Float32Array(SR)], SR).beats, []);
  assert.deepStrictEqual(beat.detect([], SR).beats, []);
  const silent = beat.detect([new Float32Array(SR * 5)], SR);
  assert.ok(Array.isArray(silent.beats));
});
