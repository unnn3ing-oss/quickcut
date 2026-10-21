// =====================================================================================
// 剪輯：時間軸核心引擎
//
// 純邏輯、不碰 DOM：瀏覽器掛在 QPTEdit.core，node 用 module.exports（test/edit-core.test.js）。
// 編輯語意以 DaVinci Resolve 的 Edit 頁為準。
//
// 時間單位：時間軸位置一律是「整數影格」（專案 fps），來源時間是「秒（浮點）」。
// 所有編輯操作都「就地修改」project，回傳 { ok: true, ... } 或 { ok: false, reason: '繁中原因' }。
// 做法是「先在副本上算、檢查不變式、通過才整份換進去」，所以失敗時 project 一定完全沒變；
// 注意：成功後 p.clips 等子物件會換成新的物件，UI 不要長期握著舊的 clip 參考，要用 id 重新查。
//
// 拖曳類的操作（trimEdge／rippleTrim／roll／slip／slide／moveClips 的水平位移）會把要求的量
// 「夾」到能做到的最大值，回傳 applied（實際做了多少）；一格都做不到才回 ok:false。
// 有連結的片段（linkId 相同，例如影像＋同錄音的聲音）預設一起動；opts.linked === false 時只動指定的片段
// （對應 UI 的「連結選取」關閉），這時可能不同步，linkOffset() 算出偏移給 UI 顯示紅字。
// 鎖定（locked）的軌道上的片段任何操作都不能改；隱藏（hidden）、靜音只影響算繪。
//
// sourceTimeAt() 是 render 與 export 唯一的時間換算，別的模組不要自己算。
// =====================================================================================
(function (root) {
  const Q = root.QPTEdit = root.QPTEdit || {};

  const FPS_CHOICES = [24, 25, 30, 50, 60];
  const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '4:5': [1080, 1350] };
  const MAX_SIDE = 3840;                  // 'source' 比例的長邊上限
  const MARKER_COLORS = ['blue', 'cyan', 'green', 'yellow', 'red', 'pink', 'purple', 'fuchsia', 'rose', 'lavender', 'sky', 'mint', 'lemon', 'sand', 'cocoa', 'cream'];
  const TRANSITION_TYPES = ['crossDissolve', 'dipToColor', 'fadeToBlack', 'wipe', 'push', 'slide', 'zoom', 'blur'];
  const EDIT_MODES = ['insert', 'overwrite', 'replace', 'append'];
  const IMAGE_DEFAULT_SEC = 5;            // 圖片放上時間軸的預設長度
  const DEFAULT_FREEZE_SEC = 2;           // 定格對話框的預設長度（UI 用）
  const SPEED_MIN = 0.01, SPEED_MAX = 100;
  const EPS = 1e-6;                       // 來源秒數比較的容許誤差
  const END_EPS = 1e-3;                   // sourceTimeAt 夾在媒體結尾前一點點，seek 才拿得到最後一格
  const BIG = 1e7;                        // 拖曳量是 Infinity 時的替代值

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const copy = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  const r9 = x => { const v = Math.round(x * 1e9) / 1e9; return v === 0 ? 0 : v; };   // 消掉浮點尾巴（也把 -0 變 0）
  const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra);

  class EditError extends Error {}
  const bail = reason => { throw new EditError(reason); };

  // ---- 預設值 ----------------------------------------------------------------------
  const defaultTransform = () => ({ zoomX: 1, zoomY: 1, zoomLinked: true, posX: 0, posY: 0, rotation: 0, anchorX: 0, anchorY: 0, opacity: 1, flipH: false, flipV: false });
  const defaultVideo = () => ({ transform: defaultTransform(), crop: { left: 0, right: 0, top: 0, bottom: 0, softness: 0 }, fit: 'fit', composite: 'normal' });
  const defaultEq = () => ({ enabled: false, bands: [
    { on: true, type: 'highpass', freq: 80, gain: 0, q: 0.7 },
    { on: true, type: 'lowshelf', freq: 200, gain: 0, q: 0.7 },
    { on: true, type: 'peaking', freq: 500, gain: 0, q: 1 },
    { on: true, type: 'peaking', freq: 1500, gain: 0, q: 1 },
    { on: true, type: 'highshelf', freq: 5000, gain: 0, q: 0.7 },
    { on: true, type: 'lowpass', freq: 18000, gain: 0, q: 0.7 },
  ] });
  const defaultAudio = () => ({ gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, fadeInCurve: 0, fadeOutCurve: 0, eq: defaultEq() });
  const defaultTitle = () => ({ text: '標題文字', preset: 'static', font: 'WHZ-Heavy', size: 80, color: '#ffffff', align: 'center',
    stroke: { color: '#000000', width: 0 }, shadow: { color: 'rgba(0,0,0,.6)', blur: 8, x: 0, y: 4 },
    bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 }, lineHeight: 1.25, x: 0.5, y: 0.5 });

  const snapFps = f => {
    f = Number(f);
    if (!isFinite(f) || f <= 0) return 30;
    return FPS_CHOICES.reduce((b, c) => (Math.abs(c - f) < Math.abs(b - f) ? c : b), FPS_CHOICES[0]);
  };
  // 偶數化、長邊不超過 MAX_SIDE
  function evenDims(w, h) {
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    return [Math.max(2, Math.round(w * k / 2) * 2), Math.max(2, Math.round(h * k / 2) * 2)];
  }

  // =====================================================================================
  // 專案、軌道
  // =====================================================================================
  function newId(p, prefix) { return prefix + (p.nextId++); }

  function createProject(opts = {}) {
    const p = {
      version: 1, fps: snapFps(opts.fps || 30), aspect: 'source', width: 1920, height: 1080,
      bgColor: opts.bgColor || '#000000',
      tracks: [], clips: {}, transitions: {}, markers: [],
      inPoint: null, outPoint: null, nextId: 1, mediaInfo: {},
    };
    const nv = opts.videoTracks == null ? 1 : opts.videoTracks, na = opts.audioTracks == null ? 1 : opts.audioTracks;
    for (let i = 0; i < Math.max(1, nv); i++) pushTrack(p, 'video');
    for (let i = 0; i < Math.max(1, na); i++) pushTrack(p, 'audio');
    if (opts.aspect) setAspect(p, opts.aspect);
    if (opts.width > 0 && opts.height > 0) { const [w, h] = evenDims(opts.width, opts.height); p.width = w; p.height = h; }
    return p;
  }

  const clone = p => copy(p);
  const serialize = p => JSON.stringify(p);

  // 讀回存檔：補齊缺的欄位（舊版或手寫的 JSON 也能用）
  function deserialize(json) {
    const src = typeof json === 'string' ? JSON.parse(json) : copy(json);
    const p = Object.assign(createProject({ videoTracks: 0, audioTracks: 0 }), src);
    p.tracks = (p.tracks || []).map(t => {
      for (const [k, v] of Object.entries({ name: '', locked: false, muted: false, hidden: false, solo: false })) if (t[k] === undefined) t[k] = v;
      return t;
    });
    p.clips = p.clips || {}; p.transitions = p.transitions || {}; p.markers = p.markers || []; p.mediaInfo = p.mediaInfo || {};
    for (const c of Object.values(p.clips)) {
      const t = getTrack(p, c.trackId);
      const base = { type: 'media', mediaId: null, srcIn: 0, speed: 1, reverse: false, freeze: false, linkId: null, enabled: true, name: '', flags: [], markers: [], title: null, solidColor: null, keyframes: {}, retime: null };
      for (const k of Object.keys(base)) if (c[k] === undefined) c[k] = base[k];
      if (c.video === undefined) c.video = t && t.kind === 'video' ? defaultVideo() : null;
      if (c.audio === undefined) c.audio = t && t.kind === 'audio' ? defaultAudio() : null;
    }
    // 轉場：舊存檔只有「leftClipId＋rightClipId（可能是 null）」；缺的欄位補預設值
    for (const [id, tr] of Object.entries(p.transitions)) {
      if (!isObj(tr)) { delete p.transitions[id]; continue; }
      const base = Object.assign(TR_DEFAULTS(p), { id, trackId: null, leftClipId: null, rightClipId: null });
      for (const k of Object.keys(base)) if (tr[k] === undefined) tr[k] = base[k];
      if (!tr.trackId) { const c = p.clips[tr.leftClipId] || p.clips[tr.rightClipId]; if (c) tr.trackId = c.trackId; }
    }
    if (!isFinite(p.nextId) || p.nextId < 1) p.nextId = 1;
    normalize(p);
    return p;
  }

  const getTrack = (p, id) => p.tracks.find(t => t.id === id) || null;
  const tracksOf = (p, kind) => p.tracks.filter(t => t.kind === kind);
  const isLocked = (p, trackId) => { const t = getTrack(p, trackId); return !!(t && t.locked); };

  function pushTrack(p, kind) {
    const t = { id: newId(p, 't'), kind, name: (kind === 'video' ? 'V' : 'A') + (tracksOf(p, kind).length + 1), locked: false, muted: false, hidden: false, solo: false };
    if (kind === 'video') {
      let i = -1;
      p.tracks.forEach((x, j) => { if (x.kind === 'video') i = j; });
      p.tracks.splice(i + 1, 0, t);
    } else p.tracks.push(t);
    return t;
  }
  // 預設名稱（V1、A2…）依順序重新編號；使用者改過的名稱不動
  function renumber(p) {
    for (const kind of ['video', 'audio']) {
      const pre = kind === 'video' ? 'V' : 'A';
      tracksOf(p, kind).forEach((t, i) => { if (/^[VA]\d+$/.test(t.name)) t.name = pre + (i + 1); });
    }
  }

  function addTrack(p, kind) {
    if (kind !== 'video' && kind !== 'audio') return fail('軌道種類只能是影片或音訊');
    return tx(p, q => ({ id: pushTrack(q, kind).id }), { lockCheck: false });
  }

  function removeTrack(p, trackId) {
    const t = getTrack(p, trackId);
    if (!t) return fail('找不到這條軌道');
    if (t.locked) return fail(`「${t.name}」軌已鎖定，不能刪除`);
    if (tracksOf(p, t.kind).length <= 1) return fail('至少要保留一條影片軌和一條音訊軌');
    return tx(p, q => {
      for (const c of clipsOnTrack(q, trackId)) removeClip(q, c.id);
      q.tracks = q.tracks.filter(x => x.id !== trackId);
      renumber(q);
      return {};
    });
  }

  // 改軌道狀態（名稱、鎖定、靜音、隱藏、獨奏）
  function setTrackProps(p, trackId, patch = {}) {
    const t = getTrack(p, trackId);
    if (!t) return fail('找不到這條軌道');
    const keys = Object.keys(patch);
    const bad = keys.find(k => !['name', 'locked', 'muted', 'hidden', 'solo'].includes(k));
    if (bad) return fail(`軌道沒有「${bad}」這個設定`);
    return tx(p, q => {
      const x = getTrack(q, trackId);
      for (const k of keys) x[k] = k === 'name' ? String(patch[k]).slice(0, 40) : !!patch[k];
      return {};
    }, { lockCheck: false });
  }

  // =====================================================================================
  // 媒體資訊、輸出比例
  // =====================================================================================
  // info：{ kind: 'video'|'audio'|'image', duration（秒）, hasAudio, width, height, fps, name }
  // 第一支影片（時間軸還是空的時候）決定專案 fps；比例是 'source' 時也決定輸出尺寸。
  function registerMediaInfo(p, id, info = {}) {
    if (!id) return fail('媒體缺少 id');
    const kind = info.kind;
    if (!['video', 'audio', 'image'].includes(kind)) return fail('不支援的媒體類型');
    let duration = null;
    if (kind !== 'image') {
      duration = Number(info.duration);
      if (!isFinite(duration) || duration <= 0) return fail('讀不到媒體長度，這個檔案可能壞了或格式不支援');
    }
    p.mediaInfo = p.mediaInfo || {};
    const firstVideo = kind === 'video' && !Object.values(p.mediaInfo).some(m => m.kind === 'video') && !Object.keys(p.clips).length;
    p.mediaInfo[id] = {
      kind, duration, hasAudio: kind === 'audio' ? true : kind === 'video' ? !!info.hasAudio : false,
      width: info.width > 0 ? +info.width : null, height: info.height > 0 ? +info.height : null,
      fps: info.fps > 0 ? +info.fps : null, name: info.name ? String(info.name) : '',
      // 檔案大小與修改時間：存檔後重新連結素材時用來比對是不是同一個檔案
      size: info.size > 0 ? +info.size : null, lastModified: info.lastModified > 0 ? +info.lastModified : null,
    };
    let fpsSet = false;
    if (firstVideo) {
      if (info.fps > 0) { p.fps = snapFps(info.fps); fpsSet = true; }
      if (p.aspect === 'source') setAspect(p, 'source');
    }
    return { ok: true, fpsSet, fps: p.fps };
  }

  function unregisterMediaInfo(p, id) {
    if (Object.values(p.clips).some(c => c.mediaId === id)) return fail('時間軸上還有片段在用這個媒體');
    if (p.mediaInfo) delete p.mediaInfo[id];
    return { ok: true };
  }

  // 'source' = 第一支影片的尺寸（偶數化，長邊上限 3840）；沒有影片時維持 1920×1080
  function setAspect(p, aspect, sourceDims) {
    if (aspect !== 'source' && !ASPECTS[aspect]) return fail('不支援的輸出比例');
    let w, h;
    if (aspect === 'source') {
      let d = sourceDims && sourceDims.width > 0 && sourceDims.height > 0 ? sourceDims : null;
      if (!d) d = Object.values(p.mediaInfo || {}).find(m => m.kind === 'video' && m.width > 0 && m.height > 0) || null;
      [w, h] = d ? evenDims(d.width, d.height) : [1920, 1080];
    } else [w, h] = ASPECTS[aspect];
    p.aspect = aspect; p.width = w; p.height = h;
    return { ok: true, width: w, height: h };
  }

  // =====================================================================================
  // 查詢
  // =====================================================================================
  const clipEnd = c => c.start + c.duration;
  const getClip = (p, id) => p.clips[id] || null;
  const clipsOnTrack = (p, trackId) => Object.values(p.clips).filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
  const clipAt = (p, trackId, frame) => Object.values(p.clips).find(c => c.trackId === trackId && c.start <= frame && frame < clipEnd(c)) || null;
  function clipsAt(p, frame) {
    const out = [];
    for (const t of p.tracks) { const c = clipAt(p, t.id, frame); if (c) out.push(c); }
    return out;
  }
  const projectDuration = p => Object.values(p.clips).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const clipLabel = c => (c && c.name ? `「${c.name}」` : '片段');

  // 同一個連結群組的其他片段（不含自己）
  function linkedClips(p, clipId) {
    const c = p.clips[clipId];
    if (!c || !c.linkId) return [];
    return Object.values(p.clips).filter(x => x.id !== c.id && x.linkId === c.linkId);
  }
  // 把選取擴展到連結片段（linkedSelection 關閉時原樣回傳）；回傳 id 陣列、不重複、不存在的 id 會略過
  function expandLinked(p, ids, linkedSelection = true) {
    const out = [];
    const seen = new Set();
    const add = id => { if (p.clips[id] && !seen.has(id)) { seen.add(id); out.push(id); } };
    arr(ids).forEach(add);
    if (linkedSelection) for (const id of out.slice()) for (const x of linkedClips(p, id)) add(x.id);
    return out;
  }

  const mediaOf = (p, c) => (c && c.type === 'media' && c.mediaId && p.mediaInfo ? p.mediaInfo[c.mediaId] || null : null);
  // 有限長度的來源（影片、音訊）回傳秒數；圖片、標題、色塊、未知媒體回 null（不受來源長度限制）
  function finiteDur(p, c) {
    const m = mediaOf(p, c);
    return m && m.kind !== 'image' && isFinite(m.duration) && m.duration > 0 ? m.duration : null;
  }
  const srcLen = (p, c) => (c.freeze ? 0 : c.duration * c.speed / p.fps);
  // 有時間軸的來源（影片、音訊）：修剪、切開、滑移時要跟著調整 srcIn；圖片、標題、色塊不用
  const timed = (p, c) => { const m = mediaOf(p, c); return c.type === 'media' && !(m && m.kind === 'image'); };

  // 這一格要顯示的來源秒數。frame 是時間軸影格，可以超出片段範圍（轉場向把手借畫面時），結果夾在媒體範圍內。
  //   正播：srcIn + (frame-start) × speed / fps
  //   倒播：片段第一格 = 來源區段的最後一格，最後一格 = srcIn
  //   定格：永遠是 srcIn
  // 標題、色塊回傳「片段內經過的秒數」；圖片回傳 0。
  function sourceTimeAt(p, clip, frame) {
    const c = typeof clip === 'string' ? p.clips[clip] : clip;
    if (!c) return 0;
    const local = frame - c.start;
    if (c.type !== 'media') return local / p.fps;
    const m = mediaOf(p, c);
    if (m && m.kind === 'image') return 0;
    let t;
    if (c.freeze) t = c.srcIn;
    else if (c.reverse) t = c.srcIn + (c.duration - 1 - local) * c.speed / p.fps;
    else t = c.srcIn + local * c.speed / p.fps;
    const D = finiteDur(p, c);
    return clamp(r9(t), 0, D == null ? Infinity : Math.max(0, D - END_EPS));
  }

  // 片段用到的來源區段（秒）；倒播時 from 仍是較早的那一端
  function sourceSpan(p, clip) {
    const c = typeof clip === 'string' ? p.clips[clip] : clip;
    if (!c) return null;
    return { from: c.srcIn, to: r9(c.srcIn + srcLen(p, c)) };
  }

  // 這一側（'start'|'end'）還能用媒體把手延長幾格（不管鄰居）。圖片、標題、色塊、定格是 Infinity。
  function maxExtend(p, clip, edge) {
    const c = typeof clip === 'string' ? p.clips[clip] : clip;
    if (!c) return 0;
    const D = finiteDur(p, c);
    if (D == null || c.freeze) return Infinity;
    const before = c.srcIn, after = D - (c.srcIn + srcLen(p, c));
    const room = (edge === 'start') !== !!c.reverse ? before : after;
    return Math.max(0, Math.floor(room * p.fps / c.speed + EPS));
  }

  // 連結片段的同步位置：同一個來源、同速度時用「來源對齊」算（J-cut／L-cut 不算不同步），否則比 start
  function anchor(p, c) {
    if (c.type !== 'media' || c.freeze) return c.start;
    const k = p.fps / c.speed;
    return c.reverse ? c.start + c.duration + c.srcIn * k : c.start - c.srcIn * k;
  }
  const sameSource = (a, b) => a.type === 'media' && b.type === 'media' && a.mediaId === b.mediaId && a.speed === b.speed && !!a.reverse === !!b.reverse && !a.freeze && !b.freeze;
  // 群組的基準片段：最下層的影片軌上的那個（沒有就第一個音訊）
  function linkRef(p, c) {
    const g = [c, ...linkedClips(p, c.id)];
    const order = id => p.tracks.findIndex(t => t.id === id);
    g.sort((a, b) => order(a.trackId) - order(b.trackId));
    return g[0];
  }
  // 這個片段相對連結群組基準的偏移（影格，正數 = 比較晚）；沒連結或同步時是 0。UI 用紅字顯示。
  function linkOffset(p, clipId) {
    const c = p.clips[clipId];
    if (!c || !c.linkId) return 0;
    const ref = linkRef(p, c);
    if (ref === c) return 0;
    const d = sameSource(c, ref) ? anchor(p, c) - anchor(p, ref) : c.start - ref.start;
    return Math.round(d * 1000) / 1000;
  }

  // 吸附目標：片段邊緣、播放頭、標記（含片段標記）、In/Out。opts：{ playhead, exclude: [id], markers, inOut }
  function snapTargets(p, opts = {}) {
    const ex = new Set(arr(opts.exclude));
    const s = new Set([0]);
    for (const c of Object.values(p.clips)) {
      if (ex.has(c.id)) continue;
      s.add(c.start); s.add(clipEnd(c));
      if (opts.markers !== false) for (const m of c.markers || []) if (m.offset >= 0 && m.offset < c.duration) s.add(c.start + m.offset);
    }
    if (opts.playhead != null && isFinite(opts.playhead)) s.add(Math.round(opts.playhead));
    if (opts.markers !== false) for (const m of p.markers) { s.add(m.frame); if (m.duration) s.add(m.frame + m.duration); }
    if (opts.inOut !== false) { if (p.inPoint != null) s.add(p.inPoint); if (p.outPoint != null) s.add(p.outPoint); }
    return [...s].sort((a, b) => a - b);
  }
  // 離 frame 最近、距離不超過 tolerance 的目標；沒有就回傳 frame
  function snap(frame, targets, tolerance) {
    let best = frame, bd = Infinity;
    for (const t of targets || []) { const d = Math.abs(t - frame); if (d <= tolerance && d < bd) { bd = d; best = t; } }
    return best;
  }

  // 轉場的種類：'both' = 兩片段之間；'out' = 片段尾端淡出（rightClipId = null）；'in' = 片段開頭淡入（leftClipId = null）。
  // 單邊轉場「屬於片段邊緣」：剪接點被拉開時轉場留在某一側變成單邊，重新接上時自動變回雙邊（見 normalize）。
  const transitionSide = t => (!t ? null : t.leftClipId && t.rightClipId ? 'both' : t.leftClipId ? 'out' : t.rightClipId ? 'in' : null);

  // 轉場在時間軸上的範圍（影格，半開區間）。edit（別名 cut）= 剪接點（單邊時 = 片段的那個邊緣）。
  // 單邊轉場一律貼著邊緣：尾端淡出在片段最後 duration 格、開頭淡入在片段最前 duration 格（align 不影響位置）。
  function transitionRange(p, tr) {
    const t = typeof tr === 'string' ? p.transitions[tr] : tr;
    if (!t) return null;
    const L = t.leftClipId ? p.clips[t.leftClipId] : null, R = t.rightClipId ? p.clips[t.rightClipId] : null;
    if ((t.leftClipId && !L) || (t.rightClipId && !R) || (!L && !R)) return null;
    const d = t.duration;
    const edit = L ? clipEnd(L) : R.start;
    let from;
    if (!L) from = edit;
    else if (!R || t.align === 'end') from = edit - d;
    else if (t.align === 'start') from = edit;
    else from = edit - Math.floor(d / 2);
    return { from, to: from + d, edit, cut: edit };
  }
  const transitionsOfClip = (p, clipId) => Object.values(p.transitions).filter(t => t.leftClipId === clipId || t.rightClipId === clipId);
  // 片段某一側邊緣上的轉場（edge：'start'|'end'）；沒有回傳 null
  const transitionAtEdge = (p, clipId, edge) => Object.values(p.transitions).find(t => (edge === 'end' ? t.leftClipId : t.rightClipId) === clipId) || null;

  // ---- 轉場時的聲音：由影片轉場推出（不另存「音訊轉場」）----------------------------------
  // 影片軌上的轉場：
  //   兩片段之間：左右片段各自連結的音訊片段若在同一條音訊軌上也相鄰 → 在轉場範圍內做等功率交叉淡化
  //     （以音訊的剪接點為準，J／L-cut 時跟著聲音的剪接點）。左段要多播到範圍結尾、右段要提早從範圍開頭播，
  //     多出來的聲音從來源把手取；把手不夠時在把手用盡處縮短淡化範圍（兩邊各自夾），兩邊都沒有把手就維持硬切。
  //   尾端淡出／開頭淡入：連結的音訊片段在自己的結尾／開頭做同長度的淡出／淡入。
  // 回傳 { [音訊片段 id]: { from, to, fades: [{ from, to, dir: 'in'|'out' }] } }：from／to 是這段聲音實際要播的時間軸範圍
  // （可能超出片段本身，用到把手），fades 的增益用 transitionFadeGain() 算，再和片段自己的淡入淡出相乘。
  // 預覽（scheduleClip）與匯出（renderAudio）都從這裡取，所以聽起來一樣。片段停用、軌道靜音不影響這裡的計算。
  function audioTransitionPlan(p) {
    const out = {};
    const entry = c => out[c.id] || (out[c.id] = { from: c.start, to: clipEnd(c), fades: [] });
    const audioOf = v => (v && v.linkId ? linkedClips(p, v.id).filter(c => { const t = getTrack(p, c.trackId); return t && t.kind === 'audio' && c.type === 'media' && !c.freeze; }) : []);
    const seen = new Set();
    for (const tr of Object.values(p.transitions)) {
      const tk = getTrack(p, tr.trackId);
      if (!tk || tk.kind !== 'video') continue;
      const r = transitionRange(p, tr);
      if (!r) continue;
      const L = tr.leftClipId ? p.clips[tr.leftClipId] : null, R = tr.rightClipId ? p.clips[tr.rightClipId] : null;
      if (L && R) {
        for (const aL of audioOf(L)) for (const aR of audioOf(R)) {
          if (aL.trackId !== aR.trackId || clipEnd(aL) !== aR.start) continue;
          const key = aL.id + '|' + aR.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const ea = aR.start;
          const pre = Math.min(r.edit - r.from, maxExtend(p, aR, 'start'), aL.duration);
          const post = Math.min(r.to - r.edit, maxExtend(p, aL, 'end'), aR.duration);
          if (pre + post < 1) continue;
          const f = { from: ea - pre, to: ea + post };
          const eL = entry(aL), eR = entry(aR);
          eL.to = Math.max(eL.to, f.to); eL.fades.push(Object.assign({ dir: 'out' }, f));
          eR.from = Math.min(eR.from, f.from); eR.fades.push(Object.assign({ dir: 'in' }, f));
        }
      } else {
        const d = r.to - r.from;
        for (const a of audioOf(L || R)) {
          const key = (L ? 'out|' : 'in|') + a.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const n = Math.min(d, a.duration);
          entry(a).fades.push(L ? { from: clipEnd(a) - n, to: clipEnd(a), dir: 'out' } : { from: a.start, to: a.start + n, dir: 'in' });
        }
      }
    }
    return out;
  }
  // 轉場淡化的增益（等功率）：u = 0~1 為淡化進度。淡出 cos(πu/2)、淡入 sin(πu/2)，交叉時兩段功率和恆為 1（中點各 −3dB）。
  // fades：audioTransitionPlan 的 fades；F：時間軸影格（可小數）。多段淡化相乘。
  function transitionFadeGain(fades, F) {
    let k = 1;
    for (const f of fades || []) {
      const u = clamp((F - f.from) / Math.max(1e-9, f.to - f.from), 0, 1);
      k *= f.dir === 'out' ? Math.cos(u * Math.PI / 2) : Math.sin(u * Math.PI / 2);
    }
    return Math.abs(k) < 1e-12 ? 0 : k;
  }

  // =====================================================================================
  // 不變式與交易
  // =====================================================================================
  // 回傳問題清單 [{ code, msg }]；空陣列 = 一切正常。opts.linkSync：連結片段也要同步。
  function problems(p, opts = {}) {
    const out = [];
    const add = (code, msg) => out.push({ code, msg });
    const tk = new Map(p.tracks.map(t => [t.id, t]));
    if (tk.size !== p.tracks.length) add('track', '軌道 id 重複');
    if (!Number.isInteger(p.fps) || p.fps <= 0) add('fps', '專案 fps 不正確');
    const byTrack = new Map();
    for (const [id, c] of Object.entries(p.clips)) {
      const nm = clipLabel(c);
      if (c.id !== id) add('id', `${nm}的 id 不一致`);
      const t = tk.get(c.trackId);
      if (!t) { add('track', `${nm}所在的軌道不存在`); continue; }
      if (!Number.isInteger(c.start) || c.start < 0) add('start', `${nm}不能放在時間軸開頭之前`);
      if (!Number.isInteger(c.duration) || c.duration < 1) add('duration', `${nm}的長度至少要 1 格`);
      if (!(c.speed > 0) || !isFinite(c.speed)) add('speed', `${nm}的速度不正確`);
      if (!isFinite(c.srcIn) || (timed(p, c) && c.srcIn < -EPS)) add('srcStart', `${nm}已經用到來源媒體的開頭，沒有更多畫面`);
      if (t.kind === 'audio' && c.type !== 'media') add('kind', '標題和色塊只能放在影片軌');
      const m = mediaOf(p, c);
      if (c.type === 'media' && m) {
        if (t.kind === 'video' && m.kind === 'audio') add('kind', '音訊不能放在影片軌');
        if (t.kind === 'audio' && !(m.kind === 'audio' || (m.kind === 'video' && m.hasAudio))) add('kind', '沒有聲音的媒體不能放在音訊軌');
      }
      const D = finiteDur(p, c);
      if (D != null && isFinite(c.srcIn)) {
        if (c.freeze ? c.srcIn >= D : c.srcIn + srcLen(p, c) > D + EPS) add('srcEnd', `${nm}已經用到來源媒體的結尾，沒有更多畫面`);
      }
      if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
      byTrack.get(c.trackId).push(c);
    }
    for (const [tid, list] of byTrack) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        if (clipEnd(list[i - 1]) > list[i].start) { add('overlap', `「${tk.get(tid).name}」軌上的片段會重疊`); break; }
      }
    }
    const edges = new Set();
    for (const tr of Object.values(p.transitions)) {
      const L = tr.leftClipId ? p.clips[tr.leftClipId] : null, R = tr.rightClipId ? p.clips[tr.rightClipId] : null;
      if (!tr.leftClipId && !tr.rightClipId) { add('transition', '轉場沒有附在任何片段上'); continue; }
      if (tr.leftClipId && !L) { add('transition', '轉場找不到前一個片段'); continue; }
      if (tr.rightClipId && !R) { add('transition', '轉場找不到後一個片段'); continue; }
      const own = L || R;
      if (tr.trackId !== own.trackId) add('transition', '轉場和片段不在同一軌');
      if (!TRANSITION_TYPES.includes(tr.type)) add('transition', '不認得的轉場種類');
      for (const k of [L && 'end:' + L.id, R && 'start:' + R.id]) {
        if (!k) continue;
        if (edges.has(k)) add('transition', '同一個片段邊緣有兩個轉場');
        edges.add(k);
      }
      let max;
      if (L && R) {
        if (R.trackId !== L.trackId || R.start !== clipEnd(L)) add('transition', '轉場兩側的片段沒有相鄰');
        max = Math.min(L.duration, R.duration);
      } else {
        // 單邊轉場貼在片段邊緣；那個邊緣緊接著別的片段時應該是兩片段之間的轉場
        max = own.duration;
        const nb = L ? clipsOnTrack(p, L.trackId).find(c => c.id !== L.id && c.start === clipEnd(L))
          : clipsOnTrack(p, R.trackId).find(c => c.id !== R.id && clipEnd(c) === R.start);
        if (nb) add('transition', '單邊轉場旁邊緊接著片段（應該是兩片段之間的轉場）');
      }
      if (!Number.isInteger(tr.duration) || tr.duration < 1) add('transition', '轉場長度至少要 1 格');
      else if (tr.duration > max) add('transition', '轉場比片段還長');
    }
    for (const mk of p.markers) {
      if (!Number.isInteger(mk.frame) || mk.frame < 0) add('marker', '標記的位置不正確');
      if (!MARKER_COLORS.includes(mk.color)) add('marker', '標記的顏色不正確');
    }
    const io = v => v == null || (Number.isInteger(v) && v >= 0);
    if (!io(p.inPoint) || !io(p.outPoint)) add('inout', 'In／Out 不正確');
    if (p.inPoint != null && p.outPoint != null && p.outPoint <= p.inPoint) add('inout', 'Out 要在 In 之後');
    if (opts.linkSync) {
      for (const c of Object.values(p.clips)) if (c.linkId && Math.abs(linkOffset(p, c.id)) > 1e-3) { add('link', `${clipLabel(c)}和連結的片段不同步`); break; }
    }
    return out;
  }
  const checkInvariants = (p, opts) => problems(p, opts).map(x => x.msg);

  // 片段在這次操作裡怎麼變的：'new'（新的）／'moved'（搬到別處：換軌或整段平移）／'trimmed'（只改了邊緣）／'same'
  function clipChange(before, c) {
    const b = before && before.clips[c.id];
    if (!b) return 'new';
    if (b.trackId !== c.trackId) return 'moved';
    const ds = c.start - b.start, de = clipEnd(c) - clipEnd(b);
    if (!ds && !de) return 'same';
    return ds === de ? 'moved' : 'trimmed';
  }
  // 兩片段之間的轉場被拉開（不再相鄰）時，決定留在哪一側（DaVinci：轉場屬於片段邊緣）：
  //   1. 只有一側被搬走（移動、被推開）→ 留在沒被移動的那一側；
  //   2. 兩側都還在原處、只有一側的邊緣被修剪 → 跟著被修剪的那個片段的邊緣；
  //   3. 判斷不出來（兩側都變、沒有操作前的狀態）→ 留在左側。
  function detachSide(before, L, R) {
    const cl = clipChange(before, L), cr = clipChange(before, R);
    if (cl === 'moved' && cr !== 'moved') return 'right';
    if (cr === 'moved' && cl !== 'moved') return 'left';
    const b = before || { clips: {} }, bl = b.clips[L.id], br = b.clips[R.id];
    const le = !bl || bl.trackId !== L.trackId || clipEnd(bl) !== clipEnd(L);   // 左片段的尾端動了
    const rs = !br || br.trackId !== R.trackId || br.start !== R.start;         // 右片段的開頭動了
    if (rs && !le) return 'right';
    return 'left';
  }

  // 操作後的整理：轉場（拉開→單邊、接上→雙邊、清掉失效的、長度夾在片段內）、只剩一個成員的連結、把淡入淡出夾在片段長度內、標記排序。
  // before：操作前的 project（用來判斷剪接點被拉開時轉場要留在哪一側）；沒有時（讀檔）一律留在左側。
  function normalize(p, before) {
    const trs = Object.values(p.transitions);
    const ofTrack = new Map();
    const onTrack = tid => { if (!ofTrack.has(tid)) ofTrack.set(tid, clipsOnTrack(p, tid)); return ofTrack.get(tid); };
    // 1. 附著的片段不見了（被刪除）→ 只刪這個轉場；兩片段之間被拉開 → 留在一側變成單邊
    for (const tr of trs) {
      if (tr.leftClipId === undefined) tr.leftClipId = null;
      if (tr.rightClipId === undefined) tr.rightClipId = null;
      const L = tr.leftClipId ? p.clips[tr.leftClipId] : null, R = tr.rightClipId ? p.clips[tr.rightClipId] : null;
      if ((tr.leftClipId && !L) || (tr.rightClipId && !R) || (!L && !R)) { delete p.transitions[tr.id]; continue; }
      if (L && R && (R.trackId !== L.trackId || R.start !== clipEnd(L))) {
        if (detachSide(before, L, R) === 'left') tr.rightClipId = null; else tr.leftClipId = null;
      }
    }
    // 2. 單邊轉場的邊緣緊接著片段（重新接上）→ 變回兩片段之間；兩側各有一個時保留左側那個
    const edgeOwner = new Map();      // 'end:id'／'start:id' → 轉場
    const live = Object.values(p.transitions).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    for (const tr of live) {
      if (tr.leftClipId && tr.rightClipId) continue;
      if (tr.leftClipId) {
        const L = p.clips[tr.leftClipId];
        const R = onTrack(L.trackId).find(c => c.id !== L.id && c.start === clipEnd(L));
        if (R) {
          const other = Object.values(p.transitions).find(x => x !== tr && x.rightClipId === R.id && !x.leftClipId);
          if (other) delete p.transitions[other.id];
          tr.rightClipId = R.id;
        }
      }
    }
    for (const tr of Object.values(p.transitions)) {
      if (tr.leftClipId || !tr.rightClipId) continue;
      const R = p.clips[tr.rightClipId];
      const L = onTrack(R.trackId).find(c => c.id !== R.id && clipEnd(c) === R.start);
      if (L && !Object.values(p.transitions).some(x => x.leftClipId === L.id)) tr.leftClipId = L.id;
    }
    // 3. 每個片段邊緣只留一個轉場；軌道跟著片段；長度夾在片段長度內
    for (const tr of Object.values(p.transitions).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
      const L = tr.leftClipId ? p.clips[tr.leftClipId] : null, R = tr.rightClipId ? p.clips[tr.rightClipId] : null;
      const keys = [L && 'end:' + L.id, R && 'start:' + R.id].filter(Boolean);
      if (keys.some(k => edgeOwner.has(k))) { delete p.transitions[tr.id]; continue; }
      keys.forEach(k => edgeOwner.set(k, tr));
      tr.trackId = (L || R).trackId;
      const max = L && R ? Math.min(L.duration, R.duration) : (L || R).duration;
      tr.duration = clamp(Math.round(tr.duration) || 1, 1, max);
    }
    const groups = new Map();
    for (const c of Object.values(p.clips)) if (c.linkId) { if (!groups.has(c.linkId)) groups.set(c.linkId, []); groups.get(c.linkId).push(c); }
    for (const g of groups.values()) if (g.length < 2) for (const c of g) if (!isLocked(p, c.trackId)) c.linkId = null;
    for (const c of Object.values(p.clips)) {
      if (!c.audio) continue;
      const a = c.audio;
      a.fadeIn = clamp(Math.round(a.fadeIn) || 0, 0, c.duration);
      a.fadeOut = clamp(Math.round(a.fadeOut) || 0, 0, c.duration - a.fadeIn);
    }
    p.markers.sort((a, b) => a.frame - b.frame);
  }

  // 鎖定軌：操作前後這條軌上的片段與轉場必須一模一樣
  function lockedChanged(a, b) {
    const snapT = (p, tid) => JSON.stringify([
      Object.values(p.clips).filter(c => c.trackId === tid).sort((x, y) => (x.id < y.id ? -1 : 1)),
      Object.values(p.transitions).filter(t => t.trackId === tid).sort((x, y) => (x.id < y.id ? -1 : 1)),
    ]);
    for (const t of a.tracks) {
      if (!t.locked) continue;
      if (!getTrack(b, t.id) || snapT(a, t.id) !== snapT(b, t.id)) return `「${t.name}」軌已鎖定，不能修改`;
    }
    return null;
  }

  function replaceInPlace(target, src) {
    for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
    Object.assign(target, src);
  }

  // 在副本上執行 fn，整理、檢查；成功回傳 { ok, draft, res }，不動到 p
  function attempt(p, fn, opts = {}) {
    const d = copy(p);
    let res;
    try { res = fn(d) || {}; } catch (e) { if (e instanceof EditError) return fail(e.message); throw e; }
    if (res.ok === false) return res;
    normalize(d, p);
    const bad = problems(d);
    if (bad.length) return fail(bad[0].msg, { code: bad[0].code });
    if (opts.lockCheck !== false) { const why = lockedChanged(p, d); if (why) return fail(why, { code: 'locked' }); }
    return { ok: true, draft: d, res };
  }
  function finish(p, a, extra) {
    replaceInPlace(p, a.draft);
    const r = Object.assign({}, a.res, extra, { ok: true });
    return r;
  }
  function tx(p, fn, opts) {
    const a = attempt(p, fn, opts);
    return a.ok ? finish(p, a) : a;
  }
  // 拖曳類：做不到全部就找出能做到的最大量（可行範圍是從 0 開始的連續區間，用二分搜尋）
  function clamped(p, d, mk) {
    d = Number(d);
    if (Number.isNaN(d)) return fail('移動量不正確');
    d = isFinite(d) ? Math.round(d) : Math.sign(d) * BIG;
    if (d === 0) return { ok: true, applied: 0 };
    const sign = Math.sign(d);
    const full = attempt(p, mk(d));
    if (full.ok) return finish(p, full, { applied: d });
    const one = attempt(p, mk(sign));
    if (!one.ok) return one;
    let lo = 1, hi = Math.abs(d), best = one;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const t = attempt(p, mk(mid * sign));
      if (t.ok) { lo = mid; best = t; } else hi = mid;
    }
    return finish(p, best, { applied: lo * sign });
  }
  // 波紋類的「重疊」失敗換成看得懂的說法
  function rippleReason(r, what) {
    if (!r.ok && r.code === 'overlap') r.reason = `${r.reason.replace('上的片段會重疊', '')}在這段時間有片段擋住，${what}；可以先鎖定那條軌道再試`;
    return r;
  }

  function needClips(p, ids) {
    const list = arr(ids);
    if (!list.length) bail('沒有選取片段');
    return list.map(id => p.clips[id] || bail('找不到片段（可能已經被刪除）'));
  }
  function needUnlocked(p, clips) {
    for (const c of clips) {
      const t = getTrack(p, c.trackId);
      if (t && t.locked) bail(`「${t.name}」軌已鎖定，不能修改`);
    }
  }
  // 包一層：前置檢查用 bail 丟出的錯誤轉成 { ok:false }
  const guard = fn => (...a) => {
    try { return fn(...a); } catch (e) { if (e instanceof EditError) return fail(e.message); throw e; }
  };

  // =====================================================================================
  // 低階工具（都在副本上用）
  // =====================================================================================
  function makeClip(p, f) {
    const t = getTrack(p, f.trackId) || bail('找不到目的軌道');
    const type = f.type || 'media';
    const c = {
      id: newId(p, 'c'), trackId: t.id, type, mediaId: type === 'media' ? f.mediaId : null,
      start: f.start, duration: f.duration, srcIn: f.srcIn || 0, speed: 1, reverse: false, freeze: !!f.freeze,
      linkId: f.linkId || null, enabled: true, name: f.name || '', flags: [], markers: [],
      video: t.kind === 'video' ? (f.video ? copy(f.video) : defaultVideo()) : null,
      audio: t.kind === 'audio' ? defaultAudio() : null,
      title: type === 'title' ? deepMerge(defaultTitle(), f.title || {}) : null,
      solidColor: type === 'solid' ? (f.solidColor || '#000000') : null,
      keyframes: {}, retime: null,
    };
    p.clips[c.id] = c;
    return c;
  }

  function removeClip(p, id) {
    delete p.clips[id];
    for (const t of Object.values(p.transitions)) if (t.leftClipId === id || t.rightClipId === id) delete p.transitions[t.id];
  }

  // 改某一側的長度：delta > 0 變長、< 0 變短。'start' 側會移動 start；來源依正播／倒播調整
  function adjustEdge(p, c, edge, delta) {
    if (!delta) return;
    const ds = c.freeze || !timed(p, c) ? 0 : delta * c.speed / p.fps;
    if (edge === 'start') {
      c.start -= delta; c.duration += delta;
      if (!c.reverse) c.srcIn = r9(c.srcIn - ds);
      for (const m of c.markers) m.offset += delta;
    } else {
      c.duration += delta;
      if (c.reverse) c.srcIn = r9(c.srcIn - ds);
    }
  }

  // 在 frame 切開（start < frame < end），左半保留原 id，回傳右半（linkId 先設 null，由呼叫端決定）
  function splitClip(p, c, frame) {
    const leftDur = frame - c.start, rightDur = clipEnd(c) - frame;
    const r = copy(c);
    r.id = newId(p, 'c'); r.start = frame; r.duration = rightDur; r.linkId = null;
    c.duration = leftDur;
    if (!c.freeze && timed(p, c)) {
      const s = c.speed / p.fps;
      if (c.reverse) c.srcIn = r9(c.srcIn + rightDur * s);   // 倒播：前半段顯示的是較晚的來源
      else r.srcIn = r9(c.srcIn + leftDur * s);
    }
    c.markers = c.markers.filter(m => m.offset < leftDur);
    r.markers = r.markers.filter(m => m.offset >= leftDur).map(m => Object.assign(m, { offset: m.offset - leftDur }));
    if (c.audio) { c.audio.fadeOut = 0; r.audio.fadeIn = 0; }
    p.clips[r.id] = r;
    for (const t of Object.values(p.transitions)) if (t.leftClipId === c.id) t.leftClipId = r.id;  // 尾端的轉場跟著右半
    return r;
  }
  // 一次切一組片段：同一個連結群組切出來的右半也互相連結
  function splitGroup(p, clips, frame) {
    const map = new Map();
    return clips.filter(c => c.start < frame && frame < clipEnd(c)).map(c => {
      const r = splitClip(p, c, frame);
      if (c.linkId) {
        if (!map.has(c.linkId)) map.set(c.linkId, newId(p, 'L'));
        r.linkId = map.get(c.linkId);
      }
      return r;
    });
  }

  // 位移：shifts = { id: 影格 }。連結群組只要有一個要動，整組（未鎖定、不在 fixed 裡的）用同一個量動，保持同步
  function applyShifts(p, shifts, fixed) {
    const byLink = new Map();
    for (const [id, a] of Object.entries(shifts)) {
      const c = p.clips[id];
      if (!c || !a || !c.linkId) continue;
      const cur = byLink.get(c.linkId);
      if (cur === undefined || Math.abs(a) > Math.abs(cur)) byLink.set(c.linkId, a);
    }
    for (const c of Object.values(p.clips)) {
      if ((fixed && fixed.has(c.id)) || isLocked(p, c.trackId)) continue;
      const a = c.linkId && byLink.has(c.linkId) ? byLink.get(c.linkId) : shifts[c.id] || 0;
      if (a) c.start += a;
    }
  }

  // 在 frame 插入 len 格空白：所有未鎖定軌，跨過 frame 的片段切開，frame 之後的往後推
  function insertSpace(p, frame, len) {
    const live = Object.values(p.clips).filter(c => !isLocked(p, c.trackId));
    splitGroup(p, live, frame);
    const shifts = {};
    for (const c of Object.values(p.clips)) if (!isLocked(p, c.trackId) && c.start >= frame) shifts[c.id] = len;
    applyShifts(p, shifts);
  }

  // 刪掉一些時間範圍後收合：每個片段往前移「它前面被刪掉的總長度」
  function closeRanges(p, ranges) {
    const rs = ranges.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of rs) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push(r.slice()); }
    const before = f => merged.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, f) - a), 0);
    const shifts = {};
    for (const c of Object.values(p.clips)) { const s = before(c.start); if (s) shifts[c.id] = -s; }
    applyShifts(p, shifts);
  }

  // 覆蓋：把 [from, to) 範圍內的其他片段清掉（整個在範圍內刪除、跨過的切開、碰到一邊的修短）
  function clearRange(p, trackId, from, to, ex) {
    for (const c of clipsOnTrack(p, trackId)) {
      if (ex && ex.has(c.id)) continue;
      const e = clipEnd(c);
      if (e <= from || c.start >= to) continue;
      if (c.start >= from && e <= to) removeClip(p, c.id);
      else if (c.start < from && e > to) { splitClip(p, c, to); adjustEdge(p, c, 'end', from - to); }
      else if (c.start < from) adjustEdge(p, c, 'end', from - e);
      else adjustEdge(p, c, 'start', c.start - to);
    }
  }

  // 深層合併（陣列裡是物件時依索引合併，null 表示這一格不變）
  function deepMerge(t, s) {
    for (const k of Object.keys(s)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const v = s[k];
      if (v === undefined) continue;
      if (isObj(v) && isObj(t[k])) deepMerge(t[k], v);
      else if (Array.isArray(v) && Array.isArray(t[k]) && v.some(isObj)) {
        v.forEach((e, i) => { if (e == null) return; if (isObj(e) && isObj(t[k][i])) deepMerge(t[k][i], e); else t[k][i] = copy(e); });
      } else t[k] = isObj(v) || Array.isArray(v) ? copy(v) : v;
    }
    return t;
  }

  // =====================================================================================
  // 編輯操作
  // =====================================================================================

  // 選取模式移動：dFrames 水平、dTracks 垂直（只在同種類軌道間移動；第一個 id 的軌道種類決定誰會換軌）。
  // 目的地被蓋到的片段以覆蓋處理。水平位移不能讓片段跑到 0 之前（會夾住）。
  const moveClips = guard((p, ids, dFrames, dTracks = 0, opts = {}) => {
    const sel = needClips(p, ids);
    const set = expandLinked(p, sel.map(c => c.id), opts.linked !== false);
    const clips = set.map(id => p.clips[id]);
    needUnlocked(p, clips);
    dFrames = Math.round(Number(dFrames) || 0); dTracks = Math.round(Number(dTracks) || 0);
    const primKind = getTrack(p, sel[0].trackId).kind;
    const minStart = Math.min(...clips.map(c => c.start));
    const applied = Math.max(dFrames, -minStart);
    if (applied === 0 && dTracks === 0) return dFrames ? fail('已經在時間軸的最前面') : { ok: true, applied: 0, dTracks: 0 };
    const dest = new Map();
    for (const c of clips) {
      const t = getTrack(p, c.trackId);
      let nt = t;
      if (dTracks && t.kind === primKind) {
        const list = tracksOf(p, t.kind);
        nt = list[list.indexOf(t) + dTracks];
        if (!nt) return fail('沒有那條軌道可以放');
        if (nt.locked) return fail(`「${nt.name}」軌已鎖定，不能放上去`);
      }
      dest.set(c.id, nt.id);
    }
    return tx(p, q => {
      const ex = new Set(set);
      for (const id of set) { const c = q.clips[id]; clearRange(q, dest.get(id), c.start + applied, clipEnd(c) + applied, ex); }
      for (const id of set) { const c = q.clips[id]; c.trackId = dest.get(id); c.start += applied; }
      return { applied, dTracks, ids: set };
    });
  });

  // 一般修剪：edge 往右移 dFrames 格（負數往左）。不推後方，受鄰居與媒體把手限制。
  // id 可以是陣列（多選一起修剪）：全部改同樣格數，夾到每個片段都做得到的量
  const trimEdge = guard((p, id, edge, dFrames, opts = {}) => {
    if (edge !== 'start' && edge !== 'end') return fail('要指定修剪片段的開頭或結尾');
    const group = expandLinked(p, needClips(p, id).map(c => c.id), opts.linked !== false);
    needUnlocked(p, group.map(g => p.clips[g]));
    const r = clamped(p, dFrames, d => q => { for (const g of group) adjustEdge(q, q.clips[g], edge, edge === 'start' ? -d : d); });
    if (!r.ok && r.code === 'overlap') r.reason = '已經碰到旁邊的片段（一般修剪不會推動其他片段，要推動請用波紋修剪）';
    return r;
  });

  // 刀片：切開 frame 這格的片段（連結片段一起切）。trackIds 省略 = 所有未鎖定的軌道。回傳 { ids: 新片段（右半）}
  const blade = guard((p, frame, trackIds, opts = {}) => {
    frame = Math.round(frame);
    const explicit = trackIds != null;
    const tracks = explicit ? arr(trackIds).map(id => getTrack(p, id) || bail('找不到這條軌道')) : p.tracks.filter(t => !t.locked);
    if (explicit) { const lk = tracks.find(t => t.locked); if (lk) return fail(`「${lk.name}」軌已鎖定，不能切`); }
    const spans = c => c && c.start < frame && frame < clipEnd(c);
    const hits = tracks.map(t => clipAt(p, t.id, frame)).filter(spans).map(c => c.id);
    let ids = expandLinked(p, hits, opts.linked !== false).filter(id => spans(p.clips[id]));
    if (!explicit) ids = ids.filter(id => !isLocked(p, p.clips[id].trackId));
    if (!ids.length) return fail('這一格沒有可以切開的片段');
    needUnlocked(p, ids.map(i => p.clips[i]));
    return tx(p, q => ({ ids: splitGroup(q, ids.map(i => q.clips[i]), frame).map(r => r.id) }));
  });

  // 波紋修剪：改長度，片段起點不動，後面（所有未鎖定軌、在這個片段結尾之後開始的）片段跟著推拉。
  // id 可以是陣列（多選一起修剪）：每個片段的同一邊都改 dFrames 格，後面的片段累加推拉（前面有幾個被修剪的就推幾次）
  const rippleTrim = guard((p, id, edge, dFrames, opts = {}) => {
    if (edge !== 'start' && edge !== 'end') return fail('要指定修剪片段的開頭或結尾');
    const linked = opts.linked !== false;
    const groups = [], fixed = new Set();
    for (const c of needClips(p, id)) {
      if (fixed.has(c.id)) continue;
      const ids = expandLinked(p, [c.id], linked).filter(g => !fixed.has(g));
      ids.forEach(g => fixed.add(g));
      const thr = new Map();
      for (const g of ids) { const k = p.clips[g]; thr.set(k.trackId, Math.max(thr.get(k.trackId) || 0, clipEnd(k))); }
      groups.push({ ids, thr, primEnd: clipEnd(c) });
    }
    needUnlocked(p, [...fixed].map(g => p.clips[g]));
    // 每個片段要推幾次：它（原本的）起點在幾個「別組」修剪片段的結尾之後
    const count = {};
    for (const k of Object.values(p.clips)) {
      let n = 0;
      for (const g of groups) {
        if (g.ids.includes(k.id)) continue;
        if (k.start >= (g.thr.has(k.trackId) ? g.thr.get(k.trackId) : g.primEnd)) n++;
      }
      if (n) count[k.id] = n;
    }
    const r = clamped(p, dFrames, d => q => {
      const delta = edge === 'end' ? d : -d;
      for (const g of fixed) {
        const k = q.clips[g];
        if (edge === 'start') { adjustEdge(q, k, 'start', delta); k.start += delta; } else adjustEdge(q, k, 'end', delta);
      }
      const shifts = {};
      for (const [k, n] of Object.entries(count)) shifts[k] = n * delta;
      applyShifts(q, shifts, fixed);
      for (const g of fixed) if (count[g]) q.clips[g].start += count[g] * delta;
    });
    return rippleReason(r, '無法波紋修剪');
  });

  // 波紋刪除：刪掉片段並收合空出來的時間（所有未鎖定軌一起收，保持同步）
  const rippleDelete = guard((p, ids, opts = {}) => {
    const set = expandLinked(p, needClips(p, ids).map(c => c.id), opts.linked !== false);
    needUnlocked(p, set.map(i => p.clips[i]));
    const ranges = set.map(i => [p.clips[i].start, clipEnd(p.clips[i])]);
    return rippleReason(tx(p, q => {
      for (const i of set) removeClip(q, i);
      closeRanges(q, ranges);
      return { removed: set };
    }), '無法波紋刪除（可改用「抬起」只刪不補位）');
  });

  // 抬起：只刪不補位
  const lift = guard((p, ids, opts = {}) => {
    const set = expandLinked(p, needClips(p, ids).map(c => c.id), opts.linked !== false);
    needUnlocked(p, set.map(i => p.clips[i]));
    return tx(p, q => { for (const i of set) removeClip(q, i); return { removed: set }; });
  });

  // 刪除空隙：frame 落在 trackId 這條軌的空隙裡，收合它（所有未鎖定軌一起收）
  const deleteGap = guard((p, trackId, frame) => {
    const t = getTrack(p, trackId);
    if (!t) return fail('找不到這條軌道');
    if (t.locked) return fail(`「${t.name}」軌已鎖定，不能修改`);
    frame = Math.round(frame);
    if (clipAt(p, trackId, frame)) return fail('這裡不是空隙');
    const list = clipsOnTrack(p, trackId);
    const next = list.find(c => c.start > frame);
    if (!next) return fail('這裡不是空隙（後面沒有片段）');
    const from = list.filter(c => clipEnd(c) <= frame).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    return rippleReason(tx(p, q => { closeRanges(q, [[from, next.start]]); return { removed: next.start - from, from }; }), '無法刪除空隙');
  });

  // 滾動修剪：相鄰兩片段的剪接點移動 dFrames，總長不變
  const roll = guard((p, leftId, rightId, dFrames, opts = {}) => {
    const [L, R] = needClips(p, [leftId, rightId]);
    if (L.trackId !== R.trackId || R.start !== clipEnd(L)) return fail('滾動修剪的兩個片段要在同一軌而且相鄰');
    const edit = R.start, linked = opts.linked !== false;
    const Ls = [L.id, ...(linked ? linkedClips(p, L.id).filter(c => clipEnd(c) === edit).map(c => c.id) : [])];
    const Rs = [R.id, ...(linked ? linkedClips(p, R.id).filter(c => c.start === edit).map(c => c.id) : [])];
    needUnlocked(p, [...Ls, ...Rs].map(i => p.clips[i]));
    return clamped(p, dFrames, d => q => {
      for (const i of Ls) adjustEdge(q, q.clips[i], 'end', d);
      for (const i of Rs) adjustEdge(q, q.clips[i], 'start', -d);
    });
  });

  // 滑移：片段位置與長度不變，只換用到的來源畫面。dFrames > 0 = 把來源往右拖（看到比較早的畫面，srcIn 變小）
  const slip = guard((p, id, dFrames, opts = {}) => {
    const c = needClips(p, id)[0];
    const slippable = k => k.type === 'media' && mediaOf(p, k) && mediaOf(p, k).kind !== 'image';
    if (!slippable(c)) return fail('這個片段沒有可以滑移的來源畫面');
    const group = expandLinked(p, [c.id], opts.linked !== false).filter(i => slippable(p.clips[i]));
    needUnlocked(p, group.map(i => p.clips[i]));
    return clamped(p, dFrames, d => q => {
      for (const i of group) { const k = q.clips[i]; k.srcIn = r9(k.srcIn - d * k.speed / q.fps); }
    });
  });

  // 滑動：片段內容不變、整個往右移 dFrames，前一個鄰居變長、後一個鄰居變短（沒有相鄰的鄰居時就只受空隙限制）
  const slide = guard((p, id, dFrames, opts = {}) => {
    const group = expandLinked(p, needClips(p, id).map(c => c.id), opts.linked !== false);
    const gs = new Set(group);
    const plan = group.map(i => {
      const k = p.clips[i];
      const others = clipsOnTrack(p, k.trackId).filter(x => !gs.has(x.id));
      const prev = others.find(x => clipEnd(x) === k.start), next = others.find(x => x.start === clipEnd(k));
      return { id: i, prev: prev && prev.id, next: next && next.id };
    });
    needUnlocked(p, group.map(i => p.clips[i]));
    return clamped(p, dFrames, d => q => {
      for (const x of plan) {
        if (x.prev) adjustEdge(q, q.clips[x.prev], 'end', d);
        if (x.next) adjustEdge(q, q.clips[x.next], 'start', -d);
        q.clips[x.id].start += d;
      }
    });
  });

  // 時間軸 In/Out（影格；Out 是半開區間的結尾 = 最後包含的那格 + 1）。傳 null 表示不設那一邊
  function setInOut(p, inF, outF) {
    const ok = v => v == null || (isFinite(v) && v >= 0);
    if (!ok(inF) || !ok(outF)) return fail('In／Out 的位置不正確');
    const i = inF == null ? null : Math.round(inF), o = outF == null ? null : Math.round(outF);
    if (i != null && o != null && o <= i) return fail('Out 要在 In 之後');
    return tx(p, q => { q.inPoint = i; q.outPoint = o; return { inPoint: i, outPoint: o }; }, { lockCheck: false });
  }
  const clearInOut = p => tx(p, q => { q.inPoint = null; q.outPoint = null; return {}; }, { lockCheck: false });

  // 插入／覆蓋／替換／加到結尾（三點剪輯）
  // o：{ mode, mediaId, srcIn, srcOut, sourceTime（來源播放頭，replace 用）, trackIds: { video, audio }（null = 不放）, frame（播放頭）, name }
  //   ignoreInOut: true → 不看時間軸 In/Out，直接放在 frame（拖放這種有明確位置的操作用）
  //   insert／overwrite：時間軸 In/Out 都有 → 放在 In、長度 = Out−In；只有 In → 放在 In；只有 Out → 結尾對齊 Out；都沒有 → 播放頭
  //   append：放在目的軌道最後一個片段之後（不看 In/Out）
  //   replace：取代播放頭位置的片段，長度 = 該片段長度；有 sourceTime 時「來源播放頭」對齊「時間軸播放頭」，否則來源 In 對齊片段開頭
  // 影片有聲音時同時放影像與聲音並連結。回傳 { ids, start, end }
  const editToTimeline = guard((p, o = {}) => {
    const mode = o.mode || 'overwrite';
    if (!EDIT_MODES.includes(mode)) return fail('不認得的剪輯方式');
    const info = p.mediaInfo && p.mediaInfo[o.mediaId];
    if (!info) return fail('找不到這個媒體的資訊，請重新匯入');
    const fps = p.fps, isImg = info.kind === 'image';
    const D = isImg ? Infinity : info.duration;
    const tids = o.trackIds || {};
    const pick = (kind, want, given) => {
      if (!want || given === null) return null;
      const t = given ? getTrack(p, given) : tracksOf(p, kind)[0];
      if (!t) bail(kind === 'video' ? '找不到目的影片軌' : '找不到目的音訊軌');
      if (t.kind !== kind) bail(kind === 'video' ? '影像只能放在影片軌' : '聲音只能放在音訊軌');
      return t;
    };
    const vt = pick('video', info.kind !== 'audio', tids.video);
    const at = pick('audio', info.kind === 'audio' || (info.kind === 'video' && info.hasAudio), tids.audio);
    if (!vt && !at) return fail('沒有可以放的目的軌道');
    const name = o.name || info.name || '';
    let srcIn = isImg ? 0 : Math.max(0, Number(o.srcIn) || 0);
    if (!isImg && srcIn >= D) return fail('來源 In 超過媒體長度');
    const srcOut = o.srcOut == null ? (isImg ? IMAGE_DEFAULT_SEC : D) : Math.min(Number(o.srcOut), D);
    if (!(srcOut > srcIn)) return fail('來源的 Out 要在 In 之後');
    const srcDur = Math.floor((srcOut - srcIn) * fps + EPS);
    if (srcDur < 1) return fail('來源片段太短（不到 1 格）');

    if (mode === 'replace') {
      const track = info.kind === 'audio' ? at : vt;
      if (!track) return fail('沒有可以替換的目的軌道');
      if (track.locked) return fail(`「${track.name}」軌已鎖定，不能修改`);
      const frame = Math.round(Number(o.frame) || 0);
      const target = clipAt(p, track.id, frame);
      if (!target) return fail('播放頭位置的目的軌道上沒有片段可以替換');
      const ns = isImg ? 0 : r9(o.sourceTime != null ? Number(o.sourceTime) - (frame - target.start) / fps : srcIn);
      if (ns < -EPS) return fail('來源播放頭前面的畫面不夠，無法對齊');
      const partners = linkedClips(p, target.id);
      needUnlocked(p, partners);
      const r = tx(p, q => {
        const t = q.clips[target.id];
        Object.assign(t, { type: 'media', mediaId: o.mediaId, srcIn: Math.max(0, ns), speed: 1, reverse: false, freeze: false, name, title: null, solidColor: null });
        for (const x of partners) {
          const k = q.clips[x.id];
          const kt = getTrack(q, k.trackId);
          if (info.kind === 'video' && kt.kind === 'audio') {
            if (info.hasAudio) Object.assign(k, { mediaId: o.mediaId, srcIn: r9(Math.max(0, ns + (k.start - t.start) / fps)), speed: 1, reverse: false, freeze: false, name });
            else removeClip(q, k.id);   // 新媒體沒有聲音：舊的聲音拿掉，不然會配錯畫面
          } else t.linkId = null;       // 替換音訊時：和原本的影像斷開連結
        }
        return { ids: [target.id], start: t.start, end: clipEnd(t) };
      });
      if (!r.ok && r.code === 'srcEnd') r.reason = '來源長度不夠，無法填滿要替換的片段';
      return r;
    }

    for (const t of [vt, at]) if (t && t.locked) return fail(`「${t.name}」軌已鎖定，不能放上去`);
    let start, dur = srcDur;
    const tin = o.ignoreInOut ? null : p.inPoint, tout = o.ignoreInOut ? null : p.outPoint;
    if (mode === 'append') start = [vt, at].filter(Boolean).reduce((m, t) => clipsOnTrack(p, t.id).reduce((n, c) => Math.max(n, clipEnd(c)), m), 0);
    else if (tin != null && tout != null) {
      start = tin; dur = tout - tin;
      if (!isImg && srcIn + dur * 1 / fps > D + EPS) return fail('來源長度不夠填滿時間軸 In～Out 的範圍');
    } else if (tin != null) start = tin;
    else if (tout != null) { start = tout - dur; if (start < 0) return fail('時間軸 Out 前面的空間不夠放這段'); }
    else start = Math.max(0, Math.round(Number(o.frame) || 0));
    return tx(p, q => {
      if (mode === 'insert') insertSpace(q, start, dur);
      else for (const t of [vt, at]) if (t) clearRange(q, t.id, start, start + dur);
      const link = vt && at ? newId(q, 'L') : null;
      const ids = [];
      for (const t of [vt, at]) if (t) ids.push(makeClip(q, { trackId: t.id, type: 'media', mediaId: o.mediaId, start, duration: dur, srcIn, linkId: link, name }).id);
      return { ids, start, end: start + dur };
    });
  });

  // 放標題／色塊（或單一媒體片段）到某條影片軌：o：{ type, trackId, start, duration, mode: 'overwrite'|'insert', title, solidColor, name, mediaId, srcIn }
  const addClip = guard((p, o = {}) => {
    const type = o.type || 'title';
    if (!['title', 'solid', 'media'].includes(type)) return fail('不認得的片段種類');
    const t = getTrack(p, o.trackId) || tracksOf(p, 'video')[0];
    if (!t) return fail('找不到目的軌道');
    if (t.locked) return fail(`「${t.name}」軌已鎖定，不能放上去`);
    if (type !== 'media' && t.kind !== 'video') return fail('標題和色塊只能放在影片軌');
    if (type === 'media' && !(p.mediaInfo && p.mediaInfo[o.mediaId])) return fail('找不到這個媒體的資訊，請重新匯入');
    const start = Math.round(Number(o.start) || 0), dur = Math.round(Number(o.duration) || IMAGE_DEFAULT_SEC * p.fps);
    if (start < 0) return fail('不能放在時間軸開頭之前');
    if (dur < 1) return fail('片段長度至少要 1 格');
    return tx(p, q => {
      if (o.mode === 'insert') insertSpace(q, start, dur); else clearRange(q, t.id, start, start + dur);
      const c = makeClip(q, { trackId: t.id, type, mediaId: o.mediaId, start, duration: dur, srcIn: Math.max(0, Number(o.srcIn) || 0), title: o.title, solidColor: o.solidColor, name: o.name || (type === 'title' ? '標題' : type === 'solid' ? '色塊' : '') });
      return { id: c.id, ids: [c.id], start, end: start + dur };
    });
  });

  // 連結：把片段設成同一組（原本的群組會被拆開）
  const link = guard((p, ids) => {
    const clips = needClips(p, ids);
    if (new Set(clips.map(c => c.id)).size < 2) return fail('至少要選兩個片段才能連結');
    needUnlocked(p, clips);
    return tx(p, q => { const L = newId(q, 'L'); for (const c of clips) q.clips[c.id].linkId = L; return { linkId: L }; });
  });
  // 取消連結：這些片段所在的整個群組都解開（同 DaVinci）
  const unlink = guard((p, ids) => {
    const clips = needClips(p, ids);
    const lids = new Set(clips.map(c => c.linkId).filter(Boolean));
    if (!lids.size) return fail('選取的片段沒有連結');
    const all = Object.values(p.clips).filter(c => lids.has(c.linkId));
    needUnlocked(p, all);
    return tx(p, q => { for (const c of all) q.clips[c.id].linkId = null; return { ids: all.map(c => c.id) }; });
  });

  // ---- 標記、旗標 ------------------------------------------------------------------
  function cleanMarker(m, base) {
    const out = Object.assign({}, base);
    for (const k of ['duration', 'color', 'name', 'note']) if (m[k] !== undefined) out[k] = m[k];
    out.duration = Math.round(Number(out.duration) || 0);
    if (out.duration < 0) bail('標記長度不能是負的');
    if (!MARKER_COLORS.includes(out.color)) bail('不認得的標記顏色');
    out.name = String(out.name || '').slice(0, 200); out.note = String(out.note || '').slice(0, 2000);
    return out;
  }
  const addMarker = guard((p, m = {}) => {
    const frame = Math.round(Number(m.frame));
    if (!isFinite(frame) || frame < 0) return fail('標記的位置不正確');
    if (p.markers.some(x => x.frame === frame)) return fail('這一格已經有標記');
    const mk = cleanMarker(m, { frame, duration: 0, color: 'blue', name: '', note: '' });
    return tx(p, q => { mk.id = newId(q, 'k'); q.markers.push(Object.assign({ id: mk.id }, mk)); return { id: mk.id }; }, { lockCheck: false });
  });
  const updateMarker = guard((p, id, patch = {}) => {
    const cur = p.markers.find(x => x.id === id);
    if (!cur) return fail('找不到這個標記');
    let frame = cur.frame;
    if (patch.frame !== undefined) {
      frame = Math.round(Number(patch.frame));
      if (!isFinite(frame) || frame < 0) return fail('標記的位置不正確');
      if (p.markers.some(x => x.id !== id && x.frame === frame)) return fail('這一格已經有標記');
    }
    const mk = cleanMarker(patch, cur);
    return tx(p, q => { const x = q.markers.find(y => y.id === id); Object.assign(x, mk, { id, frame }); return { id }; }, { lockCheck: false });
  });
  const removeMarker = (p, id) => {
    if (!p.markers.some(x => x.id === id)) return fail('找不到這個標記');
    return tx(p, q => { q.markers = q.markers.filter(x => x.id !== id); return {}; }, { lockCheck: false });
  };
  // 片段標記：m.offset（相對片段起點）或 m.frame（時間軸影格）擇一
  const addClipMarker = guard((p, clipId, m = {}) => {
    const c = needClips(p, clipId)[0];
    needUnlocked(p, [c]);
    const offset = Math.round(m.offset != null ? Number(m.offset) : Number(m.frame) - c.start);
    if (!isFinite(offset) || offset < 0 || offset >= c.duration) return fail('標記要在片段範圍內');
    if (c.markers.some(x => x.offset === offset)) return fail('這一格已經有標記');
    const mk = cleanMarker(m, { duration: 0, color: 'blue', name: '', note: '' });
    return tx(p, q => {
      const id = newId(q, 'k');
      const k = q.clips[c.id];
      k.markers.push(Object.assign({ id, offset }, mk));
      k.markers.sort((a, b) => a.offset - b.offset);
      return { id };
    });
  });
  const updateClipMarker = guard((p, clipId, markerId, patch = {}) => {
    const c = needClips(p, clipId)[0];
    needUnlocked(p, [c]);
    const cur = c.markers.find(x => x.id === markerId);
    if (!cur) return fail('找不到這個標記');
    let offset = cur.offset;
    if (patch.offset !== undefined) {
      offset = Math.round(Number(patch.offset));
      if (!isFinite(offset) || offset < 0 || offset >= c.duration) return fail('標記要在片段範圍內');
      if (c.markers.some(x => x.id !== markerId && x.offset === offset)) return fail('這一格已經有標記');
    }
    const mk = cleanMarker(patch, cur);
    return tx(p, q => {
      const k = q.clips[c.id];
      Object.assign(k.markers.find(x => x.id === markerId), mk, { id: markerId, offset });
      k.markers.sort((a, b) => a.offset - b.offset);
      return { id: markerId };
    });
  });
  const removeClipMarker = guard((p, clipId, markerId) => {
    const c = needClips(p, clipId)[0];
    needUnlocked(p, [c]);
    if (!c.markers.some(x => x.id === markerId)) return fail('找不到這個標記');
    return tx(p, q => { const k = q.clips[c.id]; k.markers = k.markers.filter(x => x.id !== markerId); return {}; });
  });
  // 片段旗標（可以一次設多個片段）
  const setFlags = guard((p, ids, flags) => {
    const clips = needClips(p, ids);
    needUnlocked(p, clips);
    const list = [...new Set(arr(flags))];
    const bad = list.find(f => !MARKER_COLORS.includes(f));
    if (bad) return fail(`不認得的旗標顏色：${bad}`);
    return tx(p, q => { for (const c of clips) q.clips[c.id].flags = list.slice(); return {}; });
  });

  // ---- 變速、定格 ------------------------------------------------------------------
  // o：{ speed, reverse, ripple }。ripple：長度跟著變（來源用量不變）並推後方；否則長度不變、只改來源用量（受媒體長度限制）
  const setSpeed = guard((p, id, o = {}) => {
    const c = needClips(p, id)[0];
    const m = mediaOf(p, c);
    if (c.type !== 'media' || !m || m.kind === 'image') return fail('只有影片和音訊片段可以變速');
    if (c.freeze) return fail('定格片段不能變速');
    const sp = o.speed == null ? c.speed : Number(o.speed);
    if (!isFinite(sp) || sp < SPEED_MIN || sp > SPEED_MAX) return fail(`速度要在 ${SPEED_MIN * 100}%～${SPEED_MAX * 100}% 之間`);
    const rev = o.reverse == null ? !!c.reverse : !!o.reverse;
    const group = expandLinked(p, [c.id], o.linked !== false).filter(i => {
      const k = p.clips[i]; const km = mediaOf(p, k);
      return k.type === 'media' && km && km.kind !== 'image' && !k.freeze;
    });
    needUnlocked(p, group.map(i => p.clips[i]));
    const fixed = new Set(group);
    const thr = new Map();
    for (const g of group) { const k = p.clips[g]; thr.set(k.trackId, Math.max(thr.get(k.trackId) || 0, clipEnd(k))); }
    const r = tx(p, q => {
      let delta = 0;
      for (const g of group) {
        const k = q.clips[g];
        if (o.ripple) {
          let nd = Math.max(1, Math.round(k.duration * k.speed / sp));
          const D = finiteDur(q, k);
          if (D != null && k.srcIn + nd * sp / q.fps > D + EPS) nd = Math.max(1, Math.floor((D - k.srcIn) * q.fps / sp + EPS));
          if (g === c.id) delta = nd - k.duration;
          k.duration = nd;
        }
        k.speed = sp; k.reverse = rev;
      }
      if (o.ripple && delta) {
        const shifts = {};
        for (const k of Object.values(q.clips)) {
          if (fixed.has(k.id)) continue;
          const th = thr.has(k.trackId) ? thr.get(k.trackId) : clipEnd(c);
          if (k.start >= th) shifts[k.id] = delta;
        }
        applyShifts(q, shifts, fixed);
      }
      return { duration: q.clips[c.id].duration };
    });
    if (!r.ok && r.code === 'srcEnd') r.reason = '來源媒體的長度不夠用這個速度填滿片段，可以勾選「波紋」讓片段長度跟著變';
    return rippleReason(r, '無法改變速度');
  });

  // 定格：o.duration（影格）> 0 → 在 frame 切開，插入這麼長的定格片段，後面波紋推後；
  //        沒給 duration → 整個片段變成定格（停在 frame 那一格的畫面）。UI 對話框的預設長度用 DEFAULT_FREEZE_SEC。
  const freezeFrame = guard((p, id, frame, o = {}) => {
    const c = needClips(p, id)[0];
    const m = mediaOf(p, c);
    if (getTrack(p, c.trackId).kind !== 'video') return fail('音訊片段不能定格');
    if (c.type !== 'media' || !m) return fail('只有影片片段可以定格');
    if (m.kind === 'image') return fail('靜態圖片本來就是定格畫面');
    needUnlocked(p, [c]);
    const f = frame == null ? c.start : Math.round(frame);
    if (f < c.start || f >= clipEnd(c)) return fail('播放頭要在片段範圍內');
    const t = sourceTimeAt(p, c, f);
    if (o.duration == null || o.duration === 0) {
      return tx(p, q => { Object.assign(q.clips[c.id], { freeze: true, srcIn: t, speed: 1, reverse: false }); return { id: c.id }; });
    }
    const dur = Math.round(Number(o.duration));
    if (!isFinite(dur) || dur < 1) return fail('定格長度至少要 1 格');
    return rippleReason(tx(p, q => {
      insertSpace(q, f, dur);
      const k = q.clips[c.id];
      const nc = makeClip(q, { trackId: k.trackId, type: 'media', mediaId: k.mediaId, start: f, duration: dur, srcIn: t, freeze: true, video: k.video, name: (k.name ? k.name + '（定格）' : '定格') });
      return { id: nc.id };
    }), '無法插入定格');
  });

  // ---- 轉場 ------------------------------------------------------------------------
  const TR_KEYS = ['type', 'duration', 'align', 'color', 'direction', 'ease'];
  const TR_DEFAULTS = p => ({ type: 'crossDissolve', duration: Math.round(p.fps / 2), align: 'center', color: '#000000', direction: 'left', ease: 'linear' });
  // side：'both' | 'out' | 'in'。單邊轉場的位置固定貼著邊緣（align 不影響位置）：新增或明確指定 align 時存成 'end'／'start'；
  // 從兩片段之間拉開變成單邊時保留原本的 align，重新接上時就回到原本的對齊方式。
  function cleanTransition(o, base, side, isNew) {
    const t = Object.assign({}, base);
    for (const k of TR_KEYS) if (o[k] !== undefined) t[k] = o[k];
    if (!TRANSITION_TYPES.includes(t.type)) bail('不認得的轉場種類');
    if (!['center', 'start', 'end'].includes(t.align)) bail('轉場對齊只能是置中、開頭或結尾');
    if (side !== 'both' && (isNew || o.align !== undefined)) t.align = side === 'out' ? 'end' : 'start';
    if (!['left', 'right', 'up', 'down'].includes(t.direction)) bail('轉場方向不正確');
    if (!['linear', 'easeInOut'].includes(t.ease)) bail('轉場曲線不正確');
    t.duration = Math.round(Number(t.duration));
    if (!isFinite(t.duration) || t.duration < 1) bail('轉場長度至少要 1 格');
    t.color = String(t.color || '#000000');
    return t;
  }
  // 加轉場（同 DaVinci：轉場屬於片段邊緣）：
  //   { leftClipId }：加在這個片段的結尾。後面緊接著同軌片段 → 兩片段之間；否則 → 尾端淡出（rightClipId = null）。
  //   { rightClipId }（不給 leftClipId）：加在這個片段的開頭。前面緊接著同軌片段 → 兩片段之間；否則（前面是空隙或時間軸起點）→ 開頭淡入（leftClipId = null）。
  // 這個邊緣（或剪接點兩側）已經有轉場時改成新的設定。長度會夾在片段長度內。
  const addTransition = guard((p, o = {}) => {
    let L, R;
    if (o.leftClipId) {
      L = needClips(p, o.leftClipId)[0];
      R = clipsOnTrack(p, L.trackId).find(c => c.id !== L.id && c.start === clipEnd(L)) || null;
    } else if (o.rightClipId) {
      R = needClips(p, o.rightClipId)[0];
      L = clipsOnTrack(p, R.trackId).find(c => c.id !== R.id && clipEnd(c) === R.start) || null;
    } else return fail('沒有指定要加轉場的片段');
    needUnlocked(p, [L, R].filter(Boolean));
    const side = L && R ? 'both' : L ? 'out' : 'in';
    const olds = Object.values(p.transitions).filter(x => (L && x.leftClipId === L.id) || (R && x.rightClipId === R.id));
    const old = olds.find(x => L && x.leftClipId === L.id) || olds[0];
    const t = cleanTransition(o, TR_DEFAULTS(p), side, true);
    return tx(p, q => {
      for (const x of olds) delete q.transitions[x.id];
      const id = old ? old.id : newId(q, 'x');
      const own = L || R;
      q.transitions[id] = Object.assign({ id, trackId: own.trackId, leftClipId: L ? L.id : null, rightClipId: R ? R.id : null }, t);
      return { id, side };
    });
  });
  const updateTransition = guard((p, id, patch = {}) => {
    const cur = p.transitions[id];
    if (!cur) return fail('找不到這個轉場');
    needUnlocked(p, [p.clips[cur.leftClipId], p.clips[cur.rightClipId]].filter(Boolean));
    const t = cleanTransition(patch, cur, transitionSide(cur), false);
    return tx(p, q => { Object.assign(q.transitions[id], t); return { id }; });
  });
  const removeTransition = guard((p, id) => {
    const cur = p.transitions[id];
    if (!cur) return fail('找不到這個轉場');
    return tx(p, q => { delete q.transitions[id]; return {}; });
  });

  // ---- 屬性 ------------------------------------------------------------------------
  const PROP_KEYS = ['name', 'enabled', 'video', 'audio', 'title', 'solidColor', 'keyframes', 'retime'];
  function sanitize(c) {
    const num = (o, k, a, b, int) => {
      if (!o || o[k] === undefined) return;
      let v = Number(o[k]);
      if (!isFinite(v)) bail(`數值不正確：${k}`);
      if (int) v = Math.round(v);
      o[k] = clamp(v, a, b);
    };
    if (c.video) {
      const tf = c.video.transform || bail('變形設定不正確');
      for (const k of ['zoomX', 'zoomY']) num(tf, k, 0.01, 100);
      for (const k of ['posX', 'posY', 'anchorX', 'anchorY']) num(tf, k, -1e5, 1e5);
      num(tf, 'rotation', -36000, 36000);
      num(tf, 'opacity', 0, 1);
      for (const k of ['zoomLinked', 'flipH', 'flipV']) tf[k] = !!tf[k];
      const cr = c.video.crop || bail('裁切設定不正確');
      for (const k of ['left', 'right', 'top', 'bottom', 'softness']) num(cr, k, 0, 1);
      if (cr.left + cr.right > 0.99) cr.right = Math.max(0, 0.99 - cr.left);
      if (cr.top + cr.bottom > 0.99) cr.bottom = Math.max(0, 0.99 - cr.top);
      if (!['fit', 'fill', 'stretch'].includes(c.video.fit)) bail('縮放方式只能是符合、填滿或延展');
    }
    if (c.audio) {
      const a = c.audio;
      num(a, 'gainDb', -60, 24); num(a, 'pan', -1, 1);
      num(a, 'fadeIn', 0, 1e9, true); num(a, 'fadeOut', 0, 1e9, true);
      num(a, 'fadeInCurve', -1, 1); num(a, 'fadeOutCurve', -1, 1);
      if (a.eq && Array.isArray(a.eq.bands)) for (const b of a.eq.bands) { num(b, 'freq', 10, 24000); num(b, 'gain', -30, 30); num(b, 'q', 0.05, 30); }
    }
    if (c.title) { num(c.title, 'size', 1, 2000); num(c.title, 'x', -1, 2); num(c.title, 'y', -1, 2); num(c.title, 'lineHeight', 0.5, 5); c.title.text = String(c.title.text == null ? '' : c.title.text); }
    c.enabled = !!c.enabled;
    c.name = String(c.name || '').slice(0, 200);
  }
  // 深層合併 video／audio／title；ids 可以是一個或多個（檢查器多選時）
  const setClipProps = guard((p, ids, patch = {}) => {
    const clips = needClips(p, ids);
    needUnlocked(p, clips);
    const bad = Object.keys(patch).find(k => !PROP_KEYS.includes(k));
    if (bad) return fail(`「${bad}」不能用屬性面板修改`);
    for (const c of clips) {
      if (patch.video && !c.video) return fail('音訊片段沒有畫面屬性');
      if (patch.audio && !c.audio) return fail('這個片段沒有聲音屬性');
      if (patch.title && c.type !== 'title') return fail('只有標題片段可以改文字設定');
      if (patch.solidColor !== undefined && c.type !== 'solid') return fail('只有色塊片段可以改顏色');
    }
    return tx(p, q => {
      for (const c of clips) { const k = q.clips[c.id]; deepMerge(k, patch); sanitize(k); }
      return {};
    });
  });

  // =====================================================================================
  // 復原／重做
  // =====================================================================================
  const bus = typeof EventTarget === 'function' ? new EventTarget() : null;
  function emit(detail) {
    if (!bus) return;
    let e;
    if (typeof CustomEvent === 'function') e = new CustomEvent('change', { detail });
    else { e = new Event('change'); e.detail = detail; }
    bus.dispatchEvent(e);
  }

  // run(label, fn)：fn(project) 回 { ok:false } 或丟錯時整個還原；有變動才記一筆復原。
  // 拖曳中（live）用 begin(label) … 直接呼叫操作 … end()：整段只記一筆；cancel() 回到 begin 前。
  // 復原／重做會就地換掉 project 的內容（物件本身不變），再呼叫 setProject(project) 通知。
  function createHistory(getProject, setProject, opts = {}) {
    const limit = opts.limit || 100;
    let undoS = [], redoS = [], pending = null;
    const push = (label, snap) => { undoS.push({ label, snap }); if (undoS.length > limit) undoS.shift(); redoS = []; };
    function restore(snap) {
      const cur = getProject(), next = deserialize(snap);
      if (cur && typeof cur === 'object') { replaceInPlace(cur, next); if (setProject) setProject(cur); } else if (setProject) setProject(next);
    }
    return {
      run(label, fn) {
        const before = serialize(getProject());
        let r;
        try { r = fn(getProject()); } catch (e) { if (serialize(getProject()) !== before) restore(before); throw e; }
        if (r && r.ok === false) { if (serialize(getProject()) !== before) restore(before); return r; }
        if (!pending && serialize(getProject()) !== before) push(label, before);
        emit({ label });
        return r === undefined ? { ok: true } : r;
      },
      begin(label) { if (!pending) pending = { label, snap: serialize(getProject()) }; },
      end() {
        if (!pending) return false;
        const pd = pending; pending = null;
        const changed = serialize(getProject()) !== pd.snap;
        if (changed) push(pd.label, pd.snap);
        emit({ label: pd.label });
        return changed;
      },
      cancel() {
        if (!pending) return;
        const pd = pending; pending = null;
        if (serialize(getProject()) !== pd.snap) restore(pd.snap);
        emit({ label: pd.label, cancel: true });
      },
      undo() {
        if (pending || !undoS.length) return false;      // 拖曳／調整中（begin 之後）不能復原：不然 end／cancel 會把專案和復原堆疊弄亂
        const e = undoS.pop();
        redoS.push({ label: e.label, snap: serialize(getProject()) });
        restore(e.snap);
        emit({ label: e.label, undo: true });
        return true;
      },
      redo() {
        if (pending || !redoS.length) return false;
        const e = redoS.pop();
        undoS.push({ label: e.label, snap: serialize(getProject()) });
        restore(e.snap);
        emit({ label: e.label, redo: true });
        return true;
      },
      get busy() { return !!pending; },                 // begin 之後、end／cancel 之前
      get canUndo() { return undoS.length > 0; },
      get canRedo() { return redoS.length > 0; },
      get undoLabel() { return undoS.length ? undoS[undoS.length - 1].label : ''; },
      get redoLabel() { return redoS.length ? redoS[redoS.length - 1].label : ''; },
      clear() { undoS = []; redoS = []; pending = null; },
    };
  }

  const api = {
    // 常數、預設值
    FPS_CHOICES, ASPECTS, MARKER_COLORS, TRANSITION_TYPES, EDIT_MODES, IMAGE_DEFAULT_SEC, DEFAULT_FREEZE_SEC, SPEED_MIN, SPEED_MAX,
    defaultVideo, defaultAudio, defaultTitle, defaultTransform, defaultEq, snapFps,
    // 專案、軌道、媒體
    createProject, clone, serialize, deserialize,
    addTrack, removeTrack, setTrackProps, getTrack, tracksOf,
    registerMediaInfo, unregisterMediaInfo, setAspect,
    // 查詢
    getClip, clipEnd, clipsOnTrack, clipAt, clipsAt, projectDuration, linkedClips, expandLinked, linkOffset,
    sourceTimeAt, sourceSpan, maxExtend, snapTargets, snap, transitionRange, transitionsOfClip, transitionSide, transitionAtEdge,
    audioTransitionPlan, transitionFadeGain,
    checkInvariants,
    // 編輯
    moveClips, trimEdge, blade, rippleTrim, rippleDelete, deleteGap, lift, roll, slip, slide,
    setInOut, clearInOut, editToTimeline, addClip, link, unlink,
    addMarker, updateMarker, removeMarker, addClipMarker, updateClipMarker, removeClipMarker, setFlags,
    setSpeed, freezeFrame, addTransition, updateTransition, removeTransition, setClipProps,
    // 復原
    createHistory, bus,
  };
  Q.core = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
