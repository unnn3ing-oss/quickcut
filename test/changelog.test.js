// changelog.json 的格式：版本號「主版本.兩位數」、每筆有一行簡述與條列（繁體中文說明見 CLAUDE.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const log = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'changelog.json'), 'utf8'));
const versions = Object.keys(log);

test('版本號格式是 主版本.兩位數', () => {
  assert.ok(versions.length > 0);
  for (const v of versions) assert.match(v, /^\d+\.\d{2}$/, v);
});

test('每一筆都有簡述與條列', () => {
  for (const [v, e] of Object.entries(log)) {
    assert.equal(typeof e.summary, 'string', v);
    assert.ok(e.summary.length > 0 && e.summary.length <= 80, `${v} 簡述 1～80 字`);
    assert.ok(Array.isArray(e.items) && e.items.length > 0 && e.items.length <= 12, `${v} 條列 1～12 條`);
    for (const it of e.items) assert.ok(typeof it === 'string' && it.length > 0 && it.length <= 140, `${v} 每條 1～140 字`);
  }
});

test('目前版本是 4.10', () => {
  const latest = versions.map(Number).sort((a, b) => b - a)[0];
  assert.equal(latest.toFixed(2), '4.10');
});
