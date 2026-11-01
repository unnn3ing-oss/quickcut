// =====================================================================================
// 剪輯介面：編輯動作、工具列與快捷鍵
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
// 選取、編輯動作（刀片、刪除、插入／覆蓋…）、變速／定格、工具列、快捷鍵。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;                     // 頁面上沒有剪輯介面
  const { $, MARKER_HEX, MARKER_NAME, app, clearSourceIO, clipOf, clipTitle, closeMenu, closePop, doc, el,
    ensureMediaInfo, fitPop, fmtNum, fps, isSubClip, isTextTarget, jumpEdit, lastSel, lib, mediaOf, openPop, report, say,
    seekTimeline, seekView, selIds, setSourceIO, shuttle, state, step, targetTrack, tc, togglePlay,
    videoTracksTopFirst, viewDuration } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

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
    UI.refreshSelectionUI();
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
      UI.refreshSelectionUI();
    } else if (!state.selection.has(id)) selectClips(ids);
    else { state.selTransition = null; UI.refreshSelectionUI(); }
  }
  function selectTransition(id) {
    state.selTransition = id; state.selection = new Set();
    UI.refreshSelectionUI();
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
    if (mode === 'replace' && state.mode === 'source' && state.sourceMedia === id && UI.srcProject) o.sourceTime = state.srcFrame / UI.srcProject.fps;
    const r = op(EDIT_LABEL[mode], p => C.editToTimeline(p, o));
    if (r && r.ok) {
      selectClips(r.ids);
      if (mode === 'insert' || mode === 'overwrite') seekTimeline(r.end); else if (mode === 'append') seekTimeline(r.start);
      UI.afterRender(() => UI.revealFrame(r.start, r.end));
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
    if (r && r.ok) { state.selection = new Set(); UI.refreshSelectionUI(); }
  }

  // 清除空隙：整條軌的空白一次收掉（沒指定軌道就用選取片段所在的軌，沒選取就用第一條影像軌）
  function closeGaps(trackId) {
    const p = state.project;
    if (!trackId) { const id = lastSel(); trackId = id ? p.clips[id].trackId : (C.tracksOf(p, 'video')[0] || {}).id; }
    const t = C.getTrack(p, trackId);
    const r = op('清除空隙', q => C.closeAllGaps(q, trackId));
    if (r && r.ok) say(`已清除「${t ? (UI.trackLabel ? UI.trackLabel(t) : t.name) : ''}」軌 ${r.closed} 個空隙（共 ${tc(r.frames, fps())}）` + (r.skipped ? `；${r.skipped} 個被其他軌的片段擋住沒收` : ''), r.skipped ? 'error' : 'ok');
    return r;
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
    // 打拍子模式：播放中按 M 直接加一個節拍標記（不開小視窗、不加片段標記）
    if (state.beatTap && state.mode === 'timeline' && UI.player && UI.player.playing) {
      const r = state.history.run('打拍子', p => C.addBeatMarkers(p, [f], { replace: false }));
      if (r && r.ok) say(`節拍 ${C.beatFrames(state.project).length}`);
      return;
    }
    const c = selIds().map(clipOf).find(x => x && x.start <= f && f < C.clipEnd(x));
    if (c) {
      const had = c.markers.find(m => m.offset === f - c.start);
      if (had) { openMarkerPop('clip', had.id, c.id); return; }
      const r = op('加片段標記', p => C.addClipMarker(p, c.id, { frame: f }));
      if (r && r.ok) UI.afterRender(() => openMarkerPop('clip', r.id, c.id));
      return;
    }
    const had = state.project.markers.find(m => m.frame === f);
    if (had) { openMarkerPop('timeline', had.id); return; }
    const r = op('加標記', p => C.addMarker(p, { frame: f }));
    if (r && r.ok) UI.afterRender(() => openMarkerPop('timeline', r.id));
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
  // 曲線變速的預設（順序就是對話框裡的順序）；名字和說明給初學者看
  const RETIME_UI = [
    ['slowMid', '中段慢動作', '前後正常，中間放慢到 30%'],
    ['bullet', '子彈時間', '快 → 極慢 → 快，動作片、運動精華'],
    ['speedUp', '漸漸加速', '從 50% 慢慢加速到 250%'],
    ['slowDown', '漸漸減速', '從 250% 慢慢減速到 50%'],
    ['flashIn', '快速切入', '開頭 400% 衝進來再回到正常'],
    ['flashOut', '快速切出', '結尾加速到 400% 離開'],
  ];
  // 速度曲線的小圖：橫軸是片段時間，縱軸是速度（對數刻度，中間的虛線是 100%）
  function retimeSvg(preset, strength) {
    const NS = 'http://www.w3.org/2000/svg', W = 64, H = 26;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'ed-rt-svg'); svg.setAttribute('aria-hidden', 'true');
    const y = s => H / 2 - Math.max(-2.2, Math.min(2.2, Math.log2(s))) * (H / 2 - 2) / 2.2;
    const mid = doc.createElementNS(NS, 'line');
    mid.setAttribute('x1', 0); mid.setAttribute('x2', W); mid.setAttribute('y1', H / 2); mid.setAttribute('y2', H / 2); mid.setAttribute('class', 'ed-rt-mid');
    svg.appendChild(mid);
    const pts = preset ? C.retimeCurve(C.RETIME_PRESETS[preset], strength) : [[0, 1], [1, 1]];
    const line = doc.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.map(([u, v]) => `${(u * W).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
    line.setAttribute('class', 'ed-rt-line');
    svg.appendChild(line);
    return svg;
  }
  function openSpeedPop(anchor) {
    const c = speedTarget();
    if (!c) { say('先選取一個影片或音訊片段（圖片、字幕、定格片段不能變速）', 'error'); return; }
    const id = c.id, wasRamped = !!(c.retime && !c.reverse);
    let cur = wasRamped && c.retime.preset !== 'custom' ? c.retime.preset : null;
    const box = el('div', 'ed-form');
    box.append(el('div', 'ed-form-h', `變速：${clipTitle(c)}`));
    const row = el('div', 'ed-form-row');
    const lab = el('span', null, '速度');
    const inp = el('input'); inp.type = 'number'; inp.id = 'edSpeedPct'; inp.min = 1; inp.max = 10000; inp.step = 5;
    inp.value = fmtNum((wasRamped ? c.retime.base : c.speed) * 100, 2);
    inp.setAttribute('aria-label', '速度百分比');
    row.append(lab, inp, el('span', 'ed-unit', '%'));
    const presets = el('div', 'ed-presets');
    for (const v of [25, 50, 100, 200, 400]) { const b = el('button', 'ed-btn small', v + '%'); b.type = 'button'; b.addEventListener('click', () => { inp.value = v; }); presets.appendChild(b); }
    // 曲線變速
    const rtH = el('div', 'ed-beat-h', '曲線變速（平滑變快變慢）');
    const grid = el('div', 'ed-rt-grid'); grid.id = 'edRetimeGrid';
    const str = el('input'); str.type = 'range'; str.min = 10; str.max = 100; str.step = 5; str.id = 'edRetimeStr';
    str.value = wasRamped ? Math.round((c.retime.strength == null ? 1 : c.retime.strength) * 100) : 100;
    str.setAttribute('aria-label', '曲線強度');
    const strV = el('span', 'ed-unit');
    const strRow = el('div', 'ed-form-row'); strRow.append(el('span', null, '強度'), str, strV);
    const desc = el('div', 'ed-hint');
    const btns = [];
    const opt = (key, name) => {
      const b = el('button', 'ed-rt-opt'); b.type = 'button'; b.dataset.preset = key || 'none';
      b.title = key ? RETIME_UI.find(x => x[0] === key)[2] : '整段同一個速度';
      b.append(retimeSvg(key, 1), el('span', null, name));
      b.addEventListener('click', () => { cur = key; sync(); });
      btns.push(b); grid.appendChild(b);
    };
    opt(null, '不用曲線');
    for (const [k, n] of RETIME_UI) opt(k, n);
    const rev = el('label', 'ed-chk'); const cr = el('input'); cr.type = 'checkbox'; cr.checked = !!c.reverse; cr.id = 'edSpeedRev'; rev.append(cr, doc.createTextNode('倒播'));
    const rip = el('label', 'ed-chk'); const cp = el('input'); cp.type = 'checkbox'; cp.checked = state.rippleSpeed; cp.id = 'edSpeedRipple';
    rip.append(cp, doc.createTextNode('波紋（片段長度跟著變，後面的片段一起推拉）'));
    function sync() {
      const k = str.value / 100;
      strV.textContent = str.value + '%';
      for (const b of btns) {
        const on = (b.dataset.preset === 'none' ? null : b.dataset.preset) === cur;
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (b.dataset.preset !== 'none') b.firstChild.replaceWith(retimeSvg(b.dataset.preset, k));
      }
      strRow.hidden = !cur;
      lab.textContent = cur ? '基準速度' : '速度';
      cr.disabled = !!cur; if (cur) cr.checked = false;
      rev.classList.toggle('off', !!cur);
      desc.textContent = cur ? RETIME_UI.find(x => x[0] === cur)[2] + '。曲線裡的百分比都是相對「基準速度」；建議勾選波紋，慢動作才不會吃掉後面的畫面。'
        : wasRamped ? '套用後會取消曲線變速，整段回到同一個速度。' : '';
      desc.hidden = !desc.textContent;
      fitPop();                                     // 多了強度、說明，視窗變高：下緣不要跑出畫面
    }
    str.addEventListener('input', sync);
    const act = el('div', 'ed-form-act');
    const no = el('button', 'ed-btn small', '取消'); no.type = 'button'; no.addEventListener('click', closePop);
    const ok = el('button', 'ed-btn small primary', '套用'); ok.type = 'button'; ok.id = 'edSpeedOk';
    const apply = () => {
      const pct = parseFloat(inp.value);
      if (!isFinite(pct) || pct <= 0) { say('請輸入大於 0 的速度百分比', 'error'); return; }
      state.rippleSpeed = cp.checked;
      const o = { ripple: cp.checked, linked: state.linkedSelection };
      let r;
      if (cur) {
        const name = RETIME_UI.find(x => x[0] === cur)[1];
        r = op('曲線變速', p => C.setRetime(p, id, Object.assign({ preset: cur, strength: str.value / 100, base: pct / 100 }, o)), `曲線變速：${name}（基準 ${fmtNum(pct, 2)}%）`);
      } else {
        r = op('變速', p => {
          if (wasRamped) { const x = C.clearRetime(p, id, o); if (!x.ok) return x; }
          return C.setSpeed(p, id, Object.assign({ speed: pct / 100, reverse: cr.checked }, o));
        }, `速度 ${fmtNum(pct, 2)}%${cr.checked ? '（倒播）' : ''}`);
      }
      if (r && r.ok) closePop();
    };
    ok.addEventListener('click', apply);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    act.append(no, ok);
    box.append(row, presets, rtH, grid, strRow, desc, rev, rip, act);
    sync();
    openPop(anchor, box, 'speed');
    inp.focus(); inp.select();
  }
  // ---- 節拍：偵測、打拍子、卡點 --------------------------------------------------------
  // 要分析的音樂：選取的片段有聲音就用它，否則音訊軌上第一個音樂（純音訊優先）
  function beatSource() {
    const p = state.project;
    const hasAudio = c => {
      if (!c || c.type !== 'media' || !c.mediaId || c.freeze) return false;
      const m = mediaOf(c.mediaId);
      return !!m && (m.kind === 'audio' || (m.kind === 'video' && m.hasAudio !== false));
    };
    const sel = selIds().map(clipOf).filter(hasAudio);
    const pick = sel.find(c => C.getTrack(p, c.trackId).kind === 'audio') || sel[0];
    if (pick) return pick;
    const aud = Object.values(p.clips).filter(c => hasAudio(c) && C.getTrack(p, c.trackId).kind === 'audio').sort((a, b) => a.start - b.start);
    return aud.find(c => mediaOf(c.mediaId).kind === 'audio') || aud[0] || null;
  }
  const BEAT_DENSITY = [['2', '每半拍（快節奏）'], ['1', '每一拍'], ['0.5', '每 2 拍'], ['0.25', '每小節（4 拍）']];
  // 來源秒數的拍點 → 時間軸影格（片段範圍內）；density 2＝在兩拍中間補一點、0.5＝隔一拍取一點
  function beatsToFrames(c, beats, density) {
    const p = state.project, fpsv = p.fps;
    let list = beats.slice();
    if (density >= 2) list = list.flatMap((t, i) => (i + 1 < list.length ? [t, (t + list[i + 1]) / 2] : [t]));
    else if (density < 1) { const step = Math.round(1 / density); list = list.filter((_, i) => i % step === 0); }
    const span = C.sourceSpan(p, c);
    // 曲線變速：來源秒數和影格不是線性關係，用二分搜尋找畫面最接近的那一格（sourceTimeAt 是遞增的）
    const toFrame = c.retime && !c.reverse ? t => {
      let lo = c.start - 1, hi = C.clipEnd(c);
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C.sourceTimeAt(p, c, m) < t) lo = m; else hi = m; }
      return lo >= c.start && t - C.sourceTimeAt(p, c, lo) < C.sourceTimeAt(p, c, Math.min(hi, C.clipEnd(c) - 1)) - t ? lo : hi;
    } : t => Math.round(c.start + (t - span.from) * fpsv / c.speed);
    return list.map(toFrame).filter(f => f >= c.start && f < C.clipEnd(c));
  }
  async function detectBeatsInto(c, density, out) {
    const m = mediaOf(c.mediaId);
    if (c.reverse) { say('倒播的片段不能偵測節拍，先取消倒播', 'error'); return; }
    out.textContent = '分析中…';
    let buf = null;
    try { buf = await R.media.decodeAudio(c.mediaId); } catch (_) { buf = null; }
    if (!buf) { out.textContent = ''; say(`讀不到「${m ? m.name : '這個素材'}」的聲音`, 'error'); return; }
    const chans = []; for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) chans.push(buf.getChannelData(i));
    const span = C.sourceSpan(state.project, c);
    const r = Q.beat.detect(chans, buf.sampleRate, { from: span.from, to: span.to });
    if (!r.beats.length) { out.textContent = '找不到明顯的節拍（片段至少要 2 秒、節奏清楚的音樂比較準）'; return; }
    const frames = beatsToFrames(c, r.beats, density);
    const res = op('偵測節拍', p => C.addBeatMarkers(p, frames), `約 ${fmtNum(r.bpm * c.speed, 0)} BPM，加上 ${frames.length} 個節拍標記`);
    out.textContent = res && res.ok ? `約 ${fmtNum(r.bpm * c.speed, 0)} BPM，加上 ${frames.length} 個節拍標記` : '';
  }
  function openBeatPop(anchor) {
    const box = el('div', 'ed-form ed-beat');
    box.append(el('div', 'ed-form-h', '節拍標記與卡點'));
    // 1. 自動偵測
    const src = beatSource();
    box.append(el('div', 'ed-beat-h', '① 自動偵測'));
    box.append(el('div', 'ed-hint', src ? `分析：${clipTitle(src)}` : '時間軸上還沒有音樂：先把音樂放到音訊軌（或選取有聲音的片段）'));
    const row = el('div', 'ed-form-row');
    const dens = el('select'); dens.id = 'edBeatDensity'; dens.setAttribute('aria-label', '節拍密度');
    BEAT_DENSITY.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; dens.append(o); });
    dens.value = state.beatDensity || '1';
    const go = el('button', 'ed-btn small primary', '偵測節拍'); go.type = 'button'; go.id = 'edBeatDetect'; go.disabled = !src;
    row.append(dens, go);
    const out = el('div', 'ed-hint ed-beat-out'); out.id = 'edBeatOut';
    go.addEventListener('click', () => { state.beatDensity = dens.value; if (src) detectBeatsInto(clipOf(src.id) || src, Number(dens.value), out); });
    box.append(row, out);
    // 2. 打拍子
    box.append(el('div', 'ed-beat-h', '② 手動打拍子'));
    const tap = el('button', 'ed-btn small' + (state.beatTap ? ' active' : ''), state.beatTap ? '結束打拍子' : '開始打拍子'); tap.type = 'button'; tap.id = 'edBeatTap';
    tap.addEventListener('click', () => {
      state.beatTap = !state.beatTap;
      closePop();
      if (state.beatTap) {
        if (src && (state.playhead < src.start || state.playhead >= C.clipEnd(src))) seekTimeline(src.start);
        if (UI.player && !UI.player.playing) UI.player.toggle();
        say('打拍子：跟著音樂按 M，每按一下加一個節拍標記；按空白鍵停止');
      } else say('已結束打拍子');
    });
    box.append(el('div', 'ed-hint', '開始後會播放，跟著音樂按 M 鍵，每按一下就加一個節拍標記。'), tap);
    // 3. 卡點
    box.append(el('div', 'ed-beat-h', '③ 卡點：片段跟著節拍換'));
    const n = selIds().length, nb = C.beatFrames(state.project).length;
    const row2 = el('div', 'ed-form-row');
    const every = el('select'); every.id = 'edBeatEvery'; every.setAttribute('aria-label', '每幾拍換一段');
    [['1', '每 1 拍換一段'], ['2', '每 2 拍換一段'], ['4', '每 4 拍換一段']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; every.append(o); });
    every.value = state.beatEvery || '1';
    const fit = el('button', 'ed-btn small primary', '套用'); fit.type = 'button'; fit.id = 'edBeatFit'; fit.disabled = !n || !nb;
    fit.addEventListener('click', () => {
      state.beatEvery = every.value;
      const r = op('卡點', p => C.fitClipsToBeats(p, selIds(), { every: Number(every.value) }));
      if (r && r.ok) {
        closePop();
        say(`已把 ${r.count} 段片段排到節拍上` + (r.short ? `；${r.short} 段素材不夠長，後面留了空隙` : '') + (r.extra ? `；節拍不夠，${r.extra} 段照原長度接在後面` : ''));
      }
    });
    row2.append(every, fit);
    box.append(el('div', 'ed-hint', !nb ? '先用 ① 或 ② 加上節拍標記。' : !n ? `有 ${nb} 個節拍標記。在時間軸選取要卡點的圖片或影片（可以框選）。` : `把選取的 ${n} 段片段依時間順序排到 ${nb} 個節拍標記上。`), row2);
    const act = el('div', 'ed-form-act');
    const clr = el('button', 'ed-btn small', '清除節拍標記'); clr.type = 'button'; clr.id = 'edBeatClear'; clr.disabled = !nb;
    clr.addEventListener('click', () => { const r = op('清除節拍標記', p => C.clearBeatMarkers(p)); if (r && r.ok) closePop(); });
    const no = el('button', 'ed-btn small', '關閉'); no.type = 'button'; no.addEventListener('click', closePop);
    act.append(clr, no);
    box.append(act);
    openPop(anchor, box, 'beat');
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
      UI.afterRender(() => UI.revealFrame(r.start, r.end));
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
  const subMarkOn = () => state.mode === 'timeline' && (lib.tab === 'title' || (UI.primaryClip() && UI.primaryClip().type === 'title'));
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
    UI.loadTabOf().sub = 'subs';
    UI.insp.revealSub = id;
    UI.scheduleInspector();
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
      UI.afterRender(() => UI.revealFrame(cues[0].start, cues[cues.length - 1].end));
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
    if (r && r.ok) { if (UI.player && !UI.player.playing) UI.player.refresh(); say(list.length > 1 ? `${okMsg}（${list.length} 個字幕）` : okMsg, 'ok'); }
    return r;
  }
  function applyTitleStyle(key, ids) {
    const st = F.TITLE_STYLES && F.TITLE_STYLES[key];
    if (!st) return null;
    return applyTitlePatch('字幕樣式', JSON.parse(JSON.stringify(st.patch)), ids, `已套用字幕樣式「${st.name}」`);
  }
  // 一般的字幕欄位修改（簡易模式的快速調整：位置、大小、持續／出場特效）：一筆復原、重畫預覽
  function applyTitleProps(label, patch, ids, okMsg) {
    return applyTitlePatch(label, JSON.parse(JSON.stringify(patch)), ids, okMsg);
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
    UI.setActionLabel('');
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
      btn('edRipple', '波紋刪除', '', '波紋刪除：刪掉並把後面的片段補上來。快捷鍵 Shift+Delete 或 Backspace', () => deleteSelection(true)),
      btn('edCloseGaps', '清除空隙', '', '清除空隙：把選取片段所在的軌（沒選取時是第一條影像軌）所有片段之間的空白一次收掉，其他軌跟著移、保持同步', () => closeGaps()));

    const bl = btn('edToggleLink', '連結選取', '', '連結選取：開啟時連結的影像與聲音一起選、一起動。快捷鍵 ' + MOD + 'Shift+L', toggleLink, 'toggle');
    const bs = btn('edToggleSnap', '吸附', 'N', '吸附：拖曳時貼齊片段邊緣、播放頭、標記、In／Out', toggleSnap, 'toggle');
    grp('toggles', bl, bs);

    grp('mark',
      btn('edMarkIn', '設 In', 'I', '把播放頭設成 In（來源模式時設來源的 In）', markIn),
      btn('edMarkOut', '設 Out', 'O', '把播放頭設成 Out（來源模式時設來源的 Out）', markOut),
      btn('edClearIO', '清除 In／Out', '', '清除 In／Out。快捷鍵 Alt+X', clearInOut),
      btn('edMarker', '標記', 'M', '在播放頭加標記（選取的片段在播放頭下時加片段標記）', addMarkerHere),
      btn('edBeat', '節拍', '', '節拍：自動偵測音樂節拍、手動打拍子、讓片段跟著節拍換（卡點）', b => { b.dataset.pop = '1'; openBeatPop(b); }),
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
    if (doc.querySelector('dialog[open], #edAuto, #edStart')) return;   // 匯出對話框／一鍵成片／開始畫面開著：不要改到底下的時間軸
    if (isTextTarget(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    const key = e.key, lk = key.length === 1 ? key.toLowerCase() : key;
    const mod = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const fresh = !e.repeat;
    // 拖曳中（時間軸或詳細內容的數值拖曳，history 在 begin 之後）：只留 Esc（拖曳自己的 capture 監聽會處理）；
    // 其他會改專案的快捷鍵一律擋掉，不然 Delete／刀片／復原會跟拖曳的 cancel＋重套打架，放開後專案或復原堆疊會亂掉
    if (UI.drag || UI.live.started || (state.history && state.history.busy)) { if (key !== 'Escape' && key !== 'Shift' && key !== 'Alt' && key !== 'Control' && key !== 'Meta') done(); return; }

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
        if (UI.popEl || UI.menuEl) { closePop(); closeMenu(); done(); return; }
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
      case 'z': if (shift) { done(); UI.zoomFit(); } break;
      case '=': case '+': done(); UI.zoomBy(1.25); break;
      case '-': case '_': done(); UI.zoomBy(0.8); break;
      default:
    }
  }
  function onKeyUp(e) {
    // 空白鍵按在按鈕上時，放開會再「點」一次那顆按鈕：這裡擋掉
    if (!app.hidden && e.key === ' ' && !isTextTarget(e.target)) e.preventDefault();
  }

  Object.assign(UI, {
    MOD, TRANS_SIDE_TEXT, addMarkerHere, openBeatPop, addTitle, addTransitionAt, addTransitionToSelection, applyTextFx,
    applyTitleProps, applyTitleStyle, bladeAtPlayhead, buildToolbar, clearInOut, clickSelect, closeGaps, deleteSelection, doEdit, exportSrt,
    flushPop, importSrt, isSrtFile, linkSelection, markClipRange, markIn, markOut, markSubtitle, onKeyDown, onKeyUp,
    op, openFlagPop, openFreezePop, openMarkerPop, openSpeedPop, redo, sanitizeSelection, selectClips,
    selectTransition, setTool, subClips, toggleLink, toggleSnap, undo, updateSubMark, updateToolbar,
  });
})(typeof window !== 'undefined' ? window : globalThis);
