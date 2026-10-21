// =====================================================================================
// 剪輯：匯出影片（MP4／MOV／WebM）
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
  //   opts.brand = 'qt' → MOV（QuickTime 的 ftyp，其餘結構一樣）。
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
      let samples = t.samples.map(s => ({ data: s.data != null ? toU8(s.data) : null, size: s.data != null ? 0 : s.size, ref: s.ref, ts: Math.round(s.ts), dur: s.dur, key: kind === 'audio' ? true : !!s.key }));
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

    function writeFtyp(tracks, brand) {
      if (brand === 'qt') {                          // MOV（QuickTime）：其餘 box 和 MP4 一樣
        const q = writer(32);
        q.box('ftyp', () => { q.str('qt  ').u32(0x20050300).str('qt  '); });
        return q.done();
      }
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
      const ftyp = writeFtyp(tracks, opts.brand);
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
  // 一之二、WebM 封裝（純函式，Matroska 的子集）
  //   webm.mux({ video, audio }) → Uint8Array；webm.muxParts(...) → [位元組片段…]（樣本資料不複製）
  //   video / audio 的格式和 mp4.mux 一樣；只接受 VP9／AV1＋Opus（WebM 規範只允許這些）。
  //   樣本也可以只給 { size, ref }（資料在暫存檔）：muxParts 回傳的片段裡會有 { length, ref } 佔位物件，由寫檔的一方去讀。
  //   結構：EBML 檔頭 → Segment［SeekHead、Info、Tracks、Cluster…、Cues］。每個影像關鍵格開一個 Cluster
  //   （最長 30 秒），Cues 記每個 Cluster 的位置，播放器才能快速跳轉。時間單位 1 毫秒（TimestampScale 1e6 ns）。
  //   Opus 的 pre-skip 寫在 CodecDelay；尾端多出來的樣本用最後一個 BlockGroup 的 DiscardPadding 截掉。
  // ===================================================================================
  const webm = (function () {
    const ID = {
      EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7, EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3,
      DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
      Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
      Info: 0x1549A966, TimestampScale: 0x2AD7B1, Duration: 0x4489, MuxingApp: 0x4D80, WritingApp: 0x5741,
      Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5, TrackType: 0x83, FlagLacing: 0x9C,
      CodecID: 0x86, CodecPrivate: 0x63A2, CodecDelay: 0x56AA, SeekPreRoll: 0x56BB, DefaultDuration: 0x23E383,
      Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
      Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, DiscardPadding: 0x75A2,
      Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7, CueClusterPosition: 0xF1,
    };
    const toU8 = a => (a instanceof Uint8Array ? a : ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a));
    const idBytes = id => { const out = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255); return out; };
    // 長度的 vint：n 個位元組最多表示 2^(7n)−2（全 1 保留給「未知長度」）
    const vintLen = v => { let n = 1; while (n < 8 && v >= 2 ** (7 * n) - 1) n++; return n; };
    function vint(v, n) {
      n = n || vintLen(v);
      const out = new Array(n);
      for (let i = n - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] |= 0x80 >> (n - 1);
      return out;
    }
    const uintBytes = (v, n) => { const out = []; do { out.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0); while (n && out.length < n) out.unshift(0); return out; };
    const intBytes = v => { const b = new DataView(new ArrayBuffer(8)); b.setBigInt64(0, BigInt(v)); const a = Array.from(new Uint8Array(b.buffer)); while (a.length > 1 && ((a[0] === 0 && !(a[1] & 0x80)) || (a[0] === 255 && (a[1] & 0x80)))) a.shift(); return a; };
    const floatBytes = v => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v); return Array.from(new Uint8Array(b.buffer)); };
    const strBytes = s => Array.from(new TextEncoder().encode(s));

    // 節點：{ id, kids: [...] } 或 { id, data: Uint8Array|number[] } 或 { id, parts: [Uint8Array…] }（片段不複製）
    const el = (id, kids) => ({ id, kids });
    const u = (id, v, n) => ({ id, data: uintBytes(v, n) });
    const i = (id, v) => ({ id, data: intBytes(v) });
    const f = (id, v) => ({ id, data: floatBytes(v) });
    const str = (id, v) => ({ id, data: strBytes(v) });
    const bin = (id, v) => ({ id, data: toU8(v) });
    function payloadSize(n) {
      if (n.kids) return n.kids.reduce((s, k) => s + nodeSize(k), 0);
      if (n.parts) return n.parts.reduce((s, p) => s + p.length, 0);
      return n.data.length;
    }
    function nodeSize(n) { const p = payloadSize(n); return idBytes(n.id).length + vintLen(p) + p; }
    function emit(n, out) {
      const p = payloadSize(n);
      out.push(Uint8Array.from([...idBytes(n.id), ...vint(p)]));
      if (n.kids) for (const k of n.kids) emit(k, out);
      else if (n.parts) for (const x of n.parts) out.push(x);
      else out.push(n.data instanceof Uint8Array ? n.data : Uint8Array.from(n.data));
    }

    const codecId = c => {
      const x = String(c || '').toLowerCase();
      if (x.startsWith('vp09') || x === 'vp9') return 'V_VP9';
      if (x.startsWith('av01')) return 'V_AV1';
      if (x === 'opus') return 'A_OPUS';
      throw new Error(`WebM 不能放 ${c}（只支援 VP9／AV1＋Opus）`);
    };
    function opusHead(t) {
      const d = t.description ? toU8(t.description) : null;
      if (d && d.length >= 19 && String.fromCharCode(...d.subarray(0, 8)) === 'OpusHead') return d;
      const h = new Uint8Array(19), dv = new DataView(h.buffer);
      h.set([79, 112, 117, 115, 72, 101, 97, 100, 1, t.channels || 2]);
      dv.setUint16(10, t.skip != null ? t.skip : 312, true); dv.setUint32(12, t.sampleRate || 48000, true);
      return h;
    }

    function muxParts(opts) {
      opts = opts || {};
      const V = opts.video && opts.video.samples && opts.video.samples.length ? opts.video : null;
      const A = opts.audio && opts.audio.samples && opts.audio.samples.length ? opts.audio : null;
      if (!V && !A) throw new Error('沒有任何影音樣本可以封裝');
      const tracks = [], blocks = [];
      let durMs = 0;
      if (V) {
        const cid = codecId(V.codec), ts = V.timescale || 1000, num = tracks.length + 1;
        const firstKey = V.samples.find(x => x.key) || V.samples[0];
        const kids = [u(ID.TrackNumber, num), u(ID.TrackUID, num), u(ID.TrackType, 1), u(ID.FlagLacing, 0), str(ID.CodecID, cid)];
        if (cid === 'V_AV1') kids.push(bin(ID.CodecPrivate, V.description ? toU8(V.description) : mp4.buildAv1C(V.codec, firstKey.data != null ? toU8(firstKey.data) : null)));
        const fdur = V.samples[0].dur || 0;
        if (fdur > 0) kids.push(u(ID.DefaultDuration, Math.round(fdur / ts * 1e9)));
        kids.push(el(ID.Video, [u(ID.PixelWidth, V.width), u(ID.PixelHeight, V.height)]));
        tracks.push(el(ID.TrackEntry, kids));
        for (const x of V.samples) {
          const data = x.data == null ? { length: x.size, ref: x.ref } : cid === 'V_AV1' ? mp4.stripTemporalDelimiters(toU8(x.data)) : toU8(x.data);
          blocks.push({ track: num, ms: Math.round(x.ts / ts * 1000), key: !!x.key, video: true, data });
          durMs = Math.max(durMs, (x.ts + (x.dur || 0)) / ts * 1000);
        }
      }
      if (A) {
        const cid = codecId(A.codec), sr = A.sampleRate || 48000, ts = A.timescale || sr, num = tracks.length + 1;
        const head = opusHead(A), skip = A.skip != null ? A.skip : new DataView(head.buffer, head.byteOffset).getUint16(10, true);
        tracks.push(el(ID.TrackEntry, [u(ID.TrackNumber, num), u(ID.TrackUID, num), u(ID.TrackType, 2), u(ID.FlagLacing, 0), str(ID.CodecID, cid),
          bin(ID.CodecPrivate, head), u(ID.CodecDelay, Math.round(skip / sr * 1e9)), u(ID.SeekPreRoll, 80000000),
          el(ID.Audio, [f(ID.SamplingFrequency, sr), u(ID.Channels, A.channels || 2)])]));
        const last = A.samples[A.samples.length - 1], end = last.ts + (last.dur || 0);
        // 尾端多出來的樣本（編碼器補的靜音）：最後一個封包標 DiscardPadding
        const extra = A.presentDuration != null ? Math.max(0, end - skip - Math.round(A.presentDuration * ts / sr)) : 0;
        A.samples.forEach((x, k) => {
          const b = { track: num, ms: Math.round(x.ts / ts * 1000), key: true, video: false, data: x.data == null ? { length: x.size, ref: x.ref } : toU8(x.data) };
          if (k === A.samples.length - 1 && extra > 0 && extra <= (x.dur || 0)) b.discardNs = Math.round(extra / ts * 1e9);
          blocks.push(b);
        });
        const present = A.presentDuration != null ? A.presentDuration / sr * 1000 : (end - skip) / ts * 1000;
        durMs = Math.max(durMs, present);
      }
      // 依時間交錯（同時間影像在前）
      blocks.sort((a, b) => a.ms - b.ms || (a.video === b.video ? 0 : a.video ? -1 : 1));
      // 切 Cluster：有影像時每個關鍵格開新的；最長 30 秒（區塊時間是 16 位元的相對毫秒）
      const clusters = [];
      let cur = null;
      for (const b of blocks) {
        const brk = !cur || (V ? b.video && b.key : false) || b.ms - cur.ms > 30000;
        if (brk) { cur = { ms: b.ms, blocks: [], cue: !V || (b.video && b.key) }; clusters.push(cur); }
        cur.blocks.push(b);
      }
      const clusterNodes = clusters.map(c => el(ID.Cluster, [u(ID.Timestamp, c.ms), ...c.blocks.map(b => {
        const head = Uint8Array.from([...vint(b.track), ...(() => { const r = b.ms - c.ms; return [(r >> 8) & 255, r & 255]; })(), b.discardNs ? 0 : (b.key ? 0x80 : 0)]);
        if (b.discardNs) return el(ID.BlockGroup, [{ id: ID.Block, parts: [head, b.data] }, i(ID.DiscardPadding, b.discardNs)]);
        return { id: ID.SimpleBlock, parts: [head, b.data] };
      })]));
      const info = el(ID.Info, [u(ID.TimestampScale, 1000000), f(ID.Duration, durMs), str(ID.MuxingApp, 'QuickCut'), str(ID.WritingApp, 'QuickCut')]);
      const tracksNode = el(ID.Tracks, tracks);
      // SeekHead 與 Cues 的位置都用 8 位元組的固定長度整數，大小不會因為位置而變，算一次就好
      const seekHead = pos => el(ID.SeekHead, [[ID.Info, pos.info], [ID.Tracks, pos.tracks], [ID.Cues, pos.cues]].map(([id, p]) =>
        el(ID.Seek, [bin(ID.SeekID, idBytes(id)), u(ID.SeekPosition, p, 8)])));
      const shSize = nodeSize(seekHead({ info: 0, tracks: 0, cues: 0 }));
      const pos = { info: shSize };
      pos.tracks = pos.info + nodeSize(info);
      let p = pos.tracks + nodeSize(tracksNode);
      const cuePoints = [];
      clusterNodes.forEach((n, k) => {
        if (clusters[k].cue) cuePoints.push(el(ID.CuePoint, [u(ID.CueTime, clusters[k].ms), el(ID.CueTrackPositions, [u(ID.CueTrack, 1), u(ID.CueClusterPosition, p, 8)])]));
        p += nodeSize(n);
      });
      pos.cues = p;
      const segKids = [seekHead(pos), info, tracksNode, ...clusterNodes, el(ID.Cues, cuePoints)];
      const header = el(ID.EBML, [u(ID.EBMLVersion, 1), u(ID.EBMLReadVersion, 1), u(ID.EBMLMaxIDLength, 4), u(ID.EBMLMaxSizeLength, 8),
        str(ID.DocType, 'webm'), u(ID.DocTypeVersion, 4), u(ID.DocTypeReadVersion, 2)]);
      const out = [];
      emit(header, out);
      emit(el(ID.Segment, segKids), out);
      return out;
    }
    function mux(opts) {
      const parts = muxParts(opts);
      const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
      let q = 0;
      for (const x of parts) { out.set(x, q); q += x.length; }
      return out;
    }
    return { mux, muxParts, ID, vint, codecId };
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

  // 封裝格式能放哪些編碼：MOV 只放 H.264＋AAC（QuickTime／Apple 裝置相容）；WebM 規範只允許 VP9／AV1＋Opus
  const CONTAINERS = {
    mp4: { name: 'MP4', ext: 'mp4', mime: 'video/mp4', video: ['h264', 'vp9', 'av1'], audio: ['aac', 'opus'] },
    mov: { name: 'MOV', ext: 'mov', mime: 'video/quicktime', video: ['h264'], audio: ['aac'] },
    webm: { name: 'WebM', ext: 'webm', mime: 'video/webm', video: ['vp9', 'av1'], audio: ['opus'] },
  };
  const FAMILY_NAME = { h264: 'H.264', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus' };

  // 回傳這個瀏覽器能用的候選清單（依偏好排序）。
  //   prefer.video／prefer.audio：優先用的編碼（'h264'|'vp9'|'av1'／'aac'|'opus'）；audio: 'none' → 不含聲音
  //   container：'mp4'|'mov'|'webm'，只留這個格式放得下的編碼；videoBitrate／audioBitrate（bps）可直接指定
  //   res.support：每種編碼這個瀏覽器能不能用（不管封裝格式），對話框用來停用選項
  async function pickCodecs({ width, height, fps, quality = 'high', prefer, container = 'mp4', audio, videoBitrate: vbIn, audioBitrate: abIn } = {}) {
    const res = { video: [], audio: [], label: '', note: '', support: {} };
    if (typeof VideoEncoder === 'undefined') return res;
    const C = CONTAINERS[container] || CONTAINERS.mp4;
    const vb = vbIn || videoBitrate(width, height, fps, quality), ab = abIn || audioBitrate(quality);
    const ok = async (E, cfg) => { try { return !!(await E.isConfigSupported(cfg)).supported; } catch (e) { return false; } };
    const sortBy = (list, fam) => (fam ? list.filter(c => c.family === fam).concat(list.filter(c => c.family !== fam)) : list);
    for (const c of sortBy(videoCandidates(width, height, fps), prefer && prefer.video)) {
      if (!(await ok(VideoEncoder, videoConfig(c, width, height, fps, vb)))) continue;
      res.support[c.family] = true;
      if (C.video.includes(c.family)) res.video.push(c);
    }
    if (typeof AudioEncoder !== 'undefined') {
      for (const c of sortBy(audioCandidates(), prefer && prefer.audio)) {
        if (!(await ok(AudioEncoder, audioConfig(c, ab)))) continue;
        res.support[c.family] = true;
        if (C.audio.includes(c.family) && audio !== 'none') res.audio.push(c);
      }
    }
    const v = res.video[0], a = res.audio[0];
    if (v) {
      res.label = a ? `${v.name}＋${a.name}` : `${v.name}（${audio === 'none' ? '不含聲音' : '沒有聲音'}）`;
      const notes = [];
      // 指定的編碼不能用：說明改用了什麼
      const want = prefer || {};
      if (want.video && v.family !== want.video) notes.push(`此瀏覽器不支援 ${FAMILY_NAME[want.video]} 編碼，改用 ${v.name}`);
      if (want.audio && audio !== 'none' && a && a.family !== want.audio) notes.push(`此瀏覽器不支援 ${FAMILY_NAME[want.audio]} 編碼，改用 ${a.name}`);
      if (!a && audio !== 'none') notes.push(C.audio.some(x => res.support[x]) || container === 'mp4' ? '此瀏覽器不支援聲音編碼，匯出的影片不會有聲音' : `此瀏覽器沒有 ${C.name} 能用的聲音編碼（${C.audio.map(x => FAMILY_NAME[x]).join('／')}），匯出的影片不會有聲音`);
      else if (!want.video && !want.audio && container === 'mp4') {
        const miss = [];
        if (v.family !== 'h264') miss.push('H.264');
        if (a && a.family !== 'aac') miss.push('AAC');
        if (miss.length) notes.push(`此瀏覽器不支援 ${miss.join('／')} 編碼`);
      }
      res.note = notes.join('；');
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

  // 主流程。opts = { project, from, to（影格，半開區間）, quality, filename, onProgress(info), signal, prefer,
  //   width, height（輸出尺寸，預設＝專案；比例不同會被拉伸，對話框只給同比例的尺寸）,
  //   videoBitrate, audioBitrate（bps，預設依 quality）, audio: 'none'（不含聲音）, container: 'mp4'|'mov'|'webm', gopSec（關鍵格間隔秒數） }
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
    const fps = Math.round(p.fps) || 30, W = Math.round(opts.width || p.width), H = Math.round(opts.height || p.height);
    if (!(W > 0 && H > 0)) throw new Error('專案的輸出尺寸不正確');
    const CT = CONTAINERS[opts.container] || CONTAINERS.mp4;
    if (W % 2 || H % 2) throw new Error(`輸出尺寸 ${W}×${H} 需要是偶數`);
    const from = Math.max(0, Math.floor(opts.from || 0));
    const to = Math.floor(opts.to != null ? opts.to : (C && C.projectDuration ? C.projectDuration(p) : 0));
    const total = to - from;
    if (!(total > 0)) throw new Error('匯出範圍是空的：時間軸上沒有內容，或 In／Out 範圍不正確');
    const signal = opts.signal;
    const check = () => { if (signal && signal.aborted) throw new Cancelled(); };
    // opts.sink = { writable }：直接寫進使用者選的檔案（FileSystemWritableFileStream），不在記憶體組整個檔案
    const sink = opts.sink && opts.sink.writable ? opts.sink : null;
    let tmp = null;
    const quality = QUALITY[opts.quality] ? opts.quality : 'high';
    const report = info => { if (opts.onProgress) try { opts.onProgress(info); } catch (e) { /* 介面更新失敗不影響匯出 */ } };

    // 字型要先載入，不然第一格的字幕會用備用字型
    report({ phase: 'prepare', fraction: 0, text: '準備中…' });
    // 專案用到的字幕字型（大字型是用到才下載）都要等；網路慢時最多等 60 秒，再不行就用備用字型
    if (Q.fx && typeof Q.fx.ready === 'function') await withTimeout(Q.fx.ready(p), 60000);
    if (root.document && document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 8000);
    check();

    const vb = opts.videoBitrate > 0 ? Math.round(opts.videoBitrate) : videoBitrate(W, H, fps, quality);
    const ab = opts.audioBitrate > 0 ? Math.round(opts.audioBitrate) : audioBitrate(quality);
    const picked = opts.codecs || await pickCodecs({ width: W, height: H, fps, quality, prefer: opts.prefer, container: opts.container, audio: opts.audio, videoBitrate: vb, audioBitrate: ab });
    if (!picked.video.length) {
      throw new Error(CT === CONTAINERS.mp4 ? '這個瀏覽器沒有可用的影片編碼器（H.264／VP9／AV1 都不支援），請改用最新版 Chrome 或 Edge'
        : `這個瀏覽器沒有 ${CT.name} 能用的影片編碼器（需要 ${CT.video.map(x => FAMILY_NAME[x]).join('／')}），請改用其他封裝格式`);
    }
    check();

    const vts = fps * 1000, frameUs = 1e6 / fps;
    const audioLen = Math.round(total / fps * SAMPLE_RATE);
    const hasAudio = opts.audio !== 'none' && picked.audio.length > 0 && R && typeof R.renderAudio === 'function';
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
    if (sink) tmp = await openTemp();
    try {
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
          let d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
          const smp = { ts: Math.round(chunk.timestamp / frameUs) * 1000, dur: 1000, key: chunk.type === 'key' };
          if (tmp) {
            // AV1 的 temporal delimiter 先拿掉（封裝時大小要對）；第一個關鍵格留在記憶體（av1C 要讀它的序列標頭）
            if (cand.family === 'av1') d = mp4.stripTemporalDelimiters(d);
            if (cand.family === 'av1' && smp.key && !samples.some(x => x.data)) smp.data = d;
            else { smp.size = d.byteLength; smp.ref = tmp.append(d); }
          } else smp.data = d;
          samples.push(smp);
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
        const gop = Math.max(1, Math.round(fps * (opts.gopSec > 0 ? opts.gopSec : GOP_SEC)));
        for (let i = 0; i < total; i++) {
          check();
          if (err) throw fail(err);
          await drawFrame(ctx, p, from + i, W, H, check);
          const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
          try { enc.encode(vf, { keyFrame: i % gop === 0 }); } finally { vf.close(); }
          while (enc.encodeQueueSize > MAX_VQUEUE && !err) { await waitDequeue(enc); check(); }
          if (tmp && tmp.pending > TMP_PENDING_MAX) { await tmp.drain(); check(); }
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
    progress(sink ? 0.95 : 0.99, '封裝中…');
    const muxOpts = { video: videoTrack, audio: audioTrack, brand: CT === CONTAINERS.mov ? 'qt' : undefined };
    let parts;
    if (CT === CONTAINERS.webm) parts = webm.muxParts(muxOpts);
    else if (sink) { const h = mp4.muxHeader(muxOpts); parts = [h.header, ...h.samples.map(x => (x.data ? x.data : { length: x.size, ref: x.ref }))]; }
    else parts = mp4.muxParts(muxOpts);
    let blob = null, size = 0;
    if (sink) {
      const tmpFile = await tmp.finish();
      check();
      size = await writeParts(sink.writable, parts, tmpFile, check, f => progress(0.95 + 0.05 * f, '寫入檔案中…'));
      await sink.writable.close();
    } else { blob = new Blob(parts, { type: CT.mime }); size = blob.size; }
    const codecs = { video: videoUsed.name, audio: audioUsed ? audioUsed.name : null, container: CT.name,
      label: audioUsed ? `${videoUsed.name}＋${audioUsed.name}` : `${videoUsed.name}（${opts.audio === 'none' ? '不含聲音' : '沒有聲音'}）` };
    report({ phase: 'done', fraction: 1, elapsed: (performance.now() - t0) / 1000, text: '完成' });
    return { blob, size, savedToDisk: !!sink, filename: opts.filename || `剪輯.${CT.ext}`, codecs, frames: total, seconds: total / fps, width: W, height: H, videoBitrate: vb, audioBitrate: hasAudio ? ab : 0 };
    } finally { if (tmp) await tmp.remove(); }
  }

  // ---- 直接寫入硬碟（大檔案不佔記憶體）--------------------------------------------------
  // 編碼出來的影像樣本先接續寫進瀏覽器的私有暫存區（OPFS）的暫存檔，記憶體只留大小與位置；
  // 全部編完後算出檔頭（MP4 一樣把 moov 放前面），再依序把樣本從暫存檔搬到使用者選的檔案。
  const TMP_PENDING_MAX = 32 << 20;      // 還沒寫進暫存檔的資料超過 32MB 就等一下（背壓）
  const COPY_BLOCK = 8 << 20;            // 搬到目的檔時一次最多讀 8MB
  async function openTemp() {
    if (!(root.navigator && navigator.storage && typeof navigator.storage.getDirectory === 'function')) throw new Error('這個瀏覽器沒有暫存區（OPFS）');
    const dir = await navigator.storage.getDirectory();
    const name = `quickcut-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    let off = 0, pending = 0, chain = Promise.resolve(), err = null;
    return {
      get pending() { return pending; },
      append(d) {
        const ref = { off, size: d.byteLength };
        off += d.byteLength; pending += d.byteLength;
        chain = chain.then(() => w.write(d)).then(() => { pending -= d.byteLength; }, e => { err = err || e; });
        return ref;
      },
      async drain() { await chain; if (err) throw err; },
      async finish() { await chain; if (err) throw err; await w.close(); return fh.getFile(); },
      async remove() { try { await chain; } catch (e) { /* 無妨 */ } try { await w.abort(); } catch (e) { /* 已關閉 */ } try { await dir.removeEntry(name); } catch (e) { /* 無妨 */ } },
    };
  }
  // 依序寫出片段：Uint8Array 直接寫；{ length, ref } 從暫存檔讀（相鄰的合併成一次讀）
  async function writeParts(writable, parts, tmpFile, check, onFrac) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    let done = 0;
    for (let i = 0; i < parts.length;) {
      check();
      const p = parts[i];
      if (p instanceof Uint8Array) { await writable.write(p); done += p.length; i++; }
      else {
        const start = p.ref.off;
        let end = start + p.length, j = i + 1;
        while (j < parts.length && !(parts[j] instanceof Uint8Array) && parts[j].ref.off === end && end - start < COPY_BLOCK) { end += parts[j].length; j++; }
        await writable.write(new Uint8Array(await tmpFile.slice(start, end).arrayBuffer()));
        done += end - start; i = j;
      }
      onFrac(done / total);
    }
    return total;
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
  // 全畫面的匯出面板：左邊「快速匯出」（社群平台的建議設定），右邊各項設定，下方是摘要、進度與按鈕。
  // 平台建議值的來源見 DESIGN.md 第 5 節；選了平台後再改任何一項就變回「自訂」。
  const STYLE = `
.ed-ex-dialog { border: none; border-radius: 0; padding: 0; margin: 0; width: 100vw; height: 100vh; max-width: none; max-height: none;
  background: var(--bg); color: var(--text); font-family: var(--ui-font); }
.ed-ex-dialog::backdrop { background: rgba(10, 14, 22, .55); }
.ed-ex { height: 100%; margin: 0; display: grid; grid-template-rows: auto 1fr auto; }
.ed-ex-head { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--card-bg); }
.ed-ex-title { margin: 0; font-size: 18px; }
.ed-ex-head .ed-ex-x { margin-left: auto; width: 36px; height: 36px; padding: 0; border-radius: 50%; font-size: 16px; line-height: 1; }
.ed-ex-main { min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 24px; padding: 20px 24px; align-content: start; }
.ed-ex-col > h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 700; letter-spacing: .02em; }
.ed-ex-presets { display: grid; gap: 8px; }
.ed-ex-preset { text-align: left; display: grid; gap: 2px; padding: 10px 14px; border-radius: 14px; border: 1px solid var(--border);
  background: var(--card-bg); color: var(--text); cursor: pointer; font: inherit; }
.ed-ex-preset:hover:not(:disabled) { border-color: var(--accent); }
.ed-ex-preset.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); background: var(--accent-soft); }
.ed-ex-preset b { font-size: 14px; }
.ed-ex-preset span { font-size: 12px; color: var(--muted); }
.ed-ex-src { font-size: 11.5px; color: var(--muted); margin: 10px 2px 0; line-height: 1.5; }
.ed-ex-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px 20px; }
.ed-ex-field > .ed-ex-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.ed-ex-field.wide { grid-column: 1 / -1; }
.ed-ex-field select, .ed-ex-field input[type=number], .ed-ex-name input { width: 100%; font: inherit; font-size: 14px; padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--field-bg); color: var(--text); }
.ed-ex-field select:focus, .ed-ex-field input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ed-ex-field option:disabled { color: var(--muted); }
.ed-ex-name { display: flex; align-items: center; gap: 6px; }
.ed-ex-name input { flex: 1; min-width: 0; }
.ed-ex-name span { color: var(--muted); font-size: 14px; }
.ed-ex-check { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; min-height: 24px; }
.ed-ex-check input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.ed-ex-mbps { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.ed-ex-mbps input { max-width: 120px; }
.ed-ex-seg { margin-bottom: 0; display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 999px; background: var(--ed-tint, rgba(0, 74, 173, .07)); }
.ed-ex-seg button { border: none; background: transparent; color: var(--muted); border-radius: 999px; padding: 7px 16px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.ed-ex-seg button:hover:not(:disabled):not(.active) { color: var(--text); }
.ed-ex-seg button.active { background: var(--ed-tab-on-bg, var(--field-bg)); color: var(--ed-tab-on-fg, var(--accent)); box-shadow: 0 0 0 1px var(--ed-tab-on-ring, transparent), 0 4px 12px -6px rgba(0, 0, 0, .45); }
.ed-ex-seg button:disabled { opacity: .45; cursor: not-allowed; }
.ed-ex-hint { font-size: 12px; color: var(--muted); margin-top: 6px; min-height: 1em; line-height: 1.5; }
.ed-ex-advice { grid-column: 1 / -1; font-size: 13px; line-height: 1.6; padding: 10px 14px; border-radius: 12px; background: var(--ed-warn-bg, #fff5dd); color: var(--ed-warn-fg, #8a5a00); }
.ed-ex-advice button { margin-left: 8px; padding: 3px 12px; font-size: 12px; }
.ed-ex-foot { border-top: 1px solid var(--border); background: var(--card-bg); padding: 14px 24px; display: grid; gap: 10px; }
.ed-ex-info { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
.ed-ex-info dt { color: var(--muted); }
.ed-ex-info dd { margin: 0; font-weight: 600; }
.ed-ex-info .ed-ex-note { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.ed-ex-progress { display: grid; gap: 6px; }
.ed-ex-progress progress { width: 100%; height: 8px; appearance: none; border: none; border-radius: 99px; overflow: hidden; background: var(--accent-soft); }
.ed-ex-progress progress::-webkit-progress-bar { background: var(--accent-soft); border-radius: 99px; }
.ed-ex-progress progress::-webkit-progress-value { background: var(--accent); border-radius: 99px; transition: width .2s; }
.ed-ex-progress progress::-moz-progress-bar { background: var(--accent); }
.ed-ex-stat { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ed-ex-bottom { display: flex; align-items: center; gap: 12px; }
.ed-ex-msg { flex: 1; font-size: 13px; min-height: 1.2em; }
.ed-ex-msg.is-error { color: var(--ed-err-fg, #c0262d); }
.ed-ex-msg.is-ok { color: var(--success); }
.ed-ex-actions { display: flex; gap: 8px; }
.ed-ex-actions button { padding: 10px 22px; }
@media (max-width: 900px) { .ed-ex-main { grid-template-columns: 1fr; } .ed-ex-info { grid-template-columns: auto 1fr; } }
@media (prefers-reduced-motion: reduce) { .ed-ex-progress progress::-webkit-progress-value { transition: none; } }
`;

  // 社群平台的建議設定。size＝短邊（保持專案比例）；mbps 依 fps；aspect＝平台建議的畫面比例（和專案不同時提示）
  const PRESETS = [
    { id: 'yt1080', name: 'YouTube', sub: '1080p 橫式（16:9）', aspect: '16:9', size: 1080, mbps: fps => (fps > 30 ? 12 : 8), akbps: 384, gop: 'half' },
    { id: 'yt4k', name: 'YouTube 4K', sub: '2160p 橫式（16:9）', aspect: '16:9', size: 2160, mbps: fps => (fps > 30 ? 60 : 40), akbps: 384, gop: 'half' },
    { id: 'shorts', name: 'YouTube Shorts', sub: '1080×1920 直式（9:16）', aspect: '9:16', size: 1080, mbps: fps => (fps > 30 ? 12 : 8), akbps: 384, gop: 'half' },
    { id: 'igreels', name: 'Instagram Reels', sub: '1080×1920 直式（9:16）', aspect: '9:16', size: 1080, mbps: () => 5, akbps: 192, maxFps: 30 },
    { id: 'igpost', name: 'Instagram 貼文', sub: '1080×1350（4:5）', aspect: '4:5', size: 1080, mbps: () => 5, akbps: 192, maxFps: 30 },
    { id: 'fb', name: 'Facebook 影片', sub: '1080p 橫式（16:9）', aspect: '16:9', size: 1080, mbps: () => 8, akbps: 192 },
    { id: 'fbreels', name: 'Facebook Reels', sub: '1080×1920 直式（9:16）', aspect: '9:16', size: 1080, mbps: () => 8, akbps: 192 },
  ];
  const ASPECT_RATIO = { '16:9': 16 / 9, '9:16': 9 / 16, '4:5': 4 / 5 };
  const SIZES = [2160, 1440, 1080, 720, 480];
  const AUDIO_KBPS = [128, 192, 256, 320, 384];
  const DEFAULTS = { preset: 'custom', size: 'project', quality: 'high', mbps: 8, video: 'auto', audio: 'auto', akbps: 'auto', container: 'mp4', gop: null, toDisk: true };
  // 能不能「直接寫入硬碟」：要有存檔視窗（showSaveFilePicker）和暫存區（OPFS）；Chrome／Edge 有，Firefox／Safari 沒有
  const canDisk = () => typeof root.showSaveFilePicker === 'function' && !!(root.navigator && navigator.storage && navigator.storage.getDirectory);
  const SETTINGS_KEY = 'qc-export';

  const ui = { built: false, busy: false, ctrl: null, range: 'all', name: '', project: null, pickToken: 0, set: Object.assign({}, DEFAULTS) };
  Object.defineProperty(ui, 'quality', { get: () => ui.set.quality, set: v => { ui.set.quality = v; } });
  const pad2 = n => String(n).padStart(2, '0');
  const stampNow = () => { const d = new Date(); return `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
  const safeBase = name => (String(name || '').replace(/\.(mp4|mov|webm)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 80));
  const fmtTime = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m} 分 ${pad2(s % 60)} 秒` : `${s} 秒`; };
  const fmtDur = s => (s < 60 ? `${+s.toFixed(1)} 秒` : fmtTime(s));
  const fmtTc = (f, fps) => { const s = Math.floor(f / fps); return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(f % fps)}`; };
  const fmtSize = b => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const fmtRate = b => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : `${Math.round(b / 1e3)} kbps`);
  const even = n => Math.max(2, Math.round(n / 2) * 2);

  function loadSettings() {
    try { const o = JSON.parse(root.localStorage.getItem(SETTINGS_KEY)); if (o && typeof o === 'object') for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) ui.set[k] = o[k]; } catch (e) { /* 讀不到就用預設 */ }
    if (!CONTAINERS[ui.set.container]) ui.set.container = 'mp4';
    if (!QUALITY[ui.set.quality] && ui.set.quality !== 'custom') ui.set.quality = 'high';
  }
  function saveSettings() { try { root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(ui.set)); } catch (e) { /* 不能存就算了 */ } }

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
  // 輸出尺寸：size＝'project' 用專案尺寸，否則是短邊（保持專案比例，偶數化）
  function outSize(p, size) {
    if (size === 'project' || !(size > 0)) return { w: p.width, h: p.height };
    if (p.width <= p.height) return { w: even(size), h: even(size * p.height / p.width) };
    return { w: even(size * p.width / p.height), h: even(size) };
  }
  // 目前設定換算成 run() 的參數
  function plan(p) {
    const fps = Math.round(p.fps) || 30, S = ui.set, { w, h } = outSize(p, S.size);
    const vb = S.quality === 'custom' ? Math.round(Math.max(0.2, Math.min(200, +S.mbps || 8)) * 1e6) : videoBitrate(w, h, fps, S.quality);
    const ab = S.audio === 'none' ? 0 : (S.akbps === 'auto' ? audioBitrate(S.quality === 'custom' ? 'high' : S.quality) : +S.akbps * 1000);
    const prefer = {};
    if (S.video !== 'auto') prefer.video = S.video;
    if (S.audio !== 'auto' && S.audio !== 'none') prefer.audio = S.audio;
    return { fps, w, h, vb, ab, prefer: (prefer.video || prefer.audio) ? prefer : undefined, container: S.container, audio: S.audio === 'none' ? 'none' : undefined,
      gopSec: S.gop === 'half' ? 0.5 : undefined, ext: CONTAINERS[S.container].ext };
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
    const opt = (v, t) => `<option value="${v}">${t}</option>`;
    dlg.innerHTML = `
<form class="ed-ex" method="dialog" novalidate>
  <header class="ed-ex-head">
    <h2 class="ed-ex-title" id="edExTitle">匯出影片</h2>
    <button type="button" class="ed-ex-x" id="edExX" aria-label="關閉" title="關閉（Esc）">✕</button>
  </header>
  <div class="ed-ex-main">
    <section class="ed-ex-col" aria-labelledby="edExPresetsLabel">
      <h3 id="edExPresetsLabel">快速匯出</h3>
      <div class="ed-ex-presets" id="edExPresets">
        <button type="button" class="ed-ex-preset" data-preset="custom"><b>自訂</b><span>自己選畫質、尺寸與格式</span></button>
        ${PRESETS.map(x => `<button type="button" class="ed-ex-preset" data-preset="${x.id}"><b>${x.name}</b><span>${x.sub}．H.264＋AAC．MP4</span></button>`).join('')}
      </div>
      <p class="ed-ex-src">平台建議值依 YouTube 官方上傳建議與 Meta／Instagram 常見規格整理；平台收到後都會再壓縮一次。比例和專案不同時會提醒你。</p>
    </section>
    <section class="ed-ex-col" aria-labelledby="edExSetLabel">
      <h3 id="edExSetLabel">設定</h3>
      <div class="ed-ex-grid">
        <div class="ed-ex-advice" id="edExAdvice" hidden></div>
        <div class="ed-ex-field wide">
          <label class="ed-ex-label" for="edExName">檔名</label>
          <div class="ed-ex-name"><input id="edExName" type="text" autocomplete="off" spellcheck="false" maxlength="80"><span id="edExExt">.mp4</span></div>
        </div>
        <div class="ed-ex-field">
          <span class="ed-ex-label" id="edExRangeLabel">範圍</span>
          <div class="bg-toggle ed-ex-seg" id="edExRange" role="group" aria-labelledby="edExRangeLabel">
            <button type="button" data-v="all">整段</button><button type="button" data-v="io">In～Out</button>
          </div>
          <div class="ed-ex-hint" id="edExRangeHint"></div>
        </div>
        <div class="ed-ex-field">
          <label class="ed-ex-label" for="edExSizeSel">尺寸</label>
          <select id="edExSizeSel"></select>
          <div class="ed-ex-hint" id="edExSizeHint"></div>
        </div>
        <div class="ed-ex-field">
          <span class="ed-ex-label" id="edExQualityLabel">畫質</span>
          <div class="bg-toggle ed-ex-seg" id="edExQuality" role="group" aria-labelledby="edExQualityLabel">
            <button type="button" data-v="high">高</button><button type="button" data-v="medium">中</button><button type="button" data-v="small">小</button><button type="button" data-v="custom">自訂</button>
          </div>
          <div class="ed-ex-mbps" id="edExMbpsRow" hidden><input id="edExMbps" type="number" min="0.2" max="200" step="0.5" aria-label="影像位元率（Mbps）"><span>Mbps</span></div>
          <div class="ed-ex-hint" id="edExQualityHint"></div>
        </div>
        <div class="ed-ex-field">
          <label class="ed-ex-label" for="edExContainer">封裝格式</label>
          <select id="edExContainer">${opt('mp4', 'MP4（最通用）')}${opt('mov', 'MOV（QuickTime／Apple）')}${opt('webm', 'WebM（網頁用）')}</select>
          <div class="ed-ex-hint" id="edExContainerHint"></div>
        </div>
        <div class="ed-ex-field">
          <label class="ed-ex-label" for="edExVideo">影像編碼</label>
          <select id="edExVideo">${opt('auto', '自動（建議）')}${opt('h264', 'H.264（相容性最好）')}${opt('vp9', 'VP9')}${opt('av1', 'AV1（檔案最小、較新）')}</select>
          <div class="ed-ex-hint" id="edExVideoHint"></div>
        </div>
        <div class="ed-ex-field">
          <label class="ed-ex-label" for="edExAudio">聲音</label>
          <select id="edExAudio">${opt('auto', '自動（建議）')}${opt('aac', 'AAC')}${opt('opus', 'Opus')}${opt('none', '不含聲音')}</select>
          <div class="ed-ex-hint" id="edExAudioHint"></div>
        </div>
        <div class="ed-ex-field">
          <label class="ed-ex-label" for="edExAkbps">聲音位元率</label>
          <select id="edExAkbps">${opt('auto', '依畫質')}${AUDIO_KBPS.map(k => opt(k, `${k} kbps`)).join('')}</select>
        </div>
        <div class="ed-ex-field wide" id="edExDiskRow">
          <label class="ed-ex-check"><input type="checkbox" id="edExDisk"> 直接寫入硬碟（先選存檔位置，邊編碼邊寫入，不佔記憶體；長片、4K 建議開啟）</label>
          <div class="ed-ex-hint" id="edExDiskHint"></div>
        </div>
      </div>
    </section>
  </div>
  <footer class="ed-ex-foot">
    <dl class="ed-ex-info">
      <dt>輸出</dt><dd id="edExSize"></dd>
      <dt>編碼</dt><dd id="edExCodec"></dd>
      <dt>位元率</dt><dd id="edExRate"></dd>
      <dt>預估大小</dt><dd id="edExEst"></dd>
    </dl>
    <div class="ed-ex-progress" id="edExProgress" hidden>
      <progress id="edExBar" max="1" value="0"></progress>
      <div class="ed-ex-stat"><span id="edExStatus"></span><span id="edExEta"></span></div>
    </div>
    <div class="ed-ex-bottom">
      <div class="ed-ex-msg" id="edExMsg" role="status" aria-live="polite"></div>
      <div class="ed-ex-actions">
        <button type="button" id="edExClose">關閉</button>
        <button type="button" class="primary" id="edExGo">匯出</button>
      </div>
    </div>
  </footer>
</form>`;
    // 改了任何一項（不是點平台）就變回「自訂」
    const touch = () => { ui.set.preset = 'custom'; ui.set.gop = null; saveSettings(); refresh(); };
    $('edExRange').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled || ui.busy) return; ui.range = b.dataset.v; refresh(); });
    $('edExQuality').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled || ui.busy) return;
      // 切到「自訂」時，先帶入目前畫質換算出來的位元率
      const p = currentProject();
      if (b.dataset.v === 'custom' && ui.set.quality !== 'custom' && p) ui.set.mbps = +(plan(p).vb / 1e6).toFixed(1);
      ui.set.quality = b.dataset.v;
      touch();
    });
    $('edExMbps').addEventListener('change', () => { const v = +$('edExMbps').value; if (v > 0) ui.set.mbps = Math.max(0.2, Math.min(200, v)); touch(); });
    $('edExSizeSel').addEventListener('change', e => { const v = e.target.value; ui.set.size = v === 'project' ? 'project' : +v; touch(); });
    $('edExContainer').addEventListener('change', e => {
      ui.set.container = e.target.value;
      const C = CONTAINERS[ui.set.container];
      if (ui.set.video !== 'auto' && !C.video.includes(ui.set.video)) ui.set.video = 'auto';
      if (ui.set.audio !== 'auto' && ui.set.audio !== 'none' && !C.audio.includes(ui.set.audio)) ui.set.audio = 'auto';
      touch();
    });
    $('edExVideo').addEventListener('change', e => { ui.set.video = e.target.value; touch(); });
    $('edExAudio').addEventListener('change', e => { ui.set.audio = e.target.value; touch(); });
    $('edExAkbps').addEventListener('change', e => { ui.set.akbps = e.target.value === 'auto' ? 'auto' : +e.target.value; touch(); });
    $('edExDisk').addEventListener('change', e => { ui.set.toDisk = e.target.checked; saveSettings(); refresh(); });   // 存檔方式不算改「平台設定」
    $('edExPresets').addEventListener('click', e => { const b = e.target.closest('[data-preset]'); if (b && !ui.busy) applyPreset(b.dataset.preset); });
    $('edExName').addEventListener('input', () => { ui.name = $('edExName').value; });
    $('edExName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); start(); } });
    $('edExGo').addEventListener('click', start);
    $('edExClose').addEventListener('click', () => { if (ui.busy) { if (ui.ctrl) ui.ctrl.abort(); } else dlg.close(); });
    $('edExX').addEventListener('click', () => { if (!ui.busy) dlg.close(); });
    dlg.addEventListener('cancel', e => { if (ui.busy) e.preventDefault(); });     // 匯出中按 Esc 不關
    ui.built = true;
  }

  // 套用平台建議：H.264＋AAC＋MP4、指定尺寸與位元率（瀏覽器沒有 H.264／AAC 時會自動改用別的，並在編碼欄說明）
  function applyPreset(id) {
    const x = PRESETS.find(q => q.id === id);
    if (!x) { ui.set.preset = 'custom'; ui.set.gop = null; saveSettings(); refresh(); return; }
    const p = currentProject(), fps = p ? Math.round(p.fps) || 30 : 30;
    Object.assign(ui.set, { preset: id, size: x.size, quality: 'custom', mbps: x.mbps(fps), video: 'h264', audio: 'aac', akbps: x.akbps, container: 'mp4', gop: x.gop || null });
    saveSettings();
    refresh();
  }
  // 平台建議比例和專案不同：提示，並提供一鍵改專案的輸出比例（只有匯出的是目前的剪輯專案時）
  function adviceFor(p, fps) {
    const x = PRESETS.find(q => q.id === ui.set.preset);
    if (!x) return null;
    const tips = [];
    let fix = null;
    const want = ASPECT_RATIO[x.aspect], have = p.width / p.height;
    if (want && Math.abs(have - want) / want > 0.01) {
      tips.push(`${x.name} 建議 ${x.aspect}，目前專案是 ${p.width}×${p.height}，匯出後平台可能會加黑邊或裁切。`);
      if (!ui.project && $('edAspect')) fix = x.aspect;
    }
    if (x.maxFps && fps > x.maxFps) tips.push(`${x.name} 建議 ${x.maxFps} fps 以下，目前專案是 ${fps} fps（影格率依專案設定）。`);
    return tips.length ? { text: tips.join(' '), fix } : null;
  }
  function applyAspect(a) {
    const sel = $('edAspect');
    if (!sel || ui.busy) return;
    sel.value = a;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
  }

  function setMsg(text, kind) {
    const m = $('edExMsg');
    m.textContent = text || '';
    m.classList.toggle('is-error', kind === 'error');
    m.classList.toggle('is-ok', kind === 'ok');
  }

  // 依目前專案與選項更新面板（不含進度）
  function refresh() {
    const p = currentProject(), S = ui.set;
    const go = $('edExGo');
    const hasIO = !!p && (p.inPoint != null || p.outPoint != null);
    if (!hasIO && ui.range === 'io') ui.range = 'all';
    for (const b of $('edExRange').children) { b.classList.toggle('active', b.dataset.v === ui.range); b.disabled = ui.busy || (b.dataset.v === 'io' && !hasIO); }
    for (const b of $('edExQuality').children) { b.classList.toggle('active', b.dataset.v === S.quality); b.disabled = ui.busy; }
    for (const b of $('edExPresets').children) { b.classList.toggle('active', b.dataset.preset === S.preset); b.disabled = ui.busy; b.setAttribute('aria-pressed', String(b.dataset.preset === S.preset)); }
    for (const id of ['edExName', 'edExSizeSel', 'edExContainer', 'edExVideo', 'edExAudio', 'edExAkbps', 'edExMbps', 'edExDisk']) $(id).disabled = ui.busy;
    $('edExDiskRow').hidden = !canDisk();
    $('edExDisk').checked = ui.set.toDisk !== false;
    $('edExDiskHint').textContent = ui.set.toDisk !== false ? '按「匯出」會先問要存在哪裡' : '匯出完成後從瀏覽器下載（整個檔案會先放在記憶體）';
    $('edExMbpsRow').hidden = S.quality !== 'custom';
    if (doc().activeElement !== $('edExMbps')) $('edExMbps').value = S.mbps;
    $('edExContainer').value = S.container; $('edExVideo').value = S.video; $('edExAudio').value = S.audio; $('edExAkbps').value = String(S.akbps);
    $('edExAkbps').disabled = ui.busy || S.audio === 'none';
    $('edExExt').textContent = `.${CONTAINERS[S.container].ext}`;
    go.disabled = ui.busy;
    $('edExClose').textContent = ui.busy ? '取消匯出' : '關閉';
    $('edExX').disabled = ui.busy;
    if (!p) {
      for (const id of ['edExSize', 'edExCodec', 'edExRate', 'edExEst']) $(id).textContent = '—';
      $('edExRangeHint').textContent = ''; $('edExQualityHint').textContent = ''; $('edExSizeHint').textContent = '';
      $('edExAdvice').hidden = true;
      go.disabled = true;
      if (!ui.busy) setMsg('還沒有專案可以匯出', 'error');
      return;
    }
    // 尺寸選單：依專案比例算出每個選項的實際寬高
    const sizeSel = $('edExSizeSel');
    sizeSel.textContent = '';
    const addSize = (v, t) => { const o = document.createElement('option'); o.value = String(v); o.textContent = t; sizeSel.appendChild(o); };
    addSize('project', `依專案（${p.width}×${p.height}）`);
    for (const s of SIZES) { const d = outSize(p, s); addSize(s, `${s}p（${d.w}×${d.h}）`); }
    sizeSel.value = String(S.size);
    if (sizeSel.value !== String(S.size)) { S.size = 'project'; sizeSel.value = 'project'; }

    const P = plan(p), fps = P.fps;
    const r = rangeOf(p, ui.range), frames = r.to - r.from, secs = frames / fps;
    $('edExSize').textContent = S.size === 'project' ? `${P.w}×${P.h}．${fps} fps（依專案設定）` : `${P.w}×${P.h}．${fps} fps（從專案 ${p.width}×${p.height} ${P.w > p.width ? '放大' : P.w < p.width ? '縮小' : '輸出'}）`;
    $('edExSizeHint').textContent = P.w > p.width ? '比專案尺寸大：畫面會放大，細節不會變多' : '保持專案的畫面比例';
    $('edExRangeHint').textContent = frames > 0
      ? `${fmtTc(r.from, fps)} ～ ${fmtTc(r.to, fps)}，共 ${fmtDur(secs)}（${frames} 格）`
      : (ui.range === 'io' ? 'In／Out 範圍是空的' : '時間軸上還沒有內容');
    $('edExQualityHint').textContent = S.quality === 'custom' ? '直接指定影像位元率（越高越清楚、檔案越大）' : `影像約 ${fmtRate(P.vb)}（依尺寸與影格率自動計算）`;
    $('edExRate').textContent = `影像 ${fmtRate(P.vb)}${P.ab ? `．聲音 ${fmtRate(P.ab)}` : ''}${P.gopSec ? '．關鍵格每 0.5 秒' : ''}`;
    $('edExEst').textContent = frames > 0 ? `約 ${fmtSize((P.vb + P.ab) / 8 * secs)}（${fmtDur(secs)}）` : '—';
    $('edExContainerHint').textContent = { mp4: '幾乎所有平台與播放器都能用', mov: '剪輯軟體、Apple 裝置常用；只能放 H.264＋AAC', webm: '網頁播放用；只能放 VP9／AV1＋Opus' }[S.container];
    const adv = adviceFor(p, fps), box = $('edExAdvice');
    box.hidden = !adv;
    box.textContent = '';
    if (adv) {
      box.append(adv.text);
      if (adv.fix) { const b = document.createElement('button'); b.type = 'button'; b.id = 'edExFixAspect'; b.textContent = `專案改成 ${adv.fix}`; b.disabled = ui.busy; b.addEventListener('click', () => applyAspect(adv.fix)); box.append(b); }
    }
    if (frames <= 0) go.disabled = true;
    updateCodecLabel(p, P);
  }
  const doc = () => document;

  // 實際會用的編碼格式（非同步查詢；設定一樣就不重查）
  let codecKey = '', codecInfo = null;
  async function updateCodecLabel(p, P) {
    const el = $('edExCodec');
    const k = JSON.stringify([P.w, P.h, P.fps, P.vb, P.ab, P.container, P.prefer, P.audio]);
    if (k === codecKey && codecInfo) { paintCodec(el, codecInfo); return; }
    codecKey = k; codecInfo = null;
    const token = ++ui.pickToken;
    el.textContent = '偵測中…';
    let info;
    try { info = await pickCodecs({ width: P.w, height: P.h, fps: P.fps, prefer: P.prefer, container: P.container, audio: P.audio, videoBitrate: P.vb, audioBitrate: P.ab || 128000 }); } catch (e) { info = { video: [], audio: [], support: {} }; }
    if (token !== ui.pickToken) return;
    codecInfo = info;
    paintCodec(el, info);
  }
  function paintCodec(el, info) {
    el.textContent = '';
    const sup = info.support || {}, C = CONTAINERS[ui.set.container];
    // 選項狀態：這個瀏覽器不支援的、這個封裝格式放不下的都停用並寫原因
    const mark = (sel, fam, base, allowed) => {
      const o = $(sel).querySelector(`option[value="${fam}"]`);
      if (!o) return;
      const why = typeof VideoEncoder === 'undefined' ? '' : !sup[fam] ? '此瀏覽器不支援' : !allowed ? `${C.name} 不能放` : '';
      o.disabled = !!why;
      o.textContent = why ? `${base}（${why}）` : base;
    };
    mark('edExVideo', 'h264', 'H.264（相容性最好）', C.video.includes('h264'));
    mark('edExVideo', 'vp9', 'VP9', C.video.includes('vp9'));
    mark('edExVideo', 'av1', 'AV1（檔案最小、較新）', C.video.includes('av1'));
    mark('edExAudio', 'aac', 'AAC', C.audio.includes('aac'));
    mark('edExAudio', 'opus', 'Opus', C.audio.includes('opus'));
    for (const [k, base] of [['mov', 'MOV（QuickTime／Apple）'], ['webm', 'WebM（網頁用）']]) {
      const o = $('edExContainer').querySelector(`option[value="${k}"]`), D = CONTAINERS[k];
      const vOk = D.video.some(f => sup[f]);
      o.disabled = typeof VideoEncoder !== 'undefined' && !vOk;
      o.textContent = o.disabled ? `${base}（此瀏覽器沒有 ${D.video.map(f => FAMILY_NAME[f]).join('／')} 編碼）` : base;
    }
    $('edExVideoHint').textContent = ui.set.video === 'auto' ? `自動選這個格式能用的最佳編碼（${C.video.map(f => FAMILY_NAME[f]).join(' → ')}）` : '';
    $('edExAudioHint').textContent = ui.set.audio === 'none' ? '匯出的影片沒有聲音' : '';
    if (!info.video.length) {
      el.textContent = typeof VideoEncoder === 'undefined' ? '此瀏覽器不支援影片編碼' : `找不到 ${C.name} 能用的影片編碼器`;
      if (!ui.busy) { $('edExGo').disabled = true; setMsg(typeof VideoEncoder === 'undefined' ? '這個瀏覽器不能匯出影片，請改用最新版 Chrome 或 Edge' : `這個瀏覽器不能匯出 ${C.name}，請改用其他封裝格式`, 'error'); }
      return;
    }
    if (!ui.busy && /不能匯出/.test($('edExMsg').textContent)) setMsg('');
    el.append(`${info.label}．${C.name}`);
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
    const P = plan(p);
    const filename = `${base}.${P.ext}`;
    // 直接寫入硬碟：先選位置（要在按鈕的使用者動作裡呼叫）；按取消就不匯出
    let handle = null, writable = null;
    if (canDisk() && ui.set.toDisk !== false) {
      const CT = CONTAINERS[P.container];
      try { handle = await root.showSaveFilePicker({ suggestedName: filename, types: [{ description: `${CT.name} 影片`, accept: { [CT.mime]: [`.${CT.ext}`] } }] }); }
      catch (e) { if (e && e.name === 'AbortError') return; handle = null; }     // 其他錯誤（例如被瀏覽器擋）：改用下載
      if (handle) {
        try { writable = await handle.createWritable(); } catch (e) { setMsg(`無法寫入「${handle.name}」：${(e && e.message) || e}`, 'error'); return; }
      }
    }
    ui.busy = true;
    ui.ctrl = new AbortController();
    setMsg('');
    refresh();
    showProgress({ fraction: 0, text: '準備中…' });
    const t0 = performance.now();
    try {
      const res = await run({ project: p, from: r.from, to: r.to, quality: ui.set.quality === 'custom' ? 'high' : ui.set.quality, filename, signal: ui.ctrl.signal, onProgress: showProgress,
        width: P.w, height: P.h, videoBitrate: P.vb, audioBitrate: P.ab || undefined, prefer: P.prefer, container: P.container, audio: P.audio, gopSec: P.gopSec,
        sink: writable ? { writable } : null });
      if (res.blob) saveBlob(res.blob, filename);
      const savedName = handle ? handle.name : filename;
      api.lastExport = { filename: savedName, size: res.size, at: Date.now(), codecs: res.codecs, toDisk: !!handle };
      if (Q.core && Q.core.bus && typeof CustomEvent !== 'undefined') Q.core.bus.dispatchEvent(new CustomEvent('exported', { detail: api.lastExport }));
      setMsg(`${handle ? '已儲存' : '已匯出'}：${savedName}（${fmtSize(res.size)}，${res.width}×${res.height}，${res.codecs.label}，用時 ${fmtTime((performance.now() - t0) / 1000)}）`, 'ok');
    } catch (e) {
      // 寫到一半失敗或取消：丟掉寫了一半的內容；存檔視窗建立的空檔案也移除（瀏覽器支援時）
      if (writable) { try { await writable.abort(); } catch (x) { /* 已關閉 */ } }
      if (handle && typeof handle.remove === 'function') { try { await handle.remove(); } catch (x) { /* 無妨 */ } }
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
    if (!ui.built) { loadSettings(); build(dlg); }
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
    open, cancel, run, pickCodecs, mp4, webm,
    get busy() { return ui.busy; },
    lastExport: null,
    // 測試／除錯用
    _internal: { videoBitrate, audioBitrate, avcLevel, vp9Level, av1Level, videoCandidates, rangeOf, QUALITY, CONTAINERS, PRESETS, outSize, applyPreset, ui },
  };
  Q.exporter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
