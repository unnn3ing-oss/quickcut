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
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit = root.QPTEdit || {};
  const doc = root.document;
  const app = doc && doc.getElementById('editApp');
  if (!app) { Q.ui = { state: null }; return; }
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
  Q.ui = { state, get player() { return player; }, say: (m, k) => say(m, k) };

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

  let player = null;                 // render.createPlayer
  let srcProject = null;             // 來源模式用的暫時專案（只有這一個媒體）
  let statusEl = null, statusTimer = 0;

  // 狀態列：訊息會自動消失；kind = 'error' | 'ok' | ''
  function say(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.dataset.kind = ''; }, kind === 'error' ? 10000 : 5500);
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
    if (c.name) return c.name;
    const m = c.mediaId && mediaOf(c.mediaId);
    return m ? m.name : (c.type === 'title' ? '字幕' : c.type === 'solid' ? '色塊' : '片段');
  };
  const videoTracksTopFirst = () => C.tracksOf(state.project, 'video').slice().reverse();   // 畫面上方的影片軌（高層）在前

  // 目的軌道：使用者點過的軌道標頭；沒有（或已被刪掉）就用第一條
  function targetTrack(kind) {
    const p = state.project;
    const t = state.targets[kind] && C.getTrack(p, state.targets[kind]);
    return (t && t.kind === kind ? t : C.tracksOf(p, kind)[0]) || null;
  }

  // ---- 彈出視窗與右鍵選單 ----------------------------------------------------------
  let popEl = null, menuEl = null;
  function closePop() { flushPop(); if (popEl) { popEl.remove(); popEl = null; } }
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function placeFloating(node, x, y) {
    node.style.left = '0px'; node.style.top = '0px';
    const w = node.offsetWidth, h = node.offsetHeight, vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    node.style.left = clamp(x, 8, Math.max(8, vw - w - 8)) + 'px';
    node.style.top = clamp(y, 8, Math.max(8, vh - h - 8)) + 'px';
  }
  // 在 anchor（元素或座標）旁邊開一個小視窗；回傳視窗元素
  function openPop(anchor, node, cls) {
    closePop(); closeMenu();
    popEl = el('div', 'ed-pop' + (cls ? ' ' + cls : ''));
    popEl.appendChild(node);
    popEl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } });
    app.appendChild(popEl);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
    placeFloating(popEl, r.left, r.bottom + 6);
    // 太靠下面放不下就改放上方
    const h = popEl.offsetHeight, vh = doc.documentElement.clientHeight;
    if (r.bottom + 6 + h > vh - 8 && r.top - h - 6 > 8) popEl.style.top = (r.top - h - 6) + 'px';
    return popEl;
  }
  // items：[{ label, run, disabled, sep, hint }]
  function openMenu(x, y, items) {
    closePop(); closeMenu();
    menuEl = el('div', 'ed-menu');
    menuEl.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) { menuEl.appendChild(el('div', 'ed-menu-sep')); continue; }
      const b = el('button', 'ed-menu-item'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.append(el('span', null, it.label));
      if (it.hint) b.append(el('span', 'ed-menu-hint', it.hint));
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      menuEl.appendChild(b);
    }
    app.appendChild(menuEl);
    placeFloating(menuEl, x, y);
  }
  doc.addEventListener('pointerdown', e => {
    if (popEl && !popEl.contains(e.target) && !(e.target.closest && e.target.closest('[data-pop]'))) closePop();
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);
  doc.addEventListener('scroll', () => closeMenu(), true);

  // =====================================================================================
  // 媒體庫（媒體／轉場／字幕）
  // =====================================================================================
  const lib = { tab: 'media', trans: 'crossDissolve', title: 'static', textFx: 'pop', tstyle: 'plain' };
  const FILE_ACCEPT = 'video/*,audio/*,image/*,.srt,.mkv,.mov,.m4a,.mp3,.wav,.flac,.opus,.ogg,.webm,.heic,.heif';

  function buildMediaPanel() {
    const host = $('edMedia');
    host.textContent = '';
    const tabs = el('div', 'ed-tabs'); tabs.setAttribute('role', 'tablist');
    for (const [k, t] of [['media', '媒體'], ['trans', '特效'], ['title', '字幕']]) {
      const b = el('button', 'ed-tab', t); b.type = 'button'; b.dataset.tab = k; b.setAttribute('role', 'tab');
      b.addEventListener('click', () => setLibTab(k));
      tabs.appendChild(b);
    }
    host.appendChild(tabs);

    const pm = el('div', 'ed-panel'); pm.dataset.panel = 'media';
    const drop = el('div', 'ed-drop'); drop.id = 'edDrop'; drop.tabIndex = 0; drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', '匯入媒體：拖放或選擇檔案');
    drop.innerHTML = '<strong>拖放檔案到這裡，或點擊選擇</strong><span>影片、音訊、圖片　·　也可以 Ctrl+V 貼上</span>';
    const input = el('input'); input.type = 'file'; input.id = 'edFile'; input.multiple = true; input.accept = FILE_ACCEPT; input.tabIndex = -1;
    drop.appendChild(input);
    drop.addEventListener('click', e => { if (e.target !== input) input.click(); });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { const f = [...input.files]; input.value = ''; importFiles(f); });
    const msgs = el('div', 'ed-msgs'); msgs.id = 'edMsgs'; msgs.setAttribute('aria-live', 'polite');
    const list = el('div', 'ed-mlist'); list.id = 'edMList';
    // 顯示方式：列表（縮圖＋完整資訊）／網格（大縮圖，資訊只留種類與長度）；選擇記在 localStorage
    const mbar = el('div', 'ed-mbar');
    const cnt = el('span', 'ed-mcount'); cnt.id = 'edMCount';
    const vseg = el('div', 'ed-seg small'); vseg.setAttribute('role', 'group'); vseg.setAttribute('aria-label', '媒體顯示方式');
    for (const [k, t, tip] of [['list', '列表', '列表顯示'], ['grid', '網格', '網格顯示（大縮圖）']]) {
      const b = el('button', 'ed-segbtn', t); b.type = 'button'; b.dataset.mview = k; b.title = tip;
      b.addEventListener('click', () => setMediaView(k));
      vseg.appendChild(b);
    }
    mbar.append(cnt, el('span', 'ed-spacer'), vseg);
    const foot = el('div', 'ed-mfoot', '單擊選取　雙擊在檢視器預覽（可設來源 In／Out）　拖到時間軸放入');
    pm.append(drop, msgs, mbar, list, foot);

    // 特效：轉場特效（加在剪接點）＋字體特效（加在字幕片段）。兩組都在同一個捲動面板裡
    const pt = el('div', 'ed-panel scroll'); pt.dataset.panel = 'trans'; pt.hidden = true;
    const tl = el('div', 'ed-glist static'); tl.id = 'edTransList';
    const ta = el('div', 'ed-pfoot');
    const tbIn = el('button', 'ed-btn'); tbIn.type = 'button'; tbIn.id = 'edTransAddIn'; tbIn.textContent = '加到開頭';
    tbIn.title = '把選取的轉場加到所選片段的開頭（和前一個片段之間；前面是空隙或時間軸起點時是淡入）';
    tbIn.addEventListener('click', () => addTransitionToSelection(lib.trans, 'start'));
    const tb = el('button', 'ed-btn primary'); tb.type = 'button'; tb.id = 'edTransAdd'; tb.textContent = '加到結尾';
    tb.title = '把選取的轉場加到所選片段的結尾（和下一個片段之間；沒有下一個片段時是淡出）';
    tb.addEventListener('click', () => addTransitionToSelection(lib.trans, 'end'));
    const tbs = el('div', 'ed-btnrow'); tbs.append(tbIn, tb);
    ta.append(tbs, el('span', 'ed-hint', '先選一個片段，按「加到開頭」或「加到結尾」；或把轉場拖到剪接點、片段的開頭或結尾。'));
    const xl = el('div', 'ed-glist static'); xl.id = 'edTextFxList';
    const xa = el('div', 'ed-pfoot');
    const xb = el('button', 'ed-btn primary'); xb.type = 'button'; xb.id = 'edTextFxApply'; xb.textContent = '套用到選取的字幕';
    xb.title = '把選取的字體特效套用到時間軸上選取的字幕片段';
    xb.addEventListener('click', () => applyTextFx(lib.textFx));
    xa.append(xb, el('span', 'ed-hint', '字幕出現時的動畫。選取字幕片段後按「套用」，或把特效拖到時間軸的字幕片段上；長度在詳細內容調整。'));
    pt.append(groupHead('轉場特效'), tl, ta, groupHead('字體特效'), xl, xa);

    const pg = el('div', 'ed-panel scroll'); pg.dataset.panel = 'title'; pg.hidden = true;
    const gl = el('div', 'ed-glist static'); gl.id = 'edTitleList';
    const ga = el('div', 'ed-pfoot');
    const gb = el('button', 'ed-btn primary'); gb.type = 'button'; gb.id = 'edTitleAdd'; gb.textContent = '在播放頭新增';
    gb.title = '在播放頭的位置新增選取樣式的字幕（放在最上層沒被佔用的影片軌）';
    gb.addEventListener('click', () => addTitle(lib.title));
    ga.append(gb, el('span', 'ed-hint', '字幕放在影片軌上，新增後在右側詳細內容改文字、字型、顏色。也可以把過場拖到時間軸。'));
    const sl = el('div', 'ed-glist static'); sl.id = 'edTStyleList';
    const sa = el('div', 'ed-pfoot');
    const sb = el('button', 'ed-btn primary'); sb.type = 'button'; sb.id = 'edTStyleApply'; sb.textContent = '套用到選取的字幕';
    sb.title = '把選取的字幕樣式套用到時間軸上選取的字幕片段';
    sb.addEventListener('click', () => applyTitleStyle(lib.tstyle));
    sa.append(sb, el('span', 'ed-hint', '顏色、描邊、外框、立體一次換好（不動文字與位置）。新增字幕也會用選取的樣式；可以把樣式拖到時間軸的字幕片段上。'));
    const ca = el('div', 'ed-pfoot');
    const cb = el('button', 'ed-btn'); cb.type = 'button'; cb.id = 'edSrtImport'; cb.textContent = '匯入 SRT';
    cb.title = '匯入 SRT 字幕檔：每一段變成「字幕」軌上的一個字幕片段';
    const ci = el('input'); ci.type = 'file'; ci.id = 'edSrtFile'; ci.accept = '.srt,application/x-subrip,text/plain'; ci.hidden = true; ci.tabIndex = -1;
    ci.addEventListener('change', () => { const f = ci.files && ci.files[0]; ci.value = ''; if (f) importSrt(f); });
    cb.addEventListener('click', () => ci.click());
    const ce = el('button', 'ed-btn'); ce.type = 'button'; ce.id = 'edSrtExport'; ce.textContent = '匯出 SRT';
    ce.title = '把「字幕」軌的字幕存成 SRT 檔（沒有字幕清單時，改匯出時間軸上所有有文字的字幕）';
    ce.addEventListener('click', () => exportSrt());
    const cm = el('button', 'ed-btn'); cm.type = 'button'; cm.textContent = '在播放頭標記（V）';
    cm.title = '在播放頭加一段字幕（快捷鍵 V），之後在右側詳細內容的「字幕清單」輸入文字';
    cm.addEventListener('click', () => markSubtitle());
    ca.append(cb, ce, cm, ci, el('span', 'ed-hint', '匯入／匯出 SRT，或邊播放邊按 V 標記每一句的開始時間，再到右側「字幕清單」一行一行輸入文字。每段預設 10 秒，碰到下一段就提早結束。'));
    pg.append(groupHead('字幕清單'), ca, groupHead('字幕過場'), gl, ga, groupHead('字幕樣式'), sl, sa);

    host.append(pm, pt, pg);
    setMediaView(state.mediaView, true);
    buildGallery();
    setLibTab('media');
  }

  function setLibTab(k) {
    lib.tab = k;
    const host = $('edMedia');
    for (const b of host.querySelectorAll('.ed-tab')) { const on = b.dataset.tab === k; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); }
    for (const p of host.querySelectorAll('.ed-panel')) p.hidden = p.dataset.panel !== k;
    updateSubMark();
  }

  // 轉場與字幕樣式的縮圖（用 fx 真的畫一次，所以和成品一致）
  function buildGallery() {
    const tl = $('edTransList'), gl = $('edTitleList');
    tl.textContent = ''; gl.textContent = '';
    for (const [type, def] of Object.entries(F.TRANSITIONS || {})) {
      const it = el('div', 'ed-gitem'); it.dataset.trans = type; it.tabIndex = 0; it.title = `${def.name}：拖到剪接點或片段的開頭／結尾，或選取後按「加到開頭」「加到結尾」`;
      const cv = el('canvas'); cv.width = 128; cv.height = 72;
      it.append(cv, el('span', 'ed-gname', def.name));
      tl.appendChild(it);
      paintTransThumb(cv, type);
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'transition', id: type }, def.name, () => { lib.trans = type; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.trans = type; markGallery(); addTransitionToSelection(type); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.trans = type; markGallery(); addTransitionToSelection(type); } });
    }
    for (const [preset, def] of Object.entries(F.TITLE_PRESETS || {})) {
      const it = el('div', 'ed-gitem'); it.dataset.title = preset; it.tabIndex = 0; it.title = `${def.name}：拖到時間軸，或選取後按「在播放頭新增」`;
      const cv = el('canvas'); cv.width = 192; cv.height = 108;
      it.append(cv, el('span', 'ed-gname', def.name));
      gl.appendChild(it);
      paintTitleThumb(cv, preset);
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'title', id: preset }, def.name, () => { lib.title = preset; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.title = preset; markGallery(); addTitle(preset); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.title = preset; markGallery(); addTitle(preset); } });
    }
    const xl = $('edTextFxList'), sl = $('edTStyleList');
    xl.textContent = ''; sl.textContent = '';
    for (const [kind, def] of Object.entries(F.TEXT_FX || {})) {
      const it = el('div', 'ed-gitem'); it.dataset.textfx = kind; it.tabIndex = 0; it.title = `${def.name}：拖到時間軸的字幕片段，或選取字幕後按「套用到選取的字幕」（滑鼠移上來會播放）`;
      const cv = el('canvas'); cv.width = 192; cv.height = 108;
      it.append(cv, el('span', 'ed-gname', def.name));
      xl.appendChild(it);
      paintTextFxThumb(cv, kind, null);
      wireThumbPlay(it, cv, f => paintTextFxThumb(cv, kind, f));
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'textfx', id: kind }, def.name, () => { lib.textFx = kind; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.textFx = kind; markGallery(); applyTextFx(kind); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.textFx = kind; markGallery(); applyTextFx(kind); } });
    }
    for (const [key, def] of Object.entries(F.TITLE_STYLES || {})) {
      const it = el('div', 'ed-gitem'); it.dataset.tstyle = key; it.tabIndex = 0; it.title = `${def.name}：拖到時間軸的字幕片段，或選取字幕後按「套用到選取的字幕」`;
      const cv = el('canvas'); cv.width = 192; cv.height = 108;
      it.append(cv, el('span', 'ed-gname', def.name));
      sl.appendChild(it);
      paintStyleThumb(cv, key);
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'tstyle', id: key }, def.name, () => { lib.tstyle = key; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.tstyle = key; markGallery(); applyTitleStyle(key); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.tstyle = key; markGallery(); applyTitleStyle(key); } });
    }
    markGallery();
    if (F.ready) F.ready().then(() => {
      for (const it of gl.children) paintTitleThumb(it.querySelector('canvas'), it.dataset.title);
      for (const it of xl.children) paintTextFxThumb(it.querySelector('canvas'), it.dataset.textfx, null);
      for (const it of sl.children) paintStyleThumb(it.querySelector('canvas'), it.dataset.tstyle);
    }).catch(() => {});
  }
  function markGallery() {
    for (const it of $('edTransList').children) it.classList.toggle('sel', it.dataset.trans === lib.trans);
    for (const it of $('edTitleList').children) it.classList.toggle('sel', it.dataset.title === lib.title);
    for (const it of $('edTextFxList').children) it.classList.toggle('sel', it.dataset.textfx === lib.textFx);
    for (const it of $('edTStyleList').children) it.classList.toggle('sel', it.dataset.tstyle === lib.tstyle);
  }
  const groupHead = t => el('div', 'ed-ghead', t);
  // 縮圖背景＋畫一個字幕片段（用 fx 真的畫，和成品一致）
  function paintSampleTitle(cv, title, f) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#5b6b86'); gr.addColorStop(1, '#2a3550');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    try { F.drawTitle(g, { id: 'thumb', type: 'title', duration: 60, title, video: F.defaultVideo() }, W, H, f, 30); } catch (_) { /* 字型還沒好：之後會重畫 */ }
  }
  // 字體特效縮圖：f＝null 時畫動畫進行到一半的樣子（看得出效果），播放時逐格畫
  function paintTextFxThumb(cv, kind, f) {
    const t = Object.assign(F.makeTitle('static', '字體特效'), { size: 260, textFx: kind, textFxDur: 0.5, stroke: { color: '#1b2233', width: 6 } });
    paintSampleTitle(cv, t, f == null ? (F.TEXT_FX[kind] && F.TEXT_FX[kind].char ? 9 : 7) : f);
  }
  function paintStyleThumb(cv, key) {
    const st = F.TITLE_STYLES[key];
    if (!st) return;
    paintSampleTitle(cv, Object.assign(F.makeTitle('static', st.sample || '字幕樣式'), JSON.parse(JSON.stringify(st.patch)), { size: 260 }), 0);
  }
  // 滑鼠移到縮圖上：用 requestAnimationFrame 播 0~45 格（30 fps），重複播放；移開停在預設畫面
  function wireThumbPlay(it, cv, draw) {
    let raf = 0, t0 = 0;
    const tick = now => { const f = Math.floor(((now - t0) / 1000 * 30) % 45); draw(f); raf = root.requestAnimationFrame(tick); };
    it.addEventListener('pointerenter', () => { if (raf) return; t0 = performance.now(); raf = root.requestAnimationFrame(tick); });
    it.addEventListener('pointerleave', () => { if (raf) root.cancelAnimationFrame(raf); raf = 0; draw(null); });
  }
  function paintTransThumb(cv, type) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const side = (c0, c1, label) => c => {
      const gr = c.createLinearGradient(0, 0, W, H); gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      c.fillStyle = gr; c.fillRect(0, 0, W, H);
      c.fillStyle = 'rgba(255,255,255,.9)'; c.font = `bold ${Math.round(H * 0.55)}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, W / 2, H / 2 + 2);
    };
    g.clearRect(0, 0, W, H);
    try { F.TRANSITIONS[type].draw(g, side('#4f86d6', '#1d3f87', 'A'), side('#f59e0b', '#b45309', 'B'), 0.5, { type, direction: 'left', color: '#000000', ease: 'linear', align: 'center' }, W, H); } catch (_) { side('#4f86d6', '#1d3f87', 'A')(g); }
  }
  function paintTitleThumb(cv, preset) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#5b6b86'); gr.addColorStop(1, '#2a3550');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    try {
      const t = F.makeTitle(preset, '字幕範例');
      F.drawTitle(g, { id: 'thumb', type: 'title', duration: 90, title: t, video: F.defaultVideo() }, W, H, preset === 'static' || preset === 'lowerThird' ? 0 : 60, 30);
    } catch (_) { /* 字型還沒好：之後會重畫 */ }
  }

  // ---- 匯入 ------------------------------------------------------------------------
  function mediaInfoOf(m) {
    return { kind: m.kind, duration: m.kind === 'image' ? null : m.duration, hasAudio: !!m.hasAudio, width: m.width, height: m.height, fps: m.fps, name: m.name };
  }
  // 復原會把專案換成舊的快照，裡面可能沒有後來匯入的媒體資訊：補回去（不進復原）
  function ensureMediaInfo() {
    const p = state.project;
    if (!p.mediaInfo) p.mediaInfo = {};
    let changed = false;
    for (const m of R.media.list()) {
      if (!p.mediaInfo[m.id]) { C.registerMediaInfo(p, m.id, mediaInfoOf(m)); changed = true; }
    }
    return changed;
  }

  let importChain = Promise.resolve([]);
  function importFiles(files) {
    files = [...(files || [])];
    const srt = files.filter(isSrtFile);
    if (srt.length) { files = files.filter(f => !isSrtFile(f)); srt.reduce((pr, f) => pr.then(() => importSrt(f)), Promise.resolve()); }
    if (!files.length) return importChain;
    importChain = importChain.then(() => doImport(files), () => doImport(files));
    return importChain;
  }
  async function doImport(files) {
    state.importing = true;
    setBusy(true);
    const errors = [], warns = [];
    let added = [];
    try {
      const ok = await R.media.import(files, { onProgress: (i, n, name) => say(`匯入中 ${i}／${n}：${name}`) });
      for (const e of ok.errors || []) errors.push(e);
      for (const m of ok) {
        const r = C.registerMediaInfo(state.project, m.id, mediaInfoOf(m));
        if (!r.ok) { errors.push({ name: m.name, message: r.reason }); R.media.remove(m.id); continue; }
        added.push(m);
        if (r.fpsSet) warns.push({ name: m.name, message: `專案影格率已設為 ${r.fps} fps（依第一支影片）`, info: true });
      }
      if (added.length) state.selMedia = added[added.length - 1].id;
    } catch (e) {
      errors.push({ name: '匯入', message: (e && e.message) || String(e) });
    }
    state.importing = false;
    setBusy(false);
    showMsgs(errors, warns);
    if (added.length) say(`已匯入 ${added.length} 個素材`, 'ok'); else if (errors.length) say(errors[0].message, 'error'); else say('');
    renderMedia();
    syncAspect();
    if (player) player.refresh();
    scheduleRender();
    return added;
  }
  function setBusy(b) { app.classList.toggle('busy', !!b); const d = $('edDrop'); if (d) d.classList.toggle('busy', !!b); }

  function showMsgs(errors, warns) {
    const box = $('edMsgs');
    box.textContent = '';
    for (const [list, cls] of [[errors, 'err'], [warns, 'warn']]) {
      for (const m of list) {
        const row = el('div', 'ed-msg ' + cls + (m.info ? ' info' : ''));
        row.append(el('span', 'ed-msg-t', m.message));
        const x = el('button', 'ed-msg-x'); x.type = 'button'; x.setAttribute('aria-label', '關閉訊息'); x.appendChild(icon('close'));
        x.addEventListener('click', () => row.remove());
        row.appendChild(x);
        box.appendChild(row);
        if (m.info) setTimeout(() => row.remove(), 9000);
      }
    }
  }

  // ---- 媒體清單 --------------------------------------------------------------------
  function setMediaView(v, quiet) {
    state.mediaView = v === 'grid' ? 'grid' : 'list';
    if (!quiet) lsSet(MVIEW_KEY, state.mediaView);
    const host = $('edMList');
    if (host) host.classList.toggle('grid', state.mediaView === 'grid');
    for (const b of doc.querySelectorAll('[data-mview]')) {
      const on = b.dataset.mview === state.mediaView;
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
    }
  }
  function renderMedia() {
    const host = $('edMList');
    if (!host) return;
    const list = R.media.list();
    const cnt = $('edMCount');
    if (cnt) cnt.textContent = list.length ? `${list.length} 個素材` : '';
    const st = host.scrollTop;
    host.textContent = '';
    if (!list.length) {
      host.appendChild(el('div', 'ed-mempty', '還沒有素材。把影片、音訊或圖片拖進來，雙擊在檢視器預覽，再放上時間軸。'));
    }
    const p = state.project;
    for (const m of list) {
      const used = Object.values(p.clips).some(c => c.mediaId === m.id);
      const it = el('div', 'ed-mitem' + (state.selMedia === m.id ? ' sel' : '') + (state.sourceMedia === m.id && state.mode === 'source' ? ' src' : ''));
      it.dataset.media = m.id;
      it.title = `${m.name}\n單擊選取，雙擊在檢視器預覽，拖到時間軸放入`;
      const cv = el('canvas', 'ed-mthumb'); cv.width = 160; cv.height = 90;
      paintMediaThumb(cv, m);
      const info = el('div', 'ed-minfo');
      info.append(el('div', 'ed-mname', m.name));
      const bits = [KIND_NAME[m.kind] || '', m.kind === 'image' ? '' : fmtSec(m.duration)];
      if (m.kind !== 'audio' && m.width) bits.push(`${m.width}×${m.height}`);
      if (m.kind === 'video' && m.fps) bits.push(`${+Number(m.fps).toFixed(2)} fps`);
      if (m.kind === 'video' && !m.hasAudio) bits.push('無聲音');
      const sio = state.sourceInOut && state.sourceInOut.mediaId === m.id ? state.sourceInOut : null;
      if (sio) bits.push(`In／Out ${sio.srcIn != null ? fmtNum(sio.srcIn, 2) : '0'}–${sio.srcOut != null ? fmtNum(sio.srcOut, 2) : '結尾'} 秒`);
      const meta = el('div', 'ed-mmeta');
      for (const b of bits.filter(Boolean)) meta.appendChild(el('span', null, b));
      info.append(meta);
      if (m.warning) info.append(el('div', 'ed-mwarn', m.warning));
      const del = el('button', 'ed-mdel'); del.type = 'button'; del.title = used ? '時間軸上還有片段在用，不能移除' : '從媒體庫移除'; del.setAttribute('aria-label', `移除 ${m.name}`);
      del.appendChild(icon('close'));
      del.addEventListener('click', e => { e.stopPropagation(); removeMedia(m.id); });
      del.addEventListener('pointerdown', e => e.stopPropagation());
      it.append(cv, info, del);
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'media', id: m.id }, m.name, () => { state.selMedia = m.id; markMediaSel(); }));
      it.addEventListener('dblclick', () => openSource(m.id));
      host.appendChild(it);
    }
    host.scrollTop = st;
  }
  function markMediaSel() {
    for (const it of $('edMList').children) {
      it.classList.toggle('sel', it.dataset.media === state.selMedia);
      it.classList.toggle('src', it.dataset.media === state.sourceMedia && state.mode === 'source');
    }
  }
  function paintMediaThumb(cv, m) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.fillStyle = m.kind === 'audio' ? colors.audio : colors.thumbBg; g.fillRect(0, 0, W, H);
    if (m.kind === 'audio') {
      g.fillStyle = colors.waveThumb;
      if (m.peaks && m.peaks.length) {
        const n = m.peaks.length;
        for (let x = 0; x < W; x++) {
          const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n));
          let mx = 0;
          for (let i = a; i < b && i < n; i++) if (m.peaks[i] > mx) mx = m.peaks[i];
          const h = Math.max(1, waveAmp(mx) * H * 0.9);
          g.fillRect(x, (H - h) / 2, 1, h);
        }
      }
      return;
    }
    const th = m.thumbs && m.thumbs.length ? m.thumbs[Math.min(m.thumbs.length - 1, Math.floor(m.thumbs.length / 3))] : null;
    if (th && th.bitmap) {
      const bw = th.bitmap.width, bh = th.bitmap.height, k = Math.max(W / bw, H / bh);
      try { g.drawImage(th.bitmap, (W - bw * k) / 2, (H - bh * k) / 2, bw * k, bh * k); } catch (_) { /* 已釋放 */ }
    }
  }
  function removeMedia(id) {
    const m = mediaOf(id);
    if (!m) return;
    const r = C.unregisterMediaInfo(state.project, id);
    if (!r.ok) { say(`時間軸上還有片段在用「${m.name}」，請先把那些片段刪掉再移除素材`, 'error'); return; }
    if (state.sourceMedia === id) closeSource();
    if (state.sourceInOut && state.sourceInOut.mediaId === id) state.sourceInOut = null;
    if (state.selMedia === id) state.selMedia = null;
    R.media.remove(id);
    renderMedia();
    say(`已移除「${m.name}」`, 'ok');
  }

  // ---- 從媒體庫拖到時間軸（自己用 pointer 事件做，不靠瀏覽器的拖放：測得到、也不會被拖影像干擾）-------------
  let libDrag = null;
  function libPointerDown(e, payload, label, onClick) {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null, moved = false;
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!moved) {
        moved = true;
        ghost = el('div', 'ed-ghost ' + payload.kind, label);
        app.appendChild(ghost);
        libDrag = payload;
        app.classList.add('dragging-lib');
      }
      ghost.style.left = (ev.clientX + 12) + 'px';
      ghost.style.top = (ev.clientY + 8) + 'px';
      tlShowDrop(payload, ev);
    };
    const end = ev => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', end);
      root.removeEventListener('pointercancel', end);
      if (ghost) ghost.remove();
      app.classList.remove('dragging-lib');
      libDrag = null;
      tlShowDrop(null);
      if (!moved) { if (onClick) onClick(); return; }
      if (ev.type === 'pointerup') tlDrop(payload, ev);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  }

  // ---- 從檔案總管拖進來、Ctrl+V 貼上 --------------------------------------------------
  function hasFiles(e) { return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'); }
  function wireFileDrop() {
    app.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; app.classList.add('filedrag'); });
    app.addEventListener('dragleave', e => { if (e.target === app || !app.contains(e.relatedTarget)) app.classList.remove('filedrag'); });
    app.addEventListener('drop', e => {
      app.classList.remove('filedrag');
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      importFiles(e.dataTransfer.files);
    });
    // Ctrl+V 一律由這裡處理（捕捉階段攔下）
    doc.addEventListener('paste', e => {
      if (app.hidden) return;
      if (isTextTarget(e.target)) return;
      e.stopImmediatePropagation();
      const files = e.clipboardData ? [...e.clipboardData.items].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) : [];
      if (!files.length) return;
      e.preventDefault();
      importFiles(files);
    }, true);
  }

  // =====================================================================================
  // 檢視器：來源／時間軸、播放控制、時間碼、輸出比例、匯出
  // =====================================================================================
  const viewProject = () => (state.mode === 'source' && srcProject ? srcProject : state.project);
  const viewDuration = () => C.projectDuration(viewProject());

  function buildViewer() {
    const bar = $('edVBar');
    bar.textContent = '';
    const seg = el('div', 'ed-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', '檢視器模式');
    for (const [k, t] of [['source', '來源'], ['timeline', '時間軸']]) {
      const b = el('button', 'ed-segbtn', t); b.type = 'button'; b.dataset.mode = k; b.id = k === 'source' ? 'edModeSource' : 'edModeTimeline';
      b.addEventListener('click', () => { if (k === 'source' && !state.sourceMedia) { const id = state.selMedia; if (!id) { say('請先在媒體庫雙擊一個素材，才能在來源檢視器預覽', 'error'); return; } openSource(id); return; } setMode(k); });
      seg.appendChild(b);
    }
    const name = el('span', 'ed-vname'); name.id = 'edVName';
    const sp = el('span', 'ed-spacer');
    const aspLab = el('label', 'ed-aspect'); aspLab.htmlFor = 'edAspect';
    aspLab.append(el('span', null, '輸出比例'));
    const sel = el('select'); sel.id = 'edAspect'; sel.title = '輸出畫面的比例（只影響時間軸與匯出，不影響素材）';
    for (const [v, t] of [['source', '依來源'], ['9:16', '9:16 直式'], ['16:9', '16:9 橫式'], ['4:5', '4:5']]) { const o = el('option', null, t); o.value = v; sel.appendChild(o); }
    sel.addEventListener('change', () => {
      const v = sel.value;
      const r = state.history.run('輸出比例', p => C.setAspect(p, v));
      if (!report(r)) syncAspect();
      else say(`輸出比例 ${aspectText()}`, 'ok');
    });
    aspLab.appendChild(sel);
    const vb = el('button', 'ed-btn small ed-vertbtn'); vb.type = 'button'; vb.id = 'edVert';
    vb.title = '把預覽放到整頁左側，從頂端延伸到時間軸底部（直式、橫式各自記住開關）'; vb.setAttribute('aria-pressed', 'false');
    vb.append(el('span', 'ed-bl', '直式版面'));
    vb.addEventListener('click', () => {
      const portrait = isPortrait(), v = !(portrait ? state.vertPref : state.vertPrefH);
      if (portrait) { state.vertPref = v; lsSet(VERT_KEY, v ? '1' : '0'); } else { state.vertPrefH = v; lsSet(VERT_H_KEY, v ? '1' : '0'); }
      applyVertical(true);
    });
    const sb = el('button', 'ed-btn small ed-safebtn'); sb.type = 'button'; sb.id = 'edSafe'; sb.hidden = true;
    sb.title = '顯示 Reels／短影音介面會蓋住的範圍（灰色區域），只在預覽顯示、不會匯出'; sb.setAttribute('aria-pressed', 'false');
    sb.append(el('span', 'ed-bl', '安全框'));
    sb.addEventListener('click', () => { state.safePref = !state.safePref; lsSet(SAFE_KEY, state.safePref ? '1' : '0'); scheduleStage(); });
    const dims = el('span', 'ed-vdims'); dims.id = 'edVDims';
    const ex = el('button', 'ed-btn primary'); ex.type = 'button'; ex.id = 'edExportBtn'; ex.textContent = '匯出 MP4';
    ex.title = '匯出成 MP4 影片';
    ex.addEventListener('click', openExport);
    bar.append(seg, name, sp, aspLab, vb, sb, dims, ex);
    wireStage();

    // 拖曳條
    const sw = $('edScrubWrap');
    sw.textContent = '';
    const scrub = el('div', 'ed-scrub');
    const io = el('div', 'ed-scrub-io'); io.id = 'edScrubIO';
    const rg = el('input'); rg.type = 'range'; rg.id = 'edScrub'; rg.min = 0; rg.max = 1; rg.step = 1; rg.value = 0; rg.setAttribute('aria-label', '播放位置');
    rg.addEventListener('input', () => { if (state.mode === 'timeline') seekTimeline(+rg.value); else player && player.seek(+rg.value); });
    scrub.append(io, rg);
    const srcio = el('div', 'ed-srcio'); srcio.id = 'edSrcIO';
    sw.append(scrub, srcio);

    // 播放控制
    const tr = $('edTransport');
    tr.textContent = '';
    const mk = (id, ic, title, fn, txt) => {
      const b = el('button', 'ed-tbtn'); b.type = 'button'; b.id = id; b.title = title; b.setAttribute('aria-label', title);
      if (ic) b.appendChild(icon(ic)); else b.textContent = txt;
      b.addEventListener('click', fn);
      return b;
    };
    const group = el('div', 'ed-tgroup');
    group.append(
      mk('edPrevEdit', 'prev', '上一個剪輯點（↑）', () => jumpEdit(-1)),
      mk('edStepB', 'stepB', '往前一格（←）', () => step(-1)),
      mk('edPlay', 'play', '播放／暫停（空白鍵）', () => togglePlay()),
      mk('edStepF', 'stepF', '往後一格（→）', () => step(1)),
      mk('edNextEdit', 'next', '下一個剪輯點（↓）', () => jumpEdit(1)));
    const jkl = el('div', 'ed-tgroup small');
    jkl.append(mk('edJ', null, '倒播（J，連按加速）', () => shuttle(-1), 'J'), mk('edK', null, '停止（K）', () => shuttle(0), 'K'), mk('edL', null, '播放（L，連按加速）', () => shuttle(1), 'L'));
    const time = el('div', 'ed-time');
    const cur = el('span', 'ed-tc'); cur.id = 'edTc'; cur.textContent = '00:00:00:00';
    const dur = el('span', 'ed-tcdur'); dur.id = 'edTcDur'; dur.textContent = '/ 00:00:00:00';
    time.append(cur, dur);
    const vm = mk('edSubMark', null, '字幕標記（V）：在播放頭加一段字幕，右側詳細內容會多一行可以輸入文字', () => markSubtitle(), 'V');
    vm.classList.add('ed-submark'); vm.hidden = true;
    tr.append(group, jkl, vm, time);

    const empty = $('edEmpty');
    empty.innerHTML = '<div class="ed-empty-box"><strong>把影片、音訊或圖片拖進來開始剪輯</strong><span>拖到左側「媒體」，或直接拖到這裡；也可以按下面的按鈕選檔案。<br>雙擊素材先預覽，再按 F10（覆蓋）、F9（插入）或「加到結尾」放上時間軸。</span></div>';
    const eb = el('button', 'ed-btn primary', '選擇檔案'); eb.type = 'button';
    eb.addEventListener('click', () => $('edFile').click());
    empty.firstChild.appendChild(eb);
  }

  function openExport() {
    if (!Q.exporter || typeof Q.exporter.open !== 'function') { say('匯出模組還沒載入完成，請重新整理頁面再試', 'error'); return; }
    if (player) player.pause();
    if (!C.projectDuration(state.project)) { say('時間軸上還沒有內容可以匯出', 'error'); return; }
    Q.exporter.open();
  }

  const aspectText = () => { const p = state.project; return `${p.width}×${p.height}`; };
  function syncAspect() {
    const sel = $('edAspect'), p = state.project;
    if (sel) sel.value = p.aspect;
    const d = $('edVDims');
    if (d) d.textContent = `${p.width}×${p.height}　${p.fps} fps`;
    applyVertical(false);
    scheduleStage();
  }

  // ---- 直式版面：檢視器放到整頁左側，從頂端一路延伸到時間軸底部（直式專案預設開、橫式預設關，各自記在 localStorage）----------
  // 只切 class（.ed-vert，版面在 edit.css）與左欄寬度變數 --ed-vw；不碰專案資料、不停播放（畫布是 CSS 縮放，不用重畫）。
  // 左欄寬度預設依畫面比例算（讓預覽剛好塞滿高度）；使用者拖過分隔條就用拖的寬度（state.cols.vw）。
  let vertSig = '';
  const isPortrait = () => state.project.height > state.project.width;
  const vertRange = () => { const minW = 300; return [minW, Math.max(minW, Math.round(app.clientWidth * 0.62))]; };
  function fitVertical() {
    const p = state.project, vw = $('edViewer'), st = $('edStage');
    if (app.hidden || !vw || !st || !app.classList.contains('ed-vert') || !(p.width > 0 && p.height > 0)) return;
    const [lo, hi] = vertRange();
    if (state.cols.vw) { app.style.setProperty('--ed-vw', clamp(state.cols.vw, lo, hi) + 'px'); return; }
    const ratio = p.width / p.height, minW = 380, maxW = Math.max(minW, Math.round(app.clientWidth * 0.46));
    let w = parseFloat(app.style.getPropertyValue('--ed-vw')) || minW;
    for (let i = 0; i < 4; i++) {                       // 欄寬 ↔ 工具列換行 ↔ 畫面高度會互相影響，收斂幾次
      app.style.setProperty('--ed-vw', w + 'px');
      const chrome = vw.offsetWidth - st.clientWidth;   // 檢視器的內距與邊框
      const nw = clamp(Math.round(st.clientHeight * ratio) + chrome, minW, maxW);
      if (Math.abs(nw - w) < 2) break;
      w = nw;
    }
  }
  function applyVertical(force) {
    const p = state.project, portrait = isPortrait(), btn = $('edVert'), on = portrait ? state.vertPref : state.vertPrefH;
    if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('active', on); }
    const sig = on ? `${p.width}x${p.height}` : '';
    if (!force && sig === vertSig) return;
    vertSig = sig;
    app.classList.toggle('ed-vert', on);
    applyCols();
    if (on) fitVertical(); else app.style.removeProperty('--ed-vw');
    scheduleRender('tl');
    if (player && !player.playing) player.refresh();
    scheduleStage();
  }

  // ---- 上排欄寬：兩條直的分隔條（#edColL、#edColR），左右拖曳調整，雙擊恢復預設；記在 localStorage --------------
  // 一般版面：L 調媒體庫寬（--ed-mw）、R 調詳細內容寬（--ed-iw），檢視器吃剩下的。
  // 直式版面：L 調左側預覽欄寬（--ed-vw），R 調媒體庫寬（--ed-vmw），詳細內容吃剩下的。
  const COL_VAR = { mw: '--ed-mw', iw: '--ed-iw', vmw: '--ed-vmw' };
  function applyCols() {
    for (const [k, v] of Object.entries(COL_VAR)) {
      if (state.cols[k] > 0) app.style.setProperty(v, state.cols[k] + 'px'); else app.style.removeProperty(v);
    }
  }
  function saveCols() { lsSet(COLS_KEY, JSON.stringify(state.cols)); }
  function wireColSplitters() {
    for (const id of ['edColL', 'edColR']) {
      const sp = $(id);
      if (!sp) continue;
      const which = () => app.classList.contains('ed-vert') ? (sp.dataset.col === 'l' ? 'vw' : 'vmw') : (sp.dataset.col === 'l' ? 'mw' : 'iw');
      const target = k => $(k === 'vw' ? 'edViewer' : k === 'iw' ? 'edInspector' : 'edMedia');
      sp.addEventListener('dblclick', () => {
        delete state.cols[which()]; saveCols(); applyCols();
        if (app.classList.contains('ed-vert')) fitVertical();
        scheduleRender('tl'); scheduleStage();
      });
      sp.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const k = which(), x0 = e.clientX, w0 = target(k).getBoundingClientRect().width;
        const dir = k === 'iw' ? -1 : 1;          // 詳細內容在右邊：往左拖是變寬
        const aw = app.getBoundingClientRect().width;
        // 每欄至少留給其他欄的寬度：一般版面檢視器至少 320，直式版面右側兩欄各至少 220／260
        const [lo, hi] = k === 'vw' ? vertRange()
          : k === 'vmw' ? [200, Math.max(200, aw - (state.cols.vw || $('edViewer').getBoundingClientRect().width) - 300)]
            : [k === 'mw' ? 180 : 240, Math.max(260, aw - 320 - (k === 'mw' ? $('edInspector') : $('edMedia')).getBoundingClientRect().width)];
        const move = ev => {
          state.cols[k] = Math.round(clamp(w0 + dir * (ev.clientX - x0), lo, hi));
          if (k === 'vw') app.style.setProperty('--ed-vw', state.cols.vw + 'px'); else applyCols();
          scheduleStage();
        };
        const up = () => {
          root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up);
          app.classList.remove('resizing', 'colresize'); saveCols(); scheduleRender('tl');
          if (player && !player.playing) player.refresh();
        };
        app.classList.add('resizing', 'colresize');
        root.addEventListener('pointermove', move); root.addEventListener('pointerup', up);
      });
    }
    applyCols();
  }

  // ---- 預覽框上的疊圖：選取素材的控制框、安全框 ---------------------------------------------------------
  // 疊圖（#edOverlay）蓋在畫布實際顯示畫面的位置（畫布是 object-fit: contain，四周可能有留黑），只是 DOM，不會被匯出。
  // 控制框：時間軸模式下，選取的畫面片段在預覽上有外框——拖本體移動、拖四角等比縮放、拖上方圓點旋轉；
  // 點到沒選取的片段會先選它（最上層優先）。整次拖曳只記一筆復原。
  const SAFE_SVG = (() => {
    // 1080×1920 座標；灰色＝會被介面蓋住的範圍（右側按鈕欄＋下方說明／導覽列）。帳號、文字、數字都換成灰條。
    const ic = (y, d) => `<path transform="translate(1005 ${y})" d="${d}"/>`;
    const heart = 'M0 26 C-40 -4 -40 -40 -16 -40 C-6 -40 0 -32 0 -26 C0 -32 6 -40 16 -40 C40 -40 40 -4 0 26Z';
    const bubble = 'M-30 0 A30 30 0 1 1 -14 26 L-34 32 Z';
    const repost = 'M-26 -6 V-20 H22 M10 -32 L22 -20 L10 -8 M26 6 V20 H-22 M-10 32 L-22 20 L-10 8';
    const send = 'M-30 -28 L32 -28 L-4 32 L-10 -6 Z M-10 -6 L32 -28';
    const bar = (x, y, w, h, o) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#fff" fill-opacity="${o || 0.55}"/>`;
    const nav = [270, 410, 540, 670, 810].map((x, i) => i === 1
      ? `<rect x="${x - 60}" y="1768" width="120" height="70" rx="35" fill="#fff" fill-opacity=".18"/><rect x="${x - 18}" y="1786" width="36" height="34" rx="9" fill="#fff" fill-opacity=".85"/>`
      : `<circle cx="${x}" cy="1803" r="20" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="6"/>`).join('');
    return `<svg class="ed-safe" viewBox="0 0 1080 1920" preserveAspectRatio="none" aria-hidden="true">
      <path class="ed-safe-shade" d="M930 840 H1080 V1920 H0 V1500 H930 Z"/>
      <g fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="6" stroke-linejoin="round" stroke-linecap="round">
        ${ic(910, heart)}${ic(1060, bubble)}${ic(1210, repost)}${ic(1360, send)}
        <path d="M975 1500 H1035 M985 1524 H1035"/>
        <rect x="975" y="1580" width="62" height="62" rx="12"/>
        <circle cx="90" cy="1560" r="46"/>
        <rect x="445" y="1528" width="110" height="52" rx="14" stroke-opacity=".7"/>
      </g>
      ${bar(158, 1532, 230, 24, 0.75)}${bar(158, 1572, 170, 18)}${bar(40, 1640, 470, 26)}
      <rect x="40" y="1700" width="1000" height="5" rx="2.5" fill="#fff" fill-opacity=".35"/>
      <rect x="120" y="1750" width="840" height="106" rx="53" fill="#000" fill-opacity=".35"/>
      ${nav}
    </svg>`;
  })();
  let stageRaf = 0;
  function scheduleStage() { if (!stageRaf) stageRaf = root.requestAnimationFrame(() => { stageRaf = 0; syncStage(); }); }
  // 畫布上實際顯示畫面的矩形（相對 #edStage）與縮放比例 s（螢幕像素／輸出像素）
  function stageRect() {
    const st = $('edStage'), cv = $('edCanvas'), p = viewProject();
    if (!st || !cv || !(p.width > 0 && p.height > 0)) return null;
    const sr = st.getBoundingClientRect(), cr = cv.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    const s = Math.min(cr.width / p.width, cr.height / p.height), w = p.width * s, h = p.height * s;
    return { left: cr.left - sr.left + (cr.width - w) / 2, top: cr.top - sr.top + (cr.height - h) / 2, w, h, s, W: p.width, H: p.height, sw: sr.width, sh: sr.height };
  }
  const safeAvailable = () => { const p = state.project; return p.height / p.width >= 1.7; };
  // 播放頭這格看得到的畫面片段（影片／圖片／純色／字幕），最上層在前：[{ clip, q（clipQuad：輸出像素四角＋樞紐）}]
  function visualsAtPlayhead() {
    if (state.mode !== 'timeline' || !R || !F || typeof F.clipQuad !== 'function') return [];
    const p = state.project, f = state.playhead, out = [];
    for (const l of R.layersAt(p, f)) {
      if (l.kind !== 'clip' || !l.clip.video) continue;
      const q = F.clipQuad(l.clip, p, Math.max(0, f - l.clip.start));
      if (q) out.unshift({ clip: l.clip, q });
    }
    return out;
  }
  // 控制框對象：選取中、且播放頭這格看得到的片段（主選取優先）
  function gizmoTarget(vis) {
    const pr = lastSel();
    return vis.find(v => v.clip.id === pr) || vis.find(v => state.selection.has(v.clip.id)) || null;
  }
  const GZ = { corner: 7, rotGap: 26, rotR: 6, hit: 10 };   // 螢幕像素：角點半徑、旋轉點離上緣距離、點選容許範圍
  // 控制框各點（overlay 座標＝螢幕像素）：四角、上緣中點、旋轉點
  function gizmoGeom(t, r) {
    const pts = t.q.pts.map(([x, y]) => [x * r.s, y * r.s]);
    const [tl, tr, br, bl] = pts;
    const top = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2], bot = [(bl[0] + br[0]) / 2, (bl[1] + br[1]) / 2];
    let nx = top[0] - bot[0], ny = top[1] - bot[1];
    const nl = Math.hypot(nx, ny);
    if (nl) { nx /= nl; ny /= nl; } else { nx = 0; ny = -1; }
    // 旋轉點：從樞紐沿「往上緣」的方向，放在上緣外側一點；跑出預覽區（片段滿版或放大時常見）就往樞紐拉回到看得到的地方
    const pv = [t.q.pivot[0] * r.s, t.q.pivot[1] * r.s];
    const want = (top[0] - pv[0]) * nx + (top[1] - pv[1]) * ny + GZ.rotGap;
    const m = GZ.rotR + 4, x0 = m - r.left, y0 = m - r.top, x1 = r.sw - m - r.left, y1 = r.sh - m - r.top;
    let room = Infinity;   // 樞紐沿 n 方向走多遠還在預覽區內
    if (nx > 1e-9) room = Math.min(room, (x1 - pv[0]) / nx); else if (nx < -1e-9) room = Math.min(room, (x0 - pv[0]) / nx);
    if (ny > 1e-9) room = Math.min(room, (y1 - pv[1]) / ny); else if (ny < -1e-9) room = Math.min(room, (y0 - pv[1]) / ny);
    const inside = pv[0] >= x0 && pv[0] <= x1 && pv[1] >= y0 && pv[1] <= y1;
    const dist = inside ? Math.max(GZ.rotGap, Math.min(want, room)) : want;
    const rot = [pv[0] + nx * dist, pv[1] + ny * dist];
    return { pts, top, rot, pivot: pv };
  }
  function inQuad(pts, x, y, pad) {
    // 凸四邊形（也可能因翻轉而順序相反）：點在每條邊的同一側；pad 讓邊緣好點一點
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
      const d = (ex * (y - a[1]) - ey * (x - a[0])) / len;
      if (Math.abs(d) <= pad) continue;
      const s = d > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }
  function syncStage() {
    const ov = $('edOverlay'), sb = $('edSafe');
    if (!ov) return;
    const avail = safeAvailable();
    if (sb) { sb.hidden = !avail; sb.classList.toggle('active', state.safePref); sb.setAttribute('aria-pressed', String(state.safePref)); }
    const r = app.hidden ? null : stageRect();
    if (!r) { ov.hidden = true; return; }
    ov.hidden = false;
    Object.assign(ov.style, { left: r.left + 'px', top: r.top + 'px', width: r.w + 'px', height: r.h + 'px' });
    const safe = ov.querySelector('.ed-safe');
    if (safe) safe.style.display = avail && state.safePref && state.mode === 'timeline' ? '' : 'none';
    const gz = $('edGizmo'), t = gizmoTarget(visualsAtPlayhead());
    gz.toggleAttribute('hidden', !t);   // SVG 元素沒有 .hidden 屬性，要直接改 attribute
    if (!t) return;
    const g = gizmoGeom(t, r), P = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
    gz.setAttribute('viewBox', `0 0 ${r.w} ${r.h}`);
    gz.classList.toggle('title', t.clip.type === 'title');
    gz.dataset.clip = t.clip.id;
    gz.querySelector('.ed-gz-box').setAttribute('points', g.pts.map(P).join(' '));
    gz.querySelector('.ed-gz-stem').setAttribute('points', `${P(g.top)} ${P(g.rot)}`);
    const rc = gz.querySelector('.ed-gz-rot'); rc.setAttribute('cx', g.rot[0]); rc.setAttribute('cy', g.rot[1]);
    gz.querySelectorAll('.ed-gz-corner').forEach((c, i) => { c.setAttribute('cx', g.pts[i][0]); c.setAttribute('cy', g.pts[i][1]); });
  }
  // 預覽上按到哪裡：控制框的旋轉點／角點／本體，或沒選取的片段（最上層優先）
  function stageHit(e) {
    const r = stageRect();
    if (!r) return null;
    const sr = $('edStage').getBoundingClientRect();
    const x = e.clientX - sr.left - r.left, y = e.clientY - sr.top - r.top;
    const vis = visualsAtPlayhead(), t = gizmoTarget(vis);
    if (t) {
      const g = gizmoGeom(t, r), near = p => Math.hypot(p[0] - x, p[1] - y) <= GZ.hit;
      if (near(g.rot)) return { kind: 'rotate', t, r, x, y };
      const ci = g.pts.findIndex(near);
      if (ci >= 0) return { kind: 'scale', t, r, x, y, corner: ci };
      if (inQuad(g.pts, x, y, 4)) return { kind: 'move', t, r, x, y };
    }
    for (const v of vis) {
      if (inQuad(v.q.pts.map(([a, b]) => [a * r.s, b * r.s]), x, y, 4)) return { kind: 'move', t: v, r, x, y };
    }
    return null;
  }
  const HIT_CURSOR = { rotate: 'grab', scale: 'nwse-resize', move: 'move' };
  const tfOf = (c, k, d) => { const v = c.video && c.video.transform ? c.video.transform[k] : undefined; return Number.isFinite(+v) && v !== undefined && v !== null ? +v : d; };
  function wireStage() {
    const st = $('edStage');
    if (!st || $('edOverlay')) return;
    const ov = el('div', 'ed-overlay'); ov.id = 'edOverlay'; ov.hidden = true;
    ov.innerHTML = SAFE_SVG + `<svg class="ed-gizmo" id="edGizmo" hidden aria-hidden="true">
      <polygon class="ed-gz-box"/><polyline class="ed-gz-stem"/><circle class="ed-gz-rot" r="${GZ.rotR}"/>
      ${`<circle class="ed-gz-corner" r="${GZ.corner / 1.4}"/>`.repeat(4)}</svg>`;
    st.appendChild(ov);
    const cv = $('edCanvas');
    cv.addEventListener('pointermove', e => { if (!drag) { const h = stageHit(e); cv.style.cursor = h ? HIT_CURSOR[h.kind] : ''; } });
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || drag) return;
      const h = stageHit(e);
      if (!h) return;
      e.preventDefault();
      if (player) player.pause();
      const clip = h.t.clip, id = clip.id;
      if (!state.selection.has(id) || state.selection.size > 1) selectClips([id]);
      const W = h.r.W, H = h.r.H, s = h.r.s;
      if (h.kind === 'move' && clip.type === 'title') return dragTitle(e, clip, W, H, s);
      const z0x = tfOf(clip, 'zoomX', 1), linked = !(clip.video.transform && clip.video.transform.zoomLinked === false);
      const z0y = linked ? z0x : tfOf(clip, 'zoomY', 1);
      const px0 = tfOf(clip, 'posX', 0), py0 = tfOf(clip, 'posY', 0), rot0 = tfOf(clip, 'rotation', 0);
      const pv = [h.t.q.pivot[0] * s, h.t.q.pivot[1] * s];   // 樞紐（螢幕像素，overlay 座標）
      const cx0 = h.t.q.pts.reduce((a, p) => a + p[0], 0) / 4, cy0 = h.t.q.pts.reduce((a, p) => a + p[1], 0) / 4;
      const LABEL = { move: '移動素材', scale: '縮放素材', rotate: '旋轉素材' };
      const apply = tf => {
        const r = live.run(LABEL[h.kind], q => C.setClipProps(q, id, { video: { transform: tf } }));
        if (r && !r.ok) say(r.reason, 'error');
        scheduleStage();
      };
      let last = '';
      beginDrag(e, {
        move(ev, dx, dy) {
          if (h.kind === 'move') {
            let x = px0 + dx / s, y = py0 + dy / s;
            if (!ev.altKey) {   // 片段中心靠近畫面中線 8 個螢幕像素內就吸附
              const cx = cx0 + x - px0, cy = cy0 + y - py0;
              if (Math.abs(cx - W / 2) * s < 8) x += W / 2 - cx;
              if (Math.abs(cy - H / 2) * s < 8) y += H / 2 - cy;
            }
            x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10;
            apply({ posX: x, posY: y });
            last = `位置 ${Math.round(x)}, ${Math.round(y)} px`;
          } else if (h.kind === 'scale') {
            const d0 = Math.hypot(h.x - pv[0], h.y - pv[1]) || 1, d1 = Math.hypot(h.x + dx - pv[0], h.y + dy - pv[1]);
            const k = d1 / d0, zx = clamp(Math.round(z0x * k * 1000) / 1000, 0.01, 20), zy = clamp(Math.round(z0y * k * 1000) / 1000, 0.01, 20);
            apply(linked ? { zoomX: zx, zoomY: zx } : { zoomX: zx, zoomY: zy });
            last = `縮放 ${Math.round(zx * 100)}%`;
          } else {
            const a0 = Math.atan2(h.y - pv[1], h.x - pv[0]), a1 = Math.atan2(h.y + dy - pv[1], h.x + dx - pv[0]);
            let d = (a1 - a0) * 180 / Math.PI;
            d = ((d + 540) % 360) - 180;
            let rot = rot0 + d;
            rot = ev.shiftKey ? Math.round(rot / 15) * 15 : Math.round(rot * 10) / 10;
            apply({ rotation: rot });
            last = `旋轉 ${rot}°`;
          }
        },
        up(ev, moved) {
          if (!moved) return;
          live.end();
          say(`${last}（${h.kind === 'move' ? 'Alt＝不吸附到中線' : h.kind === 'rotate' ? 'Shift＝每 15° 一格' : '按住角點等比縮放'}）`, 'ok');
        },
        cancel() { live.abort(); scheduleStage(); },
      });
    });
    if (typeof root.ResizeObserver === 'function') new root.ResizeObserver(() => scheduleStage()).observe(st);
  }
  // 字幕拖曳：改 title.x／y（0~1），不是 posX／posY，這樣字幕的位置欄位和預設動畫才會跟著走
  function dragTitle(e, clip, W, H, s) {
    const id = clip.id, t0 = clip.title, x0 = Number(t0.x) || 0, y0 = Number(t0.y) || 0;
    // 螢幕位移 → 字幕座標：扣掉片段變形（縮放／旋轉／翻轉）的線性部分
    const m = F.clipMatrix(clip, W, H, W, H, Math.max(0, state.playhead - clip.start));
    const det = m[0] * m[3] - m[2] * m[1] || 1;
    const snap = (v, px) => (Math.abs(v - 0.5) * px < 8 ? 0.5 : v);
    beginDrag(e, {
      move(ev, dx, dy) {
        const ox = dx / s, oy = dy / s;
        const ux = (m[3] * ox - m[2] * oy) / det, uy = (-m[1] * ox + m[0] * oy) / det;
        let x = clamp(x0 + ux / W, -0.5, 1.5), y = clamp(y0 + uy / H, -0.5, 1.5);
        if (!ev.altKey) { x = snap(x, W * s); y = snap(y, H * s); }
        const r = live.run('移動字幕', q => C.setClipProps(q, id, { title: { x, y } }));
        if (r && !r.ok) say(r.reason, 'error');
        scheduleStage();
      },
      up(ev, moved) { if (moved) { live.end(); say('已移動字幕（Alt＝不吸附到中線）', 'ok'); } },
      cancel() { live.abort(); scheduleStage(); },
    });
  }

  // ---- 深色／淺色（edit.css 用 html[data-ed-theme] 切換）-------
  function applyTheme(theme, save) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    doc.documentElement.setAttribute('data-ed-theme', state.theme);
    if (save) lsSet(THEME_KEY, state.theme);
    syncThemeBtn();
    if (!app.hidden) themeRepaint();
  }
  function syncThemeBtn() {
    const b = $('edThemeBtn');
    if (!b) return;
    const dark = state.theme === 'dark';
    b.setAttribute('aria-pressed', String(dark));
    b.title = `切換深色／淺色（目前：${dark ? '深色' : '淺色'}）`;
    const ic = b.querySelector('.ed-theme-ic');
    if (ic) ic.textContent = dark ? '☾' : '☀';
  }
  // 主題換了：重讀 canvas 顏色，重畫時間軸片段（縮圖／波形）、媒體庫縮圖、EQ 圖；只是重畫，不動專案
  function themeRepaint() {
    if (readColors()) { dirty.tl = dirty.media = dirty.insp = true; scheduleRender(); schedulePaint(); }
  }

  // ---- 來源模式 --------------------------------------------------------------------
  function buildSourceProject(m) {
    const p = C.createProject({ videoTracks: 1, audioTracks: 1 });
    p.nextId = 100000;                      // 讓片段 id 不要和時間軸的撞在一起（播放器用 id 管理 <video>）
    const r = C.registerMediaInfo(p, m.id, mediaInfoOf(m));
    if (!r.ok) return null;
    if (m.kind !== 'audio' && m.width > 0) C.setAspect(p, 'source', { width: m.width, height: m.height });
    const e = C.editToTimeline(p, { mode: 'overwrite', mediaId: m.id, frame: 0 });
    return e.ok ? p : null;
  }
  function openSource(id) {
    const m = mediaOf(id);
    if (!m) return;
    const p = buildSourceProject(m);
    if (!p) { say(`無法預覽「${m.name}」`, 'error'); return; }
    if (player) player.pause();
    if (state.sourceInOut && state.sourceInOut.mediaId !== id) state.sourceInOut = null;
    state.sourceMedia = id; state.selMedia = id;
    srcProject = p; state.srcFrame = 0;
    markMediaSel();
    setMode('source', true);
  }
  function closeSource() {
    state.sourceMedia = null; srcProject = null;
    if (state.mode === 'source') setMode('timeline', true);
    markMediaSel();
  }

  function setMode(mode, force) {
    if (!player) return;
    if (mode === state.mode && !force) return;
    if (mode === 'source' && !srcProject) return;
    player.pause();
    state.mode = mode;
    player.refresh();
    player.seek(mode === 'timeline' ? state.playhead : state.srcFrame);
    renderViewerChrome();
    markMediaSel();
    updatePlayheadPos(false);
    scheduleStage();
  }

  function setSourceIO(which) {
    if (state.mode !== 'source' || !srcProject) { say('在來源檢視器裡才能設定來源的 In／Out（雙擊媒體庫的素材）', 'error'); return; }
    const m = mediaOf(state.sourceMedia);
    if (!m) return;
    const sf = srcProject.fps, f = state.srcFrame;
    let io = state.sourceInOut && state.sourceInOut.mediaId === m.id ? { ...state.sourceInOut } : { mediaId: m.id, srcIn: null, srcOut: null };
    const D = m.kind === 'image' ? Infinity : m.duration;
    if (which === 'in') { io.srcIn = Math.min(f / sf, D); if (io.srcOut != null && io.srcOut <= io.srcIn) io.srcOut = null; }
    else { io.srcOut = Math.min((f + 1) / sf, D); if (io.srcIn != null && io.srcOut <= io.srcIn) io.srcIn = null; }
    state.sourceInOut = io.srcIn == null && io.srcOut == null ? null : io;
    renderViewerChrome(); renderMedia();
    say(which === 'in' ? `來源 In：${tc(f, sf)}` : `來源 Out：${tc(f, sf)}`, 'ok');
  }
  function clearSourceIO() { state.sourceInOut = null; renderViewerChrome(); renderMedia(); }

  // 模式、名稱、拖曳條、來源 In／Out 列、空狀態
  function renderViewerChrome() {
    const src = state.mode === 'source';
    for (const b of $('edVBar').querySelectorAll('.ed-segbtn')) { const on = b.dataset.mode === (src ? 'source' : 'timeline'); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
    const m = state.sourceMedia && mediaOf(state.sourceMedia);
    $('edVName').textContent = src && m ? m.name : '';
    app.classList.toggle('src-mode', src);
    const vp = viewProject();
    const dur = Math.max(1, viewDuration());
    const sc = $('edScrub');
    sc.max = String(dur);
    sc.value = String(src ? state.srcFrame : state.playhead);
    $('edTcDur').textContent = '/ ' + tc(viewDuration(), vp.fps);
    updateTransportTime();
    // 拖曳條上的 In／Out 範圍
    const io = $('edScrubIO');
    io.style.display = 'none';
    const box = $('edSrcIO');
    box.textContent = '';
    if (src && m) {
      const sf = vp.fps, sio = state.sourceInOut && state.sourceInOut.mediaId === m.id ? state.sourceInOut : null;
      const a = sio && sio.srcIn != null ? sio.srcIn : 0, b = sio && sio.srcOut != null ? sio.srcOut : (isFinite(m.duration) ? m.duration : viewDuration() / sf);
      if (sio) {
        io.style.display = 'block';
        io.style.left = (a * sf / dur * 100) + '%';
        io.style.width = (Math.max(0, b - a) * sf / dur * 100) + '%';
      }
      const bi = el('button', 'ed-btn small', '設 In（I）'); bi.type = 'button'; bi.addEventListener('click', () => setSourceIO('in'));
      const bo = el('button', 'ed-btn small', '設 Out（O）'); bo.type = 'button'; bo.addEventListener('click', () => setSourceIO('out'));
      const t = el('span', 'ed-srcio-t', sio
        ? `來源 In ${tc(Math.round(a * sf), sf)}　Out ${sio.srcOut != null ? tc(Math.round(b * sf), sf) : '到結尾'}　長度 ${fmtSec(b - a)}`
        : '來源範圍：整段（按 I／O 設定）');
      box.append(bi, bo, t);
      if (sio) { const cb = el('button', 'ed-btn small', '清除'); cb.type = 'button'; cb.addEventListener('click', clearSourceIO); box.appendChild(cb); }
    }
    const empty = !Object.keys(state.project.clips).length && !src;
    $('edEmpty').hidden = !empty;
  }
  function updateTransportTime() {
    const vp = viewProject(), f = state.mode === 'source' ? state.srcFrame : state.playhead;
    $('edTc').textContent = tc(f, vp.fps);
    const sc = $('edScrub');
    if (+sc.value !== f) sc.value = String(f);
  }
  function updatePlayButton() {
    const b = $('edPlay');
    if (!b || !player) return;
    const on = player.playing;
    b.replaceChildren(icon(on ? 'pause' : 'play'));
    b.classList.toggle('active', on);
    b.title = on ? '暫停（空白鍵）' : '播放（空白鍵）';
  }

  function onPlayerFrame(f) {
    if (state.mode === 'timeline') state.playhead = f; else state.srcFrame = f;
    updateTransportTime();
    if (state.mode === 'timeline') updatePlayheadPos(player && player.playing);
    scheduleStage();
  }

  // ---- 播放與移動播放頭 ------------------------------------------------------------
  function togglePlay() { if (player) { player.toggle(); } }
  function shuttle(dir) {
    if (!player) return;
    const r = player.rate;
    if (dir === 0) { player.shuttle(0); return; }
    if (dir > 0) player.shuttle(r > 0 ? SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(r)) + 1)] : 1);
    else player.shuttle(r < 0 ? -SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(-r)) + 1)] : -1);
  }
  function step(n) { if (player) player.stepFrames(n); }
  // 回到時間軸模式並移到某格
  function seekTimeline(f) {
    f = Math.max(0, Math.round(f));
    if (state.mode !== 'timeline') { state.playhead = f; setMode('timeline'); return; }
    state.playhead = f;
    if (player) player.seek(f);
  }
  function seekView(f) {
    if (state.mode === 'timeline') seekTimeline(f); else if (player) player.seek(Math.max(0, f));
  }
  function editPoints() {
    const p = viewProject(), s = new Set([0]);
    if (state.mode === 'timeline') for (const c of Object.values(p.clips)) { s.add(c.start); s.add(c.start + c.duration); }
    else { s.add(C.projectDuration(p)); const io = state.sourceInOut; if (io) { if (io.srcIn != null) s.add(Math.round(io.srcIn * p.fps)); if (io.srcOut != null) s.add(Math.round(io.srcOut * p.fps)); } }
    return [...s].sort((a, b) => a - b);
  }
  function jumpEdit(dir) {
    const f = state.mode === 'timeline' ? state.playhead : state.srcFrame, pts = editPoints();
    const t = dir < 0 ? [...pts].reverse().find(x => x < f) : pts.find(x => x > f);
    if (t != null) seekView(t); else seekView(dir < 0 ? 0 : pts[pts.length - 1]);
  }

  // =====================================================================================
  // 選取與編輯動作（工具列、快捷鍵、選單共用）
  // =====================================================================================
  function selectClips(ids, opts) {
    const add = opts && opts.add;
    const next = add ? new Set(state.selection) : new Set();
    for (const id of ids) {
      if (!clipOf(id)) continue;
      if (add && opts.toggle && next.has(id)) next.delete(id); else next.add(id);
    }
    state.selection = next;
    state.selTransition = null;
    if (!add) state.primary = ids.length ? ids[0] : null;
    refreshSelectionUI();
  }
  // 點一個片段：連結選取開著時連結的片段一起選
  function clickSelect(id, toggle) {
    const ids = C.expandLinked(state.project, [id], state.linkedSelection);
    state.primary = id;
    if (toggle) {
      const all = ids.every(i => state.selection.has(i));
      const next = new Set(state.selection);
      for (const i of ids) { if (all) next.delete(i); else next.add(i); }
      state.selection = next; state.selTransition = null;
      refreshSelectionUI();
    } else if (!state.selection.has(id)) selectClips(ids);
    else { state.selTransition = null; refreshSelectionUI(); }
  }
  function selectTransition(id) {
    state.selTransition = id; state.selection = new Set();
    refreshSelectionUI();
  }
  function sanitizeSelection() {
    const p = state.project;
    for (const id of [...state.selection]) if (!p.clips[id]) state.selection.delete(id);
    if (state.selTransition && !p.transitions[state.selTransition]) state.selTransition = null;
    for (const k of ['video', 'audio']) if (state.targets[k] && !C.getTrack(p, state.targets[k])) state.targets[k] = null;
  }

  // 執行一個編輯：走 history.run（失敗整個還原），失敗時在狀態列說明原因
  function op(label, fn, okMsg) {
    const r = state.history.run(label, p => fn(p));
    report(r, okMsg);
    return r;
  }

  // ---- 三點剪輯：插入／覆蓋／替換／加到結尾 ---------------------------------------------
  function editMediaId() {
    if (state.mode === 'source' && state.sourceMedia) return state.sourceMedia;
    if (state.selMedia && mediaOf(state.selMedia)) return state.selMedia;
    if (state.sourceMedia && mediaOf(state.sourceMedia)) return state.sourceMedia;
    const l = R.media.list();
    return l.length === 1 ? l[0].id : null;
  }
  const EDIT_LABEL = { insert: '插入', overwrite: '覆蓋', replace: '替換', append: '加到結尾' };
  function doEdit(mode) {
    const id = editMediaId();
    if (!id) { say(R.media.list().length ? '請先在媒體庫單擊選一個素材（或雙擊在檢視器預覽）' : '媒體庫還是空的，先把影片、音訊或圖片拖進來', 'error'); return null; }
    const m = mediaOf(id);
    ensureMediaInfo();
    const io = state.sourceInOut && state.sourceInOut.mediaId === id ? state.sourceInOut : null;
    const o = {
      mode, mediaId: id, srcIn: io && io.srcIn != null ? io.srcIn : 0, srcOut: io && io.srcOut != null ? io.srcOut : undefined,
      frame: state.playhead, trackIds: { video: targetTrack('video') && targetTrack('video').id, audio: targetTrack('audio') && targetTrack('audio').id }, name: m.name,
    };
    if (mode === 'replace' && state.mode === 'source' && state.sourceMedia === id && srcProject) o.sourceTime = state.srcFrame / srcProject.fps;
    const r = op(EDIT_LABEL[mode], p => C.editToTimeline(p, o));
    if (r && r.ok) {
      selectClips(r.ids);
      if (mode === 'insert' || mode === 'overwrite') seekTimeline(r.end); else if (mode === 'append') seekTimeline(r.start);
      afterRender(() => revealFrame(r.start, r.end));
      say(`${EDIT_LABEL[mode]}：${m.name}`, 'ok');
    }
    return r;
  }

  // ---- 刀片、刪除 ------------------------------------------------------------------
  function bladeAtPlayhead() {
    const f = state.playhead;
    const spans = c => c.start < f && f < c.start + c.duration;
    const sel = selIds().map(clipOf).filter(c => c && spans(c));
    const tracks = sel.length ? [...new Set(sel.map(c => c.trackId))] : undefined;
    const r = op('刀片', q => C.blade(q, f, tracks, { linked: state.linkedSelection }));
    if (r && r.ok) say('已在播放頭切開', 'ok');
    return r;
  }
  function deleteSelection(ripple) {
    const ids = selIds();
    if (!ids.length) {
      if (state.selTransition) { op('刪除轉場', p => C.removeTransition(p, state.selTransition)); state.selTransition = null; return; }
      say('先選取要刪除的片段', 'error'); return;
    }
    const r = op(ripple ? '波紋刪除' : '刪除', p => (ripple ? C.rippleDelete(p, ids, { linked: state.linkedSelection }) : C.lift(p, ids, { linked: state.linkedSelection })));
    if (r && r.ok) { state.selection = new Set(); refreshSelectionUI(); }
  }

  // ---- In／Out -----------------------------------------------------------------------
  function markIn() {
    if (state.mode === 'source') { setSourceIO('in'); return; }
    const f = state.playhead, o = state.project.outPoint;
    op('設定 In', p => C.setInOut(p, f, o != null && o > f ? o : null), `In：${tc(f, fps())}`);
  }
  function markOut() {
    if (state.mode === 'source') { setSourceIO('out'); return; }
    const f = state.playhead + 1, i = state.project.inPoint;
    if (f < 1) return;
    op('設定 Out', p => C.setInOut(p, i != null && i < f ? i : null, f), `Out：${tc(f - 1, fps())}`);
  }
  function clearInOut() {
    if (state.mode === 'source') { clearSourceIO(); return; }
    if (state.project.inPoint == null && state.project.outPoint == null) return;
    op('清除 In／Out', p => C.clearInOut(p), '已清除 In／Out');
  }
  // X：把 In／Out 設成選取的片段（沒有選取就用播放頭下最上層的片段）
  function markClipRange() {
    let cs = selIds().map(clipOf);
    if (!cs.length) { for (const t of videoTracksTopFirst().concat(C.tracksOf(state.project, 'audio'))) { const c = C.clipAt(state.project, t.id, state.playhead); if (c) { cs = [c]; break; } } }
    if (!cs.length) { say('先選取一個片段，或把播放頭放在片段上', 'error'); return; }
    const a = Math.min(...cs.map(c => c.start)), b = Math.max(...cs.map(c => C.clipEnd(c)));
    op('標記片段範圍', p => C.setInOut(p, a, b), `In／Out：${tc(a, fps())} – ${tc(b - 1, fps())}`);
  }

  // ---- 標記、旗標 ------------------------------------------------------------------
  function addMarkerHere() {
    const f = state.playhead;
    const c = selIds().map(clipOf).find(x => x && x.start <= f && f < C.clipEnd(x));
    if (c) {
      const had = c.markers.find(m => m.offset === f - c.start);
      if (had) { openMarkerPop('clip', had.id, c.id); return; }
      const r = op('加片段標記', p => C.addClipMarker(p, c.id, { frame: f }));
      if (r && r.ok) afterRender(() => openMarkerPop('clip', r.id, c.id));
      return;
    }
    const had = state.project.markers.find(m => m.frame === f);
    if (had) { openMarkerPop('timeline', had.id); return; }
    const r = op('加標記', p => C.addMarker(p, { frame: f }));
    if (r && r.ok) afterRender(() => openMarkerPop('timeline', r.id));
  }

  let popFlush = null;       // 關閉小視窗前要先存檔的動作
  function flushPop() { if (popFlush) { const f = popFlush; popFlush = null; try { f(); } catch (_) { /* 已被刪除 */ } } }
  function swatchRow(current, onPick, multi) {
    const row = el('div', 'ed-swatches');
    for (const name of C.MARKER_COLORS) {
      const b = el('button', 'ed-swatch'); b.type = 'button'; b.style.background = MARKER_HEX[name]; b.title = MARKER_NAME[name]; b.setAttribute('aria-label', MARKER_NAME[name]);
      b.dataset.color = name;
      const on = multi ? current.includes(name) : current === name;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => onPick(name));
      row.appendChild(b);
    }
    return row;
  }
  // 時間軸標記／片段標記的編輯小視窗：名稱、顏色、備註、刪除
  function openMarkerPop(kind, id, clipId) {
    const p = state.project;
    const clip = clipId && p.clips[clipId];
    const get = () => (kind === 'clip' ? (clip && (p.clips[clipId].markers.find(m => m.id === id))) : p.markers.find(m => m.id === id));
    const m = get();
    if (!m) return;
    flushPop();
    const box = el('div', 'ed-form');
    box.append(el('div', 'ed-form-h', kind === 'clip' ? '片段標記' : '時間軸標記'));
    const name = el('input'); name.type = 'text'; name.value = m.name || ''; name.placeholder = '名稱'; name.maxLength = 200; name.setAttribute('aria-label', '標記名稱');
    const note = el('textarea'); note.value = m.note || ''; note.placeholder = '備註'; note.rows = 3; note.maxLength = 2000; note.setAttribute('aria-label', '標記備註');
    const save = patch => {
      const r = state.history.run('編輯標記', q => (kind === 'clip' ? C.updateClipMarker(q, clipId, id, patch) : C.updateMarker(q, id, patch)));
      report(r);
    };
    const row = swatchRow(m.color, c => { save({ color: c }); closePop(); }, false);
    const act = el('div', 'ed-form-act');
    const del = el('button', 'ed-btn small danger', '刪除'); del.type = 'button';
    del.addEventListener('click', () => { popFlush = null; closePop(); state.history.run('刪除標記', q => (kind === 'clip' ? C.removeClipMarker(q, clipId, id) : C.removeMarker(q, id))); });
    const ok = el('button', 'ed-btn small primary', '完成'); ok.type = 'button';
    ok.addEventListener('click', () => closePop());
    act.append(del, ok);
    box.append(name, row, note, act);
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); closePop(); } });
    const anchor = doc.querySelector(kind === 'clip' ? `[data-cmarker="${id}"]` : `[data-marker="${id}"]`) || $('edTimeline');
    openPop(anchor, box, 'marker');
    // 關閉視窗時把名稱與備註存起來（要在 openPop 之後設，openPop 開頭會先關掉舊視窗並執行舊的存檔）
    popFlush = () => {
      const cur = get();
      if (!cur) return;
      const patch = {};
      if (name.value !== (cur.name || '')) patch.name = name.value;
      if (note.value !== (cur.note || '')) patch.note = note.value;
      if (Object.keys(patch).length) save(patch);
    };
    name.focus();
  }
  function openFlagPop(anchor) {
    const ids = selIds();
    if (!ids.length) { say('先選取要加旗標的片段', 'error'); return; }
    const box = el('div', 'ed-form');
    box.append(el('div', 'ed-form-h', '片段旗標'));
    const draw = () => {
      const cur = clipOf(lastSel());
      const flags = cur ? cur.flags : [];
      const old = box.querySelector('.ed-swatches');
      const row = swatchRow(flags, c => {
        const f = flags.includes(c) ? flags.filter(x => x !== c) : [...flags, c];
        op('旗標', p => C.setFlags(p, ids, f));
        draw();
      }, true);
      if (old) old.replaceWith(row); else box.insertBefore(row, box.querySelector('.ed-form-act'));
    };
    const act = el('div', 'ed-form-act');
    const clr = el('button', 'ed-btn small', '清除旗標'); clr.type = 'button';
    clr.addEventListener('click', () => { op('清除旗標', p => C.setFlags(p, ids, [])); draw(); });
    const ok = el('button', 'ed-btn small primary', '完成'); ok.type = 'button'; ok.addEventListener('click', closePop);
    act.append(clr, ok);
    box.appendChild(act);
    draw();
    openPop(anchor, box, 'flags');
  }

  // ---- 變速、定格 ------------------------------------------------------------------
  function speedTarget() {
    const ok = c => c && c.type === 'media' && !c.freeze && c.mediaId && mediaOf(c.mediaId) && mediaOf(c.mediaId).kind !== 'image';
    let c = selIds().map(clipOf).find(ok);
    if (!c) for (const t of videoTracksTopFirst().concat(C.tracksOf(state.project, 'audio'))) { const x = C.clipAt(state.project, t.id, state.playhead); if (ok(x)) { c = x; break; } }
    return c || null;
  }
  function openSpeedPop(anchor) {
    const c = speedTarget();
    if (!c) { say('先選取一個影片或音訊片段（圖片、字幕、定格片段不能變速）', 'error'); return; }
    const id = c.id;
    const box = el('div', 'ed-form');
    box.append(el('div', 'ed-form-h', `變速：${clipTitle(c)}`));
    const row = el('div', 'ed-form-row');
    const inp = el('input'); inp.type = 'number'; inp.id = 'edSpeedPct'; inp.min = 1; inp.max = 10000; inp.step = 5; inp.value = fmtNum(c.speed * 100, 2);
    inp.setAttribute('aria-label', '速度百分比');
    row.append(el('span', null, '速度'), inp, el('span', 'ed-unit', '%'));
    const presets = el('div', 'ed-presets');
    for (const v of [25, 50, 100, 200, 400]) { const b = el('button', 'ed-btn small', v + '%'); b.type = 'button'; b.addEventListener('click', () => { inp.value = v; }); presets.appendChild(b); }
    const rev = el('label', 'ed-chk'); const cr = el('input'); cr.type = 'checkbox'; cr.checked = !!c.reverse; cr.id = 'edSpeedRev'; rev.append(cr, doc.createTextNode('倒播'));
    const rip = el('label', 'ed-chk'); const cp = el('input'); cp.type = 'checkbox'; cp.checked = state.rippleSpeed; cp.id = 'edSpeedRipple';
    rip.append(cp, doc.createTextNode('波紋（片段長度跟著變，後面的片段一起推拉）'));
    const act = el('div', 'ed-form-act');
    const no = el('button', 'ed-btn small', '取消'); no.type = 'button'; no.addEventListener('click', closePop);
    const ok = el('button', 'ed-btn small primary', '套用'); ok.type = 'button'; ok.id = 'edSpeedOk';
    const apply = () => {
      const pct = parseFloat(inp.value);
      if (!isFinite(pct) || pct <= 0) { say('請輸入大於 0 的速度百分比', 'error'); return; }
      state.rippleSpeed = cp.checked;
      const r = op('變速', p => C.setSpeed(p, id, { speed: pct / 100, reverse: cr.checked, ripple: cp.checked, linked: state.linkedSelection }), `速度 ${fmtNum(pct, 2)}%${cr.checked ? '（倒播）' : ''}`);
      if (r && r.ok) closePop();
    };
    ok.addEventListener('click', apply);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    act.append(no, ok);
    box.append(row, presets, rev, rip, act);
    openPop(anchor, box, 'speed');
    inp.focus(); inp.select();
  }
  function freezeTarget() {
    const f = state.playhead, p = state.project;
    const ok = c => c && c.type === 'media' && c.mediaId && mediaOf(c.mediaId) && mediaOf(c.mediaId).kind === 'video' && c.start <= f && f < C.clipEnd(c) && C.getTrack(p, c.trackId).kind === 'video';
    let c = selIds().map(clipOf).find(ok);
    if (!c) for (const t of videoTracksTopFirst()) { const x = C.clipAt(p, t.id, f); if (ok(x)) { c = x; break; } }
    return c || null;
  }
  function openFreezePop(anchor) {
    const c = freezeTarget();
    if (!c) { say('把播放頭放在影片片段上（或先選取它），才能定格', 'error'); return; }
    const id = c.id, f = state.playhead;
    const box = el('div', 'ed-form');
    box.append(el('div', 'ed-form-h', `定格：${clipTitle(c)}（${tc(f, fps())}）`));
    const row = el('div', 'ed-form-row');
    const inp = el('input'); inp.type = 'number'; inp.id = 'edFreezeSec'; inp.min = 0.1; inp.step = 0.5; inp.value = String(C.DEFAULT_FREEZE_SEC);
    inp.setAttribute('aria-label', '定格長度（秒）');
    row.append(el('span', null, '長度'), inp, el('span', 'ed-unit', '秒'));
    const hint = el('div', 'ed-hint', '「插入定格」會在播放頭切開並插入一段定格畫面，後面的片段往後推；「整段變定格」則把這個片段全部變成這一格。');
    const act = el('div', 'ed-form-act');
    const whole = el('button', 'ed-btn small', '整段變定格'); whole.type = 'button'; whole.id = 'edFreezeWhole';
    whole.addEventListener('click', () => { const r = op('定格', p => C.freezeFrame(p, id, f), '已把片段變成定格'); if (r && r.ok) closePop(); });
    const ins = el('button', 'ed-btn small primary', '插入定格'); ins.type = 'button'; ins.id = 'edFreezeIns';
    const apply = () => {
      const sec = parseFloat(inp.value);
      if (!isFinite(sec) || sec <= 0) { say('請輸入大於 0 的秒數', 'error'); return; }
      const r = op('插入定格', p => C.freezeFrame(p, id, f, { duration: Math.max(1, Math.round(sec * p.fps)) }), `已插入 ${fmtNum(sec, 2)} 秒定格`);
      if (r && r.ok) { closePop(); selectClips([r.id]); }
    };
    ins.addEventListener('click', apply);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    act.append(whole, ins);
    box.append(row, hint, act);
    openPop(anchor, box, 'freeze');
    inp.focus(); inp.select();
  }

  // ---- 轉場、字幕 ------------------------------------------------------------------
  // 轉場加在影片軌片段的邊緣（同 DaVinci：轉場屬於片段邊緣）：
  //   結尾：後面緊接著片段 = 兩片段之間；否則 = 尾端淡出。開頭：前面緊接著片段 = 兩片段之間；否則（空隙、時間軸起點）= 開頭淡入。
  const TRANS_SIDE_TEXT = { both: '兩片段之間', out: '尾端淡出', in: '開頭淡入' };
  function transitionTarget() {
    const p = state.project;
    const vids = selIds().map(clipOf).filter(c => c && C.getTrack(p, c.trackId).kind === 'video');
    return vids.length ? vids[vids.length - 1] : null;
  }
  function addTransitionToSelection(type, edge) {
    const c = transitionTarget();
    if (!c) { say(`先選取一個影片軌上的片段，轉場會加在它的${edge === 'start' ? '開頭' : '結尾'}`, 'error'); return; }
    addTransitionAt(c.id, type, edge);
  }
  // edge：'end'（預設，加在 clipId 的結尾）或 'start'（加在 clipId 的開頭）
  function addTransitionAt(clipId, type, edge) {
    const o = edge === 'start' ? { rightClipId: clipId, type } : { leftClipId: clipId, type };
    const r = op('加轉場', p => C.addTransition(p, o));
    if (r && r.ok) {
      selectTransition(r.id);
      const where = { both: '加在兩個片段之間', out: '加在片段結尾（淡出）', in: '加在片段開頭（淡入）' }[r.side] || '已加入';
      say(`${(F.TRANSITIONS[type] || {}).name || '轉場'}：${where}`, 'ok');
    }
    return r;
  }

  function trackFreeAt(p, track, start, dur) {
    return !track.locked && !C.clipsOnTrack(p, track.id).some(c => c.start < start + dur && C.clipEnd(c) > start);
  }
  // 新增字幕：track 沒指定時放在最上層沒被佔用的影片軌，都被佔用就新增一條影片軌
  function addTitle(preset, trackId, start) {
    const dur = Math.max(1, Math.round(state.project.fps * 3));
    const at = start == null ? state.playhead : start;
    const def = (F.TITLE_PRESETS || {})[preset] || {};
    const r = op('加字幕', p => {
      let tid = trackId;
      if (!tid) {
        const free = videoTracksTopFirst().find(t => trackFreeAt(p, t, at, dur));
        if (free) tid = free.id; else { const a = C.addTrack(p, 'video'); if (!a.ok) return a; tid = a.id; }
      }
      const st = F.TITLE_STYLES && F.TITLE_STYLES[lib.tstyle];   // 新增的字幕套用目前選取的字幕樣式
      const title = Object.assign(F.makeTitle(preset, '輸入字幕'), st ? JSON.parse(JSON.stringify(st.patch)) : {});
      return C.addClip(p, { type: 'title', trackId: tid, start: at, duration: dur, mode: 'overwrite', title, name: def.name || '字幕' });
    });
    if (r && r.ok) {
      selectClips([r.id]);
      afterRender(() => revealFrame(r.start, r.end));
      say('已新增字幕：在右側詳細內容改文字與樣式', 'ok');
    }
    return r;
  }

  // ---- 字幕清單：SRT 匯入、V 標記 ---------------------------------------------------------
  // 字幕清單的片段＝title.sub 為 true 的字幕片段，放在名為「字幕」的影片軌（沒有就在最上層新增一條）
  const SUB_TRACK = '字幕', SUB_MAX_SEC = 10;
  const isSrtFile = f => /\.srt$/i.test((f && f.name) || '');
  const subClips = () => Object.values(state.project.clips).filter(isSubClip).sort((a, b) => a.start - b.start);
  function subTrackId(p) {
    const t = C.tracksOf(p, 'video').find(x => x.name === SUB_TRACK && !x.locked);
    if (t) return { ok: true, id: t.id };
    const a = C.addTrack(p, 'video');
    if (!a.ok) return a;
    const r = C.setTrackProps(p, a.id, { name: SUB_TRACK });
    return r.ok ? { ok: true, id: a.id } : r;
  }
  function subTitle(text) {
    const st = F.TITLE_STYLES && F.TITLE_STYLES[lib.tstyle];
    const t = Object.assign(F.makeTitle('static', text), { size: 64, y: 0.86 }, st ? JSON.parse(JSON.stringify(st.patch)) : {});
    if (!st || lib.tstyle === 'plain') t.stroke = { color: '#000000', width: 6 };   // 沒選樣式時加黑邊，字幕在亮的畫面上才看得清楚
    t.sub = true;
    return t;
  }
  const subMarkOn = () => state.mode === 'timeline' && (lib.tab === 'title' || (primaryClip() && primaryClip().type === 'title'));
  function updateSubMark() { const b = $('edSubMark'); if (b) b.hidden = !subMarkOn(); }
  // V：在播放頭加一段字幕。規則見 fx.planSubtitleMark（最長 10 秒、碰到下一段就停、正在播的前一段改成在這格前結束）
  function markSubtitle() {
    if (state.mode !== 'timeline') { say('切到「時間軸」才能標記字幕', 'error'); return null; }
    const f = state.playhead, fps = state.project.fps;
    const plan = F.planSubtitleMark(subClips().map(c => ({ id: c.id, start: c.start, end: c.start + c.duration })), f, fps, SUB_MAX_SEC);
    if (plan.existing) { selectClips([plan.existing]); showSubsTab(plan.existing); say('這一格已經有字幕了', 'ok'); return null; }
    const r = op('字幕標記', p => {
      if (plan.trimPrev) {
        const pc = p.clips[plan.trimPrev.id];
        const t = C.trimEdge(p, pc.id, 'end', plan.trimPrev.end - (pc.start + pc.duration), { linked: false });
        if (!t.ok) return t;
      }
      const tr = subTrackId(p);
      if (!tr.ok) return tr;
      return C.addClip(p, { type: 'title', trackId: tr.id, start: plan.start, duration: plan.end - plan.start, mode: 'overwrite', title: subTitle(''), name: '字幕' });
    });
    if (r && r.ok) {
      selectClips([r.id]);
      showSubsTab(r.id);
      say(`已標記字幕 ${tc(plan.start, fps)}（${fmtNum((plan.end - plan.start) / fps, 2)} 秒）：在右側字幕清單輸入文字`, 'ok');
    }
    return r;
  }
  function showSubsTab(id) {
    loadTabOf().sub = 'subs';
    insp.revealSub = id;
    scheduleInspector();
  }
  async function readText(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { /* 不是 UTF-8：台灣常見的舊字幕檔是 Big5 */ }
    try { return new TextDecoder('big5').decode(buf); } catch (_) { return new TextDecoder('utf-8').decode(buf); }
  }
  async function importSrt(file) {
    let text;
    try { text = await readText(file); } catch (e) { say(`讀不到「${file.name}」`, 'error'); return null; }
    const cues = F.parseSrt(text, state.project.fps);
    if (!cues.length) { say(`「${file.name}」裡找不到字幕（請確認是 SRT 格式）`, 'error'); return null; }
    const r = op('匯入 SRT', p => {
      const tr = subTrackId(p);
      if (!tr.ok) return tr;
      const ids = [];
      for (const c of cues) {
        const a = C.addClip(p, { type: 'title', trackId: tr.id, start: c.start, duration: c.end - c.start, mode: 'overwrite', title: subTitle(c.text), name: '字幕' });
        if (!a.ok) return a;
        ids.push(a.id);
      }
      return { ok: true, ids };
    });
    if (r && r.ok) {
      selectClips([r.ids[0]]);
      showSubsTab(r.ids[0]);
      afterRender(() => revealFrame(cues[0].start, cues[cues.length - 1].end));
      say(`已匯入 ${cues.length} 段字幕（「${SUB_TRACK}」軌）`, 'ok');
    }
    return r;
  }

  // 匯出 SRT：字幕清單（「字幕」軌）的字幕；沒有的話改用時間軸上所有有文字的字幕片段
  function srtCues() {
    const all = Object.values(state.project.clips).filter(c => c.type === 'title' && c.title && String(c.title.text || '').trim());
    const subs = all.filter(isSubClip);
    return (subs.length ? subs : all).map(c => ({ start: c.start, end: c.start + c.duration, text: c.title.text }));
  }
  function exportSrt() {
    const cues = srtCues();
    const text = cues.length ? F.formatSrt(cues, state.project.fps) : '';
    if (!text) { say('時間軸上沒有可以匯出的字幕文字', 'error'); return null; }
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const filename = `字幕_${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}.srt`;
    const a = doc.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-subrip;charset=utf-8' }));
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    const n = (text.match(/ --> /g) || []).length;
    say(`已匯出 ${n} 段字幕：${filename}`, 'ok');
    return { ok: true, filename, text, count: n };
  }

  // 字幕樣式／字體特效套用到字幕片段：ids 沒給就用選取中的字幕片段
  function titleTargets(ids) {
    return (ids || selIds()).filter(id => { const c = clipOf(id); return c && c.type === 'title'; });
  }
  function applyTitlePatch(label, patch, ids, okMsg) {
    const list = titleTargets(ids);
    if (!list.length) { say('請先在時間軸選取字幕片段（或把它拖到字幕片段上）', 'error'); return null; }
    const r = op(label, p => C.setClipProps(p, list, { title: patch }));
    if (r && r.ok) { if (player && !player.playing) player.refresh(); say(list.length > 1 ? `${okMsg}（${list.length} 個字幕）` : okMsg, 'ok'); }
    return r;
  }
  function applyTitleStyle(key, ids) {
    const st = F.TITLE_STYLES && F.TITLE_STYLES[key];
    if (!st) return null;
    return applyTitlePatch('字幕樣式', JSON.parse(JSON.stringify(st.patch)), ids, `已套用字幕樣式「${st.name}」`);
  }
  function applyTextFx(kind, ids) {
    const d = F.TEXT_FX && F.TEXT_FX[kind];
    if (!d) return null;
    return applyTitlePatch('字體特效', { textFx: kind }, ids, kind === 'none' ? '已移除字體特效' : `已套用字體特效「${d.name}」`);
  }

  // ---- 開關、復原 ------------------------------------------------------------------
  function toggleLink() {
    state.linkedSelection = !state.linkedSelection;
    updateToolbar();
    say(state.linkedSelection ? '連結選取：開（連結的影像與聲音一起動）' : '連結選取：關（可以單獨移動，會出現紅色的不同步偏移）', 'ok');
  }
  function toggleSnap() {
    state.snapping = !state.snapping;
    updateToolbar();
    say(state.snapping ? '吸附：開' : '吸附：關', 'ok');
  }
  function setTool(t) {
    if (!['select', 'blade', 'trim'].includes(t)) return;
    state.tool = t;
    updateToolbar();
    app.dataset.tool = t;
    setActionLabel('');
  }
  function undo() { if (state.history.busy) return say('調整中，放開滑鼠後再復原'); const lab = state.history.undoLabel; if (state.history.undo()) say(`已復原：${lab}`, 'ok'); else say('沒有可以復原的動作'); }
  function redo() { if (state.history.busy) return say('調整中，放開滑鼠後再重做'); const lab = state.history.redoLabel; if (state.history.redo()) say(`已重做：${lab}`, 'ok'); else say('沒有可以重做的動作'); }
  function linkSelection(link) {
    const ids = selIds();
    if (!ids.length) { say('先選取片段', 'error'); return; }
    op(link ? '連結' : '取消連結', p => (link ? C.link(p, ids) : C.unlink(p, ids)), link ? '已連結' : '已取消連結');
  }

  // =====================================================================================
  // 工具列
  // =====================================================================================
  const isMac = /Mac|iPhone|iPad/.test((root.navigator && root.navigator.platform) || '');
  const MOD = isMac ? '⌘' : 'Ctrl+';
  function buildToolbar() {
    const tb = $('edToolbar');
    tb.textContent = '';
    const btn = (id, label, key, title, fn, cls) => {
      const b = el('button', 'ed-btn tb' + (cls ? ' ' + cls : '')); b.type = 'button'; b.id = id;
      b.append(el('span', 'ed-bl', label));
      if (key) b.append(el('kbd', 'ed-k', key));
      b.title = title + (key ? `（${key}）` : '');
      b.addEventListener('click', () => { fn(b); });
      return b;
    };
    const grp = (cls, ...kids) => { const g = el('div', 'ed-tbgroup' + (cls ? ' ' + cls : '')); g.append(...kids); tb.appendChild(g); return g; };

    grp('tools',
      btn('edToolSelect', '選取', 'A', '選取工具：點選、拖曳移動片段、拖片段邊緣做一般修剪', () => setTool('select')),
      btn('edToolBlade', '刀片', 'B', '刀片工具：點片段切開', () => setTool('blade')),
      btn('edToolTrim', '修剪', 'T', '修剪工具：游標在片段邊緣＝波紋修剪、兩片段交界＝滾動、片段上半部＝滑移、下半部＝滑動', () => setTool('trim')));
    const act = el('span', 'ed-action'); act.id = 'edAction'; act.setAttribute('aria-live', 'polite');
    act.title = '目前游標會做的動作';
    tb.lastChild.appendChild(act);

    grp('edit',
      btn('edInsert', '插入', 'F9', '插入：把來源放在播放頭（或時間軸 In），後面的片段往後推', () => doEdit('insert')),
      btn('edOverwrite', '覆蓋', 'F10', '覆蓋：把來源放在播放頭（或時間軸 In），蓋掉原本的內容', () => doEdit('overwrite')),
      btn('edReplace', '替換', 'F11', '替換：用來源取代播放頭位置的片段，長度不變', () => doEdit('replace')),
      btn('edAppend', '加到結尾', 'F12', '加到結尾：把來源接在目的軌道最後一個片段後面', () => doEdit('append'), 'strong'));

    grp('del',
      btn('edDelete', '刪除', '', '刪除選取的片段（留下空隙）。快捷鍵 Delete', () => deleteSelection(false)),
      btn('edRipple', '波紋刪除', '', '波紋刪除：刪掉並把後面的片段補上來。快捷鍵 Shift+Delete 或 Backspace', () => deleteSelection(true)));

    const bl = btn('edToggleLink', '連結選取', '', '連結選取：開啟時連結的影像與聲音一起選、一起動。快捷鍵 ' + MOD + 'Shift+L', toggleLink, 'toggle');
    const bs = btn('edToggleSnap', '吸附', 'N', '吸附：拖曳時貼齊片段邊緣、播放頭、標記、In／Out', toggleSnap, 'toggle');
    grp('toggles', bl, bs);

    grp('mark',
      btn('edMarkIn', '設 In', 'I', '把播放頭設成 In（來源模式時設來源的 In）', markIn),
      btn('edMarkOut', '設 Out', 'O', '把播放頭設成 Out（來源模式時設來源的 Out）', markOut),
      btn('edClearIO', '清除 In／Out', '', '清除 In／Out。快捷鍵 Alt+X', clearInOut),
      btn('edMarker', '標記', 'M', '在播放頭加標記（選取的片段在播放頭下時加片段標記）', addMarkerHere),
      btn('edFlag', '旗標', '', '替選取的片段加旗標顏色', b => { b.dataset.pop = '1'; openFlagPop(b); }),
      btn('edSpeed', '變速', MOD + 'R', '變速：速度百分比、倒播、波紋', b => { b.dataset.pop = '1'; openSpeedPop(b); }),
      btn('edFreeze', '定格', '⇧R', '定格：在播放頭插入定格畫面，或把整個片段變成定格', b => { b.dataset.pop = '1'; openFreezePop(b); }));

    grp('hist',
      btn('edUndo', '復原', MOD + 'Z', '復原', undo),
      btn('edRedo', '重做', MOD + '⇧Z', '重做', redo));
    for (const id of ['edUndo', 'edRedo']) { const s = el('span', 'ed-ulab'); s.id = id + 'Lab'; $(id).appendChild(s); }
    wireToolbarScroll(tb);
  }
  // 工具列只有一排、超出就左右捲動：滑鼠滾輪（直向）在工具列上轉成橫向捲動；觸控板橫向滑動與拖曳細捲軸由瀏覽器處理；
  // 左右邊緣的漸層遮罩（.fade-l／.fade-r）依捲動位置顯示
  function updateTbFade() {
    const tb = $('edToolbar');
    if (!tb) return;
    const max = tb.scrollWidth - tb.clientWidth;
    tb.classList.toggle('fade-l', tb.scrollLeft > 1);
    tb.classList.toggle('fade-r', max > 1 && tb.scrollLeft < max - 1);
  }
  function wireToolbarScroll(tb) {
    tb.addEventListener('scroll', updateTbFade, { passive: true });
    tb.addEventListener('wheel', e => {
      if (e.ctrlKey || tb.scrollWidth <= tb.clientWidth + 1) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;            // 本來就是橫向（觸控板）：照瀏覽器預設
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * tb.clientWidth : e.deltaY;
      const before = tb.scrollLeft;
      tb.scrollLeft = before + d;
      if (tb.scrollLeft !== before) e.preventDefault();                 // 已經捲到底就讓頁面自己處理
    }, { passive: false });
    if (typeof root.ResizeObserver === 'function') new root.ResizeObserver(updateTbFade).observe(tb);
    updateTbFade();
  }
  function updateToolbar() {
    for (const [id, tool] of [['edToolSelect', 'select'], ['edToolBlade', 'blade'], ['edToolTrim', 'trim']]) {
      const b = $(id); b.classList.toggle('active', state.tool === tool); b.setAttribute('aria-pressed', String(state.tool === tool));
    }
    for (const [id, on] of [['edToggleLink', state.linkedSelection], ['edToggleSnap', state.snapping]]) { const b = $(id); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
    const h = state.history;
    const u = $('edUndo'), r = $('edRedo');
    u.disabled = !h.canUndo; r.disabled = !h.canRedo;
    $('edUndoLab').textContent = h.undoLabel || '';
    $('edRedoLab').textContent = h.redoLabel || '';
    u.title = h.canUndo ? `復原：${h.undoLabel}（${MOD}Z）` : '沒有可以復原的動作';
    r.title = h.canRedo ? `重做：${h.redoLabel}（${MOD}⇧Z）` : '沒有可以重做的動作';
    const hasSel = selIds().length > 0 || !!state.selTransition;
    $('edDelete').disabled = !hasSel; $('edRipple').disabled = !hasSel;
    $('edClearIO').disabled = state.mode === 'source' ? !state.sourceInOut : (state.project.inPoint == null && state.project.outPoint == null);
    updateTbFade();
  }

  // =====================================================================================
  // 快捷鍵
  // =====================================================================================
  function onKeyDown(e) {
    if (app.hidden || e.defaultPrevented) return;
    if (doc.querySelector('dialog[open]')) return;                 // 匯出對話框開著
    if (isTextTarget(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    const key = e.key, lk = key.length === 1 ? key.toLowerCase() : key;
    const mod = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const fresh = !e.repeat;
    // 拖曳中（時間軸或詳細內容的數值拖曳，history 在 begin 之後）：只留 Esc（拖曳自己的 capture 監聽會處理）；
    // 其他會改專案的快捷鍵一律擋掉，不然 Delete／刀片／復原會跟拖曳的 cancel＋重套打架，放開後專案或復原堆疊會亂掉
    if (drag || live.started || (state.history && state.history.busy)) { if (key !== 'Escape' && key !== 'Shift' && key !== 'Alt' && key !== 'Control' && key !== 'Meta') done(); return; }

    // 復原／重做
    if (mod && lk === 'z') { done(); if (shift) redo(); else undo(); return; }
    if (mod && lk === 'y') { done(); redo(); return; }
    if (mod && !shift && lk === 'b') { done(); if (fresh) bladeAtPlayhead(); return; }
    if (mod && shift && lk === 'l') { done(); if (fresh) toggleLink(); return; }
    if (mod && !shift && lk === 'r') { done(); if (fresh) openSpeedPop($('edSpeed')); return; }
    if (mod && !shift && lk === 'a') { done(); selectClips(Object.keys(state.project.clips)); return; }
    if (mod || (alt && lk !== 'x')) return;                         // 其他組合鍵交給瀏覽器

    switch (key) {
      case ' ': done(); if (fresh) togglePlay(); return;
      case 'ArrowLeft': done(); step(shift ? -fps() : -1); return;
      case 'ArrowRight': done(); step(shift ? fps() : 1); return;
      case 'ArrowUp': done(); if (fresh) jumpEdit(-1); return;
      case 'ArrowDown': done(); if (fresh) jumpEdit(1); return;
      case 'Home': done(); seekView(0); return;
      case 'End': done(); seekView(viewDuration()); return;
      case 'Delete': done(); if (fresh) deleteSelection(shift); return;
      case 'Backspace': done(); if (fresh) deleteSelection(true); return;
      case 'F9': done(); if (fresh) doEdit('insert'); return;
      case 'F10': done(); if (fresh) doEdit('overwrite'); return;
      case 'F11': done(); if (fresh) doEdit('replace'); return;
      case 'F12': done(); if (fresh) doEdit('append'); return;
      case 'Escape':
        if (popEl || menuEl) { closePop(); closeMenu(); done(); return; }
        if (state.selection.size || state.selTransition) { done(); selectClips([]); }
        return;
      default:
    }
    if (alt) { if (lk === 'x') { done(); clearInOut(); } return; }
    switch (lk) {
      case 'a': done(); setTool('select'); break;
      case 'b': done(); setTool('blade'); break;
      case 't': done(); setTool('trim'); break;
      case 'i': done(); if (fresh) markIn(); break;
      case 'o': done(); if (fresh) markOut(); break;
      case 'x': done(); if (fresh) markClipRange(); break;
      case 'n': done(); if (fresh) toggleSnap(); break;
      case 'm': done(); if (fresh) addMarkerHere(); break;
      case 'v': if (subMarkOn()) { done(); if (fresh) markSubtitle(); } break;
      case 'j': done(); if (fresh) shuttle(-1); break;
      case 'k': done(); if (fresh) shuttle(0); break;
      case 'l': done(); if (fresh) shuttle(1); break;
      case 'r': if (shift) { done(); if (fresh) openFreezePop($('edFreeze')); } break;
      case 'z': if (shift) { done(); zoomFit(); } break;
      case '=': case '+': done(); zoomBy(1.25); break;
      case '-': case '_': done(); zoomBy(0.8); break;
      default:
    }
  }
  function onKeyUp(e) {
    // 空白鍵按在按鈕上時，放開會再「點」一次那顆按鈕：這裡擋掉
    if (!app.hidden && e.key === ' ' && !isTextTarget(e.target)) e.preventDefault();
  }

  // =====================================================================================
  // 時間軸：畫面
  // =====================================================================================
  const tl = { scroll: null, inner: null, k: 1, contentW: 0, overlay: null, playhead: null, phHead: null, snapLine: null, bladeLine: null, dropLine: null, marquee: null, edgeTc: null, edgeAt: null };

  function buildTimeline() {
    const host = $('edTimeline');
    host.textContent = '';
    const bar = el('div', 'ed-tl-bar');
    const zl = el('label', 'ed-zoomlab'); zl.htmlFor = 'edZoom'; zl.textContent = '縮放';
    const zr = el('input'); zr.type = 'range'; zr.id = 'edZoom'; zr.min = 0; zr.max = 100; zr.step = 1; zr.title = '水平縮放（Ctrl＋滾輪，或按 ＋／－）';
    zr.addEventListener('input', () => setZoom(sliderToZoom(+zr.value), true));
    const mkb = (id, text, title, fn) => { const b = el('button', 'ed-btn small', text); b.type = 'button'; b.id = id; b.title = title; b.addEventListener('click', fn); return b; };
    bar.append(zl, mkb('edZoomOut', '－', '縮小（-）', () => zoomBy(0.8)), zr, mkb('edZoomIn', '＋', '放大（+）', () => zoomBy(1.25)),
      mkb('edZoomFit', '全部顯示', '把整個時間軸縮放到剛好看完（Shift+Z）', zoomFit));
    bar.append(el('span', 'ed-spacer'));
    bar.append(mkb('edAddV', '＋ 影片軌', '新增一條影片軌（放在最上層）', () => op('新增影片軌', p => C.addTrack(p, 'video'))),
      mkb('edAddA', '＋ 音訊軌', '新增一條音訊軌', () => op('新增音訊軌', p => C.addTrack(p, 'audio'))));

    tl.scroll = el('div', 'ed-tl-scroll');
    tl.scroll.tabIndex = -1;
    tl.inner = el('div', 'ed-tl-inner');
    tl.scroll.appendChild(tl.inner);
    const foot = el('div', 'ed-tl-foot');
    statusEl = el('div', 'ed-status'); statusEl.id = 'edStatus'; statusEl.setAttribute('role', 'status'); statusEl.setAttribute('aria-live', 'polite');
    const keys = el('div', 'ed-keys', 'A 選取　B 刀片　T 修剪　I／O 入出點　F9 插入　F10 覆蓋　F12 加到結尾　空白鍵 播放　' + MOD + 'Z 復原　' + MOD + '滾輪 縮放');
    foot.append(statusEl, keys);
    host.append(bar, tl.scroll, foot);

    tl.scroll.addEventListener('scroll', () => { schedulePaint(); closeMenu(); }, { passive: true });
    tl.scroll.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAround(Math.pow(1.0018, -e.deltaY), e.clientX);
    }, { passive: false });
    if (typeof root.ResizeObserver === 'function') new root.ResizeObserver(() => { if (!app.hidden) scheduleRender('tl'); }).observe(tl.scroll);
  }

  // ---- 縮放 ------------------------------------------------------------------------
  const zoomMax = () => state.project.fps * 48;                       // 一格 48 像素
  const sliderToZoom = v => ZOOM_MIN * Math.pow(zoomMax() / ZOOM_MIN, v / 100);
  const zoomToSlider = z => Math.round(Math.log(z / ZOOM_MIN) / Math.log(zoomMax() / ZOOM_MIN) * 100);
  function setZoom(z, keepCenter) {
    z = clamp(z, ZOOM_MIN, zoomMax());
    if (Math.abs(z - state.zoom) < 1e-6) return;
    const sc = tl.scroll;
    let anchorFrame = null, anchorOff = 0;
    if (keepCenter && sc) {                  // 以播放頭（在畫面內時）或畫面中央為基準
      const vis = sc.clientWidth - HEAD_W, phx = state.playhead * tl.k;
      if (phx >= sc.scrollLeft && phx <= sc.scrollLeft + vis) { anchorFrame = state.playhead; anchorOff = phx - sc.scrollLeft; }
      else { anchorFrame = (sc.scrollLeft + vis / 2) / tl.k; anchorOff = vis / 2; }
    }
    state.zoom = z;
    renderTimeline(true);
    if (anchorFrame != null) sc.scrollLeft = Math.max(0, anchorFrame * tl.k - anchorOff);
    schedulePaint();
  }
  function zoomBy(f) { setZoom(state.zoom * f, true); }
  function zoomAround(f, clientX) {
    const sc = tl.scroll, r = tl.inner.getBoundingClientRect();
    const x = clientX - r.left - HEAD_W;                      // 滑鼠在內容裡的位置（像素）
    const fr = x / tl.k, off = x - sc.scrollLeft;
    const z = clamp(state.zoom * f, ZOOM_MIN, zoomMax());
    if (Math.abs(z - state.zoom) < 1e-6) return;
    state.zoom = z;
    renderTimeline(true);
    sc.scrollLeft = Math.max(0, fr * tl.k - off);
    schedulePaint();
  }
  function zoomFit() {
    const dur = Math.max(C.projectDuration(state.project), state.project.fps * 4);
    const vis = tl.scroll.clientWidth - HEAD_W - 30;
    setZoom(vis / dur * state.project.fps, false);
    tl.scroll.scrollLeft = 0;
  }

  // 內容 x（像素） ↔ 影格
  const xToFrame = clientX => (clientX - tl.inner.getBoundingClientRect().left - HEAD_W) / tl.k;
  // 讓 [a, b) 影格出現在畫面內
  function revealFrame(a, b) {
    const sc = tl.scroll, vis = sc.clientWidth - HEAD_W, x0 = a * tl.k, x1 = b * tl.k;
    if (x0 < sc.scrollLeft || x0 > sc.scrollLeft + vis) sc.scrollLeft = Math.max(0, x0 - 60);
    else if (x1 > sc.scrollLeft + vis) sc.scrollLeft = Math.max(0, Math.min(x0 - 60, x1 - vis + 40));
  }

  // ---- 畫面排程 --------------------------------------------------------------------
  const dirty = { tl: false, insp: false, media: false, chrome: false };
  let rafId = 0, paintRaf = 0;
  const afterQ = [];
  function scheduleRender(what) {
    if (!what || what === 'all') { dirty.tl = dirty.insp = dirty.chrome = true; }
    else dirty[what] = true;
    if (!rafId) rafId = requestAnimationFrame(flush);
  }
  function scheduleInspector() { scheduleRender('insp'); }
  function afterRender(fn) { afterQ.push(fn); if (!rafId) rafId = requestAnimationFrame(flush); }
  function flush() {
    rafId = 0;
    if (app.hidden || !tl.inner) return;                 // 看不到時先不畫，等 onShow
    if (dirty.tl) { dirty.tl = false; renderTimeline(); }
    if (dirty.media) { dirty.media = false; renderMedia(); }
    if (dirty.insp) { dirty.insp = false; renderInspector(); }
    if (dirty.chrome) { dirty.chrome = false; renderViewerChrome(); syncAspect(); updateToolbar(); }
    const q = afterQ.splice(0);
    for (const f of q) try { f(); } catch (e) { say((e && e.message) || String(e), 'error'); }
  }
  function renderNow() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } flush(); }
  function schedulePaint() { if (!paintRaf) paintRaf = requestAnimationFrame(() => { paintRaf = 0; paintVisible(); }); }

  // ---- 時間尺 ----------------------------------------------------------------------
  function tickStep(fpsv, k) {
    const cand = [1, 2, 5, 10, Math.round(fpsv / 2), fpsv, 2 * fpsv, 5 * fpsv, 10 * fpsv, 15 * fpsv, 30 * fpsv, 60 * fpsv, 120 * fpsv, 300 * fpsv, 600 * fpsv, 1800 * fpsv, 3600 * fpsv];
    const list = [...new Set(cand.filter(x => x >= 1))].sort((a, b) => a - b);
    return list.find(s => s * k >= 96) || list[list.length - 1];
  }

  function renderTimeline() {
    const p = state.project, fpsv = p.fps, k = state.zoom / fpsv;
    const sc = tl.scroll, inner = tl.inner;
    const sl = sc.scrollLeft, st = sc.scrollTop;
    const viewW = Math.max(200, sc.clientWidth - HEAD_W);
    const dur = C.projectDuration(p);
    const frames = Math.max(Math.ceil(dur * 1.12 + fpsv * 6), Math.ceil(viewW / k));
    const contentW = Math.ceil(frames * k);
    tl.k = k; tl.contentW = contentW;
    // 片段縮圖／波形的畫布留著重用：拖曳時每次移動都會重建時間軸，片段內容沒變就不用重畫（paintVisible 會比對 key）
    tl.reuse = new Map();
    for (const e of inner.querySelectorAll('.ed-clip')) { const cv = e.firstChild; if (cv && cv.dataset.key) tl.reuse.set(e.dataset.clip, cv); }
    inner.textContent = '';
    inner.style.width = (HEAD_W + contentW) + 'px';

    // 時間尺
    const rrow = el('div', 'ed-ruler-row');
    const corner = el('div', 'ed-corner');
    corner.textContent = tc(state.playhead, fpsv);
    corner.id = 'edTlTc';
    corner.title = '播放頭位置';
    const ruler = el('div', 'ed-ruler'); ruler.style.width = contentW + 'px';
    const step = tickStep(fpsv, k);
    const minor = step * k / 5;
    if (minor >= 6) { ruler.style.backgroundImage = `repeating-linear-gradient(to right, var(--ed-tick) 0 1px, transparent 1px ${minor}px)`; ruler.style.backgroundSize = '100% 6px'; ruler.style.backgroundRepeat = 'no-repeat'; ruler.style.backgroundPosition = 'left bottom'; }
    for (let f = 0; f <= frames; f += step) {
      const t = el('div', 'ed-tick'); t.style.left = (f * k) + 'px';
      t.appendChild(el('span', null, tc(f, fpsv)));
      ruler.appendChild(t);
    }
    // In／Out 範圍（時間尺上的色帶）
    if (p.inPoint != null || p.outPoint != null) {
      const a = p.inPoint != null ? p.inPoint : 0, b = p.outPoint != null ? p.outPoint : frames;
      const band = el('div', 'ed-io-band'); band.style.left = (a * k) + 'px'; band.style.width = Math.max(2, (b - a) * k) + 'px';
      ruler.appendChild(band);
      if (p.inPoint != null) { const f = el('div', 'ed-io-flag in'); f.style.left = (p.inPoint * k) + 'px'; f.title = `In ${tc(p.inPoint, fpsv)}`; ruler.appendChild(f); }
      if (p.outPoint != null) { const f = el('div', 'ed-io-flag out'); f.style.left = (p.outPoint * k) + 'px'; f.title = `Out ${tc(p.outPoint - 1, fpsv)}`; ruler.appendChild(f); }
    }
    // 時間軸標記
    for (const m of p.markers) {
      const e = el('div', 'ed-mk'); e.dataset.marker = m.id;
      e.style.left = (m.frame * k) + 'px'; e.style.setProperty('--c', MARKER_HEX[m.color] || MARKER_HEX.blue);
      if (m.duration > 0) e.style.setProperty('--w', Math.max(8, m.duration * k) + 'px');
      e.title = `${m.name || '標記'}（${MARKER_NAME[m.color] || ''}，${tc(m.frame, fpsv)}）${m.note ? '\n' + m.note : ''}`;
      ruler.appendChild(e);
    }
    tl.phHead = el('div', 'ed-ph-head');
    ruler.appendChild(tl.phHead);
    rrow.append(corner, ruler);
    inner.appendChild(rrow);

    // 軌道：影片軌（高層在上）→ 音訊軌
    const rows = el('div', 'ed-rows');
    const order = [...videoTracksTopFirst(), ...C.tracksOf(p, 'audio')];
    const aplan = C.audioTransitionPlan ? C.audioTransitionPlan(p) : {};     // 影片轉場推出的聲音淡化（畫在音訊軌上）
    let totalH = RULER_H;
    for (const t of order) {
      const h = t.kind === 'video' ? VIDEO_H : AUDIO_H;
      totalH += h;
      const row = el('div', 'ed-track ' + t.kind + (t.locked ? ' locked' : '') + (t.muted ? ' muted' : '') + (t.hidden ? ' hidden' : ''));
      row.style.height = h + 'px';
      row.dataset.track = t.id;
      row.appendChild(trackHeader(t, h));
      const lane = el('div', 'ed-lane'); lane.dataset.track = t.id; lane.dataset.kind = t.kind; lane.style.width = contentW + 'px'; lane.style.height = h + 'px';
      for (const c of C.clipsOnTrack(p, t.id)) lane.appendChild(clipEl(p, c, t, h));
      for (const tr of Object.values(p.transitions)) if (tr.trackId === t.id) { const te = transEl(p, tr); if (te) lane.appendChild(te); }
      if (t.kind === 'audio') for (const c of C.clipsOnTrack(p, t.id)) for (const fd of (aplan[c.id] || {}).fades || []) lane.appendChild(xfadeEl(fd, h));
      row.appendChild(lane);
      rows.appendChild(row);
    }
    inner.appendChild(rows);
    inner.style.minHeight = totalH + 'px';

    // 覆蓋層：In/Out 底色、播放頭、吸附線、刀片線、放下位置
    const ov = el('div', 'ed-overlay');
    tl.overlay = ov;
    if (p.inPoint != null || p.outPoint != null) {
      const a = p.inPoint != null ? p.inPoint : 0, b = p.outPoint != null ? p.outPoint : frames;
      const tint = el('div', 'ed-io-tint'); tint.style.left = (HEAD_W + a * k) + 'px'; tint.style.width = Math.max(2, (b - a) * k) + 'px'; tint.style.top = RULER_H + 'px';
      ov.appendChild(tint);
    }
    tl.playhead = el('div', 'ed-playhead');
    tl.snapLine = el('div', 'ed-snapline'); tl.snapLine.hidden = true;
    tl.bladeLine = el('div', 'ed-bladeline'); tl.bladeLine.hidden = true;
    tl.dropLine = el('div', 'ed-dropline'); tl.dropLine.hidden = true;
    tl.marquee = el('div', 'ed-marquee'); tl.marquee.hidden = true;
    tl.edgeTc = el('div', 'ed-edgetc'); tl.edgeTc.hidden = true;
    ov.append(tl.playhead, tl.snapLine, tl.bladeLine, tl.dropLine, tl.marquee, tl.edgeTc);
    if (!Object.keys(p.clips).length) {
      const hint = el('div', 'ed-tl-empty', '時間軸是空的：把媒體庫的素材拖到這裡，或選好素材後按「加到結尾」（F12）。');
      ov.appendChild(hint);
    }
    inner.appendChild(ov);
    tl.reuse = null;
    for (const l of [tl.snapLine, tl.bladeLine, tl.dropLine]) { l.style.top = RULER_H + 'px'; }

    sc.scrollLeft = sl; sc.scrollTop = st;
    placeEdgeTc();
    const z = $('edZoom'); if (z && doc.activeElement !== z) z.value = String(clamp(zoomToSlider(state.zoom), 0, 100));
    updatePlayheadPos(false);
    paintVisible();
  }

  function trackHeader(t, h) {
    const th = el('div', 'ed-th ' + t.kind); th.dataset.track = t.id; th.style.height = h + 'px';
    const isTarget = targetTrack(t.kind) && targetTrack(t.kind).id === t.id;
    if (isTarget) th.classList.add('target');
    const nm = el('button', 'ed-th-name', t.name); nm.type = 'button';
    nm.title = `${t.name}：點一下設為目的軌道（插入／覆蓋會放到這條）；雙擊改名；右鍵更多`;
    nm.addEventListener('click', () => setTarget(t.kind, t.id));
    nm.addEventListener('dblclick', () => renameTrack(t.id, nm));
    const btns = el('div', 'ed-th-btns');
    const tg = (cls, content, title, on, patch) => {
      const b = el('button', 'ed-thb ' + cls + (on ? ' on' : '')); b.type = 'button'; b.title = title; b.setAttribute('aria-pressed', String(!!on)); b.setAttribute('aria-label', title);
      if (typeof content === 'string' && content.startsWith('<')) b.innerHTML = content; else b.textContent = content;
      b.addEventListener('click', () => op('軌道設定', p => C.setTrackProps(p, t.id, patch)));
      return b;
    };
    btns.appendChild(tg('lock', ICONS.lock, t.locked ? '解除鎖定' : '鎖定軌道（鎖定後不能修改這條軌的片段）', t.locked, { locked: !t.locked }));
    if (t.kind === 'video') btns.appendChild(tg('hide', ICONS.eye, t.hidden ? '顯示這條軌道' : '隱藏這條軌道（預覽與匯出都不畫）', t.hidden, { hidden: !t.hidden }));
    else {
      btns.appendChild(tg('mute', 'M', t.muted ? '取消靜音' : '靜音', t.muted, { muted: !t.muted }));
      btns.appendChild(tg('solo', 'S', t.solo ? '取消獨奏' : '獨奏（只聽這條）', t.solo, { solo: !t.solo }));
    }
    th.append(nm, btns);
    th.addEventListener('contextmenu', e => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: '設為目的軌道', run: () => setTarget(t.kind, t.id) },
        { label: '重新命名', run: () => renameTrack(t.id, $('edTimeline').querySelector(`.ed-th[data-track="${t.id}"] .ed-th-name`)) },
        { sep: true },
        { label: '刪除這條軌道', run: () => deleteTrack(t.id) },
      ]);
    });
    return th;
  }
  // 目的軌道：只換標頭的標示，不重畫整個時間軸（不然雙擊改名的第二下會點到已經被換掉的元素）
  function setTarget(kind, id) {
    state.targets[kind] = id;
    for (const th of tl.inner.querySelectorAll('.ed-th.' + kind)) th.classList.toggle('target', th.dataset.track === id);
    const t = trackOf(id);
    say(`${kind === 'video' ? '影片' : '音訊'}目的軌道：${t ? t.name : ''}`, 'ok');
  }
  function renameTrack(id, nameBtn) {
    const t = trackOf(id);
    if (!t || !nameBtn) return;
    const inp = el('input', 'ed-th-input'); inp.type = 'text'; inp.value = t.name; inp.maxLength = 40; inp.setAttribute('aria-label', '軌道名稱');
    nameBtn.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const fin = ok => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (ok && v && v !== t.name) op('重新命名軌道', p => C.setTrackProps(p, id, { name: v }));
      else scheduleRender('tl');
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
    inp.addEventListener('blur', () => fin(true));
  }
  async function deleteTrack(id) {
    const t = trackOf(id);
    if (!t) return;
    const n = C.clipsOnTrack(state.project, id).length;
    if (n && typeof root.askConfirm === 'function') {
      const ok = await root.askConfirm({ title: `刪除「${t.name}」軌？`, message: `這條軌道上有 ${n} 個片段，會一起刪掉（可以用復原救回來）。`, okText: '刪除' });
      if (!ok) return;
    }
    op('刪除軌道', p => C.removeTrack(p, id), `已刪除「${t.name}」`);
  }

  // ---- 片段 ------------------------------------------------------------------------
  function clipEl(p, c, t, h) {
    const k = tl.k;
    const e = el('div', 'ed-clip ' + t.kind + ' ' + c.type);
    e.dataset.clip = c.id;
    const m = c.mediaId && mediaOf(c.mediaId);
    if (m && m.kind === 'image') e.classList.add('image');
    if (state.selection.has(c.id)) e.classList.add('sel');
    if (c.enabled === false) e.classList.add('off');
    if (c.freeze) e.classList.add('freeze');
    if (c.reverse) e.classList.add('rev');
    e.style.left = (c.start * k) + 'px';
    e.style.width = Math.max(3, c.duration * k) + 'px';
    const w = c.duration * k;
    const old = tl.reuse && tl.reuse.get(c.id);
    if (old) tl.reuse.delete(c.id);
    const cv = old || el('canvas', 'ed-cv'); e.appendChild(cv);
    if (c.flags && c.flags.length) {
      const fl = el('div', 'ed-cflags');
      for (const f of c.flags) { const s = el('i'); s.style.background = MARKER_HEX[f] || '#999'; s.title = `旗標：${MARKER_NAME[f] || f}`; fl.appendChild(s); }
      e.appendChild(fl);
    }
    if (w > 28) {
      const nm = el('div', 'ed-cname');
      if (c.linkId) { const li = icon('link', 'ed-linkic'); li.title = '連結的片段'; nm.appendChild(li); }
      nm.appendChild(el('span', 'ed-cname-t', clipTitle(c)));
      const off = c.linkId ? C.linkOffset(p, c.id) : 0;
      if (off) { const o = el('span', 'ed-badge bad', (off > 0 ? '+' : '') + fmtNum(off, 0) + ' 格'); o.title = '和連結的片段不同步（正數＝比較晚）'; nm.appendChild(o); }
      if (c.freeze) nm.appendChild(el('span', 'ed-badge', '定格'));
      else {
        if (Math.abs(c.speed - 1) > 1e-6) nm.appendChild(el('span', 'ed-badge', fmtNum(c.speed * 100, 1) + '%'));
        if (c.reverse) nm.appendChild(el('span', 'ed-badge', '倒播'));
      }
      e.appendChild(nm);
    }
    // 片段標記
    for (const mk of c.markers || []) {
      const d = el('div', 'ed-cmark'); d.dataset.cmarker = mk.id; d.dataset.clip = c.id;
      d.style.left = (mk.offset * k) + 'px'; d.style.setProperty('--c', MARKER_HEX[mk.color] || MARKER_HEX.blue);
      d.title = `${mk.name || '片段標記'}（${MARKER_NAME[mk.color] || ''}）${mk.note ? '\n' + mk.note : ''}`;
      e.appendChild(d);
    }
    // 音訊淡入淡出：曲線＋上緣兩端的把手
    if (t.kind === 'audio' && c.audio && w > 24) {
      const a = c.audio, W = Math.max(3, c.duration * k);
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ed-fadesvg'); svg.setAttribute('width', W); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${W} ${h}`);
      const env = (len, curve, fromRight) => {
        const n = 24, pts = [];
        for (let i = 0; i <= n; i++) {
          const u = i / n, g = R.fadeShape(u, curve);
          pts.push([fromRight ? W - len * k * u : len * k * u, h * (1 - g)]);
        }
        return pts;
      };
      const addFade = (len, curve, right) => {
        if (len <= 0) return;
        const pts = env(len, curve, right);
        const edgeX = right ? W - len * k : len * k;
        const poly = doc.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        poly.setAttribute('class', 'ed-fade-area');
        poly.setAttribute('points', [[right ? W : 0, 0], [edgeX, 0], ...pts.slice().reverse()].map(q => q.join(',')).join(' '));
        svg.appendChild(poly);
        const line = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('class', 'ed-fade-line'); line.setAttribute('points', pts.map(q => q.join(',')).join(' '));
        svg.appendChild(line);
      };
      addFade(a.fadeIn, a.fadeInCurve, false);
      addFade(a.fadeOut, a.fadeOutCurve, true);
      e.appendChild(svg);
      for (const side of ['in', 'out']) {
        const len = side === 'in' ? a.fadeIn : a.fadeOut;
        const hd = el('div', 'ed-fade-h ' + side); hd.dataset.clip = c.id; hd.dataset.side = side;
        hd.style.left = clamp(side === 'in' ? len * k : W - len * k, 7, Math.max(7, W - 7)) + 'px';   // 夾在片段內，不然 0 格時圓點會被片段邊緣切掉一半
        hd.title = side === 'in' ? `淡入 ${len} 格（拖曳調整）` : `淡出 ${len} 格（拖曳調整）`;
        e.appendChild(hd);
      }
    }
    return e;
  }

  function transEl(p, tr) {
    const r = C.transitionRange(p, tr);
    if (!r) return null;
    const k = tl.k, side = C.transitionSide(tr);
    const e = el('div', 'ed-trans ' + side + (state.selTransition === tr.id ? ' sel' : ''));
    e.dataset.trans = tr.id; e.dataset.side = side;
    const w = Math.max(10, tr.duration * k);
    // 單邊轉場貼著片段邊緣：太窄時往片段內側長，不要凸出到空隙裡
    const x = side === 'in' ? r.from * k : side === 'out' ? r.to * k - w : r.from * k - (w - tr.duration * k) / 2;
    e.style.left = x + 'px'; e.style.width = w + 'px';
    const def = (F.TRANSITIONS || {})[tr.type];
    const nm = def ? def.name : tr.type;
    e.title = `${nm}（${TRANS_SIDE_TEXT[side]}）　${tr.duration} 格（拖曳${side === 'both' ? '兩側' : side === 'in' ? '右側' : '左側'}調整長度，點一下在詳細內容編輯）`;
    e.append(el('span', 'ed-trans-t', nm));
    // 單邊轉場只有朝片段內側那一邊可以拖（另一邊貼著片段邊緣）
    for (const hs of side === 'both' ? ['l', 'r'] : side === 'in' ? ['r'] : ['l']) { const hd = el('div', 'ed-trans-h ' + hs); hd.dataset.trans = tr.id; hd.dataset.side = hs; e.appendChild(hd); }
    return e;
  }

  // 轉場時的聲音淡化（由影片轉場推出，見 core.audioTransitionPlan）：畫等功率曲線，交叉淡化時兩條疊成 X
  function xfadeEl(fd, h) {
    const k = tl.k, W = Math.max(2, (fd.to - fd.from) * k);
    const e = el('div', 'ed-xfade ' + fd.dir);
    e.style.left = (fd.from * k) + 'px'; e.style.width = W + 'px';
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${W} ${h}`); svg.setAttribute('preserveAspectRatio', 'none');
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24, g = fd.dir === 'out' ? Math.cos(u * Math.PI / 2) : Math.sin(u * Math.PI / 2);
      pts.push([(W * u).toFixed(1), (3 + (h - 6) * (1 - g)).toFixed(1)]);
    }
    const line = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', pts.map(q => q.join(',')).join(' '));
    svg.appendChild(line);
    e.appendChild(svg);
    return e;
  }

  // ---- 縮圖與波形（只畫看得到的那一段，避免超長畫布）--------------------------------------
  // 波形高度：用分貝（-50dB～0dB 對應 0～1），小聲的素材也看得到
  const waveAmp = v => (v <= 0.003 ? 0 : clamp(1 + 20 * Math.log10(v) / 50, 0, 1));
  function nearestThumb(th, t) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < th.length; i++) { const d = Math.abs(th[i].t - t); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function paintVisible() {
    if (!tl.inner || app.hidden) return;
    const sc = tl.scroll, v0 = sc.scrollLeft - 300, v1 = sc.scrollLeft + sc.clientWidth + 300;
    const p = state.project;
    for (const e of tl.inner.querySelectorAll('.ed-clip')) {
      const cv = e.firstChild;
      const x0 = e.offsetLeft, w = e.offsetWidth, H = e.clientHeight;
      if (x0 + w < v0 || x0 > v1 || w < 2 || H < 4) { if (cv.width > 1) { cv.width = 1; cv.dataset.key = ''; } continue; }
      const a = Math.floor(Math.max(0, v0 - x0)), b = Math.ceil(Math.min(w, v1 - x0));
      const c = p.clips[e.dataset.clip];
      if (!c) continue;
      const key = `${a}:${b}:${H}:${tl.k}:${paintSig(p, c, e)}`;
      if (cv.dataset.key === key) continue;
      cv.dataset.key = key;
      cv.style.left = a + 'px';
      cv.width = Math.max(1, b - a); cv.height = H;
      try { paintClipCanvas(p, c, C.getTrack(p, c.trackId), cv, a, H); } catch (err) { /* 畫縮圖失敗不影響剪輯 */ }
    }
  }
  // 畫布內容取決於這些值；都沒變（例如只是移動位置）就沿用上次畫好的
  function paintSig(p, c, e) {
    const m = c.mediaId ? mediaOf(c.mediaId) : null, th = m && m.thumbs;
    return [colors.rev, e.classList.contains('video') ? 'v' : 'a', c.type, c.solidColor, c.mediaId, c.srcIn, c.speed, c.reverse ? 1 : 0, c.freeze ? 1 : 0, c.duration,
      c.audio ? c.audio.gainDb : 0, p.fps, m ? m.kind + '/' + m.duration : '', th ? th.length + (th[0] && th[0].bitmap ? 'b' : '') : 0, m && m.peaks ? m.peaks.length : 0].join('|');
  }
  function paintClipCanvas(p, c, t, cv, a, H) {
    const g = cv.getContext('2d'), W = cv.width, k = tl.k;
    g.clearRect(0, 0, W, H);
    if (c.type === 'solid') { g.fillStyle = c.solidColor || '#000'; g.fillRect(0, 0, W, H); return; }
    if (c.type === 'title') {
      const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, colors.titleA); gr.addColorStop(1, colors.titleB);
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      return;
    }
    const m = mediaOf(c.mediaId);
    if (!m) { g.fillStyle = colors.phMissing; g.fillRect(0, 0, W, H); return; }
    if (t.kind === 'video') {
      const th = m.thumbs || [];
      if (!th.length || !th[0].bitmap) { g.fillStyle = colors.phVideo; g.fillRect(0, 0, W, H); return; }
      const bw = th[0].bitmap.width, bh = th[0].bitmap.height, tw = Math.max(20, Math.round(bw / bh * H));
      const lastF = c.start + c.duration - 1;
      for (let x = Math.floor(a / tw) * tw; x < a + W; x += tw) {
        const f = Math.min(lastF, c.start + (x + tw / 2) / k);
        const i = m.kind === 'image' ? 0 : nearestThumb(th, C.sourceTimeAt(p, c, f));
        try { g.drawImage(th[i].bitmap, x - a, 0, tw, H); } catch (_) { /* 已釋放 */ }
      }
      return;
    }
    // 音訊：波形
    g.fillStyle = colors.wave;
    const peaks = m.peaks, rate = m.peaksRate || 100;
    if (!peaks || !peaks.length || c.freeze) return;
    const gain = R.dbToGain(c.audio ? c.audio.gainDb : 0), mid = H / 2, amax = (H - 10) / 2;
    for (let x = 0; x < W; x++) {
      const f0 = c.start + (a + x) / k, f1 = c.start + (a + x + 1) / k;
      const t0 = C.sourceTimeAt(p, c, f0), t1 = C.sourceTimeAt(p, c, f1);
      const i0 = Math.floor(Math.min(t0, t1) * rate), i1 = Math.max(i0, Math.floor(Math.max(t0, t1) * rate));
      let mx = 0;
      for (let i = i0; i <= i1 && i < peaks.length; i++) if (peaks[i] > mx) mx = peaks[i];
      const amp = waveAmp(mx * gain) * amax;
      g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
    }
  }

  // ---- 播放頭 ----------------------------------------------------------------------
  function updatePlayheadPos(follow) {
    if (!tl.playhead) return;
    const x = state.playhead * tl.k;
    tl.playhead.style.transform = `translateX(${HEAD_W + x}px)`;
    tl.phHead.style.transform = `translateX(${x}px)`;
    const c = $('edTlTc'); if (c) c.textContent = tc(state.playhead, fps());
    if (follow) {
      const sc = tl.scroll, vis = sc.clientWidth - HEAD_W;
      if (x > sc.scrollLeft + vis - 24) sc.scrollLeft = Math.max(0, x - vis * 0.15);
      else if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 24);
    }
  }

  function refreshSelectionUI() {
    if (tl.inner) {
      for (const e of tl.inner.querySelectorAll('.ed-clip')) e.classList.toggle('sel', state.selection.has(e.dataset.clip));
      for (const e of tl.inner.querySelectorAll('.ed-trans')) e.classList.toggle('sel', state.selTransition === e.dataset.trans);
    }
    scheduleInspector();
    if (state.history) updateToolbar();
    scheduleStage();
    updateSubMark();
  }

  // =====================================================================================
  // 時間軸：滑鼠操作
  // =====================================================================================
  // 拖曳中的「即時預覽」：每次移動都回到拖曳前，再套用「總位移」一次；放開才記成一筆復原
  const live = {
    started: false, ops: 0,
    run(label, fn) {
      const h = state.history;
      if (!this.started) { h.begin(label); this.started = true; this.ops = 0; } else if (this.ops) { h.cancel(); h.begin(label); }
      this.ops++;
      const r = fn(state.project);
      scheduleRender('tl');
      if (player) player.refresh();
      scheduleInspector();
      return r;
    },
    end() { if (this.started) { this.started = false; this.ops = 0; state.history.end(); } },
    abort() { if (this.started) { this.started = false; this.ops = 0; state.history.cancel(); } },
  };

  let drag = null, autoRaf = 0;
  function beginDrag(e, d) {
    if (drag) return;
    d.x0 = e.clientX; d.y0 = e.clientY; d.moved = false; d.sl0 = tl.scroll.scrollLeft; d.last = e;
    drag = d;
    const apply = ev => d.move(ev, ev.clientX - d.x0 + (tl.scroll.scrollLeft - d.sl0), ev.clientY - d.y0);
    const onMove = ev => {
      d.last = ev;
      if (!d.moved) { if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < DRAG_PX) return; d.moved = true; app.classList.add('dragging'); }
      apply(ev);
      if (d.autoscroll && !autoRaf) autoRaf = requestAnimationFrame(autoScroll);
    };
    const autoScroll = () => {
      autoRaf = 0;
      if (drag !== d || !d.moved) return;
      const r = tl.scroll.getBoundingClientRect(), x = d.last.clientX;
      let v = 0;
      if (x > r.right - 36) v = Math.min(28, (x - (r.right - 36)) * 0.6 + 2); else if (x < r.left + HEAD_W + 20) v = -Math.min(28, (r.left + HEAD_W + 20 - x) * 0.6 + 2);
      if (v) {
        const before = tl.scroll.scrollLeft;
        tl.scroll.scrollLeft = Math.max(0, before + v);
        if (tl.scroll.scrollLeft !== before) apply(d.last);
        autoRaf = requestAnimationFrame(autoScroll);
      }
    };
    const finish = () => {
      root.removeEventListener('pointermove', onMove); root.removeEventListener('pointerup', onUp); root.removeEventListener('pointercancel', onUp);
      root.removeEventListener('keydown', onKey, true); root.removeEventListener('blur', onBlur);
      drag = null; app.classList.remove('dragging'); showSnap(null);
      if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = 0; }
    };
    const onUp = ev => { finish(); if (d.up) d.up(ev, d.moved); };
    const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(); if (d.cancel) d.cancel(); } };
    const onBlur = () => { finish(); if (d.cancel) d.cancel(); };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('keydown', onKey, true);
    root.addEventListener('blur', onBlur);        // 在視窗外放開滑鼠時不會收到 pointerup：視窗失焦就取消這次拖曳
  }

  // 拖片段頭尾修剪時，在拖的那一側邊緣旁顯示目前的時間碼（tl.edgeAt＝{ clipId, edge }；null＝不顯示）
  function placeEdgeTc() {
    const b = tl.edgeTc;
    if (!b) return;
    const at = tl.edgeAt, c = at && clipOf(at.clipId), ce = c && tl.inner.querySelector(`.ed-clip[data-clip="${c.id}"]`);
    if (!ce) { b.hidden = true; return; }
    const f = at.edge === 'start' ? c.start : C.clipEnd(c);
    const ir = tl.inner.getBoundingClientRect(), r = ce.getBoundingClientRect();
    b.textContent = tc(at.edge === 'start' ? f : Math.max(c.start, f - 1), state.project.fps);   // 尾端顯示最後一格（片段範圍不含 end）
    b.dataset.edge = at.edge;
    b.hidden = false;
    b.style.left = (HEAD_W + f * tl.k) + 'px';
    b.style.top = (r.top - ir.top + r.height / 2) + 'px';
  }
  function showEdgeTc(clipId, edge) { tl.edgeAt = clipId ? { clipId, edge } : null; placeEdgeTc(); }

  function showSnap(frame) {
    tl.snapAt = frame;
    if (!tl.snapLine) return;
    tl.snapLine.hidden = frame == null;
    if (frame != null) tl.snapLine.style.transform = `translateX(${HEAD_W + frame * tl.k}px)`;
  }
  // d（影格）加上吸附：edges 是會動的那幾個邊緣，targets 是吸附目標
  function snapDelta(d, edges, targets, off) {
    if (!state.snapping || off) { showSnap(null); return d; }
    const tol = SNAP_PX / tl.k;
    let best = 0, bd = Infinity, at = null;
    for (const e of edges) {
      const s = C.snap(e + d, targets, tol), diff = s - (e + d);
      if (Math.abs(diff) <= tol && (diff !== 0 || bd === Infinity) && Math.abs(diff) < bd) { bd = Math.abs(diff); best = diff; at = s; }
    }
    showSnap(at);
    return d + best;
  }
  function laneRects() {
    return [...tl.inner.querySelectorAll('.ed-lane')].map(l => { const r = l.getBoundingClientRect(); return { id: l.dataset.track, kind: l.dataset.kind, top: r.top, bottom: r.bottom }; });
  }

  // ---- 判斷游標在什麼東西上 ----------------------------------------------------------
  function hitInfo(e) {
    const t = e.target;
    if (!t || !t.closest) return { kind: 'none' };
    let x;
    if ((x = t.closest('.ed-fade-h'))) return { kind: 'fade', clipId: x.dataset.clip, side: x.dataset.side, el: x };
    if ((x = t.closest('.ed-trans-h'))) return { kind: 'transH', id: x.dataset.trans, side: x.dataset.side };
    if ((x = t.closest('.ed-trans'))) return { kind: 'trans', id: x.dataset.trans };
    if ((x = t.closest('.ed-cmark'))) return { kind: 'cmark', id: x.dataset.cmarker, clipId: x.dataset.clip };
    if ((x = t.closest('.ed-mk'))) return { kind: 'marker', id: x.dataset.marker };
    if (t.closest('.ed-ph-head')) return { kind: 'ruler' };
    if ((x = t.closest('.ed-clip'))) return { kind: 'clip', clipId: x.dataset.clip, el: x };
    if (t.closest('.ed-ruler')) return { kind: 'ruler' };
    if ((x = t.closest('.ed-lane'))) return { kind: 'lane', trackId: x.dataset.track };
    return { kind: 'none' };
  }
  function clipZone(e, el) {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top, edge = Math.min(EDGE_PX, r.width / 3);
    return { zone: x <= edge ? 'start' : x >= r.width - edge ? 'end' : 'body', upper: y < r.height / 2 };
  }
  function neighbor(c, dir) {
    const list = C.clipsOnTrack(state.project, c.trackId);
    return dir < 0 ? list.find(x => C.clipEnd(x) === c.start) : list.find(x => x.start === C.clipEnd(c));
  }
  // 修剪工具：依位置決定做哪一種
  function trimPlan(c, zone, upper) {
    if (zone === 'start' || zone === 'end') {
      const nb = neighbor(c, zone === 'start' ? -1 : 1);
      if (nb) return zone === 'start' ? { type: 'roll', leftId: nb.id, rightId: c.id } : { type: 'roll', leftId: c.id, rightId: nb.id };
      return { type: 'ripple', edge: zone };
    }
    return { type: upper ? 'slip' : 'slide' };
  }
  const ACTION_NAME = { move: '移動', trim: '一般修剪', trimMulti: '一般修剪（所有選取的片段）', rippleMulti: '波紋修剪（所有選取的片段）', blade: '刀片', ripple: '波紋修剪', roll: '滾動修剪', slip: '滑移', slide: '滑動' };
  const ACTION_TIP = {
    move: '拖曳移動片段（可拖到別軌；目的地的內容會被蓋掉）', trim: '拖曳邊緣修剪，不會推動其他片段',
    trimMulti: '拖曳邊緣，所有選取的片段一起加長或縮短同樣的格數，不會推動其他片段（碰到旁邊就停）', rippleMulti: '拖曳邊緣，所有選取的片段一起加長或縮短同樣的格數，後面的片段跟著推拉、不留空隙', blade: '點一下在游標位置切開（Shift＝所有軌道）',
    ripple: '拖曳邊緣修剪，後面的片段跟著推拉', roll: '拖曳剪接點，兩邊一邊變長一邊變短，總長不變', slip: '拖曳換用來源的另一段畫面，片段位置與長度不變', slide: '拖曳整個片段，前後鄰居一個變長一個變短',
  };
  function defaultAction() { return state.tool === 'select' ? '選取：拖曳移動，拖邊緣修剪' : state.tool === 'blade' ? '刀片：點片段切開' : '修剪：游標移到片段上自動判斷'; }
  function setActionLabel(name, tip) {
    const a = $('edAction');
    if (!a) return;
    a.textContent = name ? `目前動作：${name}` : defaultAction();
    a.title = tip || '目前游標會做的動作';
    a.dataset.action = name || '';
  }
  function actionAt(e, h) {
    if (h.kind !== 'clip') return null;
    const z = clipZone(e, h.el), c = clipOf(h.clipId);
    if (!c) return null;
    if (state.tool === 'blade') return { name: 'blade', cursor: 'cut' };
    if (state.tool === 'select') return z.zone === 'body' ? { name: 'move', cursor: 'move' } : { name: multiTrimIds(c.id) ? 'trimMulti' : 'trim', cursor: 'ew' };
    if (z.zone !== 'body' && multiTrimIds(c.id)) return { name: 'rippleMulti', cursor: 'ew' };
    const plan = trimPlan(c, z.zone, z.upper);
    return { name: plan.type, cursor: plan.type === 'roll' ? 'roll' : plan.type === 'ripple' ? 'ew' : plan.type, plan };
  }
  function onTlHover(e) {
    if (drag || libDrag) return;
    const h = hitInfo(e), a = actionAt(e, h);
    setActionLabel(a ? ACTION_NAME[a.name] : '', a ? ACTION_TIP[a.name] : '');
    tl.scroll.dataset.cursor = a ? a.cursor : (h.kind === 'fade' || h.kind === 'transH' ? 'ew' : '');
    // 刀片：跟著游標的切線
    if (tl.bladeLine) {
      if (state.tool === 'blade' && (h.kind === 'clip' || h.kind === 'lane')) {
        let f = Math.max(0, Math.round(xToFrame(e.clientX)));
        if (state.snapping) f = C.snap(f, C.snapTargets(state.project, { playhead: state.playhead }), SNAP_PX / tl.k);
        tl.bladeLine.hidden = false; tl.bladeLine.style.transform = `translateX(${HEAD_W + f * tl.k}px)`;
      } else tl.bladeLine.hidden = true;
    }
  }

  // ---- 按下 ------------------------------------------------------------------------
  function onTlDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.ed-th')) return;
    flushPop(); closePop(); closeMenu();
    const h = hitInfo(e);
    switch (h.kind) {
      case 'fade': e.preventDefault(); return startFade(e, h);
      case 'transH': e.preventDefault(); return startTransResize(e, h);
      case 'trans': selectTransition(h.id); return;
      case 'cmark': selectClips([h.clipId]); openMarkerPop('clip', h.id, h.clipId); return;
      case 'marker': return startMarkerDrag(e, h);
      case 'ruler': e.preventDefault(); return startScrub(e);
      case 'clip': e.preventDefault(); return onClipDown(e, h);
      case 'lane': e.preventDefault(); return onLaneDown(e, h);
      default:
        // 軌道下方的空白：跟軌道空白一樣，拖曳框選、點一下取消選取（捲軸、軌道標頭不算）
        const sr = tl.scroll.getBoundingClientRect();
        const onBar = e.clientX - sr.left >= tl.scroll.clientWidth || e.clientY - sr.top >= tl.scroll.clientHeight;
        if (h.kind === 'none' && (e.target === tl.scroll || e.target === tl.inner || e.target === tl.overlay) && !onBar && e.clientX - sr.left >= HEAD_W) { e.preventDefault(); onLaneDown(e, h); }
    }
  }

  function startScrub(e) {
    const to = ev => seekTimeline(Math.max(0, Math.round(xToFrame(ev.clientX))));
    to(e);
    beginDrag(e, { autoscroll: true, move: ev => to(ev) });
  }

  function onClipDown(e, h) {
    const c = clipOf(h.clipId);
    if (!c) return;
    const z = clipZone(e, h.el), toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    if (state.tool === 'blade') { bladeClick(e, c); return; }
    if (state.tool === 'select') {
      if (z.zone !== 'body') {
        const multi = multiTrimIds(c.id);
        if (!multi) clickSelect(c.id, false);
        startEdgeDrag(e, c.id, z.zone, 'trim', multi);
        return;
      }
      clickSelect(c.id, toggle);
      if (toggle && !state.selection.has(c.id)) return;
      startMoveDrag(e, c.id);
      return;
    }
    const multi = z.zone !== 'body' && multiTrimIds(c.id);
    if (multi) { startEdgeDrag(e, c.id, z.zone, 'ripple', multi); return; }
    clickSelect(c.id, false);
    const plan = trimPlan(c, z.zone, z.upper);
    if (plan.type === 'ripple') startEdgeDrag(e, c.id, plan.edge, 'ripple');
    else if (plan.type === 'roll') startRollDrag(e, plan);
    else if (plan.type === 'slip') startSlipSlide(e, c.id, 'slip');
    else startSlipSlide(e, c.id, 'slide');
  }

  function bladeClick(e, c) {
    let f = Math.max(0, Math.round(xToFrame(e.clientX)));
    if (state.snapping) f = C.snap(f, C.snapTargets(state.project, { playhead: state.playhead }), SNAP_PX / tl.k);
    const r = op('刀片', q => C.blade(q, f, e.shiftKey ? undefined : [c.trackId], { linked: state.linkedSelection }));
    if (r && r.ok) { seekTimeline(f); say('已切開', 'ok'); }
  }

  function groupOf(ids) { return C.expandLinked(state.project, ids, state.linkedSelection); }
  // 這個片段在多選裡：拖邊緣時所有選取的片段一起修剪（回傳選取的 id；不是多選回 null）
  function multiTrimIds(clipId) {
    if (!state.selection.has(clipId)) return null;
    const ids = selIds();
    return groupOf(ids).length > groupOf([clipId]).length ? ids : null;
  }

  function startMoveDrag(e, clipId) {
    const p = state.project, ids = selIds(), group = groupOf(ids);
    const c0 = p.clips[clipId], t0 = trackOf(c0.trackId);
    const edges = [];
    for (const id of group) { const c = p.clips[id]; edges.push(c.start, C.clipEnd(c)); }
    const targets = C.snapTargets(p, { playhead: state.playhead, exclude: group });
    const lanes = laneRects(), kindList = C.tracksOf(p, t0.kind), baseIdx = kindList.findIndex(t => t.id === t0.id);
    beginDrag(e, {
      autoscroll: true,
      move(ev, dx) {
        const d = snapDelta(Math.round(dx / tl.k), edges, targets, ev.altKey);
        let dt = 0;
        const lane = lanes.find(l => ev.clientY >= l.top && ev.clientY < l.bottom);
        if (lane && lane.kind === t0.kind) dt = kindList.findIndex(t => t.id === lane.id) - baseIdx;
        const r = live.run('移動片段', q => C.moveClips(q, ids, d, dt, { linked: state.linkedSelection }));
        if (!r.ok) say(r.reason, 'error');
      },
      up(ev, moved) { if (moved) live.end(); },
      cancel() { live.abort(); },
    });
  }

  // ids：多選時所有選取的片段（每個都改同樣格數）；省略＝只修剪 clipId
  function startEdgeDrag(e, clipId, edge, kind, ids) {
    const p = state.project, c0 = p.clips[clipId], target = ids || clipId, group = groupOf(ids || [clipId]);
    const f0 = edge === 'start' ? c0.start : C.clipEnd(c0);
    const targets = C.snapTargets(p, { playhead: state.playhead, exclude: group });
    const label = (kind === 'ripple' ? '波紋修剪' : '修剪邊緣') + (ids ? `（${ids.length} 個片段）` : '');
    showEdgeTc(clipId, edge);
    beginDrag(e, {
      autoscroll: true,
      move(ev, dx) {
        const d = snapDelta(Math.round(dx / tl.k), [f0], targets, ev.altKey);
        const r = live.run(label, q => (kind === 'ripple' ? C.rippleTrim(q, target, edge, d, { linked: state.linkedSelection }) : C.trimEdge(q, target, edge, d, { linked: state.linkedSelection })));
        if (!r.ok) say(r.reason, 'error');
        else if (r.applied != null && r.applied !== d) say('已經到極限了（來源沒有更多畫面，或碰到旁邊的片段）');
      },
      up(ev, moved) { showEdgeTc(null); if (moved) live.end(); },
      cancel() { showEdgeTc(null); live.abort(); },
    });
  }

  function startRollDrag(e, plan) {
    const p = state.project, R_ = p.clips[plan.rightId], f0 = R_.start;
    const group = groupOf([plan.leftId, plan.rightId]);
    const targets = C.snapTargets(p, { playhead: state.playhead, exclude: group });
    showEdgeTc(plan.leftId, 'end');
    beginDrag(e, {
      autoscroll: true,
      move(ev, dx) {
        const d = snapDelta(Math.round(dx / tl.k), [f0], targets, ev.altKey);
        const r = live.run('滾動修剪', q => C.roll(q, plan.leftId, plan.rightId, d, { linked: state.linkedSelection }));
        if (!r.ok) say(r.reason, 'error');
        else if (r.applied != null && r.applied !== d) say('已經到極限了（來源沒有更多畫面）');
      },
      up(ev, moved) { showEdgeTc(null); if (moved) live.end(); },
      cancel() { showEdgeTc(null); live.abort(); },
    });
  }

  function startSlipSlide(e, clipId, kind) {
    const p = state.project, c0 = p.clips[clipId], group = groupOf([clipId]);
    const targets = C.snapTargets(p, { playhead: state.playhead, exclude: group });
    const label = kind === 'slip' ? '滑移' : '滑動';
    beginDrag(e, {
      autoscroll: true,
      move(ev, dx) {
        let d = Math.round(dx / tl.k);
        if (kind === 'slide') d = snapDelta(d, [c0.start, C.clipEnd(c0)], targets, ev.altKey);
        const r = live.run(label, q => (kind === 'slip' ? C.slip(q, clipId, d, { linked: state.linkedSelection }) : C.slide(q, clipId, d, { linked: state.linkedSelection })));
        if (!r.ok) say(r.reason, 'error');
        else if (r.applied != null && r.applied !== d) say('已經到極限了');
      },
      up(ev, moved) { if (moved) live.end(); },
      cancel() { live.abort(); },
    });
  }

  function startFade(e, h) {
    const p = state.project, c0 = p.clips[h.clipId];
    if (!c0 || !c0.audio) return;
    selectClips([c0.id]);
    const side = h.side, start = c0.start, end = C.clipEnd(c0), other = side === 'in' ? c0.audio.fadeOut : c0.audio.fadeIn;
    beginDrag(e, {
      move(ev) {
        const f = xToFrame(ev.clientX);
        const n = clamp(Math.round(side === 'in' ? f - start : end - f), 0, c0.duration - other);
        const r = live.run(side === 'in' ? '調整淡入' : '調整淡出', q => C.setClipProps(q, c0.id, { audio: side === 'in' ? { fadeIn: n } : { fadeOut: n } }));
        if (!r.ok) say(r.reason, 'error'); else say(`${side === 'in' ? '淡入' : '淡出'} ${n} 格（${fmtNum(n / p.fps, 2)} 秒）`);
      },
      up(ev, moved) { if (moved) live.end(); },
      cancel() { live.abort(); },
    });
  }

  function startTransResize(e, h) {
    const p = state.project, tr0 = p.transitions[h.id];
    if (!tr0) return;
    selectTransition(h.id);
    const sd = C.transitionSide(tr0), edit = C.transitionRange(p, tr0).edit, side = h.side;
    const align = sd === 'both' ? tr0.align : sd === 'out' ? 'end' : 'start';
    beginDrag(e, {
      move(ev) {
        const f = xToFrame(ev.clientX);
        let d = null;
        if (align === 'center') d = Math.round(2 * Math.abs(f - edit));
        else if (align === 'start' && side === 'r') d = Math.round(f - edit);
        else if (align === 'end' && side === 'l') d = Math.round(edit - f);
        if (d == null) return;
        d = Math.max(1, d);
        const r = live.run('調整轉場長度', q => C.updateTransition(q, h.id, { duration: d }));
        if (!r.ok) say(r.reason, 'error');
      },
      up(ev, moved) { if (moved) live.end(); },
      cancel() { live.abort(); },
    });
  }

  function startMarkerDrag(e, h) {
    selectClips([]);
    const mk0 = state.project.markers.find(m => m.id === h.id), f0 = mk0 ? mk0.frame : 0, g0 = xToFrame(e.clientX);   // 以抓住的位置為基準，標記不會跳到游標下
    beginDrag(e, {
      autoscroll: true,
      move(ev) {
        const f = Math.max(0, f0 + Math.round(xToFrame(ev.clientX) - g0));
        const r = live.run('移動標記', q => C.updateMarker(q, h.id, { frame: f }));
        if (!r.ok) say(r.reason, 'error');
      },
      up(ev, moved) { if (moved) live.end(); else openMarkerPop('timeline', h.id); },
      cancel() { live.abort(); },
    });
  }

  // 空白處：拖曳框選；點一下取消選取
  function onLaneDown(e, h) {
    if (state.tool === 'blade') return;
    const ir = tl.inner.getBoundingClientRect();
    const x0 = e.clientX - ir.left, y0 = e.clientY - ir.top;
    const base = (e.shiftKey || e.ctrlKey || e.metaKey) ? new Set(state.selection) : new Set();
    const rects = [...tl.inner.querySelectorAll('.ed-clip')].map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.clip, l: r.left - ir.left, r: r.right - ir.left, t: r.top - ir.top, b: r.bottom - ir.top }; });
    beginDrag(e, {
      autoscroll: true,
      move(ev) {
        // 用「現在」的位置換算：拖到邊緣自動捲動後，框的起點要跟著內容走，不會停在螢幕上同一個地方
        const cr = tl.inner.getBoundingClientRect(), x1 = ev.clientX - cr.left, y1 = ev.clientY - cr.top;
        const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
        tl.marquee.hidden = false;
        Object.assign(tl.marquee.style, { left: l + 'px', top: t + 'px', width: (r - l) + 'px', height: (b - t) + 'px' });
        const hit = rects.filter(q => q.l < r && q.r > l && q.t < b && q.b > t).map(q => q.id);
        const sel = new Set(base);
        for (const id of C.expandLinked(state.project, hit, state.linkedSelection)) sel.add(id);
        state.selection = sel; state.selTransition = null;
        refreshSelectionUI();
      },
      up(ev, moved) {
        if (tl.marquee) tl.marquee.hidden = true;
        // 點一下只取消選取，不移動播放頭（播放頭只在拖紅色箭頭或點時間尺時移動）
        if (!moved && !base.size) { state.selection = new Set(); state.selTransition = null; refreshSelectionUI(); }
      },
      cancel() { if (tl.marquee) tl.marquee.hidden = true; },
    });
  }

  // ---- 右鍵選單 --------------------------------------------------------------------
  function onTlContext(e) {
    const h = hitInfo(e);
    if (h.kind === 'clip') {
      e.preventDefault();
      if (!state.selection.has(h.clipId)) clickSelect(h.clipId, false);
      const ids = selIds(), anchor = { x: e.clientX, y: e.clientY };
      openMenu(e.clientX, e.clientY, [
        { label: '在播放頭切開', hint: MOD + 'B', run: bladeAtPlayhead },
        { label: '刪除（留下空隙）', hint: 'Del', run: () => deleteSelection(false) },
        { label: '波紋刪除', hint: '⇧Del', run: () => deleteSelection(true) },
        { sep: true },
        { label: '連結', disabled: ids.length < 2, run: () => linkSelection(true) },
        { label: '取消連結', disabled: !ids.some(i => clipOf(i) && clipOf(i).linkId), run: () => linkSelection(false) },
        { sep: true },
        { label: '變速…', hint: MOD + 'R', run: () => openSpeedPop(anchor) },
        { label: '定格…', hint: '⇧R', run: () => openFreezePop(anchor) },
        { label: '旗標…', run: () => openFlagPop(anchor) },
        { label: '加標記', hint: 'M', run: addMarkerHere },
        { label: '把 In／Out 設成這個片段', hint: 'X', run: markClipRange },
      ]);
    } else if (h.kind === 'lane') {
      e.preventDefault();
      const f = Math.round(xToFrame(e.clientX)), p = state.project;
      const gap = !C.clipAt(p, h.trackId, f) && C.clipsOnTrack(p, h.trackId).some(c => c.start > f);
      openMenu(e.clientX, e.clientY, [
        { label: '刪除空隙', disabled: !gap, run: () => op('刪除空隙', q => C.deleteGap(q, h.trackId, f), '已刪除空隙') },
        { label: '在這裡設播放頭', run: () => seekTimeline(f) },
      ]);
    }
  }

  // ---- 從媒體庫拖到時間軸 ------------------------------------------------------------
  function dropTarget(payload, ev) {
    if (!tl.inner) return null;
    const x = doc.elementFromPoint(ev.clientX, ev.clientY);
    const lane = x && x.closest && x.closest('.ed-lane');
    if (!lane) return null;
    const p = state.project, tid = lane.dataset.track, kind = lane.dataset.kind;
    let f = Math.max(0, Math.round(xToFrame(ev.clientX)));
    if (payload.kind === 'transition') {
      // 候選：每個片段的結尾（剪接點或尾端），以及前面是空隙或時間軸起點的片段開頭（開頭淡入）。同一格時剪接點優先
      const tol = 24 / tl.k, list = C.clipsOnTrack(p, tid);
      let best = null, bd = Infinity;
      for (const c of list) {
        const d = Math.abs(C.clipEnd(c) - f);
        if (d <= tol && d < bd) { bd = d; best = { clipId: c.id, edge: 'end', f: C.clipEnd(c) }; }
      }
      for (const c of list) {
        if (list.some(x => x.id !== c.id && C.clipEnd(x) === c.start)) continue;
        const d = Math.abs(c.start - f);
        if (d <= tol && d < bd) { bd = d; best = { clipId: c.id, edge: 'start', f: c.start }; }
      }
      return { lane, tid, kind, f: best ? best.f : f, clipId: best && best.clipId, edge: best && best.edge, leftId: best && best.edge === 'end' ? best.clipId : null };
    }
    if (payload.kind === 'textfx' || payload.kind === 'tstyle') {   // 字體特效／字幕樣式：放在游標下的片段上
      const c = C.clipAt(p, tid, f);
      return { lane, tid, kind, f, clipId: c ? c.id : null, isTitle: !!(c && c.type === 'title') };
    }
    if (state.snapping) f = C.snap(f, C.snapTargets(p, { playhead: state.playhead }), SNAP_PX / tl.k);
    return { lane, tid, kind, f };
  }
  function tlShowDrop(payload, ev) {
    for (const l of tl.inner.querySelectorAll('.ed-lane.drop-ok, .ed-lane.drop-bad')) l.classList.remove('drop-ok', 'drop-bad');
    if (!tl.dropLine) return;
    if (!payload) { tl.dropLine.hidden = true; return; }
    const t = dropTarget(payload, ev);
    if (!t) { tl.dropLine.hidden = true; return; }
    const m = payload.kind === 'media' ? mediaOf(payload.id) : null;
    let ok = true;
    if (payload.kind === 'transition') ok = !!t.clipId && t.kind === 'video';
    else if (payload.kind === 'title') ok = t.kind === 'video';
    else if (payload.kind === 'textfx' || payload.kind === 'tstyle') ok = t.isTitle;
    else if (m) ok = t.kind === 'video' ? m.kind !== 'audio' : (m.kind === 'audio' || !!m.hasAudio);
    t.lane.classList.add(ok ? 'drop-ok' : 'drop-bad');
    tl.dropLine.hidden = false;
    tl.dropLine.style.transform = `translateX(${HEAD_W + t.f * tl.k}px)`;
  }
  function tlDrop(payload, ev) {
    const t = dropTarget(payload, ev);
    if (!t) return;
    if (payload.kind === 'transition') {
      if (t.kind !== 'video') { say('轉場只能加在影片軌的片段上', 'error'); return; }
      if (!t.clipId) { say('請把轉場拖到兩個片段之間的剪接點，或片段的開頭／結尾', 'error'); return; }
      addTransitionAt(t.clipId, payload.id, t.edge);
    } else if (payload.kind === 'title') {
      if (t.kind !== 'video') { say('字幕只能放在影片軌上', 'error'); return; }
      addTitle(payload.id, t.tid, t.f);
    } else if (payload.kind === 'textfx' || payload.kind === 'tstyle') {
      if (!t.isTitle) { say(payload.kind === 'textfx' ? '字體特效要拖到時間軸的字幕片段上' : '字幕樣式要拖到時間軸的字幕片段上', 'error'); return; }
      selectClips([t.clipId]);
      if (payload.kind === 'textfx') applyTextFx(payload.id, [t.clipId]); else applyTitleStyle(payload.id, [t.clipId]);
    } else dropMedia(payload.id, t);
  }
  function dropMedia(id, t) {
    const m = mediaOf(id);
    if (!m) return;
    if (t.kind === 'audio' && !(m.kind === 'audio' || m.hasAudio)) { say(`「${m.name}」沒有聲音，不能放在音訊軌`, 'error'); return; }
    if (t.kind === 'video' && m.kind === 'audio') { say('音訊只能放在音訊軌', 'error'); return; }
    ensureMediaInfo();
    const io = state.sourceInOut && state.sourceInOut.mediaId === id ? state.sourceInOut : null;
    const v = targetTrack('video'), a = targetTrack('audio');
    const trackIds = t.kind === 'video' ? { video: t.tid, audio: a && a.id } : { video: v && v.id, audio: t.tid };
    // 拖放有明確的位置：ignoreInOut，不要被時間軸的 In／Out 搶走
    const r = op('覆蓋', p => C.editToTimeline(p, { mode: 'overwrite', mediaId: id, srcIn: io && io.srcIn != null ? io.srcIn : 0, srcOut: io && io.srcOut != null ? io.srcOut : undefined, frame: t.f, trackIds, name: m.name, ignoreInOut: true }));
    if (r && r.ok) { selectClips(r.ids); seekTimeline(r.start); say(`已放入「${m.name}」`, 'ok'); }
  }

  // =====================================================================================
  // 詳細內容
  // =====================================================================================
  const insp = { body: null, secs: {}, fxSecs: [], title: null, audio: null, speed: null, info: null, project: null };

  function mkSection(id, title, opts) {
    const s = el('section', 'ed-sec' + (opts && opts.closed ? ' closed' : '')); s.dataset.sec = id; s.hidden = true;
    const h = el('button', 'ed-sec-h'); h.type = 'button'; h.setAttribute('aria-expanded', opts && opts.closed ? 'false' : 'true');
    h.append(el('span', 'ed-caret'), el('span', null, title));
    const b = el('div', 'ed-sec-b ed-fx');
    h.addEventListener('click', () => { const c = s.classList.toggle('closed'); h.setAttribute('aria-expanded', String(!c)); });
    s.append(h, b);
    insp.body.appendChild(s);
    return { el: s, head: h, body: b, id, title };
  }

  // 數值欄位：標籤可左右拖曳（Shift 加速、Alt 微調）、雙擊標籤重設；外觀沿用 fx 詳細內容（.ed-fx-*）
  function numRow(parent, label, o) {
    const row = el('div', 'ed-fx-row');
    const lab = el('span', 'ed-fx-lab ed-fx-drag', label); lab.title = `${label}：在標籤上左右拖曳調整（Shift 加速、Alt 微調），雙擊重設`;
    const ctl = el('div', 'ed-fx-ctl');
    const inp = el('input'); inp.type = 'number'; inp.setAttribute('aria-label', label);
    const scale = o.scale || 1, dec = o.dec == null ? 2 : o.dec;
    inp.step = o.step || fmtNum(Math.pow(10, -dec), dec);
    ctl.append(inp, el('span', 'ed-fx-unit', o.unit || ''));
    row.append(lab, ctl);
    parent.appendChild(row);
    const lo = o.min == null ? -Infinity : o.min, hi = o.max == null ? Infinity : o.max;
    const q = v => { const k = Math.pow(10, dec) * scale; return Math.round(clamp(v, lo, hi) * k) / k; };
    const cur = () => { const v = Number(o.get()); return isFinite(v) ? v : (o.def || 0); };
    const dpp = o.dpp || (isFinite(hi - lo) ? (hi - lo) / 400 : Math.pow(10, -dec));
    const refresh = () => { if (doc.activeElement !== inp) inp.value = fmtNum(cur() * scale, dec); };
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) { inp.value = fmtNum(cur() * scale, dec); return; }
      const nv = q(v / scale);
      inp.value = fmtNum(nv * scale, dec);
      o.set(nv, false);
    });
    lab.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, v0 = cur();
      let moved = false, last = v0;
      const move = ev => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) < 2) return;
        moved = true;
        last = q(v0 + dx * dpp * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1));
        inp.value = fmtNum(last * scale, dec);
        o.set(last, true);
      };
      const up = () => {
        root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); root.removeEventListener('pointercancel', up);
        doc.body.style.cursor = '';
        if (moved) o.set(last, false);
      };
      doc.body.style.cursor = 'ew-resize';
      root.addEventListener('pointermove', move); root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
    });
    lab.addEventListener('dblclick', () => { if (o.def == null) return; inp.value = fmtNum(o.def * scale, dec); o.set(o.def, false); });
    return { row, input: inp, refresh };
  }
  function checkRow(parent, label, o) {
    const row = el('div', 'ed-fx-row one');
    const l = el('label', 'ed-fx-chk'); const c = el('input'); c.type = 'checkbox';
    l.append(c, doc.createTextNode(label));
    row.appendChild(l); parent.appendChild(row);
    c.addEventListener('change', () => o.set(c.checked));
    return { row, input: c, refresh() { c.checked = !!o.get(); } };
  }
  // 屬性修改：live（拖曳／輸入中）不進復原，放開時再送一次 live:false 才記一筆
  let propsLive = false;
  function applyProps(ids, patch, live, label) {
    if (!ids.length) return;
    if (live) {
      if (!propsLive) { state.history.begin(label || '調整屬性'); propsLive = true; }
      const r = C.setClipProps(state.project, ids, patch);
      if (!r.ok) say(r.reason, 'error');
      if (player) player.refresh();
      scheduleRender('tl');
      return;
    }
    if (propsLive) {
      propsLive = false;
      const r = C.setClipProps(state.project, ids, patch);
      if (!r.ok) say(r.reason, 'error');
      state.history.end();
      return;
    }
    op(label || '調整屬性', p => C.setClipProps(p, ids, patch));
  }
  let transLive = false;
  function commitTransition(patch, o) {
    const id = state.selTransition;
    if (!id) return;
    const isLive = !!(o && o.live);
    const run = p => C.updateTransition(p, id, patch);
    if (isLive) {
      if (!transLive) { state.history.begin('調整轉場'); transLive = true; }
      const r = run(state.project);
      if (!r.ok) say(r.reason, 'error');
      if (player) player.refresh();
      scheduleRender('tl');
    } else if (transLive) {
      transLive = false;
      const r = run(state.project);
      if (!r.ok) say(r.reason, 'error');
      state.history.end();
    } else op('調整轉場', run);
  }
  function commitFor(sec) {
    return (patch, o) => {
      const ids = selIds().filter(id => { const c = clipOf(id); return c && sec.appliesTo(c); });
      applyProps(ids, patch, !!(o && o.live), '調整' + sec.title);
    };
  }

  const primaryClip = () => clipOf(lastSel());
  // 詳細內容的音訊區：主要片段有聲音就用它，否則用選取裡第一個有聲音的（例如選了連結的影像＋聲音）
  const audioClip = () => { const c = primaryClip(); if (c && c.audio) return c; return selIds().map(clipOf).find(x => x && x.audio) || null; };
  const speedClip = () => { const c = primaryClip(); if (c && speedApplies(c)) return c; return selIds().map(clipOf).find(x => speedApplies(x)) || null; };
  const audioIds = () => selIds().filter(id => { const c = clipOf(id); return c && c.audio; });
  const audioPatch = (patch, live) => applyProps(audioIds(), { audio: patch }, live, '調整音訊');
  const aget = (k, d) => () => { const c = audioClip(); return c && c.audio[k] != null ? c.audio[k] : d; };

  function buildInspector() {
    const host = $('edInspector');
    host.textContent = '';
    const head = el('div', 'ed-ph'); head.id = 'edInspHead'; head.textContent = '詳細內容';
    insp.tabs = el('div', 'ed-itabs'); insp.tabs.id = 'edInspTabs'; insp.tabs.setAttribute('role', 'tablist'); insp.tabs.hidden = true;
    insp.body = el('div', 'ed-insp-body');
    host.append(head, insp.tabs, insp.body);
    // 在數值標籤上按下去拖曳時，先讓輸入框失焦：不然焦點還停在輸入框裡，Ctrl+Z 會變成輸入框自己的文字復原
    host.addEventListener('pointerdown', e => {
      if (e.target.closest && e.target.closest('.ed-fx-lab') && doc.activeElement && doc.activeElement !== doc.body && host.contains(doc.activeElement) && isTextTarget(doc.activeElement)) doc.activeElement.blur();
    }, true);

    insp.project = mkSection('project', '專案');
    buildProjectSection(insp.project.body);
    insp.info = mkSection('info', '片段資訊');
    buildInfoSection(insp.info.body);
    // fx 提供的區段（變形／裁切／字幕／轉場）
    for (const s of (F.inspector && F.inspector.sections) || []) insp.fxSecs.push({ def: s, ui: mkSection('fx-' + s.id, s.title, { closed: s.id === 'crop' }) });
    insp.audio = mkSection('audio', '音訊');
    buildAudioSection(insp.audio.body);
    insp.speed = mkSection('speed', '速度');
    buildSpeedSection(insp.speed.body);
    insp.subs = mkSection('subs', '字幕清單');
    buildSubsSection(insp.subs.body);
    insp.delTrans = el('div', 'ed-sec-act'); insp.delTrans.hidden = true;
    const dt = el('button', 'ed-btn small danger', '刪除這個轉場'); dt.type = 'button'; dt.id = 'edDelTrans';
    dt.addEventListener('click', () => { if (state.selTransition) { op('刪除轉場', p => C.removeTransition(p, state.selTransition)); state.selTransition = null; refreshSelectionUI(); } });
    insp.delTrans.appendChild(dt);
    insp.body.appendChild(insp.delTrans);
  }

  // ---- 專案（沒選任何東西時）-----------------------------------------------------------
  function buildProjectSection(body) {
    const dl = el('dl', 'ed-dl');
    insp.projRows = {};
    for (const [k, t] of [['size', '輸出尺寸'], ['fps', '影格率'], ['dur', '時間軸長度'], ['io', 'In／Out'], ['tracks', '軌道'], ['media', '素材']]) {
      const dt = el('dt', null, t), dd = el('dd'); insp.projRows[k] = dd; dl.append(dt, dd);
    }
    const tip = el('div', 'ed-hint');
    tip.innerHTML = '點選時間軸上的片段，這裡會出現它的資訊、變形、音訊與速度。<br>在媒體庫雙擊素材可在檢視器預覽，並設定來源的 In／Out。';
    body.append(dl, tip);
  }
  function updateProjectSection() {
    const p = state.project, r = insp.projRows;
    r.size.textContent = `${p.width}×${p.height}（${p.aspect === 'source' ? '依來源' : p.aspect}）`;
    r.fps.textContent = `${p.fps} fps`;
    const d = C.projectDuration(p);
    r.dur.textContent = d ? `${tc(d, p.fps)}（${d} 格）` : '空的';
    r.io.textContent = p.inPoint == null && p.outPoint == null ? '未設定' : `${p.inPoint != null ? tc(p.inPoint, p.fps) : '開頭'} – ${p.outPoint != null ? tc(p.outPoint - 1, p.fps) : '結尾'}`;
    r.tracks.textContent = `影片 ${C.tracksOf(p, 'video').length}　音訊 ${C.tracksOf(p, 'audio').length}`;
    r.media.textContent = `${R.media.list().length} 個`;
  }

  // ---- 片段資訊 --------------------------------------------------------------------
  function buildInfoSection(body) {
    insp.infoMulti = el('div', 'ed-hint'); body.appendChild(insp.infoMulti);
    const nameRow = el('div', 'ed-fx-row');
    nameRow.append(el('span', 'ed-fx-lab', '名稱'));
    const ctl = el('div', 'ed-fx-ctl'); const inp = el('input'); inp.type = 'text'; inp.id = 'edClipName'; inp.setAttribute('aria-label', '片段名稱');
    ctl.appendChild(inp); nameRow.appendChild(ctl); body.appendChild(nameRow);
    inp.addEventListener('change', () => { const c = primaryClip(); if (c && inp.value !== c.name) applyProps([c.id], { name: inp.value }, false, '改名'); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    insp.nameInput = inp;
    const dl = el('dl', 'ed-dl'); insp.infoRows = {};
    for (const [k, t] of [['kind', '種類'], ['track', '軌道'], ['start', '開始'], ['dur', '長度'], ['src', '來源範圍'], ['link', '連結'], ['en', '啟用']]) {
      const dt = el('dt', null, t), dd = el('dd'); insp.infoRows[k] = dd; dl.append(dt, dd);
    }
    body.appendChild(dl);
    const fl = el('div', 'ed-info-flags'); insp.infoFlags = fl;
    const fb = el('button', 'ed-btn small', '旗標…'); fb.type = 'button'; fb.addEventListener('click', () => { fb.dataset.pop = '1'; openFlagPop(fb); });
    body.append(fl, fb);
  }
  function updateInfoSection(c, n) {
    const p = state.project, r = insp.infoRows, t = trackOf(c.trackId), m = c.mediaId && mediaOf(c.mediaId);
    insp.infoMulti.textContent = n > 1 ? `已選取 ${n} 個片段（以下顯示最後選取的；數值修改會套用到全部適用的片段）` : '';
    insp.infoMulti.hidden = n <= 1;
    if (doc.activeElement !== insp.nameInput) insp.nameInput.value = c.name || '';
    insp.nameInput.placeholder = clipTitle(c);
    r.kind.textContent = c.type === 'title' ? '字幕' : c.type === 'solid' ? '色塊' : m ? `${KIND_NAME[m.kind]}（${m.name}）` : '媒體（找不到素材）';
    r.track.textContent = t ? t.name : '—';
    r.start.textContent = `${tc(c.start, p.fps)}（第 ${c.start} 格）`;
    r.dur.textContent = `${tc(c.duration, p.fps)}（${c.duration} 格，${fmtNum(c.duration / p.fps, 2)} 秒）`;
    const span = c.type === 'media' && m && m.kind !== 'image' ? C.sourceSpan(p, c) : null;
    r.src.textContent = span ? (c.freeze ? `定格於 ${fmtNum(c.srcIn, 3)} 秒` : `${fmtNum(span.from, 2)} – ${fmtNum(span.to, 2)} 秒`) : '—';
    const off = c.linkId ? C.linkOffset(p, c.id) : 0;
    r.link.textContent = c.linkId ? (off ? `已連結（不同步 ${off > 0 ? '+' : ''}${fmtNum(off, 0)} 格）` : '已連結（同步）') : '沒有連結';
    r.link.className = off ? 'bad' : '';
    r.en.textContent = c.enabled === false ? '已停用' : '啟用中';
    insp.infoFlags.textContent = '';
    for (const f of c.flags || []) { const s = el('i', 'ed-flagdot'); s.style.background = MARKER_HEX[f]; s.title = MARKER_NAME[f] || f; insp.infoFlags.appendChild(s); }
    $('edInspHead').textContent = `詳細內容　${clipTitle(c)}`;
  }

  // ---- 音訊 ------------------------------------------------------------------------
  function buildAudioSection(body) {
    const A_ = insp.audioRows = [];
    const add = r => { A_.push(r); return r; };
    add(numRow(body, '增益', { unit: 'dB', min: -60, max: 24, dec: 1, dpp: 0.2, def: 0, get: aget('gainDb', 0), set: (v, live) => audioPatch({ gainDb: v }, live) }));
    add(numRow(body, 'Pan', { unit: '', min: -1, max: 1, scale: 100, dec: 0, dpp: 0.005, def: 0, get: aget('pan', 0), set: (v, live) => audioPatch({ pan: v }, live) }));
    const fl = el('div', 'ed-fx-head', '淡入／淡出'); body.appendChild(fl);
    add(numRow(body, '淡入長度', { unit: '格', min: 0, max: 3000, dec: 0, dpp: 0.5, def: 0, get: aget('fadeIn', 0), set: (v, live) => audioPatch({ fadeIn: Math.round(v) }, live) }));
    add(numRow(body, '淡入曲線', { unit: '%', min: -1, max: 1, scale: 100, dec: 0, dpp: 0.005, def: 0, get: aget('fadeInCurve', 0), set: (v, live) => audioPatch({ fadeInCurve: v }, live) }));
    add(numRow(body, '淡出長度', { unit: '格', min: 0, max: 3000, dec: 0, dpp: 0.5, def: 0, get: aget('fadeOut', 0), set: (v, live) => audioPatch({ fadeOut: Math.round(v) }, live) }));
    add(numRow(body, '淡出曲線', { unit: '%', min: -1, max: 1, scale: 100, dec: 0, dpp: 0.005, def: 0, get: aget('fadeOutCurve', 0), set: (v, live) => audioPatch({ fadeOutCurve: v }, live) }));
    body.appendChild(el('div', 'ed-hint', '曲線：正值＝一開始變化快，負值＝一開始變化慢。也可以直接在時間軸上拖曳音訊片段上緣兩端的圓點。'));

    // EQ
    body.appendChild(el('div', 'ed-fx-head', '等化器（EQ）'));
    add(checkRow(body, '啟用 EQ', { get: () => { const c = audioClip(); return !!(c && c.audio.eq && c.audio.eq.enabled); }, set: v => audioPatch({ eq: { enabled: v } }, false) }));
    const cv = el('canvas', 'ed-eqgraph'); cv.width = 520; cv.height = 150; cv.id = 'edEqGraph';
    cv.setAttribute('aria-label', 'EQ 頻率響應圖'); cv.setAttribute('role', 'img');
    body.appendChild(cv);
    insp.eqCanvas = cv;
    const head = el('div', 'ed-eqhead'); head.append(el('span'), el('span', null, '類型'), el('span', null, '頻率 Hz'), el('span', null, '增益 dB'), el('span', null, 'Q'));
    body.appendChild(head);
    insp.eqBands = [];
    for (let i = 0; i < 6; i++) {
      const row = el('div', 'ed-eqband'); row.dataset.band = i;
      const on = el('input'); on.type = 'checkbox'; on.title = `第 ${i + 1} 段`; on.setAttribute('aria-label', `第 ${i + 1} 段 EQ 開關`);
      const ty = el('select'); ty.setAttribute('aria-label', `第 ${i + 1} 段類型`);
      for (const [v, t] of EQ_TYPES) { const o = el('option', null, t); o.value = v; ty.appendChild(o); }
      const mkn = (label, min, max, step) => { const n = el('input'); n.type = 'number'; n.min = min; n.max = max; n.step = step; n.setAttribute('aria-label', `第 ${i + 1} 段${label}`); return n; };
      const fr = mkn('頻率', 10, 24000, 10), ga = mkn('增益', -30, 30, 0.5), qq = mkn('Q', 0.05, 30, 0.1);
      row.append(on, ty, fr, ga, qq);
      body.appendChild(row);
      const bandPatch = o => { const bands = []; bands[i] = o; return { eq: { bands } }; };
      on.addEventListener('change', () => audioPatch(bandPatch({ on: on.checked }), false));
      ty.addEventListener('change', () => audioPatch(bandPatch({ type: ty.value }), false));
      for (const [inp, key, lo, hi] of [[fr, 'freq', 10, 24000], [ga, 'gain', -30, 30], [qq, 'q', 0.05, 30]]) {
        inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!isFinite(v)) { updateAudioSection(); return; } audioPatch(bandPatch({ [key]: clamp(v, lo, hi) }), false); });
      }
      insp.eqBands.push({ on, ty, fr, ga, qq });
    }
    body.appendChild(el('div', 'ed-hint', '頻率響應圖就是目前的 EQ 設定（預覽與匯出都套用同一組濾波器）。'));
    const rst = el('button', 'ed-btn small', '重設 EQ'); rst.type = 'button'; rst.id = 'edEqReset';
    rst.addEventListener('click', () => audioPatch({ eq: C.defaultEq() }, false));
    body.appendChild(rst);
  }
  function updateAudioSection() {
    const c = audioClip();
    if (!c) return;
    for (const r of insp.audioRows) r.refresh();
    const eq = c.audio.eq || C.defaultEq();
    insp.eqBands.forEach((b, i) => {
      const d = eq.bands[i]; if (!d) return;
      b.on.checked = d.on !== false;
      b.ty.value = d.type;
      if (doc.activeElement !== b.fr) b.fr.value = fmtNum(d.freq, 0);
      if (doc.activeElement !== b.ga) b.ga.value = fmtNum(d.gain, 1);
      if (doc.activeElement !== b.qq) b.qq.value = fmtNum(d.q, 2);
      for (const x of [b.on, b.ty, b.fr, b.ga, b.qq]) x.disabled = !eq.enabled;
      b.on.parentElement.classList.toggle('off', !eq.enabled || d.on === false);
    });
    drawEq(insp.eqCanvas, eq);
  }
  function drawEq(cv, eq) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, dbR = 18;
    const css = getComputedStyle(app);
    const col = n => css.getPropertyValue(n).trim() || '#6b7890';
    g.clearRect(0, 0, W, H);
    g.fillStyle = col('--ed-field') || '#fff'; g.fillRect(0, 0, W, H);
    const fx0 = 20, fx1 = 20000, L = Math.log(fx1 / fx0);
    const X = f => Math.log(f / fx0) / L * W, Y = db => H / 2 - clamp(db, -dbR, dbR) / dbR * (H / 2 - 6);
    g.strokeStyle = col('--ed-grid'); g.lineWidth = 1; g.fillStyle = col('--ed-muted'); g.font = '17px system-ui, sans-serif';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(X(f)) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      g.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x + 2, H - 3);
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = Math.round(Y(db)) + .5; g.strokeStyle = db === 0 ? col('--ed-grid-strong') : col('--ed-grid-weak');
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.fillText((db > 0 ? '+' : '') + db, 3, y - 2);
    }
    const n = 200, freqs = new Float32Array(n);
    for (let i = 0; i < n; i++) freqs[i] = fx0 * Math.exp(L * i / (n - 1));
    let resp;
    try { resp = R.eqResponse(eq, freqs); } catch (_) { resp = new Float32Array(n); }
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = X(freqs[i]), y = Y(resp[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = eq.enabled ? col('--ed-accent') : col('--ed-grid-strong'); g.lineWidth = 2; g.stroke();
    if (!eq.enabled) { g.fillStyle = col('--ed-muted'); g.textAlign = 'center'; g.fillText('EQ 未啟用', W / 2, H / 2 - 8); g.textAlign = 'left'; }
  }

  // ---- 速度 ------------------------------------------------------------------------
  function speedCommit(patch, isLive) {
    const c = speedClip();
    if (!c) return;
    const fn = q => C.setSpeed(q, c.id, Object.assign({ ripple: state.rippleSpeed, linked: state.linkedSelection }, patch));
    if (isLive) { const r = live.run('變速', fn); if (!r.ok) say(r.reason, 'error'); return; }
    if (live.started) { const r = live.run('變速', fn); if (!r.ok) say(r.reason, 'error'); live.end(); return; }
    op('變速', fn);
  }
  function buildSpeedSection(body) {
    insp.speedRows = [];
    const add = r => { insp.speedRows.push(r); return r; };
    add(numRow(body, '速度', { unit: '%', min: 1, max: 10000, scale: 100, dec: 1, dpp: 0.01, def: 1, get: () => { const c = speedClip(); return c ? c.speed : 1; }, set: (v, live_) => speedCommit({ speed: v }, live_) }));
    add(checkRow(body, '倒播', { get: () => { const c = speedClip(); return !!(c && c.reverse); }, set: v => speedCommit({ reverse: v }, false) }));
    add(checkRow(body, '波紋（片段長度跟著變，後面的片段一起推拉）', { get: () => state.rippleSpeed, set: v => { state.rippleSpeed = v; } }));
    insp.speedNote = el('div', 'ed-hint'); body.appendChild(insp.speedNote);
  }
  function speedApplies(c) { const m = c && c.type === 'media' && c.mediaId && mediaOf(c.mediaId); return !!m && m.kind !== 'image'; }
  function updateSpeedSection(c) {
    for (const r of insp.speedRows) r.refresh();
    const frozen = !!c.freeze;
    for (const r of insp.speedRows) r.input.disabled = frozen;
    insp.speedNote.textContent = frozen ? '這是定格片段，不能變速。' : '也可以按 ' + MOD + 'R 開啟變速對話框。';
  }

  // ---- 字幕清單：每段字幕一行（時間＋文字框）----------------------------------------------
  function buildSubsSection(body) {
    insp.subHead = el('div', 'ed-hint');
    insp.subList = el('div', 'ed-sublist');
    const foot = el('div', 'ed-hint', '按時間跳到那一段；Enter 跳到下一行，Shift＋Enter 換行。播放時按 V 可以再加一段。');
    const ex = el('button', 'ed-btn'); ex.type = 'button'; ex.id = 'edSubsExport'; ex.textContent = '匯出 SRT';
    ex.addEventListener('click', () => exportSrt());
    body.append(insp.subHead, insp.subList, foot, ex);
    insp.subKey = null;
  }
  function updateSubsSection() {
    const subs = subClips(), fps = state.project.fps, list = insp.subList;
    insp.subHead.textContent = `共 ${subs.length} 段字幕`;
    const key = subs.map(c => c.id + '@' + c.start + '+' + c.duration).join(',');
    if (key !== insp.subKey) {
      insp.subKey = key;
      list.textContent = '';
      subs.forEach((c, i) => {
        const row = el('div', 'ed-subrow'); row.dataset.clip = c.id;
        const t = el('button', 'ed-subtc', tc(c.start, fps)); t.type = 'button';
        t.title = `跳到這一段（${tc(c.start, fps)}，${fmtNum(c.duration / fps, 2)} 秒）`;
        t.addEventListener('click', () => { seekTimeline(c.start); selectClips([c.id]); });
        const d = el('span', 'ed-subdur', fmtNum(c.duration / fps, 1) + ' 秒');
        const ta = el('textarea', 'ed-subtxt'); ta.rows = 1; ta.placeholder = `第 ${i + 1} 段字幕`; ta.setAttribute('aria-label', `第 ${i + 1} 段字幕文字`);
        const commit = live => applyProps([c.id], { title: { text: ta.value } }, live, '修改字幕');
        ta.addEventListener('input', () => { fitRows(ta); commit(true); });
        ta.addEventListener('change', () => commit(false));
        ta.addEventListener('focus', () => { if (state.playhead < c.start || state.playhead >= c.start + c.duration) seekTimeline(c.start); });
        ta.addEventListener('keydown', e => {
          if (e.isComposing || e.keyCode === 229) return;                       // 注音／倉頡選字中的 Enter 不算
          if (e.key === 'Escape') { e.preventDefault(); ta.blur(); return; }
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          const next = row.nextElementSibling && row.nextElementSibling.querySelector('.ed-subtxt');
          ta.blur();
          if (next) next.focus();
        });
        const x = el('button', 'ed-subdel', '×'); x.type = 'button'; x.title = '刪除這段字幕'; x.setAttribute('aria-label', `刪除第 ${i + 1} 段字幕`);
        x.addEventListener('click', () => { const r = op('刪除字幕', p => C.lift(p, [c.id], { linked: false })); if (r && r.ok) { state.selection.delete(c.id); refreshSelectionUI(); } });
        row.append(t, d, x, ta);
        list.appendChild(row);
      });
      if (!subs.length) list.appendChild(el('div', 'ed-hint', '還沒有字幕。按 V 或「匯入 SRT」。'));
    }
    for (const row of list.children) {
      const c = clipOf(row.dataset.clip);
      if (!c) continue;
      row.classList.toggle('sel', state.selection.has(c.id));
      const ta = row.querySelector('.ed-subtxt');
      if (ta && doc.activeElement !== ta && ta.value !== c.title.text) { ta.value = c.title.text; fitRows(ta); }
    }
    if (insp.revealSub) {
      const row = list.querySelector(`.ed-subrow[data-clip="${insp.revealSub}"]`);
      insp.revealSub = null;
      if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.add('new'); root.setTimeout(() => row.classList.remove('new'), 1200); }
    }
  }
  const fitRows = ta => { ta.rows = Math.min(4, Math.max(1, ta.value.split('\n').length)); };

  // ---- 分頁：依選取的物件種類分頁，一次只看一頁 ------------------------------------------
  // 每頁列出要顯示的區段（沒有的區段自動略過，整頁都沒有就不出現這個分頁）；各種類記住上次看的分頁
  const fxSec = id => insp.fxSecs.find(f => f.def.id === id);
  function inspPages(c) {
    const fx = (...ids) => ids.map(id => { const f = fxSec(id); return f && f.def.appliesTo(c) ? f : null; });
    const audio = audioClip() ? insp.audio : null, speed = speedClip() ? insp.speed : null;
    if (isSubClip(c)) {
      return { kind: 'sub', pages: [['subs', '清單', [insp.subs]], ['text', '文字', fx('title')], ['look', '外觀', fx('titleLook')], ['anim', '動畫', fx('titleAnim')],
        ['xform', '變形', fx('transform', 'crop')], ['info', '資訊', [insp.info]]] };
    }
    if (c.type === 'title') {
      return { kind: 'title', pages: [['text', '文字', fx('title')], ['look', '外觀', fx('titleLook')], ['anim', '動畫', fx('titleAnim')],
        ['xform', '變形', fx('transform', 'crop')], ['info', '資訊', [insp.info]]] };
    }
    const kind = c.video ? c.type : 'audio';
    return { kind, pages: [['xform', '變形', fx('transform')], ['crop', '裁切', fx('crop')], ['audio', '音訊', [audio]], ['speed', '速度', [speed]], ['info', '資訊', [insp.info]]] };
  }
  function loadTabOf() {
    if (!insp.tabOf) { insp.tabOf = {}; try { insp.tabOf = JSON.parse(root.localStorage.getItem('qc-itab')) || {}; } catch (_) { /* 讀不到就用預設 */ } }
    return insp.tabOf;
  }
  function setInspTab(kind, id) {
    loadTabOf()[kind] = id;
    try { root.localStorage.setItem('qc-itab', JSON.stringify(insp.tabOf)); } catch (_) { /* 不能存就算了 */ }
    renderInspector();
  }

  // ---- 總更新 ----------------------------------------------------------------------
  function renderInspector() {
    if (!insp.body) return;
    const p = state.project;
    const tr = state.selTransition && p.transitions[state.selTransition];
    const ids = selIds(), c = primaryClip();
    const show = (sec, on) => { sec.el.hidden = !on; };
    show(insp.project, false); show(insp.info, false); show(insp.audio, false); show(insp.speed, false); show(insp.subs, false);
    insp.delTrans.hidden = true;
    for (const f of insp.fxSecs) show(f.ui, false);
    for (const s of [insp.info, insp.audio, insp.speed, insp.subs, ...insp.fxSecs.map(f => f.ui)]) s.el.classList.remove('solo');
    insp.tabs.hidden = true;
    $('edInspHead').textContent = '詳細內容';
    if (tr) {
      const f = insp.fxSecs.find(x => x.def.appliesTo(tr));
      if (f) { show(f.ui, true); f.def.render(f.ui.body, tr, commitTransition); }
      insp.delTrans.hidden = false;
      $('edInspHead').textContent = `詳細內容　轉場（${TRANS_SIDE_TEXT[C.transitionSide(tr)] || ''}）`;
      return;
    }
    if (!c) { show(insp.project, true); updateProjectSection(); return; }
    updateInfoSection(c, ids.length);
    const { kind, pages } = inspPages(c);
    const avail = pages.map(([id, label, secs]) => [id, label, secs.filter(Boolean)]).filter(pg => pg[2].length);
    const page = avail.find(pg => pg[0] === loadTabOf()[kind]) || avail[0];
    const key = kind + ':' + avail.map(pg => pg[0]).join(',') + ':' + page[0];
    if (insp.tabsKey !== key) {
      insp.tabsKey = key;
      insp.tabs.textContent = '';
      for (const [id, label] of avail) {
        const b = el('button', 'ed-itab' + (id === page[0] ? ' active' : ''), label);
        b.type = 'button'; b.dataset.itab = id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(id === page[0]));
        b.addEventListener('click', () => setInspTab(kind, id));
        insp.tabs.appendChild(b);
      }
    }
    insp.tabs.hidden = avail.length < 2;
    const secs = page[2];
    for (const s of secs) {
      const ui = s.ui || s;
      show(ui, true);
      if (secs.length === 1) ui.el.classList.add('solo');
      if (s.def) s.def.render(s.ui.body, c, commitFor(s.def));
      else if (s === insp.audio) updateAudioSection();
      else if (s === insp.speed) updateSpeedSection(speedClip());
      else if (s === insp.subs) updateSubsSection();
    }
  }

  // =====================================================================================
  // 啟動
  // =====================================================================================
  const hasContent = () => !!state.project && Object.keys(state.project.clips).length > 0;

  function onCoreChange(e) {
    sanitizeSelection();
    ensureMediaInfo();
    scheduleStage();
    if (hasContent()) state.dirty = true;
    scheduleRender('all');
    if (state.mode === 'timeline' && player) {
      // 專案縮短後播放頭不能留在內容之外太遠
      const d = C.projectDuration(state.project);
      if (state.playhead > d) { state.playhead = d; player.seek(d); }
    }
  }

  function createPlayer() {
    if (player) return;
    player = R.createPlayer({ canvas: $('edCanvas'), getProject: viewProject, maxSize: 1280 });
    player.on('frame', onPlayerFrame);
    player.on('state', updatePlayButton);
    updatePlayButton();
  }

  function onShow() {
    createPlayer();
    themeRepaint();
    applyVertical(true);
    renderMedia();
    syncAspect();
    dirty.tl = dirty.insp = dirty.chrome = true;
    renderNow();
    if (player) player.refresh();
    updatePlayheadPos(false);
  }
  function onHide() {
    if (player) player.pause();
    closePop(); closeMenu();
  }

  function wireSplitter() {
    const sp = $('edSplit');
    sp.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const tlEl = $('edTimeline'), y0 = e.clientY, h0 = tlEl.getBoundingClientRect().height;
      const top = $('edTop');
      const move = ev => {
        const h = clamp(h0 - (ev.clientY - y0), 170, Math.max(200, app.getBoundingClientRect().height - 340));
        app.style.setProperty('--ed-tl-h', h + 'px');
        void top;
      };
      const up = () => { root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); app.classList.remove('resizing'); scheduleRender('tl'); };
      app.classList.add('resizing');
      root.addEventListener('pointermove', move); root.addEventListener('pointerup', up);
    });
  }

  function init() {
    C = Q.core; R = Q.render; F = Q.fx;
    if (!C || !R || !F || typeof C.createProject !== 'function' || !R.media || typeof R.createPlayer !== 'function') {
      app.textContent = '';
      app.appendChild(el('div', 'ed-fatal', '剪輯模組沒有載入成功，請重新整理頁面；如果還是不行，請改用最新版 Chrome 或 Edge。'));
      return;
    }
    newProject();
    // fx 的詳細內容樣式（.ed-fx-*）：音訊／速度區段也用同一套外觀，啟動時就插入
    if (typeof F.ensureStyle === 'function') F.ensureStyle();
    buildMediaPanel(); buildViewer(); buildToolbar(); buildTimeline(); buildInspector();
    wireFileDrop(); wireSplitter(); wireColSplitters();
    readColors(); syncThemeBtn();
    const tbtn = $('edThemeBtn');
    if (tbtn) tbtn.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark', true));
    root.addEventListener('resize', () => { if (!app.hidden && app.classList.contains('ed-vert')) fitVertical(); });
    app.dataset.tool = state.tool;

    tl.scroll.addEventListener('pointerdown', onTlDown);
    tl.scroll.addEventListener('pointermove', onTlHover);
    tl.scroll.addEventListener('pointerleave', () => { if (!drag) { setActionLabel(''); if (tl.bladeLine) tl.bladeLine.hidden = true; } });
    tl.scroll.addEventListener('contextmenu', onTlContext);

    C.bus.addEventListener('change', onCoreChange);
    // 字幕字型是用到才下載：下載中提示一下，好了就重畫預覽、拖曳框與字幕縮圖
    if (F.onFontLoad) F.onFontLoad((id, what) => {
      const nm = F.FONTS && F.FONTS[id] ? F.FONTS[id].name : id;
      if (what === 'loading') { say(`正在下載字型「${nm}」（檔案較大，第一次需要一點時間）…`); return; }
      if (id !== 'WHZ-Heavy') say(what === 'loaded' ? `字型「${nm}」已載入` : `字型「${nm}」載入失敗，先用系統字型顯示`, what === 'loaded' ? 'ok' : 'error');
      if (player && !player.playing) player.refresh();
      scheduleStage();
    });
    C.bus.addEventListener('exported', () => { state.dirty = false; say('已匯出', 'ok'); });
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp, true);
    root.addEventListener('beforeunload', e => {
      if (state.dirty && hasContent()) { e.preventDefault(); e.returnValue = ''; return ''; }
      return undefined;
    });
    doc.addEventListener('visibilitychange', () => { if (doc.hidden && player) player.pause(); });

    renderMedia(); syncAspect(); renderViewerChrome(); updateToolbar(); setActionLabel('');
    dirty.tl = dirty.insp = true;
    if (!app.hidden) onShow();
  }

  Object.assign(Q.ui, {
    init, importFiles, importSrt, exportSrt, markSubtitle, doEdit, selectClips, applyTitleStyle, applyTextFx, selectTransition, seekTimeline, setTool, undo, redo, openSource, setMode, addTitle, addTransitionAt, addTransitionToSelection,
    setZoom, zoomFit, renderNow, bladeAtPlayhead, deleteSelection, markIn, markOut, clearInOut, addMarkerHere, toggleLink, toggleSnap, ensureMediaInfo,
    openSpeedPop, openFreezePop, tl, tc, setTheme: t => applyTheme(t, true),
  });
  Object.defineProperties(Q.ui, {
    zoom: { get: () => state.zoom, enumerable: true },
    ppf: { get: () => tl.k, enumerable: true },          // 每格幾像素（測試用）
  });

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
