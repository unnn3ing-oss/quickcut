// =====================================================================================
// 剪輯介面：啟動與公開 API
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
// 啟動（init）、顯示／隱藏、分隔條、公開 API（QPTEdit.ui）。這支最後載入。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;                     // 頁面上沒有剪輯介面
  const { $, addMarkerHere, addTitle, addTransitionAt, addTransitionToSelection, app, applyTextFx, applyTheme,
    applyTitleStyle, applyVertical, bladeAtPlayhead, buildInspector, buildMediaPanel, buildTimeline, buildToolbar,
    buildViewer, clamp, clearInOut, closeMenu, closePop, closeSource, deleteSelection, dirty, doEdit, doc, el,
    ensureMediaInfo, exportSrt, fitVertical, importFiles, importSrt, markIn, markOut, markSubtitle, newProject,
    onKeyDown, onKeyUp, onPlayerFrame, onTlContext, onTlDown, onTlHover, openFreezePop, openSource, openSpeedPop,
    readColors, redo, renderMedia, renderNow, renderViewerChrome, sanitizeSelection, say, scheduleRender,
    scheduleStage, seekTimeline, selectClips, selectTrack, selectTransition, setActionLabel, setMode, setTool, setZoom,
    showMsgs, state, syncAspect, syncThemeBtn, tc, themeRepaint, tl, toggleLink, toggleSnap, undo, updatePlayButton,
    updatePlayheadPos, updateToolbar, viewProject, wireColSplitters, wireFileDrop, zoomFit } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

  // =====================================================================================
  // 啟動
  // =====================================================================================
  const hasContent = () => !!state.project && Object.keys(state.project.clips).length > 0;
  // 開啟專案：換掉整個專案、清空復原紀錄與選取；view.playhead 是存檔時的播放頭位置
  function replaceProject(p, view) {
    if (UI.player) UI.player.pause();
    closePop(); closeMenu();
    if (state.mode === 'source') closeSource();
    state.project = p;
    state.history = C.createHistory(() => state.project, q => { state.project = q; }, { limit: 100 });
    state.selection = new Set(); state.primary = null; state.selTransition = null; state.selMedia = null;
    state.sourceInOut = null; state.targets = { video: null, audio: null };
    state.dirty = false;
    renderMedia(); syncAspect(); updateToolbar();
    dirty.tl = dirty.insp = dirty.chrome = true;
    renderNow();
    if (UI.player) UI.player.refresh();
    seekTimeline(Math.min(Math.max(0, Math.round((view && view.playhead) || 0)), C.projectDuration(p)));
    updatePlayheadPos(false);
    scheduleStage();
  }
  // 素材接回來之後重畫（片段縮圖、預覽、詳細內容）
  function mediaChanged() {
    renderMedia(); syncAspect();
    dirty.tl = dirty.insp = true;
    scheduleRender();
    if (UI.player) UI.player.refresh();
  }

  function onCoreChange(e) {
    sanitizeSelection();
    ensureMediaInfo();
    scheduleStage();
    if (hasContent()) state.dirty = true;
    scheduleRender('all');
    if (state.mode === 'timeline' && UI.player) {
      // 專案縮短後播放頭不能留在內容之外太遠
      const d = C.projectDuration(state.project);
      if (state.playhead > d) { state.playhead = d; UI.player.seek(d); }
    }
  }

  function createPlayer() {
    if (UI.player) return;
    UI.player = R.createPlayer({ canvas: $('edCanvas'), getProject: viewProject, maxSize: 1280 });
    UI.player.on('frame', onPlayerFrame);
    UI.player.on('state', updatePlayButton);
    // 打拍子模式在停止播放時結束（顯示打了幾拍）
    UI.player.on('state', e => {
      if (e && !e.playing && state.beatTap) { state.beatTap = false; say(`打拍子結束：時間軸上有 ${Q.core.beatFrames(state.project).length} 個節拍標記`); }
    });
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
    if (UI.player) UI.player.refresh();
    updatePlayheadPos(false);
  }
  function onHide() {
    if (UI.player) UI.player.pause();
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
    UI.bindModules();
    if (!C || !R || !F || typeof C.createProject !== 'function' || !R.media || typeof R.createPlayer !== 'function') {
      app.textContent = '';
      app.appendChild(el('div', 'ed-fatal', '剪輯模組沒有載入成功，請重新整理頁面；如果還是不行，請改用最新版 Chrome 或 Edge。'));
      return;
    }
    newProject();
    // fx 的詳細內容樣式（.ed-fx-*）：音訊／速度區段也用同一套外觀，啟動時就插入
    if (typeof F.ensureStyle === 'function') F.ensureStyle();
    buildMediaPanel(); buildViewer(); buildToolbar(); buildTimeline(); buildInspector();
    UI.initSimple();                     // 簡易／專業切換、大按鈕工具列、開始畫面（edit-ui-simple.js）
    wireFileDrop(); wireSplitter(); wireColSplitters();
    readColors(); syncThemeBtn();
    const tbtn = $('edThemeBtn');
    if (tbtn) tbtn.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark', true));
    root.addEventListener('resize', () => { if (!app.hidden && app.classList.contains('ed-vert')) fitVertical(); });
    app.dataset.tool = state.tool;

    tl.scroll.addEventListener('pointerdown', onTlDown);
    tl.scroll.addEventListener('pointermove', onTlHover);
    tl.scroll.addEventListener('pointerleave', () => { if (!UI.drag) { setActionLabel(''); if (tl.bladeLine) tl.bladeLine.hidden = true; } });
    tl.scroll.addEventListener('contextmenu', onTlContext);

    C.bus.addEventListener('change', onCoreChange);
    // 字幕字型是用到才下載：下載中提示一下，好了就重畫預覽、拖曳框與字幕縮圖
    if (F.onFontLoad) F.onFontLoad((id, what) => {
      const nm = F.FONTS && F.FONTS[id] ? F.FONTS[id].name : id;
      if (what === 'loading') { say(`正在下載字型「${nm}」（檔案較大，第一次需要一點時間）…`); return; }
      if (id !== 'WHZ-Heavy') say(what === 'loaded' ? `字型「${nm}」已載入` : `字型「${nm}」載入失敗，先用系統字型顯示`, what === 'loaded' ? 'ok' : 'error');
      if (UI.player && !UI.player.playing) UI.player.refresh();
      scheduleStage();
    });
    C.bus.addEventListener('exported', () => { state.dirty = false; say('已匯出', 'ok'); });
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp, true);
    root.addEventListener('beforeunload', e => {
      if (state.dirty && hasContent()) { e.preventDefault(); e.returnValue = ''; return ''; }
      return undefined;
    });
    doc.addEventListener('visibilitychange', () => { if (doc.hidden && UI.player) UI.player.pause(); });

    renderMedia(); syncAspect(); renderViewerChrome(); updateToolbar(); setActionLabel('');
    dirty.tl = dirty.insp = true;
    if (!app.hidden) onShow();
  }

  Object.assign(Q.ui, {
    init, importFiles, importSrt, exportSrt, markSubtitle, doEdit, selectClips, selectTrack, applyTitleStyle, applyTextFx, selectTransition, seekTimeline, setTool, undo, redo, openSource, setMode, addTitle, addTransitionAt, addTransitionToSelection,
    setZoom, zoomFit, renderNow, bladeAtPlayhead, deleteSelection, markIn, markOut, clearInOut, addMarkerHere, toggleLink, toggleSnap, ensureMediaInfo,
    openSpeedPop, openFreezePop, tl, tc, setTheme: t => applyTheme(t, true), setUiMode: m => UI.setUiMode(m),
    replaceProject, mediaChanged, hasContent, renderMedia, showMsgs,
    markSaved: () => { state.dirty = false; },
  });
  Object.defineProperties(Q.ui, {
    zoom: { get: () => state.zoom, enumerable: true },
    ppf: { get: () => tl.k, enumerable: true },          // 每格幾像素（測試用）
  });

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
