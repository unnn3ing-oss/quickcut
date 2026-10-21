// =====================================================================================
// 剪輯：匯出 MP4
//
// 流程：逐格 render.seekSource → render.compose（畫到 OffscreenCanvas）→ VideoFrame → VideoEncoder；
//       聲音用 render.renderAudio 一次混好 → 切成 AudioData → AudioEncoder；最後用下面自己寫的 mp4 封裝成檔案下載。
// 不用外部函式庫：編碼交給瀏覽器的 WebCodecs，封裝（ISO-BMFF）自己寫，純函式、node 也能測（test/edit-mp4.test.js）。
//
// 編碼格式依序試：H.264（High→Main→Baseline）→ VP9 → AV1；聲音 AAC → Opus。一般 Chrome 會走 H.264＋AAC，
// 沒有 H.264／AAC 編碼器的瀏覽器（例如 Linux 版 Chromium）才會退到 VP9／Opus（MP4 裡一樣能放，Chrome、VLC、ffmpeg 都能播）。
//
// 時間：影片 timescale = fps×1000（一格剛好 1000），聲音 timescale = 取樣率；音訊編碼器開頭的「暖機」樣本
// （Opus 的 pre-skip、AAC 的 priming）用 edit list 跳過，所以聲音和畫面從同一個時間點開始。
// =====================================================================================
(function (root) {
  const Q = root.QPTEdit = root.QPTEdit || {};

  // ===================================================================================
  // 一、MP4 封裝（純函式）
  //   mp4.mux({ video, audio }) → Uint8Array
  //   video = { codec: 'avc1.640028'|'vp09.00.40.08'|'av01.0.08M.08', width, height, timescale,
  //             description /* avcC（H.264 必填）或 av1C */, colorSpace /* VideoColorSpaceInit，可省略 */,
  //             samples: [{ data, ts, dur, key }] }        // 依解碼順序；ts＝顯示時間、dur＝長度（timescale 單位）
  //   audio = { codec: 'mp4a.40.2'|'opus', sampleRate, channels, timescale /* 預設 = sampleRate */,
  //             description /* AAC：AudioSpecificConfig；Opus：OpusHead */, skip /* 開頭要跳過的樣本數 */,
  //             presentDuration /* 實際要播的長度（截掉尾端補的靜音）*/, samples: [...] }
  //   mp4.muxParts(...) 回傳 [檔頭, 樣本資料…]，直接丟給 new Blob() 不用再複製一次（大檔省記憶體）。
  //   mp4.muxHeader(...) 只算檔頭；樣本可以只給 { size } 不給 data（測試 4GB 以上的 co64 用）。
  // ===================================================================================
  const mp4 = (function () {
    const U32 = 4294967296;
    const MOVIE_TS = 1000;              // mvhd 的 timescale（毫秒）
    const CHUNK_SEC = 0.5;              // 每個 chunk 最多放多少秒的樣本（影音交錯，播放器邊下載邊播比較順）
    const CHUNK_BYTES = 4 << 20;

    const toU8 = a => (a instanceof Uint8Array ? a
      : ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      : new Uint8Array(a));

    // ---- 可自動長大的位元組寫入器；box() 先寫 0 當大小，寫完內容再回填 -------------------
    function writer(cap) {
      let b = new Uint8Array(cap || 4096), dv = new DataView(b.buffer), p = 0;
      const need = n => {
        if (p + n <= b.length) return;
        let c = b.length * 2;
        while (c < p + n) c *= 2;
        const nb = new Uint8Array(c); nb.set(b.subarray(0, p));
        b = nb; dv = new DataView(b.buffer);
      };
      const w = {
        get pos() { return p; },
        u8(v) { need(1); b[p++] = v & 255; return w; },
        u16(v) { need(2); dv.setUint16(p, v & 0xffff); p += 2; return w; },
        i16(v) { need(2); dv.setInt16(p, v); p += 2; return w; },
        u24(v) { need(3); b[p++] = (v >>> 16) & 255; b[p++] = (v >>> 8) & 255; b[p++] = v & 255; return w; },
        u32(v) { need(4); dv.setUint32(p, v >>> 0); p += 4; return w; },
        i32(v) { need(4); dv.setInt32(p, v); p += 4; return w; },
        u64(v) { need(8); dv.setUint32(p, Math.floor(v / U32)); dv.setUint32(p + 4, v >>> 0); p += 8; return w; },
        str(s) { for (let i = 0; i < s.length; i++) w.u8(s.charCodeAt(i)); return w; },
        bytes(a) { a = toU8(a); need(a.length); b.set(a, p); p += a.length; return w; },
        zeros(n) { need(n); b.fill(0, p, p + n); p += n; return w; },
        box(type, fn) { const s = p; w.u32(0).str(type); if (fn) fn(w); dv.setUint32(s, p - s); return w; },
        full(type, ver, flags, fn) { return w.box(type, () => { w.u8(ver).u24(flags); if (fn) fn(w); }); },
        done() { return b.slice(0, p); },
      };
      return w;
    }
    const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

    // ---- 編碼格式字串解析 ---------------------------------------------------------------
    const fourcc = codec => {
      const c = String(codec || '').toLowerCase();
      if (/^(avc1|avc3)\./.test(c)) return 'avc1';
      if (c.startsWith('vp09') || c === 'vp9') return 'vp09';
      if (c.startsWith('av01')) return 'av01';
      if (c.startsWith('mp4a') || c === 'aac') return 'mp4a';
      if (c === 'opus') return 'Opus';
      throw new Error(`不支援的編碼格式：${codec}`);
    };

    // VideoColorSpace 名稱 → ISO/IEC 23091-2 代碼
    const CP = { bt709: 1, bt470bg: 5, smpte170m: 6, smpte240m: 7, film: 8, bt2020: 9, smpte432: 12 };
    const TC = { bt709: 1, smpte170m: 6, smpte240m: 7, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 };
    const MC = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, smpte240m: 7, 'bt2020-ncl': 9 };
    function colorCodes(cs, dflt) {
      const d = dflt || { cp: 1, tc: 1, mc: 1, full: 0 };
      if (!cs) return d;
      return {
        cp: CP[cs.primaries] ?? d.cp, tc: TC[cs.transfer] ?? d.tc, mc: MC[cs.matrix] ?? d.mc,
        full: cs.fullRange == null ? d.full : (cs.fullRange ? 1 : 0),
      };
    }

    // vp09.PP.LL.DD[.CC.cp.tc.mc.FF]
    function parseVp9(codec) {
      const f = String(codec).split('.').slice(1).map(x => parseInt(x, 10));
      const v = (i, d) => (Number.isFinite(f[i]) ? f[i] : d);
      return { profile: v(0, 0), level: v(1, 40), bitDepth: v(2, 8), chroma: v(3, 1), cp: v(4, 1), tc: v(5, 1), mc: v(6, 1), full: v(7, 0) };
    }
    // av01.P.LLT.DD[.M.CCC.cp.tc.mc.F]
    function parseAv1(codec) {
      const f = String(codec).split('.').slice(1);
      const lv = f[1] || '08M';
      const ccc = f[4] || '110';
      const depth = parseInt(f[2] || '8', 10);
      return {
        profile: parseInt(f[0] || '0', 10), level: parseInt(lv, 10), tier: /H$/i.test(lv) ? 1 : 0,
        highBitdepth: depth > 8 ? 1 : 0, twelveBit: depth === 12 ? 1 : 0, mono: parseInt(f[3] || '0', 10) ? 1 : 0,
        ssx: +ccc[0] || 0, ssy: +ccc[1] || 0, csp: +ccc[2] || 0,
      };
    }

    // ---- AV1：OBU 處理 -------------------------------------------------------------------
    function leb128(b, p) {
      let v = 0, i = 0;
      for (; i < 8; i++) { const x = b[p + i]; v += (x & 0x7f) * 2 ** (7 * i); if (!(x & 0x80)) return { v, n: i + 1 }; }
      return null;
    }
    // 切成 OBU；任何一個沒有 size 欄位就回傳 null（不是 low-overhead 格式，不去動它）
    function splitObus(b) {
      const out = [];
      for (let p = 0; p < b.length;) {
        const h = b[p], type = (h >> 3) & 15, ext = (h >> 2) & 1, hasSize = (h >> 1) & 1;
        if (!hasSize) return null;
        const L = leb128(b, p + 1 + ext);
        if (!L) return null;
        const end = p + 1 + ext + L.n + L.v;
        if (end > b.length) return null;
        out.push({ type, start: p, end });
        p = end;
      }
      return out;
    }
    // ISO-BMFF 的 AV1 樣本不該帶 temporal delimiter（OBU type 2），WebCodecs 輸出會帶，拿掉
    function stripTemporalDelimiters(b) {
      const obus = splitObus(b);
      if (!obus || !obus.some(o => o.type === 2)) return b;
      const keep = obus.filter(o => o.type !== 2);
      const out = new Uint8Array(keep.reduce((s, o) => s + o.end - o.start, 0));
      let p = 0;
      for (const o of keep) { out.set(b.subarray(o.start, o.end), p); p += o.end - o.start; }
      return out;
    }
    const sequenceHeaderObu = b => { const o = (splitObus(b) || []).find(x => x.type === 1); return o ? b.slice(o.start, o.end) : new Uint8Array(0); };

    // ---- 各種設定 box ----------------------------------------------------------------------
    function buildAv1C(codec, firstKey) {
      const a = parseAv1(codec);
      const w = writer(64);
      w.u8(0x81).u8((a.profile << 5) | (a.level & 31))
        .u8((a.tier << 7) | (a.highBitdepth << 6) | (a.twelveBit << 5) | (a.mono << 4) | (a.ssx << 3) | (a.ssy << 2) | (a.csp & 3))
        .u8(0).bytes(firstKey ? sequenceHeaderObu(firstKey) : new Uint8Array(0));
      return w.done();
    }
    function buildVpcC(codec, colorSpace) {
      const v = parseVp9(codec);
      const c = colorCodes(colorSpace, { cp: v.cp, tc: v.tc, mc: v.mc, full: v.full });
      const w = writer(32);
      w.u8(v.profile).u8(v.level).u8((v.bitDepth << 4) | ((v.chroma & 7) << 1) | (c.full & 1)).u8(c.cp).u8(c.tc).u8(c.mc).u16(0);
      return w.done();
    }
    const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    function buildAsc(sampleRate, channels) {      // AAC-LC 的 AudioSpecificConfig（編碼器沒給 description 時用）
      const fi = AAC_RATES.indexOf(sampleRate);
      if (fi < 0) throw new Error(`AAC 不支援取樣率 ${sampleRate}`);
      return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | ((channels & 15) << 3)]);
    }
    // OpusHead（小端序，WebCodecs 給的 description）→ 欄位
    function parseOpusHead(d, channels, sampleRate) {
      const b = d ? toU8(d) : null;
      if (b && b.length >= 19 && String.fromCharCode(...b.subarray(0, 8)) === 'OpusHead') {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const r = { channels: b[9], preSkip: dv.getUint16(10, true), inputRate: dv.getUint32(12, true), gain: dv.getInt16(16, true), family: b[18] };
        if (r.family && b.length >= 21 + r.channels) { r.streams = b[19]; r.coupled = b[20]; r.mapping = b.slice(21, 21 + r.channels); }
        return r;
      }
      return { channels, preSkip: 312, inputRate: sampleRate || 48000, gain: 0, family: 0 };
    }
    // esds 的描述子：長度一律寫成 4 個位元組（0x80 0x80 0x80 n），和 ffmpeg 一樣，播放器相容性最好
    function descriptor(tag, body) {
      const w = writer(body.length + 8);
      const n = body.length;
      w.u8(tag).u8(0x80 | ((n >> 21) & 0x7f)).u8(0x80 | ((n >> 14) & 0x7f)).u8(0x80 | ((n >> 7) & 0x7f)).u8(n & 0x7f).bytes(body);
      return w.done();
    }
    function buildEsds(trackId, asc, avgBitrate, maxBitrate, bufferSize) {
      const dsi = descriptor(5, asc);
      const dcd = writer(64);
      dcd.u8(0x40).u8((0x05 << 2) | 1).u24(Math.min(bufferSize, 0xffffff)).u32(maxBitrate).u32(avgBitrate).bytes(dsi);
      const es = writer(64);
      es.u16(trackId).u8(0).bytes(descriptor(4, dcd.done())).bytes(descriptor(6, new Uint8Array([2])));
      return descriptor(3, es.done());
    }

    // ---- 整理一條軌：時間、chunk、編碼設定 --------------------------------------------------
    function prepTrack(t, kind, id) {
      if (!t || !t.samples || !t.samples.length) return null;
      const fc = fourcc(t.codec);
      const ts = Math.round(t.timescale || (kind === 'audio' ? t.sampleRate : 0));
      if (!(ts > 0)) throw new Error('timescale 必須是正整數');
      let samples = t.samples.map(s => ({ data: s.data != null ? toU8(s.data) : null, size: s.data != null ? 0 : s.size, ts: Math.round(s.ts), dur: s.dur, key: kind === 'audio' ? true : !!s.key }));
      if (fc === 'av01') for (const s of samples) if (s.data) s.data = stripTemporalDelimiters(s.data);
      for (const s of samples) if (s.data) s.size = s.data.byteLength;
      const n = samples.length;

      // 解碼時間（dts）：顯示時間排序後依序配給每個樣本；有 B 格（顯示順序 ≠ 解碼順序）時用 ctts 補差
      const pts = samples.map(s => s.ts);
      const sorted = pts.slice().sort((a, b) => a - b);
      let shift = 0;
      for (let i = 0; i < n; i++) shift = Math.max(shift, sorted[i] - pts[i]);
      const base = sorted[0];
      const dts = sorted.map(v => v - base);
      const durs = new Array(n);
      for (let i = 0; i < n - 1; i++) durs[i] = dts[i + 1] - dts[i];
      const lastDur = Math.round(samples[n - 1].dur);
      durs[n - 1] = lastDur > 0 ? lastDur : (n > 1 ? durs[n - 2] : 1);
      const ctts = shift > 0 ? pts.map((v, i) => v - base + shift - dts[i]) : null;
      const mediaDuration = dts[n - 1] + durs[n - 1];

      // 設定
      const tr = { id, kind, fc, ts, samples, durs, ctts, mediaDuration, codec: t.codec };
      let skip = Math.max(0, Math.round(t.skip || 0));
      if (kind === 'video') {
        tr.width = t.width; tr.height = t.height;
        if (fc === 'avc1') {
          if (!t.description) throw new Error('H.264 缺少 avcC（encoder 的 decoderConfig.description）');
          tr.config = ['avcC', toU8(t.description)];
        } else if (fc === 'vp09') {
          tr.config = ['vpcC', buildVpcC(t.codec, t.colorSpace), 1];
        } else if (fc === 'av01') {
          const d = t.description && toU8(t.description);
          const firstKey = samples.find(s => s.key && s.data);
          tr.config = ['av1C', d && d.length >= 4 && d[0] === 0x81 ? d : buildAv1C(t.codec, firstKey && firstKey.data)];
        } else throw new Error(`影像軌不能用 ${t.codec}`);
        if (t.colorSpace) tr.colr = colorCodes(t.colorSpace);
      } else {
        tr.channels = t.channels || 2; tr.sampleRate = t.sampleRate || ts;
        if (fc === 'Opus') {
          const h = parseOpusHead(t.description, tr.channels, tr.sampleRate);
          tr.opus = h; tr.channels = h.channels || tr.channels;
          if (t.skip == null) skip = h.preSkip;       // Opus 的 pre-skip 同時寫在 dOps 和 edit list（規範要求）
        } else if (fc === 'mp4a') {
          tr.asc = t.description ? toU8(t.description) : buildAsc(tr.sampleRate, tr.channels);
        } else throw new Error(`聲音軌不能用 ${t.codec}`);
      }
      tr.mediaTime = shift + skip;
      const avail = Math.max(0, mediaDuration - skip);
      tr.presentDuration = t.presentDuration != null ? Math.max(0, Math.min(Math.round(t.presentDuration), avail)) : avail;
      tr.emptyBefore = base > 0 ? base : 0;          // 第一個樣本不是從 0 開始：前面補一段空的 edit
      tr.needEdit = tr.mediaTime > 0 || tr.emptyBefore > 0 || tr.presentDuration !== mediaDuration;

      // chunk：連續、同一軌、最多 CHUNK_SEC 秒或 CHUNK_BYTES
      const chunks = [];
      let cur = null;
      for (let i = 0; i < n; i++) {
        if (!cur || dts[i] - cur.d0 >= CHUNK_SEC * ts || cur.bytes + samples[i].size > CHUNK_BYTES) {
          cur = { tr, first: i, count: 0, d0: dts[i], t0: (dts[i] + tr.emptyBefore) / ts, bytes: 0, offset: 0 };
          chunks.push(cur);
        }
        cur.count++; cur.bytes += samples[i].size;
      }
      tr.chunks = chunks;
      const total = samples.reduce((s, x) => s + x.size, 0);
      const secs = mediaDuration / ts || 1;
      tr.avgBitrate = Math.round(total * 8 / secs);
      tr.maxSize = samples.reduce((m, x) => Math.max(m, x.size), 0);
      return tr;
    }

    // ---- stbl 表格（都做 run-length 壓縮）-------------------------------------------------
    function rle(arr) {
      const out = [];
      for (const v of arr) { const l = out[out.length - 1]; if (l && l[1] === v) l[0]++; else out.push([1, v]); }
      return out;
    }

    function writeSampleEntry(w, tr) {
      if (tr.kind === 'video') {
        w.box(tr.fc, () => {
          w.zeros(6).u16(1).u16(0).u16(0).zeros(12).u16(tr.width).u16(tr.height)
            .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).i16(-1);
          const [type, data, fullVer] = tr.config;
          if (fullVer != null) w.full(type, fullVer, 0, () => w.bytes(data)); else w.box(type, () => w.bytes(data));
          if (tr.colr) w.box('colr', () => w.str('nclx').u16(tr.colr.cp).u16(tr.colr.tc).u16(tr.colr.mc).u8(tr.colr.full ? 0x80 : 0));
          w.box('pasp', () => w.u32(1).u32(1));
        });
      } else {
        const rate = tr.fc === 'Opus' ? 48000 : tr.sampleRate;
        w.box(tr.fc, () => {
          w.zeros(6).u16(1).zeros(8).u16(tr.channels).u16(16).u16(0).u16(0).u32(Math.min(rate, 65535) * 65536);
          if (tr.fc === 'Opus') {
            const h = tr.opus;
            w.box('dOps', () => {
              w.u8(0).u8(tr.channels).u16(h.preSkip).u32(h.inputRate).i16(h.gain).u8(h.family);
              if (h.family) w.u8(h.streams).u8(h.coupled).bytes(h.mapping);
            });
          } else {
            w.full('esds', 0, 0, () => w.bytes(buildEsds(tr.id, tr.asc, tr.avgBitrate, tr.avgBitrate, tr.maxSize)));
          }
        });
      }
    }

    function writeTrak(w, tr, o) {
      const v1 = x => x > 0xffffffff;
      const movieDur = toMovie(tr.emptyBefore, tr.ts) + toMovie(tr.presentDuration, tr.ts);
      w.box('trak', () => {
        const tv = v1(movieDur) ? 1 : 0;
        w.full('tkhd', tv, 3, () => {
          if (tv) w.u64(o.time).u64(o.time).u32(tr.id).u32(0).u64(movieDur);
          else w.u32(o.time).u32(o.time).u32(tr.id).u32(0).u32(movieDur);
          w.zeros(8).i16(0).i16(tr.kind === 'audio' ? 1 : 0).u16(tr.kind === 'audio' ? 0x0100 : 0).u16(0);
          for (const m of MATRIX) w.u32(m);
          w.u32(tr.kind === 'video' ? tr.width * 65536 : 0).u32(tr.kind === 'video' ? tr.height * 65536 : 0);
        });
        if (tr.needEdit) {
          w.box('edts', () => {
            const entries = [];
            if (tr.emptyBefore) entries.push([toMovie(tr.emptyBefore, tr.ts), -1]);
            entries.push([toMovie(tr.presentDuration, tr.ts), tr.mediaTime]);
            const ev = entries.some(e => v1(e[0]) || v1(e[1])) ? 1 : 0;
            w.full('elst', ev, 0, () => {
              w.u32(entries.length);
              for (const [d, t] of entries) {
                if (ev) { w.u64(d); if (t < 0) w.u32(0xffffffff).u32(0xffffffff); else w.u64(t); } else w.u32(d).i32(t);
                w.u16(1).u16(0);
              }
            });
          });
        }
        w.box('mdia', () => {
          const mv = v1(tr.mediaDuration) ? 1 : 0;
          w.full('mdhd', mv, 0, () => {
            if (mv) w.u64(o.time).u64(o.time).u32(tr.ts).u64(tr.mediaDuration);
            else w.u32(o.time).u32(o.time).u32(tr.ts).u32(tr.mediaDuration);
            w.u16(0x55c4).u16(0);                       // 語言 'und'
          });
          w.full('hdlr', 0, 0, () => {
            w.u32(0).str(tr.kind === 'video' ? 'vide' : 'soun').zeros(12).str(tr.kind === 'video' ? 'VideoHandler' : 'SoundHandler').u8(0);
          });
          w.box('minf', () => {
            if (tr.kind === 'video') w.full('vmhd', 0, 1, () => w.zeros(8));
            else w.full('smhd', 0, 0, () => w.zeros(4));
            w.box('dinf', () => w.full('dref', 0, 0, () => { w.u32(1); w.full('url ', 0, 1); }));
            w.box('stbl', () => writeStbl(w, tr, o));
          });
        });
      });
    }

    function writeStbl(w, tr, o) {
      const n = tr.samples.length;
      w.full('stsd', 0, 0, () => { w.u32(1); writeSampleEntry(w, tr); });
      const stts = rle(tr.durs);
      w.full('stts', 0, 0, () => { w.u32(stts.length); for (const [c, d] of stts) w.u32(c).u32(d); });
      if (tr.ctts) {
        const ct = rle(tr.ctts);
        w.full('ctts', 0, 0, () => { w.u32(ct.length); for (const [c, d] of ct) w.u32(c).u32(d); });
      }
      if (tr.kind === 'video' && tr.samples.some(s => !s.key)) {
        const keys = [];
        tr.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
        w.full('stss', 0, 0, () => { w.u32(keys.length); for (const k of keys) w.u32(k); });
      }
      const stsc = [];
      tr.chunks.forEach((c, i) => { const l = stsc[stsc.length - 1]; if (!l || l[1] !== c.count) stsc.push([i + 1, c.count]); });
      w.full('stsc', 0, 0, () => { w.u32(stsc.length); for (const [f, c] of stsc) w.u32(f).u32(c).u32(1); });
      const s0 = tr.samples[0].size, same = tr.samples.every(s => s.size === s0);
      w.full('stsz', 0, 0, () => { w.u32(same ? s0 : 0).u32(n); if (!same) for (const s of tr.samples) w.u32(s.size); });
      if (o.co64) w.full('co64', 0, 0, () => { w.u32(tr.chunks.length); for (const c of tr.chunks) w.u64(c.offset); });
      else w.full('stco', 0, 0, () => { w.u32(tr.chunks.length); for (const c of tr.chunks) w.u32(c.offset); });
    }

    const toMovie = (v, ts) => Math.round(v * MOVIE_TS / ts);

    function writeMoov(tracks, o) {
      const w = writer(65536);
      const dur = Math.max(...tracks.map(t => toMovie(t.emptyBefore, t.ts) + toMovie(t.presentDuration, t.ts)));
      w.box('moov', () => {
        const v = dur > 0xffffffff ? 1 : 0;
        w.full('mvhd', v, 0, () => {
          if (v) w.u64(o.time).u64(o.time).u32(MOVIE_TS).u64(dur); else w.u32(o.time).u32(o.time).u32(MOVIE_TS).u32(dur);
          w.u32(0x00010000).u16(0x0100).zeros(10);
          for (const m of MATRIX) w.u32(m);
          w.zeros(24).u32(tracks.length + 1);
        });
        for (const t of tracks) writeTrak(w, t, o);
      });
      return w.done();
    }

    function writeFtyp(tracks) {
      const brands = ['isom', 'iso2', 'mp41'];
      if (tracks.some(t => t.fc === 'avc1')) brands.push('avc1');
      if (tracks.some(t => t.fc === 'av01')) brands.push('av01');
      if (tracks.some(t => t.fc === 'Opus')) brands.push('Opus');
      const w = writer(64);
      w.box('ftyp', () => { w.str('isom').u32(512); for (const b of brands) w.str(b); });
      return w.done();
    }

    // 檔頭（ftyp＋moov＋mdat 標頭）與樣本在 mdat 裡的順序
    function muxHeader(opts) {
      opts = opts || {};
      const tracks = [prepTrack(opts.video, 'video', 0), prepTrack(opts.audio, 'audio', 0)].filter(Boolean);
      if (!tracks.length) throw new Error('沒有任何影音樣本可以封裝');
      tracks.forEach((t, i) => { t.id = i + 1; });
      // 依開始時間交錯排 chunk（同時間影像在前）
      const order = tracks.flatMap(t => t.chunks).sort((a, b) => a.t0 - b.t0 || (a.tr.kind === 'video' ? -1 : 1));
      const payload = order.reduce((s, c) => s + c.bytes, 0);
      const ftyp = writeFtyp(tracks);
      const largeMdat = payload + 8 > 0xffffffff;
      const mdatHead = largeMdat ? 16 : 8;
      const o = { co64: !!opts.forceCo64, time: opts.time != null ? opts.time : Math.floor(Date.now() / 1000) + 2082844800 };
      const layout = moovSize => {
        let off = ftyp.length + moovSize + mdatHead;
        for (const c of order) { c.offset = off; off += c.bytes; }
        return off;
      };
      let moov = writeMoov(tracks, o);
      // 最後一個 chunk 的位置超過 32 位元就改用 co64（moov 會變大，所以重算一次）
      if (!o.co64 && layout(moov.length) - (order[order.length - 1] || { bytes: 0 }).bytes > 0xffffffff) { o.co64 = true; moov = writeMoov(tracks, o); }
      const size = moov.length;
      const total = layout(size);
      moov = writeMoov(tracks, o);
      if (moov.length !== size) throw new Error('moov 大小不一致');
      const h = writer(mdatHead);
      if (largeMdat) h.u32(1).str('mdat').u64(payload + 16); else h.u32(payload + 8).str('mdat');
      const header = new Uint8Array(ftyp.length + moov.length + mdatHead);
      header.set(ftyp, 0); header.set(moov, ftyp.length); header.set(h.done(), ftyp.length + moov.length);
      const samples = [];
      for (const c of order) for (let i = c.first; i < c.first + c.count; i++) samples.push(c.tr.samples[i]);
      return { header, samples, co64: o.co64, largeMdat, size: total, tracks: tracks.map(t => ({ id: t.id, kind: t.kind, fourcc: t.fc })) };
    }

    function muxParts(opts) {
      const h = muxHeader(opts);
      const parts = [h.header];
      for (const s of h.samples) { if (!s.data) throw new Error('樣本缺少資料'); parts.push(s.data); }
      return parts;
    }

    function mux(opts) {
      const parts = muxParts(opts);
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let p = 0;
      for (const x of parts) { out.set(x, p); p += x.length; }
      return out;
    }

    return { mux, muxParts, muxHeader, buildAv1C, buildVpcC, buildEsds, buildAsc, parseOpusHead, stripTemporalDelimiters, fourcc, colorCodes };
  })();

  // ===================================================================================
  // 二、編碼格式選擇與位元率
  // ===================================================================================
  const QUALITY = {
    high:   { name: '高', bpp: 0.12, audio: 192000 },
    medium: { name: '中', bpp: 0.07, audio: 160000 },
    small:  { name: '小', bpp: 0.035, audio: 96000 },
  };
  const SAMPLE_RATE = 48000, CHANNELS = 2;
  // 位元率 = 每秒像素數 × 每像素位元（1080×1920@30：高 ≈ 7.5、中 ≈ 4.4、小 ≈ 2.2 Mbps）
  const videoBitrate = (w, h, fps, q) => Math.round(Math.min(80e6, Math.max(300e3, w * h * fps * (QUALITY[q] || QUALITY.high).bpp)));
  const audioBitrate = q => (QUALITY[q] || QUALITY.high).audio;

  const hex2 = n => n.toString(16).padStart(2, '0');
  // H.264 level：依畫面巨集區塊數與每秒巨集區塊數挑最小夠用的（1080p30 → 4.0＝0x28，4K30 → 5.1＝0x33）
  function avcLevel(w, h, fps) {
    const fs = Math.ceil(w / 16) * Math.ceil(h / 16), rate = fs * fps;
    const T = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240],
      [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3c, 139264, 4177920]];
    const l = T.find(([, f, r]) => fs <= f && rate <= r);
    return l ? l[0] : 0x3c;
  }
  function vp9Level(w, h, fps) {
    const ps = w * h, rate = ps * fps;
    const T = [[31, 983040, 36864000], [40, 2228224, 83558400], [41, 2228224, 160432128], [50, 8912896, 311951360],
      [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272], [61, 35651584, 2353004544]];
    const l = T.find(([, p, r]) => ps <= p && rate <= r);
    return l ? l[0] : 62;
  }
  function av1Level(w, h, fps) {
    const ps = w * h, rate = ps * fps;
    const T = [[8, 2228224, 133693440], [9, 2228224, 267386880], [12, 8912896, 267386880], [13, 8912896, 534773760],
      [14, 8912896, 1069547520], [16, 35651584, 1069547520], [17, 35651584, 2139095040]];
    const l = T.find(([, p, r]) => ps <= p && rate <= r);
    return l ? l[0] : 18;
  }

  function videoCandidates(w, h, fps) {
    const lv = hex2(avcLevel(w, h, fps));
    const avc = { avc: { format: 'avc' } };
    return [
      { name: 'H.264', family: 'h264', codec: `avc1.6400${lv}`, extra: avc },
      { name: 'H.264', family: 'h264', codec: `avc1.4d00${lv}`, extra: avc },
      { name: 'H.264', family: 'h264', codec: `avc1.4200${lv}`, extra: avc },
      { name: 'VP9', family: 'vp9', codec: `vp09.00.${vp9Level(w, h, fps)}.08` },
      { name: 'AV1', family: 'av1', codec: `av01.0.${String(av1Level(w, h, fps)).padStart(2, '0')}M.08` },
    ];
  }
  const audioCandidates = () => [
    { name: 'AAC', family: 'aac', codec: 'mp4a.40.2' },
    { name: 'Opus', family: 'opus', codec: 'opus' },
  ];
  const videoConfig = (c, w, h, fps, bitrate) => Object.assign({
    codec: c.codec, width: w, height: h, bitrate, framerate: fps,
    bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: 'no-preference',
  }, c.extra || {});
  const audioConfig = (c, bitrate) => ({ codec: c.codec, sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate });

  // 回傳這個瀏覽器能用的候選清單（依偏好排序）；prefer 可指定 'vp9'／'av1'…（測試用）
  async function pickCodecs({ width, height, fps, quality = 'high', prefer } = {}) {
    const res = { video: [], audio: [], label: '', note: '' };
    if (typeof VideoEncoder === 'undefined') return res;
    const vb = videoBitrate(width, height, fps, quality), ab = audioBitrate(quality);
    const ok = async (E, cfg) => { try { return !!(await E.isConfigSupported(cfg)).supported; } catch (e) { return false; } };
    const sortBy = (list, fam) => (fam ? list.filter(c => c.family === fam).concat(list.filter(c => c.family !== fam)) : list);
    for (const c of sortBy(videoCandidates(width, height, fps), prefer && prefer.video)) {
      if (await ok(VideoEncoder, videoConfig(c, width, height, fps, vb))) res.video.push(c);
    }
    if (typeof AudioEncoder !== 'undefined') {
      for (const c of sortBy(audioCandidates(), prefer && prefer.audio)) {
        if (await ok(AudioEncoder, audioConfig(c, ab))) res.audio.push(c);
      }
    }
    const v = res.video[0], a = res.audio[0];
    if (v) {
      res.label = a ? `${v.name}＋${a.name}` : `${v.name}（沒有聲音）`;
      const miss = [];
      if (v.family !== 'h264') miss.push('H.264');
      if (a && a.family !== 'aac') miss.push('AAC');
      if (!a) res.note = '此瀏覽器不支援聲音編碼，匯出的影片不會有聲音';
      else if (miss.length && !(prefer && (prefer.video || prefer.audio))) res.note = `此瀏覽器不支援 ${miss.join('／')} 編碼`;
    }
    return res;
  }

  // ===================================================================================
  // 三、匯出流程
  // ===================================================================================
  const GOP_SEC = 2;                      // 每 2 秒一個關鍵格
  const MAX_VQUEUE = 6, MAX_AQUEUE = 24;  // 編碼器佇列上限（背壓）
  const AUDIO_BLOCK = 4800;               // 每次送進聲音編碼器 0.1 秒
  const AUDIO_WEIGHT = 0.05;              // 進度條裡聲音佔的比例

  class Cancelled extends Error { constructor() { super('已取消匯出'); this.cancelled = true; } }

  const isVideoFrame = d => typeof VideoFrame !== 'undefined' && d instanceof VideoFrame;
  function waitDequeue(enc) {
    return new Promise(r => {
      const t = setTimeout(done, 30);
      function done() { clearTimeout(t); enc.removeEventListener && enc.removeEventListener('dequeue', done); r(); }
      if (enc.addEventListener) enc.addEventListener('dequeue', done, { once: true });
    });
  }
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms))]);
  const safeClose = x => { try { if (x && x.state !== 'closed') x.close(); } catch (e) { /* 已關閉 */ } };

  // 把 WebCodecs 的英文錯誤轉成看得懂的說明
  function explain(err, stage) {
    if (!err) return `${stage}失敗：發生未知錯誤`;
    if (err.cancelled) return err.message;
    const m = String(err.message || err);
    if (/memory|allocation/i.test(m)) return `${stage}時記憶體不足，請關掉其他分頁或改用較小的畫質再試一次（${m}）`;
    return `${stage}失敗：${m}`;
  }
  // 別的模組（render）丟出的錯誤：加上說明、標記成「換編碼格式也沒用」
  const stageError = (e, text) => {
    if (e && e.cancelled) return e;
    const x = new Error(`${text}：${(e && e.message) || e}`);
    x.noRetry = true;
    return x;
  };

  // 一格畫面：compose 的 getSource 是同步的，所以要先把非同步的來源畫格（seekSource）準備好再畫。
  // 依序用：render.renderFrame（render 自己備好來源再合成）→ render.sourcesAt 問要哪些來源 → 先「試畫」一次，記下 compose 跟 getSource 要了什麼。
  // 試畫時沒用到任何來源（只有字幕、色塊）就直接用試畫的結果，不畫第二次。
  async function drawFrame(ctx, p, frame, W, H, check) {
    const R = Q.render;
    const keyOf = (clip, t) => (clip ? `${clip.id}|${clip.mediaId}@${t}` : '');
    const need = new Map();                 // key → { mediaId, time }
    const paintBg = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = p.bgColor || '#000000'; ctx.fillRect(0, 0, W, H); };
    const compose = async getSource => {
      paintBg();
      ctx.save();
      try { await R.compose(ctx, p, frame, getSource); }
      catch (e) { throw stageError(e, `第 ${frame} 格畫面合成失敗`); } finally { ctx.restore(); }
    };
    // render 自己有「備好來源再合成」的 renderFrame（同一支素材同時要多個時間時會分開 <video>）：直接用
    if (typeof R.renderFrame === 'function') {
      paintBg();
      ctx.save();
      try { await R.renderFrame(ctx, p, frame); }
      catch (e) { throw e && e.cancelled ? e : stageError(e, `第 ${frame} 格畫面合成失敗`); } finally { ctx.restore(); }
      return;
    }
    let byClip = null;
    if (typeof R.sourcesAt === 'function') {
      let list;
      try { list = R.sourcesAt(p, frame) || []; } catch (e) { throw stageError(e, `第 ${frame} 格畫面合成失敗`); }
      byClip = new Map();
      for (const r of list) if (r && r.clip && r.mediaId != null) { need.set(r.clip.id, { mediaId: r.mediaId, time: r.time }); byClip.set(r.clip.id, r.clip.id); }
      if (!need.size) { await compose(() => null); return; }
    } else {
      await compose((clip, t) => {
        if (clip && clip.mediaId != null && Number.isFinite(t)) need.set(keyOf(clip, t), { mediaId: clip.mediaId, time: t });
        return null;
      });
      if (!need.size) return;
    }
    const got = new Map();
    try {
      for (const [k, r] of need) {
        check();
        try { got.set(k, await R.seekSource(r.mediaId, r.time)); } catch (e) { throw stageError(e, `讀取第 ${frame} 格的來源畫面失敗`); }
      }
      check();
      await compose((clip, t) => (clip && got.get(byClip ? clip.id : keyOf(clip, t))) || null);
    } finally {
      // seekSource 回傳的 VideoFrame 是快照，由呼叫端用完關閉；圖片（ImageBitmap）歸 render 管，不關
      for (const d of new Set(got.values())) if (isVideoFrame(d)) safeClose(d);
    }
  }

  // 把 AudioBuffer 整理成剛好 len 個樣本的立體聲（單聲道複製成兩聲道；長度不足補靜音）
  function audioPlanes(buf, len) {
    const L = new Float32Array(len), Rr = new Float32Array(len);
    if (buf && buf.numberOfChannels) {
      const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
      const n = Math.min(len, buf.length);
      L.set(a.subarray(0, n)); Rr.set(b.subarray(0, n));
    }
    return [L, Rr];
  }

  // 主流程。opts = { project, from, to（影格，半開區間）, quality, filename, onProgress(info), signal, prefer }
  // 回傳 { blob, filename, codecs: { video, audio, label }, frames, seconds }
  async function run(opts) {
    try { return await runExport(opts || {}); } finally { releaseSeekers(); }
  }
  async function runExport(opts) {
    const R = Q.render, C = Q.core;
    // 快照：匯出要花好幾秒，期間專案被改（API、自動處理）也不能讓成品前後不一致，甚至中途變黑畫面
    const p = opts.project && C && typeof C.clone === 'function' ? C.clone(opts.project) : opts.project;
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error(root.isSecureContext === false
        ? '影片編碼需要安全連線（https 或 localhost），請用正式網址開啟'
        : '這個瀏覽器不支援影片編碼（WebCodecs），請改用最新版 Chrome 或 Edge');
    }
    if (!p) throw new Error('還沒有專案可以匯出');
    if (!R || typeof R.compose !== 'function' || typeof R.seekSource !== 'function') throw new Error('剪輯模組還沒載入完成，請稍候再試');
    const fps = Math.round(p.fps) || 30, W = p.width, H = p.height;
    if (!(W > 0 && H > 0)) throw new Error('專案的輸出尺寸不正確');
    if (W % 2 || H % 2) throw new Error(`輸出尺寸 ${W}×${H} 需要是偶數`);
    const from = Math.max(0, Math.floor(opts.from || 0));
    const to = Math.floor(opts.to != null ? opts.to : (C && C.projectDuration ? C.projectDuration(p) : 0));
    const total = to - from;
    if (!(total > 0)) throw new Error('匯出範圍是空的：時間軸上沒有內容，或 In／Out 範圍不正確');
    const signal = opts.signal;
    const check = () => { if (signal && signal.aborted) throw new Cancelled(); };
    const quality = QUALITY[opts.quality] ? opts.quality : 'high';
    const report = info => { if (opts.onProgress) try { opts.onProgress(info); } catch (e) { /* 介面更新失敗不影響匯出 */ } };

    // 字型要先載入，不然第一格的字幕會用備用字型
    report({ phase: 'prepare', fraction: 0, text: '準備中…' });
    // 專案用到的字幕字型（大字型是用到才下載）都要等；網路慢時最多等 60 秒，再不行就用備用字型
    if (Q.fx && typeof Q.fx.ready === 'function') await withTimeout(Q.fx.ready(p), 60000);
    if (root.document && document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 8000);
    check();

    const picked = opts.codecs || await pickCodecs({ width: W, height: H, fps, quality, prefer: opts.prefer });
    if (!picked.video.length) throw new Error('這個瀏覽器沒有可用的影片編碼器（H.264／VP9／AV1 都不支援），請改用最新版 Chrome 或 Edge');
    check();

    const vb = videoBitrate(W, H, fps, quality), ab = audioBitrate(quality);
    const vts = fps * 1000, frameUs = 1e6 / fps;
    const audioLen = Math.round(total / fps * SAMPLE_RATE);
    const hasAudio = picked.audio.length > 0 && R && typeof R.renderAudio === 'function';
    const t0 = performance.now();
    let frac = 0;
    const progress = (f, text) => {
      frac = Math.max(frac, f);
      const el = (performance.now() - t0) / 1000;
      report({ phase: 'encode', fraction: frac, elapsed: el, eta: frac > 0.02 && el > 1 ? el * (1 - frac) / frac : null, text });
    };

    // ---- 聲音 ----
    let audioTrack = null, audioUsed = null;
    if (hasAudio) {
      progress(0, '混音中…');
      let buf;
      try { buf = await R.renderAudio(p, { sampleRate: SAMPLE_RATE, channels: CHANNELS, from, to }); } catch (e) { throw stageError(e, '混音失敗'); }
      check();
      const planes = audioPlanes(buf, audioLen);
      let lastErr = null;
      for (const cand of picked.audio) {
        try {
          audioTrack = await encodeAudio(cand, planes, audioLen, ab, check, f => progress(f * AUDIO_WEIGHT, '聲音編碼中…'));
          audioUsed = cand;
          break;
        } catch (e) { if (e.cancelled || e.noRetry) throw e; lastErr = e; }
      }
      if (!audioTrack) throw new Error(explain(lastErr, '聲音編碼'));
    }
    const vStart = hasAudio ? AUDIO_WEIGHT : 0;

    // ---- 影像 ----
    let videoTrack = null, videoUsed = null, lastErr = null;
    for (const cand of picked.video) {
      try {
        videoTrack = await encodeVideo(cand);
        videoUsed = cand;
        break;
      } catch (e) {
        if (e.cancelled || e.noRetry) throw e;
        lastErr = e;
        if (!e.retryable) break;             // 已經編出畫面才失敗：不換格式重來
      }
    }
    if (!videoTrack) throw new Error(explain(lastErr, '影片編碼'));

    async function encodeVideo(cand) {
      const samples = [];
      let desc = null, cs = null, err = null, outputs = 0;
      const enc = new VideoEncoder({
        output(chunk, meta) {
          if (meta && meta.decoderConfig) { if (meta.decoderConfig.description) desc = meta.decoderConfig.description; if (meta.decoderConfig.colorSpace) cs = meta.decoderConfig.colorSpace; }
          const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
          samples.push({ data: d, ts: Math.round(chunk.timestamp / frameUs) * 1000, dur: 1000, key: chunk.type === 'key' });
          outputs++;
          progress(vStart + (1 - vStart) * 0.98 * (outputs / total), `影片編碼中 ${outputs}／${total} 格`);
        },
        error(e) { err = e; },
      });
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = canvas.getContext('2d', { alpha: false });
      const fail = e => { const x = e instanceof Error ? e : new Error(String(e && e.message || e)); x.retryable = outputs === 0; return x; };
      try {
        enc.configure(videoConfig(cand, W, H, fps, vb));
        const gop = fps * GOP_SEC;
        for (let i = 0; i < total; i++) {
          check();
          if (err) throw fail(err);
          await drawFrame(ctx, p, from + i, W, H, check);
          const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
          try { enc.encode(vf, { keyFrame: i % gop === 0 }); } finally { vf.close(); }
          while (enc.encodeQueueSize > MAX_VQUEUE && !err) { await waitDequeue(enc); check(); }
        }
        if (err) throw fail(err);
        await enc.flush();
        if (err) throw fail(err);
      } catch (e) {
        if (e.cancelled || e.noRetry) throw e;
        throw fail(err || e);
      } finally { safeClose(enc); }
      if (samples.length !== total) throw fail(new Error(`編碼器輸出 ${samples.length} 格，預期 ${total} 格`));
      // samples 維持編碼器輸出的順序（＝解碼順序）；有 B 格時 mp4 會自己算 ctts
      return { codec: cand.codec, width: W, height: H, timescale: vts, description: desc, colorSpace: cs, samples };
    }

    // ---- 封裝 ----
    check();
    progress(0.99, '封裝中…');
    const parts = mp4.muxParts({ video: videoTrack, audio: audioTrack });
    const blob = new Blob(parts, { type: 'video/mp4' });
    const codecs = { video: videoUsed.name, audio: audioUsed ? audioUsed.name : null, label: audioUsed ? `${videoUsed.name}＋${audioUsed.name}` : `${videoUsed.name}（沒有聲音）` };
    report({ phase: 'done', fraction: 1, elapsed: (performance.now() - t0) / 1000, text: '完成' });
    return { blob, filename: opts.filename || '剪輯.mp4', codecs, frames: total, seconds: total / fps };
  }

  // 匯出用的 <video>（render.seekSource 開的）用完就釋放
  const releaseSeekers = () => { try { if (Q.render && typeof Q.render.releaseSeekers === 'function') Q.render.releaseSeekers(); } catch (e) { /* 不影響匯出 */ } };

  async function encodeAudio(cand, planes, len, bitrate, check, onFrac) {
    const samples = [];
    let desc = null, err = null;
    const enc = new AudioEncoder({
      output(chunk, meta) {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) desc = meta.decoderConfig.description;
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        samples.push({ data: d, ts: Math.round(chunk.timestamp * SAMPLE_RATE / 1e6), dur: Math.round((chunk.duration || 0) * SAMPLE_RATE / 1e6), key: true });
      },
      error(e) { err = e; },
    });
    try {
      enc.configure(audioConfig(cand, bitrate));
      const [L, Rr] = planes;
      for (let off = 0; off < len; off += AUDIO_BLOCK) {
        check();
        if (err) throw err;
        const n = Math.min(AUDIO_BLOCK, len - off);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(off, off + n), 0); data.set(Rr.subarray(off, off + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: CHANNELS, timestamp: Math.round(off * 1e6 / SAMPLE_RATE), data });
        try { enc.encode(ad); } finally { ad.close(); }
        while (enc.encodeQueueSize > MAX_AQUEUE && !err) { await waitDequeue(enc); check(); }
        onFrac((off + n) / len);
      }
      await enc.flush();
      if (err) throw err;
    } finally { safeClose(enc); }
    if (!samples.length) throw new Error('聲音編碼器沒有輸出');
    // 編碼器的暖機樣本：Opus 由 OpusHead 的 pre-skip 決定（封裝時自動處理）；
    // AAC：第一個封包時間是負的就照它，否則用 AAC 標準的 1024（各平台編碼器不同，誤差在 ±1 個 AAC 框＝約 21ms 內）
    let skip;
    const first = samples[0].ts;
    if (first < 0) { skip = -first; for (const s of samples) s.ts += skip; }
    else if (cand.family === 'aac') skip = 1024;
    return { codec: cand.codec, sampleRate: SAMPLE_RATE, channels: CHANNELS, timescale: SAMPLE_RATE, description: desc, skip, presentDuration: len, samples };
  }

  // ===================================================================================
  // 四、對話框
  // ===================================================================================
  const $ = id => document.getElementById(id);
  const STYLE = `
.ed-ex-dialog { border: 1px solid var(--border); border-radius: 14px; padding: 0; width: min(460px, calc(100vw - 32px));
  background: var(--field-bg); color: var(--text); box-shadow: var(--shadow); font-family: var(--ui-font); }
.ed-ex-dialog::backdrop { background: rgba(15, 30, 60, .38); }
.ed-ex { padding: 20px 22px 18px; display: grid; gap: 14px; margin: 0; }
.ed-ex-title { margin: 0; font-size: 18px; }
.ed-ex-field > .ed-ex-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.ed-ex-name { display: flex; align-items: center; gap: 6px; }
.ed-ex-name input { flex: 1; min-width: 0; font: inherit; font-size: 14px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text); }
.ed-ex-name input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ed-ex-name span { color: var(--muted); font-size: 14px; }
.ed-ex-seg { margin-bottom: 0; }
.ed-ex-hint { font-size: 12px; color: var(--muted); margin-top: 6px; min-height: 1em; }
.ed-ex-info { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 13px;
  background: var(--accent-soft); border-radius: 10px; padding: 10px 12px; }
.ed-ex-info dt { color: var(--muted); }
.ed-ex-info dd { margin: 0; font-weight: 600; }
.ed-ex-info .ed-ex-note { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.ed-ex-progress { display: grid; gap: 6px; }
.ed-ex-progress progress { width: 100%; height: 8px; appearance: none; border: none; border-radius: 99px; overflow: hidden; background: var(--accent-soft); }
.ed-ex-progress progress::-webkit-progress-bar { background: var(--accent-soft); border-radius: 99px; }
.ed-ex-progress progress::-webkit-progress-value { background: var(--accent); border-radius: 99px; transition: width .2s; }
.ed-ex-progress progress::-moz-progress-bar { background: var(--accent); }
.ed-ex-stat { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ed-ex-msg { font-size: 13px; min-height: 1.2em; }
.ed-ex-msg.is-error { color: var(--ed-err-fg, #c0262d); }
.ed-ex-msg.is-ok { color: var(--success); }
.ed-ex-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ed-ex-actions button { padding: 9px 18px; }
@media (prefers-reduced-motion: reduce) { .ed-ex-progress progress::-webkit-progress-value { transition: none; } }
`;

  const ui = { built: false, busy: false, ctrl: null, range: 'all', quality: 'high', name: '', project: null, pickToken: 0 };
  const pad2 = n => String(n).padStart(2, '0');
  const stampNow = () => { const d = new Date(); return `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
  const safeBase = name => (String(name || '').replace(/\.mp4$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 80));
  const fmtTime = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m} 分 ${pad2(s % 60)} 秒` : `${s} 秒`; };
  const fmtDur = s => (s < 60 ? `${+s.toFixed(1)} 秒` : fmtTime(s));
  const fmtTc = (f, fps) => { const s = Math.floor(f / fps); return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(f % fps)}`; };
  const fmtSize = b => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const fmtRate = b => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : `${Math.round(b / 1e3)} kbps`);

  const currentProject = () => ui.project || (Q.ui && Q.ui.state && Q.ui.state.project) || null;
  const duration = p => { try { return Q.core && Q.core.projectDuration ? Q.core.projectDuration(p) : 0; } catch (e) { return 0; } };
  function rangeOf(p, which) {
    const dur = duration(p);
    if (which === 'io' && (p.inPoint != null || p.outPoint != null)) {
      const a = Math.max(0, p.inPoint != null ? p.inPoint : 0);
      const b = p.outPoint != null ? p.outPoint : dur;
      return { from: a, to: Math.max(a, b) };
    }
    return { from: 0, to: dur };
  }

  function injectStyle() {
    if ($('ed-export-style')) return;
    const s = document.createElement('style');
    s.id = 'ed-export-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function build(dlg) {
    dlg.classList.add('ed-ex-dialog');
    dlg.setAttribute('aria-labelledby', 'edExTitle');
    dlg.innerHTML = `
<form class="ed-ex" method="dialog" novalidate>
  <h2 class="ed-ex-title" id="edExTitle">匯出影片</h2>
  <div class="ed-ex-field">
    <label class="ed-ex-label" for="edExName">檔名</label>
    <div class="ed-ex-name"><input id="edExName" type="text" autocomplete="off" spellcheck="false" maxlength="80"><span>.mp4</span></div>
  </div>
  <div class="ed-ex-field">
    <span class="ed-ex-label" id="edExRangeLabel">範圍</span>
    <div class="bg-toggle ed-ex-seg" id="edExRange" role="group" aria-labelledby="edExRangeLabel">
      <button type="button" data-v="all">整段</button><button type="button" data-v="io">In～Out</button>
    </div>
    <div class="ed-ex-hint" id="edExRangeHint"></div>
  </div>
  <div class="ed-ex-field">
    <span class="ed-ex-label" id="edExQualityLabel">畫質</span>
    <div class="bg-toggle ed-ex-seg" id="edExQuality" role="group" aria-labelledby="edExQualityLabel">
      <button type="button" data-v="high">高</button><button type="button" data-v="medium">中</button><button type="button" data-v="small">小</button>
    </div>
    <div class="ed-ex-hint" id="edExQualityHint"></div>
  </div>
  <dl class="ed-ex-info">
    <dt>輸出</dt><dd id="edExSize"></dd>
    <dt>編碼</dt><dd id="edExCodec"></dd>
  </dl>
  <div class="ed-ex-progress" id="edExProgress" hidden>
    <progress id="edExBar" max="1" value="0"></progress>
    <div class="ed-ex-stat"><span id="edExStatus"></span><span id="edExEta"></span></div>
  </div>
  <div class="ed-ex-msg" id="edExMsg" role="status" aria-live="polite"></div>
  <div class="ed-ex-actions">
    <button type="button" id="edExClose">關閉</button>
    <button type="button" class="primary" id="edExGo">匯出</button>
  </div>
</form>`;
    const seg = (id, key) => $(id).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled || ui.busy) return;
      ui[key] = b.dataset.v;
      refresh();
    });
    seg('edExRange', 'range');
    seg('edExQuality', 'quality');
    $('edExName').addEventListener('input', () => { ui.name = $('edExName').value; });
    $('edExName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); start(); } });
    $('edExGo').addEventListener('click', start);
    $('edExClose').addEventListener('click', () => { if (ui.busy) { if (ui.ctrl) ui.ctrl.abort(); } else dlg.close(); });
    dlg.addEventListener('cancel', e => { if (ui.busy) e.preventDefault(); });     // 匯出中按 Esc 不關
    ui.built = true;
  }

  function setMsg(text, kind) {
    const m = $('edExMsg');
    m.textContent = text || '';
    m.classList.toggle('is-error', kind === 'error');
    m.classList.toggle('is-ok', kind === 'ok');
  }

  // 依目前專案與選項更新對話框（不含進度）
  function refresh() {
    const p = currentProject();
    const go = $('edExGo');
    const hasIO = !!p && (p.inPoint != null || p.outPoint != null);
    if (!hasIO && ui.range === 'io') ui.range = 'all';
    for (const b of $('edExRange').children) { b.classList.toggle('active', b.dataset.v === ui.range); b.disabled = ui.busy || (b.dataset.v === 'io' && !hasIO); }
    for (const b of $('edExQuality').children) { b.classList.toggle('active', b.dataset.v === ui.quality); b.disabled = ui.busy; }
    $('edExName').disabled = ui.busy;
    go.disabled = ui.busy;
    $('edExClose').textContent = ui.busy ? '取消匯出' : '關閉';
    if (!p) {
      $('edExSize').textContent = '—';
      $('edExRangeHint').textContent = '';
      $('edExQualityHint').textContent = '';
      $('edExCodec').textContent = '—';
      go.disabled = true;
      if (!ui.busy) setMsg('還沒有專案可以匯出', 'error');
      return;
    }
    const fps = Math.round(p.fps) || 30;
    const r = rangeOf(p, ui.range), frames = r.to - r.from, secs = frames / fps;
    $('edExSize').textContent = `${p.width}×${p.height}．${fps} fps（依專案設定）`;
    $('edExRangeHint').textContent = frames > 0
      ? `${fmtTc(r.from, fps)} ～ ${fmtTc(r.to, fps)}，共 ${fmtDur(secs)}（${frames} 格）`
      : (ui.range === 'io' ? 'In／Out 範圍是空的' : '時間軸上還沒有內容');
    const vb = videoBitrate(p.width, p.height, fps, ui.quality), ab = audioBitrate(ui.quality);
    $('edExQualityHint').textContent = `影像約 ${fmtRate(vb)}${frames > 0 ? `，檔案約 ${fmtSize((vb + ab) / 8 * secs)}` : ''}`;
    if (frames <= 0) go.disabled = true;
    updateCodecLabel(p, fps);
  }

  // 實際會用的編碼格式（非同步查詢；尺寸、fps、畫質一樣就不重查）
  let codecKey = '', codecInfo = null;
  async function updateCodecLabel(p, fps) {
    const el = $('edExCodec');
    const k = `${p.width}x${p.height}@${fps}/${ui.quality}`;
    if (k === codecKey && codecInfo) { paintCodec(el, codecInfo); return; }
    codecKey = k; codecInfo = null;
    const token = ++ui.pickToken;
    el.textContent = '偵測中…';
    let info;
    try { info = await pickCodecs({ width: p.width, height: p.height, fps, quality: ui.quality }); } catch (e) { info = { video: [], audio: [] }; }
    if (token !== ui.pickToken) return;
    codecInfo = info;
    paintCodec(el, info);
  }
  function paintCodec(el, info) {
    el.textContent = '';
    if (!info.video.length) {
      el.textContent = typeof VideoEncoder === 'undefined' ? '此瀏覽器不支援影片編碼' : '找不到可用的影片編碼器';
      if (!ui.busy) { $('edExGo').disabled = true; setMsg('這個瀏覽器不能匯出影片，請改用最新版 Chrome 或 Edge', 'error'); }
      return;
    }
    el.append(info.label);
    if (info.note) { const n = document.createElement('span'); n.className = 'ed-ex-note'; n.textContent = info.note; el.append(n); }
  }

  function showProgress(info) {
    $('edExProgress').hidden = false;
    $('edExBar').value = info.fraction || 0;
    $('edExStatus').textContent = info.text || '';
    $('edExEta').textContent = info.eta != null ? `剩餘約 ${fmtTime(info.eta)}` : (info.elapsed > 0 ? `已用 ${fmtTime(info.elapsed)}` : '');
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function start() {
    if (ui.busy) return;
    const p = currentProject();
    if (!p) { setMsg('還沒有專案可以匯出', 'error'); return; }
    const r = rangeOf(p, ui.range);
    if (!(r.to > r.from)) { setMsg('匯出範圍是空的', 'error'); return; }
    // 開啟專案後還沒重新連結的素材：匯出範圍裡有用到就不能匯出（不然那幾段會是黑畫面／沒聲音）
    const M = Q.render && Q.render.media;
    const lost = M ? Object.values(p.clips).filter(c => c.type === 'media' && c.mediaId && !M.get(c.mediaId) && c.start < r.to && c.start + c.duration > r.from) : [];
    if (lost.length) {
      const names = [...new Set(lost.map(c => (p.mediaInfo && p.mediaInfo[c.mediaId] && p.mediaInfo[c.mediaId].name) || '未知素材'))];
      setMsg(`還有 ${names.length} 個素材沒有重新連結（${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}），請先在左側媒體庫重新連結再匯出`, 'error');
      return;
    }
    const base = safeBase($('edExName').value) || `剪輯_${stampNow()}`;
    $('edExName').value = ui.name = base;
    const filename = `${base}.mp4`;
    ui.busy = true;
    ui.ctrl = new AbortController();
    setMsg('');
    refresh();
    showProgress({ fraction: 0, text: '準備中…' });
    const t0 = performance.now();
    try {
      const res = await run({ project: p, from: r.from, to: r.to, quality: ui.quality, filename, signal: ui.ctrl.signal, onProgress: showProgress });
      saveBlob(res.blob, filename);
      api.lastExport = { filename, size: res.blob.size, at: Date.now(), codecs: res.codecs };
      if (Q.core && Q.core.bus && typeof CustomEvent !== 'undefined') Q.core.bus.dispatchEvent(new CustomEvent('exported', { detail: api.lastExport }));
      setMsg(`已匯出：${filename}（${fmtSize(res.blob.size)}，${res.codecs.label}，用時 ${fmtTime((performance.now() - t0) / 1000)}）`, 'ok');
    } catch (e) {
      if (e && e.cancelled) { setMsg('已取消匯出'); $('edExProgress').hidden = true; }
      else {
        console.error(e);
        const m = String((e && e.message) || e);
        setMsg(/失敗|不足/.test(m) ? m : `無法匯出：${m}`, 'error');
      }
    } finally {
      ui.busy = false;
      ui.ctrl = null;
      refresh();
    }
  }

  // 打開匯出對話框。opts.project 可指定專案（預設用 QPTEdit.ui.state.project）
  function open(opts) {
    const dlg = typeof document !== 'undefined' && $('edExportDialog');
    if (!dlg) return false;
    injectStyle();
    if (!ui.built) build(dlg);
    if (!ui.busy) ui.project = (opts && opts.project) || null;   // 沒指定就回到目前的剪輯專案（不要黏著上次指定的專案）
    if (!ui.busy) {
      setMsg('');
      $('edExProgress').hidden = true;
      if (!ui.name) ui.name = `剪輯_${stampNow()}`;
      $('edExName').value = ui.name;
      const p = currentProject();
      if (p && (p.inPoint != null || p.outPoint != null) && !dlg.open) ui.range = 'io';   // 有 In／Out 時預設只匯出那一段
    }
    refresh();
    if (!dlg.open) dlg.showModal();
    return true;
  }

  function cancel() { if (ui.ctrl) ui.ctrl.abort(); }

  const api = {
    open, cancel, run, pickCodecs, mp4,
    get busy() { return ui.busy; },
    lastExport: null,
    // 測試／除錯用
    _internal: { videoBitrate, audioBitrate, avcLevel, vp9Level, av1Level, videoCandidates, rangeOf, QUALITY },
  };
  Q.exporter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
