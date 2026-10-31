// 剪輯時間軸核心（edit-core.js）的單元測試與模糊測試
const test = require('node:test');
const assert = require('node:assert');
const core = require('../edit-core.js');

// ---- 共用工具 ----------------------------------------------------------------------
// 專案：V1 V2 A1 A2；媒體：mv 影片 10 秒有聲音、mn 影片 3 秒無聲、ma 音樂 8 秒、mi 圖片
function setup(o = {}) {
  const p = core.createProject({ videoTracks: o.v == null ? 2 : o.v, audioTracks: o.a == null ? 2 : o.a });
  core.registerMediaInfo(p, 'mv', { kind: 'video', duration: 10, hasAudio: true, width: 1280, height: 720, fps: 29.97, name: '訪問' });
  core.registerMediaInfo(p, 'mn', { kind: 'video', duration: 3, hasAudio: false, width: 720, height: 1280, fps: 25, name: '空景' });
  core.registerMediaInfo(p, 'ma', { kind: 'audio', duration: 8, name: '音樂' });
  core.registerMediaInfo(p, 'mi', { kind: 'image', width: 800, height: 600, name: '照片' });
  return p;
}
const V = (p, i = 0) => core.tracksOf(p, 'video')[i].id;
const A = (p, i = 0) => core.tracksOf(p, 'audio')[i].id;
// 用覆蓋放一段媒體（秒），回傳新片段 id
function put(p, mediaId, frame, srcIn = 0, srcOut, trackIds) {
  const r = core.editToTimeline(p, { mode: 'overwrite', mediaId, frame, srcIn, srcOut, trackIds });
  assert.ok(r.ok, r.reason);
  return r.ids;
}
const C = (p, id) => p.clips[id];
const span = c => [c.start, c.start + c.duration];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ≠ ${b}`);
const lock = (p, tid, v = true) => assert.ok(core.setTrackProps(p, tid, { locked: v }).ok);

// 失敗時 project 完全沒變，原因是繁中
function unchanged(p, fn, re) {
  const before = core.serialize(p);
  const r = fn();
  assert.strictEqual(r.ok, false, '應該要失敗');
  assert.match(r.reason, /[一-鿿]/, '原因要是中文：' + r.reason);
  if (re) assert.match(r.reason, re);
  assert.strictEqual(core.serialize(p), before, '失敗時 project 不能被改到');
  return r;
}

// 獨立實作的不變式檢查（不依賴 core 的檢查器），最後也確認 core 自己的檢查器沒有意見
function syncAnchor(p, c) {
  if (c.type !== 'media' || c.freeze) return c.start;
  const k = p.fps / c.speed;
  return c.reverse ? c.start + c.duration + c.srcIn * k : c.start - c.srcIn * k;
}
function assertInvariants(p, { linkSync = false } = {}) {
  const tracks = new Map(p.tracks.map(t => [t.id, t]));
  assert.strictEqual(tracks.size, p.tracks.length, '軌道 id 不重複');
  const kinds = p.tracks.map(t => t.kind);
  assert.ok(kinds.lastIndexOf('video') < kinds.indexOf('audio') || kinds.indexOf('audio') < 0, '影片軌在前、音訊軌在後');
  const by = new Map();
  for (const [id, c] of Object.entries(p.clips)) {
    assert.strictEqual(c.id, id);
    const t = tracks.get(c.trackId);
    assert.ok(t, '片段的軌道存在');
    assert.ok(Number.isInteger(c.start) && c.start >= 0, `start 是非負整數：${c.start}`);
    assert.ok(Number.isInteger(c.duration) && c.duration >= 1, `duration ≥ 1：${c.duration}`);
    assert.ok(Number.isFinite(c.srcIn) && c.srcIn >= -1e-9, `srcIn ≥ 0：${c.srcIn}`);
    assert.ok(c.speed > 0);
    const m = c.type === 'media' ? p.mediaInfo[c.mediaId] : null;
    if (c.type === 'media') assert.ok(m, '媒體片段要有媒體資訊');
    if (m && m.kind !== 'image') {
      if (c.freeze) assert.ok(c.srcIn < m.duration, '定格在媒體範圍內');
      else assert.ok(c.srcIn + c.duration * c.speed / p.fps <= m.duration + 1e-6, `來源不超出媒體：${c.srcIn}+${c.duration}`);
    }
    if (t.kind === 'video') { assert.ok(c.video && !c.audio, '影片軌片段有 video、沒有 audio'); assert.ok(!m || m.kind !== 'audio'); }
    else { assert.ok(c.audio && !c.video, '音訊軌片段有 audio'); assert.strictEqual(c.type, 'media'); assert.ok(m.kind === 'audio' || m.hasAudio); }
    if (c.audio) assert.ok(c.audio.fadeIn >= 0 && c.audio.fadeOut >= 0 && c.audio.fadeIn + c.audio.fadeOut <= c.duration, '淡入淡出不超過長度');
    if (!by.has(c.trackId)) by.set(c.trackId, []);
    by.get(c.trackId).push(c);
  }
  for (const [tid, list] of by) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].start + list[i - 1].duration <= list[i].start, `「${tracks.get(tid).name}」軌片段重疊`);
  }
  const edges = new Set();
  for (const [id, tr] of Object.entries(p.transitions)) {
    assert.strictEqual(tr.id, id);
    assert.ok(tr.leftClipId || tr.rightClipId, '轉場至少附在一個片段上');
    const L = tr.leftClipId ? p.clips[tr.leftClipId] : null, R = tr.rightClipId ? p.clips[tr.rightClipId] : null;
    if (tr.leftClipId) assert.ok(L, '轉場的左片段存在');
    if (tr.rightClipId) assert.ok(R, '轉場的右片段存在');
    for (const k of [L && 'end:' + L.id, R && 'start:' + R.id].filter(Boolean)) { assert.ok(!edges.has(k), '一個片段邊緣只有一個轉場'); edges.add(k); }
    const own = L || R;
    assert.strictEqual(tr.trackId, own.trackId);
    let max = own.duration;
    if (L && R) {
      assert.ok(R.trackId === L.trackId && R.start === L.start + L.duration, '轉場兩側相鄰');
      max = Math.min(L.duration, R.duration);
    } else {
      // 單邊：貼在片段邊緣，而且那個邊緣旁邊沒有緊接著的片段（有的話應該是雙邊）
      const nb = Object.values(p.clips).find(c => c.trackId === own.trackId && c.id !== own.id && (L ? c.start === L.start + L.duration : c.start + c.duration === R.start));
      assert.ok(!nb, '單邊轉場的邊緣旁邊沒有緊接著的片段');
      const r = core.transitionRange(p, tr);
      if (L) assert.deepStrictEqual([r.from, r.to], [L.start + L.duration - tr.duration, L.start + L.duration], '尾端淡出貼在片段結尾');
      else assert.deepStrictEqual([r.from, r.to], [R.start, R.start + tr.duration], '開頭淡入貼在片段開頭');
    }
    assert.ok(Number.isInteger(tr.duration) && tr.duration >= 1 && tr.duration <= max, '轉場長度合理');
  }
  for (let i = 1; i < p.markers.length; i++) assert.ok(p.markers[i - 1].frame <= p.markers[i].frame, '標記依位置排序');
  if (p.inPoint != null && p.outPoint != null) assert.ok(p.outPoint > p.inPoint);
  if (linkSync) {
    const groups = new Map();
    for (const c of Object.values(p.clips)) if (c.linkId) { if (!groups.has(c.linkId)) groups.set(c.linkId, []); groups.get(c.linkId).push(c); }
    for (const g of groups.values()) {
      for (const c of g.slice(1)) {
        const r = g[0];
        const same = r.type === 'media' && c.type === 'media' && r.mediaId === c.mediaId && r.speed === c.speed && !!r.reverse === !!c.reverse && !r.freeze && !c.freeze;
        const d = same ? syncAnchor(p, c) - syncAnchor(p, r) : c.start - r.start;
        assert.ok(Math.abs(d) < 1e-3, `連結片段不同步（${d}）`);
      }
    }
  }
  assert.deepStrictEqual(core.checkInvariants(p), [], 'core 的檢查器也沒有問題');
}

// 每個測試回傳要檢查的 project（或陣列），結束後自動跑不變式
function t(name, fn) {
  test(name, () => {
    const out = fn();
    for (const p of [].concat(out || [])) assertInvariants(p, { linkSync: !!(p && p.__sync) });
  });
}
const synced = p => Object.defineProperty(p, '__sync', { value: true, enumerable: false });

// 基本場景：V1 [0,30) [30,60) [60,90)（mv 0~1、2~3、4~5 秒，各自連結 A1），V2 標題 [100,130)
function scene() {
  const p = setup();
  const a = put(p, 'mv', 0, 0, 1), b = put(p, 'mv', 30, 2, 3), c = put(p, 'mv', 60, 4, 5);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 100, duration: 30 });
  assert.ok(ti.ok);
  return { p, a, b, c, title: ti.id };
}

// =====================================================================================
// 專案、軌道、媒體
// =====================================================================================
t('createProject 預設值、軌道順序、序列化來回一致', () => {
  const p = core.createProject();
  assert.strictEqual(p.fps, 30);
  assert.deepStrictEqual(p.tracks.map(x => x.name), ['V1', 'A1']);
  const q = setup({ v: 3, a: 2 });
  assert.deepStrictEqual(q.tracks.map(x => x.name), ['V1', 'V2', 'V3', 'A1', 'A2']);
  put(q, 'mv', 0, 0, 1);
  const r = core.deserialize(core.serialize(q));
  assert.deepStrictEqual(r, q);
  const c = core.clone(q);
  c.clips[Object.keys(c.clips)[0]].start = 99;
  assert.notStrictEqual(Object.values(q.clips)[0].start, 99);
  assert.ok(Object.values(q.clips).every(x => x.video ? x.video.transform.zoomX === 1 : x.audio.eq.bands.length === 6));
  return [p, q, r];
});

t('deserialize 補齊舊存檔缺的欄位', () => {
  const p = setup();
  put(p, 'mv', 0, 0, 1);
  const raw = JSON.parse(core.serialize(p));
  for (const c of Object.values(raw.clips)) { delete c.flags; delete c.markers; delete c.speed; }
  const q = core.deserialize(raw);
  for (const c of Object.values(q.clips)) { assert.deepStrictEqual(c.flags, []); assert.strictEqual(c.speed, 1); }
  return q;
});

t('registerMediaInfo：第一支影片決定 fps 與 source 尺寸，之後固定', () => {
  const p = core.createProject();
  assert.ok(core.registerMediaInfo(p, 'a', { kind: 'audio', duration: 5 }).ok);
  assert.strictEqual(p.fps, 30);
  const r = core.registerMediaInfo(p, 'v', { kind: 'video', duration: 4, fps: 25, width: 721, height: 1281, hasAudio: false });
  assert.ok(r.ok && r.fpsSet);
  assert.strictEqual(p.fps, 25);
  assert.deepStrictEqual([p.width, p.height], [722, 1282]);
  core.registerMediaInfo(p, 'v2', { kind: 'video', duration: 4, fps: 59.94, width: 1920, height: 1080 });
  assert.strictEqual(p.fps, 25);
  assert.strictEqual(core.snapFps(23.976), 24);
  assert.strictEqual(core.snapFps(29.97), 30);
  assert.strictEqual(core.snapFps(59.94), 60);
  assert.strictEqual(core.snapFps(48), 50);
  // 時間軸已經有片段時不改 fps
  const q = core.createProject();
  core.registerMediaInfo(q, 'i', { kind: 'image' });
  assert.ok(core.editToTimeline(q, { mediaId: 'i', frame: 0 }).ok);
  core.registerMediaInfo(q, 'v', { kind: 'video', duration: 4, fps: 25 });
  assert.strictEqual(q.fps, 30);
  // 錯誤
  assert.strictEqual(core.registerMediaInfo(p, 'x', { kind: 'pdf' }).ok, false);
  assert.strictEqual(core.registerMediaInfo(p, 'x', { kind: 'video', duration: NaN }).ok, false);
  assert.strictEqual(core.registerMediaInfo(p, 'x', { kind: 'video', duration: 0 }).ok, false);
  assert.strictEqual(p.mediaInfo.i, undefined);
  assert.strictEqual(p.mediaInfo.i === undefined && p.mediaInfo.mi === undefined, true);
  assert.strictEqual(p.mediaInfo.v.duration, 4);
  assert.strictEqual(q.mediaInfo.i.duration, null, '圖片長度存 null（JSON 存得下）');
  return [p, q];
});

t('unregisterMediaInfo：有片段在用就不能移除', () => {
  const p = setup();
  put(p, 'mn', 0, 0, 1);
  unchanged(p, () => core.unregisterMediaInfo(p, 'mn'), /還有片段/);
  assert.ok(core.unregisterMediaInfo(p, 'ma').ok);
  assert.strictEqual(p.mediaInfo.ma, undefined);
  return p;
});

t('setAspect：9:16／16:9／4:5／source（偶數化、長邊上限 3840）', () => {
  const p = setup();
  assert.deepStrictEqual([p.width, p.height], [1280, 720]);
  for (const [a, w, h] of [['9:16', 1080, 1920], ['16:9', 1920, 1080], ['4:5', 1080, 1350], ['1:1', 1080, 1080]]) {
    assert.ok(core.setAspect(p, a).ok);
    assert.deepStrictEqual([p.aspect, p.width, p.height], [a, w, h]);
  }
  assert.ok(core.setAspect(p, 'source').ok);
  assert.deepStrictEqual([p.width, p.height], [1280, 720]);
  core.setAspect(p, 'source', { width: 7680, height: 4320 });
  assert.deepStrictEqual([p.width, p.height], [3840, 2160]);
  core.setAspect(p, 'source', { width: 2161, height: 5000 });
  assert.strictEqual(p.height, 3840);
  assert.strictEqual(p.width % 2, 0);
  assert.ok(p.width <= 3840);
  const q = core.createProject();
  core.setAspect(q, 'source');
  assert.deepStrictEqual([q.width, q.height], [1920, 1080]);
  unchanged(p, () => core.setAspect(p, '21:9'), /比例/);
  return [p, q];
});

t('addTrack／removeTrack／setTrackProps', () => {
  const p = setup();
  const r = core.addTrack(p, 'video');
  assert.ok(r.ok);
  assert.deepStrictEqual(p.tracks.map(x => x.name), ['V1', 'V2', 'V3', 'A1', 'A2']);
  assert.strictEqual(p.tracks[2].id, r.id);
  assert.ok(core.addTrack(p, 'audio').ok);
  unchanged(p, () => core.addTrack(p, 'subtitle'));
  // 刪軌道會一起刪掉上面的片段與轉場
  const ids = put(p, 'mv', 0, 0, 1, { video: V(p, 1), audio: A(p, 0) });
  put(p, 'mn', 30, 0, 1, { video: V(p, 1) });
  assert.ok(core.addTransition(p, { leftClipId: ids[0] }).ok);
  assert.ok(core.removeTrack(p, V(p, 1)).ok);
  assert.deepStrictEqual(p.tracks.map(x => x.name), ['V1', 'V2', 'A1', 'A2', 'A3']);
  assert.strictEqual(Object.keys(p.transitions).length, 0);
  assert.strictEqual(C(p, ids[1]).linkId, null, '剩下單獨一個的連結會清掉');
  // 鎖定的、最後一條不能刪
  lock(p, A(p, 0));
  unchanged(p, () => core.removeTrack(p, A(p, 0)), /鎖定/);
  const q = core.createProject();
  unchanged(q, () => core.removeTrack(q, q.tracks[0].id), /至少/);
  unchanged(p, () => core.setTrackProps(p, A(p, 1), { color: 'red' }));
  assert.ok(core.setTrackProps(p, A(p, 1), { muted: true, solo: 1, name: '旁白' }).ok);
  assert.deepStrictEqual([p.tracks[3].muted, p.tracks[3].solo, p.tracks[3].name], [true, true, '旁白']);
  return [p, q];
});

// =====================================================================================
// 查詢
// =====================================================================================
t('clipsOnTrack／clipAt（半開區間）／clipsAt／projectDuration／linkedClips／expandLinked', () => {
  const { p, a, b, title } = scene();
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(c => c.start), [0, 30, 60]);
  assert.strictEqual(core.clipAt(p, V(p), 29).id, a[0]);
  assert.strictEqual(core.clipAt(p, V(p), 30).id, b[0]);
  assert.strictEqual(core.clipAt(p, V(p), 90), null);
  assert.deepStrictEqual(core.clipsAt(p, 110).map(c => c.id), [title]);
  assert.deepStrictEqual(core.clipsAt(p, 5).map(c => c.id), [a[0], a[1]]);
  assert.strictEqual(core.projectDuration(p), 130);
  assert.strictEqual(core.projectDuration(core.createProject()), 0);
  assert.deepStrictEqual(core.linkedClips(p, a[0]).map(c => c.id), [a[1]]);
  assert.deepStrictEqual(core.linkedClips(p, title), []);
  assert.deepStrictEqual(core.expandLinked(p, [a[0], 'nope'], true), [a[0], a[1]]);
  assert.deepStrictEqual(core.expandLinked(p, [a[0]], false), [a[0]]);
  assert.strictEqual(core.clipEnd(C(p, a[0])), 30);
  assert.strictEqual(core.getClip(p, 'nope'), null);
  return synced(p);
});

t('sourceTimeAt：正播、變速、倒播、定格、夾在媒體範圍內', () => {
  const p = setup();
  const [v] = put(p, 'mv', 100, 2, 4);          // 60 格，來源 2~4 秒
  const c = C(p, v);
  near(core.sourceTimeAt(p, c, 100), 2);
  near(core.sourceTimeAt(p, c, 115), 2.5);
  near(core.sourceTimeAt(p, v, 159), 2 + 59 / 30);
  // 轉場向把手借畫面：片段範圍外照樣換算
  near(core.sourceTimeAt(p, c, 90), 2 - 10 / 30);
  // 變速 2×（非波紋，來源 2~6 秒）
  assert.ok(core.setSpeed(p, v, { speed: 2 }).ok);
  near(core.sourceTimeAt(p, v, 110), 2 + 20 / 30);
  // 倒播：第一格 = 來源區段最後一格，最後一格 = srcIn
  assert.ok(core.setSpeed(p, v, { speed: 1, reverse: true }).ok);
  const s = C(p, v);
  near(core.sourceTimeAt(p, s, 100), 2 + 59 / 30);
  near(core.sourceTimeAt(p, s, 159), 2);
  near(core.sourceTimeAt(p, s, 130), 2 + 29 / 30);
  assert.ok(core.setSpeed(p, v, { speed: 2, reverse: true }).ok);
  near(core.sourceTimeAt(p, v, 100), 2 + 59 * 2 / 30);
  near(core.sourceTimeAt(p, v, 159), 2);
  // 夾在媒體範圍
  const [w] = put(p, 'mv', 300, 0, 10);        // 0~10 秒，用滿
  near(core.sourceTimeAt(p, w, 250), 0);
  assert.ok(core.sourceTimeAt(p, w, 1000) < 10 && core.sourceTimeAt(p, w, 1000) > 9.99);
  // 定格
  assert.ok(core.freezeFrame(p, w, 330).ok);
  near(core.sourceTimeAt(p, w, 300), 1);
  near(core.sourceTimeAt(p, w, 599), 1);
  // 圖片、標題
  const [img] = put(p, 'mi', 700);
  assert.strictEqual(core.sourceTimeAt(p, img, 710), 0);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 0, duration: 60 });
  near(core.sourceTimeAt(p, ti.id, 15), 0.5);
  assert.strictEqual(core.sourceTimeAt(p, 'nope', 0), 0);
  return p;
});

t('sourceSpan／maxExtend：媒體把手、倒播左右對調、圖片與定格無限', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 100, 2, 4);
  assert.deepStrictEqual(core.sourceSpan(p, v), { from: 2, to: 4 });
  assert.strictEqual(core.maxExtend(p, v, 'start'), 60);
  assert.strictEqual(core.maxExtend(p, C(p, a), 'end'), 180);
  assert.ok(core.setSpeed(p, v, { speed: 2, linked: false }).ok);
  assert.deepStrictEqual(core.sourceSpan(p, v), { from: 2, to: 6 });
  assert.strictEqual(core.maxExtend(p, v, 'start'), 30);
  assert.strictEqual(core.maxExtend(p, v, 'end'), 60);
  assert.ok(core.setSpeed(p, v, { speed: 2, reverse: true, linked: false }).ok);
  assert.strictEqual(core.maxExtend(p, v, 'start'), 60, '倒播時開頭往前延長用的是來源後面的畫面');
  assert.strictEqual(core.maxExtend(p, v, 'end'), 30);
  const [img] = put(p, 'mi', 300);
  assert.strictEqual(core.maxExtend(p, img, 'start'), Infinity);
  const ti = core.addClip(p, { type: 'solid', trackId: V(p, 1), start: 0, duration: 10 });
  assert.strictEqual(core.maxExtend(p, ti.id, 'end'), Infinity);
  return p;
});

t('snapTargets／snap', () => {
  const { p, a } = scene();
  core.addMarker(p, { frame: 45 });
  core.setInOut(p, 10, 20);
  assert.ok(core.addClipMarker(p, a[0], { offset: 5 }).ok);
  const tg = core.snapTargets(p, { playhead: 77, exclude: [a[0]] });
  assert.deepStrictEqual(tg, [0, 10, 20, 30, 45, 60, 77, 90, 100, 130]);
  const all = core.snapTargets(p, { markers: false, inOut: false });
  assert.deepStrictEqual(all, [0, 30, 60, 90, 100, 130]);
  assert.strictEqual(core.snap(28, tg, 3), 30);
  assert.strictEqual(core.snap(25, tg, 3), 25);
  assert.strictEqual(core.snap(44, tg, 3), 45);
  return p;
});

// =====================================================================================
// 移動
// =====================================================================================
t('moveClips：連結片段一起動、夾在 0、到底了失敗', () => {
  const { p, c } = scene();
  let r = core.moveClips(p, [c[0]], 50, 0);
  assert.ok(r.ok);
  assert.deepStrictEqual(span(C(p, c[0])), [110, 140]);
  assert.deepStrictEqual(span(C(p, c[1])), [110, 140]);
  r = core.moveClips(p, [c[1]], -1000, 0);
  assert.strictEqual(r.applied, -110);
  assert.strictEqual(C(p, c[0]).start, 0);
  return synced(p);
});

t('moveClips：目的地以覆蓋處理（刪除、切開、修短）', () => {
  const p = setup();
  const [x] = put(p, 'mn', 0, 0, 3, { video: V(p) });     // V1 [0,90)
  const [y] = put(p, 'mn', 0, 0, 1, { video: V(p, 1) });  // V2 [0,30)
  // 拖到 V1 的 [30,60)：把 x 切成兩段
  let r = core.moveClips(p, [y], 30, -1);
  assert.ok(r.ok, r.reason);
  const v1 = core.clipsOnTrack(p, V(p));
  assert.deepStrictEqual(v1.map(span), [[0, 30], [30, 60], [60, 90]]);
  near(v1[2].srcIn, 2, '右半段的來源接得上');
  assert.strictEqual(v1[1].id, y);
  // 再往右拖 15 格：右邊的片段被修短（開頭）
  r = core.moveClips(p, [y], 15, 0);
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(span), [[0, 30], [45, 75], [75, 90]]);
  near(core.clipsOnTrack(p, V(p))[2].srcIn, 2.5);
  // 往左拖 40 格：整個蓋掉並修短左邊
  r = core.moveClips(p, [y], -40, 0);
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(span), [[0, 5], [5, 35], [75, 90]]);
  return p;
});

t('moveClips：換軌只動同種類、軌道不存在／鎖定失敗、連結選取關閉會不同步', () => {
  const { p, a, b } = scene();
  let r = core.moveClips(p, [a[0]], 0, 1);
  assert.ok(r.ok);
  assert.strictEqual(C(p, a[0]).trackId, V(p, 1));
  assert.strictEqual(C(p, a[1]).trackId, A(p, 0), '聲音留在原本的音訊軌');
  unchanged(p, () => core.moveClips(p, [a[0]], 0, 1), /沒有那條軌道/);
  unchanged(p, () => core.moveClips(p, ['nope'], 5, 0), /找不到/);
  unchanged(p, () => core.moveClips(p, [], 5, 0), /沒有選取/);
  lock(p, A(p, 1));
  unchanged(p, () => core.moveClips(p, [a[1]], 0, 1), /A2.*鎖定/);
  lock(p, A(p, 0));
  unchanged(p, () => core.moveClips(p, [b[0]], 10, 0), /鎖定/);  // 連結的聲音在鎖定軌
  lock(p, A(p, 0), false);
  r = core.moveClips(p, [b[0]], 5, 0, { linked: false });
  assert.ok(r.ok);
  assert.strictEqual(core.linkOffset(p, b[1]), -5);
  assert.strictEqual(core.linkOffset(p, b[0]), 0);
  assert.strictEqual(r.applied, 5);
  assert.deepStrictEqual(core.moveClips(p, [b[0]], 0, 0), { ok: true, applied: 0, dTracks: 0 });
  return p;
});

// =====================================================================================
// 修剪
// =====================================================================================
t('trimEdge：縮短、受鄰居與媒體把手限制（夾住並回報 applied）', () => {
  const p = setup();
  const [v, au] = put(p, 'mv', 100, 0, 1);              // [100,130)，來源 0~1 秒
  const [n] = put(p, 'mn', 150, 0, 1, { video: V(p) }); // 鄰居 [150,180)
  unchanged(p, () => core.trimEdge(p, v, 'start', -10), /開頭/);   // 來源前面沒畫面了
  let r = core.trimEdge(p, v, 'end', 100);
  assert.strictEqual(r.applied, 20, '碰到鄰居就停');
  assert.deepStrictEqual(span(C(p, v)), [100, 150]);
  assert.deepStrictEqual(span(C(p, au)), [100, 150], '連結的聲音一起修');
  unchanged(p, () => core.trimEdge(p, v, 'end', 1), /碰到旁邊的片段/);
  r = core.trimEdge(p, v, 'start', 1000);
  assert.strictEqual(r.applied, 49, '最短 1 格');
  assert.deepStrictEqual(span(C(p, v)), [149, 150]);
  near(C(p, v).srcIn, 49 / 30);
  r = core.trimEdge(p, v, 'start', -Infinity);
  assert.strictEqual(r.applied, -49);
  assert.strictEqual(C(p, v).srcIn, 0);
  // 媒體尾端：mn 只有 3 秒
  core.lift(p, [v]);
  r = core.trimEdge(p, n, 'end', 500);
  assert.strictEqual(r.applied, 60);
  assert.strictEqual(core.maxExtend(p, n, 'end'), 0);
  unchanged(p, () => core.trimEdge(p, n, 'end', 1), /結尾/);
  assert.deepStrictEqual(core.trimEdge(p, n, 'end', 0), { ok: true, applied: 0 });
  unchanged(p, () => core.trimEdge(p, n, 'middle', 1));
  unchanged(p, () => core.trimEdge(p, n, 'end', NaN));
  return p;
});

t('trimEdge／rippleTrim／blade：圖片、標題、色塊沒有來源限制，srcIn 不動', () => {
  const p = setup();
  const [img] = put(p, 'mi', 100);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 50, duration: 10 }).id;
  const so = core.addClip(p, { type: 'solid', trackId: V(p, 1), start: 200, duration: 10 }).id;
  let r = core.trimEdge(p, img, 'start', -1000);
  assert.strictEqual(r.applied, -100);
  assert.deepStrictEqual([C(p, img).start, C(p, img).duration, C(p, img).srcIn], [0, 250, 0]);
  r = core.trimEdge(p, ti, 'start', -1000);
  assert.strictEqual(r.applied, -50);
  assert.strictEqual(C(p, ti).srcIn, 0);
  r = core.rippleTrim(p, so, 'start', -500);
  assert.strictEqual(r.applied, -500);
  assert.deepStrictEqual([C(p, so).start, C(p, so).duration, C(p, so).srcIn], [200, 510, 0]);
  r = core.blade(p, 30, [V(p)]);
  assert.strictEqual(C(p, r.ids[0]).srcIn, 0);
  r = core.slide(p, so, -10);
  assert.ok(r.ok);
  return p;
});

t('trimEdge：倒播、片段標記跟著來源、鎖定軌、只修一邊（連結選取關閉）', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 0, 2, 3);
  assert.ok(core.setSpeed(p, v, { reverse: true }).ok);
  const t0 = core.sourceTimeAt(p, v, 0);
  let r = core.trimEdge(p, v, 'end', 15);       // 倒播往後延長 = 用來源更早的畫面
  assert.ok(r.ok);
  near(C(p, v).srcIn, 1.5);
  near(core.sourceTimeAt(p, v, 0), t0, '開頭的畫面不變');
  near(core.sourceTimeAt(p, v, 44), 1.5);
  // 片段標記：修開頭時跟著來源走
  assert.ok(core.addClipMarker(p, a, { offset: 20 }).ok);
  r = core.trimEdge(p, a, 'start', 10, { linked: false });
  assert.strictEqual(C(p, a).markers[0].offset, 10);
  assert.strictEqual(C(p, v).start, 0, '連結選取關閉時只修指定的片段');
  lock(p, V(p));
  unchanged(p, () => core.trimEdge(p, v, 'end', -5), /V1.*鎖定/);
  unchanged(p, () => core.trimEdge(p, a, 'end', -5), /鎖定/);    // 連結的影像在鎖定軌
  return p;
});

// =====================================================================================
// 刀片
// =====================================================================================
t('blade：連結片段一起切、來源接得上、轉場跟著右半、淡入淡出分開', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 0, 1, 3);
  core.setClipProps(p, a, { audio: { fadeIn: 10, fadeOut: 12 } });
  const [n] = put(p, 'mn', 60, 0, 1, { video: V(p) });
  assert.ok(core.addTransition(p, { leftClipId: v, duration: 10 }).ok);
  const before = [];
  for (let f = 0; f < 60; f++) before.push(core.sourceTimeAt(p, core.clipAt(p, V(p), f), f));
  const r = core.blade(p, 20);
  assert.ok(r.ok);
  assert.strictEqual(r.ids.length, 2);
  for (let f = 0; f < 60; f++) near(core.sourceTimeAt(p, core.clipAt(p, V(p), f), f), before[f], `第 ${f} 格`);
  const [rv, ra] = r.ids.map(id => C(p, id));
  assert.strictEqual(rv.linkId, ra.linkId);
  assert.notStrictEqual(rv.linkId, C(p, v).linkId);
  assert.deepStrictEqual([C(p, a).audio.fadeIn, C(p, a).audio.fadeOut, ra.audio.fadeIn, ra.audio.fadeOut], [10, 0, 0, 12]);
  const tr = Object.values(p.transitions)[0];
  assert.strictEqual(tr.leftClipId, rv.id);
  assert.strictEqual(tr.rightClipId, n);
  unchanged(p, () => core.blade(p, 20), /沒有可以切開/);   // 剛好在剪接點
  unchanged(p, () => core.blade(p, 500), /沒有可以切開/);
  return synced(p);
});

t('blade：倒播片段切開來源也連續；指定軌道、鎖定軌', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 0, 1, 3);
  core.setSpeed(p, v, { speed: 1.5, reverse: true, ripple: true });
  const dur = C(p, v).duration;
  const before = [];
  for (let f = 0; f < dur; f++) before.push(core.sourceTimeAt(p, C(p, v), f));
  assert.ok(core.blade(p, 13, [V(p)]).ok);
  for (let f = 0; f < dur; f++) near(core.sourceTimeAt(p, core.clipAt(p, V(p), f), f), before[f], `第 ${f} 格`);
  assert.strictEqual(core.clipsOnTrack(p, A(p)).length, 2, '指定影片軌時連結的聲音也切');
  // 不指定軌道：略過鎖定軌，只切其他軌
  lock(p, A(p));
  unchanged(p, () => core.blade(p, 25, [A(p)]), /鎖定/);
  unchanged(p, () => core.blade(p, 25, [V(p)]), /鎖定/);   // 連結的聲音在鎖定軌
  const r = core.blade(p, 25);
  assert.ok(r.ok);
  assert.strictEqual(core.clipsOnTrack(p, V(p)).length, 3);
  assert.strictEqual(core.clipsOnTrack(p, A(p)).length, 2);
  return p;
});

// =====================================================================================
// 波紋修剪／刪除
// =====================================================================================
t('rippleTrim 結尾：縮短拉近、延長推遠，所有未鎖定軌保持同步', () => {
  const { p, a, b, c, title } = scene();
  let r = core.rippleTrim(p, a[0], 'end', -10);
  assert.ok(r.ok);
  assert.deepStrictEqual(span(C(p, a[0])), [0, 20]);
  assert.deepStrictEqual(span(C(p, a[1])), [0, 20]);
  assert.deepStrictEqual(span(C(p, b[0])), [20, 50]);
  assert.deepStrictEqual(span(C(p, c[1])), [50, 80]);
  assert.deepStrictEqual(span(C(p, title)), [90, 120], '其他軌在編輯點之後的片段也跟著動');
  r = core.rippleTrim(p, a[0], 'end', 25);
  assert.strictEqual(r.applied, 25);
  assert.deepStrictEqual(span(C(p, b[0])), [45, 75]);
  assert.deepStrictEqual(span(C(p, title)), [115, 145]);
  return synced(p);
});

t('rippleTrim 開頭：起點不動、來源往後，後面跟著拉近；媒體把手限制', () => {
  const { p, a, b } = scene();
  let r = core.rippleTrim(p, b[0], 'start', 10);
  assert.ok(r.ok);
  assert.deepStrictEqual(span(C(p, b[0])), [30, 50]);
  near(C(p, b[0]).srcIn, 2 + 10 / 30);
  near(C(p, b[1]).srcIn, 2 + 10 / 30);
  assert.strictEqual(core.clipsOnTrack(p, V(p))[2].start, 50);
  r = core.rippleTrim(p, a[0], 'start', -100);        // a 的來源從 0 開始，沒有把手
  assert.strictEqual(r.ok, false);
  r = core.rippleTrim(p, b[0], 'start', -1000);       // b 的來源前面有 2.33 秒
  assert.strictEqual(r.applied, -70);
  near(C(p, b[0]).srcIn, 0);
  assert.deepStrictEqual(span(C(p, b[0])), [30, 120]);
  return synced(p);
});

t('多選 rippleTrim 結尾：每段都改同樣格數，後面累加推拉、不留空隙', () => {
  const { p, a, b, c, title } = scene();
  let r = core.rippleTrim(p, [a[0], b[0], c[0]], 'end', -10);
  assert.strictEqual(r.applied, -10);
  assert.deepStrictEqual([a, b, c].map(x => span(C(p, x[0]))), [[0, 20], [20, 40], [40, 60]]);
  assert.deepStrictEqual([a, b, c].map(x => span(C(p, x[1]))), [[0, 20], [20, 40], [40, 60]], '連結的聲音一起');
  assert.deepStrictEqual(span(C(p, title)), [70, 100], '三段後面的片段拉近 30 格');
  r = core.rippleTrim(p, [a[0], c[0]], 'end', 5);            // 只選 a、c：b 推 5 格、c 之後推 10 格
  assert.strictEqual(r.applied, 5);
  assert.deepStrictEqual([a, b, c].map(x => span(C(p, x[0]))), [[0, 25], [25, 45], [45, 70]]);
  assert.deepStrictEqual(span(C(p, title)), [80, 110]);
  return synced(p);
});

t('多選 rippleTrim 開頭：起點留在原位，夾到每段都做得到的量', () => {
  const { p, a, b, c } = scene();
  const r = core.rippleTrim(p, [b[0], c[0]], 'start', -1000);  // b 前面有 60 格把手、c 有 120 格 → 夾到 60
  assert.strictEqual(r.applied, -60);
  assert.deepStrictEqual([a, b, c].map(x => span(C(p, x[0]))), [[0, 30], [30, 120], [120, 210]]);
  near(C(p, b[0]).srcIn, 0);
  near(C(p, c[0]).srcIn, 2);
  return synced(p);
});

t('多選 trimEdge：同樣格數、夾到每段都做得到；連在一起的延長會被擋住', () => {
  const { p, a, b, c, title } = scene();
  let r = core.trimEdge(p, [a[0], b[0], c[0]], 'end', -10);
  assert.strictEqual(r.applied, -10);
  assert.deepStrictEqual([a, b, c].map(x => span(C(p, x[0]))), [[0, 20], [30, 50], [60, 80]], '不推動，留下空隙');
  assert.deepStrictEqual(span(C(p, title)), [100, 130]);
  r = core.trimEdge(p, [a[0], b[0], c[0]], 'end', 20);
  assert.strictEqual(r.applied, 10, '碰到下一段就停');
  unchanged(p, () => core.trimEdge(p, [a[0], b[0]], 'end', 1), /碰到旁邊/);
  return synced(p);
});

t('rippleTrim：鎖定軌不動、別的軌擋住時夾住、自己在鎖定軌失敗', () => {
  const p = setup();
  const [x] = put(p, 'mn', 0, 0, 2, { video: V(p) });        // V1 [0,60)
  put(p, 'mn', 60, 0, 1, { video: V(p) });                   // V1 [60,90)
  put(p, 'ma', 40, 0, 1);                                     // A1 [40,70) 跨過編輯點
  const [m2] = put(p, 'ma', 75, 0, 1);                        // A1 [75,105) 要被拉近
  const [lk] = put(p, 'ma', 80, 0, 1, { audio: A(p, 1) });   // A2 鎖定
  lock(p, A(p, 1));
  const r = core.rippleTrim(p, x, 'end', -30);
  assert.strictEqual(r.applied, -5, 'A1 只有 5 格空間可以拉近');
  assert.strictEqual(C(p, m2).start, 70);
  assert.strictEqual(C(p, lk).start, 80, '鎖定軌不動');
  unchanged(p, () => core.rippleTrim(p, x, 'end', -1), /A1.*擋住/);
  lock(p, V(p));
  unchanged(p, () => core.rippleTrim(p, x, 'end', 10), /鎖定/);
  return p;
});

t('rippleDelete：刪除並收合、多軌同步、轉場一起清掉', () => {
  const { p, a, b, c, title } = scene();
  assert.ok(core.addTransition(p, { leftClipId: a[0], duration: 10 }).ok);
  assert.ok(core.addTransition(p, { leftClipId: b[0], duration: 10 }).ok);
  const r = core.rippleDelete(p, [b[0]]);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.removed.sort(), b.slice().sort());
  assert.deepStrictEqual(span(C(p, c[0])), [30, 60]);
  assert.deepStrictEqual(span(C(p, c[1])), [30, 60]);
  assert.deepStrictEqual(span(C(p, title)), [70, 100]);
  assert.strictEqual(Object.keys(p.transitions).length, 0, '和被刪片段相關的轉場都清掉');
  // 多個片段
  assert.ok(core.rippleDelete(p, [a[0], title]).ok);
  assert.deepStrictEqual(span(C(p, c[0])), [0, 30]);
  return synced(p);
});

t('rippleDelete：別的軌擋住失敗不改、鎖定失敗、lift 只刪不補位', () => {
  const p = setup();
  const [x] = put(p, 'mn', 0, 0, 1, { video: V(p) });        // V1 [0,30)
  const [y] = put(p, 'mn', 30, 0, 1, { video: V(p) });       // V1 [30,60)
  put(p, 'ma', 0, 0, 2);                                      // A1 [0,60) 跨過
  put(p, 'ma', 60, 0, 1);                                     // A1 [60,90) 會撞上
  unchanged(p, () => core.rippleDelete(p, [x]), /A1.*擋住.*抬起/);
  lock(p, A(p));
  assert.ok(core.rippleDelete(p, [x]).ok, '鎖定 A1 後就可以');
  assert.strictEqual(C(p, y).start, 0);
  unchanged(p, () => core.rippleDelete(p, [core.clipsOnTrack(p, A(p))[0].id]), /鎖定/);
  unchanged(p, () => core.lift(p, ['nope']), /找不到/);
  lock(p, A(p), false);
  const r = core.lift(p, [y]);
  assert.ok(r.ok);
  assert.deepStrictEqual(core.clipsOnTrack(p, A(p)).map(c => c.start), [0, 60], '抬起不補位');
  return p;
});

t('deleteGap：收合空隙、不是空隙／最後面／鎖定／別的軌擋住', () => {
  const p = setup();
  put(p, 'mn', 0, 0, 1, { video: V(p) });
  const [y] = put(p, 'mn', 50, 0, 1, { video: V(p) });
  const [m] = put(p, 'ma', 60, 0, 1);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 40, duration: 5 });
  unchanged(p, () => core.deleteGap(p, V(p), 10), /不是空隙/);
  unchanged(p, () => core.deleteGap(p, V(p), 200), /後面沒有片段/);
  let r = core.deleteGap(p, V(p), 35);
  assert.ok(r.ok);
  assert.strictEqual(r.removed, 20);
  assert.strictEqual(C(p, y).start, 30);
  assert.strictEqual(C(p, m).start, 40);
  assert.strictEqual(C(p, ti.id).start, 30, '空隙裡的片段收到空隙開頭');
  // 其他軌擋住
  const q = setup();
  put(q, 'mn', 0, 0, 1, { video: V(q) });
  put(q, 'mn', 50, 0, 1, { video: V(q) });
  put(q, 'ma', 20, 0, 1);       // A1 [20,50) 在空隙裡
  put(q, 'ma', 50, 0, 1);       // A1 [50,80)
  unchanged(q, () => core.deleteGap(q, V(q), 40), /A1.*擋住/);
  lock(q, V(q));
  unchanged(q, () => core.deleteGap(q, V(q), 40), /鎖定/);
  unchanged(q, () => core.deleteGap(q, 'nope', 40), /找不到/);
  return [p, q];
});

// =====================================================================================
// 滾動／滑移／滑動
// =====================================================================================
t('roll：剪接點移動、總長不變、受把手限制、連結的聲音一起滾', () => {
  const { p, a, b, c } = scene();
  let r = core.roll(p, a[0], b[0], 10);
  assert.ok(r.ok);
  assert.deepStrictEqual([span(C(p, a[0])), span(C(p, b[0]))], [[0, 40], [40, 60]]);
  assert.deepStrictEqual([span(C(p, a[1])), span(C(p, b[1]))], [[0, 40], [40, 60]]);
  near(C(p, b[0]).srcIn, 2 + 10 / 30);
  assert.strictEqual(core.projectDuration(p), 130);
  r = core.roll(p, a[0], b[0], -1000);
  assert.strictEqual(r.applied, -39, '左邊最短 1 格（b 前面的來源還很多）');
  r = core.roll(p, b[0], c[0], 1000);
  assert.strictEqual(r.applied, 29, '右邊最短 1 格');
  unchanged(p, () => core.roll(p, a[0], c[0], 1), /相鄰/);
  // 媒體把手：a 的來源從 0 開始，b 從 0 開始的話往左滾不動
  const q = setup();
  const [x] = put(q, 'mv', 0, 0, 1, { video: V(q), audio: null });
  const [y] = put(q, 'mv', 30, 0, 1, { video: V(q), audio: null });
  unchanged(q, () => core.roll(q, x, y, -5), /開頭/);
  assert.strictEqual(core.roll(q, x, y, 5).ok, true);
  lock(q, V(q));
  unchanged(q, () => core.roll(q, x, y, 5), /鎖定/);
  return [synced(p), q];
});

t('slip：只改來源、受媒體範圍限制、標題與圖片不能滑移', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 10, 1, 2);
  let r = core.slip(p, v, 15);           // 往右拖 = 看較早的畫面
  assert.ok(r.ok);
  near(C(p, v).srcIn, 0.5); near(C(p, a).srcIn, 0.5);
  assert.deepStrictEqual(span(C(p, v)), [10, 40]);
  r = core.slip(p, v, 100);
  assert.strictEqual(r.applied, 15);
  unchanged(p, () => core.slip(p, v, 1), /開頭/);
  r = core.slip(p, v, -1e9);
  assert.strictEqual(r.applied, -270);
  near(C(p, v).srcIn, 9);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 0, duration: 10 });
  unchanged(p, () => core.slip(p, ti.id, 3), /沒有可以滑移/);
  const [img] = put(p, 'mi', 100);
  unchanged(p, () => core.slip(p, img, 3), /沒有可以滑移/);
  return synced(p);
});

t('slide：前後鄰居一個變長一個變短、總長不變、受把手與空隙限制', () => {
  const { p, a, b, c } = scene();
  let r = core.slide(p, b[0], 10);
  assert.ok(r.ok);
  assert.deepStrictEqual([span(C(p, a[0])), span(C(p, b[0])), span(C(p, c[0]))], [[0, 40], [40, 70], [70, 90]]);
  near(C(p, b[0]).srcIn, 2, '自己的內容不變');
  near(C(p, c[0]).srcIn, 4 + 10 / 30);
  assert.deepStrictEqual(span(C(p, b[1])), [40, 70], '連結的聲音一起滑');
  r = core.slide(p, b[0], 100);
  assert.strictEqual(r.applied, 19);
  r = core.slide(p, b[0], -1000);
  assert.strictEqual(r.applied, -58);
  // 沒有相鄰鄰居：只能滑進空隙
  const q = setup();
  const [x] = put(q, 'mn', 20, 0, 1, { video: V(q) });
  r = core.slide(q, x, -100);
  assert.strictEqual(r.applied, -20);
  unchanged(q, () => core.slide(q, x, -1), /開頭之前/);
  return [synced(p), q];
});

// =====================================================================================
// In/Out、三點剪輯
// =====================================================================================
t('setInOut／clearInOut', () => {
  const p = setup();
  assert.ok(core.setInOut(p, 10, 40).ok);
  assert.deepStrictEqual([p.inPoint, p.outPoint], [10, 40]);
  unchanged(p, () => core.setInOut(p, 40, 40), /Out 要在 In 之後/);
  unchanged(p, () => core.setInOut(p, -1, null));
  assert.ok(core.setInOut(p, null, 50).ok);
  assert.deepStrictEqual([p.inPoint, p.outPoint], [null, 50]);
  assert.ok(core.clearInOut(p).ok);
  assert.deepStrictEqual([p.inPoint, p.outPoint], [null, null]);
  return p;
});

t('editToTimeline 覆蓋：影像＋聲音連結、蓋掉原本的、沒聲音只放影像、音訊只放聲音、圖片 5 秒', () => {
  const p = setup();
  const r = core.editToTimeline(p, { mode: 'overwrite', mediaId: 'mv', srcIn: 1, srcOut: 2, frame: 12 });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.start, r.end], [12, 42]);
  const [v, a] = r.ids.map(id => C(p, id));
  assert.strictEqual(v.trackId, V(p)); assert.strictEqual(a.trackId, A(p));
  assert.ok(v.linkId && v.linkId === a.linkId);
  assert.strictEqual(v.name, '訪問');
  const r2 = core.editToTimeline(p, { mediaId: 'mn', srcIn: 0, srcOut: 0.5, frame: 20 });
  assert.strictEqual(r2.ids.length, 1);
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(span), [[12, 20], [20, 35], [35, 42]]);
  assert.deepStrictEqual(core.clipsOnTrack(p, A(p)).map(span), [[12, 42]], '沒聲音的影片不動音訊軌');
  const r3 = core.editToTimeline(p, { mediaId: 'ma', srcIn: 0, frame: 100, trackIds: { audio: A(p, 1) } });
  assert.deepStrictEqual(span(C(p, r3.ids[0])), [100, 340]);
  assert.strictEqual(C(p, r3.ids[0]).trackId, A(p, 1));
  const r4 = core.editToTimeline(p, { mediaId: 'mi', frame: 400 });
  assert.strictEqual(C(p, r4.ids[0]).duration, 150);
  const r5 = core.editToTimeline(p, { mediaId: 'mv', frame: 600, trackIds: { audio: null } });
  assert.strictEqual(r5.ids.length, 1, 'audio: null 表示不放聲音');
  assert.strictEqual(C(p, r5.ids[0]).duration, 300);
  return p;
});

t('editToTimeline 插入：所有未鎖定軌切開並推後，鎖定軌不動', () => {
  const p = setup();
  const [x, xa] = put(p, 'mv', 0, 0, 2);                 // [0,60)
  const [m] = put(p, 'ma', 0, 0, 3, { audio: A(p, 1) }); // A2 [0,90)
  lock(p, A(p, 1));
  const r = core.editToTimeline(p, { mode: 'insert', mediaId: 'mn', srcIn: 0, srcOut: 1, frame: 20 });
  assert.ok(r.ok);
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(span), [[0, 20], [20, 50], [50, 90]]);
  assert.deepStrictEqual(core.clipsOnTrack(p, A(p)).map(span), [[0, 20], [50, 90]]);
  assert.deepStrictEqual(span(C(p, m)), [0, 90], '鎖定軌不動');
  const right = core.clipsOnTrack(p, V(p))[2], rightA = core.clipsOnTrack(p, A(p))[1];
  assert.ok(right.linkId && right.linkId === rightA.linkId, '切開的右半互相連結');
  near(right.srcIn, 20 / 30);
  assert.strictEqual(C(p, x).duration, 20); assert.strictEqual(C(p, xa).duration, 20);
  return p;
});

t('editToTimeline 三點剪輯：In/Out 優先、只有 In、只有 Out（倒推）、加到結尾', () => {
  const p = setup();
  core.setInOut(p, 10, 25);
  let r = core.editToTimeline(p, { mediaId: 'mv', srcIn: 3, srcOut: 9, frame: 500 });
  assert.deepStrictEqual([r.start, r.end], [10, 25], '時間軸 In/Out 決定長度');
  near(C(p, r.ids[0]).srcIn, 3);
  core.setInOut(p, 100, null);
  r = core.editToTimeline(p, { mediaId: 'mn', srcIn: 0, srcOut: 1, frame: 500 });
  assert.deepStrictEqual([r.start, r.end], [100, 130]);
  core.setInOut(p, null, 200);
  r = core.editToTimeline(p, { mediaId: 'mn', srcIn: 0, srcOut: 1, frame: 500 });
  assert.deepStrictEqual([r.start, r.end], [170, 200], '只有 Out：結尾對齊 Out');
  core.setInOut(p, null, 10);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mn', srcIn: 0, srcOut: 1 }), /空間不夠/);
  core.setInOut(p, 0, 400);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mn', srcIn: 0, srcOut: 1 }), /來源長度不夠/);
  core.clearInOut(p);
  r = core.editToTimeline(p, { mode: 'append', mediaId: 'mv', srcIn: 0, srcOut: 1, frame: 0 });
  assert.deepStrictEqual([r.start, r.end], [200, 230], '加到結尾：目的軌道最後一個片段之後');
  return p;
});

t('editToTimeline ignoreInOut：拖放的明確位置不被時間軸 In/Out 搶走，In/Out 本身不變', () => {
  const p = setup();
  core.setInOut(p, 10, 25);
  let r = core.editToTimeline(p, { mediaId: 'mn', srcIn: 0, srcOut: 1, frame: 300, ignoreInOut: true });
  assert.deepStrictEqual([r.start, r.end], [300, 330], '放在 frame、長度＝來源長度');
  assert.deepStrictEqual([p.inPoint, p.outPoint], [10, 25], 'In/Out 保留');
  core.setInOut(p, null, 10);              // 沒有 ignoreInOut 會「空間不夠」的情況也能放
  r = core.editToTimeline(p, { mode: 'insert', mediaId: 'mn', srcIn: 0, srcOut: 1, frame: 400, ignoreInOut: true });
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual([r.start, r.end], [400, 430]);
  assert.deepStrictEqual([p.inPoint, p.outPoint], [null, 10]);
  return p;
});

t('editToTimeline 失敗：未知媒體、來源錯誤、鎖定軌、軌道種類不符', () => {
  const p = setup();
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'nope' }), /找不到這個媒體/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv', srcIn: 5, srcOut: 4 }), /Out 要在 In 之後/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv', srcIn: 11 }), /超過媒體長度/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv', srcIn: 1, srcOut: 1.01 }), /太短/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv', mode: 'lift' }), /不認得/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv', trackIds: { video: A(p) } }), /影片軌/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'ma', trackIds: { audio: null } }), /沒有可以放/);
  lock(p, A(p));
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv' }), /A1.*鎖定/);
  unchanged(p, () => core.editToTimeline(p, { mediaId: 'mv', mode: 'insert' }), /鎖定/);
  return p;
});

t('editToTimeline 替換：來源播放頭對齊時間軸播放頭、長度＝目標片段、連結的聲音一起換', () => {
  const p = setup();
  const [x, xa] = put(p, 'mn', 30, 0, 2, { video: V(p) }).concat(put(p, 'ma', 30, 0, 2));
  core.link(p, [x, xa]);
  let r = core.editToTimeline(p, { mode: 'replace', mediaId: 'mv', sourceTime: 5, frame: 40 });
  assert.ok(r.ok, r.reason);
  const c = C(p, x);
  assert.deepStrictEqual([c.mediaId, ...span(c)], ['mv', 30, 90]);
  near(c.srcIn, 5 - 10 / 30);
  near(core.sourceTimeAt(p, c, 40), 5, '播放頭這格就是來源播放頭那格');
  assert.strictEqual(C(p, xa).mediaId, 'mv');
  near(C(p, xa).srcIn, c.srcIn);
  // 沒給 sourceTime：來源 In 對齊片段開頭
  r = core.editToTimeline(p, { mode: 'replace', mediaId: 'mv', srcIn: 2, frame: 89 });
  near(C(p, x).srcIn, 2);
  // 來源不夠
  unchanged(p, () => core.editToTimeline(p, { mode: 'replace', mediaId: 'mv', sourceTime: 9.5, frame: 31 }), /來源長度不夠/);
  unchanged(p, () => core.editToTimeline(p, { mode: 'replace', mediaId: 'mv', sourceTime: 0.1, frame: 60 }), /不夠/);
  unchanged(p, () => core.editToTimeline(p, { mode: 'replace', mediaId: 'mv', frame: 200 }), /沒有片段可以替換/);
  // 換成沒聲音的影片：舊聲音拿掉
  r = core.editToTimeline(p, { mode: 'replace', mediaId: 'mn', srcIn: 0, frame: 50 });
  assert.ok(r.ok);
  assert.strictEqual(C(p, xa), undefined);
  assert.strictEqual(C(p, x).linkId, null);
  // 替換標題也可以
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 0, duration: 20 });
  r = core.editToTimeline(p, { mode: 'replace', mediaId: 'mi', frame: 5, trackIds: { video: V(p, 1) } });
  assert.ok(r.ok);
  assert.deepStrictEqual([C(p, ti.id).type, C(p, ti.id).title, C(p, ti.id).duration], ['media', null, 20]);
  lock(p, V(p));
  unchanged(p, () => core.editToTimeline(p, { mode: 'replace', mediaId: 'mn', frame: 50 }), /鎖定/);
  return p;
});

t('addClip：標題與色塊、覆蓋與插入、只能放影片軌', () => {
  const p = setup();
  const [v] = put(p, 'mn', 0, 0, 2, { video: V(p) });
  let r = core.addClip(p, { type: 'title', trackId: V(p), start: 20, duration: 10, title: { text: '你好', size: 120 } });
  assert.ok(r.ok);
  const ti = C(p, r.id);
  assert.deepStrictEqual([ti.title.text, ti.title.size, ti.title.font], ['你好', 120, 'WHZ-Heavy']);
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(span), [[0, 20], [20, 30], [30, 60]]);
  r = core.addClip(p, { type: 'solid', trackId: V(p, 1), start: 0, duration: 30, solidColor: '#ff0000', mode: 'insert' });
  assert.ok(r.ok);
  assert.strictEqual(C(p, r.id).solidColor, '#ff0000');
  assert.strictEqual(C(p, v).start, 30, '插入會推後');
  unchanged(p, () => core.addClip(p, { type: 'title', trackId: A(p), start: 0, duration: 10 }), /影片軌/);
  unchanged(p, () => core.addClip(p, { type: 'title', trackId: V(p), start: -5, duration: 10 }));
  unchanged(p, () => core.addClip(p, { type: 'title', trackId: V(p), start: 0, duration: 0.2 }), /1 格/);
  return p;
});

// =====================================================================================
// 連結、標記、旗標
// =====================================================================================
t('link／unlink：整組解開、鎖定軌不能改', () => {
  const { p, a, b, title } = scene();
  let r = core.link(p, [a[0], title]);
  assert.ok(r.ok);
  assert.strictEqual(C(p, a[1]).linkId, null, 'a 原本的群組只剩一個，清掉');
  assert.strictEqual(C(p, title).linkId, C(p, a[0]).linkId);
  assert.strictEqual(core.linkOffset(p, title), 100);
  unchanged(p, () => core.link(p, [a[0]]), /兩個/);
  r = core.unlink(p, [b[1]]);
  assert.ok(r.ok);
  assert.strictEqual(C(p, b[0]).linkId, null);
  unchanged(p, () => core.unlink(p, [b[0]]), /沒有連結/);
  lock(p, V(p, 1));
  unchanged(p, () => core.unlink(p, [a[0]]), /鎖定/);
  unchanged(p, () => core.link(p, [b[0], title]), /鎖定/);
  return p;
});

t('時間軸標記：新增、更新、刪除、同一格不能重複、顏色檢查', () => {
  const p = setup();
  const r = core.addMarker(p, { frame: 30, color: 'red', name: '開場' });
  assert.ok(r.ok);
  assert.ok(core.addMarker(p, { frame: 10 }).ok);
  assert.deepStrictEqual(p.markers.map(m => m.frame), [10, 30]);
  assert.deepStrictEqual(p.markers[1], { id: r.id, frame: 30, duration: 0, color: 'red', name: '開場', note: '' });
  unchanged(p, () => core.addMarker(p, { frame: 30 }), /已經有標記/);
  unchanged(p, () => core.addMarker(p, { frame: 5, color: 'black' }), /顏色/);
  unchanged(p, () => core.addMarker(p, { frame: -1 }));
  assert.ok(core.updateMarker(p, r.id, { frame: 5, note: '備註', duration: 10 }).ok);
  assert.deepStrictEqual(p.markers.map(m => m.frame), [5, 10]);
  assert.strictEqual(p.markers[0].note, '備註');
  unchanged(p, () => core.updateMarker(p, r.id, { frame: 10 }), /已經有標記/);
  unchanged(p, () => core.updateMarker(p, 'nope', {}), /找不到/);
  assert.ok(core.removeMarker(p, r.id).ok);
  unchanged(p, () => core.removeMarker(p, r.id), /找不到/);
  return p;
});

t('片段標記與旗標', () => {
  const p = setup();
  const [v] = put(p, 'mn', 100, 0, 1, { video: V(p) });
  const r = core.addClipMarker(p, v, { frame: 110, color: 'green' });
  assert.ok(r.ok);
  assert.strictEqual(C(p, v).markers[0].offset, 10);
  unchanged(p, () => core.addClipMarker(p, v, { offset: 30 }), /範圍內/);
  unchanged(p, () => core.addClipMarker(p, v, { offset: 10 }), /已經有標記/);
  assert.ok(core.updateClipMarker(p, v, r.id, { offset: 3, name: '笑' }).ok);
  assert.deepStrictEqual([C(p, v).markers[0].offset, C(p, v).markers[0].name, C(p, v).markers[0].color], [3, '笑', 'green']);
  unchanged(p, () => core.updateClipMarker(p, v, r.id, { offset: -1 }), /範圍內/);
  assert.ok(core.removeClipMarker(p, v, r.id).ok);
  unchanged(p, () => core.removeClipMarker(p, v, r.id), /找不到/);
  assert.ok(core.setFlags(p, v, ['red', 'red', 'blue']).ok);
  assert.deepStrictEqual(C(p, v).flags, ['red', 'blue']);
  unchanged(p, () => core.setFlags(p, v, ['black']), /旗標顏色/);
  lock(p, V(p));
  unchanged(p, () => core.setFlags(p, v, []), /鎖定/);
  unchanged(p, () => core.addClipMarker(p, v, { offset: 1 }), /鎖定/);
  return p;
});

// =====================================================================================
// 變速、定格
// =====================================================================================
t('setSpeed 非波紋：長度不變、來源用量改變，媒體不夠時失敗不改', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 0, 2, 4);     // 60 格
  assert.ok(core.setSpeed(p, v, { speed: 2 }).ok);
  assert.deepStrictEqual([C(p, v).duration, C(p, v).speed, C(p, a).speed], [60, 2, 2]);
  assert.deepStrictEqual(core.sourceSpan(p, a), { from: 2, to: 6 });
  unchanged(p, () => core.setSpeed(p, v, { speed: 5 }), /波紋/);  // 2 + 10 秒 > 10 秒
  unchanged(p, () => core.setSpeed(p, v, { speed: 0 }), /速度/);
  unchanged(p, () => core.setSpeed(p, v, { speed: 1000 }), /速度/);
  assert.ok(core.setSpeed(p, v, { reverse: true }).ok);
  assert.deepStrictEqual([C(p, v).reverse, C(p, a).reverse, C(p, v).speed], [true, true, 2]);
  assert.deepStrictEqual(core.sourceSpan(p, v), { from: 2, to: 6 }, '倒播用的來源區段不變');
  return synced(p);
});

t('setSpeed 波紋：長度跟著變並推拉後方；受媒體長度限制', () => {
  const { p, a, b, title } = scene();
  let r = core.setSpeed(p, a[0], { speed: 2, ripple: true });
  assert.ok(r.ok);
  assert.strictEqual(r.duration, 15);
  assert.deepStrictEqual(span(C(p, a[1])), [0, 15]);
  assert.deepStrictEqual(span(C(p, b[0])), [15, 45]);
  assert.deepStrictEqual(span(C(p, title)), [85, 115]);
  r = core.setSpeed(p, a[0], { speed: 0.5, ripple: true });
  assert.strictEqual(r.duration, 60);
  assert.deepStrictEqual(span(C(p, b[1])), [60, 90]);
  near(core.sourceSpan(p, a[0]).to, 1);
  // 媒體不夠：mn 3 秒，從 2.5 秒開始 0.5 秒，放慢到 0.25 → 2 秒 = 60 格，夠；改成來源到結尾都用掉
  const q = setup();
  const [x] = put(q, 'mn', 0, 1, 3, { video: V(q) });   // 60 格
  r = core.setSpeed(q, x, { speed: 3, ripple: true });
  assert.strictEqual(r.duration, 20);
  near(core.sourceSpan(q, x).to, 3);
  return [synced(p), q];
});

t('setSpeed：圖片、標題、定格不能變速；鎖定軌', () => {
  const p = setup();
  const [img] = put(p, 'mi', 0);
  unchanged(p, () => core.setSpeed(p, img, { speed: 2 }), /只有影片和音訊/);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 0, duration: 10 });
  unchanged(p, () => core.setSpeed(p, ti.id, { speed: 2 }), /只有影片和音訊/);
  const [v, a] = put(p, 'mv', 200, 0, 2);
  core.freezeFrame(p, v, 210);
  unchanged(p, () => core.setSpeed(p, v, { speed: 2 }), /定格/);
  assert.ok(core.setSpeed(p, a, { speed: 2, linked: false }).ok, '聲音自己可以');
  lock(p, A(p));
  unchanged(p, () => core.setSpeed(p, a, { speed: 1 }), /鎖定/);
  return p;
});

t('freezeFrame：整段定格、插入定格並波紋推後', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 0, 1, 3);           // [0,60)
  const [n] = put(p, 'mn', 60, 0, 1, { video: V(p) });
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 70, duration: 10 });
  const t20 = core.sourceTimeAt(p, v, 20);
  let r = core.freezeFrame(p, v, 20, { duration: 45 });
  assert.ok(r.ok);
  const f = C(p, r.id);
  assert.deepStrictEqual([f.freeze, f.start, f.duration, f.trackId, f.linkId], [true, 20, 45, V(p), null]);
  near(core.sourceTimeAt(p, f, 30), t20);
  assert.deepStrictEqual(core.clipsOnTrack(p, V(p)).map(span), [[0, 20], [20, 65], [65, 105], [105, 135]]);
  assert.deepStrictEqual(core.clipsOnTrack(p, A(p)).map(span), [[0, 20], [65, 105]], '聲音在定格處留空');
  assert.strictEqual(C(p, n).start, 105);
  assert.strictEqual(C(p, ti.id).start, 115);
  near(core.sourceTimeAt(p, core.clipAt(p, V(p), 65), 65), t20, '定格後接回原本那格');
  // 整段定格
  r = core.freezeFrame(p, n, 110);
  assert.ok(r.ok);
  assert.ok(C(p, n).freeze);
  near(C(p, n).srcIn, 5 / 30);
  unchanged(p, () => core.freezeFrame(p, a, 5), /音訊/);
  unchanged(p, () => core.freezeFrame(p, v, 50), /範圍內/);
  unchanged(p, () => core.freezeFrame(p, v, 5, { duration: -3 }), /1 格/);
  unchanged(p, () => core.freezeFrame(p, ti.id, 116), /只有影片/);
  const [img] = put(p, 'mi', 500);
  unchanged(p, () => core.freezeFrame(p, img, 500), /本來就是定格/);
  lock(p, V(p));
  unchanged(p, () => core.freezeFrame(p, v, 5), /鎖定/);
  return synced(p);
});

// =====================================================================================
// 轉場
// =====================================================================================
t('轉場：新增（相鄰／尾端淡出）、長度夾住、取代既有、更新、刪除、範圍', () => {
  const { p, a, b, c } = scene();
  let r = core.addTransition(p, { leftClipId: a[0], type: 'crossDissolve', duration: 20 });
  assert.ok(r.ok);
  const tr = p.transitions[r.id];
  assert.deepStrictEqual([tr.rightClipId, tr.align, tr.duration, tr.trackId], [b[0], 'center', 20, V(p)]);
  assert.deepStrictEqual(core.transitionRange(p, tr), { from: 20, to: 40, edit: 30, cut: 30 });
  r = core.addTransition(p, { leftClipId: a[0], type: 'wipe', duration: 999, align: 'start' });
  assert.strictEqual(r.id, tr.id, '同一個剪接點取代原本的');
  assert.deepStrictEqual([p.transitions[r.id].type, p.transitions[r.id].duration], ['wipe', 30]);
  assert.deepStrictEqual(core.transitionRange(p, r.id), { from: 30, to: 60, edit: 30, cut: 30 });
  r = core.addTransition(p, { leftClipId: c[0], type: 'fadeToBlack', align: 'center' });
  const fade = p.transitions[r.id];
  assert.deepStrictEqual([fade.rightClipId, fade.align, fade.duration], [null, 'end', 15]);
  assert.deepStrictEqual(core.transitionRange(p, fade), { from: 75, to: 90, edit: 90, cut: 90 });
  assert.ok(core.updateTransition(p, fade.id, { duration: 10, ease: 'easeInOut', color: '#ffffff' }).ok);
  assert.deepStrictEqual([fade.duration, fade.ease, fade.color].length, 3);
  assert.deepStrictEqual([p.transitions[fade.id].duration, p.transitions[fade.id].ease], [10, 'easeInOut']);
  unchanged(p, () => core.updateTransition(p, fade.id, { type: 'teleport' }), /轉場種類/);
  unchanged(p, () => core.updateTransition(p, fade.id, { duration: 0 }), /1 格/);
  unchanged(p, () => core.addTransition(p, { leftClipId: 'nope' }), /找不到/);
  assert.deepStrictEqual(core.transitionsOfClip(p, b[0]).map(x => x.id), [tr.id]);
  assert.ok(core.removeTransition(p, fade.id).ok);
  unchanged(p, () => core.removeTransition(p, fade.id), /找不到/);
  return synced(p);
});

t('轉場：片段分開時留在沒被移動的一側、刪除、修短時縮短；鎖定軌', () => {
  const { p, a, b } = scene();
  const r = core.addTransition(p, { leftClipId: a[0], duration: 20 });
  assert.ok(core.rippleTrim(p, b[0], 'end', -20).ok);
  assert.strictEqual(p.transitions[r.id].duration, 10, '右邊片段變短，轉場跟著縮');
  assert.ok(core.moveClips(p, [b[0]], 5, 0).ok);
  assert.deepStrictEqual(Object.values(p.transitions).map(x => [x.id, x.leftClipId, x.rightClipId]), [[r.id, a[0], null]], '右邊片段被移走：轉場留在左片段尾端（淡出）');
  const r2 = core.addTransition(p, { leftClipId: a[0] });
  assert.strictEqual(r2.id, r.id, '同一個邊緣取代原本的');
  assert.strictEqual(p.transitions[r2.id].rightClipId, null);
  assert.ok(core.lift(p, [a[0]]).ok);
  assert.strictEqual(Object.keys(p.transitions).length, 0);
  // 一起移動時轉場保留、跟著換軌
  const q = setup();
  const [x] = put(q, 'mn', 0, 0, 1, { video: V(q) });
  const [y] = put(q, 'mn', 30, 1, 2, { video: V(q) });
  const r3 = core.addTransition(q, { leftClipId: x });
  assert.ok(core.moveClips(q, [x, y], 10, 1).ok);
  assert.strictEqual(q.transitions[r3.id].trackId, V(q, 1));
  lock(q, V(q, 1));
  unchanged(q, () => core.removeTransition(q, r3.id), /鎖定/);
  unchanged(q, () => core.addTransition(q, { leftClipId: y }), /鎖定/);
  unchanged(q, () => core.addTransition(q, { rightClipId: x }), /鎖定/);
  return [p, q];
});

// ---- 單邊轉場（轉場屬於片段邊緣，同 DaVinci）---------------------------------------
const trList = p => Object.values(p.transitions).map(x => ({ id: x.id, l: x.leftClipId, r: x.rightClipId, d: x.duration, side: core.transitionSide(x) })).sort((a, b) => (a.id < b.id ? -1 : 1));

t('轉場：一般修剪拉開剪接點 → 留在被修剪片段的邊緣（左修 → 尾端淡出、右修 → 開頭淡入）', () => {
  const out = [];
  // 左片段尾端往左拉
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 20 });
    const x = core.trimEdge(p, a[0], 'end', -6);
    assert.ok(x.ok && x.applied === -6, x.reason);
    assert.deepStrictEqual(trList(p), [{ id: r.id, l: a[0], r: null, d: 20, side: 'out' }], '左片段被修剪：轉場跟著左片段的尾端');
    assert.deepStrictEqual(core.transitionRange(p, r.id), { from: 4, to: 24, edit: 24, cut: 24 });
    assert.strictEqual(core.transitionAtEdge(p, a[0], 'end').id, r.id);
    assert.strictEqual(core.transitionAtEdge(p, b[0], 'start'), null);
    out.push(synced(p)); }
  // 右片段開頭往右拉
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 20 });
    assert.ok(core.trimEdge(p, b[0], 'start', 4).ok);
    assert.deepStrictEqual(trList(p), [{ id: r.id, l: null, r: b[0], d: 20, side: 'in' }], '右片段被修剪：轉場跟著右片段的開頭');
    assert.deepStrictEqual(core.transitionRange(p, r.id), { from: 34, to: 54, edit: 34, cut: 34 });
    out.push(synced(p)); }
  // 連結選取關閉、只修影像：一樣跟著被修剪的影片片段
  { const { p, a } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 10 });
    assert.ok(core.trimEdge(p, a[0], 'end', -3, { linked: false }).ok);
    assert.strictEqual(core.transitionSide(p.transitions[r.id]), 'out');
    out.push(p); }
  // 修剪到比轉場還短：轉場跟著縮短
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 20 });
    assert.ok(core.trimEdge(p, b[0], 'start', 22).ok);
    assert.deepStrictEqual([core.transitionSide(p.transitions[r.id]), p.transitions[r.id].duration], ['in', 8], '右片段只剩 8 格，開頭淡入縮成 8 格');
    out.push(synced(p)); }
  return out;
});

t('轉場：移動拉開 → 留在沒被移動的一側；兩側都被覆蓋修短 → 留在左側', () => {
  const out = [];
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 12 });
    assert.ok(core.moveClips(p, [b[0]], 3, 0).ok);
    assert.deepStrictEqual(trList(p), [{ id: r.id, l: a[0], r: null, d: 12, side: 'out' }], '移走右片段：留在左片段（沒被移動）');
    out.push(synced(p)); }
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 12 });
    assert.ok(core.moveClips(p, [a[0]], 0, 1).ok, '左片段換到 V2');
    assert.deepStrictEqual(trList(p), [{ id: r.id, l: null, r: b[0], d: 12, side: 'in' }], '移走左片段：留在右片段（沒被移動）');
    assert.strictEqual(p.transitions[r.id].trackId, V(p));
    out.push(synced(p)); }
  { const { p, a, b, c } = scene();
    const r = core.addTransition(p, { leftClipId: b[0], duration: 10 });
    // 插入到剪接點：右邊被推開，左邊沒動
    assert.ok(core.editToTimeline(p, { mode: 'insert', mediaId: 'mn', srcIn: 0, srcOut: 0.5, frame: 60, trackIds: { video: V(p) } }).ok);
    const x = core.clipAt(p, V(p), 60).id;
    assert.deepStrictEqual(trList(p).map(q => [q.l, q.r]), [[b[0], x]], '插入的新片段緊接在左片段後面：變回兩片段之間（b｜新片段）');
    assert.ok(c);
    out.push(p); }
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 10 });
    // 覆蓋一段無聲影片蓋住剪接點兩側：左右邊緣都被修短
    const [x] = put(p, 'mn', 25, 0, 10 / 30, { video: V(p) });
    assert.deepStrictEqual(trList(p).map(q => [q.id, q.l, q.r]), [[r.id, a[0], x]], '兩側都被修剪：留在左側，左側緊接著新片段 → a｜新片段');
    assert.deepStrictEqual([C(p, a[0]).duration, C(p, b[0]).start], [25, 35]);
    out.push(p); }
  return out;
});

t('轉場：刪除片段只刪附在它上面的轉場', () => {
  const { p, a, b, c } = scene();
  const head = core.addTransition(p, { rightClipId: a[0], type: 'fadeToBlack', duration: 8 });
  assert.deepStrictEqual([head.side, p.transitions[head.id].leftClipId, p.transitions[head.id].align], ['in', null, 'start'], '時間軸起點的片段：開頭淡入');
  const ab = core.addTransition(p, { leftClipId: a[0], duration: 10 });
  const tail = core.addTransition(p, { leftClipId: c[0], duration: 6 });
  assert.strictEqual(tail.side, 'out');
  assert.ok(core.lift(p, [b[0]]).ok);
  assert.deepStrictEqual(trList(p).map(x => x.id).sort(), [head.id, tail.id].sort(), '只刪掉 a｜b（附在 b 上），a 的開頭淡入、c 的尾端淡出都留著');
  assert.ok(core.lift(p, [c[0]]).ok);
  assert.deepStrictEqual(trList(p).map(x => x.id), [head.id]);
  assert.ok(!p.transitions[ab.id]);
  return synced(p);
});

t('轉場：重新接上時變回雙邊（兩側都有單邊 → 保留左側；只有一側 → 那一個變雙邊）、移回去回到原狀', () => {
  const out = [];
  // 兩側各有一個單邊轉場，刪掉空隙後接上
  { const p = setup();
    const [x] = put(p, 'mn', 0, 0, 1, { video: V(p) });
    const [y] = put(p, 'mn', 50, 1, 2, { video: V(p) });
    const tl = core.addTransition(p, { leftClipId: x, type: 'dipToColor', duration: 10 });
    const hr = core.addTransition(p, { rightClipId: y, type: 'wipe', duration: 14 });
    assert.deepStrictEqual([tl.side, hr.side], ['out', 'in']);
    assert.ok(core.deleteGap(p, V(p), 40).ok);
    assert.deepStrictEqual(trList(p), [{ id: tl.id, l: x, r: y, d: 10, side: 'both' }], '保留左側那個並轉成雙邊');
    assert.strictEqual(p.transitions[tl.id].type, 'dipToColor');
    assert.strictEqual(p.transitions[tl.id].align, 'end', '使用者加的尾端淡出存成 end：接上後位置不變');
    out.push(p); }
  // 只有右側有開頭淡入
  { const p = setup();
    const [x] = put(p, 'mn', 0, 0, 1, { video: V(p) });
    const [y] = put(p, 'mn', 50, 1, 2, { video: V(p) });
    const hr = core.addTransition(p, { rightClipId: y, duration: 14 });
    assert.ok(core.trimEdge(p, y, 'start', -20).ok, '把右片段開頭往左拉到接上');
    assert.deepStrictEqual(trList(p), [{ id: hr.id, l: x, r: y, d: 14, side: 'both' }], '只有一側：自動轉回雙邊');
    assert.deepStrictEqual(core.transitionRange(p, hr.id), { from: 30, to: 44, edit: 30, cut: 30 }, 'align start：仍從剪接點開始');
    out.push(p); }
  // 移開再移回去：回到原本的雙邊（對齊方式保留）
  { const { p, a, b } = scene();
    const r = core.addTransition(p, { leftClipId: a[0], duration: 20, align: 'center' });
    const before = JSON.stringify(p.transitions);
    assert.ok(core.moveClips(p, [b[0]], 7, 0).ok);
    assert.strictEqual(core.transitionSide(p.transitions[r.id]), 'out');
    assert.deepStrictEqual(core.transitionRange(p, r.id), { from: 10, to: 30, edit: 30, cut: 30 }, '單邊時貼著邊緣（不看 align）');
    assert.ok(core.moveClips(p, [b[0]], -7, 0).ok);
    assert.strictEqual(JSON.stringify(p.transitions), before, '移回去：轉場回到原本的雙邊、置中');
    // 修剪開再修回來也一樣
    assert.ok(core.trimEdge(p, b[0], 'start', 5).ok);
    assert.strictEqual(core.transitionSide(p.transitions[r.id]), 'in');
    assert.ok(core.trimEdge(p, b[0], 'start', -5).ok);
    assert.strictEqual(JSON.stringify(p.transitions), before);
    out.push(synced(p)); }
  // 波紋刪除中間片段：兩邊的單邊轉場碰在一起
  { const { p, a, b, c } = scene();
    assert.ok(core.trimEdge(p, a[0], 'end', -10).ok && core.trimEdge(p, c[0], 'start', 10).ok);
    const ta = core.addTransition(p, { leftClipId: a[0], duration: 6 });
    const hc = core.addTransition(p, { rightClipId: c[0], duration: 8 });
    assert.deepStrictEqual([ta.side, hc.side], ['out', 'in']);
    assert.ok(core.rippleDelete(p, [b[0]]).ok);
    assert.ok(core.deleteGap(p, V(p), 25).ok);
    assert.deepStrictEqual(trList(p), [{ id: ta.id, l: a[0], r: c[0], d: 6, side: 'both' }]);
    out.push(synced(p)); }
  return out;
});

t('轉場：開頭淡入的新增、更新、刪除、取代、長度夾住、鎖定', () => {
  const { p, a, b, title } = scene();
  // 標題在 V2 [100,130)，前面是空隙
  let r = core.addTransition(p, { rightClipId: title, type: 'crossDissolve', duration: 999, align: 'center' });
  assert.ok(r.ok, r.reason);
  const tr = p.transitions[r.id];
  assert.deepStrictEqual([tr.leftClipId, tr.rightClipId, tr.align, tr.duration, tr.trackId, r.side], [null, title, 'start', 30, V(p, 1), 'in'], '長度夾在片段長度內');
  assert.deepStrictEqual(core.transitionRange(p, tr), { from: 100, to: 130, edit: 100, cut: 100 });
  assert.ok(core.updateTransition(p, r.id, { duration: 12, align: 'end', type: 'zoom' }).ok);
  assert.deepStrictEqual([p.transitions[r.id].duration, p.transitions[r.id].align, p.transitions[r.id].type], [12, 'start', 'zoom'], '單邊轉場的對齊固定貼著邊緣');
  const r2 = core.addTransition(p, { rightClipId: title, type: 'blur', duration: 5 });
  assert.strictEqual(r2.id, r.id, '同一個邊緣取代原本的');
  assert.strictEqual(Object.keys(p.transitions).length, 1);
  // 在前面緊接著片段的開頭加 → 就是兩片段之間的轉場（和加在左片段結尾一樣）
  const r3 = core.addTransition(p, { rightClipId: b[0], duration: 10 });
  assert.deepStrictEqual([p.transitions[r3.id].leftClipId, p.transitions[r3.id].rightClipId, r3.side], [a[0], b[0], 'both']);
  const r4 = core.addTransition(p, { leftClipId: a[0], type: 'push' });
  assert.strictEqual(r4.id, r3.id, '從左邊加同一個剪接點也是取代');
  assert.strictEqual(Object.keys(p.transitions).length, 2);
  unchanged(p, () => core.addTransition(p, {}), /指定/);
  unchanged(p, () => core.addTransition(p, { rightClipId: 'nope' }), /找不到/);
  unchanged(p, () => core.updateTransition(p, r.id, { duration: -1 }), /1 格/);
  assert.ok(core.removeTransition(p, r.id).ok);
  assert.ok(!p.transitions[r.id]);
  lock(p, V(p));
  unchanged(p, () => core.addTransition(p, { rightClipId: a[0] }), /鎖定/);
  unchanged(p, () => core.updateTransition(p, r3.id, { duration: 4 }), /鎖定/);
  return synced(p);
});

t('轉場：單邊轉場在刀片、修剪、波紋、復原重做下維持不變式', () => {
  const { p, a, b, c } = scene();
  const h = core.createHistory(() => p, () => {});
  const head = h.run('加', q => core.addTransition(q, { rightClipId: a[0], duration: 10 }));
  const tail = h.run('加', q => core.addTransition(q, { leftClipId: c[0], duration: 10 }));
  assert.ok(head.ok && tail.ok);
  // 在 c 中間切開：尾端淡出跟著右半，開頭淡入留在左半
  assert.ok(h.run('切', q => core.blade(q, 75)).ok);
  const cr = core.clipAt(p, V(p), 80).id;
  assert.strictEqual(p.transitions[tail.id].leftClipId, cr);
  assert.ok(h.run('切', q => core.blade(q, 5)).ok);
  assert.strictEqual(p.transitions[head.id].rightClipId, a[0], '開頭淡入留在左半（片段開頭）');
  assert.strictEqual(p.transitions[head.id].duration, 5, '左半只剩 5 格：縮短');
  // 波紋修剪開頭：片段變短，淡入跟著縮
  assert.ok(h.run('波紋', q => core.rippleTrim(q, a[0], 'start', 3)).ok);
  assert.deepStrictEqual([C(p, a[0]).start, p.transitions[head.id].duration], [0, 2]);
  const end = core.serialize(p);
  while (h.undo()) assertInvariants(p);
  assert.strictEqual(Object.keys(p.transitions).length, 0);
  while (h.redo()) assertInvariants(p);
  assert.strictEqual(core.serialize(p), end);
  return synced(p);
});

t('轉場：序列化來回一致；讀舊存檔（缺欄位、沒有 leftClipId: null 的寫法）', () => {
  const { p, a, b, c, title } = scene();
  core.addTransition(p, { rightClipId: title, duration: 9 });
  core.addTransition(p, { leftClipId: c[0], type: 'fadeToBlack' });
  core.addTransition(p, { leftClipId: a[0], type: 'wipe', direction: 'up' });
  const q = core.deserialize(core.serialize(p));
  assert.deepStrictEqual(q, p);
  assert.strictEqual(core.serialize(q), core.serialize(p));
  // 舊存檔：只有 leftClipId（rightClipId 缺或 null），少了 align／ease 等欄位
  const raw = JSON.parse(core.serialize(p));
  raw.transitions = {
    x1: { id: 'x1', leftClipId: a[0], rightClipId: b[0], type: 'crossDissolve', duration: 10 },
    x2: { id: 'x2', trackId: V(p), leftClipId: c[0], type: 'fadeToBlack', duration: 15, align: 'end' },
    x3: { id: 'x3', leftClipId: 'gone', rightClipId: null, type: 'wipe', duration: 5 },
  };
  const o = core.deserialize(raw);
  assert.deepStrictEqual(Object.keys(o.transitions).sort(), ['x1', 'x2'], '找不到片段的轉場丟掉');
  assert.deepStrictEqual([o.transitions.x1.trackId, o.transitions.x1.align, o.transitions.x1.ease, o.transitions.x1.direction], [V(p), 'center', 'linear', 'left']);
  assert.deepStrictEqual([o.transitions.x2.leftClipId, o.transitions.x2.rightClipId], [c[0], null]);
  // 舊存檔裡兩側不相鄰的轉場：讀檔時留在左側
  raw.transitions = { x4: { id: 'x4', trackId: V(p), leftClipId: a[0], rightClipId: c[0], type: 'crossDissolve', duration: 10, align: 'center', color: '#000000', direction: 'left', ease: 'linear' } };
  const o2 = core.deserialize(raw);
  assert.deepStrictEqual([o2.transitions.x4.leftClipId, o2.transitions.x4.rightClipId], [a[0], b[0]], 'a 後面緊接著 b：讀檔整理成 a｜b');
  return [p, q, o, o2];
});

// ---- 轉場時的聲音（由影片轉場推出）-------------------------------------------------
t('轉場聲音：等功率交叉淡化的範圍、把手不足時縮短、單邊淡入淡出、增益', () => {
  const { p, a, b, c } = scene();
  // a：mv 0~1 秒（後面把手 9 秒）；b：mv 2~3 秒（前面把手 2 秒）
  const r = core.addTransition(p, { leftClipId: a[0], duration: 20 });
  let plan = core.audioTransitionPlan(p);
  assert.deepStrictEqual(plan[a[1]], { from: 0, to: 40, fades: [{ dir: 'out', from: 20, to: 40 }] }, '左段多播到轉場結尾、淡出');
  assert.deepStrictEqual(plan[b[1]], { from: 20, to: 60, fades: [{ dir: 'in', from: 20, to: 40 }] }, '右段提早從轉場開頭播、淡入');
  assert.ok(!plan[a[0]] && !plan[b[0]], '影片片段本身沒有聲音計畫');
  // 增益：中點各 −3dB，功率和恆為 1
  const fo = plan[a[1]].fades, fi = plan[b[1]].fades;
  near(core.transitionFadeGain(fo, 30), Math.SQRT1_2); near(core.transitionFadeGain(fi, 30), Math.SQRT1_2);
  for (let F = 18; F <= 42; F += 0.5) near(core.transitionFadeGain(fo, F) ** 2 + core.transitionFadeGain(fi, F) ** 2, 1, `第 ${F} 格功率`);
  assert.deepStrictEqual([core.transitionFadeGain(fo, 20), core.transitionFadeGain(fo, 40), core.transitionFadeGain(fi, 20), core.transitionFadeGain(fi, 40)], [1, 0, 0, 1]);
  // 右段前面的把手只剩 4 格：開頭那半縮短（左邊在把手用盡處開始淡化）
  assert.ok(core.slip(p, b[0], 56).ok, '把 b 的來源往右拖到只剩 4 格前把手');
  near(C(p, b[1]).srcIn, 2 - 56 / 30);
  plan = core.audioTransitionPlan(p);
  assert.deepStrictEqual(plan[b[1]].fades, [{ dir: 'in', from: 26, to: 40 }], '前半縮成 4 格');
  assert.deepStrictEqual([plan[b[1]].from, plan[a[1]].to], [26, 40]);
  // 完全沒有前把手、align start（全部在剪接點之後）→ 只要左段的後把手
  assert.ok(core.updateTransition(p, r.id, { align: 'start' }).ok);
  assert.ok(core.slip(p, b[0], 4).ok);
  plan = core.audioTransitionPlan(p);
  assert.deepStrictEqual(plan[a[1]].fades, [{ dir: 'out', from: 30, to: 50 }]);
  // align end：全部在剪接點之前，右段沒有前把手 → 沒辦法交叉，維持硬切
  assert.ok(core.updateTransition(p, r.id, { align: 'end' }).ok);
  plan = core.audioTransitionPlan(p);
  assert.ok(!plan[a[1]] && !plan[b[1]], '兩邊都沒有可用的把手：硬切');
  // 單邊：c 的尾端淡出 → c 的聲音淡出；a 的開頭淡入 → a 的聲音淡入
  core.addTransition(p, { leftClipId: c[0], duration: 12 });
  core.addTransition(p, { rightClipId: a[0], duration: 9 });
  plan = core.audioTransitionPlan(p);
  assert.deepStrictEqual(plan[c[1]], { from: 60, to: 90, fades: [{ from: 78, to: 90, dir: 'out' }] });
  assert.deepStrictEqual(plan[a[1]], { from: 0, to: 30, fades: [{ from: 0, to: 9, dir: 'in' }] });
  near(core.transitionFadeGain(plan[a[1]].fades, 0), 0, '淡入第一格接近 0');
  return synced(p);
});

t('轉場聲音：聲音不相鄰、沒有連結、不同音訊軌時不交叉；J-cut 以聲音的剪接點為準', () => {
  const { p, a, b } = scene();
  core.addTransition(p, { leftClipId: a[0], duration: 10 });
  // 連結選取關閉時只修 b 的聲音開頭：聲音不相鄰 → 不交叉
  assert.ok(core.trimEdge(p, b[1], 'start', 4, { linked: false }).ok);
  let plan = core.audioTransitionPlan(p);
  assert.ok(!plan[a[1]] && !plan[b[1]], '聲音之間有空隙：不交叉');
  assert.ok(core.trimEdge(p, b[1], 'start', -4, { linked: false }).ok);
  // J-cut：聲音的剪接點往前 6 格（滾動修剪只動聲音）
  assert.ok(core.roll(p, a[1], b[1], -6, { linked: false }).ok);
  plan = core.audioTransitionPlan(p);
  assert.deepStrictEqual(plan[a[1]].fades, [{ dir: 'out', from: 19, to: 29 }], '以聲音的剪接點 24 為中心');
  assert.deepStrictEqual(plan[b[1]].fades, [{ dir: 'in', from: 19, to: 29 }]);
  // 聲音放到不同的音訊軌：不交叉
  assert.ok(core.moveClips(p, [b[1]], 0, 1, { linked: false }).ok);
  plan = core.audioTransitionPlan(p);
  assert.ok(!plan[a[1]] && !plan[b[1]]);
  // 解除連結：不交叉
  const q = scene();
  core.addTransition(q.p, { leftClipId: q.a[0], duration: 10 });
  assert.ok(core.unlink(q.p, [q.b[0]]).ok);
  assert.ok(!core.audioTransitionPlan(q.p)[q.a[1]]);
  return [p, q.p];
});

// =====================================================================================
// 屬性
// =====================================================================================
t('setClipProps：深層合併、EQ 依索引合併、數值夾住、不能改結構欄位', () => {
  const p = setup();
  const [v, a] = put(p, 'mv', 0, 0, 2);
  assert.ok(core.setClipProps(p, v, { video: { transform: { zoomX: 1.5, opacity: 3 } }, name: '主畫面' }).ok);
  const tf = C(p, v).video.transform;
  assert.deepStrictEqual([tf.zoomX, tf.zoomY, tf.opacity, tf.posX, C(p, v).name], [1.5, 1, 1, 0, '主畫面']);
  assert.ok(core.setClipProps(p, a, { audio: { gainDb: 99, pan: -0.5, eq: { enabled: true, bands: [null, null, { gain: 6 }] }, fadeIn: 100 } }).ok);
  const au = C(p, a).audio;
  assert.deepStrictEqual([au.gainDb, au.pan, au.eq.enabled, au.eq.bands[2].gain, au.eq.bands[2].freq, au.eq.bands.length], [24, -0.5, true, 6, 500, 6]);
  assert.strictEqual(au.fadeIn, 60, '淡入不超過片段長度');
  assert.ok(core.setClipProps(p, [v], { video: { crop: { left: 0.7, right: 0.7 } } }).ok);
  assert.ok(Math.abs(C(p, v).video.crop.right - 0.29) < 1e-9);
  unchanged(p, () => core.setClipProps(p, v, { start: 5 }), /start/);
  unchanged(p, () => core.setClipProps(p, v, { audio: { gainDb: 1 } }), /聲音/);
  unchanged(p, () => core.setClipProps(p, a, { video: { fit: 'fill' } }), /畫面/);
  unchanged(p, () => core.setClipProps(p, v, { title: { text: 'x' } }), /標題/);
  unchanged(p, () => core.setClipProps(p, v, { video: { fit: 'zoom' } }), /縮放方式/);
  unchanged(p, () => core.setClipProps(p, v, { video: { transform: { zoomX: 'abc' } } }), /數值/);
  unchanged(p, () => core.setClipProps(p, v, { solidColor: '#fff' }), /色塊/);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 0, duration: 10 });
  assert.ok(core.setClipProps(p, ti.id, { title: { text: '新標題', stroke: { width: 4 } } }).ok);
  assert.deepStrictEqual([C(p, ti.id).title.text, C(p, ti.id).title.stroke.width, C(p, ti.id).title.stroke.color], ['新標題', 4, '#000000']);
  // __proto__ 不會汙染
  core.setClipProps(p, v, JSON.parse('{"video":{"__proto__":{"polluted":1}}}'));
  assert.strictEqual({}.polluted, undefined);
  lock(p, A(p));
  unchanged(p, () => core.setClipProps(p, a, { audio: { pan: 0 } }), /鎖定/);
  return p;
});

// =====================================================================================
// 復原／重做
// =====================================================================================
t('history：run／undo／redo、change 事件、失敗不記錄並還原、物件身分不變', () => {
  let p = setup();
  const set = q => { p = q; };
  const h = core.createHistory(() => p, set, { limit: 3 });
  const events = [];
  const on = e => events.push(e.detail);
  core.bus.addEventListener('change', on);
  try {
    const orig = p;
    const s0 = core.serialize(p);
    let r = h.run('放片段', q => core.editToTimeline(q, { mediaId: 'mv', srcIn: 0, srcOut: 1, frame: 0 }));
    assert.ok(r.ok);
    const s1 = core.serialize(p);
    assert.ok(h.canUndo && !h.canRedo);
    assert.strictEqual(h.undoLabel, '放片段');
    r = h.run('壞掉', q => { core.addMarker(q, { frame: 3 }); return core.moveClips(q, ['nope'], 1, 0); });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(core.serialize(p), s1, '多步操作中途失敗也整個還原');
    h.run('沒變', () => ({ ok: true }));
    assert.strictEqual(h.undoLabel, '放片段', '沒有變動不記錄');
    assert.ok(h.undo());
    assert.strictEqual(core.serialize(p), s0);
    assert.strictEqual(p, orig, '復原時就地換內容');
    assert.ok(h.canRedo);
    assert.ok(h.redo());
    assert.strictEqual(core.serialize(p), s1);
    assert.strictEqual(h.redo(), false);
    // 新操作清掉重做
    h.undo();
    h.run('標記', q => core.addMarker(q, { frame: 1 }));
    assert.strictEqual(h.canRedo, false);
    // 上限
    for (let i = 2; i < 8; i++) h.run('標記' + i, q => core.addMarker(q, { frame: i }));
    let n = 0; while (h.undo()) n++;
    assert.strictEqual(n, 3);
    // 丟錯也還原
    const s2 = core.serialize(p);
    assert.throws(() => h.run('丟錯', q => { core.addMarker(q, { frame: 50 }); throw new Error('x'); }));
    assert.strictEqual(core.serialize(p), s2);
    assert.ok(events.some(e => e.label === '放片段') && events.some(e => e.undo) && events.some(e => e.redo));
    assert.ok(!events.some(e => e.label === '壞掉'));
    h.clear();
    assert.strictEqual(h.canUndo, false);
  } finally { core.bus.removeEventListener('change', on); }
  return p;
});

t('history：begin／end 拖曳整段只記一筆、cancel 回到開始前', () => {
  const p = setup();
  put(p, 'mv', 0, 0, 1);
  const id = core.clipsOnTrack(p, V(p))[0].id;
  const h = core.createHistory(() => p, () => {});
  const s0 = core.serialize(p);
  h.begin('移動');
  for (let i = 0; i < 5; i++) h.run('移動', q => core.moveClips(q, [id], 2, 0));
  assert.strictEqual(h.canUndo, false);
  assert.ok(h.end());
  assert.strictEqual(C(p, id).start, 10);
  h.undo();
  assert.strictEqual(core.serialize(p), s0);
  h.begin('移動');
  core.moveClips(p, [id], 7, 0);
  h.cancel();
  assert.strictEqual(core.serialize(p), s0);
  assert.strictEqual(h.end(), false);
  return p;
});

t('history：begin 之後（拖曳中）不能復原／重做，end 後專案與堆疊都正確', () => {
  const p = setup();
  put(p, 'mv', 0, 0, 1);
  const id = core.clipsOnTrack(p, V(p))[0].id;
  const h = core.createHistory(() => p, () => {});
  h.run('移動 A', q => core.moveClips(q, [id], 10, 0));
  h.run('移動 B', q => core.moveClips(q, [id], 10, 0));
  h.undo();                                                // 留一筆可重做
  assert.strictEqual(C(p, id).start, 10);
  h.begin('拖曳');
  assert.strictEqual(h.busy, true);
  core.moveClips(p, [id], 5, 0);
  assert.strictEqual(h.undo(), false, '拖曳中復原要被擋');
  assert.strictEqual(h.redo(), false, '拖曳中重做要被擋');
  assert.strictEqual(C(p, id).start, 15, '被擋的復原不能動到專案');
  h.cancel(); h.begin('拖曳');                             // UI 的 live.run：cancel → begin → 重套
  core.moveClips(p, [id], 8, 0);
  assert.ok(h.end());
  assert.strictEqual(h.busy, false);
  assert.strictEqual(C(p, id).start, 18);
  assert.strictEqual(h.undoLabel, '拖曳');
  assert.strictEqual(h.canRedo, false, '新動作清掉重做');
  h.undo(); assert.strictEqual(C(p, id).start, 10);
  h.undo(); assert.strictEqual(C(p, id).start, 0);
  assert.strictEqual(h.canUndo, false);
  return p;
});

// =====================================================================================
// 模糊測試：固定種子，隨機做幾千步操作，每步檢查不變式；失敗的操作 project 必須完全沒變
// =====================================================================================
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
function fuzz(seed, steps, { strict }) {
  const R = rng(seed);
  const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const pick = xs => xs[Math.floor(R() * xs.length)];
  const p = setup({ v: 3, a: 3 });
  const h = core.createHistory(() => p, () => {});
  const snaps = [core.serialize(p)];
  const stat = { ok: 0, fail: 0 };
  const media = ['mv', 'mn', 'ma', 'mi'];
  const clipId = () => { const ids = Object.keys(p.clips); return ids.length && R() < 0.95 ? pick(ids) : 'nope'; };
  const delta = () => (R() < 0.05 ? pick([Infinity, -Infinity, 1e6, -1e6]) : ri(-60, 60));
  const frame = () => ri(-5, core.projectDuration(p) + 30);
  const linked = () => (strict ? {} : { linked: R() < 0.7 });
  const track = () => pick(p.tracks).id;
  const ops = [
    ['edit', 6, () => {
      const m = pick(media), dur = { mv: 10, mn: 3, ma: 8, mi: 5 }[m];
      const a = R() * dur * 0.8, b = a + 0.05 + R() * (dur - a);
      const mode = pick(['insert', 'overwrite', 'overwrite', 'append', 'replace']);
      const tid = {};
      if (R() < 0.3) tid.video = pick(core.tracksOf(p, 'video')).id;
      if (R() < 0.3) tid.audio = R() < 0.2 ? null : pick(core.tracksOf(p, 'audio')).id;
      return core.editToTimeline(p, { mode, mediaId: m, srcIn: a, srcOut: Math.min(b, dur), sourceTime: R() < 0.5 ? R() * dur : undefined, frame: frame(), trackIds: tid });
    }],
    ['move', 4, () => core.moveClips(p, [clipId()], delta(), R() < 0.3 ? ri(-1, 1) : 0, linked())],
    ['trim', 4, () => core.trimEdge(p, clipId(), pick(['start', 'end']), delta(), linked())],
    ['blade', 3, () => core.blade(p, frame(), R() < 0.3 ? [track()] : undefined, linked())],
    ['ripple', 4, () => core.rippleTrim(p, clipId(), pick(['start', 'end']), delta(), linked())],
    ['rippleN', 2, () => core.rippleTrim(p, [clipId(), clipId(), clipId()], pick(['start', 'end']), delta(), linked())],
    ['trimN', 2, () => core.trimEdge(p, [clipId(), clipId()], pick(['start', 'end']), delta(), linked())],
    ['rdel', 2, () => core.rippleDelete(p, [clipId()], linked())],
    ['lift', 2, () => core.lift(p, [clipId()], linked())],
    ['gap', 2, () => core.deleteGap(p, track(), frame())],
    ['roll', 3, () => {
      const c = p.clips[clipId()];
      const nx = c && core.clipsOnTrack(p, c.trackId).find(x => x.start === c.start + c.duration);
      return core.roll(p, c ? c.id : 'nope', nx ? nx.id : clipId(), delta(), linked());
    }],
    ['slip', 3, () => core.slip(p, clipId(), delta(), linked())],
    ['slide', 3, () => core.slide(p, clipId(), delta(), linked())],
    ['inout', 1, () => (R() < 0.3 ? core.clearInOut(p) : core.setInOut(p, R() < 0.5 ? null : frame(), R() < 0.5 ? null : frame()))],
    ['marker', 1, () => core.addMarker(p, { frame: frame(), color: pick(core.MARKER_COLORS) })],
    ['cmarker', 1, () => core.addClipMarker(p, clipId(), { offset: ri(-2, 40) })],
    ['flags', 1, () => core.setFlags(p, clipId(), [pick(core.MARKER_COLORS)])],
    ['trans', 2, () => core.addTransition(p, { leftClipId: clipId(), type: pick(core.TRANSITION_TYPES), duration: ri(0, 40), align: pick(['center', 'start', 'end']) })],
    ['transIn', 1.5, () => core.addTransition(p, { rightClipId: clipId(), type: pick(core.TRANSITION_TYPES), duration: ri(0, 40), align: pick(['center', 'start', 'end']) })],
    ['uptrans', 1, () => { const ids = Object.keys(p.transitions); return core.updateTransition(p, ids.length ? pick(ids) : 'nope', R() < 0.5 ? { duration: ri(0, 40) } : { align: pick(['center', 'start', 'end']), ease: pick(['linear', 'easeInOut']) }); }],
    ['rmtrans', 1, () => { const ids = Object.keys(p.transitions); return core.removeTransition(p, ids.length ? pick(ids) : 'nope'); }],
    ['props', 1, () => core.setClipProps(p, clipId(), R() < 0.5 ? { video: { transform: { zoomX: R() * 3 } } } : { audio: { fadeIn: ri(0, 50), fadeOut: ri(0, 50) } })],
    ['freeze', 1, () => { const c = p.clips[clipId()]; return core.freezeFrame(p, c ? c.id : 'nope', c ? ri(c.start - 2, c.start + c.duration) : 0, { duration: ri(1, 40) }); }],
  ];
  if (!strict) {
    ops.push(
      ['speed', 2, () => core.setSpeed(p, clipId(), { speed: pick([0.25, 0.5, 1, 1.5, 2, 4]), reverse: R() < 0.3, ripple: R() < 0.5, linked: R() < 0.8 })],
      ['freezeAll', 1, () => { const c = p.clips[clipId()]; return core.freezeFrame(p, c ? c.id : 'nope', c ? ri(c.start, c.start + c.duration - 1) : 0); }],
      ['link', 1, () => core.link(p, [clipId(), clipId()])],
      ['unlink', 1, () => core.unlink(p, [clipId()])],
      ['lock', 2, () => core.setTrackProps(p, track(), { locked: R() < 0.35 })],
      ['addTrack', 0.3, () => core.addTrack(p, pick(['video', 'audio']))],
      ['rmTrack', 0.3, () => core.removeTrack(p, track())],
    );
  }
  const total = ops.reduce((s, o) => s + o[1], 0);
  for (let i = 0; i < steps; i++) {
    // 片段太多時偏向刪除
    let op;
    if (Object.keys(p.clips).length > 70 && R() < 0.5) op = pick(ops.filter(o => o[0] === 'lift' || o[0] === 'rdel'));
    else { let x = R() * total; op = ops.find(o => (x -= o[1]) < 0) || ops[0]; }
    const before = core.serialize(p);
    const r = h.run(op[0], op[2]);
    assert.ok(r && typeof r.ok === 'boolean', `第 ${i} 步 ${op[0]} 沒有回傳結果`);
    if (r.ok) stat.ok++;
    else {
      stat.fail++;
      assert.match(r.reason, /[一-鿿]/, `第 ${i} 步 ${op[0]} 原因不是中文：${r.reason}`);
      assert.strictEqual(core.serialize(p), before, `第 ${i} 步 ${op[0]} 失敗但 project 被改到：${r.reason}`);
    }
    try { assertInvariants(p, { linkSync: strict }); } catch (e) { e.message = `第 ${i} 步 ${op[0]}（${JSON.stringify(r).slice(0, 200)}）：${e.message}`; throw e; }
    if (h.canUndo && core.serialize(p) !== snaps[snaps.length - 1]) snaps.push(core.serialize(p));
    if (i % 250 === 0) assert.strictEqual(core.serialize(core.deserialize(core.serialize(p))), core.serialize(p), '序列化來回一致');
  }
  return { p, h, stat };
}

test('模糊測試（連結選取開著、沒有鎖定）：不變式＋連結同步', () => {
  const { stat } = fuzz(20261019, 2500, { strict: true });
  assert.ok(stat.ok > 800 && stat.fail > 100, JSON.stringify(stat));
});

test('模糊測試（全部操作、鎖定、連結選取開關、變速、增刪軌）：不變式＋全有或全無', () => {
  const { p, h, stat } = fuzz(7, 3500, { strict: false });
  assert.ok(stat.ok > 1000 && stat.fail > 100, JSON.stringify(stat));
  // 全部復原再重做，結果一致（復原上限 100 步）
  const end = core.serialize(p);
  let n = 0;
  while (h.undo()) { n++; assertInvariants(p); }
  assert.strictEqual(n, 100);
  while (h.redo()) assertInvariants(p);
  assert.strictEqual(core.serialize(p), end);
});

t('轉場預設顏色：閃光白、光漏暖橘、其他黑；改類型時只換掉舊類型的預設色', () => {
  assert.equal(core.transitionColor('flash'), '#ffffff');
  assert.equal(core.transitionColor('lightLeak'), '#ff7a2e');
  assert.equal(core.transitionColor('cube'), '#000000');
  for (const t of ['whip', 'flash', 'glitch', 'zoomPunch', 'spin', 'lightLeak', 'blinds', 'pixelate', 'flip', 'cube', 'doors']) assert.ok(core.TRANSITION_TYPES.includes(t), t);
  const { p, a, b } = scene();
  let r = core.addTransition(p, { leftClipId: a[0], type: 'flash' });
  assert.ok(r.ok, r.reason);
  assert.equal(p.transitions[r.id].color, '#ffffff');
  assert.equal(p.transitions[r.id].rightClipId, b[0]);
  // 改成光漏：白色是閃光的預設 → 換成光漏的預設
  assert.ok(core.updateTransition(p, r.id, { type: 'lightLeak' }).ok);
  assert.equal(p.transitions[r.id].color, '#ff7a2e');
  // 自己挑的顏色：改類型也保留
  assert.ok(core.updateTransition(p, r.id, { color: '#00aaff' }).ok);
  assert.ok(core.updateTransition(p, r.id, { type: 'flash' }).ok);
  assert.equal(p.transitions[r.id].color, '#00aaff');
  // 明確給顏色就用給的
  r = core.addTransition(p, { leftClipId: a[0], type: 'flash', color: '#ff0000' });
  assert.equal(p.transitions[r.id].color, '#ff0000');
  // 新增其他類型：黑
  r = core.addTransition(p, { leftClipId: a[0], type: 'spin', direction: 'right' });
  assert.deepEqual([p.transitions[r.id].color, p.transitions[r.id].direction], ['#000000', 'right']);
});

t('比例轉換：aspectMismatch 找出會留黑邊的片段、setFitAll 一次改好（鎖定軌略過、可復原）', () => {
  const p = setup();
  const a = put(p, 'mv', 0, 0, 2);              // 1280×720 影片（含連結聲音）
  const b = put(p, 'mn', 60, 0, 2);             // 720×1280 直式影片
  const img = core.addClip(p, { type: 'media', mediaId: 'mi', trackId: V(p, 1), start: 0, duration: 30 });   // 800×600 圖片
  assert.ok(img.ok, img.reason);
  const ti = core.addClip(p, { type: 'title', trackId: V(p, 1), start: 40, duration: 30 });
  assert.ok(ti.ok);
  // 16:9 輸出：直式影片和 4:3 圖片不合
  core.setAspect(p, '16:9');
  let mm = core.aspectMismatch(p);
  assert.deepStrictEqual(mm.ids.sort(), [b[0], img.id].sort());
  // 9:16：橫式影片和圖片不合，直式影片剛好
  core.setAspect(p, '9:16');
  mm = core.aspectMismatch(p);
  assert.deepStrictEqual(mm.ids.sort(), [a[0], img.id].sort());
  // 已經不是 fit 的片段不算
  assert.ok(core.setClipProps(p, img.id, { video: { fit: 'fill' } }).ok);
  assert.deepStrictEqual(core.aspectMismatch(p).ids, [a[0]]);
  // setFitAll：所有影片軌上的影片／圖片，字幕不動、聲音片段不動
  const r = core.setFitAll(p, 'blur');
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.count, 3);
  for (const id of [a[0], b[0], img.id]) assert.strictEqual(C(p, id).video.fit, 'blur');
  assert.strictEqual(C(p, ti.id).video.fit, 'fit');
  assert.strictEqual(core.aspectMismatch(p).count, 0);
  // 鎖定軌略過
  lock(p, V(p, 1));
  assert.ok(core.setFitAll(p, 'fill').ok);
  assert.strictEqual(C(p, a[0]).video.fit, 'fill');
  assert.strictEqual(C(p, img.id).video.fit, 'blur');
  // 不認得的模式、bgBlur 夾在 0~100
  unchanged(p, () => core.setFitAll(p, 'zoom'), /縮放方式/);
  assert.ok(core.setClipProps(p, a[0], { video: { fit: 'blur', bgBlur: 250 } }).ok);
  assert.strictEqual(C(p, a[0]).video.bgBlur, 100);
  unchanged(p, () => core.setClipProps(p, a[0], { video: { fit: 'cover' } }), /縮放方式/);
  assert.deepStrictEqual(core.FIT_MODES, ['fit', 'blur', 'fill', 'stretch']);
  // 沒有可套用的片段
  const q = setup();
  unchanged(q, () => core.setFitAll(q, 'blur'), /沒有可以套用/);
});

t('關鍵影格：新增／改值／刪除／清除／內插方式，失敗時不改專案', () => {
  const p = setup();
  const [v] = put(p, 'mv', 0, 0, 4);                     // [0,120)
  const ZX = 'video.transform.zoomX', PX = 'video.transform.posX';
  // 範圍外、不支援的參數、音訊片段
  unchanged(p, () => core.setKeyframe(p, v, 120, { [ZX]: 2 }), /播放頭/);
  unchanged(p, () => core.setKeyframe(p, v, 0, { 'video.fit': 2 }), /不能打關鍵影格/);
  unchanged(p, () => core.setKeyframe(p, v, 0, { [ZX]: 2 }, 'bounce'), /內插/);
  const au = Object.values(p.clips).find(c => c.trackId === A(p)).id;
  unchanged(p, () => core.setKeyframe(p, au, 0, { [ZX]: 2 }), /沒有畫面/);
  // 新增兩格、數值夾範圍
  assert.ok(core.setKeyframe(p, v, 0, { [ZX]: 1, [PX]: 0 }).ok);
  assert.ok(core.setKeyframe(p, v, 60, { [ZX]: 500, [PX]: 200 }, 'ease').ok);
  assert.deepStrictEqual(C(p, v).keyframes[ZX].map(k => [k.f, k.v]), [[0, 1], [60, 100]]);
  assert.deepStrictEqual(core.keyframeFrames(C(p, v)), [0, 60]);
  // 同一格再設定＝改值；interp 省略保留原本
  assert.ok(core.setKeyframe(p, v, 60, { [ZX]: 2 }).ok);
  assert.deepStrictEqual(C(p, v).keyframes[ZX][1], { f: 60, v: 2, interp: 'ease' });
  // 內插：linear 中點 1.5；改成 ease 後中點也是 1.5、四分之一處比較慢；hold 停在前一格
  near(core.keyframeValue(C(p, v).keyframes[ZX], 30), 1.5);
  assert.ok(core.setKeyframeInterp(p, v, 0, 'ease').ok);
  near(core.keyframeValue(C(p, v).keyframes[ZX], 30), 1.5);
  assert.ok(core.keyframeValue(C(p, v).keyframes[ZX], 15) < 1.25, '緩入：一開始比較慢');
  assert.ok(core.setKeyframeInterp(p, v, 0, 'hold', [ZX]).ok);
  assert.strictEqual(core.keyframeValue(C(p, v).keyframes[ZX], 59), 1);
  assert.strictEqual(C(p, v).keyframes[PX][0].interp, 'ease', '只改指定參數');
  unchanged(p, () => core.setKeyframeInterp(p, v, 7, 'ease'), /沒有關鍵影格/);
  // 刪除：最後一個刪掉時靜態值改成它的值
  assert.ok(core.removeKeyframe(p, v, 0, [ZX, PX]).ok);
  assert.ok(core.removeKeyframe(p, v, 60, [ZX]).ok);
  assert.strictEqual(C(p, v).keyframes[ZX], undefined);
  assert.strictEqual(C(p, v).video.transform.zoomX, 2);
  unchanged(p, () => core.removeKeyframe(p, v, 60, [ZX]), /沒有關鍵影格/);
  // 清除：靜態值＝指定格的值
  assert.ok(core.setKeyframe(p, v, 0, { [PX]: 0 }, 'linear').ok);
  assert.ok(core.setKeyframe(p, v, 60, { [PX]: 100 }).ok);
  assert.ok(core.clearKeyframes(p, v, null, 30).ok);
  assert.deepStrictEqual(C(p, v).keyframes, {});
  near(C(p, v).video.transform.posX, 50);
  unchanged(p, () => core.clearKeyframes(p, v), /沒有關鍵影格/);
  // 鎖定軌
  lock(p, V(p));
  unchanged(p, () => core.setKeyframe(p, v, 0, { [ZX]: 2 }), /鎖定/);
  // 復原
  const q = setup(); const [w] = put(q, 'mv', 0, 0, 4);
  const h = core.createHistory(() => q, () => {});
  h.run('關鍵影格', x => core.setKeyframe(x, w, 10, { [ZX]: 3 }));
  assert.strictEqual(C(q, w).keyframes[ZX].length, 1);
  h.undo();
  assert.strictEqual(C(q, w).keyframes[ZX], undefined);
  assertInvariants(q);
});

t('關鍵影格：修剪開頭、切開、變速後動畫跟著畫面走', () => {
  const ZX = 'video.transform.zoomX';
  const p = setup();
  const [v] = put(p, 'mv', 0, 0, 4);                     // [0,120)
  assert.ok(core.setKeyframe(p, v, 0, { [ZX]: 1 }).ok);
  assert.ok(core.setKeyframe(p, v, 60, { [ZX]: 2 }).ok);
  assert.ok(core.setKeyframe(p, v, 119, { [ZX]: 3 }).ok);
  const at = (id, frame) => core.keyframeValue(C(p, id).keyframes[ZX], frame - C(p, id).start);
  const before = [10, 45, 60, 90, 110].map(f => at(v, f));
  // 切開在 50：兩半在時間軸上看到的值完全不變
  assert.ok(core.blade(p, 50, [V(p)]).ok);
  const right = Object.values(p.clips).find(c => c.trackId === V(p) && c.start === 50).id;
  assert.deepStrictEqual([at(v, 10), at(v, 45), at(right, 60), at(right, 90), at(right, 110)], before);
  assert.ok(C(p, right).keyframes[ZX].some(k => k.f < 0), '保留片段前的一格讓開頭內插不變');
  assert.ok(C(p, v).keyframes[ZX].every(k => k.f <= 60), '左半只留範圍內＋後面最近一格');
  // 修剪右半的開頭（往右縮 20 格）：畫面位置不變
  assert.ok(core.trimEdge(p, right, 'start', 20).ok);
  assert.deepStrictEqual([at(right, 90), at(right, 110)], [before[3], before[4]]);
  // 變速（ripple）：長度減半，關鍵影格依比例縮
  const q = setup();
  const [w] = put(q, 'mv', 0, 0, 4);
  assert.ok(core.setKeyframe(q, w, 100, { [ZX]: 2 }).ok);
  assert.ok(core.setSpeed(q, w, { speed: 2, ripple: true }).ok);
  assert.strictEqual(C(q, w).duration, 60);
  assert.strictEqual(C(q, w).keyframes[ZX][0].f, 50);
  assertInvariants(p); assertInvariants(q);
});

t('關鍵影格：一鍵動畫（放大、縮小、平移）', () => {
  const p = setup();
  const [v] = put(p, 'mv', 0, 0, 4);
  const K = x => C(p, v).keyframes['video.transform.' + x];
  assert.ok(core.applyKeyframePreset(p, v, 'zoomIn').ok);
  assert.deepStrictEqual(K('zoomX').map(k => [k.f, k.v, k.interp]), [[0, 1, 'ease'], [119, 1.15, 'ease']]);
  assert.deepStrictEqual(K('zoomY').map(k => k.v), [1, 1.15]);
  assert.ok(core.applyKeyframePreset(p, v, 'panLeft', { amount: 0.2 }).ok);
  assert.ok(K('posX')[0].v > 0 && K('posX')[1].v < 0, '向左平移');
  assert.ok(K('zoomX')[0].v > 1, '平移時放大避免露出黑邊');
  assert.ok(core.applyKeyframePreset(p, v, 'zoomOut').ok);
  assert.strictEqual(K('posX'), undefined, '換動畫會清掉舊的平移');
  unchanged(p, () => core.applyKeyframePreset(p, v, 'spin'), /動畫種類/);
  assertInvariants(p);
});

t('關鍵影格：setClipPropsAt 有動畫的參數改成打關鍵影格，其他照常改', () => {
  const p = setup();
  const [v] = put(p, 'mv', 30, 0, 4);                    // [30,150)
  const ZX = 'video.transform.zoomX';
  // 沒有關鍵影格：等同 setClipProps
  assert.ok(core.setClipPropsAt(p, v, { video: { transform: { zoomX: 2 } } }, 40).ok);
  assert.strictEqual(C(p, v).video.transform.zoomX, 2);
  assert.ok(core.setKeyframe(p, v, 0, { [ZX]: 1 }).ok);
  // 播放頭在第 70 格（片段內 40）：新增關鍵影格；posX 沒動畫，改靜態值
  assert.ok(core.setClipPropsAt(p, v, { video: { transform: { zoomX: 3, posX: 12 } } }, 70).ok);
  assert.deepStrictEqual(C(p, v).keyframes[ZX].map(k => [k.f, k.v]), [[0, 1], [40, 3]]);
  assert.strictEqual(C(p, v).video.transform.posX, 12);
  assert.strictEqual(C(p, v).video.transform.zoomX, 2, '有動畫的參數不改靜態值');
  // 同一格再改＝改值
  assert.ok(core.setClipPropsAt(p, v, { video: { transform: { zoomX: 4 } } }, 70).ok);
  assert.deepStrictEqual(C(p, v).keyframes[ZX].map(k => k.v), [1, 4]);
  // 播放頭不在片段上：失敗、不改
  unchanged(p, () => core.setClipPropsAt(p, v, { video: { transform: { zoomX: 5 } } }, 10), /播放頭/);
  unchanged(p, () => core.setClipPropsAt(p, v, { video: { fit: 'zoom' } }, 70), /縮放方式/);
  assertInvariants(p);
});

t('節拍標記：一次加一批（取代舊的、略過已有標記的格）、清除', () => {
  const p = setup();
  assert.ok(core.addMarker(p, { frame: 30, color: 'red' }).ok);
  const r = core.addBeatMarkers(p, [15, 30, 45.4, 60, 60, -3]);
  assert.ok(r.ok); assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(core.beatFrames(p), [15, 45, 60]);
  assert.strictEqual(p.markers.find(m => m.frame === 30).color, 'red', '原本的標記不動');
  assert.ok(core.addBeatMarkers(p, [10, 20]).ok);
  assert.deepStrictEqual(core.beatFrames(p), [10, 20], '預設取代舊的節拍標記');
  assert.ok(core.addBeatMarkers(p, [40], { replace: false }).ok);
  assert.deepStrictEqual(core.beatFrames(p), [10, 20, 40]);
  unchanged(p, () => core.addBeatMarkers(p, []), /節拍/);
  assert.strictEqual(core.clearBeatMarkers(p).count, 3);
  assert.strictEqual(p.markers.length, 1);
  unchanged(p, () => core.clearBeatMarkers(p), /沒有節拍標記/);
  // 鎖定軌也能加（標記不屬於軌道）
  lock(p, V(p));
  assert.ok(core.addBeatMarkers(p, [5]).ok);
});

t('卡點：片段依節拍排好（連結聲音跟著、素材不夠長留空、後面的片段跟著推）', () => {
  const p = setup();
  const img = []; let f = 0;
  for (let i = 0; i < 3; i++) { const [id] = put(p, 'mi', f, 0, 2, { video: V(p) }); img.push(id); f += 60; }   // 三張圖片各 60 格
  const [vid, au] = put(p, 'mv', f, 0, 1);              // 影片 30 格（來源 10 秒，夠長）
  const [tail] = put(p, 'mn', f + 30, 0, 1, { video: V(p) });  // 後面沒選到的片段
  assert.ok(core.addBeatMarkers(p, [20, 35, 50, 65, 80]).ok);
  const r = core.fitClipsToBeats(p, [...img, vid]);
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual([...img, vid].map(id => span(C(p, id))), [[0, 20], [20, 35], [35, 50], [50, 65]]);
  assert.deepStrictEqual(span(C(p, au)), [50, 65], '連結的聲音跟著');
  assert.strictEqual(C(p, tail).start, 65, '後面的片段往前收');
  assertInvariants(p, { linkSync: true });
  // 每 2 拍
  const q = setup();
  const a = put(q, 'mi', 0, 0, 1, { video: V(q) })[0], b = put(q, 'mi', 30, 0, 1, { video: V(q) })[0];
  assert.ok(core.fitClipsToBeats(q, [a, b], { beats: [10, 20, 30, 40, 50], every: 2 }).ok);
  assert.deepStrictEqual([span(C(q, a)), span(C(q, b))], [[0, 10], [10, 30]]);
  // 素材不夠長：空景只有 3 秒（90 格）
  const s = setup();
  const n = put(s, 'mn', 0, 0, 1, { video: V(s) })[0];
  const r2 = core.fitClipsToBeats(s, [n], { beats: [200] });
  assert.ok(r2.ok); assert.strictEqual(r2.short, 1);
  assert.strictEqual(C(s, n).duration, 90);
  // 沒有節拍、中間夾著沒選到的片段
  const e = setup();
  const x1 = put(e, 'mi', 0, 0, 1, { video: V(e) })[0], x2 = put(e, 'mi', 30, 0, 1, { video: V(e) })[0], x3 = put(e, 'mi', 60, 0, 1, { video: V(e) })[0];
  unchanged(e, () => core.fitClipsToBeats(e, [x1, x3]), /還沒有節拍標記/);
  unchanged(e, () => core.fitClipsToBeats(e, [x1, x3], { beats: [10, 20] }), /夾在選取的片段中間/);
  assert.ok(x2);
});

t('卡點：開頭離第一拍太近時，第一段延到下一個拍子（不會一閃而過）', () => {
  const p = setup();
  const ids = [0, 1, 2].map(i => put(p, 'mi', i * 30, 0, 1, { video: V(p) })[0]);
  assert.ok(core.fitClipsToBeats(p, ids, { beats: [4, 19, 34, 49, 64, 79], every: 2 }).ok);
  assert.deepStrictEqual(ids.map(id => span(C(p, id))), [[0, 19], [19, 49], [49, 79]]);
});
