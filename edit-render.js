// =====================================================================================
// 剪輯：媒體、播放、合成、音訊
//
//   media         匯入影片／音訊／圖片：讀長度、尺寸、fps，做縮圖條和波形；大檔用 objectURL，不讀成 base64。
//   compose       把某一格畫到 canvas。預覽和匯出共用同一支，所以「看到的就是匯出的」。
//   createPlayer  檢視器播放：<video> 元素池＋AudioContext 當主時鐘；J/K/L 變速、倒播、逐格。
//   renderAudio   匯出用的混音（OfflineAudioContext）。預覽的聲音也走同一套排程（scheduleClip），兩邊聽起來一樣。
//   seekSource    匯出逐格用：保證拿到的是那個時間的畫格。
//
// 時間換算一律用 QPTEdit.core.sourceTimeAt／sourceSpan，畫面一律用 QPTEdit.fx（變形、字幕、轉場），這裡不自己算。
// 其他模組可能比這支晚好：一律在用到時才讀 Q.core／Q.fx，不在載入時假設它們存在。
// =====================================================================================
(function (root) {
  const Q = root.QPTEdit = root.QPTEdit || {};
  const core = () => Q.core || {};
  const fx = () => Q.fx || {};

  const AUDIO_RATE = 48000;            // 解碼後的取樣率（混音、波形都用這個）
  const PEAKS_RATE = 100;              // 波形：每秒幾個峰值
  const THUMB_H = 72;                  // 縮圖條高度（px）
  const THUMB_EVERY = 2;               // 大約每幾秒一張縮圖
  const THUMB_MIN = 3, THUMB_MAX = 40;
  const IMAGE_MAX = 4096;              // 圖片長邊上限（輸出最大 3840，再大只是浪費記憶體）
  const AUDIO_DECODE_MAX = 1.8e9;      // 超過這個大小的檔案不解碼聲音（瀏覽器的 ArrayBuffer 會失敗）
  const SEEK_NUDGE = 0.002;            // 跳到某格時往後推 2ms：避開「時間剛好落在格子邊界、浮點誤差跳到上一格」
  const FADE_STEPS = 48;               // 淡入淡出曲線切幾段
  const STD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
  const PRELOAD_SEC = 1.5;             // 播放時提前準備幾秒內要出現的片段
  const AUDIO_AHEAD = 2;               // 預覽聲音提前排程幾秒
  const POOL_MAX = 8, EVICT_MS = 8000; // <video> 元素池

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const yieldUI = () => new Promise(r => setTimeout(r, 0));
  const userErr = msg => { const e = new Error(msg); e.userMessage = msg; return e; };
  const dbToGain = db => Math.pow(10, (+db || 0) / 20);
  const readPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

  // 參數一律經過 fx.getParam（第二階段會改讀關鍵影格）；fx 還沒好時直接讀靜態值
  function param(clip, path, fIn, dflt) {
    const F = fx();
    const v = typeof F.getParam === 'function' ? F.getParam(clip, path, fIn) : readPath(clip, path);
    return v == null ? dflt : v;
  }

  // 淡入淡出曲線：x 0~1 → 增益 0~1。c=0 線性；c>0 偏對數（一開始升得快）；c<0 偏指數（一開始升得慢）。
  // 淡出用同一條（x = 離結尾還剩的比例），所以曲線左右對稱。UI 畫曲線也用這支。
  function fadeShape(x, c) {
    x = clamp(+x || 0, 0, 1); c = clamp(+c || 0, -1, 1);
    if (Math.abs(c) < 1e-3) return x;
    const p = 1 + 3 * Math.abs(c);
    return c > 0 ? 1 - Math.pow(1 - x, p) : Math.pow(x, p);
  }

  // ---- 專案查詢（純資料存取；時間換算交給 core）----------------------------------------
  const tracksOf = (p, kind) => (p.tracks || []).filter(t => t.kind === kind);
  const projectDuration = p => {
    const C = core();
    if (typeof C.projectDuration === 'function') return C.projectDuration(p);
    return Object.values(p.clips || {}).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  };
  function clipAt(p, trackId, f) {
    const C = core();
    if (typeof C.clipAt === 'function') return C.clipAt(p, trackId, f);
    for (const c of Object.values(p.clips || {})) if (c.trackId === trackId && f >= c.start && f < c.start + c.duration) return c;
    return null;
  }
  function sourceTime(p, clip, f) {
    const C = core();
    if (typeof C.sourceTimeAt !== 'function') throw userErr('剪輯模組還沒載入完成（core.sourceTimeAt）');
    return C.sourceTimeAt(p, clip, f);
  }
  function sourceSpan(p, clip) {
    const C = core();
    if (typeof C.sourceSpan === 'function') return C.sourceSpan(p, clip);
    const s = clip.srcIn || 0;
    return { from: s, to: s + clip.duration / p.fps * (clip.speed || 1) };
  }

  // =====================================================================================
  // 媒體庫
  // =====================================================================================
  const reg = new Map();
  const removeHooks = new Set();       // 播放器用：素材被移除時釋放對應的 <video>
  let seq = 1, decodeCtx = null;

  const EXT = {
    video: /\.(mp4|m4v|mov|webm|mkv|ogv|3gp)$/i,
    audio: /\.(mp3|m4a|aac|wav|wave|ogg|oga|opus|flac|weba)$/i,
    image: /\.(jpe?g|png|gif|webp|bmp|avif)$/i,
    heic: /\.(heic|heif)$/i,
  };
  const SUPPORTED = '請使用影片（MP4、WebM、MOV）、音訊（MP3、M4A、WAV、OGG）或圖片（JPG、PNG、WebP）';

  function guessKind(file) {
    const t = (file.type || '').toLowerCase(), n = file.name || '';
    if (/hei[cf]/.test(t) || EXT.heic.test(n)) return 'heic';
    if (t.startsWith('image/') || (!t && EXT.image.test(n))) return /svg/.test(t) ? null : 'image';
    if (t.startsWith('audio/') || (!t && EXT.audio.test(n))) return 'audio';
    if (t.startsWith('video/') || (!t && EXT.video.test(n))) return 'video';
    if (EXT.audio.test(n)) return 'audio';
    if (EXT.video.test(n)) return 'video';
    if (EXT.image.test(n)) return 'image';
    return null;
  }

  function makeVideo(url) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = url;
    return v;
  }
  function releaseVideo(v) {
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* 已經釋放 */ }
  }

  // 等元素的事件；'error' 或逾時就失敗。ready(el) 為真時直接完成（事件可能早就發生過）
  function waitFor(el, type, ms, msg, ready) {
    if (ready && ready(el)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer = 0;
      const done = err => {
        clearTimeout(timer);
        el.removeEventListener(type, ok); el.removeEventListener('error', bad);
        err ? reject(err) : resolve();
      };
      const ok = () => done();
      const bad = () => done(userErr(msg));
      el.addEventListener(type, ok); el.addEventListener('error', bad);
      timer = setTimeout(() => done(userErr(msg)), ms);
    });
  }

  // 跳到某個時間，等 'seeked'（Chrome 在 seeked 時新的畫格已經可以畫）
  function seekEl(el, t, ms) {
    if (!el.seeking && Math.abs(el.currentTime - t) < 1e-6 && el.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(userErr('影片跳到指定時間逾時')), ms || 10000);
      function done(err) {
        clearTimeout(timer);
        el.removeEventListener('seeked', ok); el.removeEventListener('error', bad);
        err ? reject(err) : resolve();
      }
      const ok = () => done();
      const bad = () => done(userErr('影片讀取失敗'));
      el.addEventListener('seeked', ok); el.addEventListener('error', bad);
      el.currentTime = t;
    }).then(() => (el.readyState >= 2 ? null : waitFor(el, 'canplay', 5000, '影片畫格讀取逾時', x => x.readyState >= 2)));
  }

  // 影片的 fps：播幾格，看 requestVideoFrameCallback 的 mediaTime 間隔；失敗就當 30
  function fpsFromTimes(ts) {
    const d = [];
    for (let i = 1; i < ts.length; i++) { const x = ts[i] - ts[i - 1]; if (x > 0.001) d.push(x); }
    if (d.length < 3) return 30;
    const med = d.slice().sort((a, b) => a - b)[d.length >> 1];
    let frames = 0, span = 0;
    for (const x of d) { frames += Math.max(1, Math.round(x / med)); span += x; }   // 掉格的間隔算成好幾格
    const fps = frames / span;
    if (!isFinite(fps) || fps < 1 || fps > 240) return 30;
    // WebM 的時間戳只到毫秒，幾格之內分不出 29.97 和 30：差距在 0.15% 內就當整數
    if (Math.abs(fps - Math.round(fps)) / fps < 0.0015) return Math.round(fps);
    const near = STD_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
    return Math.abs(near - fps) / near < 0.02 ? near : Math.round(fps * 100) / 100;
  }
  function detectFps(v) {
    if (typeof v.requestVideoFrameCallback !== 'function') return Promise.resolve(30);
    return new Promise(resolve => {
      const ts = [];
      let done = false, id = 0;
      const finish = () => {
        if (done) return;
        done = true;
        try { v.cancelVideoFrameCallback(id); } catch (_) { /* 無妨 */ }
        v.removeEventListener('ended', finish);
        v.pause();
        resolve(fpsFromTimes(ts));
      };
      const cb = (_, md) => { ts.push(md.mediaTime); if (ts.length >= 16) finish(); else id = v.requestVideoFrameCallback(cb); };
      id = v.requestVideoFrameCallback(cb);
      v.addEventListener('ended', finish);
      setTimeout(finish, 1500);
      const pr = v.play();
      if (pr && pr.catch) pr.catch(finish);
    });
  }

  // MediaRecorder 錄的 WebM 常常沒寫長度（Infinity）：跳到很後面讓瀏覽器自己算出來
  async function fixDuration(v, name) {
    await new Promise(resolve => {
      const t = setTimeout(resolve, 8000);
      const ok = () => { if (isFinite(v.duration)) { clearTimeout(t); v.removeEventListener('durationchange', ok); resolve(); } };
      v.addEventListener('durationchange', ok);
      v.currentTime = 1e101;
    });
    if (!isFinite(v.duration) || !(v.duration > 0)) throw userErr(`「${name}」讀不到影片長度，檔案可能損毀`);
    await seekEl(v, 0).catch(() => {});
    return v.duration;
  }

  async function makeThumbs(v, m) {
    const n = m.duration < 1 ? 1 : clamp(Math.ceil(m.duration / THUMB_EVERY), THUMB_MIN, THUMB_MAX);
    const th = THUMB_H, tw = Math.max(1, Math.round(m.width / m.height * th));
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n * m.duration;
      try {
        await seekEl(v, t, 8000);
        out.push({ t, bitmap: await createImageBitmap(v, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' }) });
      } catch (_) { break; }      // 縮圖失敗不影響匯入
    }
    return out;
  }

  // 波形峰值：每 1/PEAKS_RATE 秒取所有聲道的最大絕對值。長檔分段算，每 12ms 讓出一次畫面
  async function computePeaks(buf) {
    const step = buf.sampleRate / PEAKS_RATE, n = Math.ceil(buf.length / step);
    const out = new Float32Array(n);
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    let t0 = now();
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step));
      let mx = 0;
      for (const ch of chans) for (let j = a; j < b; j++) { const x = ch[j] < 0 ? -ch[j] : ch[j]; if (x > mx) mx = x; }
      out[i] = mx;
      if ((i & 63) === 0 && now() - t0 > 12) { await yieldUI(); t0 = now(); }
    }
    return out;
  }

  function decodeAudioOf(m) {
    if (!m._audioP) m._audioP = (async () => {
      if (m.kind === 'image') return null;
      if (m.file.size > AUDIO_DECODE_MAX) { m.warning = '檔案太大，無法讀取聲音（約 1.8GB 以上）'; return null; }
      const data = await m.file.arrayBuffer();
      if (!decodeCtx) decodeCtx = new OfflineAudioContext(2, 1, AUDIO_RATE);
      try {
        m.audioBuffer = await decodeCtx.decodeAudioData(data);
        return m.audioBuffer;
      } catch (_) { return null; }       // 沒有音軌，或格式不支援
    })();
    return m._audioP;
  }

  async function loadImage(m) {
    let bmp = null;
    try { bmp = await createImageBitmap(m.file); } catch (_) {
      try {
        const img = new Image();
        img.src = m.url;
        await img.decode();
        bmp = await createImageBitmap(img);
      } catch (__) { bmp = null; }
    }
    if (!bmp) throw userErr(`「${m.name}」無法讀取：圖片可能損毀，或是瀏覽器不支援的格式（HEIC 請先轉成 JPG 或 PNG）`);
    m.width = bmp.width; m.height = bmp.height; m.duration = Infinity; m.fps = null;
    const long = Math.max(bmp.width, bmp.height);
    if (long > IMAGE_MAX) {
      const k = IMAGE_MAX / long;
      const r = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close(); bmp = r;
    }
    m.image = bmp;
    const tw = Math.max(1, Math.round(bmp.width / bmp.height * THUMB_H));
    m.thumbs = [{ t: 0, bitmap: await createImageBitmap(bmp, { resizeWidth: tw, resizeHeight: THUMB_H, resizeQuality: 'medium' }) }];
  }

  // 瀏覽器讀不到影像時，判斷檔案裡是不是「真的有影像軌」：
  //   WebM／Ogg：Chrome 支援這兩種容器裡所有常見的影像編碼（VP8／VP9／AV1／Theora），讀不到影像 = 本來就是純音訊。
  //   MP4／MOV／3GP：看檔頭與檔尾（moov 可能在最後）有沒有 handler 'vide' 的 hdlr box。
  //   其他（MKV 等）：無從判斷，保守當成有。
  async function hasUnplayableVideo(file) {
    const n = (file && file.name) || '', t = ((file && file.type) || '').toLowerCase();
    if (/\.(webm|weba|ogg|ogv|oga|opus)$/i.test(n) || /(webm|ogg)/.test(t)) return false;
    if (!/\.(mp4|m4v|mov|3gp)$/i.test(n) && !/(mp4|quicktime|3gpp)/.test(t)) return true;
    const SPAN = 4 << 20;
    const has = async (a, b) => {
      const u = new Uint8Array(await file.slice(a, b).arrayBuffer());
      for (let i = 0; i + 16 <= u.length; i++) {        // 'hdlr' + version/flags(4) + pre_defined(4) + 'vide'
        if (u[i] === 0x68 && u[i + 1] === 0x64 && u[i + 2] === 0x6c && u[i + 3] === 0x72 &&
            u[i + 12] === 0x76 && u[i + 13] === 0x69 && u[i + 14] === 0x64 && u[i + 15] === 0x65) return true;
      }
      return false;
    };
    try {
      if (await has(0, SPAN)) return true;
      return file.size > SPAN ? await has(Math.max(SPAN - 16, file.size - SPAN), file.size) : false;
    } catch (_) { return true; }
  }

  async function loadAV(m, guess) {
    const v = makeVideo(m.url);
    const badMsg = `「${m.name}」無法播放：可能是瀏覽器不支援的格式或編碼（例如 HEVC／H.265、ProRes、AVI），請先轉成 H.264 的 MP4`;
    try {
      await waitFor(v, 'loadedmetadata', 20000, badMsg, x => x.readyState >= 1);
      m.duration = isFinite(v.duration) ? v.duration : await fixDuration(v, m.name);
      if (v.videoWidth > 0 && guess !== 'audio') {
        m.kind = 'video';
        m.width = v.videoWidth; m.height = v.videoHeight;
        await waitFor(v, 'loadeddata', 15000, badMsg, x => x.readyState >= 2);
        m.fps = await detectFps(v);
        m.thumbs = await makeThumbs(v, m);
      } else {
        m.kind = 'audio';
        // 副檔名／MIME 像影片、卻只讀到聲音：真的有影像軌（只是編碼不支援）才警告；純音訊的 .webm（MediaRecorder 常見）不用
        if (guess === 'video' && await hasUnplayableVideo(m.file)) m.warning = '這個檔案只讀到聲音；它的影像編碼瀏覽器不支援（例如 HEVC／H.265），請先轉成 H.264 的 MP4';
      }
    } finally { releaseVideo(v); }
    const buf = await decodeAudioOf(m);
    if (m.kind === 'audio' && !buf) throw userErr(`「${m.name}」的聲音無法解碼，格式可能不支援`);
    m.hasAudio = !!buf;
    if (buf) m.peaks = await computePeaks(buf);
  }

  function freeMedia(m) {
    for (const t of m.thumbs || []) try { t.bitmap.close(); } catch (_) { /* 無妨 */ }
    if (m.image) try { m.image.close(); } catch (_) { /* 無妨 */ }
    m.thumbs = []; m.image = null; m.audioBuffer = null; m._audioP = null; m._rev = null; m.peaks = null;
  }

  // 指定 id 時（開啟專案後重新連結素材）沿用存檔裡的 id，時間軸上的片段才接得回來
  async function importOne(file, forcedId, handle) {
    const guess = guessKind(file);
    if (guess === 'heic') throw userErr(`「${file.name}」是 HEIC 格式，瀏覽器不支援，請先轉成 JPG 或 PNG`);
    if (!guess) throw userErr(`「${file.name}」不是支援的格式：${SUPPORTED}`);
    const m = {
      id: forcedId || 'm' + seq++, kind: guess, name: file.name, file, handle: handle || null, url: URL.createObjectURL(file),
      duration: 0, width: 0, height: 0, fps: null, hasAudio: false,
      audioBuffer: null, peaks: null, peaksRate: PEAKS_RATE, thumbs: [], image: null, warning: '',
    };
    try {
      if (guess === 'image') await loadImage(m); else await loadAV(m, guess);
    } catch (e) {
      URL.revokeObjectURL(m.url); freeMedia(m);
      throw e.userMessage ? e : userErr(`「${file.name}」匯入失敗：${e.message || e}`);
    }
    reg.set(m.id, m);
    return m;
  }

  const media = {
    // 依序匯入（一次一個，避免大檔同時佔記憶體）。回傳成功的 Media 陣列；失敗的放在陣列的 .errors（[{ name, message }]，繁中）
    // opts.ids[i]：第 i 個檔案要用的 id（重新連結用；已經有人用的 id 不會覆蓋）；opts.handles[i]：檔案的 FileSystemFileHandle（記住位置用）
    async import(files, opts) {
      const list = Array.from(files || []), ok = [], errors = [];
      const ids = (opts && opts.ids) || [], handles = (opts && opts.handles) || [];
      for (let i = 0; i < list.length; i++) {
        const id = ids[i] && !reg.has(ids[i]) ? ids[i] : null;
        try { ok.push(await importOne(list[i], id, handles[i])); } catch (e) { errors.push({ name: list[i].name, message: e.message }); }
        if (opts && typeof opts.onProgress === 'function') opts.onProgress(i + 1, list.length, list[i].name);
      }
      ok.errors = errors;
      return ok;
    },
    get: id => reg.get(id) || null,
    list: () => Array.from(reg.values()),
    // 開啟專案：存檔裡用過的 id（m12 這種）之後不能再發給新素材
    reserve(ids) {
      for (const id of ids || []) { const n = /^m(\d+)$/.exec(id); if (n && +n[1] >= seq) seq = +n[1] + 1; }
    },
    remove(id) {
      const m = reg.get(id);
      if (!m) return false;
      reg.delete(id);
      for (const [k, s] of seekers) if (k.startsWith(id + ':')) { releaseVideo(s.el); seekers.delete(k); }
      removeHooks.forEach(fn => fn(id));
      URL.revokeObjectURL(m.url);
      freeMedia(m);
      return true;
    },
    // 解碼後的聲音（快取）；沒有音軌回傳 null
    decodeAudio(id) {
      const m = reg.get(id);
      return m ? decodeAudioOf(m) : Promise.resolve(null);
    },
  };

  // =====================================================================================
  // 合成（預覽與匯出共用）
  // =====================================================================================

  // 轉場佔的時間軸範圍 [from, to)。center：跨在剪接點兩側；start：從剪接點開始；end：在剪接點結束。
  // 單邊轉場貼著片段邊緣：尾端淡出在左片段最後 duration 格、開頭淡入在右片段最前 duration 格。
  function transitionRange(p, tr) {
    const C = core();
    if (typeof C.transitionRange === 'function') return C.transitionRange(p, tr);
    const L = tr.leftClipId ? p.clips[tr.leftClipId] : null, R = tr.rightClipId ? p.clips[tr.rightClipId] : null;
    if (!L && !R) return null;
    const cut = L ? L.start + L.duration : R.start, d = Math.max(1, Math.round(tr.duration || 1));
    let from;
    if (!L) from = cut;
    else if (!R) from = cut - d;
    else from = tr.align === 'start' ? cut : tr.align === 'end' ? cut - d : cut - Math.floor(d / 2);
    return { from, to: from + d, cut };
  }

  function transitionAt(p, trackId, frame) {
    for (const tr of Object.values(p.transitions || {})) {
      if (tr.trackId !== trackId) continue;
      const r = transitionRange(p, tr);
      if (r && frame >= r.from && frame < r.to) return { tr, from: r.from, to: r.to };
    }
    return null;
  }

  // 這一格要畫的圖層，由下往上（V1 最下層）
  function layersAt(p, frame) {
    const out = [];
    for (const t of tracksOf(p, 'video')) {
      if (t.hidden) continue;
      const tn = transitionAt(p, t.id, frame);
      if (tn) {
        // 單邊轉場沒有的那一邊是 null：畫成空白（露出下層軌道或背景色），fx 依 leftClipId／rightClipId 是 null 判斷單邊
        const L = tn.tr.leftClipId ? p.clips[tn.tr.leftClipId] : null, R = tn.tr.rightClipId ? p.clips[tn.tr.rightClipId] : null;
        out.push({ kind: 'transition', tr: tn.tr, from: tn.from, to: tn.to,
          L: L && L.enabled !== false ? L : null, R: R && R.enabled !== false ? R : null });
        continue;
      }
      const c = clipAt(p, t.id, frame);
      if (c && c.enabled !== false) out.push({ kind: 'clip', clip: c });
    }
    return out;
  }

  // 片段在第 frame 格（可以超出片段範圍：轉場從把手取畫格）的來源秒數，夾在媒體範圍內
  function srcTimeFor(p, clip, frame) {
    const m = reg.get(clip.mediaId);
    const t = sourceTime(p, clip, frame);
    if (!m || !isFinite(m.duration)) return Math.max(0, t);
    return clamp(t, 0, m.duration);
  }
  // 實際要 seek 到的時間：往後推一點點避開格子邊界，並且不超過最後一格
  function seekTarget(m, t) {
    const last = Math.max(0, m.duration - 0.5 / (m.fps || 30));
    return clamp(t + SEEK_NUDGE, 0, last);
  }

  // 這一格需要哪些影像來源：[{ clip, mediaId, time }]（匯出先用 seekSource 準備好，再 compose）
  function sourcesAt(p, frame) {
    const out = [];
    const add = clip => {
      if (!clip || clip.type !== 'media' || !clip.mediaId) return;
      const m = reg.get(clip.mediaId);
      if (m && m.kind === 'audio') return;
      out.push({ clip, mediaId: clip.mediaId, time: srcTimeFor(p, clip, frame) });
    };
    for (const l of layersAt(p, frame)) {
      if (l.kind === 'clip') add(l.clip);
      else { add(l.L); add(l.R); }
    }
    return out;
  }

  function sourceSize(s) {
    if (!s) return [0, 0];
    if (s.videoWidth) return [s.videoWidth, s.videoHeight];
    if (s.displayWidth) return [s.displayWidth, s.displayHeight];
    if (s.naturalWidth) return [s.naturalWidth, s.naturalHeight];
    return [s.width || 0, s.height || 0];
  }

  // 畫一個片段（ctx 已經是專案座標 W×H）
  function drawClip(ctx, p, clip, frame, getSource) {
    const F = fx(), W = p.width, H = p.height;
    const fIn = clamp(frame - clip.start, 0, Math.max(0, clip.duration - 1));
    ctx.save();
    try {
      if (clip.type === 'title') {
        if (typeof F.drawTitle === 'function') F.drawTitle(ctx, clip, W, H, fIn, p.fps);
      } else if (clip.type === 'solid') {
        if (typeof F.drawSolid === 'function') F.drawSolid(ctx, clip, W, H, fIn, p.fps);
        else {
          ctx.globalAlpha *= param(clip, 'video.transform.opacity', fIn, 1);
          ctx.fillStyle = clip.solidColor || '#000000';
          ctx.fillRect(0, 0, W, H);
        }
      } else if (clip.mediaId) {
        const src = getSource(clip, srcTimeFor(p, clip, frame));
        if (!src) return;
        const [sw, sh] = sourceSize(src);
        if (!sw || !sh) return;
        if (typeof F.drawClipVisual === 'function') F.drawClipVisual(ctx, clip, src, sw, sh, W, H, fIn, p.fps);
        else {     // fx 還沒載入：照比例放進畫面
          const k = Math.min(W / sw, H / sh);
          ctx.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
        }
      }
    } finally { ctx.restore(); }
  }

  // 合成第 frame 格。ctx 的畫布可以比專案小（預覽縮小）：這裡統一縮放，fx 只要用專案座標畫。
  // getSource(clip, srcTime) → HTMLVideoElement | ImageBitmap | VideoFrame | HTMLImageElement | null
  function compose(ctx, p, frame, getSource) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height, W = p.width, H = p.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = p.bgColor || '#000000';
    ctx.fillRect(0, 0, cw, ch);
    if (cw !== W || ch !== H) ctx.scale(cw / W, ch / H);
    ctx.imageSmoothingQuality = 'high';
    const F = fx();
    // 電影黑邊：蓋在影像上、字幕下面——畫在「最下面一條有字幕片段的影片軌」之前（整個專案看，不是只看這一格，
    //   所以同一條軌上的畫中畫不會因為字幕出現／消失而忽上忽下）；沒有字幕就畫在最上面。
    const box = letterboxRectOf(p), bar = !!box;
    let barAt = Infinity, barDone = !bar;
    if (bar) {
      const vt = tracksOf(p, 'video'), withTitle = new Set();
      for (const c of Object.values(p.clips || {})) if (c.type === 'title') withTitle.add(c.trackId);
      const i = vt.findIndex(t => withTitle.has(t.id));
      if (i >= 0) barAt = i;
    }
    const trackIdx = new Map(tracksOf(p, 'video').map((t, i) => [t.id, i]));
    const drawBars = () => { barDone = true; drawLetterbox(ctx, W, H, box); };
    for (const l of layersAt(p, frame)) {
      if (!barDone && trackIdx.get(l.kind === 'clip' ? l.clip.trackId : l.tr.trackId) >= barAt) drawBars();
      if (l.kind === 'clip') { drawClip(ctx, p, l.clip, frame, getSource); continue; }
      const t = clamp((frame - l.from + 0.5) / (l.to - l.from), 0, 1);   // 線性；緩動由 fx 的轉場自己套（opts.ease）
      const drawA = c => { if (l.L) drawClip(c, p, l.L, frame, getSource); };
      const drawB = c => { if (l.R) drawClip(c, p, l.R, frame, getSource); };
      const def = F.TRANSITIONS && F.TRANSITIONS[l.tr.type];
      ctx.save();
      try {
        if (def && typeof def.draw === 'function') def.draw(ctx, drawA, drawB, t, l.tr, W, H);
        else {      // 不認得的轉場：交叉疊化
          drawA(ctx);
          ctx.globalAlpha = l.tr.ease === 'easeInOut' ? t * t * (3 - 2 * t) : t;
          drawB(ctx);
        }
      } finally { ctx.restore(); }
    }
    if (!barDone) drawBars();
    ctx.restore();
  }
  // 黑邊中間的畫面範圍（專案像素）；core 還沒載入時當作沒有
  function letterboxRectOf(p) {
    const C = core();
    return typeof C.letterboxRect === 'function' ? C.letterboxRect(p) : null;
  }
  // 中間畫面以外都塗黑：上下（letterbox）或左右（pillarbox，例如 16:9 裡的 Open Gate 3:2）
  function drawLetterbox(ctx, W, H, r) {
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = '#000000';
    if (r.y) { ctx.fillRect(0, 0, W, r.y); ctx.fillRect(0, r.y + r.h, W, H - r.y - r.h); }
    if (r.x) { ctx.fillRect(0, 0, r.x, H); ctx.fillRect(r.x + r.w, 0, W - r.x - r.w, H); }
    ctx.restore();
  }

  // =====================================================================================
  // 匯出逐格取畫格
  // =====================================================================================
  // 回傳那個時間的畫格：影片是 VideoFrame（快照，呼叫端用完要 close()），圖片是素材自己的 ImageBitmap（不要 close）。
  // 每個 (素材, slot) 一個 <video>；同一支素材同時要跳很多個時間（平行匯出）時可以用不同 slot 避免互相搶。
  // 瀏覽器沒有 VideoFrame 時退回 <video> 元素本身（到下一次對同一個 slot 呼叫前都停在那一格）。
  const seekers = new Map();
  function snapshot(el) {
    if (typeof VideoFrame !== 'function') return el;
    try { return new VideoFrame(el, { timestamp: Math.round(el.currentTime * 1e6) }); } catch (_) { return el; }
  }
  function seekSource(mediaId, time, opts) {
    const m = reg.get(mediaId);
    if (!m) return Promise.reject(userErr('找不到這個素材，可能已經從媒體庫移除'));
    if (m.kind === 'image') return Promise.resolve(m.image);
    if (m.kind !== 'video') return Promise.resolve(null);
    const key = mediaId + ':' + ((opts && opts.slot) | 0);
    let s = seekers.get(key);
    if (!s) {
      const el = makeVideo(m.url);
      s = { el, chain: waitFor(el, 'loadeddata', 20000, `「${m.name}」無法讀取`, x => x.readyState >= 2) };
      seekers.set(key, s);
    }
    const run = s.chain.then(() => seekEl(s.el, seekTarget(m, time))).then(() => snapshot(s.el));
    s.chain = run.catch(() => {});
    return run;
  }
  function releaseSeekers() {
    for (const s of seekers.values()) releaseVideo(s.el);
    seekers.clear();
  }

  // 匯出用的便利函式：準備好這一格所有來源，再合成
  async function renderFrame(ctx, p, frame) {
    const reqs = sourcesAt(p, frame), slots = new Map();
    // allSettled：其中一個來源讀取失敗時，其他已經拿到的 VideoFrame 也要關掉（用 Promise.all 會直接丟出去、漏關）
    const settled = await Promise.allSettled(reqs.map(r => {
      const slot = slots.get(r.mediaId) || 0;
      slots.set(r.mediaId, slot + 1);
      return seekSource(r.mediaId, r.time, { slot });
    }));
    const got = settled.map(x => (x.status === 'fulfilled' ? x.value : null));
    try {
      const bad = settled.find(x => x.status === 'rejected');
      if (bad) throw bad.reason;
      const byClip = new Map(reqs.map((r, i) => [r.clip.id, got[i]]));
      compose(ctx, p, frame, clip => byClip.get(clip.id) || null);
    } finally {
      for (const s of got) if (typeof VideoFrame === 'function' && s instanceof VideoFrame) s.close();
    }
  }

  // =====================================================================================
  // 音訊：預覽與匯出共用的排程
  // =====================================================================================
  function audibleClips(p) {
    const tr = tracksOf(p, 'audio');
    const solo = tr.some(t => t.solo);
    const ok = new Set(tr.filter(t => !t.muted && (!solo || t.solo)).map(t => t.id));
    return Object.values(p.clips || {}).filter(c => ok.has(c.trackId) && c.enabled !== false && c.type === 'media' && c.mediaId);
  }

  // 片段內第 x 格（可小數）的增益：基本增益 × 淡入 × 淡出
  function gainAt(clip, x) {
    const a = clip.audio || {}, d = clip.duration;
    const fi = Math.max(0, a.fadeIn || 0), fo = Math.max(0, a.fadeOut || 0);
    let k = dbToGain(param(clip, 'audio.gainDb', clamp(Math.floor(x), 0, d - 1), 0));
    if (fi > 0 && x < fi) k *= fadeShape(x / fi, a.fadeInCurve || 0);
    if (fo > 0 && x > d - fo) k *= fadeShape((d - x) / fo, a.fadeOutCurve || 0);
    return k;
  }

  // BiquadFilter：Web Audio 的 lowpass／highpass 的 Q 是 dB，規格的 q 是一般的 Q 值（0.707 = Butterworth），這裡換算
  function makeBiquad(ctx, band) {
    const f = ctx.createBiquadFilter();
    f.type = band.type;
    f.frequency.value = clamp(+band.freq || 1000, 10, ctx.sampleRate / 2 - 1);
    const q = Math.max(1e-4, +band.q || 0.707);
    f.Q.value = band.type === 'lowpass' || band.type === 'highpass' ? 20 * Math.log10(q) : q;
    f.gain.value = +band.gain || 0;
    return f;
  }

  function reversedOf(m, buf) {
    if (m && m._rev && m._revOf === buf) return m._rev;
    const r = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = new Float32Array(s.length);
      for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i];
      r.copyToChannel(d, c);
    }
    if (m) { m._rev = r; m._revOf = buf; }
    return r;
  }

  // 轉場時的聲音（交叉淡化、單邊淡入淡出）由 core 從影片轉場推出：{ [片段 id]: { from, to, fades } }。
  // 預覽與匯出都從這裡取，聽起來才會一樣。
  function audioPlan(p) {
    const C = core();
    return typeof C.audioTransitionPlan === 'function' ? C.audioTransitionPlan(p) : {};
  }
  function xfadeGain(fades, F) {
    const C = core();
    return fades && fades.length && typeof C.transitionFadeGain === 'function' ? C.transitionFadeGain(fades, F) : 1;
  }
  // 片段在 [winA, winB) 影格內的增益包絡：{ a, b, pts: [[影格, 增益]] }（點之間線性內插）；沒有要播的部分回傳 null。
  // a／b 是實際要播的範圍（轉場交叉淡化時會超出片段本身，用到來源把手）。
  // 增益 = 基本增益 × 片段自己的淡入淡出 × 轉場淡化（等功率），預覽與匯出共用這一支。
  function audioEnvelope(p, clip, winA, winB, plan) {
    const ext = (plan || audioPlan(p))[clip.id] || null;
    const s0 = ext ? ext.from : clip.start, s1 = ext ? ext.to : clip.start + clip.duration;
    const a = Math.max(s0, winA), b = Math.min(s1, winB);
    if (!(b > a) || clip.freeze) return null;
    const xs = new Set([a, b]);
    const au = clip.audio || {}, fi = au.fadeIn || 0, fo = au.fadeOut || 0, end = clip.start + clip.duration;
    const fades = ext ? ext.fades : [];
    for (let i = 0; i <= FADE_STEPS; i++) {
      if (fi > 0) xs.add(clip.start + fi * i / FADE_STEPS);
      if (fo > 0) xs.add(end - fo + fo * i / FADE_STEPS);
      for (const f of fades) xs.add(f.from + (f.to - f.from) * i / FADE_STEPS);
    }
    // 片段邊界前後：片段自己的淡入淡出在邊界外是 0（例如有手動淡出又被延長去交叉淡化時），要在邊界放點才不會被內插抹掉
    for (const F of [clip.start, end]) if (F > a && F < b) { xs.add(F); xs.add(F - 1e-3); }
    const pts = Array.from(xs).filter(F => F >= a && F <= b).sort((x, y) => x - y)
      .map(F => [F, gainAt(clip, F - clip.start) * xfadeGain(fades, F)]);
    return { a, b, pts };
  }

  // 在 ctx（AudioContext 或 OfflineAudioContext）排一個音訊片段，只排 [winA, winB) 影格內的部分。
  // map：時間軸第 F 格 = ctx 時間 t0 + (F − F0) / (fps × rate)。plan：audioPlan(p)（呼叫端算一次重複用）。
  // 鏈：BufferSource(速度) → Gain(增益＋淡入淡出包絡) → 6×Biquad(EQ) → StereoPanner → dest
  function scheduleClip(ctx, dest, p, clip, buf, map, winA, winB, plan) {
    const fps = p.fps || 30, rate = map.rate || 1;
    const env = audioEnvelope(p, clip, winA, winB, plan);
    if (!env) return null;                           // 沒有要播的部分；定格：靜音
    const { a, b } = env;
    const timeOf = F => map.t0 + (F - map.F0) / (fps * rate);
    const speed = clip.speed > 0 ? clip.speed : 1;
    const span = sourceSpan(p, clip);
    const C = core(), ramp = !clip.reverse && clip.retime && typeof C.srcOffset === 'function' && typeof C.retimeFactor === 'function';
    const rf = F => (ramp ? C.retimeFactor(clip, F) : 1);
    // 從片段起點到 a 消耗的來源秒數（交叉淡化提早開始時是負的：從前面的把手播）；曲線變速時是速度曲線的積分
    const used = ramp ? C.srcOffset(p, clip, a - clip.start) : (a - clip.start) / fps * speed;
    const m = reg.get(clip.mediaId);
    const src = ctx.createBufferSource();
    let offset;
    if (clip.reverse) { src.buffer = reversedOf(m, buf); offset = buf.duration - (span.to - used); }
    else { src.buffer = buf; offset = span.from + used; }
    let startT = timeOf(a);
    if (offset < 0) { startT += -offset / (speed * rf(a) * rate); offset = 0; }  // 來源前段沒有聲音（例如音軌比影片短）
    const stopT = timeOf(b);
    if (offset >= buf.duration || startT >= stopT) return null;
    src.playbackRate.value = speed * rf(a) * rate;
    if (ramp) {
      // 曲線變速：在曲線的每個轉折點排線性漸變，播放速度的積分剛好等於 srcOffset（兩邊都是分段線性）
      src.playbackRate.setValueAtTime(speed * rf(a) * rate, Math.max(0, startT));
      const D = clip.duration;
      for (const q of clip.retime.points) {
        const F = clip.start + q.u * D;
        if (F > a && F < b) src.playbackRate.linearRampToValueAtTime(speed * q.s * rate, timeOf(F));
      }
      src.playbackRate.linearRampToValueAtTime(speed * rf(b) * rate, stopT);
    }

    const gain = ctx.createGain();
    const pts = env.pts;
    gain.gain.setValueAtTime(pts[0][1], timeOf(pts[0][0]));
    for (let i = 1; i < pts.length; i++) gain.gain.linearRampToValueAtTime(pts[i][1], timeOf(pts[i][0]));

    src.connect(gain);
    let node = gain;
    const eq = (clip.audio || {}).eq;
    if (eq && eq.enabled) for (const band of eq.bands || []) {
      if (!band || band.on === false) continue;
      const f = makeBiquad(ctx, band);
      node.connect(f); node = f;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(+param(clip, 'audio.pan', 0, 0) || 0, -1, 1);
    node.connect(pan); pan.connect(dest);
    src.start(Math.max(0, startT), offset);
    src.stop(stopT);
    return {
      stop() {
        try { src.stop(); } catch (_) { /* 已停止 */ }
        try { src.disconnect(); pan.disconnect(); } catch (_) { /* 已中斷 */ }
      },
    };
  }

  // 匯出混音：from／to 是時間軸影格（半開區間），預設整段。結果長度 = (to − from) / fps 秒。
  // 很長的專案可以分段呼叫（例如每 30 秒），避免一次佔太多記憶體。
  async function renderAudio(p, opts) {
    const o = opts || {};
    const sr = o.sampleRate || 48000, chs = o.channels || 2, fps = p.fps || 30;
    const from = o.from != null ? o.from : 0;
    const to = o.to != null ? o.to : projectDuration(p);
    const length = Math.max(1, Math.round((to - from) / fps * sr));
    const oc = new OfflineAudioContext({ numberOfChannels: chs, length, sampleRate: sr });
    const plan = audioPlan(p);
    for (const c of audibleClips(p)) {
      const ext = plan[c.id], s0 = ext ? ext.from : c.start, s1 = ext ? ext.to : c.start + c.duration;
      if (s0 >= to || s1 <= from || c.freeze) continue;
      const buf = await media.decodeAudio(c.mediaId);
      if (buf) scheduleClip(oc, oc.destination, p, c, buf, { t0: 0, F0: from, rate: 1 }, from, to, plan);
    }
    return oc.startRendering();
  }

  // EQ 頻率響應（dB），給檢查器畫曲線用；和實際播放用同一套濾波器設定
  let eqCtx = null;
  function eqResponse(eq, freqs) {
    const f = Float32Array.from(freqs), out = new Float32Array(f.length);
    if (!eq || !eq.enabled) return out;
    if (!eqCtx) eqCtx = new OfflineAudioContext(1, 1, AUDIO_RATE);
    const mag = new Float32Array(f.length), ph = new Float32Array(f.length);
    for (const band of eq.bands || []) {
      if (!band || band.on === false) continue;
      makeBiquad(eqCtx, band).getFrequencyResponse(f, mag, ph);
      for (let i = 0; i < f.length; i++) out[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
    }
    return out;
  }

  // =====================================================================================
  // 播放器
  // =====================================================================================
  function createPlayer(opts) {
    const canvas = opts.canvas, getProject = opts.getProject, maxSize = opts.maxSize || 1920;
    const g = canvas.getContext('2d');
    const subs = { frame: new Set(), state: new Set() };
    const pool = new Map();       // clipId → { el, mediaId, target, used, native, failed }
    const voices = new Map();     // clipId → 已排程的預覽聲音
    let frame = 0, pos = 0, rate = 0, raf = 0, disposed = false;
    let dirty = true, dirtySince = 0, drewOnce = false;
    let ac = null, master = null, clockKind = '', anchorClock = 0, anchorFrame = 0;

    const emit = (type, v) => subs[type].forEach(fn => { try { fn(v); } catch (e) { console.error(e); } });

    function kick() {
      if (disposed) return;
      if (!dirty) { dirty = true; dirtySince = now(); }
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function setFrame(f) {
      if (f === frame) return;
      frame = f; dirty = true; dirtySince = now();
      emit('frame', f);
    }

    // ---- 時鐘：AudioContext 為主；它還沒啟動（瀏覽器自動播放限制）時先用 performance.now() ----
    function clockNow() {
      if (ac && ac.state === 'running') return { kind: 'ac', t: ac.currentTime };
      return { kind: 'perf', t: now() / 1000 };
    }
    function anchor() { const c = clockNow(); clockKind = c.kind; anchorClock = c.t; anchorFrame = pos; }
    function posAt(t, fps) { return anchorFrame + (t - anchorClock) * fps * rate; }
    function ensureAudio() {
      if (!ac) {
        try {
          ac = new AudioContext({ latencyHint: 'interactive' });
          master = ac.createGain();
          master.connect(ac.destination);
        } catch (_) { ac = null; }
      }
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    }

    // ---- <video> 元素池 ----
    function release(id) {
      const e = pool.get(id);
      if (!e) return;
      releaseVideo(e.el);
      pool.delete(id);
    }
    function acquire(clip, m) {
      let e = pool.get(clip.id);
      if (e && e.mediaId !== m.id) { release(clip.id); e = null; }
      if (!e) {
        const el = makeVideo(m.url);
        e = { el, mediaId: m.id, target: -1, used: now(), native: false, failed: false };
        el.addEventListener('loadedmetadata', kick);
        el.addEventListener('seeked', kick);
        el.addEventListener('loadeddata', kick);
        el.addEventListener('error', () => { e.failed = true; kick(); });
        pool.set(clip.id, e);
      }
      return e;
    }
    const onRemove = id => { for (const [cid, e] of pool) if (e.mediaId === id) release(cid); kick(); };
    removeHooks.add(onRemove);

    // 讓元素停在（或播到）該在的位置。playing=true 時順向、速度在範圍內的片段用原生播放，其他逐格 seek。
    function syncVideos(p) {
      const t = now(), live = new Set();
      const place = (r, active) => {
        const m = reg.get(r.mediaId);
        if (!m || m.kind !== 'video') return;
        const e = acquire(r.clip, m), el = e.el;
        live.add(r.clip.id); e.used = t;
        if (el.readyState < 1) return;            // 還在讀 metadata；讀好會 kick 再來
        const target = seekTarget(m, r.time), clip = r.clip;
        const C = core(), ramp = !clip.reverse && clip.retime && typeof C.srcOffset === 'function' && typeof C.retimeFactor === 'function';
        // 曲線變速：速度跟著播放頭一直變（每次 tick 更新 playbackRate），位置用曲線的積分
        const sp = (clip.speed > 0 ? clip.speed : 1) * (ramp ? C.retimeFactor(clip, pos) : 1) * rate;
        e.native = active && rate > 0 && !clip.reverse && !clip.freeze && sp >= 0.0625 && sp <= 16;
        if (e.native) {
          const adv = ramp ? C.srcOffset(p, clip, pos - clip.start) - C.srcOffset(p, clip, frame - clip.start) : (pos - frame) / p.fps * clip.speed;
          const want = clamp(target + adv, 0, m.duration);
          if (Math.abs(el.playbackRate - sp) > sp * 0.01) el.playbackRate = sp;
          if (el.paused) {
            if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want;
            const pr = el.play();
            if (pr && pr.catch) pr.catch(() => {});
          } else if (Math.abs(el.currentTime - want) > Math.max(0.15, 4 / p.fps) * sp) el.currentTime = want;   // 漂移太多才校正
          e.target = want;
        } else {
          if (!el.paused) el.pause();
          e.target = target;
          // 倒播／逐格：上一次 seek 還沒完成就先跳過這格（不要堆積）
          if (Math.abs(el.currentTime - target) > 1e-4 && !(rate && el.seeking)) el.currentTime = target;
        }
      };
      for (const r of sourcesAt(p, frame)) place(r, true);
      if (rate > 0) {                               // 預先準備快要出現的片段：先停在第一格，輪到它時直接播放，不閃黑
        const ahead = frame + Math.ceil(PRELOAD_SEC * p.fps * rate), fs = new Set();
        for (const tk of tracksOf(p, 'video')) {
          if (tk.hidden) continue;
          for (const c of Object.values(p.clips)) if (c.trackId === tk.id && c.start > frame && c.start <= ahead) fs.add(c.start);
          for (const tr of Object.values(p.transitions || {})) {
            if (tr.trackId !== tk.id) continue;
            const r = transitionRange(p, tr);
            if (r && r.from > frame && r.from <= ahead) fs.add(r.from);
          }
        }
        for (const f of fs) for (const r of sourcesAt(p, f)) if (!live.has(r.clip.id)) place(r, false);
      }
      for (const [id, e] of pool) {
        if (live.has(id)) continue;
        if (!e.el.paused) e.el.pause();
        if (t - e.used > EVICT_MS || pool.size > POOL_MAX) release(id);
      }
    }

    // 某個來源現在能不能畫：undefined = 還沒準備好（先保留上一格畫面），null = 沒有（畫不出來就略過）
    function readySource(r) {
      const m = reg.get(r.mediaId);
      if (!m) return null;
      if (m.kind === 'image') return m.image;
      const e = pool.get(r.clip.id);
      if (!e) return undefined;
      if (e.failed) return null;
      const el = e.el;
      if (el.readyState < 2) return undefined;
      if (!e.native && (el.seeking || Math.abs(el.currentTime - e.target) > 1e-3)) return undefined;
      return el;
    }

    function sizeCanvas(p) {
      const k = Math.min(1, maxSize / Math.max(p.width, p.height));
      const w = Math.max(2, Math.round(p.width * k)), h = Math.max(2, Math.round(p.height * k));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; drewOnce = false; }
    }

    function draw(p) {
      sizeCanvas(p);
      if (!rate) syncVideos(p);
      const got = new Map();
      let waiting = false;
      for (const r of sourcesAt(p, frame)) {
        const s = readySource(r);
        if (s === undefined) waiting = true; else got.set(r.clip.id, s);
      }
      const late = now() - dirtySince > 1500;
      if (waiting && drewOnce && !late) return;     // 等來源準備好；畫面保留上一格，不閃黑
      compose(g, p, frame, clip => got.get(clip.id) || null);
      drewOnce = true;
      dirty = waiting && !late;
    }

    // ---- 預覽聲音（和匯出同一套 scheduleClip）；倒播與超過 2× 時靜音 ----
    function stopVoices() { voices.forEach(v => v && v.stop()); voices.clear(); }
    function scheduleVoices(p) {
      if (!ac || clockKind !== 'ac' || rate <= 0 || rate > 2) return;
      const startF = posAt(ac.currentTime + 0.03, p.fps), look = startF + AUDIO_AHEAD * p.fps * rate;
      const plan = audioPlan(p);
      for (const c of audibleClips(p)) {
        const ext = plan[c.id], s0 = ext ? ext.from : c.start, s1 = ext ? ext.to : c.start + c.duration;
        if (voices.has(c.id) || s0 > look || s1 <= startF) continue;
        const m = reg.get(c.mediaId);
        if (!m || !m.hasAudio) continue;
        if (!m.audioBuffer) { decodeAudioOf(m); continue; }
        voices.set(c.id, scheduleClip(ac, master, p, c, m.audioBuffer, { t0: anchorClock, F0: anchorFrame, rate }, startF, Infinity, plan));
      }
    }

    function tick() {
      raf = 0;
      if (disposed) return;
      const p = getProject();
      if (!p) return;
      if (rate) {
        const c = clockNow();
        if (c.kind !== clockKind) { stopVoices(); anchor(); }   // AudioContext 剛啟動：換時鐘
        let x = posAt(c.t, p.fps), stop = false;
        const dur = projectDuration(p);
        if (rate > 0 && x >= dur) { x = Math.max(0, dur - 1); stop = true; }
        if (rate < 0 && x <= 0) { x = 0; stop = true; }
        pos = x;
        setFrame(Math.max(0, Math.floor(x + 1e-6)));
        if (stop) setRate(0);
        else { syncVideos(p); scheduleVoices(p); }
      }
      if (dirty) draw(p);
      if ((rate || dirty) && !raf) raf = requestAnimationFrame(tick);
    }

    function setRate(r) {
      r = +r || 0;
      if (r === rate) return;
      const p = getProject();
      if (!p) return;
      const dur = projectDuration(p);
      if (r && (dur <= 0 || (r < 0 && frame <= 0))) return;
      if (rate) pos = clamp(posAt(clockNow().t, p.fps), 0, Math.max(0, dur - 1));
      stopVoices();
      if (!r) {
        rate = 0; pos = frame;
        for (const e of pool.values()) if (!e.el.paused) e.el.pause();
        dirty = true; dirtySince = now();
      } else {
        if (rate === 0) pos = frame;
        if (r > 0 && frame >= dur - 1) { pos = 0; setFrame(0); }    // 已經在結尾：從頭播
        ensureAudio();
        rate = r;
        anchor();
      }
      emit('state', { playing: rate !== 0, rate });
      kick();
    }

    function seek(f) {
      const p = getProject();
      const dur = p ? projectDuration(p) : 0;
      f = clamp(Math.round(+f || 0), 0, Math.max(0, dur));
      pos = f;
      setFrame(f);
      if (rate) { stopVoices(); anchor(); }
      kick();
    }

    // 專案改了（例如靜音、改增益、移動片段）：重畫，播放中的聲音重新排程
    function refresh() {
      if (rate) { const p = getProject(); if (p) pos = posAt(clockNow().t, p.fps); stopVoices(); anchor(); }
      dirty = true; dirtySince = now();
      kick();
    }
    const bus = core().bus;
    if (bus && bus.addEventListener) bus.addEventListener('change', refresh);

    kick();
    return {
      play() { setRate(1); },
      pause() { setRate(0); },
      toggle() { setRate(rate ? 0 : 1); },
      shuttle: setRate,
      seek,
      stepFrames(n) { if (rate) setRate(0); seek(frame + (Math.round(n) || 0)); },
      refresh,
      get frame() { return frame; },
      get playing() { return rate !== 0; },
      get rate() { return rate; },
      on(type, cb) { if (!subs[type]) return () => {}; subs[type].add(cb); return () => subs[type].delete(cb); },
      dispose() {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        stopVoices();
        for (const id of Array.from(pool.keys())) release(id);
        removeHooks.delete(onRemove);
        if (bus && bus.removeEventListener) bus.removeEventListener('change', refresh);
        if (ac) ac.close().catch(() => {});
        ac = null;
      },
    };
  }

  const api = {
    media, compose, createPlayer, renderAudio, seekSource,
    renderFrame, sourcesAt, layersAt, transitionRange, releaseSeekers,
    fadeShape, gainAt, audioEnvelope, eqResponse, dbToGain, fpsFromTimes,
    _internal: { hasUnplayableVideo },        // 測試用
  };
  Q.render = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
