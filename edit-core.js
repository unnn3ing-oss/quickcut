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
  const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '4:5': [1080, 1350], '1:1': [1080, 1080] };
  // 片段放進輸出畫面的方式：fit＝完整（黑邊）、blur＝完整＋同一畫面的模糊放大當背景、fill＝填滿（裁切）、stretch＝拉伸
  const FIT_MODES = ['fit', 'blur', 'fill', 'stretch'];
  // 濾鏡（video.look）：none＝原色、warm＝暖陽、cool＝冷調、mono＝黑白；video.lookAmt 0~100（強度，預設 100）
  const LOOKS = ['none', 'warm', 'cool', 'mono', 'mist', 'film'];
  // 可以打關鍵影格的參數 → [最小, 最大]（和 sanitize 的範圍一致）。f 是「片段內影格」（0 = 片段第一格），
  //   可以超出片段範圍（修剪、切開後留著，邊界附近的內插才不會變）。
  const KF_PATHS = {
    'video.transform.zoomX': [0.01, 100], 'video.transform.zoomY': [0.01, 100],
    'video.transform.posX': [-1e5, 1e5], 'video.transform.posY': [-1e5, 1e5],
    'video.transform.rotation': [-36000, 36000], 'video.transform.opacity': [0, 1],
    'video.transform.anchorX': [-1e5, 1e5], 'video.transform.anchorY': [-1e5, 1e5],
    'video.crop.left': [0, 1], 'video.crop.right': [0, 1], 'video.crop.top': [0, 1], 'video.crop.bottom': [0, 1],
  };
  // 兩個關鍵影格之間怎麼走：linear＝等速、ease＝緩入緩出、hold＝停在前一格的值直到下一格
  const KF_INTERPS = ['linear', 'ease', 'hold'];
  // 節拍標記：一般的時間軸標記，用名稱認（使用者也可以自己改名字讓它變回普通標記）
  const BEAT_NAME = '節拍', BEAT_COLOR = 'yellow';
  const MAX_SIDE = 3840;                  // 'source' 比例的長邊上限
  const MARKER_COLORS = ['blue', 'cyan', 'green', 'yellow', 'red', 'pink', 'purple', 'fuchsia', 'rose', 'lavender', 'sky', 'mint', 'lemon', 'sand', 'cocoa', 'cream'];
  const TRANSITION_TYPES = ['crossDissolve', 'dipToColor', 'fadeToBlack', 'wipe', 'push', 'slide', 'zoom', 'blur',
    // 3.20 的 WebGL 轉場（edit-fx-gl.js）
    'whip', 'flash', 'glitch', 'zoomPunch', 'spin', 'lightLeak', 'blinds', 'pixelate', 'flip', 'cube', 'doors',
    // 4.20 拆解參考影片加的（edit-fx.js，2D）
    'invertFlash', 'lineSweep'];
  // 有自己預設顏色的轉場（其他都是黑色）：閃光預設白光、光漏預設暖橘
  const TRANSITION_COLORS = { flash: '#ffffff', lightLeak: '#ff7a2e', lineSweep: '#ffffff' };
  const transitionColor = type => TRANSITION_COLORS[type] || '#000000';
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

  // ---- 曲線變速（Speed Ramp）-------------------------------------------------------
  // c.retime = { preset, strength, base, points: [{ u, s }] }
  //   u：片段內位置的比例（0＝第一格、1＝結尾），遞增，頭尾一定是 0 和 1
  //   s：相對 c.speed 的倍率，點與點之間線性變化；整段平均一定是 1，
  //     所以「片段長度 × c.speed」仍是總來源用量（srcLen、修剪、連結、媒體長度檢查都照舊），曲線只改片段內的快慢分配。
  //   真正的速度＝c.speed × s；base＝套曲線前的基準速度（換別的曲線或取消時回到它）。
  //   片段外（轉場借用的把手）用頭尾的速度延伸。
  function rtSpeed(pts, u) {
    if (u <= pts[0].u) return pts[0].s;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (u <= b.u) return b.u > a.u ? a.s + (b.s - a.s) * (u - a.u) / (b.u - a.u) : b.s;
    }
    return pts[pts.length - 1].s;
  }
  // ∫₀ᵘ s（u 可以小於 0 或大於 1）
  function rtIntegral(pts, u) {
    if (u <= 0) return u * pts[0].s;
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], w = b.u - a.u;
      if (w <= 0) continue;
      if (u <= b.u) { const x = u - a.u, sx = a.s + (b.s - a.s) * x / w; return acc + (a.s + sx) / 2 * x; }
      acc += (a.s + b.s) / 2 * w;
    }
    return acc + (u - 1) * pts[pts.length - 1].s;
  }
  const ramped = c => !!(c && c.retime && Array.isArray(c.retime.points) && c.retime.points.length >= 2 && !c.reverse && !c.freeze);
  // 片段內第 x 格（可以有小數、可以超出片段）相對 srcIn 用掉的來源秒數
  const srcOffset = (p, c, x) => (ramped(c) ? c.speed / p.fps * c.duration * rtIntegral(c.retime.points, x / c.duration) : x * c.speed / p.fps);
  // 時間軸第 frame 格的相對速度倍率（沒有曲線＝1）；預覽播放、聲音排程用
  const retimeFactor = (c, frame) => (ramped(c) ? rtSpeed(c.retime.points, (frame - c.start) / c.duration) : 1);
  // 把片段裁成「片段內 [a, b) 格」（a 可以 < 0、b 可以 > 長度：用頭尾速度延伸）。曲線黏在來源上：
  //   裁完之後每一格看到的畫面和裁之前一樣（切開、修剪都用這支）。呼叫端自己改 start。
  function retimeCrop(p, c, a, b) {
    const pts = c.retime.points, D = c.duration, ua = a / D, ub = b / D;
    const T = D * (rtIntegral(pts, ub) - rtIntegral(pts, ua));   // 這段用掉的「基準格數」
    const Dn = b - a;
    if (!(T > 0) || Dn < 1) bail('曲線變速的片段至少要 1 格');
    c.srcIn = r9(c.srcIn + c.speed / p.fps * D * rtIntegral(pts, ua));
    const k = Dn / T;
    const us = [ua, ...pts.map(q => q.u).filter(u => u > ua + 1e-9 && u < ub - 1e-9), ub];
    const np = us.map(u => ({ u: r9((u - ua) / (ub - ua)), s: r9(rtSpeed(pts, u) * k) }));
    np[0].u = 0; np[np.length - 1].u = 1;
    c.speed = c.speed * T / Dn;
    c.duration = Dn;
    c.retime = np.every(q => Math.abs(q.s - 1) < 1e-4) ? null : Object.assign({}, c.retime, { points: np });
  }
  // 有時間軸的來源（影片、音訊）：修剪、切開、滑移時要跟著調整 srcIn；圖片、標題、色塊不用
  const timed = (p, c) => { const m = mediaOf(p, c); return c.type === 'media' && !(m && m.kind === 'image'); };

  // 這一格要顯示的來源秒數。frame 是時間軸影格，可以超出片段範圍（轉場向把手借畫面時），結果夾在媒體範圍內。
  //   正播：srcIn + (frame-start) × speed / fps（有曲線變速時是速度曲線的積分，見 srcOffset）
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
    else t = c.srcIn + srcOffset(p, c, local);
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
    const edgeS = ramped(c) ? c.retime.points[edge === 'start' ? 0 : c.retime.points.length - 1].s : 1;
    return Math.max(0, Math.floor(room * p.fps / (c.speed * edgeS) + EPS));
  }

  // 連結片段的同步位置：同一個來源、同速度時用「來源對齊」算（J-cut／L-cut 不算不同步），否則比 start
  function anchor(p, c) {
    if (c.type !== 'media' || c.freeze) return c.start;
    const k = p.fps / c.speed;
    return c.reverse ? c.start + c.duration + c.srcIn * k : c.start - c.srcIn * k;
  }
  const sameSource = (a, b) => a.type === 'media' && b.type === 'media' && a.mediaId === b.mediaId && a.speed === b.speed && !!a.reverse === !!b.reverse && !a.freeze && !b.freeze && !ramped(a) && !ramped(b);
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
      if (c.retime) {
        const pts = c.retime.points;
        const okPts = Array.isArray(pts) && pts.length >= 2 && pts[0].u === 0 && pts[pts.length - 1].u === 1 &&
          pts.every((x, i) => x.s > 0 && isFinite(x.s) && (!i || x.u >= pts[i - 1].u));
        if (!okPts || Math.abs(rtIntegral(pts, 1) - 1) > 1e-3) add('retime', `${nm}的變速曲線不正確`);
        else if (c.reverse || c.freeze) add('retime', `${nm}不能同時倒播（或定格）和曲線變速`);
      }
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
    if (ramped(c) && timed(p, c)) {               // 曲線變速：裁切曲線（曲線黏在來源上，延長的部分用頭尾速度）
      if (edge === 'start') {
        retimeCrop(p, c, -delta, c.duration);
        c.start -= delta;
        for (const m of c.markers) m.offset += delta;
        shiftKeyframes(c, delta);
      } else retimeCrop(p, c, 0, c.duration + delta);
      return;
    }
    const ds = c.freeze || !timed(p, c) ? 0 : delta * c.speed / p.fps;
    if (edge === 'start') {
      c.start -= delta; c.duration += delta;
      if (!c.reverse) c.srcIn = r9(c.srcIn - ds);
      for (const m of c.markers) m.offset += delta;
      shiftKeyframes(c, delta);
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
    const wasRamped = ramped(c) && timed(p, c);
    if (wasRamped) {                              // 曲線變速：兩半各自裁出自己那段曲線
      r.duration = c.duration;
      retimeCrop(p, r, leftDur, leftDur + rightDur);
      retimeCrop(p, c, 0, leftDur);
    } else c.duration = leftDur;
    if (!wasRamped && !c.freeze && timed(p, c)) {
      const s = c.speed / p.fps;
      if (c.reverse) c.srcIn = r9(c.srcIn + rightDur * s);   // 倒播：前半段顯示的是較晚的來源
      else r.srcIn = r9(c.srcIn + leftDur * s);
    }
    c.markers = c.markers.filter(m => m.offset < leftDur);
    r.markers = r.markers.filter(m => m.offset >= leftDur).map(m => Object.assign(m, { offset: m.offset - leftDur }));
    shiftKeyframes(r, -leftDur);
    pruneKeyframes(c); pruneKeyframes(r);
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

  // ---- 關鍵影格的時間調整（片段內影格跟著內容走）---------------------------------------
  function eachKeyframes(c, fn) {
    if (!c.keyframes) return;
    for (const path of Object.keys(c.keyframes)) {
      const a = c.keyframes[path];
      if (Array.isArray(a) && a.length) fn(a, path); else delete c.keyframes[path];
    }
  }
  // 片段開頭往前／往後長了 delta 格：原本的畫面在片段內的位置跟著移
  function shiftKeyframes(c, delta) { if (delta) eachKeyframes(c, a => { for (const k of a) k.f += delta; }); }
  // 長度改變（變速）：關鍵影格依比例伸縮
  function scaleKeyframes(c, ratio) {
    if (ratio === 1 || !isFinite(ratio)) return;
    eachKeyframes(c, a => {
      for (const k of a) k.f = Math.round(k.f * ratio);
      dedupeKeys(a);
    });
  }
  function dedupeKeys(a) {
    a.sort((x, y) => x.f - y.f);
    for (let i = a.length - 1; i > 0; i--) if (a[i].f === a[i - 1].f) a.splice(i - 1, 1);
  }
  // 切開後：只留片段範圍內的，加上兩側各最近的一個（片段內的內插結果完全不變）
  function pruneKeyframes(c) {
    eachKeyframes(c, (a, path) => {
      a.sort((x, y) => x.f - y.f);
      const inside = a.filter(k => k.f >= 0 && k.f < c.duration);
      const before = a.filter(k => k.f < 0).pop(), after = a.find(k => k.f >= c.duration);
      const keep = [before, ...inside, after].filter(Boolean);
      if (keep.length) c.keyframes[path] = keep; else delete c.keyframes[path];
    });
  }
  // 在片段內第 f 格的值（關鍵影格內插）；fx.getParam 也用這支，預覽和匯出一致
  function keyframeValue(kfs, f) {
    const a = kfs.slice().sort((p, q) => p.f - q.f);
    if (f <= a[0].f) return a[0].v;
    const last = a[a.length - 1];
    if (f >= last.f) return last.v;
    for (let i = 0; i < a.length - 1; i++) {
      const k0 = a[i], k1 = a[i + 1];
      if (f >= k0.f && f < k1.f) {
        if (k0.interp === 'hold' || typeof k0.v !== 'number' || typeof k1.v !== 'number') return k0.v;
        let u = (f - k0.f) / (k1.f - k0.f);
        if (k0.interp === 'ease') u = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
        return k0.v + (k1.v - k0.v) * u;
      }
    }
    return last.v;
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
        Object.assign(t, { type: 'media', mediaId: o.mediaId, srcIn: Math.max(0, ns), speed: 1, reverse: false, freeze: false, retime: null, name, title: null, solidColor: null });
        for (const x of partners) {
          const k = q.clips[x.id];
          const kt = getTrack(q, k.trackId);
          if (info.kind === 'video' && kt.kind === 'audio') {
            if (info.hasAudio) Object.assign(k, { mediaId: o.mediaId, srcIn: r9(Math.max(0, ns + (k.start - t.start) / fps)), speed: 1, reverse: false, freeze: false, retime: null, name });
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
  // ---- 節拍標記與卡點 ---------------------------------------------------------------
  const isBeat = m => m.name === BEAT_NAME;
  const beatFrames = p => p.markers.filter(isBeat).map(m => m.frame).sort((a, b) => a - b);
  // 一次加一批節拍標記（一筆復原）。o.replace（預設 true）：先清掉舊的節拍標記；同一格已經有標記就略過
  const addBeatMarkers = guard((p, frames, o = {}) => {
    const list = [...new Set(arr(frames).map(f => Math.round(Number(f))).filter(f => isFinite(f) && f >= 0))].sort((a, b) => a - b);
    if (!list.length) return fail('沒有找到節拍');
    return tx(p, q => {
      if (o.replace !== false) q.markers = q.markers.filter(m => !isBeat(m));
      const used = new Set(q.markers.map(m => m.frame));
      let count = 0;
      for (const f of list) {
        if (used.has(f)) continue;
        used.add(f); count++;
        q.markers.push({ id: newId(q, 'k'), frame: f, duration: 0, color: BEAT_COLOR, name: BEAT_NAME, note: '' });
      }
      return { count };
    }, { lockCheck: false });
  });
  const clearBeatMarkers = guard(p => {
    const n = p.markers.filter(isBeat).length;
    if (!n) return fail('時間軸上沒有節拍標記');
    return tx(p, q => { q.markers = q.markers.filter(m => !isBeat(m)); return { count: n }; }, { lockCheck: false });
  });

  // 卡點：把選取的片段（同一條軌）依時間順序排到節拍上，每段長度＝ every 拍。
  //   第一段的開頭不動，結尾對齊開頭之後的第一個節拍（太近、不到半段長就用下一個）；接著每段佔 every 拍。
  //   影片素材不夠長時用到最長，後面留空隙（回傳 short）；節拍不夠時剩下的片段照原長度接在後面（回傳 extra）。
  //   連結的聲音跟著移；同一軌、排序範圍後面沒選到的片段整批往前／往後推，不會被蓋掉。
  //   o.beats：節拍影格（省略＝時間軸上的節拍標記）；o.every：每幾拍換一段（預設 1）
  const fitClipsToBeats = guard((p, ids, o = {}) => {
    const sel = needClips(p, ids);
    const byTrack = new Map();
    for (const c of sel) { if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []); byTrack.get(c.trackId).push(c); }
    const order = id => p.tracks.findIndex(t => t.id === id);
    const tid = [...byTrack.keys()].sort((a, b) => byTrack.get(b).length - byTrack.get(a).length || order(a) - order(b))[0];
    const clips = byTrack.get(tid).slice().sort((a, b) => a.start - b.start);
    if (clips.length < 1) return fail('先選取要卡點的片段');
    const every = Math.max(1, Math.round(Number(o.every) || 1));
    const beats = (o.beats ? arr(o.beats).map(Number) : beatFrames(p)).map(Math.round).filter(isFinite).sort((a, b) => a - b);
    if (!beats.length) return fail('時間軸上還沒有節拍標記：先偵測節拍或在播放時按 M 打拍子');
    const first = clips[0].start;
    const ahead = beats.filter(f => f > first);
    if (!ahead.length) return fail('第一段片段之後沒有節拍標記');
    // 第一段至少要有半段長（避免開頭剛好差一點點就到拍子，變成一閃而過的短片段）
    const gaps = ahead.slice(1).map((f, i) => f - ahead[i]).sort((a, b) => a - b);
    const seg = (gaps.length ? gaps[Math.floor(gaps.length / 2)] : ahead[0] - first) * every;
    let k = ahead.findIndex(f => f - first >= seg / 2);
    if (k < 0) k = ahead.length - 1;
    const bounds = [first];
    for (let i = k; i < ahead.length; i += every) bounds.push(ahead[i]);
    const group = new Set(clips.map(c => c.id));
    for (const c of clips) for (const x of linkedClips(p, c.id)) group.add(x.id);
    needUnlocked(p, [...group].map(i => p.clips[i]));
    const oldEnd = clipEnd(clips[clips.length - 1]);
    // 範圍內夾著沒選到的片段：不知道該放哪，請使用者處理
    const between = clipsOnTrack(p, tid).find(c => !group.has(c.id) && c.start < oldEnd && clipEnd(c) > first);
    if (between) return fail(`${clipLabel(between)}夾在選取的片段中間：一起選取，或先移開再卡點`);
    let short = 0, extra = 0;
    return tx(p, q => {
      let cursor = first;
      clips.forEach((c0, i) => {
        const c = q.clips[c0.id];
        let start, want;
        if (i + 1 < bounds.length) { start = bounds[i]; want = bounds[i + 1] - bounds[i]; }
        else { start = cursor; want = c.duration; extra++; }
        start = Math.max(start, cursor);
        const room = c.duration + maxExtend(q, c, 'end');
        let dur = Math.max(1, Math.min(want, room));
        if (dur < want) short++;
        const ds = start - c.start, dd = dur - c.duration;
        for (const x of linkedClips(q, c.id)) {
          const same = x.start === c.start && x.duration === c.duration;
          x.start += ds;
          if (same) adjustEdge(q, x, 'end', dd);
        }
        c.start = start;
        adjustEdge(q, c, 'end', dd);
        cursor = start + dur;
      });
      // 轉場：兩邊不再相鄰就拿掉；變短的片段放不下就縮短轉場
      for (const tr of Object.values(q.transitions)) {
        const L = tr.leftClipId && q.clips[tr.leftClipId], R = tr.rightClipId && q.clips[tr.rightClipId];
        if (!(group.has(tr.leftClipId) || group.has(tr.rightClipId))) continue;
        if (L && R && R.start !== clipEnd(L)) { delete q.transitions[tr.id]; continue; }
        const max = L && R ? Math.min(L.duration, R.duration) : (L || R).duration;
        if (tr.duration > max) tr.duration = max;
      }
      const delta = cursor - oldEnd;
      if (delta) {
        const shifts = {};
        const tracks = new Set([...group].map(i => q.clips[i].trackId));
        for (const k of Object.values(q.clips)) if (!group.has(k.id) && tracks.has(k.trackId) && k.start >= oldEnd) shifts[k.id] = delta;
        applyShifts(q, shifts, group);
      }
      return { count: clips.length, short, extra, end: cursor };
    });
  });

  // ---- 一鍵成片（4.10） --------------------------------------------------------------
  // 風格：every＝每幾拍換一段（有音樂時）；sec＝沒有音樂時每段幾秒；motions 依序輪流套用；
  //   trans：轉場種類／顏色／秒數，transEvery＝每幾個剪接點放一個（其餘直接切）；look：濾鏡；fade：開頭結尾淡入淡出（秒）
  const AUTO_STYLES = {
    beat: { name: '節奏感', every: 2, sec: 1.2, motions: ['zoomIn', 'zoomOut'], trans: { type: 'dipToColor', color: '#ffffff', sec: 0.27 }, transEvery: 2, look: null, lookAmt: 0, fade: 0 },
    gentle: { name: '溫柔回憶', every: 4, sec: 3, motions: ['zoomIn', 'panLeft', 'zoomOut', 'panRight'], trans: { type: 'crossDissolve', sec: 0.6 }, transEvery: 1, look: 'warm', lookAmt: 50, fade: 0.5 },
    cinema: { name: '電影感', every: 4, sec: 3.5, motions: ['zoomIn'], trans: { type: 'dipToColor', color: '#000000', sec: 0.5 }, transEvery: 1, look: 'cool', lookAmt: 40, fade: 1 },
  };
  // o：{ mediaIds（影片／圖片，依序）, musicId（音訊或有聲影片；null＝不要音樂）, beats（音樂裡的拍點，來源秒數）, style }
  // 從時間軸目前的結尾開始排：影片／圖片接在第一條影片軌；有音樂時放第二條音訊軌（沒有就新增），素材原聲不放；
  // 沒音樂時素材原聲放第一條音訊軌。每段長度跟著拍子（每 every 拍換一段；素材少時加倍到最多 8 拍，盡量配滿整首歌；
  // 拍點用完就照平均間隔往後推）；
  // 影片取中段、太短就整段用（之後的段落接著排）。比例不合用模糊背景；動態、轉場、濾鏡依風格。整批一筆復原。
  const autoEdit = guard((p, o = {}) => {
    const st = AUTO_STYLES[o.style || 'beat'];
    if (!st) return fail('不認得的風格');
    const ids = arr(o.mediaIds);
    const infos = ids.map(id => p.mediaInfo && p.mediaInfo[id]);
    if (!ids.length) return fail('先選要用的影片或照片');
    const badI = infos.findIndex(m => !m || (m.kind !== 'video' && m.kind !== 'image'));
    if (badI >= 0) return fail(infos[badI] ? `「${infos[badI].name || '這個素材'}」不是影片或照片` : '找不到素材的資訊，請重新匯入');
    const music = o.musicId ? p.mediaInfo && p.mediaInfo[o.musicId] : null;
    if (o.musicId && (!music || music.kind === 'image' || (music.kind === 'video' && music.hasAudio === false))) return fail('選的音樂沒有聲音');
    const fps = p.fps;
    return tx(p, q => {
      let vt = tracksOf(q, 'video')[0];
      let at = tracksOf(q, 'audio');
      if (!vt) bail('沒有影片軌');
      if (music && !at[1]) { pushTrack(q, 'audio'); at = tracksOf(q, 'audio'); }
      const musicT = music ? at[1] : null, origT = music ? null : at[0] || null;
      const used = [vt, musicT, origT].filter(Boolean);
      for (const t of used) if (t.locked) bail(`「${t.name}」軌已鎖定，不能放上去`);
      const start = used.reduce((m, t) => clipsOnTrack(q, t.id).reduce((n, c) => Math.max(n, clipEnd(c)), m), 0);
      // 段落邊界（時間軸影格）
      const musicLen = music ? Math.floor(music.duration * fps + EPS) : 0;
      let beats = music ? arr(o.beats).map(Number).filter(t => isFinite(t) && t > 0 && t < music.duration).sort((a, b) => a - b).map(t => start + Math.round(t * fps)) : [];
      beats = beats.filter((f, i) => i === 0 || f > beats[i - 1]);
      const gaps = beats.slice(1).map((f, i) => f - beats[i]).sort((a, b) => a - b);
      // 素材少、歌比較長：每段多幾拍（風格拍數的倍數，最多 8 拍），盡量配滿整首歌
      const every = beats.length ? Math.max(st.every, Math.min(Math.max(8, st.every), st.every * Math.floor(beats.length / ids.length / st.every))) : st.every;
      const nominal = Math.max(2, gaps.length ? gaps[Math.floor(gaps.length / 2)] * every : Math.round(st.sec * fps));
      const marks = [];
      if (beats.length) {
        // 第一個切點：最接近「開頭＋一段長」的拍子（拍點不一定從 0 秒開始）
        let k = -1;
        beats.forEach((f, i) => { if (f - start >= nominal / 2 && (k < 0 || Math.abs(f - start - nominal) < Math.abs(beats[k] - start - nominal))) k = i; });
        if (k >= 0) for (let i = k; i < beats.length; i += every) marks.push(beats[i]);
      }
      const nextMark = cur => {
        const m = marks.find(f => f - cur >= nominal / 2);
        if (m != null) return m;
        if (!marks.length) return cur + nominal;            // 沒有拍點：固定長度
        const last = marks.length ? marks[marks.length - 1] : start;
        let f = last;
        while (f - cur < nominal / 2) f += nominal;
        return f;
      };
      let cursor = start;
      const vids = [];
      ids.forEach((id, i) => {
        const m = infos[i];
        let dur = nextMark(cursor) - cursor;
        let srcIn = 0;
        if (m.kind === 'video') {
          const avail = Math.floor(m.duration * fps + EPS);
          if (avail < 1) return;
          if (avail < dur) dur = avail;
          srcIn = r9(Math.max(0, (m.duration - dur / fps) / 2));
        }
        const r = editToTimeline(q, { mode: 'overwrite', mediaId: id, srcIn, srcOut: srcIn + dur / fps + (m.kind === 'video' ? EPS : 0), frame: cursor, ignoreInOut: true,
          trackIds: { video: vt.id, audio: m.kind === 'video' && m.hasAudio !== false && origT ? origT.id : null }, name: m.name });
        if (!r.ok) bail(r.reason);
        const v = r.ids.find(x => q.clips[x].trackId === vt.id);
        for (const x of r.ids) if (q.clips[x].duration !== dur) adjustEdge(q, q.clips[x], 'end', dur - q.clips[x].duration);
        vids.push(v);
        cursor += dur;
      });
      if (!vids.length) bail('選的素材都太短');
      const end = cursor;
      // 畫面：比例不合→模糊背景；濾鏡
      const mis = new Set(aspectMismatch(q).ids);
      for (const id of vids) {
        const c = q.clips[id];
        if (mis.has(id)) c.video.fit = 'blur';
        if (st.look) { c.video.look = st.look; c.video.lookAmt = st.lookAmt; }
      }
      // 動態
      vids.forEach((id, i) => { const r = applyKeyframePreset(q, id, st.motions[i % st.motions.length]); if (!r.ok) bail(r.reason); });
      // 轉場（放不下就略過）；開頭結尾淡入淡出
      const tlen = Math.max(1, Math.round(st.trans.sec * fps));
      for (let i = 0; i + 1 < vids.length; i++) {
        if ((i + 1) % st.transEvery) continue;
        const L = q.clips[vids[i]], R = q.clips[vids[i + 1]];
        if (clipEnd(L) !== R.start || Math.min(L.duration, R.duration) < tlen * 2) continue;
        addTransition(q, Object.assign({ leftClipId: L.id, duration: tlen, align: 'center' }, st.trans.color ? { type: st.trans.type, color: st.trans.color } : { type: st.trans.type }));
      }
      if (st.fade) {
        const fl = Math.round(st.fade * fps);
        const a = q.clips[vids[0]], z = q.clips[vids[vids.length - 1]];
        if (a.start === start && a.duration > fl * 2) addTransition(q, { rightClipId: a.id, type: 'dipToColor', color: '#000000', duration: fl });
        if (z.duration > fl * 2) addTransition(q, { leftClipId: z.id, type: 'dipToColor', color: '#000000', duration: fl });
      }
      // 音樂：從開頭放到影片結尾（音樂比較短就放完為止），最後淡出
      let musicId = null;
      if (music) {
        const len = Math.min(musicLen, end - start);
        if (len >= 1) {
          const r = editToTimeline(q, { mode: 'overwrite', mediaId: o.musicId, srcIn: 0, srcOut: len / fps + EPS, frame: start, ignoreInOut: true, trackIds: { video: null, audio: musicT.id }, name: music.name });
          if (!r.ok) bail(r.reason);
          musicId = r.ids[0];
          const mc = q.clips[musicId];
          if (mc.duration > len) adjustEdge(q, mc, 'end', len - mc.duration);
          mc.audio.fadeOut = Math.min(Math.round(1.5 * fps), Math.floor(mc.duration / 3));
        }
      }
      return { ids: vids, musicId, start, end, count: vids.length, every };
    });
  });

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
    if (rev && ramped(c)) return fail('曲線變速的片段不能倒播：先取消曲線變速');
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
          const src = o.srcFrames && o.srcFrames[g] != null ? o.srcFrames[g] : k.duration * k.speed;   // 來源用量（影格）
          let nd = Math.max(1, Math.round(src / sp));
          const D = finiteDur(q, k);
          if (D != null && k.srcIn + nd * sp / q.fps > D + EPS) nd = Math.max(1, Math.floor((D - k.srcIn) * q.fps / sp + EPS));
          if (g === c.id) delta = nd - k.duration;
          scaleKeyframes(k, nd / k.duration);
          k.duration = nd;
        }
        if (ramped(k)) k.retime.base = r9(k.retime.base * sp / k.speed);   // 整條曲線一起變快／變慢
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

  // 曲線變速：o：{ preset, strength（0~1，預設 1）, points（自訂：[[u, 真正速度倍率], …]）, base（基準速度，預設沿用）, ripple, linked }
  //   速度倍率是相對「基準速度」（套曲線前的速度，例如 100%）。套用後 c.speed＝平均速度，
  //   ripple：來源用量不變、片段長度跟著變（慢動作會變長）並推後方；否則長度不變、改用的來源長度（受媒體長度限制）。
  //   預設曲線的控制點之間用緩入緩出補點，速度變化是平滑的。
  const RETIME_PRESETS = {
    slowMid: [[0, 1], [0.2, 1], [0.35, 0.3], [0.65, 0.3], [0.8, 1], [1, 1]],          // 中段慢動作（中間 30% 的時間用 30% 速度）
    bullet: [[0, 2], [0.28, 2], [0.42, 0.15], [0.58, 0.15], [0.72, 2], [1, 2]],       // 子彈時間：快→極慢→快
    speedUp: [[0, 0.5], [1, 2.5]],                                                    // 漸漸加速
    slowDown: [[0, 2.5], [1, 0.5]],                                                   // 漸漸減速
    flashIn: [[0, 4], [0.3, 1], [1, 1]],                                              // 快速切入
    flashOut: [[0, 1], [0.7, 1], [1, 4]],                                             // 快速切出
  };
  // 控制點 → 平滑的折線（每段用 smoothstep 補 8 點）；strength 在對數空間往 1 靠（0＝沒有變化）
  function retimeCurve(ctrl, strength) {
    const k = clamp(strength == null ? 1 : Number(strength), 0, 1);
    const pts = [];
    for (let i = 0; i < ctrl.length; i++) {
      const [u0, s0] = ctrl[i];
      pts.push([u0, s0]);
      if (i + 1 < ctrl.length) {
        const [u1, s1] = ctrl[i + 1];
        if (Math.abs(s1 - s0) > 1e-9) for (let j = 1; j < 8; j++) { const x = j / 8, e = x * x * (3 - 2 * x); pts.push([u0 + (u1 - u0) * x, s0 + (s1 - s0) * e]); }
      }
    }
    return pts.map(([u, v]) => [u, Math.exp(k * Math.log(v))]);
  }
  // 曲線變速前的來源用量（影格）：長度四捨五入會吃掉零頭，記下原本的值，取消／換曲線時才回得去原長度。
  // 片段長度變過（修剪、分割、改基準速度）就不準了，改用目前的長度×速度
  function rtSrcFrames(p, group) {
    const out = {};
    for (const g of group) {
      const k = p.clips[g];
      out[g] = ramped(k) && isFinite(k.retime.src) && k.retime.len === k.duration ? k.retime.src : k.duration * k.speed;
    }
    return out;
  }
  function rtGroup(p, c, linked) {
    return expandLinked(p, [c.id], linked !== false).filter(i => {
      const k = p.clips[i]; const km = mediaOf(p, k);
      return k.type === 'media' && km && km.kind !== 'image' && !k.freeze;
    });
  }
  const setRetime = guard((p, id, o = {}) => {
    const c = needClips(p, id)[0];
    const m = mediaOf(p, c);
    if (c.type !== 'media' || !m || m.kind === 'image') return fail('只有影片和音訊片段可以曲線變速');
    if (c.freeze) return fail('定格片段不能變速');
    if (c.reverse) return fail('倒播的片段不能曲線變速：先取消倒播');
    let ctrl = o.points;
    if (!ctrl) { ctrl = RETIME_PRESETS[o.preset]; if (!ctrl) return fail('不認得的變速曲線'); }
    ctrl = arr(ctrl).map(x => [Number(x[0]), Number(x[1])]);
    if (ctrl.length < 2 || ctrl[0][0] !== 0 || ctrl[ctrl.length - 1][0] !== 1 || ctrl.some((x, i) => !(x[1] > 0) || !isFinite(x[1]) || (i && !(x[0] > ctrl[i - 1][0]))))
      return fail('變速曲線的點不正確');
    const curve = retimeCurve(ctrl, o.strength);
    const base = o.base != null ? Number(o.base) : ramped(c) ? c.retime.base : c.speed;
    if (!(base > 0) || !isFinite(base)) return fail('基準速度不正確');
    const mean = rtIntegral(curve.map(([u, v]) => ({ u, s: v })), 1);
    const lo = Math.min(...curve.map(x => x[1])) * base, hi = Math.max(...curve.map(x => x[1])) * base;
    if (lo < SPEED_MIN - EPS || hi > SPEED_MAX + EPS) return fail(`曲線裡的速度要在 ${SPEED_MIN * 100}%～${SPEED_MAX * 100}% 之間`);
    const group = rtGroup(p, c, o.linked);
    const retime = { preset: o.points ? 'custom' : o.preset, strength: clamp(o.strength == null ? 1 : Number(o.strength), 0, 1), base,
      points: curve.map(([u, v]) => ({ u: r9(u), s: r9(v / mean) })) };
    const r = tx(p, q => {
      const src = rtSrcFrames(q, group);
      for (const g of group) q.clips[g].retime = null;            // 先拿掉舊曲線，讓 setSpeed 用一般的方式算長度
      const sr = setSpeed(q, c.id, { speed: base * mean, ripple: o.ripple, linked: o.linked, srcFrames: src });
      if (!sr.ok) return sr;
      for (const g of group) { const k = q.clips[g]; k.retime = Object.assign(copy(retime), { src: src[g], len: k.duration }); }
      return { duration: q.clips[c.id].duration, mean: r9(mean) };
    });
    if (!r.ok && /來源媒體的長度不夠/.test(r.reason)) r.reason = '來源媒體的長度不夠，可以勾選「波紋」讓片段長度跟著變';
    return r;
  });
  // 取消曲線變速：回到基準速度（ripple 時長度跟著變）
  const clearRetime = guard((p, id, o = {}) => {
    const c = needClips(p, id)[0];
    if (!ramped(c)) return fail('這個片段沒有曲線變速');
    const group = rtGroup(p, c, o.linked);
    const base = c.retime.base;
    return tx(p, q => {
      const src = rtSrcFrames(q, group);
      for (const g of group) q.clips[g].retime = null;
      const sr = setSpeed(q, c.id, { speed: base, ripple: o.ripple, linked: o.linked, srcFrames: src });
      return sr.ok ? { duration: q.clips[c.id].duration } : sr;
    });
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
      return tx(p, q => { Object.assign(q.clips[c.id], { freeze: true, srcIn: t, speed: 1, reverse: false, retime: null }); return { id: c.id }; });
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
    // 沒指定顏色時：新轉場用該類型的預設色；改類型時，原本是舊類型的預設色才跟著換（使用者自己挑的顏色保留）
    if (o.color === undefined && (isNew || (t.type !== base.type && String(base.color || '#000000').toLowerCase() === transitionColor(base.type)))) t.color = transitionColor(t.type);
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
  const PROP_KEYS = ['name', 'enabled', 'video', 'audio', 'title', 'solidColor', 'keyframes'];   // 曲線變速走 setRetime
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
      if (!FIT_MODES.includes(c.video.fit)) bail('縮放方式只能是符合、模糊背景、填滿或延展');
      num(c.video, 'bgBlur', 0, 100);
      if (c.video.look != null && !LOOKS.includes(c.video.look)) bail('濾鏡只能是原色、暖陽、冷調或黑白');
      num(c.video, 'lookAmt', 0, 100);
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

  // ---- 關鍵影格 ----------------------------------------------------------------------
  // values：{ path: 值 }，一次設定多個參數（例如連結縮放時 zoomX＋zoomY）在片段內第 f 格。
  //   那一格已經有關鍵影格就改值；沒有就新增。interp 省略時：改值保留原本的、新增用前一個關鍵影格的（都沒有就 linear）。
  const readPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  function writePath(o, path, v) {
    const ks = path.split('.');
    let t = o;
    for (const k of ks.slice(0, -1)) t = t[k];
    t[ks[ks.length - 1]] = v;
  }
  function kfClip(p, id) {
    const c = needClips(p, id)[0];
    needUnlocked(p, [c]);
    if (!c.video) bail('這個片段沒有畫面，不能打關鍵影格');
    return c;
  }
  const kfFrame = (c, f) => {
    f = Math.round(Number(f));
    if (!isFinite(f) || f < 0 || f >= c.duration) bail('播放頭要在這個片段的範圍內才能打關鍵影格');
    return f;
  };
  const kfPaths = paths => {
    const list = arr(paths);
    if (!list.length) bail('沒有指定要打關鍵影格的參數');
    for (const x of list) if (!KF_PATHS[x]) bail(`「${x}」不能打關鍵影格`);
    return list;
  };
  const setKeyframe = guard((p, id, f, values = {}, interp) => {
    const c = kfClip(p, id);
    f = kfFrame(c, f);
    const paths = kfPaths(Object.keys(values));
    if (interp != null && !KF_INTERPS.includes(interp)) return fail('內插方式只能是等速、緩入緩出或停格');
    const vals = {};
    for (const x of paths) {
      const v = Number(values[x]);
      if (!isFinite(v)) return fail(`數值不正確：${x}`);
      vals[x] = clamp(v, KF_PATHS[x][0], KF_PATHS[x][1]);
    }
    return tx(p, q => {
      const k = q.clips[c.id];
      k.keyframes = k.keyframes || {};
      for (const x of paths) {
        const a = k.keyframes[x] = Array.isArray(k.keyframes[x]) ? k.keyframes[x] : [];
        const cur = a.find(e => e.f === f);
        if (cur) { cur.v = vals[x]; if (interp) cur.interp = interp; }
        else {
          const prev = a.filter(e => e.f < f).sort((m, n) => n.f - m.f)[0];
          a.push({ f, v: vals[x], interp: interp || (prev && prev.interp) || 'linear' });
          a.sort((m, n) => m.f - n.f);
        }
      }
      return { f };
    });
  });
  // 和 setClipProps 一樣，但「已經有關鍵影格的參數」改成在時間軸第 frame 格（播放頭）新增／修改關鍵影格，
  //   其他參數照常改靜態值。詳細內容和預覽畫面上的拖曳都走這支，有動畫的參數才不會改了沒反應。
  function leafPaths(o, pre, out) {
    for (const k of Object.keys(o)) {
      const v = o[k], path = pre ? pre + '.' + k : k;
      if (isObj(v)) leafPaths(v, path, out); else out.push([path, v]);
    }
    return out;
  }
  const setClipPropsAt = guard((p, ids, patch = {}, frame) => {
    const clips = needClips(p, ids);
    const leaves = leafPaths(patch, '', []);
    const animated = c => leaves.filter(([x]) => KF_PATHS[x] && c.keyframes && Array.isArray(c.keyframes[x]) && c.keyframes[x].length);
    if (!clips.some(c => animated(c).length)) return setClipProps(p, ids, patch);
    const pre = setClipProps(copy(p), ids, patch);    // 只借它的檢查（在副本上跑）
    if (!pre.ok) return pre;
    for (const c of clips) {
      if (!animated(c).length) continue;
      const f = Math.round(Number(frame)) - c.start;
      if (!(f >= 0 && f < c.duration)) return fail('這個參數有關鍵影格：先把播放頭移到片段上再調整');
    }
    return tx(p, q => {
      for (const c of clips) {
        const k = q.clips[c.id], an = animated(c);
        // 靜態值：有動畫的參數不改（只寫關鍵影格），其他照常改
        const rest = copy(patch);
        for (const [x] of an) {
          const ks = x.split('.'); let o = rest;
          for (const kk of ks.slice(0, -1)) o = o && o[kk];
          if (o) delete o[ks[ks.length - 1]];
        }
        deepMerge(k, rest); sanitize(k);
        const f = Math.round(Number(frame)) - c.start;
        for (const [x, v0] of an) {
          const v = clamp(Number(v0), KF_PATHS[x][0], KF_PATHS[x][1]);
          if (!isFinite(v)) bail(`數值不正確：${x}`);
          const a = k.keyframes[x], cur = a.find(e => e.f === f);
          if (cur) cur.v = v;
          else {
            const prev = a.filter(e => e.f < f).sort((m, n) => n.f - m.f)[0];
            a.push({ f, v, interp: (prev && prev.interp) || 'linear' });
            a.sort((m, n) => m.f - n.f);
          }
        }
      }
      return {};
    });
  });
  // 刪掉第 f 格的關鍵影格；某個參數的最後一個被刪掉時，靜態值改成那一格的值（畫面不會突然跳回舊值）
  const removeKeyframe = guard((p, id, f, paths) => {
    const c = kfClip(p, id);
    f = Math.round(Number(f));
    const list = kfPaths(paths).filter(x => c.keyframes && Array.isArray(c.keyframes[x]) && c.keyframes[x].some(e => e.f === f));
    if (!list.length) return fail('這一格沒有關鍵影格');
    return tx(p, q => {
      const k = q.clips[c.id];
      for (const x of list) {
        const a = k.keyframes[x], gone = a.find(e => e.f === f);
        k.keyframes[x] = a.filter(e => e.f !== f);
        if (!k.keyframes[x].length) { delete k.keyframes[x]; writePath(k, x, gone.v); }
      }
      sanitize(k);
      return {};
    });
  });
  // 清掉這些參數的所有關鍵影格；靜態值改成片段內第 f 格（通常是播放頭）看到的值
  const clearKeyframes = guard((p, id, paths, f = 0) => {
    const c = kfClip(p, id);
    const all = paths ? kfPaths(paths) : Object.keys(c.keyframes || {}).filter(x => KF_PATHS[x]);
    const list = all.filter(x => c.keyframes && Array.isArray(c.keyframes[x]) && c.keyframes[x].length);
    if (!list.length) return fail('沒有關鍵影格可以清除');
    return tx(p, q => {
      const k = q.clips[c.id];
      for (const x of list) { writePath(k, x, keyframeValue(k.keyframes[x], Number(f) || 0)); delete k.keyframes[x]; }
      sanitize(k);
      return {};
    });
  });
  // 改第 f 格關鍵影格「到下一格」的走法
  const setKeyframeInterp = guard((p, id, f, interp, paths) => {
    const c = kfClip(p, id);
    if (!KF_INTERPS.includes(interp)) return fail('內插方式只能是等速、緩入緩出或停格');
    f = Math.round(Number(f));
    const all = paths ? kfPaths(paths) : Object.keys(c.keyframes || {});
    const list = all.filter(x => c.keyframes && Array.isArray(c.keyframes[x]) && c.keyframes[x].some(e => e.f === f));
    if (!list.length) return fail('這一格沒有關鍵影格');
    return tx(p, q => { for (const x of list) q.clips[c.id].keyframes[x].find(e => e.f === f).interp = interp; return {}; });
  });
  // 片段所有關鍵影格的位置（片段內影格，排序、去重，只含片段範圍內）；paths 省略＝全部參數
  function keyframeFrames(c, paths) {
    const s = new Set();
    for (const x of paths ? arr(paths) : Object.keys((c && c.keyframes) || {})) {
      const a = c && c.keyframes && c.keyframes[x];
      if (Array.isArray(a)) for (const e of a) if (e.f >= 0 && e.f < c.duration) s.add(e.f);
    }
    return Array.from(s).sort((a, b) => a - b);
  }
  // 一鍵動畫：在片段頭尾各打一組關鍵影格（緩入緩出）。kind：zoomIn 慢慢放大、zoomOut 慢慢縮小、panLeft／panRight 左右平移
  const KF_PRESETS = ['zoomIn', 'zoomOut', 'panLeft', 'panRight'];
  const applyKeyframePreset = guard((p, id, kind, o = {}) => {
    const c = kfClip(p, id);
    if (!KF_PRESETS.includes(kind)) return fail('不認得的動畫種類');
    const amt = clamp(Number(o.amount) || 0.15, 0.02, 1);
    const last = c.duration - 1;
    if (last < 1) return fail('片段太短，至少要 2 格才能做動畫');
    const z = readPath(c, 'video.transform.zoomX') || 1;
    const shift = Math.round((p.width || 1080) * amt / 2), px = Number(readPath(c, 'video.transform.posX')) || 0;
    const plan = {
      zoomIn: { 'video.transform.zoomX': [z, z * (1 + amt)], 'video.transform.zoomY': [z, z * (1 + amt)] },
      zoomOut: { 'video.transform.zoomX': [z * (1 + amt), z], 'video.transform.zoomY': [z * (1 + amt), z] },
      panLeft: { 'video.transform.zoomX': [z * (1 + amt), z * (1 + amt)], 'video.transform.zoomY': [z * (1 + amt), z * (1 + amt)], 'video.transform.posX': [px + shift, px - shift] },
      panRight: { 'video.transform.zoomX': [z * (1 + amt), z * (1 + amt)], 'video.transform.zoomY': [z * (1 + amt), z * (1 + amt)], 'video.transform.posX': [px - shift, px + shift] },
    }[kind];
    return tx(p, q => {
      const k = q.clips[c.id];
      k.keyframes = k.keyframes || {};
      for (const x of ['video.transform.zoomX', 'video.transform.zoomY', 'video.transform.posX']) delete k.keyframes[x];
      for (const [x, [a, b]] of Object.entries(plan)) {
        k.keyframes[x] = [{ f: 0, v: r9(a), interp: 'ease' }, { f: last, v: r9(b), interp: 'ease' }];
      }
      k.video.transform.zoomLinked = true;
      return {};
    });
  });

  // ---- 比例轉換 ----------------------------------------------------------------------
  // 時間軸上影片軌的「影片／圖片」片段（不含字幕、色塊）
  function mediaVisualClips(p) {
    return Object.values(p.clips).filter(c => {
      if (c.type !== 'media' || !c.mediaId || !c.video) return false;
      const t = getTrack(p, c.trackId), m = p.mediaInfo && p.mediaInfo[c.mediaId];
      return t && t.kind === 'video' && m && (m.kind === 'video' || m.kind === 'image');
    });
  }
  // 比例和輸出畫面差超過 5%、而且還是「符合（黑邊）」的片段：換比例後會出現大片黑邊，介面據此詢問要不要一次改掉
  function aspectMismatch(p) {
    const out = p.width / p.height;
    const ids = mediaVisualClips(p).filter(c => {
      const m = p.mediaInfo[c.mediaId];
      if (!(m.width > 0 && m.height > 0)) return false;
      const fit = (c.video && c.video.fit) || 'fit';
      return fit === 'fit' && Math.abs(m.width / m.height - out) / out > 0.05;
    }).map(c => c.id);
    return { count: ids.length, ids };
  }
  // 一次把所有影片／圖片片段改成同一種畫面符合方式（鎖定軌上的略過），整批只算一次編輯
  const setFitAll = guard((p, fit) => {
    if (!FIT_MODES.includes(fit)) return fail('縮放方式只能是符合、模糊背景、填滿或延展');
    const ids = mediaVisualClips(p).filter(c => !getTrack(p, c.trackId).locked).map(c => c.id);
    if (!ids.length) return fail('時間軸上沒有可以套用的影片或圖片片段');
    const r = setClipProps(p, ids, { video: { fit } });
    return r.ok ? { ok: true, count: ids.length } : r;
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
    FPS_CHOICES, ASPECTS, FIT_MODES, LOOKS, MARKER_COLORS, TRANSITION_TYPES, TRANSITION_COLORS, transitionColor, EDIT_MODES, IMAGE_DEFAULT_SEC, DEFAULT_FREEZE_SEC, SPEED_MIN, SPEED_MAX,
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
    autoEdit, AUTO_STYLES, setSpeed, setRetime, clearRetime, RETIME_PRESETS, retimeCurve, retimeFactor, srcOffset, freezeFrame, addTransition, updateTransition, removeTransition, setClipProps, setFitAll, aspectMismatch,
    // 節拍
    BEAT_NAME, beatFrames, addBeatMarkers, clearBeatMarkers, fitClipsToBeats,
    // 關鍵影格
    KF_PATHS, KF_INTERPS, KF_PRESETS, keyframeValue, keyframeFrames, setKeyframe, setClipPropsAt, removeKeyframe, clearKeyframes, setKeyframeInterp, applyKeyframePreset,
    // 復原
    createHistory, bus,
  };
  Q.core = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
