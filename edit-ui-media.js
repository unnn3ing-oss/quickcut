// =====================================================================================
// 剪輯介面：媒體庫
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
// 左側面板：媒體（匯入、清單、拖到時間軸）、特效（轉場／字體特效）、字幕（樣式、SRT、V 標記）。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;                     // 頁面上沒有剪輯介面
  const { $, KIND_NAME, MVIEW_KEY, app, colors, doc, el, fmtNum, fmtSec, icon, isTextTarget, lsSet, mediaOf, say,
    state } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

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
    drop.addEventListener('click', e => { if (e.target !== input) pickFiles(input); });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(input); } });
    input.addEventListener('change', () => { const f = [...input.files]; input.value = ''; importFiles(f); });
    const msgs = el('div', 'ed-msgs'); msgs.id = 'edMsgs'; msgs.setAttribute('aria-live', 'polite');
    const relink = el('div', 'ed-relink'); relink.id = 'edRelink'; relink.hidden = true;   // 開啟專案後缺少的素材（內容由 edit-project.js 填）
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
    pm.append(drop, msgs, relink, mbar, list, foot);

    // 特效：轉場特效（加在剪接點）＋字體特效（加在字幕片段）。兩組都在同一個捲動面板裡
    const pt = el('div', 'ed-panel scroll'); pt.dataset.panel = 'trans'; pt.hidden = true;
    const tl = el('div', 'ed-glist static'); tl.id = 'edTransList';
    const ta = el('div', 'ed-pfoot');
    const tbIn = el('button', 'ed-btn'); tbIn.type = 'button'; tbIn.id = 'edTransAddIn'; tbIn.textContent = '加到開頭';
    tbIn.title = '把選取的轉場加到所選片段的開頭（和前一個片段之間；前面是空隙或時間軸起點時是淡入）';
    tbIn.addEventListener('click', () => UI.addTransitionToSelection(lib.trans, 'start'));
    const tb = el('button', 'ed-btn primary'); tb.type = 'button'; tb.id = 'edTransAdd'; tb.textContent = '加到結尾';
    tb.title = '把選取的轉場加到所選片段的結尾（和下一個片段之間；沒有下一個片段時是淡出）';
    tb.addEventListener('click', () => UI.addTransitionToSelection(lib.trans, 'end'));
    const tbs = el('div', 'ed-btnrow'); tbs.append(tbIn, tb);
    ta.append(tbs, el('span', 'ed-hint', '先選一個片段，按「加到開頭」或「加到結尾」；或把轉場拖到剪接點、片段的開頭或結尾。'));
    const xl = el('div', 'ed-glist static'); xl.id = 'edTextFxList';
    const xa = el('div', 'ed-pfoot');
    const xb = el('button', 'ed-btn primary'); xb.type = 'button'; xb.id = 'edTextFxApply'; xb.textContent = '套用到選取的字幕';
    xb.title = '把選取的字體特效套用到時間軸上選取的字幕片段';
    xb.addEventListener('click', () => UI.applyTextFx(lib.textFx));
    xa.append(xb, el('span', 'ed-hint', '字幕出現時的動畫。選取字幕片段後按「套用」，或把特效拖到時間軸的字幕片段上；長度在詳細內容調整。'));
    pt.append(groupHead('轉場特效'), tl, ta, groupHead('字體特效'), xl, xa);

    const pg = el('div', 'ed-panel scroll'); pg.dataset.panel = 'title'; pg.hidden = true;
    const gl = el('div', 'ed-glist static'); gl.id = 'edTitleList';
    const ga = el('div', 'ed-pfoot');
    const gb = el('button', 'ed-btn primary'); gb.type = 'button'; gb.id = 'edTitleAdd'; gb.textContent = '在播放頭新增';
    gb.title = '在播放頭的位置新增選取樣式的字幕（放在最上層沒被佔用的影片軌）';
    gb.addEventListener('click', () => UI.addTitle(lib.title));
    ga.append(gb, el('span', 'ed-hint', '字幕放在影片軌上，新增後在右側詳細內容改文字、字型、顏色。也可以把過場拖到時間軸。'));
    const sl = el('div', 'ed-glist static'); sl.id = 'edTStyleList';
    const sa = el('div', 'ed-pfoot');
    const sb = el('button', 'ed-btn primary'); sb.type = 'button'; sb.id = 'edTStyleApply'; sb.textContent = '套用到選取的字幕';
    sb.title = '把選取的字幕樣式套用到時間軸上選取的字幕片段';
    sb.addEventListener('click', () => UI.applyTitleStyle(lib.tstyle));
    sa.append(sb, el('span', 'ed-hint', '顏色、描邊、外框、立體一次換好（不動文字與位置）。新增字幕也會用選取的樣式；可以把樣式拖到時間軸的字幕片段上。'));
    const ca = el('div', 'ed-pfoot');
    const cb = el('button', 'ed-btn'); cb.type = 'button'; cb.id = 'edSrtImport'; cb.textContent = '匯入 SRT';
    cb.title = '匯入 SRT 字幕檔：每一段變成「字幕」軌上的一個字幕片段';
    const ci = el('input'); ci.type = 'file'; ci.id = 'edSrtFile'; ci.accept = '.srt,application/x-subrip,text/plain'; ci.hidden = true; ci.tabIndex = -1;
    ci.addEventListener('change', () => { const f = ci.files && ci.files[0]; ci.value = ''; if (f) UI.importSrt(f); });
    cb.addEventListener('click', () => ci.click());
    const ce = el('button', 'ed-btn'); ce.type = 'button'; ce.id = 'edSrtExport'; ce.textContent = '匯出 SRT';
    ce.title = '把「字幕」軌的字幕存成 SRT 檔（沒有字幕清單時，改匯出時間軸上所有有文字的字幕）';
    ce.addEventListener('click', () => UI.exportSrt());
    const cm = el('button', 'ed-btn'); cm.type = 'button'; cm.textContent = '在播放頭標記（V）';
    cm.title = '在播放頭加一段字幕（快捷鍵 V），之後在右側詳細內容的「字幕清單」輸入文字';
    cm.addEventListener('click', () => UI.markSubtitle());
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
    UI.updateSubMark();
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
      wireThumbPlay(it, cv, f => paintTransThumb(cv, type, f == null ? null : f / 44));
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'transition', id: type }, def.name, () => { lib.trans = type; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.trans = type; markGallery(); UI.addTransitionToSelection(type); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.trans = type; markGallery(); UI.addTransitionToSelection(type); } });
    }
    for (const [preset, def] of Object.entries(F.TITLE_PRESETS || {})) {
      const it = el('div', 'ed-gitem'); it.dataset.title = preset; it.tabIndex = 0; it.title = `${def.name}：拖到時間軸，或選取後按「在播放頭新增」`;
      const cv = el('canvas'); cv.width = 192; cv.height = 108;
      it.append(cv, el('span', 'ed-gname', def.name));
      gl.appendChild(it);
      paintTitleThumb(cv, preset);
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'title', id: preset }, def.name, () => { lib.title = preset; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.title = preset; markGallery(); UI.addTitle(preset); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.title = preset; markGallery(); UI.addTitle(preset); } });
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
      it.addEventListener('dblclick', () => { lib.textFx = kind; markGallery(); UI.applyTextFx(kind); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.textFx = kind; markGallery(); UI.applyTextFx(kind); } });
    }
    for (const [key, def] of Object.entries(F.TITLE_STYLES || {})) {
      const it = el('div', 'ed-gitem'); it.dataset.tstyle = key; it.tabIndex = 0; it.title = `${def.name}：拖到時間軸的字幕片段，或選取字幕後按「套用到選取的字幕」`;
      const cv = el('canvas'); cv.width = 192; cv.height = 108;
      it.append(cv, el('span', 'ed-gname', def.name));
      sl.appendChild(it);
      paintStyleThumb(cv, key);
      it.addEventListener('pointerdown', e => libPointerDown(e, { kind: 'tstyle', id: key }, def.name, () => { lib.tstyle = key; markGallery(); }));
      it.addEventListener('dblclick', () => { lib.tstyle = key; markGallery(); UI.applyTitleStyle(key); });
      it.addEventListener('keydown', e => { if (e.key === 'Enter') { lib.tstyle = key; markGallery(); UI.applyTitleStyle(key); } });
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
  // t：轉場進度（null＝停在該轉場的預設畫面 thumbT，閃光停在最亮前一點、甩鏡停在模糊最明顯處）
  function paintTransThumb(cv, type, t) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const side = (c0, c1, label) => c => {
      const gr = c.createLinearGradient(0, 0, W, H); gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      c.fillStyle = gr; c.fillRect(0, 0, W, H);
      c.fillStyle = 'rgba(255,255,255,.9)'; c.font = `bold ${Math.round(H * 0.55)}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, W / 2, H / 2 + 2);
    };
    g.clearRect(0, 0, W, H);
    const def = F.TRANSITIONS[type] || {};
    const at = t == null ? (def.thumbT || 0.5) : t;
    const color = C.transitionColor ? C.transitionColor(type) : '#000000';
    try { def.draw(g, side('#4f86d6', '#1d3f87', 'A'), side('#f59e0b', '#b45309', 'B'), at, { type, direction: 'left', color, ease: 'linear', align: 'center' }, W, H); } catch (_) { side('#4f86d6', '#1d3f87', 'A')(g); }
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
    return { kind: m.kind, duration: m.kind === 'image' ? null : m.duration, hasAudio: !!m.hasAudio, width: m.width, height: m.height, fps: m.fps, name: m.name,
      size: m.file ? m.file.size : null, lastModified: m.file ? m.file.lastModified : null };
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
  // handles[i]：files[i] 的 FileSystemFileHandle（從檔案挑選器或拖放拿到的；沒有就 null），存起來下次開專案可以自動接回素材
  // 選檔：Chrome／Edge 用 showOpenFilePicker（同時拿到 FileSystemFileHandle，下次開專案可以一鍵接回素材）；其他瀏覽器或失敗時用 <input type=file>
  const PICK_TYPES = [{ description: '影片、音訊、圖片、字幕', accept: {
    'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv'], 'audio/*': ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac', '.aac'],
    'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'], 'text/plain': ['.srt'] } }];
  async function pickFiles(input) {
    if (typeof root.showOpenFilePicker !== 'function') { input.click(); return; }
    let hs;
    try { hs = await root.showOpenFilePicker({ multiple: true, types: PICK_TYPES }); } catch (e) { if (!e || e.name !== 'AbortError') input.click(); return; }
    const files = [];
    for (const h of hs) { try { files.push(await h.getFile()); } catch (_) { files.push(null); } }
    const keep = files.map((f, i) => i).filter(i => files[i]);
    importFiles(keep.map(i => files[i]), keep.map(i => hs[i]));
  }
  function importFiles(files, handles) {
    files = [...(files || [])];
    handles = files.map((f, i) => (handles && handles[i]) || null);
    const proj = files.findIndex(f => /\.qcut$/i.test(f.name || ''));
    if (proj >= 0 && Q.project && Q.project.openFile) {
      Q.project.openFile(files[proj]);
      const keep = files.map((f, i) => i).filter(i => !/\.qcut$/i.test(files[i].name || ''));
      files = keep.map(i => files[i]); handles = keep.map(i => handles[i]);
    }
    const srt = files.map((f, i) => i).filter(i => UI.isSrtFile(files[i]));
    if (srt.length) {
      srt.map(i => files[i]).reduce((pr, f) => pr.then(() => UI.importSrt(f)), Promise.resolve());
      const keep = files.map((f, i) => i).filter(i => !UI.isSrtFile(files[i]));
      files = keep.map(i => files[i]); handles = keep.map(i => handles[i]);
    }
    if (!files.length) return importChain;
    importChain = importChain.then(() => doImport(files, handles), () => doImport(files, handles));
    return importChain;
  }
  async function doImport(files, handles) {
    state.importing = true;
    setBusy(true);
    const errors = [], warns = [];
    let added = [];
    try {
      // 開啟專案後還缺的素材：檔名（＋大小）對得上就沿用存檔裡的 id，時間軸上的片段直接接回來
      const P = Q.project, ids = P && P.claim ? P.claim(files) : [];
      const ok = await R.media.import(files, { ids, handles, onProgress: (i, n, name) => say(`匯入中 ${i}／${n}：${name}`) });
      for (const e of ok.errors || []) errors.push(e);
      for (const m of ok) {
        const r = C.registerMediaInfo(state.project, m.id, mediaInfoOf(m));
        if (!r.ok) { errors.push({ name: m.name, message: r.reason }); R.media.remove(m.id); continue; }
        added.push(m);
        if (r.fpsSet) warns.push({ name: m.name, message: `專案影格率已設為 ${r.fps} fps（依第一支影片）`, info: true });
      }
      if (added.length) state.selMedia = added[added.length - 1].id;
      if (P && P.afterImport) for (const w of P.afterImport(added)) warns.push(w);
    } catch (e) {
      errors.push({ name: '匯入', message: (e && e.message) || String(e) });
    }
    state.importing = false;
    setBusy(false);
    showMsgs(errors, warns);
    const relinked = added.filter(m => m.relinked).length;
    if (added.length) say(relinked ? `已重新連結 ${relinked} 個素材${added.length > relinked ? `，另外匯入 ${added.length - relinked} 個` : ''}` : `已匯入 ${added.length} 個素材`, 'ok');
    else if (errors.length) say(errors[0].message, 'error'); else say('');
    renderMedia();
    UI.syncAspect();
    if (UI.placeImported) UI.placeImported(added);     // 簡易模式：自動排到時間軸
    if (UI.player) UI.player.refresh();
    UI.scheduleRender();
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
      const lost = Q.project && Q.project.missing ? Q.project.missing().length : 0;
      host.appendChild(el('div', 'ed-mempty', lost ? '素材重新連結後會出現在這裡。' : '還沒有素材。把影片、音訊或圖片拖進來，雙擊在檢視器預覽，再放上時間軸。'));
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
      it.addEventListener('dblclick', () => UI.openSource(m.id));
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
          const h = Math.max(1, UI.waveAmp(mx) * H * 0.9);
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
    if (state.sourceMedia === id) UI.closeSource();
    if (state.sourceInOut && state.sourceInOut.mediaId === id) state.sourceInOut = null;
    if (state.selMedia === id) state.selMedia = null;
    R.media.remove(id);
    renderMedia();
    say(`已移除「${m.name}」`, 'ok');
  }

  // ---- 從媒體庫拖到時間軸（自己用 pointer 事件做，不靠瀏覽器的拖放：測得到、也不會被拖影像干擾）-------------
  UI.libDrag = null;
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
        UI.libDrag = payload;
        app.classList.add('dragging-lib');
      }
      ghost.style.left = (ev.clientX + 12) + 'px';
      ghost.style.top = (ev.clientY + 8) + 'px';
      UI.tlShowDrop(payload, ev);
    };
    const end = ev => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', end);
      root.removeEventListener('pointercancel', end);
      if (ghost) ghost.remove();
      app.classList.remove('dragging-lib');
      UI.libDrag = null;
      UI.tlShowDrop(null);
      if (!moved) { if (onClick) onClick(); return; }
      if (ev.type === 'pointerup') UI.tlDrop(payload, ev);
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
      // getAsFileSystemHandle 要在 drop 事件裡同步呼叫（之後 dataTransfer 就清空了）
      const files = [...e.dataTransfer.files];
      const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file');
      const hp = items.map(i => (typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
      Promise.all(hp).then(hs => importFiles(files, hs.length === files.length ? hs.map(h => (h && h.kind === 'file' ? h : null)) : null));
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

  Object.assign(UI, {
    buildMediaPanel, ensureMediaInfo, importFiles, lib, markMediaSel, mediaInfoOf, renderMedia, showMsgs, wireFileDrop,
  });
})(typeof window !== 'undefined' ? window : globalThis);
