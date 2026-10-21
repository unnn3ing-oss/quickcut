// edit-project.js 的純函式：專案檔格式、讀檔檢查、缺少素材清單、檔案配對。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../edit-project.js');
const C = require('../edit-core.js');

function sampleProject() {
  const p = C.createProject({ videoTracks: 2, audioTracks: 2 });
  C.registerMediaInfo(p, 'm1', { kind: 'video', duration: 6, hasAudio: true, width: 1280, height: 720, fps: 30, name: 'A.mp4', size: 1000, lastModified: 111 });
  C.registerMediaInfo(p, 'm2', { kind: 'audio', duration: 8, name: 'music.mp3', size: 2000, lastModified: 222 });
  C.registerMediaInfo(p, 'm3', { kind: 'image', name: 'still.png', size: 300 });
  const v1 = C.tracksOf(p, 'video')[0].id, a1 = C.tracksOf(p, 'audio')[0].id;
  assert.equal(C.addClip(p, { type: 'media', mediaId: 'm1', trackId: v1, start: 0, duration: 90 }).ok, true);
  assert.equal(C.addClip(p, { type: 'media', mediaId: 'm1', trackId: v1, start: 90, duration: 60 }).ok, true);
  assert.equal(C.addClip(p, { type: 'media', mediaId: 'm2', trackId: a1, start: 0, duration: 120 }).ok, true);
  return p;
}

test('registerMediaInfo 記下檔案大小與修改時間（重新連結用）', () => {
  const p = sampleProject();
  assert.equal(p.mediaInfo.m1.size, 1000);
  assert.equal(p.mediaInfo.m1.lastModified, 111);
  assert.equal(p.mediaInfo.m3.lastModified, null);
});

test('buildSave → parseSave 來回一致，而且檔案很小', () => {
  const p = sampleProject();
  const s = P.buildSave(JSON.parse(C.serialize(p)), { playhead: 42.6 });
  assert.equal(s.format, 'quickcut-project');
  assert.equal(s.version, 1);
  assert.equal(s.view.playhead, 43);
  const text = JSON.stringify(s);
  assert.ok(text.length < 20000, `專案檔 ${text.length} bytes`);
  const r = P.parseSave(text);
  assert.equal(r.ok, true);
  const back = C.deserialize(r.save.project);
  assert.deepEqual(C.checkInvariants(back), []);
  assert.equal(Object.keys(back.clips).length, 3);
  assert.deepEqual(back.mediaInfo, p.mediaInfo);
});

test('parseSave 擋下不是專案檔、版本太新、內容不完整的檔案', () => {
  assert.match(P.parseSave('not json').reason, /不是 JSON/);
  assert.match(P.parseSave('{"a":1}').reason, /不是 QuickCut/);
  assert.match(P.parseSave(JSON.stringify({ format: 'quickcut-project', version: 99, project: {} })).reason, /較新版本/);
  assert.match(P.parseSave(JSON.stringify({ format: 'quickcut-project', version: 1, project: { clips: {} } })).reason, /不完整/);
});

test('missingMedia：列出沒有載入的素材，有片段在用的排前面', () => {
  const p = sampleProject();
  const miss = P.missingMedia(p, id => id === 'm2');
  assert.deepEqual(miss.map(x => [x.id, x.clips]), [['m1', 2], ['m3', 0]]);
  assert.equal(miss[0].name, 'A.mp4');
  assert.deepEqual(P.missingMedia(p, () => true), []);
});

test('matchFiles：先比檔名＋大小，再比檔名（不分大小寫），一個素材只配一次', () => {
  const miss = [
    { id: 'm1', name: 'A.mp4', size: 1000 },
    { id: 'm2', name: 'music.mp3', size: 2000 },
    { id: 'm4', name: 'a.mp4', size: 5000 },
  ];
  const files = [
    { name: 'a.MP4', size: 5000 },      // 大小對得上 m4（檔名不分大小寫）
    { name: 'A.mp4', size: 1000 },      // m1
    { name: 'MUSIC.mp3', size: 9 },     // 大小不同：只有檔名對得上 → m2（loose）
    { name: 'other.mov', size: 1 },     // 配不到
    { name: 'A.mp4', size: 1000 },      // m1 已經被配走了
  ];
  const r = P.matchFiles(miss, files);
  assert.deepEqual(r.ids, ['m4', 'm1', 'm2', null, null]);
  assert.deepEqual(r.loose, [false, false, true, false, false]);
});

test('fileKey：檔名＋大小＋修改時間（IndexedDB 記檔案位置的 key）', () => {
  assert.equal(P.fileKey({ name: 'A.mp4', size: 10, lastModified: 5 }), 'A.mp4|10|5');
  assert.equal(P.fileKey({ name: 'A.mp4', size: null, lastModified: null }), 'A.mp4||');
});

test('APP_VERSION 和 changelog.json 最新版一致', () => {
  const log = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'changelog.json'), 'utf8'));
  const latest = Object.keys(log).map(Number).sort((a, b) => b - a)[0].toFixed(2);
  assert.equal(P.APP_VERSION, latest);
});
