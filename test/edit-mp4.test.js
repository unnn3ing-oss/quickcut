// 剪輯匯出的 MP4 封裝（edit-export.js 的 mp4）：box 結構、各表格內容、co64 切換條件。
// 有 ffmpeg／ffprobe 時另外用 ffmpeg 產生 H.264＋AAC、VP9＋Opus、AV1 的參考檔，拆出樣本後用我們的 muxer 重新封裝，
// 再用 ffprobe／ffmpeg 解碼比對（沙盒的瀏覽器沒有 H.264／AAC 編碼器，這是驗證 avc1／mp4a 分支唯一的方法）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { mp4, webm } = require('../edit-export.js');

// ---- 簡單的 box 解析器（同時檢查每一層的大小剛好填滿上一層）------------------------------
const CONTAINERS = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'dinf', 'stbl', 'udta']);
const VISUAL = new Set(['avc1', 'avc3', 'vp09', 'av01', 'hvc1', 'hev1']);
const AUDIO = new Set(['mp4a', 'Opus']);
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u64 = (b, p) => u32(b, p) * 4294967296 + u32(b, p + 4);
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const i32 = (b, p) => u32(b, p) | 0;
const str4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

function parseBoxes(b, start, end, depth = 0) {
  const out = [];
  let p = start;
  while (p < end) {
    assert.ok(end - p >= 8, `box 標頭不完整 @${p}`);
    let size = u32(b, p);
    const type = str4(b, p + 4);
    let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    assert.ok(size >= hdr && p + size <= end, `${type} 大小 ${size} 超出上一層（${p}+${size} > ${end}）`);
    const box = { type, start: p, size, hdr, body: p + hdr, end: p + size };
    if (type === 'mdat') { /* 不展開 */ }
    else if (CONTAINERS.has(type)) box.children = parseBoxes(b, box.body, box.end, depth + 1);
    else if (type === 'stsd' || type === 'dref') box.children = parseBoxes(b, box.body + 8, box.end, depth + 1);
    else if (VISUAL.has(type)) box.children = parseBoxes(b, box.body + 78, box.end, depth + 1);
    else if (AUDIO.has(type)) box.children = parseBoxes(b, box.body + 28, box.end, depth + 1);
    out.push(box);
    p += size;
  }
  assert.equal(p, end, '子 box 沒有剛好填滿上一層');
  return out;
}
const parseFile = b => parseBoxes(b, 0, b.length);
// path 例：'moov/trak:1/mdia/minf/stbl/stts'（:n 表示同名的第 n 個，從 0 起算）
function find(boxes, pth) {
  let cur = { children: boxes };
  for (const seg of pth.split('/')) {
    const [type, idx] = seg.split(':');
    const list = (cur.children || []).filter(x => x.type === type);
    cur = list[+(idx || 0)];
    if (!cur) return null;
  }
  return cur;
}
const childTypes = box => box.children.map(c => c.type);

// ---- 表格讀取 ---------------------------------------------------------------------------
function readTable(b, box) {
  const p = box.body + 4;    // 跳過 version/flags
  const n = u32(b, p);
  const rows = [];
  switch (box.type) {
    case 'stts': case 'ctts': for (let i = 0; i < n; i++) rows.push([u32(b, p + 4 + i * 8), u32(b, p + 8 + i * 8)]); return rows;
    case 'stss': case 'stco': for (let i = 0; i < n; i++) rows.push(u32(b, p + 4 + i * 4)); return rows;
    case 'co64': for (let i = 0; i < n; i++) rows.push(u64(b, p + 4 + i * 8)); return rows;
    case 'stsc': for (let i = 0; i < n; i++) rows.push([u32(b, p + 4 + i * 12), u32(b, p + 8 + i * 12), u32(b, p + 12 + i * 12)]); return rows;
    default: throw new Error(box.type);
  }
}
function readStsz(b, box) {
  const ss = u32(b, box.body + 4), n = u32(b, box.body + 8);
  return ss ? new Array(n).fill(ss) : Array.from({ length: n }, (_, i) => u32(b, box.body + 12 + i * 4));
}
function readElst(b, box) {
  const ver = b[box.body], n = u32(b, box.body + 4), out = [];
  let p = box.body + 8;
  for (let i = 0; i < n; i++) {
    if (ver) { const d = u64(b, p), t = u32(b, p + 8) === 0xffffffff ? -1 : u64(b, p + 8); out.push([d, t]); p += 20; }
    else { out.push([u32(b, p), i32(b, p + 4)]); p += 12; }
  }
  return out;
}
function readMdhd(b, box) {
  const v = b[box.body];
  return v ? { timescale: u32(b, box.body + 20), duration: u64(b, box.body + 24) } : { timescale: u32(b, box.body + 12), duration: u32(b, box.body + 16) };
}
// 樣本位置：由 stsc＋stco/co64＋stsz 展開成每個樣本的 [offset, size]
function sampleLocations(b, stbl) {
  const sizes = readStsz(b, find(stbl.children, 'stsz'));
  const co = find(stbl.children, 'stco') || find(stbl.children, 'co64');
  const offs = readTable(b, co), stsc = readTable(b, find(stbl.children, 'stsc'));
  const out = [];
  let s = 0;
  for (let c = 0; c < offs.length; c++) {
    let per = 0;
    for (const [first, n] of stsc) if (first - 1 <= c) per = n;
    let off = offs[c];
    for (let k = 0; k < per; k++, s++) { out.push([off, sizes[s]]); off += sizes[s]; }
  }
  assert.equal(out.length, sizes.length, 'stsc 展開的樣本數和 stsz 不符');
  return out;
}

// 把一個 mp4 拆成軌道與樣本（給 ffmpeg 參考檔用）
function demux(b) {
  const top = parseFile(b);
  const moov = find(top, 'moov');
  const tracks = [];
  for (const trak of moov.children.filter(x => x.type === 'trak')) {
    const hdlr = find(trak.children, 'mdia/hdlr');
    const kind = str4(b, hdlr.body + 8) === 'vide' ? 'video' : 'audio';
    const stbl = find(trak.children, 'mdia/minf/stbl');
    const { timescale } = readMdhd(b, find(trak.children, 'mdia/mdhd'));
    const entry = find(stbl.children, 'stsd').children[0];
    const stts = readTable(b, find(stbl.children, 'stts'));
    const cttsBox = find(stbl.children, 'ctts');
    const ctts = cttsBox ? readTable(b, cttsBox) : null;
    const stssBox = find(stbl.children, 'stss');
    const keys = stssBox ? new Set(readTable(b, stssBox)) : null;
    const elstBox = find(trak.children, 'edts/elst');
    const elst = elstBox ? readElst(b, elstBox) : null;
    const durs = stts.flatMap(([n, d]) => new Array(n).fill(d));
    const offs = ctts ? ctts.flatMap(([n, d]) => new Array(n).fill(d | 0)) : null;
    const locs = sampleLocations(b, stbl);
    let dts = 0;
    const samples = locs.map(([off, size], i) => {
      const s = { data: b.slice(off, off + size), ts: dts + (offs ? offs[i] : 0), dur: durs[i], key: keys ? keys.has(i + 1) : true };
      dts += durs[i];
      return s;
    });
    const cfg = entry.children[0];
    tracks.push({ kind, fourcc: entry.type, timescale, samples, elst, cfg: b.slice(cfg.body, cfg.end), cfgType: cfg.type, entry,
      width: kind === 'video' ? u16(b, entry.body + 24) : 0, height: kind === 'video' ? u16(b, entry.body + 26) : 0,
      channels: kind === 'audio' ? u16(b, entry.body + 16) : 0, sampleRate: kind === 'audio' ? u32(b, entry.body + 24) >>> 16 : 0 });
  }
  return tracks;
}
// esds → AudioSpecificConfig（找 tag 5 的描述子）
function ascFromEsds(e) {
  let p = 4;
  const len = () => { let n = 0, x; do { x = e[p++]; n = (n << 7) | (x & 0x7f); } while (x & 0x80); return n; };
  for (;;) {
    const tag = e[p++], n = len();
    if (tag === 3) { p += 3; continue; }
    if (tag === 4) { p += 13; continue; }
    if (tag === 5) return e.slice(p, p + n);
    p += n;
    if (p >= e.length) return null;
  }
}

// ---- 假資料 ------------------------------------------------------------------------------
const fill = (n, v) => new Uint8Array(n).fill(v);
const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xce]);
const OPUS_HEAD = new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 56, 1, 128, 187, 0, 0, 0, 0, 0]);
function fakeVideo(n, { codec = 'avc1.640028', fps = 30, gop = 5 } = {}) {
  return { codec, width: 1080, height: 1920, timescale: fps * 1000, description: codec.startsWith('avc1') ? AVCC : undefined,
    samples: Array.from({ length: n }, (_, i) => ({ data: fill(100 + i, i), ts: i * 1000, dur: 1000, key: i % gop === 0 })) };
}
function fakeOpus(n, len) {
  return { codec: 'opus', sampleRate: 48000, channels: 2, timescale: 48000, description: OPUS_HEAD, presentDuration: len,
    samples: Array.from({ length: n }, (_, i) => ({ data: fill(20 + (i % 3), 200 + i), ts: i * 960, dur: 960, key: true })) };
}

// ---- 結構 --------------------------------------------------------------------------------
test('faststart：ftyp → moov → mdat，各層大小正確，影像在 track 1、聲音在 track 2', () => {
  const out = mp4.mux({ video: fakeVideo(10), audio: fakeOpus(16, 14000), time: 0 });
  const top = parseFile(out);
  assert.deepEqual(top.map(x => x.type), ['ftyp', 'moov', 'mdat']);
  const moov = find(top, 'moov');
  assert.deepEqual(childTypes(moov), ['mvhd', 'trak', 'trak']);
  assert.deepEqual(childTypes(find(moov.children, 'trak:0')), ['tkhd', 'mdia']);          // 影像不需要 edit list
  assert.deepEqual(childTypes(find(moov.children, 'trak:1')), ['tkhd', 'edts', 'mdia']);  // Opus 有 pre-skip
  assert.deepEqual(childTypes(find(moov.children, 'trak:0/mdia')), ['mdhd', 'hdlr', 'minf']);
  assert.deepEqual(childTypes(find(moov.children, 'trak:0/mdia/minf')), ['vmhd', 'dinf', 'stbl']);
  assert.deepEqual(childTypes(find(moov.children, 'trak:1/mdia/minf')), ['smhd', 'dinf', 'stbl']);
  assert.deepEqual(childTypes(find(moov.children, 'trak:0/mdia/minf/stbl')), ['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco']);
  assert.deepEqual(childTypes(find(moov.children, 'trak:1/mdia/minf/stbl')), ['stsd', 'stts', 'stsc', 'stsz', 'stco']);
  const avc1 = find(moov.children, 'trak:0/mdia/minf/stbl/stsd/avc1');
  assert.ok(avc1);
  assert.equal(u16(out, avc1.body + 24), 1080);
  assert.equal(u16(out, avc1.body + 26), 1920);
  const avcC = find(avc1.children, 'avcC');
  assert.deepEqual(Array.from(out.slice(avcC.body, avcC.end)), Array.from(AVCC));
  // tkhd：track id、寬高（16.16）
  const tkhd = find(moov.children, 'trak:0/tkhd');
  assert.equal(u32(out, tkhd.body + 12), 1);
  assert.equal(u32(out, tkhd.body + 76), 1080 * 65536);
  assert.equal(u32(out, tkhd.body + 80), 1920 * 65536);
  assert.equal(u32(out, find(moov.children, 'trak:1/tkhd').body + 12), 2);
  // mvhd：timescale 1000、長度取較長的那條（影像 10 格 @30 = 333ms；聲音 14000/48000 = 292ms）
  const mvhd = find(moov.children, 'mvhd');
  assert.equal(u32(out, mvhd.body + 12), 1000);
  assert.equal(u32(out, mvhd.body + 16), 333);
  assert.equal(u32(out, mvhd.body + 96), 3);   // next_track_ID
  const hd = n => str4(out, find(moov.children, `trak:${n}/mdia/hdlr`).body + 8);
  assert.equal(hd(0), 'vide'); assert.equal(hd(1), 'soun');
  // mdat 大小 = 8 + 所有樣本
  const mdat = find(top, 'mdat');
  const payload = Array.from({ length: 10 }, (_, i) => 100 + i).reduce((a, b) => a + b) + Array.from({ length: 16 }, (_, i) => 20 + (i % 3)).reduce((a, b) => a + b);
  assert.equal(mdat.size, payload + 8);
});

test('stts／stsz／stss／stsc／stco 內容正確，stco 指到的位元組就是樣本資料', () => {
  const v = fakeVideo(40, { gop: 15 });
  const out = mp4.mux({ video: v, time: 0 });
  const stbl = find(parseFile(out), 'moov/trak/mdia/minf/stbl');
  assert.deepEqual(readTable(out, find(stbl.children, 'stts')), [[40, 1000]]);
  assert.deepEqual(readStsz(out, find(stbl.children, 'stsz')), v.samples.map(s => s.data.length));
  assert.deepEqual(readTable(out, find(stbl.children, 'stss')), [1, 16, 31]);
  // 每 0.5 秒（15 格）一個 chunk：15、15、10
  assert.deepEqual(readTable(out, find(stbl.children, 'stsc')), [[1, 15, 1], [3, 10, 1]]);
  assert.equal(readTable(out, find(stbl.children, 'stco')).length, 3);
  const locs = sampleLocations(out, stbl);
  locs.forEach(([off, size], i) => assert.deepEqual(out.slice(off, off + size), v.samples[i].data, `樣本 ${i}`));
  const mdhd = readMdhd(out, find(parseFile(out), 'moov/trak/mdia/mdhd'));
  assert.deepEqual(mdhd, { timescale: 30000, duration: 40000 });
});

test('全部是關鍵格時不寫 stss；樣本大小都一樣時 stsz 用單一 sample_size', () => {
  const v = fakeVideo(6, { gop: 1 });
  v.samples.forEach(s => { s.data = fill(50, 1); });
  const out = mp4.mux({ video: v, time: 0 });
  const stbl = find(parseFile(out), 'moov/trak/mdia/minf/stbl');
  assert.equal(find(stbl.children, 'stss'), null);
  const stsz = find(stbl.children, 'stsz');
  assert.equal(u32(out, stsz.body + 4), 50);
  assert.equal(stsz.size, 20);
});

test('影音交錯：chunk 依時間排，影像、聲音的 stco 互相穿插', () => {
  const out = mp4.mux({ video: fakeVideo(60), audio: fakeOpus(100, 96000), time: 0 });
  const moov = find(parseFile(out), 'moov');
  const vo = readTable(out, find(moov.children, 'trak:0/mdia/minf/stbl/stco'));
  const ao = readTable(out, find(moov.children, 'trak:1/mdia/minf/stbl/stco'));
  assert.equal(vo.length, 4); assert.equal(ao.length, 4);
  for (let i = 0; i < 4; i++) assert.ok(vo[i] < ao[i] && (i === 3 || ao[i] < vo[i + 1]), `第 ${i} 組交錯順序`);
});

test('Opus：dOps 欄位（大端序）與 edit list 跳過 pre-skip', () => {
  const out = mp4.mux({ audio: fakeOpus(51, 48000), time: 0 });
  const trak = find(parseFile(out), 'moov/trak');
  const dOps = find(trak.children, 'mdia/minf/stbl/stsd/Opus/dOps');
  const d = out.slice(dOps.body, dOps.end);
  assert.deepEqual(Array.from(d), [0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0]);
  const opus = find(trak.children, 'mdia/minf/stbl/stsd/Opus');
  assert.equal(u16(out, opus.body + 16), 2);                  // channelcount
  assert.equal(u32(out, opus.body + 24) >>> 16, 48000);       // samplerate 16.16
  // elst：media_time = 312、長度 = 48000 樣本 = 1000ms
  assert.deepEqual(readElst(out, find(trak.children, 'edts/elst')), [[1000, 312]]);
  assert.deepEqual(readMdhd(out, find(trak.children, 'mdia/mdhd')), { timescale: 48000, duration: 51 * 960 });
});

test('AAC：esds 內含 AudioSpecificConfig，priming 用 edit list 跳過', () => {
  const asc = mp4.buildAsc(48000, 2);
  assert.deepEqual(Array.from(asc), [0x11, 0x90]);
  const out = mp4.mux({ audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: asc, skip: 1024, presentDuration: 48000,
    samples: Array.from({ length: 48 }, (_, i) => ({ data: fill(300, i), ts: i * 1024, dur: 1024 })) }, time: 0 });
  const trak = find(parseFile(out), 'moov/trak');
  const esds = find(trak.children, 'mdia/minf/stbl/stsd/mp4a/esds');
  const e = out.slice(esds.body, esds.end);
  assert.deepEqual(Array.from(ascFromEsds(e)), [0x11, 0x90]);
  assert.equal(e[4], 3);                                       // ES_Descriptor
  assert.equal(e[4 + 5 + 3], 4);                               // DecoderConfigDescriptor
  assert.equal(e[4 + 5 + 3 + 5], 0x40);                        // objectTypeIndication = MPEG-4 Audio
  assert.equal(e[4 + 5 + 3 + 5 + 1], 0x15);                    // streamType = audio
  assert.deepEqual(readElst(out, find(trak.children, 'edts/elst')), [[1000, 1024]]);
});

test('B 格（顯示順序 ≠ 解碼順序）：產生 ctts，edit list 讓第一格從 0 開始', () => {
  // 解碼順序 I P B B P B B，顯示時間（格）0 3 1 2 6 4 5
  const order = [0, 3, 1, 2, 6, 4, 5];
  const v = { codec: 'avc1.640028', width: 64, height: 64, timescale: 30000, description: AVCC,
    samples: order.map((f, i) => ({ data: fill(10, i), ts: f * 1000, dur: 1000, key: i === 0 })) };
  const out = mp4.mux({ video: v, time: 0 });
  const trak = find(parseFile(out), 'moov/trak');
  const stbl = find(trak.children, 'mdia/minf/stbl');
  assert.deepEqual(readTable(out, find(stbl.children, 'stts')), [[7, 1000]]);
  const ctts = readTable(out, find(stbl.children, 'ctts')).flatMap(([n, d]) => new Array(n).fill(d));
  // dts = 0..6 格；pts = dts + ctts，減掉 edit 的 media_time 之後要等於原本的顯示時間
  const [[, mediaTime]] = readElst(out, find(trak.children, 'edts/elst'));
  order.forEach((f, i) => assert.equal(i * 1000 + ctts[i] - mediaTime, f * 1000, `樣本 ${i}`));
  assert.ok(ctts.every(x => x >= 0));
});

test('co64：一般大小用 stco；mdat 超過 4GB 自動改 co64，mdat 用 64 位元大小', () => {
  const big = n => ({ codec: 'vp09.00.40.08', width: 1920, height: 1080, timescale: 30000,
    samples: Array.from({ length: n }, (_, i) => ({ size: 4 << 20, ts: i * 1000, dur: 1000, key: i % 60 === 0 })) });
  const small = mp4.muxHeader({ video: big(900), time: 0 });      // 900 × 4MB ≈ 3.77GB
  assert.equal(small.co64, false);
  assert.equal(small.largeMdat, false);
  const sb = find(parseFile(small.header.slice(0, small.header.length - 8)), 'moov/trak/mdia/minf/stbl');
  assert.ok(find(sb.children, 'stco'));

  const h = mp4.muxHeader({ video: big(1100), time: 0 });          // ≈ 4.6GB
  assert.equal(h.co64, true);
  assert.equal(h.largeMdat, true);
  const head = h.header;
  // 檔頭最後 16 bytes 是 mdat 的 64 位元標頭
  const m = head.length - 16;
  assert.equal(u32(head, m), 1);
  assert.equal(str4(head, m + 4), 'mdat');
  assert.equal(u64(head, m + 8), 1100 * (4 << 20) + 16);
  assert.equal(h.size, head.length + 1100 * (4 << 20));
  const top = parseBoxes(head, 0, m);
  const stbl = find(top, 'moov/trak/mdia/minf/stbl');
  assert.equal(find(stbl.children, 'stco'), null);
  const offs = readTable(head, find(stbl.children, 'co64'));
  assert.equal(offs[0], head.length);
  assert.ok(offs[offs.length - 1] > 0xffffffff);
  // chunk 位置 = 前面所有樣本大小的累加
  const per = readTable(head, find(stbl.children, 'stsc'));
  assert.equal(per[0][1], 1);                                      // 每個樣本 4MB = 達到 chunk 上限，一個 chunk 一個樣本
  offs.forEach((o, i) => assert.equal(o, head.length + i * (4 << 20)));
});

test('co64 的臨界：只看最後一個 chunk 的起點是否超過 32 位元', () => {
  const mk = sizes => ({ codec: 'vp09.00.40.08', width: 16, height: 16, timescale: 30000,
    samples: sizes.map((s, i) => ({ size: s, ts: i * 1000, dur: 1000, key: i === 0 })) });
  const MB4 = 4 << 20;
  // 1023 個 4MB 加一個很大的尾巴：最後一個 chunk 起點 < 4GB → stco 就夠
  const a = mp4.muxHeader({ video: mk([...new Array(1023).fill(MB4), MB4 - 100000]), time: 0 });
  assert.equal(a.co64, false);
  const b = mp4.muxHeader({ video: mk([...new Array(1024).fill(MB4), 10]), time: 0 });
  assert.equal(b.co64, true);
  const c = mp4.muxHeader({ video: mk([10, 10]), time: 0, forceCo64: true });
  assert.equal(c.co64, true);
});

test('vpcC：由 codec 字串與 colorSpace 組成', () => {
  assert.deepEqual(Array.from(mp4.buildVpcC('vp09.00.40.08')), [0, 40, (8 << 4) | (1 << 1), 1, 1, 1, 0, 0]);
  assert.deepEqual(Array.from(mp4.buildVpcC('vp09.02.51.10.01.09.16.09.01')), [2, 51, (10 << 4) | (1 << 1) | 1, 9, 16, 9, 0, 0]);
  assert.deepEqual(Array.from(mp4.buildVpcC('vp09.00.40.08', { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false })),
    [0, 40, 0x82, 6, 6, 6, 0, 0]);
  const out = mp4.mux({ video: { ...fakeVideo(3, { codec: 'vp09.00.40.08' }), colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } }, time: 0 });
  const entry = find(parseFile(out), 'moov/trak/mdia/minf/stbl/stsd/vp09');
  assert.deepEqual(childTypes(entry), ['vpcC', 'colr', 'pasp']);
  const vpcC = find(entry.children, 'vpcC');
  assert.equal(out[vpcC.body], 1);                                // FullBox version 1
});

test('av1C：codec 字串＋從第一個關鍵格取出 sequence header；樣本去掉 temporal delimiter', () => {
  // TD(0x12 0x00) + 序列標頭 OBU(type 1, 3 bytes) + frame OBU(type 6, 2 bytes)
  const key = new Uint8Array([0x12, 0x00, 0x0a, 0x03, 0xaa, 0xbb, 0xcc, 0x32, 0x02, 0x11, 0x22]);
  const delta = new Uint8Array([0x12, 0x00, 0x32, 0x01, 0x33]);
  assert.deepEqual(Array.from(mp4.stripTemporalDelimiters(key)), [0x0a, 0x03, 0xaa, 0xbb, 0xcc, 0x32, 0x02, 0x11, 0x22]);
  const c = mp4.buildAv1C('av01.0.08M.08', key);
  assert.deepEqual(Array.from(c), [0x81, 0x08, 0x0c, 0x00, 0x0a, 0x03, 0xaa, 0xbb, 0xcc]);
  assert.deepEqual(Array.from(mp4.buildAv1C('av01.0.13H.10')).slice(0, 4), [0x81, 13, 0x80 | 0x40 | 0x0c, 0]);
  const out = mp4.mux({ video: { codec: 'av01.0.08M.08', width: 64, height: 64, timescale: 30000,
    samples: [{ data: key, ts: 0, dur: 1000, key: true }, { data: delta, ts: 1000, dur: 1000, key: false }] }, time: 0 });
  const stbl = find(parseFile(out), 'moov/trak/mdia/minf/stbl');
  assert.deepEqual(readStsz(out, find(stbl.children, 'stsz')), [9, 3]);
  assert.ok(find(stbl.children, 'stsd/av01/av1C'));
});

test('OpusHead 解析；沒給時用 312', () => {
  assert.deepEqual(mp4.parseOpusHead(OPUS_HEAD), { channels: 2, preSkip: 312, inputRate: 48000, gain: 0, family: 0 });
  assert.equal(mp4.parseOpusHead(null, 2, 48000).preSkip, 312);
});

test('錯誤：H.264 沒有 avcC、沒有樣本、不支援的格式', () => {
  assert.throws(() => mp4.mux({ video: { ...fakeVideo(2), description: null } }), /avcC/);
  assert.throws(() => mp4.mux({}), /沒有任何/);
  assert.throws(() => mp4.mux({ video: { ...fakeVideo(2), codec: 'hvc1.1.6.L93.B0' } }), /不支援/);
});

// ---- 和 ffmpeg 交叉驗證 --------------------------------------------------------------------
const hasFF = ['ffmpeg', 'ffprobe'].every(c => spawnSync(c, ['-version']).status === 0);
const ffSkip = hasFF ? false : '沒有 ffmpeg／ffprobe';
let tmp;
test.before(() => { if (hasFF) tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-mp4-')); });
test.after(() => { if (tmp && !process.env.ED_MP4_KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else if (tmp) console.log('# 保留測試檔：' + tmp); });

const ff = args => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', file]).toString());
const decodeErrors = file => spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim();
const md5 = (file, sel) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', `0:${sel}:0`, '-fps_mode', 'passthrough', '-f', 'md5', '-']).toString().trim();
const hasEncoder = name => execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes(` ${name} `);

// 從參考檔拆出樣本，交給我們的 muxer 重新封裝（mux 可換成 webm.mux）
function remux(ref, o = {}) { return (o.mux || mp4.mux)(remuxOpts(ref, o)); }
function remuxOpts(ref, { forceCo64 = false, av1NoDesc = false, brand } = {}) {
  const tracks = demux(ref);
  const opts = { time: 0, forceCo64, brand };
  for (const t of tracks) {
    const skip = t.elst ? t.elst[t.elst.length - 1][1] : 0;
    const present = t.elst ? Math.round(t.elst[t.elst.length - 1][0] * t.timescale / u32(ref, find(parseFile(ref), 'moov/mvhd').body + 12)) : undefined;
    if (t.kind === 'video') {
      let codec, description;
      if (t.fourcc === 'avc1') { codec = 'avc1.' + Array.from(t.cfg.slice(1, 4), x => x.toString(16).padStart(2, '0')).join(''); description = t.cfg; }
      else if (t.fourcc === 'vp09') { const c = t.cfg.slice(4); codec = `vp09.${String(c[0]).padStart(2, '0')}.${c[1]}.${String(c[2] >> 4).padStart(2, '0')}`; }
      else if (t.fourcc === 'av01') { codec = `av01.${t.cfg[1] >> 5}.${String(t.cfg[1] & 31).padStart(2, '0')}${t.cfg[2] & 0x80 ? 'H' : 'M'}.08`; description = av1NoDesc ? undefined : t.cfg; }
      // 參考檔的 B 格用 edit list 讓第一格從 0 開始顯示；我們的 muxer 吃的是「顯示時間」，所以先扣掉，ctts／edit list 由 muxer 自己算
      const samples = t.samples.map(s => ({ ...s, ts: s.ts - skip }));
      opts.video = { codec, width: t.width, height: t.height, timescale: t.timescale, description, samples };
    } else {
      let codec, description;
      if (t.fourcc === 'mp4a') { codec = 'mp4a.40.2'; description = ascFromEsds(t.cfg.slice(0)); }
      else {
        codec = 'opus';
        const d = t.cfg;    // dOps（大端序）→ OpusHead（小端序）
        description = new Uint8Array(19);
        description.set([79, 112, 117, 115, 72, 101, 97, 100, 1, d[1], d[3], d[2], d[7], d[6], d[5], d[4], d[9], d[8], d[10]]);
      }
      opts.audio = { codec, sampleRate: t.sampleRate, channels: t.channels, timescale: t.timescale, description, skip, presentDuration: present, samples: t.samples };
    }
  }
  return opts;
}

function crossCheck(t, name, encArgs, extra = {}) {
  const ext = extra.ext || 'mp4';
  const ref = path.join(tmp, `${name}-ref.mp4`), out = path.join(tmp, `${name}-ours.${ext}`);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-ac', '2', ...encArgs, '-shortest', ref]);
  const refBuf = new Uint8Array(fs.readFileSync(ref));
  const ours = remux(refBuf, extra);
  fs.writeFileSync(out, ours);
  if (extra.check) extra.check(ours); else parseFile(ours);   // 結構檢查
  const a = probe(ref), b = probe(out);
  const vs = b.streams.find(s => s.codec_type === 'video'), as = b.streams.find(s => s.codec_type === 'audio');
  const rvs = a.streams.find(s => s.codec_type === 'video'), ras = a.streams.find(s => s.codec_type === 'audio');
  t.diagnostic(`${name}: ${vs.codec_name} ${vs.width}x${vs.height} frames=${vs.nb_read_frames} dur=${vs.duration} | ${as.codec_name} ${as.sample_rate}Hz dur=${as.duration} | format dur=${b.format.duration}`);
  assert.equal(vs.nb_read_frames, '90');
  assert.equal(vs.nb_read_frames, rvs.nb_read_frames);
  assert.equal(vs.codec_name, rvs.codec_name);
  assert.equal(as.codec_name, ras.codec_name);
  // WebM（Matroska）的 ffprobe 不回報各串流的長度，只看整個檔案；畫面與聲音的內容由下面的 md5 比對
  if (vs.duration !== undefined) assert.ok(Math.abs(+vs.duration - 3) < 0.01, `影像長度 ${vs.duration}`);
  if (as.duration !== undefined) assert.ok(Math.abs(+as.duration - +ras.duration) < 0.03, `聲音長度 ${as.duration} vs ${ras.duration}`);
  assert.ok(Math.abs(+b.format.duration - 3) < 0.05, `檔案長度 ${b.format.duration}`);
  assert.equal(decodeErrors(out), '', 'ffmpeg 解碼有錯誤');
  // 解出來的畫面與聲音要和參考檔完全一樣
  assert.equal(md5(out, 'v'), md5(ref, 'v'), '畫面 md5 不同');
  assert.equal(md5(out, 'a'), md5(ref, 'a'), '聲音 md5 不同');
  return { ours, out };
}

test('ffmpeg 交叉驗證：H.264（含 B 格）＋AAC 重新封裝後解碼結果相同', { skip: ffSkip }, t => {
  crossCheck(t, 'h264-aac', ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k']);
});

test('ffmpeg 交叉驗證：H.264 無 B 格＋AAC，強制 co64', { skip: ffSkip }, t => {
  const { ours } = crossCheck(t, 'h264-co64', ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], { forceCo64: true });
  const stbl = find(parseFile(ours), 'moov/trak/mdia/minf/stbl');
  assert.ok(find(stbl.children, 'co64'));
  assert.equal(find(stbl.children, 'ctts'), null);
});

test('ffmpeg 交叉驗證：VP9＋Opus', { skip: ffSkip }, t => {
  crossCheck(t, 'vp9-opus', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-b:a', '96k']);
});

test('ffmpeg 交叉驗證：AV1＋Opus（av1C 由我們從 codec 字串和序列標頭組）', { skip: ffSkip || (!hasEncoder('libaom-av1') && !hasEncoder('libsvtav1') && '沒有 AV1 編碼器') }, t => {
  const enc = hasEncoder('libsvtav1') ? ['-c:v', 'libsvtav1', '-preset', '12'] : ['-c:v', 'libaom-av1', '-cpu-used', '8', '-row-mt', '1'];
  crossCheck(t, 'av1-opus', [...enc, '-g', '60', '-b:v', '500k', '-c:a', 'libopus'], { av1NoDesc: true });
});

// =====================================================================================
// MOV（QuickTime）：同一個 muxer，ftyp 換成 qt
// =====================================================================================
test('MOV：ftyp 是 QuickTime 的 qt brand，其餘 box 和 MP4 一樣', () => {
  const b = mp4.mux({ video: fakeVideo(10), audio: fakeOpus(16, 14000), time: 0, brand: 'qt' });
  const top = parseFile(b);
  assert.deepEqual(top.map(x => x.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(str4(b, top[0].body), 'qt  ');
  assert.equal(str4(b, top[0].body + 8), 'qt  ');
});

test('ffmpeg 交叉驗證：MOV（H.264＋AAC）', { skip: ffSkip }, t => {
  const { out } = crossCheck(t, 'h264-aac-mov', ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], { brand: 'qt', ext: 'mov' });
  assert.match(probe(out).format.format_name, /mov/);
});

// =====================================================================================
// WebM：EBML 結構與 ffmpeg 交叉驗證
// =====================================================================================
const W = webm.ID;
const MASTER = new Set([W.EBML, W.Segment, W.SeekHead, W.Seek, W.Info, W.Tracks, W.TrackEntry, W.Video, W.Audio, W.Cluster, W.BlockGroup, W.Cues, W.CuePoint, W.CueTrackPositions]);
function readVint(b, p, keepMarker) {
  const first = b[p];
  let n = 1;
  while (n <= 8 && !(first & (0x80 >> (n - 1)))) n++;
  assert.ok(n <= 8, `vint 錯誤 @${p}`);
  let v = keepMarker ? first : first & (0xff >> n);
  for (let k = 1; k < n; k++) v = v * 256 + b[p + k];
  return { v, n };
}
// 解析 EBML，同時檢查每個 master 元素的子元素剛好填滿它
function parseEbml(b, start = 0, end = b.length) {
  const out = [];
  for (let p = start; p < end;) {
    const id = readVint(b, p, true), size = readVint(b, p + id.n);
    const body = p + id.n + size.n, stop = body + size.v;
    assert.ok(stop <= end, `元素 0x${id.v.toString(16)} 超出範圍`);
    const n = { id: id.v, start: p, body, end: stop };
    if (MASTER.has(id.v)) n.kids = parseEbml(b, body, stop);
    out.push(n);
    p = stop;
  }
  return out;
}
const kid = (n, id) => n.kids.find(k => k.id === id);
const uintAt = (b, n) => { let v = 0; for (let p = n.body; p < n.end; p++) v = v * 256 + b[p]; return v; };

test('WebM：EBML 結構、Segment 子元素、Cues 指到每個關鍵格的 Cluster', () => {
  const samples = Array.from({ length: 90 }, (_, k) => ({ data: new Uint8Array([k, 1, 2]), ts: k * 1000, dur: 1000, key: k % 30 === 0 }));
  const audio = Array.from({ length: 150 }, (_, k) => ({ data: new Uint8Array([9, k & 255]), ts: k * 960, dur: 960, key: true }));
  const b = webm.mux({ video: { codec: 'vp09.00.10.08', width: 320, height: 240, timescale: 30000, samples },
    audio: { codec: 'opus', sampleRate: 48000, channels: 2, skip: 312, presentDuration: 143500, samples: audio } });
  const top = parseEbml(b);
  assert.deepEqual(top.map(n => n.id), [W.EBML, W.Segment]);
  const seg = top[1], ids = seg.kids.map(n => n.id);
  assert.deepEqual([ids[0], ids[1], ids[2], ids[ids.length - 1]], [W.SeekHead, W.Info, W.Tracks, W.Cues]);
  const clusters = seg.kids.filter(n => n.id === W.Cluster);
  assert.equal(clusters.length, 3, '每 30 格一個關鍵格 → 3 個 Cluster');
  // SeekHead 的位置（相對 Segment 資料起點）指到對的元素
  for (const s of seg.kids[0].kids) {
    const target = uintAt(b, kid(s, W.SeekPosition)) + seg.body, idn = kid(s, W.SeekID);
    assert.deepEqual(Array.from(b.subarray(target, target + idn.end - idn.body)), Array.from(b.subarray(idn.body, idn.end)));
  }
  const cues = seg.kids[seg.kids.length - 1].kids;
  assert.deepEqual(cues.map(c => uintAt(b, kid(c, W.CueTime))), [0, 1000, 2000]);
  cues.forEach((c, k) => assert.equal(uintAt(b, kid(kid(c, W.CueTrackPositions), W.CueClusterPosition)) + seg.body, clusters[k].start));
  // Opus 的 CodecDelay＝pre-skip；最後一個聲音封包是 BlockGroup＋DiscardPadding
  const tr = kid(seg, W.Tracks).kids;
  assert.equal(uintAt(b, kid(tr[1], W.CodecDelay)), Math.round(312 / 48000 * 1e9));
  const lastCluster = clusters[clusters.length - 1];
  const bg = lastCluster.kids.filter(n => n.id === W.BlockGroup);
  assert.equal(bg.length, 1, '只有最後一個封包要截尾');
  // 每個 Cluster 的第一個影像區塊是關鍵格
  for (const c of clusters) {
    const first = c.kids.find(n => n.id === W.SimpleBlock && b[n.body] === 0x81);
    assert.equal(b[first.body + 3] & 0x80, 0x80);
  }
});

test('WebM：不接受 H.264／AAC', () => {
  assert.throws(() => webm.mux({ video: { codec: 'avc1.640028', width: 2, height: 2, timescale: 1000, samples: [{ data: new Uint8Array(1), ts: 0, dur: 1, key: true }] } }), /WebM 不能放/);
});

test('ffmpeg 交叉驗證：WebM（VP9＋Opus）', { skip: ffSkip }, t => {
  const { out } = crossCheck(t, 'vp9-opus-webm', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-b:a', '96k'],
    { mux: webm.mux, ext: 'webm', check: b => parseEbml(b) });
  assert.match(probe(out).format.format_name, /webm/);
});

test('ffmpeg 交叉驗證：WebM（AV1＋Opus）', { skip: ffSkip || (!hasEncoder('libaom-av1') && !hasEncoder('libsvtav1') && '沒有 AV1 編碼器') }, t => {
  const enc = hasEncoder('libsvtav1') ? ['-c:v', 'libsvtav1', '-preset', '12'] : ['-c:v', 'libaom-av1', '-cpu-used', '8', '-row-mt', '1'];
  crossCheck(t, 'av1-opus-webm', [...enc, '-g', '60', '-b:v', '500k', '-c:a', 'libopus'], { mux: webm.mux, ext: 'webm', check: b => parseEbml(b), av1NoDesc: true });
});
