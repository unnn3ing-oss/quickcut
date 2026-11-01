// =====================================================================================
// 剪輯介面：檢視器
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
// 來源／時間軸檢視器、播放控制、時間碼、輸出比例、直式版面、預覽框（變形與字幕拖曳）、安全框。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;                     // 頁面上沒有剪輯介面
  const { $, COLS_KEY, SAFE_KEY, SPEEDS, THEME_KEY, VERT_H_KEY, VERT_KEY, app, clamp, doc, el, fmtSec, icon, lastSel,
    lsSet, markMediaSel, mediaInfoOf, mediaOf, readColors, renderMedia, report, say, state, tc } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

  // =====================================================================================
  // 檢視器：來源／時間軸、播放控制、時間碼、輸出比例、匯出
  // =====================================================================================
  const viewProject = () => (state.mode === 'source' && UI.srcProject ? UI.srcProject : state.project);
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
    for (const [v, t] of [['source', '依來源'], ['9:16', '9:16 直式'], ['16:9', '16:9 橫式'], ['4:5', '4:5'], ['1:1', '1:1 方形']]) { const o = el('option', null, t); o.value = v; sel.appendChild(o); }
    sel.addEventListener('change', () => {
      const v = sel.value;
      const r = state.history.run('輸出比例', p => C.setAspect(p, v));
      if (!report(r)) syncAspect();
      else { say(`輸出比例 ${aspectText()}`, 'ok'); offerFitAll(sel); }
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
    // 「匯出影片」按鈕在頁首（index.html 的 #edExportBtn，「儲存專案」右邊），這裡只接上點擊
    const ex = $('edExportBtn');
    if (ex) ex.addEventListener('click', openExport);
    bar.append(seg, name, sp, aspLab, vb, sb, dims);
    wireStage();

    // 拖曳條
    const sw = $('edScrubWrap');
    sw.textContent = '';
    const scrub = el('div', 'ed-scrub');
    const io = el('div', 'ed-scrub-io'); io.id = 'edScrubIO';
    const rg = el('input'); rg.type = 'range'; rg.id = 'edScrub'; rg.min = 0; rg.max = 1; rg.step = 1; rg.value = 0; rg.setAttribute('aria-label', '播放位置');
    rg.addEventListener('input', () => { if (state.mode === 'timeline') seekTimeline(+rg.value); else UI.player && UI.player.seek(+rg.value); });
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
    const vm = mk('edSubMark', null, '字幕標記（V）：在播放頭加一段字幕，右側詳細內容會多一行可以輸入文字', () => UI.markSubtitle(), 'V');
    vm.classList.add('ed-submark'); vm.hidden = true;
    tr.append(group, jkl, vm, time);

    const empty = $('edEmpty');
    empty.innerHTML = '<div class="ed-empty-box"><strong>把影片、音訊或圖片拖進來開始剪輯</strong><span>拖到左側「媒體」，或直接拖到這裡；也可以按下面的按鈕選檔案。<br><em class="ed-pro-only">雙擊素材先預覽，再按 F10（覆蓋）、F9（插入）或「加到結尾」放上時間軸。</em><em class="ed-simple-only">加進來的影片、照片會自動依序排到時間軸，音樂放到「音樂」軌。</em></span></div>';
    const eb = el('button', 'ed-btn primary', '選擇檔案'); eb.type = 'button';
    eb.addEventListener('click', () => $('edFile').click());
    empty.firstChild.appendChild(eb);
  }

  function openExport() {
    if (!Q.exporter || typeof Q.exporter.open !== 'function') { say('匯出模組還沒載入完成，請重新整理頁面再試', 'error'); return; }
    if (UI.player) UI.player.pause();
    if (!C.projectDuration(state.project)) { say('時間軸上還沒有內容可以匯出', 'error'); return; }
    Q.exporter.open();
  }

  const aspectText = () => { const p = state.project; return `${p.width}×${p.height}`; };

  // ---- 一鍵比例轉換：換了輸出比例後，有素材比例不合（會出現大片黑邊）就問要怎麼放進新畫面 ------------
  // 套用到所有影片軌上的影片／圖片片段（C.setFitAll，整批一次復原）；「保持黑邊」＝不改。
  const FIT_CHOICES = [
    ['blur', '模糊背景', '完整顯示，空白處用同一個畫面的模糊放大補滿（短影音最常見）'],
    ['fill', '填滿裁切', '放大蓋滿整個畫面，多出來的部分裁掉；可以在預覽上拖曳調整要留哪一塊'],
    ['fit', '保持黑邊', '不改，完整顯示並留黑邊'],
  ];
  function offerFitAll(anchor) {
    const p = state.project;
    const mm = C.aspectMismatch ? C.aspectMismatch(p) : { count: 0 };
    if (!mm.count) return;
    const ratio = p.aspect === 'source' ? aspectText() : p.aspect;
    const box = el('div', 'ed-form');
    box.id = 'edFitPop';
    box.append(el('div', 'ed-form-h', `有 ${mm.count} 段素材的比例和 ${ratio} 不同`));
    box.append(el('div', 'ed-hint', '要怎麼放進新的畫面？會套用到時間軸上所有影片和圖片片段，之後也可以在「詳細內容 → 畫面符合」逐段調整。'));
    const list = el('div', 'ed-fitopts');
    for (const [fit, label, desc] of FIT_CHOICES) {
      const b = el('button', 'ed-fitopt' + (fit === 'blur' ? ' rec' : '')); b.type = 'button'; b.dataset.fit = fit;
      b.append(el('strong', null, label + (fit === 'blur' ? '（推薦）' : '')), el('span', null, desc));
      b.addEventListener('click', () => {
        UI.closePop();
        if (fit === 'fit') return;
        UI.op('畫面符合', q => C.setFitAll(q, fit), `已把所有影片和圖片片段改成「${label}」`);
      });
      list.appendChild(b);
    }
    box.appendChild(list);
    UI.openPop(anchor, box, 'fit');
    const first = list.querySelector('button');
    if (first) first.focus();
  }
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
    UI.scheduleRender('tl');
    if (UI.player && !UI.player.playing) UI.player.refresh();
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
        UI.scheduleRender('tl'); scheduleStage();
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
          app.classList.remove('resizing', 'colresize'); saveCols(); UI.scheduleRender('tl');
          if (UI.player && !UI.player.playing) UI.player.refresh();
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
  // 播放頭那一格看到的變形值（有關鍵影格時是內插後的值）
  const tfOf = (c, k, d) => { const v = F.getParam(c, 'video.transform.' + k, Math.max(0, state.playhead - c.start)); return Number.isFinite(+v) && v !== undefined && v !== null ? +v : d; };
  function wireStage() {
    const st = $('edStage');
    if (!st || $('edOverlay')) return;
    const ov = el('div', 'ed-overlay'); ov.id = 'edOverlay'; ov.hidden = true;
    ov.innerHTML = SAFE_SVG + `<svg class="ed-gizmo" id="edGizmo" hidden aria-hidden="true">
      <polygon class="ed-gz-box"/><polyline class="ed-gz-stem"/><circle class="ed-gz-rot" r="${GZ.rotR}"/>
      ${`<circle class="ed-gz-corner" r="${GZ.corner / 1.4}"/>`.repeat(4)}</svg>`;
    st.appendChild(ov);
    const cv = $('edCanvas');
    cv.addEventListener('pointermove', e => { if (!UI.drag) { const h = stageHit(e); cv.style.cursor = h ? HIT_CURSOR[h.kind] : ''; } });
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || UI.drag) return;
      const h = stageHit(e);
      if (!h) return;
      e.preventDefault();
      if (UI.player) UI.player.pause();
      const clip = h.t.clip, id = clip.id;
      if (!state.selection.has(id) || state.selection.size > 1) UI.selectClips([id]);
      const W = h.r.W, H = h.r.H, s = h.r.s;
      if (h.kind === 'move' && clip.type === 'title') return dragTitle(e, clip, W, H, s);
      const z0x = tfOf(clip, 'zoomX', 1), linked = !(clip.video.transform && clip.video.transform.zoomLinked === false);
      const z0y = linked ? z0x : tfOf(clip, 'zoomY', 1);
      const px0 = tfOf(clip, 'posX', 0), py0 = tfOf(clip, 'posY', 0), rot0 = tfOf(clip, 'rotation', 0);
      const pv = [h.t.q.pivot[0] * s, h.t.q.pivot[1] * s];   // 樞紐（螢幕像素，overlay 座標）
      const cx0 = h.t.q.pts.reduce((a, p) => a + p[0], 0) / 4, cy0 = h.t.q.pts.reduce((a, p) => a + p[1], 0) / 4;
      const LABEL = { move: '移動素材', scale: '縮放素材', rotate: '旋轉素材' };
      const apply = tf => {
        const r = UI.live.run(LABEL[h.kind], q => C.setClipPropsAt(q, id, { video: { transform: tf } }, state.playhead));
        if (r && !r.ok) say(r.reason, 'error');
        scheduleStage();
      };
      let last = '';
      UI.beginDrag(e, {
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
          UI.live.end();
          say(`${last}（${h.kind === 'move' ? 'Alt＝不吸附到中線' : h.kind === 'rotate' ? 'Shift＝每 15° 一格' : '按住角點等比縮放'}）`, 'ok');
        },
        cancel() { UI.live.abort(); scheduleStage(); },
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
    UI.beginDrag(e, {
      move(ev, dx, dy) {
        const ox = dx / s, oy = dy / s;
        const ux = (m[3] * ox - m[2] * oy) / det, uy = (-m[1] * ox + m[0] * oy) / det;
        let x = clamp(x0 + ux / W, -0.5, 1.5), y = clamp(y0 + uy / H, -0.5, 1.5);
        if (!ev.altKey) { x = snap(x, W * s); y = snap(y, H * s); }
        const r = UI.live.run('移動字幕', q => C.setClipProps(q, id, { title: { x, y } }));
        if (r && !r.ok) say(r.reason, 'error');
        scheduleStage();
      },
      up(ev, moved) { if (moved) { UI.live.end(); say('已移動字幕（Alt＝不吸附到中線）', 'ok'); } },
      cancel() { UI.live.abort(); scheduleStage(); },
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
    if (readColors()) { UI.dirty.tl = UI.dirty.media = UI.dirty.insp = true; UI.scheduleRender(); UI.schedulePaint(); }
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
    if (UI.player) UI.player.pause();
    if (state.sourceInOut && state.sourceInOut.mediaId !== id) state.sourceInOut = null;
    state.sourceMedia = id; state.selMedia = id;
    UI.srcProject = p; state.srcFrame = 0;
    markMediaSel();
    setMode('source', true);
  }
  function closeSource() {
    state.sourceMedia = null; UI.srcProject = null;
    if (state.mode === 'source') setMode('timeline', true);
    markMediaSel();
  }

  function setMode(mode, force) {
    if (!UI.player) return;
    if (mode === state.mode && !force) return;
    if (mode === 'source' && !UI.srcProject) return;
    UI.player.pause();
    state.mode = mode;
    UI.player.refresh();
    UI.player.seek(mode === 'timeline' ? state.playhead : state.srcFrame);
    renderViewerChrome();
    markMediaSel();
    UI.updatePlayheadPos(false);
    scheduleStage();
  }

  function setSourceIO(which) {
    if (state.mode !== 'source' || !UI.srcProject) { say('在來源檢視器裡才能設定來源的 In／Out（雙擊媒體庫的素材）', 'error'); return; }
    const m = mediaOf(state.sourceMedia);
    if (!m) return;
    const sf = UI.srcProject.fps, f = state.srcFrame;
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
    if (!b || !UI.player) return;
    const on = UI.player.playing;
    b.replaceChildren(icon(on ? 'pause' : 'play'));
    b.classList.toggle('active', on);
    b.title = on ? '暫停（空白鍵）' : '播放（空白鍵）';
  }

  function onPlayerFrame(f) {
    if (state.mode === 'timeline') state.playhead = f; else state.srcFrame = f;
    updateTransportTime();
    if (state.mode === 'timeline') UI.updatePlayheadPos(UI.player && UI.player.playing);
    scheduleStage();
    // 詳細內容的數值、◇ 狀態跟著播放頭：停下來時一律更新；播放中只有選取的片段有關鍵影格才更新
    if (state.mode === 'timeline' && UI.primaryClip) {
      const c = UI.primaryClip();
      if (c && c.video && (!(UI.player && UI.player.playing) || (c.keyframes && Object.keys(c.keyframes).length))) UI.scheduleRender('insp');
    }
  }

  // ---- 播放與移動播放頭 ------------------------------------------------------------
  function togglePlay() { if (UI.player) { UI.player.toggle(); } }
  function shuttle(dir) {
    if (!UI.player) return;
    const r = UI.player.rate;
    if (dir === 0) { UI.player.shuttle(0); return; }
    if (dir > 0) UI.player.shuttle(r > 0 ? SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(r)) + 1)] : 1);
    else UI.player.shuttle(r < 0 ? -SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(-r)) + 1)] : -1);
  }
  function step(n) { if (UI.player) UI.player.stepFrames(n); }
  // 回到時間軸模式並移到某格
  function seekTimeline(f) {
    f = Math.max(0, Math.round(f));
    if (state.mode !== 'timeline') { state.playhead = f; setMode('timeline'); return; }
    state.playhead = f;
    if (UI.player) UI.player.seek(f);
  }
  function seekView(f) {
    if (state.mode === 'timeline') seekTimeline(f); else if (UI.player) UI.player.seek(Math.max(0, f));
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

  Object.assign(UI, {
    applyTheme, applyVertical, buildViewer, clearSourceIO, closeSource, fitVertical, jumpEdit, onPlayerFrame,
    openSource, renderViewerChrome, scheduleStage, seekTimeline, seekView, setMode, setSourceIO, shuttle, step,
    syncAspect, syncThemeBtn, themeRepaint, togglePlay, updatePlayButton, viewDuration, viewProject, wireColSplitters,
  });
})(typeof window !== 'undefined' ? window : globalThis);
