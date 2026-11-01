// =====================================================================================
// 剪輯介面：詳細內容
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
// 右側「詳細內容」：專案資訊、片段資訊、變形／裁切、音訊（EQ）、速度、字幕清單。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;                     // 頁面上沒有剪輯介面
  const { $, EQ_TYPES, KIND_NAME, MARKER_HEX, MARKER_NAME, MOD, TRANS_SIDE_TEXT, app, clamp, clipOf, clipTitle, doc,
    el, exportSrt, fmtNum, isSubClip, isTextTarget, lastSel, live, mediaOf, op, openFlagPop, refreshSelectionUI, say,
    scheduleRender, seekTimeline, selIds, selectClips, state, subClips, tc, trackOf } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

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
      const r = C.setClipPropsAt(state.project, ids, patch, state.playhead);
      if (!r.ok) say(r.reason, 'error');
      if (UI.player) UI.player.refresh();
      scheduleRender('tl');
      return;
    }
    if (propsLive) {
      propsLive = false;
      const r = C.setClipPropsAt(state.project, ids, patch, state.playhead);
      if (!r.ok) say(r.reason, 'error');
      state.history.end();
      return;
    }
    op(label || '調整屬性', p => C.setClipPropsAt(p, ids, patch, state.playhead));
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
      if (UI.player) UI.player.refresh();
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

  // 詳細內容的關鍵影格操作（edit-fx 的 ◇ 按鈕、工具列、一鍵動畫會呼叫）。f 一律是「播放頭在片段內第幾格」。
  // ---- LUT（4.50）：選 .cube 檔 → 解析 → 存進專案，套到選取的影片／圖片片段（一筆復原）----
  function lutTargets(clip) {
    const ids = selIds().filter(id => { const k = clipOf(id); return k && k.video && k.type === 'media'; });
    return ids.length ? ids : clip ? [clip.id] : [];
  }
  function loadLut(clip) {
    const inp = el('input'); inp.type = 'file'; inp.accept = '.cube'; inp.hidden = true; inp.id = 'edLutFile';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (f) await applyLutFile(f, lutTargets(clip));
    });
    doc.body.appendChild(inp);
    inp.click();
  }
  async function applyLutFile(file, ids) {
    let text;
    try { text = await file.text(); } catch (_) { say('讀不到 LUT 檔', 'error'); return null; }
    const lut = C.parseCube(text, file.name);
    if (!lut.ok) { say(lut.reason, 'error'); return lut; }
    return op('套用 LUT', p => {
      const a = C.addLut(p, lut);
      if (!a.ok) return a;
      return ids.length ? C.setClipProps(p, ids, { video: { lut: a.id, lutAmt: 100 } }) : a;
    }, `已套用 LUT「${lut.name}」${ids.length > 1 ? `到 ${ids.length} 個片段` : ''}`);
  }
  function removeLut(id) {
    const r = state.project.luts && state.project.luts[id];
    if (!r) return;
    op('移除 LUT', p => C.removeLut(p, id), `已從專案移除 LUT「${r.name}」（用到它的片段改回無）`);
  }
  UI.applyLutFile = applyLutFile;

  function kfCtx(c) {
    const f = state.playhead - c.start;
    const inRange = state.mode === 'timeline' && f >= 0 && f < c.duration;
    const valueAt = (clip, path) => { const v = F.getParam(clip, path, Math.max(0, f)); return v == null ? 0 : v; };
    const need = () => { if (!inRange) { say('先把播放頭移到這個片段上', 'error'); return false; } return true; };
    return {
      f, inRange,
      luts: state.project.luts || {},
      loadLut, removeLut,
      kf: {
        // ◇：這格有關鍵影格就刪掉，沒有就用目前看到的值新增
        toggle(paths, clip) {
          if (!need()) return;
          const here = paths.some(x => ((clip.keyframes || {})[x] || []).some(e => e.f === f));
          if (here) op('刪除關鍵影格', p => C.removeKeyframe(p, clip.id, f, paths));
          else op('加關鍵影格', p => C.setKeyframe(p, clip.id, f, Object.fromEntries(paths.map(x => [x, valueAt(clip, x)]))));
        },
        seek(fIn, clip) { seekTimeline(clip.start + fIn); scheduleRender('insp'); },
        interp(v, clip) { if (need()) op('關鍵影格走法', p => C.setKeyframeInterp(p, clip.id, f, v)); },
        clear(clip) { op('清除關鍵影格', p => C.clearKeyframes(p, clip.id, null, Math.max(0, Math.min(clip.duration - 1, f)))); },
        // 多選時一次套到所有選取的畫面片段（做照片輪播很方便）
        preset(kind, clip) {
          const ids = selIds().filter(id => { const k = clipOf(id); return k && k.video; });
          const list = ids.length ? ids : [clip.id];
          op('一鍵動畫', p => {
            for (const id of list) { const r = C.applyKeyframePreset(p, id, kind); if (!r.ok) return r; }
            return { ok: true };
          }, list.length > 1 ? `已替 ${list.length} 個片段加上動畫，按空白鍵播放看看` : '已加上動畫，按空白鍵播放看看');
        },
        reset(prefix, patch, clip) {
          const ids = selIds().filter(id => { const k = clipOf(id); return k && k.video; });
          op('重設', p => {
            for (const id of ids) {
              const k = p.clips[id], paths = Object.keys(k.keyframes || {}).filter(x => x.startsWith(prefix));
              if (paths.length) { const r = C.clearKeyframes(p, id, paths, 0); if (!r.ok) return r; }
            }
            return C.setClipProps(p, ids.length ? ids : [clip.id], patch);
          });
        },
      },
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
    // 電影黑邊（專案層級，整支影片一起；core.setLetterbox，一筆復原）
    const lbT = el('dt'), lbD = el('dd');
    const lbL = el('label', null, '電影黑邊'); lbL.htmlFor = 'edLetterbox'; lbT.appendChild(lbL);
    const lb = el('select'); lb.id = 'edLetterbox';
    lb.title = '加黑邊做出電影畫幅：寬銀幕是上下黑邊；Open Gate（3:2）放在 16:9 裡是左右黑邊（蓋在影片上、字幕下面，預覽和匯出一樣）';
    for (const [v, t] of [['none', '不加'], ['2.39', '2.39：1 寬銀幕'], ['2.00', '2：1'], ['1.85', '1.85：1 遮幅'], ['1.50', 'Open Gate（3:2）']]) { const o = el('option', null, t); o.value = v; lb.appendChild(o); }
    lb.addEventListener('change', () => {
      const v = lb.value;
      const r = op('電影黑邊', p => C.setLetterbox(p, v), v === 'none' ? '已拿掉電影黑邊' : (v === '1.50' ? '已加上 Open Gate（3:2）黑邊' : `已加上 ${v}：1 電影黑邊`));
      if (!r.ok) lb.value = state.project.letterbox || 'none';
    });
    lbD.appendChild(lb); dl.append(lbT, lbD);
    insp.letterbox = lb;
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
    if (insp.letterbox) insp.letterbox.value = p.letterbox || 'none';
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
    // 多選（例如點軌道標頭選了整條軌）：標題寫出選了幾個，每個分頁都看得到改數值會套用到全部
    const head = $('edInspHead');
    head.textContent = n > 1 ? `詳細內容　已選取 ${n} 個片段（顯示：${clipTitle(c)}）` : `詳細內容　${clipTitle(c)}`;
    head.title = n > 1 ? `修改數值會套用到全部 ${n} 個選取的片段` : '';
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
    const ramp = !!(c.retime && !c.reverse);
    for (const r of insp.speedRows) r.input.disabled = frozen;
    insp.speedRows[1].input.disabled = frozen || ramp;           // 曲線變速不能倒播
    insp.speedNote.textContent = frozen ? '這是定格片段，不能變速。'
      : ramp ? `曲線變速中（「速度」是整段的平均，改它會讓整條曲線一起變快變慢）。按 ${MOD}R 換曲線或取消。`
      : '按 ' + MOD + 'R 開啟變速對話框，也可以套用平滑的曲線變速（慢動作、子彈時間）。';
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
    return { kind, pages: [['xform', '變形', fx('transform')], ['color', '色彩', fx('color')], ['crop', '裁切', fx('crop')], ['audio', '音訊', [audio]], ['speed', '速度', [speed]], ['info', '資訊', [insp.info]]] };
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
    if (UI.renderQuick && UI.renderQuick(insp)) return;     // 簡易模式：影片／圖片／音訊片段、字幕片段改顯示「快速調整」
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
      if (s.def) s.def.render(s.ui.body, c, commitFor(s.def), kfCtx(c));
      else if (s === insp.audio) updateAudioSection();
      else if (s === insp.speed) updateSpeedSection(speedClip());
      else if (s === insp.subs) updateSubsSection();
    }
  }

  Object.assign(UI, {
    buildInspector, insp, kfCtx, loadTabOf, primaryClip, renderInspector,
  });
})(typeof window !== 'undefined' ? window : globalThis);
