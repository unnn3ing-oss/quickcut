// =====================================================================================
// 剪輯介面：時間軸
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
// 時間軸的畫面（時間尺、軌道、片段、轉場、播放頭）與滑鼠操作（拖曳、修剪、框選、自動捲動）。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;                     // 頁面上沒有剪輯介面
  const { $, AUDIO_H, DRAG_PX, EDGE_PX, HEAD_W, ICONS, MARKER_HEX, MARKER_NAME, MOD, RULER_H, SNAP_PX, TRANS_SIDE_TEXT,
    VIDEO_H, ZOOM_MIN, addMarkerHere, addTitle, addTransitionAt, app, applyTextFx, applyTitleStyle, bladeAtPlayhead,
    clamp, clickSelect, clipOf, clipTitle, closeMenu, closePop, colors, deleteSelection, doc, el, ensureMediaInfo,
    flushPop, fmtNum, fps, icon, linkSelection, markClipRange, mediaOf, op, openFlagPop, openFreezePop, openMarkerPop,
    openMenu, openSpeedPop, renderMedia, renderViewerChrome, say, scheduleStage, seekTimeline, selIds, selectClips,
    selectTransition, state, syncAspect, targetTrack, tc, trackOf, updateSubMark, updateToolbar, videoTracksTopFirst } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

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
    UI.statusEl = el('div', 'ed-status'); UI.statusEl.id = 'edStatus'; UI.statusEl.setAttribute('role', 'status'); UI.statusEl.setAttribute('aria-live', 'polite');
    const keys = el('div', 'ed-keys', 'A 選取　B 刀片　T 修剪　I／O 入出點　F9 插入　F10 覆蓋　F12 加到結尾　空白鍵 播放　' + MOD + 'Z 復原　' + MOD + '滾輪 縮放');
    foot.append(UI.statusEl, keys);
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
    if (dirty.insp) { dirty.insp = false; UI.renderInspector(); }
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
    nm.title = `${t.name}：點一下選取這條軌的所有片段並設為目的軌道（插入／覆蓋會放到這條）；Shift／${MOD.replace('+', '')}＋點一下加選；雙擊改名；右鍵更多`;
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
    // 點標頭（名稱或空白處；鎖定／眼睛／M／S 按鈕與改名輸入框除外）：選取整條軌
    th.addEventListener('click', e => {
      if (e.target.closest('.ed-thb, .ed-th-input')) return;
      selectTrack(t.id, e.shiftKey || e.ctrlKey || e.metaKey);
    });
    th.addEventListener('contextmenu', e => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: '選取這條軌的所有片段', run: () => selectTrack(t.id, false) },
        { label: '設為目的軌道', run: () => setTarget(t.kind, t.id) },
        { label: '重新命名', run: () => renameTrack(t.id, $('edTimeline').querySelector(`.ed-th[data-track="${t.id}"] .ed-th-name`)) },
        { sep: true },
        { label: '刪除這條軌道', run: () => deleteTrack(t.id) },
      ]);
    });
    return th;
  }
  // 目的軌道：只換標頭的標示，不重畫整個時間軸（不然雙擊改名的第二下會點到已經被換掉的元素）
  function setTarget(kind, id, quiet) {
    state.targets[kind] = id;
    for (const th of tl.inner.querySelectorAll('.ed-th.' + kind)) th.classList.toggle('target', th.dataset.track === id);
    const t = trackOf(id);
    if (!quiet) say(`${kind === 'video' ? '影片' : '音訊'}目的軌道：${t ? t.name : ''}`, 'ok');
  }
  // 選取整條軌：只選這條軌上的片段（不展開連結，免得選到別條軌），同時設為目的軌道；詳細內容顯示第一個片段，改數值會套用到全部選取的片段。
  // add＝Shift／Ctrl（⌘）：這條軌的片段已經全部選了就取消，不然加進目前的選取。
  function selectTrack(id, add) {
    const t = trackOf(id);
    if (!t) return;
    setTarget(t.kind, t.id, true);
    const ids = C.clipsOnTrack(state.project, id).map(c => c.id);   // 已依開始時間排序
    if (!ids.length) {
      if (!add) selectClips([]);
      say(`「${t.name}」軌沒有片段（已設為目的軌道）`);
      return;
    }
    if (add) {
      const all = ids.every(i => state.selection.has(i));
      selectClips(ids, { add: true, toggle: all });
      if (!all) state.primary = ids[0];
      else if (!state.selection.has(state.primary)) state.primary = state.selection.size ? [...state.selection][0] : null;
      refreshSelectionUI();
      say(all ? `已取消選取「${t.name}」軌（還有 ${state.selection.size} 個片段被選取）` : `已加選「${t.name}」軌的 ${ids.length} 個片段（共 ${state.selection.size} 個）`, 'ok');
    } else {
      selectClips(ids);
      say(`已選取「${t.name}」軌的 ${ids.length} 個片段${t.locked ? '（這條軌已鎖定，不能修改）' : ''}`, 'ok');
    }
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
      // 整條軌的片段都被選取時，標頭也標示出來
      for (const th of tl.inner.querySelectorAll('.ed-th')) {
        const cs = C.clipsOnTrack(state.project, th.dataset.track);
        th.classList.toggle('sel', cs.length > 0 && cs.every(c => state.selection.has(c.id)));
      }
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
      if (UI.player) UI.player.refresh();
      scheduleInspector();
      return r;
    },
    end() { if (this.started) { this.started = false; this.ops = 0; state.history.end(); } },
    abort() { if (this.started) { this.started = false; this.ops = 0; state.history.cancel(); } },
  };

  UI.drag = null; let autoRaf = 0;
  function beginDrag(e, d) {
    if (UI.drag) return;
    d.x0 = e.clientX; d.y0 = e.clientY; d.moved = false; d.sl0 = tl.scroll.scrollLeft; d.last = e;
    UI.drag = d;
    const apply = ev => d.move(ev, ev.clientX - d.x0 + (tl.scroll.scrollLeft - d.sl0), ev.clientY - d.y0);
    const onMove = ev => {
      d.last = ev;
      if (!d.moved) { if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < DRAG_PX) return; d.moved = true; app.classList.add('dragging'); }
      apply(ev);
      if (d.autoscroll && !autoRaf) autoRaf = requestAnimationFrame(autoScroll);
    };
    const autoScroll = () => {
      autoRaf = 0;
      if (UI.drag !== d || !d.moved) return;
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
      UI.drag = null; app.classList.remove('dragging'); showSnap(null);
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
    if (UI.drag || UI.libDrag) return;
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

  Object.assign(UI, {
    afterRender, beginDrag, buildTimeline, dirty, live, onTlContext, onTlDown, onTlHover, refreshSelectionUI,
    renderNow, revealFrame, scheduleInspector, schedulePaint, scheduleRender, selectTrack, setActionLabel, setZoom, tl,
    tlDrop, tlShowDrop, updatePlayheadPos, waveAmp, zoomBy, zoomFit,
  });
})(typeof window !== 'undefined' ? window : globalThis);
