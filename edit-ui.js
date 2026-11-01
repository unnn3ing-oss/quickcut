// =====================================================================================
// 剪輯：介面
//
// 把 core（時間軸引擎）、render（播放與合成）、fx（變形／轉場／字幕與詳細內容）、exporter（匯出）接成一個畫面：
//   媒體庫（媒體／轉場／字幕）｜檢視器（來源／時間軸）｜詳細內容　→　工具列　→　多軌時間軸。
// 這支只管「畫面與操作」：所有剪輯邏輯都在 core，這裡一律透過 history.run／begin…end 呼叫，
// core 回傳 ok:false 時把 reason 顯示在狀態列。拖曳時用 history.begin 起頭、每次移動「回到起點再套用一次總位移」
// （cancel＋begin＋操作），放開時 end()，所以整段拖曳只留下一筆復原。
//
// 重要約定（見 DESIGN.md「剪輯」）：
//   - 不長期握著 clip 物件（操作成功後 core 會換掉子物件），一律用 id 重新查。
//   - 時間軸位置是整數影格；來源時間是秒。畫面上的像素 ↔ 影格只在 xToFrame／frameToX 換算。
//   - 媒體資訊（core.registerMediaInfo）不在復原範圍內，復原後由 ensureMediaInfo 補回。
//   - 其他模組（core／render／fx）在載入時不假設存在，這支在 init 時才讀 Q.xxx。
//
// 拆檔（3.10 之後）：這支只放共用的常數、狀態、小工具與浮動視窗；各區塊在 edit-ui-*.js，載入順序：
//   edit-ui.js → media → viewer → actions → timeline → inspector → main（main 最後，負責 init 與公開 API）。
//   檔案之間透過 QPTEdit.uiParts（各檔案裡叫 UI）共用：前面檔案的東西在檔頭解構進來；後面檔案的函式、
//   以及跨檔案會被重新指定的變數（player、drag…）一律寫成 UI.xxx，用到時才讀。core／render／fx 每個檔案
//   各留一份 C／R／F，init 時由 UI.bindModules() 一起設定。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit = root.QPTEdit || {};
  const doc = root.document;
  const app = doc && doc.getElementById('editApp');
  if (!app) { Q.ui = { state: null }; return; }
  // 拆出去的各檔案共用的地方（見檔頭）；binders：init 時設定各檔案的 C／R／F
  const UI = Q.uiParts = { binders: [] };
  UI.bindModules = () => { for (const f of UI.binders) f(); };
  const $ = id => doc.getElementById(id);

  // ---- 常數 ------------------------------------------------------------------------
  const HEAD_W = 150;                 // 軌道標頭寬度
  const RULER_H = 26;                 // 時間尺高度
  const VIDEO_H = 52, AUDIO_H = 40;   // 軌道高度
  const EDGE_PX = 8;                  // 片段邊緣的判定寬度
  const SNAP_PX = 9;                  // 吸附距離（螢幕像素）
  const DRAG_PX = 3;                  // 超過這麼多像素才算拖曳
  const ZOOM_MIN = 3;                 // 時間軸縮放（每秒幾像素）
  const SPEEDS = [1, 2, 4];           // L／J 連按的倍速

  const MARKER_HEX = {
    blue: '#3b82f6', cyan: '#06b6d4', green: '#22c55e', yellow: '#eab308', red: '#ef4444', pink: '#ec4899', purple: '#8b5cf6', fuchsia: '#d946ef',
    rose: '#fb7185', lavender: '#b7a8f5', sky: '#7dd3fc', mint: '#86efac', lemon: '#fde047', sand: '#d6c19a', cocoa: '#8b5e3c', cream: '#f5e9c8',
  };
  const MARKER_NAME = {
    blue: '藍', cyan: '青', green: '綠', yellow: '黃', red: '紅', pink: '粉紅', purple: '紫', fuchsia: '洋紅',
    rose: '玫瑰', lavender: '薰衣草', sky: '天藍', mint: '薄荷', lemon: '檸檬', sand: '沙色', cocoa: '可可', cream: '奶油',
  };
  const KIND_NAME = { video: '影片', audio: '音訊', image: '圖片' };
  const EQ_TYPES = [['highpass', '高通'], ['lowpass', '低通'], ['lowshelf', '低頻架'], ['highshelf', '高頻架'], ['peaking', '峰值'], ['notch', '陷波'], ['bandpass', '帶通']];

  // 小圖示（單色，跟著文字顏色）
  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4h4v16h-4zM13.5 4h4v16h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M5 4h2.2v16H5zM20 4.5v15L8.5 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16.8 4H19v16h-2.2zM4 4.5v15L15.5 12z"/></svg>',
    stepB: '<svg viewBox="0 0 24 24"><path d="M16 5l-9 7 9 7z"/></svg>',
    stepF: '<svg viewBox="0 0 24 24"><path d="M8 5l9 7-9 7z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M9 3v12.3A3.5 3.5 0 1 0 11 18.5V7h6V3z"/></svg>',
  };

  // ---- 小工具 ----------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = n => String(n).padStart(2, '0');
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = (name, cls) => { const s = el('span', 'ed-ic' + (cls ? ' ' + cls : '')); s.innerHTML = ICONS[name] || ''; return s; };
  // 時間碼 HH:MM:SS:FF（fps 取整數）
  function tc(frame, fps) {
    fps = Math.max(1, Math.round(fps) || 30);
    frame = Math.max(0, Math.round(frame) || 0);
    const s = Math.floor(frame / fps);
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(frame % fps)}`;
  }
  // 秒數 → 「1:23.4」「5.2 秒」
  function fmtSec(s) {
    if (!isFinite(s)) return '—';
    s = Math.max(0, s);
    if (s < 60) return `${+s.toFixed(1)} 秒`;
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${pad2(Math.floor(r))}`;
  }
  const fmtNum = (v, dec) => String(+Number(v).toFixed(dec));
  const isTextTarget = t => !!t && (t.tagName === 'INPUT' ? !/^(checkbox|radio|button|range|color|file)$/.test(t.type) : (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));

  // 模組（在 init 時填入）
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

  // ---- 狀態 ------------------------------------------------------------------------
  const state = {
    project: null, history: null,
    selection: new Set(),            // 選取的片段 id
    primary: null,                   // 詳細內容顯示的片段（最後一次點的那個）
    selTransition: null,             // 選取的轉場 id（詳細內容顯示轉場）
    selMedia: null,                  // 媒體庫選取的媒體 id
    tool: 'select',                  // 'select' | 'blade' | 'trim'（trim 依游標位置自動變成波紋／滾動／滑移／滑動）
    linkedSelection: true, snapping: true,
    sourceInOut: null,               // { mediaId, srcIn, srcOut }（秒）
    zoom: 60,                        // 時間軸縮放：每秒幾像素
    mode: 'timeline',                // 檢視器：'timeline' | 'source'
    sourceMedia: null,               // 來源檢視器載入的媒體 id
    playhead: 0,                     // 時間軸播放頭（影格）
    srcFrame: 0,                     // 來源播放頭（影格，以來源專案的 fps）
    targets: { video: null, audio: null },   // 插入／覆蓋的目的軌道（空 = 第一條）
    rippleSpeed: true,               // 變速對話框的預設：波紋
    dirty: false,                    // 有改動但還沒匯出（beforeunload 用）
    importing: false,
    theme: 'dark',                   // 'dark' | 'light'：介面外觀（預設深色，選擇記在 localStorage）
    vertPref: true,                  // 直式專案時是否把檢視器放到整頁左側（預設開，選擇記在 localStorage）
    vertPrefH: false,                // 橫式（含正方形）專案的同一個選擇，預設關
    cols: {},                        // 使用者拖過的欄寬（px）：mw 媒體庫、iw 詳細內容、vw 直式版面左欄、vmw 直式版面的媒體庫
    mediaView: 'list',               // 媒體庫顯示方式：list 列表／grid 網格
  };
  Q.ui = { state, get player() { return UI.player; }, say: (m, k) => say(m, k) };

  // ---- 偏好（localStorage）：讀寫都可能丟錯（無痕、被封鎖），一律包 try/catch，讀不到就用預設 ----------
  const THEME_KEY = 'qc-theme', VERT_KEY = 'qc-vert', VERT_H_KEY = 'qc-vert-h', SAFE_KEY = 'qc-safe', COLS_KEY = 'qc-cols', MVIEW_KEY = 'qc-mview';
  const lsGet = k => { try { return root.localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { root.localStorage.setItem(k, v); } catch (_) { /* 存不了就算了，只是下次不記得 */ } };
  state.theme = lsGet(THEME_KEY) === 'light' ? 'light' : 'dark';
  state.vertPref = lsGet(VERT_KEY) !== '0';
  state.vertPrefH = lsGet(VERT_H_KEY) === '1';
  state.cols = (() => { try { const o = JSON.parse(lsGet(COLS_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } })();
  state.mediaView = lsGet(MVIEW_KEY) === 'grid' ? 'grid' : 'list';
  state.safePref = lsGet(SAFE_KEY) === '1';
  doc.documentElement.setAttribute('data-ed-theme', state.theme);

  // canvas 用的顏色：從 CSS 變數讀（edit.css 的 :root／深色覆寫），主題換了就重讀、重畫
  const colors = { rev: 0, sig: '', wave: 'rgba(255,255,255,.78)', waveThumb: 'rgba(255,255,255,.9)', audio: '#2f9e8a', thumbBg: '#cfd9ea', phVideo: '#6f8fc9', phMissing: '#8895ad', titleA: '#8b6fd6', titleB: '#5a43a8' };
  function readColors() {
    const cs = root.getComputedStyle(app), g = (n, d) => cs.getPropertyValue(n).trim() || d;
    const next = {
      wave: g('--ed-wave', colors.wave), waveThumb: g('--ed-wave-thumb', colors.waveThumb), audio: g('--ed-audio', colors.audio), thumbBg: g('--ed-thumb-bg', colors.thumbBg),
      phVideo: g('--ed-ph-video', colors.phVideo), phMissing: g('--ed-ph-missing', colors.phMissing), titleA: g('--ed-title-a', colors.titleA), titleB: g('--ed-title-b', colors.titleB),
    };
    const sig = JSON.stringify(next);
    if (sig === colors.sig) return false;
    Object.assign(colors, next); colors.sig = sig; colors.rev++;
    return true;
  }

  function newProject() {
    state.project = C.createProject({ videoTracks: 2, audioTracks: 2 });
    state.history = C.createHistory(() => state.project, p => { state.project = p; }, { limit: 100 });
  }

  UI.player = null;                 // render.createPlayer
  UI.srcProject = null;             // 來源模式用的暫時專案（只有這一個媒體）
  UI.statusEl = null; let statusTimer = 0;

  // 狀態列：訊息會自動消失；kind = 'error' | 'ok' | ''
  function say(msg, kind) {
    if (!UI.statusEl) return;
    UI.statusEl.textContent = msg || '';
    UI.statusEl.dataset.kind = kind || '';
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(() => { UI.statusEl.textContent = ''; UI.statusEl.dataset.kind = ''; }, kind === 'error' ? 10000 : 5500);
  }
  // core 操作的結果：失敗時顯示原因
  function report(r, okMsg) {
    if (!r || r.ok === false) { say((r && r.reason) || '這個操作無法執行', 'error'); return false; }
    if (okMsg) say(okMsg, 'ok');
    return true;
  }

  // ---- 專案存取 --------------------------------------------------------------------
  const fps = () => state.project.fps;
  const clipOf = id => state.project.clips[id] || null;
  const trackOf = id => C.getTrack(state.project, id);
  const selIds = () => [...state.selection].filter(id => state.project.clips[id]);
  const lastSel = () => { if (state.primary && state.selection.has(state.primary) && state.project.clips[state.primary]) return state.primary; const a = selIds(); return a.length ? a[a.length - 1] : null; };
  const mediaOf = id => (R && R.media.get(id)) || null;
  const isSubClip = c => !!(c && c.type === 'title' && c.title && c.title.sub);
  const clipTitle = c => {
    if (!c) return '';
    if (isSubClip(c)) { const t = F.parseAccent(c.title.text).text.split('\n')[0].trim(); if (t) return t.length > 24 ? t.slice(0, 24) + '…' : t; }   // 字幕清單的片段：時間軸上直接顯示字幕內容
    const m = c.mediaId && mediaOf(c.mediaId);
    // 開啟專案後還沒重新連結的素材：用存檔裡的檔名，並標示「缺少素材」（片段自己有名字也一樣標）
    const info = !m && c.type === 'media' && c.mediaId && state.project && state.project.mediaInfo && state.project.mediaInfo[c.mediaId];
    if (info) return `${c.name || info.name || '片段'}（缺少素材）`;
    if (c.name) return c.name;
    if (m) return m.name;
    return c.type === 'title' ? '字幕' : c.type === 'solid' ? '色塊' : '片段';
  };
  const videoTracksTopFirst = () => C.tracksOf(state.project, 'video').slice().reverse();   // 畫面上方的影片軌（高層）在前

  // 目的軌道：使用者點過的軌道標頭；沒有（或已被刪掉）就用第一條
  function targetTrack(kind) {
    const p = state.project;
    const t = state.targets[kind] && C.getTrack(p, state.targets[kind]);
    return (t && t.kind === kind ? t : C.tracksOf(p, kind)[0]) || null;
  }

  // ---- 彈出視窗與右鍵選單 ----------------------------------------------------------
  UI.popEl = null; UI.menuEl = null;
  function closePop() { UI.flushPop(); if (UI.popEl) { UI.popEl.remove(); UI.popEl = null; } }
  function closeMenu() { if (UI.menuEl) { UI.menuEl.remove(); UI.menuEl = null; } }
  function placeFloating(node, x, y) {
    node.style.left = '0px'; node.style.top = '0px';
    const w = node.offsetWidth, h = node.offsetHeight, vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    node.style.left = clamp(x, 8, Math.max(8, vw - w - 8)) + 'px';
    node.style.top = clamp(y, 8, Math.max(8, vh - h - 8)) + 'px';
  }
  // 小視窗內容變高之後（例如多出一列），往上挪到下緣還在畫面裡；太高時由 CSS 的 max-height 捲動
  function fitPop() {
    const n = UI.popEl;
    if (!n) return;
    const r = n.getBoundingClientRect(), vh = doc.documentElement.clientHeight;
    if (r.bottom > vh - 8) n.style.top = Math.max(8, vh - 8 - r.height) + 'px';
  }
  // 在 anchor（元素或座標）旁邊開一個小視窗；回傳視窗元素
  function openPop(anchor, node, cls) {
    closePop(); closeMenu();
    UI.popEl = el('div', 'ed-pop' + (cls ? ' ' + cls : ''));
    UI.popEl.appendChild(node);
    UI.popEl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } });
    app.appendChild(UI.popEl);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
    placeFloating(UI.popEl, r.left, r.bottom + 6);
    // 太靠下面放不下就改放上方
    const h = UI.popEl.offsetHeight, vh = doc.documentElement.clientHeight;
    if (r.bottom + 6 + h > vh - 8 && r.top - h - 6 > 8) UI.popEl.style.top = (r.top - h - 6) + 'px';
    return UI.popEl;
  }
  // items：[{ label, run, disabled, sep, hint }]
  function openMenu(x, y, items) {
    closePop(); closeMenu();
    UI.menuEl = el('div', 'ed-menu');
    UI.menuEl.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) { UI.menuEl.appendChild(el('div', 'ed-menu-sep')); continue; }
      const b = el('button', 'ed-menu-item'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.append(el('span', null, it.label));
      if (it.hint) b.append(el('span', 'ed-menu-hint', it.hint));
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      UI.menuEl.appendChild(b);
    }
    app.appendChild(UI.menuEl);
    placeFloating(UI.menuEl, x, y);
  }
  doc.addEventListener('pointerdown', e => {
    if (UI.popEl && !UI.popEl.contains(e.target) && !(e.target.closest && e.target.closest('[data-pop]'))) closePop();
    if (UI.menuEl && !UI.menuEl.contains(e.target)) closeMenu();
  }, true);
  doc.addEventListener('scroll', () => closeMenu(), true);

  Object.assign(UI, {
    $, AUDIO_H, COLS_KEY, DRAG_PX, EDGE_PX, EQ_TYPES, HEAD_W, ICONS, KIND_NAME, MARKER_HEX, MARKER_NAME, MVIEW_KEY,
    RULER_H, SAFE_KEY, SNAP_PX, SPEEDS, THEME_KEY, VERT_H_KEY, VERT_KEY, VIDEO_H, ZOOM_MIN, app, clamp, clipOf,
    clipTitle, closeMenu, closePop, colors, doc, el, fmtNum, fmtSec, fps, icon, isSubClip, isTextTarget, lastSel,
    lsSet, mediaOf, newProject, fitPop, openMenu, openPop, readColors, report, say, selIds, state, targetTrack, tc, trackOf,
    videoTracksTopFirst,
  });
})(typeof window !== 'undefined' ? window : globalThis);
