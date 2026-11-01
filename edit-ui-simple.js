// =====================================================================================
// 剪輯介面：簡易模式（4.00）
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
//
// 簡易／專業只是兩套「介面」，專案資料完全一樣，隨時可以切換：
//   - 頁首的「簡易｜專業」切換（記在 localStorage qc-ui；沒選過＝簡易）
//   - 簡易：大按鈕工具列（#edSimpleBar）取代專業工具列；選到影片／圖片／音訊片段或字幕片段（4.30）時，
//     詳細內容換成「快速調整」（點選項就套用，每次一筆復原）；軌道名稱顯示成白話（影片／畫中畫／原聲／音樂，只改顯示、不改資料）；
//     加進來的素材自動依序排到時間軸結尾（音樂放到音樂軌）。
//   - 開始畫面（空專案打開時；qc-start-off＝不要再顯示）：選直式短影音／橫式影片／自己來（＝專業模式）
//   - 第一次用簡易模式的三步教學泡泡（qc-tips＝done 之後不再出現）
// 所有修改都走 op()（history.run）＋ core，這支不直接改專案。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;
  const { $, app, clipOf, clipTitle, closeMenu, closePop, doc, el, fmtNum, mediaOf, say, selIds, state } = UI;
  let C = null, R = null, F = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; });

  const UI_KEY = 'qc-ui', START_KEY = 'qc-start-off', TIPS_KEY = 'qc-tips';
  const lsGet = k => { try { return root.localStorage.getItem(k); } catch (_) { return null; } };
  const lsPut = (k, v) => { try { root.localStorage.setItem(k, v); } catch (_) { /* 不能存就算了 */ } };
  state.ui = lsGet(UI_KEY) === 'pro' ? 'pro' : 'simple';
  const simple = () => state.ui === 'simple';

  const SVG = {
    add: '<path d="M12 5v14M5 12h14"/>',
    cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
    del: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    txt: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
    mus: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    gap: '<path d="M4 5v14M20 5v14M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3"/>',
    beat: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    sticker: '<path d="M4 4h16v10l-6 6H4z"/><path d="M14 20v-6h6"/><circle cx="9" cy="10" r="1"/>',
  };
  const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${SVG[k]}</svg>`;

  // =====================================================================================
  // 模式切換
  // =====================================================================================
  function setUiMode(m, remember = true) {
    state.ui = m === 'pro' ? 'pro' : 'simple';
    if (remember) lsPut(UI_KEY, state.ui);
    app.dataset.ui = state.ui;
    const sw = $('edUiMode');
    if (sw) for (const b of sw.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.ui === state.ui));
    closePop(); closeMenu();
    quick.sig = null;
    UI.dirty.tl = UI.dirty.insp = true;
    UI.scheduleRender('all');
    if (state.ui === 'simple') UI.scheduleRender();
  }
  function buildModeSwitch() {
    const host = doc.querySelector('.topbar-actions');
    if (!host || $('edUiMode')) return;
    const sw = el('div', 'ed-uimode'); sw.id = 'edUiMode'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', '介面模式');
    for (const [k, label, tip] of [['simple', '簡易', '簡易模式：大按鈕、點選項就能調整，適合第一次剪片'], ['pro', '專業', '專業模式：多軌剪輯、關鍵影格、EQ 等完整功能']]) {
      const b = el('button', null, label); b.type = 'button'; b.dataset.ui = k; b.title = tip;
      b.addEventListener('click', () => { setUiMode(k); say(k === 'pro' ? '已切換到專業模式（專案內容不變）' : '已切換到簡易模式（專案內容不變）', 'ok'); });
      sw.appendChild(b);
    }
    host.insertBefore(sw, host.firstChild);
  }

  // 白話軌道名稱（只在簡易模式、而且是預設名稱 V1／A2 這種時才換）
  function trackLabel(t) {
    if (!simple() || !C) return t.name;
    const m = /^([VA])(\d+)$/.exec(t.name || '');
    if (!m) return t.name;
    const n = +m[2];
    if (m[1] === 'V') return n === 1 ? '影片' : n === 2 ? '畫中畫' : `畫中畫 ${n - 1}`;
    return n === 1 ? '原聲' : n === 2 ? '音樂' : `音樂 ${n - 1}`;
  }

  // =====================================================================================
  // 大按鈕工具列
  // =====================================================================================
  function pickFiles(accept) {
    const inp = el('input'); inp.type = 'file'; inp.multiple = true; inp.accept = accept; inp.hidden = true;
    inp.addEventListener('change', () => { UI.importFiles(inp.files); inp.remove(); });
    doc.body.appendChild(inp);
    inp.click();
  }
  // 加貼圖：選圖片 → 匯入後由 placeImported 交給 placeSticker（旗標在匯入完成後放掉）
  function pickSticker() {
    const inp = el('input'); inp.type = 'file'; inp.multiple = true; inp.accept = 'image/*'; inp.hidden = true;
    inp.addEventListener('change', async () => {
      state.stickerPicking = true;
      try { await UI.importFiles(inp.files); } finally { state.stickerPicking = false; inp.remove(); }
    });
    doc.body.appendChild(inp);
    inp.click();
  }
  function buildSimpleBar() {
    const bar = el('div', 'ed-sbar'); bar.id = 'edSimpleBar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '簡易工具列');
    const btn = (id, ic, label, tip, run, cls) => {
      const b = el('button', 'ed-sbtn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.id = id; b.title = tip;
      b.innerHTML = svg(ic); b.append(el('span', null, label));
      b.addEventListener('click', e => run(e.currentTarget));
      bar.appendChild(b);
      return b;
    };
    const sep = () => bar.appendChild(el('span', 'ed-ssep'));
    btn('edSAdd', 'add', '加素材', '選影片、照片或音樂；會自動依序接在時間軸最後面（也可以直接拖進來）', () => pickFiles('video/*,audio/*,image/*'));
    btn('edSCut', 'cut', '分割', '在播放頭（紅線）把片段切成兩段（快捷鍵 Ctrl／⌘＋B）', () => UI.bladeAtPlayhead());
    btn('edSDel', 'del', '刪除', '刪除選取的片段，後面的自動往前補（快捷鍵 Delete）', () => UI.deleteSelection(true));
    btn('edSGaps', 'gap', '清除空隙', '把片段之間的空白一次收掉，後面的自動往前補（字幕、音樂跟著移）', () => UI.closeGaps());
    btn('edSUndo', 'undo', '復原', '復原上一步（Ctrl／⌘＋Z）', () => UI.undo());
    btn('edSRedo', 'redo', '重做', '重做（Ctrl／⌘＋Shift＋Z）', () => UI.redo());
    sep();
    btn('edSText', 'txt', '加字幕', '在播放頭加一段字幕，右邊可以改文字和樣式', () => UI.addTitle('static'));
    btn('edSSticker', 'sticker', '加貼圖', '選一張圖片當貼圖：放在播放頭、最上層的影片軌，縮小到 35% 並自帶「進場彈出」動態；位置和動態在右邊的詳細內容改', () => pickSticker());
    btn('edSMusic', 'mus', '加音樂', '選一首音樂，會放到「音樂」軌', () => pickFiles('audio/*,video/*'));
    btn('edSBeat', 'beat', '對拍子', '偵測音樂節拍，讓照片和影片跟著拍子換', a => UI.openBeatPop(a));
    bar.appendChild(el('span', 'ed-shint', '點時間軸上的片段，右邊就能調整'));
    const tb = $('edToolbar');
    tb.parentNode.insertBefore(bar, tb);
  }

  // =====================================================================================
  // 加進來的素材自動排到時間軸（簡易模式）
  // =====================================================================================
  // 影片／圖片依序接在第一條影片軌的最後（有聲音的影片，聲音放第一條音訊軌）；純音訊放第二條音訊軌（音樂）
  function placeImported(added) {
    if (state.stickerPicking && simple() && added && added.length) return placeSticker(added);
    if (!simple() || state.autoPicking || !added || !added.length) return;   // 一鍵成片對話框裡加的素材：等產生時才排
    const fresh = added.filter(m => !m.relinked);
    if (!fresh.length) return;
    let firstIds = null;
    const r = UI.op('加入素材', p => {
      const vt = C.tracksOf(p, 'video')[0], at = C.tracksOf(p, 'audio');
      if (!vt) return { ok: false, reason: '沒有影片軌' };
      let musicT = at[1];
      if (!musicT) { const x = C.addTrack(p, 'audio'); if (!x.ok) return x; musicT = C.tracksOf(p, 'audio')[1]; }
      const endOf = tid => Object.values(p.clips).filter(c => c.trackId === tid).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const ids = [];
      for (const m of fresh) {
        const info = p.mediaInfo[m.id];
        if (!info) continue;
        let o;
        if (info.kind === 'audio') o = { mode: 'overwrite', mediaId: m.id, frame: endOf(musicT.id), trackIds: { video: null, audio: musicT.id }, name: m.name };
        else {
          const fr = Math.max(endOf(vt.id), info.kind === 'video' && info.hasAudio !== false && at[0] ? endOf(at[0].id) : 0);
          o = { mode: 'overwrite', mediaId: m.id, frame: fr, trackIds: { video: vt.id, audio: info.kind === 'video' && at[0] ? at[0].id : null }, name: m.name };
        }
        const x = C.editToTimeline(p, o);
        if (!x.ok) return x;
        ids.push(...x.ids);
        if (!firstIds) firstIds = x.ids;
      }
      // 比例和輸出不同的影片／圖片：用模糊背景（直式短影音最常見的做法）
      const mis = new Set(C.aspectMismatch(p).ids);
      const blur = ids.filter(id => mis.has(id));
      if (blur.length) { const x = C.setClipProps(p, blur, { video: { fit: 'blur' } }); if (!x.ok) return x; }
      return { ok: true, ids, blur: blur.length };
    }, null);
    if (r && r.ok && firstIds) {
      UI.selectClips(firstIds);
      const c = clipOf(firstIds[0]);
      if (c) UI.seekTimeline(c.start);
      say(`已把 ${fresh.length} 個素材排到時間軸${r.blur ? `（${r.blur} 段比例不同，自動加上模糊背景）` : ''}`, 'ok');
    }
  }

  // 圖片貼圖：放在播放頭、最上層「放得下」的影片軌（都被佔用就新增一條影片軌），縮放 0.35、fit 模式（不加模糊背景）、
  //   進場彈出；長度用圖片預設長度。整批包在一個 op() 裡，一步復原。
  function placeSticker(added) {
    const imgs = added.filter(m => !m.relinked && (C && state.project.mediaInfo[m.id] || {}).kind === 'image');
    if (!imgs.length) { say('加貼圖要選圖片檔', 'error'); return; }
    const at = Math.max(0, Math.round(state.playhead || 0));
    let firstIds = null;
    const r = UI.op('加貼圖', p => {
      const ids = [];
      for (const m of imgs) {
        const dur = Math.round(C.IMAGE_DEFAULT_SEC * p.fps);
        const free = C.tracksOf(p, 'video').slice().reverse().find(t => !t.locked &&
          !C.clipsOnTrack(p, t.id).some(c => c.start < at + dur && C.clipEnd(c) > at));
        let tid = free && free.id;
        if (!tid) { const a = C.addTrack(p, 'video'); if (!a.ok) return a; tid = a.id; }
        const x = C.editToTimeline(p, { mode: 'overwrite', mediaId: m.id, frame: at, trackIds: { video: tid, audio: null }, name: m.name });
        if (!x.ok) return x;
        const y = C.setClipProps(p, x.ids, { video: { fit: 'fit', transform: { zoomLinked: true, zoomX: 0.35, zoomY: 0.35 }, sticker: 'pop', stickerAmt: 100 } });
        if (!y.ok) return y;
        ids.push(...x.ids);
        if (!firstIds) firstIds = x.ids;
      }
      return { ok: true, ids };
    }, null);
    if (r && r.ok && firstIds) {
      UI.selectClips(firstIds);
      say(`已加上 ${imgs.length} 張貼圖：拖曳預覽畫面調位置，右邊可以換動態`, 'ok');
    }
  }

  // =====================================================================================
  // 快速調整（取代詳細內容）
  // =====================================================================================
  const quick = { el: null, sig: null };
  const isVisual = c => c && c.type === 'media' && !!c.video;
  const timed = c => { const m = c && c.type === 'media' && mediaOf(c.mediaId); return !!m && m.kind !== 'image'; };
  const MOTIONS = [['none', '不動'], ['zoomIn', '慢慢放大'], ['zoomOut', '慢慢縮小'], ['panLeft', '向左平移'], ['panRight', '向右平移']];
  const FITS = [['blur', '模糊背景'], ['fill', '填滿畫面'], ['fit', '完整顯示']];
  const TRANS = [['none', '直接切'], ['crossDissolve', '淡化'], ['push', '推移'], ['flash', '閃白'], ['zoom', '縮放']];
  const SPEEDS = [['normal', '正常'], ['slow', '慢動作'], ['bullet', '子彈時間'], ['fast', '快轉 2×']];
  const LOOKS = [['none', '原色'], ['warm', '暖陽'], ['cool', '冷調'], ['mono', '黑白'], ['mist', '黑柔'], ['film', '電影感']];
  const MOTION_PATHS = ['video.transform.zoomX', 'video.transform.zoomY', 'video.transform.posX'];

  function motionOf(c) {
    const k = c.keyframes || {}, z = k['video.transform.zoomX'], x = k['video.transform.posX'];
    if (x && x.length >= 2) return x[0].v > x[x.length - 1].v ? 'panLeft' : 'panRight';
    if (z && z.length >= 2) return z[0].v < z[z.length - 1].v ? 'zoomIn' : 'zoomOut';
    return 'none';
  }
  const transOf = c => Object.values(state.project.transitions).find(t => t.leftClipId === c.id) || null;
  function transKey(t) {
    if (!t) return 'none';
    if (t.type === 'dipToColor' && String(t.color).toLowerCase() === '#ffffff') return 'flash';
    return t.type;
  }
  function speedOf(c) {
    if (c.retime && !c.reverse) return c.retime.preset === 'bullet' ? 'bullet' : 'custom';
    if (c.reverse) return 'custom';
    if (Math.abs(c.speed - 1) < 1e-6) return 'normal';
    if (Math.abs(c.speed - 0.5) < 1e-6) return 'slow';
    if (Math.abs(c.speed - 2) < 1e-6) return 'fast';
    return 'custom';
  }
  // 片段的聲音：音訊軌上的自己，或連結的音訊片段
  function audioOf(c) {
    const p = state.project;
    if (c.audio) return [c];
    if (!c.linkId) return [];
    return Object.values(p.clips).filter(k => k.linkId === c.linkId && k.audio);
  }
  const gainPct = db => (db <= -60 ? 0 : Math.round(Math.pow(10, db / 20) * 100));
  const pctGain = pct => (pct <= 0 ? -60 : Math.max(-60, Math.min(24, 20 * Math.log10(pct / 100))));

  // 選取的「媒體片段」：連結的影像＋聲音只算一個（影像優先）
  function quickTargets() {
    const p = state.project, seen = new Set(), out = [];
    const list = selIds().map(clipOf).filter(c => c && c.type === 'media' && !UI.isSubClip(c));
    list.sort((a, b) => (a.video ? 0 : 1) - (b.video ? 0 : 1));
    for (const c of list) {
      if (c.linkId && seen.has(c.linkId)) continue;
      if (c.linkId) seen.add(c.linkId);
      out.push(c);
    }
    void p;
    return out;
  }

  // 多選時一起套用；一次一筆復原
  function applyAll(label, cs, fn, okMsg) {
    const r = UI.op(label, p => {
      for (const c of cs) { const x = fn(p, p.clips[c.id] ? p.clips[c.id] : c); if (x && x.ok === false) return x; }
      return { ok: true };
    });
    if (r && r.ok && okMsg) say(okMsg, 'ok');
    return r;
  }
  function setMotion(cs, k) {
    applyAll('動態', cs, (p, c) => {
      if (k === 'none') {
        const has = MOTION_PATHS.filter(x => c.keyframes && c.keyframes[x] && c.keyframes[x].length);
        if (!has.length) return { ok: true };
        const x = C.clearKeyframes(p, c.id, has, 0);
        if (!x.ok) return x;
        return C.setClipProps(p, c.id, { video: { transform: { zoomX: 1, zoomY: 1, posX: 0 } } });
      }
      if (motionOf(c) !== 'none') {
        const has = MOTION_PATHS.filter(x => c.keyframes && c.keyframes[x] && c.keyframes[x].length);
        const x = C.clearKeyframes(p, c.id, has, 0);
        if (!x.ok) return x;
        const y = C.setClipProps(p, c.id, { video: { transform: { zoomX: 1, zoomY: 1, posX: 0 } } });
        if (!y.ok) return y;
      }
      return C.applyKeyframePreset(p, c.id, k);
    }, '已套用動態：' + MOTIONS.find(x => x[0] === k)[1]);
  }
  function setTrans(cs, k) {
    const fpsv = state.project.fps;
    applyAll('轉場', cs, (p, c) => {
      const old = Object.values(p.transitions).find(t => t.leftClipId === c.id);
      if (k === 'none') return old ? C.removeTransition(p, old.id) : { ok: true };
      const o = k === 'flash' ? { type: 'dipToColor', color: '#ffffff' } : { type: k };
      return C.addTransition(p, Object.assign({ leftClipId: c.id, duration: Math.round(fpsv * (k === 'flash' ? 0.4 : 0.5)), align: 'center' }, o));
    }, k === 'none' ? '已改成直接切' : '已加上轉場：' + TRANS.find(x => x[0] === k)[1]);
  }
  function setSpeedKind(cs, k) {
    applyAll('變速', cs, (p, c) => {
      if (!timed(c) || c.freeze) return { ok: true };
      const o = { ripple: true, linked: true };
      if (c.retime && !c.reverse) { const x = C.clearRetime(p, c.id, o); if (!x.ok) return x; }
      if (k === 'bullet') return C.setRetime(p, c.id, Object.assign({ preset: 'bullet', base: 1 }, o));
      return C.setSpeed(p, c.id, Object.assign({ speed: k === 'slow' ? 0.5 : k === 'fast' ? 2 : 1, reverse: false }, o));
    }, '速度：' + SPEEDS.find(x => x[0] === k)[1]);
  }

  function chips(label, note, opts, cur, onPick, id) {
    const sec = el('div', 'ed-qsec'); if (id) sec.id = id;
    const h = el('div', 'ed-qlab'); h.append(el('span', null, label)); if (note) h.append(el('small', null, note));
    const g = el('div', 'ed-qchips'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
    for (const [k, name] of opts) {
      const b = el('button', 'ed-qchip' + (k === cur ? ' on' : ''), name); b.type = 'button'; b.dataset.k = k;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === cur));
      b.addEventListener('click', () => onPick(k));
      g.appendChild(b);
    }
    sec.append(h, g);
    return sec;
  }

  // 回傳 true＝這次由快速調整顯示（詳細內容的其他區段藏起來）
  function renderQuick(insp) {
    if (!quick.el) {
      quick.el = el('div', 'ed-quick'); quick.el.id = 'edQuick';
      insp.body.parentNode.insertBefore(quick.el, insp.body);
    }
    const cs = simple() && !state.selTransition ? quickTargets() : [];
    const ts = simple() && !state.selTransition && !cs.length ? quickTitles() : [];   // 同時選了媒體和字幕：以媒體為主
    const on = cs.length > 0 || ts.length > 0;
    quick.el.hidden = !on;
    insp.body.hidden = on;
    if (!on) { quick.sig = null; return false; }
    insp.tabs.hidden = true;
    if (ts.length) return renderQuickTitle(ts);
    const p = state.project, c = cs[0];
    const vis = cs.filter(isVisual), tim = cs.filter(timed), aud = cs.flatMap(audioOf);
    const nextT = vis.length ? transOf(vis[0]) : null;
    const sig = JSON.stringify([cs.map(x => x.id), vis.map(x => [x.video.fit, x.video.look, motionOf(x)]), nextT && [nextT.type, nextT.color],
      tim.map(x => [x.speed, x.reverse, x.retime && x.retime.preset]), aud.map(x => x.audio.gainDb), p.aspect]);
    $('edInspHead').textContent = cs.length > 1 ? `快速調整　${cs.length} 個片段` : `快速調整　${clipTitle(c)}`;
    if (sig === quick.sig) return true;
    const keep = quick.sig && JSON.parse(quick.sig)[0].join() === cs.map(x => x.id).join() ? quick.el.scrollTop : 0;   // 同一批片段：重畫後捲動位置不變
    quick.sig = sig;
    quick.el.textContent = '';
    if (cs.length > 1) quick.el.append(el('div', 'ed-hint', '改了會一起套用到選取的所有片段'));
    if (vis.length) {
      quick.el.append(chips('畫面', p.aspect === 'source' ? null : '比例不同時', FITS, vis[0].video.fit === 'stretch' ? null : vis[0].video.fit, k =>
        applyAll('畫面符合', vis, (q, x) => C.setClipProps(q, x.id, { video: { fit: k } }), '畫面：' + FITS.find(x => x[0] === k)[1]), 'edQFit'));
      quick.el.append(chips('動態', '從頭到尾慢慢動', MOTIONS, motionOf(vis[0]), k => setMotion(vis, k), 'edQMotion'));
      quick.el.append(chips('接下一段', '轉場', TRANS, transKey(nextT), k => setTrans(vis, k), 'edQTrans'));
    }
    if (tim.length) quick.el.append(chips('速度', null, SPEEDS, speedOf(tim[0]), k => setSpeedKind(tim, k), 'edQSpeed'));
    if (aud.length) {
      const sec = el('div', 'ed-qsec'); sec.id = 'edQVol';
      const h = el('div', 'ed-qlab'); const v = el('small');
      h.append(el('span', null, c.video ? '原聲音量' : '音量'), v);
      const rg = el('input'); rg.type = 'range'; rg.min = 0; rg.max = 200; rg.step = 5; rg.id = 'edQVolR'; rg.setAttribute('aria-label', '音量百分比');
      rg.value = gainPct(aud[0].audio.gainDb);
      const show = () => { v.textContent = rg.value === '0' ? '靜音' : rg.value + '%'; };
      show();
      rg.addEventListener('input', show);
      rg.addEventListener('change', () => applyAll('音量', aud, (q, x) => C.setClipProps(q, x.id, { audio: { gainDb: pctGain(+rg.value) } })));
      sec.append(h, rg);
      quick.el.append(sec);
    }
    if (vis.length) quick.el.append(chips('濾鏡', null, LOOKS, vis[0].video.look || 'none', k =>
      applyAll('濾鏡', vis, (q, x) => C.setClipProps(q, x.id, { video: { look: k } }), '濾鏡：' + LOOKS.find(x => x[0] === k)[1]), 'edQLook'));
    const pro = el('div', 'ed-qpro');
    const pb = el('button', 'ed-linkbtn', '切到專業模式'); pb.type = 'button'; pb.addEventListener('click', () => setUiMode('pro'));
    pro.append(doc.createTextNode('要調更細的數值（位置、裁切、關鍵影格、EQ…）？'), pb, doc.createTextNode('，專案內容完全一樣。'));
    quick.el.append(pro);
    quick.el.scrollTop = keep;
    return true;
  }

  // =====================================================================================
  // 快速調整：字幕（4.30）
  // 樣式、進場／持續／出場特效都從 fx 的註冊表（TITLE_STYLES／TEXT_FX／TEXT_LOOP／TEXT_OUT）動態產生，
  // 新增的樣式、特效會自動出現；註冊表只有「無」的特效區段整段不顯示。
  // 字幕清單（title.sub：SRT 匯入、V 標記）的片段不在這裡，照舊用詳細內容的「字幕清單」編輯。
  // =====================================================================================
  const quickTitles = () => selIds().map(clipOf).filter(c => c && c.type === 'title' && c.title && !UI.isSubClip(c));
  const isTall = p => p.width > 0 && p.height / p.width >= 1.6;              // 直式 9:16：下方要讓開平台的按鈕、說明文字
  const titlePos = p => [['top', '上方', 0.15], ['mid', '中間', 0.5], ['bottom', '下方', isTall(p) ? 0.75 : 0.82]];
  const TITLE_SIZES = [['s', '小', 56], ['m', '中', 80], ['l', '大', 112]];
  const near = (a, b) => Math.abs(a - b) < 0.006;
  const textOf = c => String(c.title.text == null ? '' : c.title.text);

  // 樣式的 patch 和字幕目前的外觀一不一樣（只比 patch 有的欄位；顏色不分大小寫、不管空白；兩邊都是 on:false 的開關＝一樣）
  function sameVal(a, b) {
    if (Array.isArray(a)) return Array.isArray(b) && a.every((x, i) => sameVal(x, b[i]));
    if (a && typeof a === 'object') {
      if (!b || typeof b !== 'object') return false;
      if (a.on === false && b.on === false) return true;
      return Object.keys(a).every(k => sameVal(a[k], b[k]));
    }
    if (typeof a === 'string' && typeof b === 'string') return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
    return a === b;
  }
  // 目前的樣式＝patch 完全符合的；好幾個都符合時取欄位最多的（某個樣式的 patch 可能只是另一個的一部分）；
  // 都不符合（在專業模式改過顏色之類）＝null，不標選取
  const leafCount = o => (o && typeof o === 'object' ? Object.values(o).reduce((n, v) => n + leafCount(v), 0) : 1);
  function styleOf(c) {
    const t = F.normTitle(c.title);
    let best = null, bestN = -1;
    for (const [k, st] of Object.entries(F.TITLE_STYLES || {})) {
      if (!st || !st.patch || !sameVal(st.patch, t)) continue;
      const n = leafCount(st.patch);
      if (n > bestN) { best = k; bestN = n; }
    }
    return best;
  }

  // 樣式縮圖：每個樣式只真的畫一次（用 fx 畫，和成品一致），重畫面板時複製過去；字型載入後清掉重畫
  const thumbs = new Map();
  function styleThumb(k) {
    let src = thumbs.get(k);
    if (!src) {
      src = el('canvas'); src.width = 192; src.height = 108;
      const g = src.getContext('2d'), W = src.width, H = src.height, st = F.TITLE_STYLES[k];
      const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#5b6b86'); gr.addColorStop(1, '#2a3550');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      try {
        const title = Object.assign(F.makeTitle('static', st.sample || '字幕樣式'), JSON.parse(JSON.stringify(st.patch)), { size: 260 });
        F.drawTitle(g, { id: 'thumb', type: 'title', duration: 60, title, video: F.defaultVideo() }, W, H, 0, 30);
      } catch (_) { /* 字型還沒好：之後會重畫 */ }
      thumbs.set(k, src);
    }
    const cv = el('canvas'); cv.width = src.width; cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
    return cv;
  }
  function refreshThumbs() {
    thumbs.clear();
    if (quick.sig && JSON.parse(quick.sig)[1] === 'title') { quick.sig = null; UI.scheduleInspector(); }
  }

  // 樣式分頁（基本／綜藝／社群，來自 F.TITLE_STYLE_GROUPS）：預設打開目前樣式所在的那一頁；切分頁只換顯示、不重畫面板
  function styleChips(cur, onPick) {
    const sec = el('div', 'ed-qsec'); sec.id = 'edQStyle';
    const h = el('div', 'ed-qlab'); h.append(el('span', null, '樣式'), el('small', null, '只換外觀，文字和位置不變'));
    const styles = Object.entries(F.TITLE_STYLES || {}), groups = F.TITLE_STYLE_GROUPS || {};
    const gkeys = Object.keys(groups).filter(gk => styles.some(([, st]) => st.group === gk));
    const curG = cur && F.TITLE_STYLES[cur] && F.TITLE_STYLES[cur].group;
    if (!gkeys.includes(quick.styleGroup)) quick.styleGroup = null;
    let active = (curG && gkeys.includes(curG) && !quick.styleTouched ? curG : quick.styleGroup) || curG || gkeys[0] || null;
    const g = el('div', 'ed-qchips ed-qstyles'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', '樣式');
    const show = gk => {
      active = gk; quick.styleGroup = gk;
      for (const b of g.children) b.hidden = !!gk && b.dataset.group !== gk;
      if (tabs) for (const t of tabs.children) { const on = t.dataset.group === gk; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); }
    };
    let tabs = null;
    if (gkeys.length > 1) {
      tabs = el('div', 'ed-qtabs'); tabs.id = 'edQStyleTabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '樣式分類');
      for (const gk of gkeys) {
        const t = el('button', 'ed-qtab', groups[gk]); t.type = 'button'; t.dataset.group = gk; t.setAttribute('role', 'tab');
        t.addEventListener('click', () => { quick.styleTouched = true; show(gk); });
        tabs.appendChild(t);
      }
    }
    for (const [k, st] of styles) {
      const b = el('button', 'ed-qchip ed-qthumb' + (k === cur ? ' on' : '')); b.type = 'button'; b.dataset.k = k; b.title = st.name;
      if (st.group) b.dataset.group = st.group;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === cur));
      b.append(styleThumb(k), el('span', null, st.name));
      b.addEventListener('click', () => onPick(k));
      g.appendChild(b);
    }
    sec.append(h);
    if (tabs) sec.append(tabs);
    sec.append(g);
    if (tabs) show(active);
    return sec;
  }
  const regOpts = reg => Object.entries(reg || {}).filter(([, d]) => !(d && d.hidden)).map(([k, d]) => [k, (d && d.name) || k]);   // hidden＝只留給舊專案讀的 key，不列出

  function renderQuickTitle(ts) {
    const p = state.project, c = ts[0], ids = ts.map(x => x.id), t0 = F.normTitle(c.title);
    const POS = titlePos(p);
    // 文字不放進 sig：改文字（失焦時寫回）不重畫面板，才不會吃掉同時按下的選項
    const sig = JSON.stringify([ids, 'title', ts.map(x => { const n = F.normTitle(x.title); return [styleOf(x), n.textFx, n.textLoop, n.textOut, n.y, n.size]; }),
      p.width, p.height, [F.TITLE_STYLES, F.TEXT_FX, F.TEXT_LOOP, F.TEXT_OUT].map(r => Object.keys(r || {}).join())]);
    $('edInspHead').textContent = ts.length > 1 ? `快速調整　${ts.length} 個字幕` : `快速調整　${clipTitle(c)}`;
    if (sig === quick.sig) {
      const box = $('edQTextIn');                                           // 復原／重做改到文字：在這裡同步
      if (box && doc.activeElement !== box && box.value !== textOf(c)) box.value = textOf(c);
      return true;
    }
    const keep = quick.sig && JSON.parse(quick.sig)[0].join() === ids.join() ? quick.el.scrollTop : 0;
    if (quick.styleIds !== ids.join()) { quick.styleIds = ids.join(); quick.styleTouched = false; }   // 換了別的字幕：樣式分頁回到它目前樣式那一頁
    quick.sig = sig;
    quick.el.textContent = '';
    if (ts.length > 1) quick.el.append(el('div', 'ed-hint', `改了會一起套用到選取的 ${ts.length} 個字幕（文字要一個一個改）`));
    else {
      const sec = el('div', 'ed-qsec'); sec.id = 'edQText';
      const h = el('div', 'ed-qlab'); h.append(el('span', null, '文字'), el('small', null, '用 *星號* 包住的字會變強調色'));
      const box = el('textarea', 'ed-qtext'); box.id = 'edQTextIn'; box.rows = 2; box.setAttribute('aria-label', '字幕文字');
      box.value = textOf(c);
      box.addEventListener('focus', () => { if (box.value === F.makeTitle('static').text) box.select(); });   // 還是預設的「輸入字幕」：直接打字就取代
      box.addEventListener('change', () => {
        const cur = clipOf(c.id);
        if (!cur || textOf(cur) === box.value) return;
        UI.applyTitleProps('字幕文字', { text: box.value }, [c.id], '已更新字幕文字');
      });
      sec.append(h, box);
      quick.el.append(sec);
    }
    quick.el.append(styleChips(styleOf(c), k => UI.applyTitleStyle(k, ids)));
    const fx = [
      ['進場', '字幕出現時', F.TEXT_FX, 'textFx', 'edQIn', k => UI.applyTextFx(k, ids)],
      ['持續', '整段一直在動', F.TEXT_LOOP, 'textLoop', 'edQLoop', (k, nm) => UI.applyTitleProps('持續特效', { textLoop: k }, ids, k === 'none' ? '已移除持續特效' : `已套用持續特效「${nm}」`)],
      ['出場', '結束前', F.TEXT_OUT, 'textOut', 'edQOut', (k, nm) => UI.applyTitleProps('出場特效', { textOut: k }, ids, k === 'none' ? '已移除出場特效' : `已套用出場特效「${nm}」`)],
    ];
    for (const [label, note, reg, key, id, run] of fx) {
      const opts = regOpts(reg);
      if (opts.length <= 1) continue;                                       // 註冊表只有「無」：整段不顯示
      const cur = opts.some(o => o[0] === t0[key]) ? t0[key] : 'none';
      quick.el.append(chips(label, note, opts, cur, k => run(k, (opts.find(o => o[0] === k) || [])[1]), id));
    }
    const pos = POS.find(x => near(t0.y, x[2]));
    quick.el.append(chips('位置', isTall(p) ? '直式的下方會讓開平台按鈕' : null, POS.map(x => [x[0], x[1]]), pos ? pos[0] : null, k => {
      const x = POS.find(o => o[0] === k);
      UI.applyTitleProps('字幕位置', { y: x[2] }, ids, '字幕位置：' + x[1]);
    }, 'edQPos'));
    const sz = TITLE_SIZES.find(x => near(t0.size, x[2]));
    quick.el.append(chips('大小', null, TITLE_SIZES.map(x => [x[0], x[1]]), sz ? sz[0] : null, k => {
      const x = TITLE_SIZES.find(o => o[0] === k);
      UI.applyTitleProps('字幕大小', { size: x[2] }, ids, '字幕大小：' + x[1]);
    }, 'edQSize'));
    const pro = el('div', 'ed-qpro');
    const pb = el('button', 'ed-linkbtn', '切到專業模式'); pb.type = 'button'; pb.addEventListener('click', () => setUiMode('pro'));
    pro.append(doc.createTextNode('要改字型、顏色、描邊、動畫長度…？'), pb, doc.createTextNode('，專案內容完全一樣。'));
    quick.el.append(pro);
    quick.el.scrollTop = keep;
    return true;
  }

  // =====================================================================================
  // 開始畫面
  // =====================================================================================
  function openStart() {
    if ($('edStart')) return;
    const dlg = el('div', 'ed-start'); dlg.id = 'edStart'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'edStartH');
    const card = el('div', 'ed-start-card');
    const h = el('h2', null, '想做什麼影片？'); h.id = 'edStartH';
    card.append(h, el('div', 'ed-start-sub', '選一個開始，輸出尺寸和版面會自動調好；之後隨時可以改。'));
    const grid = el('div', 'ed-start-grid');
    const opt = (k, title, lines, frame, rec) => {
      const b = el('button', 'ed-start-opt' + (rec ? ' rec' : '')); b.type = 'button'; b.dataset.start = k;
      const fr = el('span', 'ed-start-frame');
      if (frame) { const i = el('i'); i.style.width = frame[0] + 'px'; i.style.height = frame[1] + 'px'; fr.appendChild(i); } else fr.textContent = '⋯';
      b.append(fr, el('strong', null, title), el('span', 'ed-start-desc', lines));
      if (rec) b.append(el('span', 'ed-start-tag', '最常用'));
      b.addEventListener('click', () => choose(k));
      grid.appendChild(b);
      return b;
    };
    const first = opt('vertical', '直式短影音', 'Reels、Shorts、抖音\n9:16・1080×1920\n橫的素材自動加模糊背景', [50, 88], true);
    opt('landscape', '橫式影片', 'YouTube、簡報影片\n16:9・1920×1080', [124, 70]);
    opt('pro', '自己來', '依第一支素材的比例\n直接進專業模式\n（完整的多軌剪輯）', null);
    const drop = el('div', 'ed-start-drop'); drop.append(el('b', null, '也可以直接把影片、照片、音樂拖進來'), doc.createTextNode('，會用直式短影音開始'));
    const foot = el('div', 'ed-start-foot');
    const off = el('label', 'ed-chk'); const cb = el('input'); cb.type = 'checkbox'; cb.id = 'edStartOff';
    off.append(cb, doc.createTextNode('下次不要再顯示'));
    const open = el('button', 'ed-linkbtn', '開啟舊專案…'); open.type = 'button';
    open.addEventListener('click', () => { close(); const b = $('edOpenBtn'); if (b) b.click(); });
    foot.append(off, open);
    card.append(grid, drop, foot);
    dlg.appendChild(card);
    app.appendChild(dlg);
    first.focus();
    function close() {
      if (cb.checked) lsPut(START_KEY, '1');
      dlg.remove();
      doc.removeEventListener('keydown', onKey, true);
    }
    function choose(k) {
      close();
      const asp = k === 'vertical' ? '9:16' : k === 'landscape' ? '16:9' : 'source';
      if (state.project.aspect !== asp) UI.op('輸出比例', p => C.setAspect(p, asp));
      if (k === 'vertical') state.safePref = true;
      UI.syncAspect();
      UI.scheduleStage();
      if (k === 'pro') setUiMode('pro'); else { if (!simple()) setUiMode('simple'); showTips(); }
    }
    function onKey(e) { if (e.key === 'Escape' && $('edStart')) { e.preventDefault(); e.stopPropagation(); choose('vertical'); } }
    doc.addEventListener('keydown', onKey, true);
    dlg.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    dlg.addEventListener('dragleave', () => drop.classList.remove('over'));
    dlg.addEventListener('drop', e => {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files;
      choose('vertical');
      if (files && files.length) UI.importFiles(files);
    });
    UI.startChoose = choose;
  }

  // =====================================================================================
  // 三步教學泡泡
  // =====================================================================================
  const TIPS = [
    ['edSAdd', '按「加素材」或直接把檔案拖進來', '影片、照片會依序排到時間軸，音樂放到「音樂」軌。'],
    ['edTimeline', '點時間軸上的片段', '右邊就會出現它可以調的東西：畫面、動態、轉場、速度、濾鏡。'],
    ['edInspector', '點選項馬上看到效果', '不喜歡就按「復原」。剪好之後按右上角「匯出影片」。'],
  ];
  function showTips(i = 0) {
    const old = $('edTip'); if (old) old.remove();
    if (lsGet(TIPS_KEY) === 'done' || !simple() || i >= TIPS.length) { if (i >= TIPS.length) lsPut(TIPS_KEY, 'done'); return; }
    const [anchorId, title, body] = TIPS[i];
    const a = $(anchorId);
    if (!a) return;
    const tip = el('div', 'ed-tip'); tip.id = 'edTip'; tip.setAttribute('role', 'dialog'); tip.setAttribute('aria-label', '使用教學');
    const n = el('span', 'ed-tip-n', String(i + 1));
    const h = el('div', 'ed-tip-h'); h.append(n, doc.createTextNode(title));
    const act = el('div', 'ed-tip-act');
    const skip = el('button', 'ed-linkbtn', '略過教學'); skip.type = 'button';
    skip.addEventListener('click', () => { lsPut(TIPS_KEY, 'done'); tip.remove(); });
    const next = el('button', 'ed-btn small primary', i + 1 < TIPS.length ? `下一步（${i + 1}／${TIPS.length}）` : '開始剪輯'); next.type = 'button'; next.id = 'edTipNext';
    next.addEventListener('click', () => showTips(i + 1));
    act.append(skip, next);
    tip.append(h, el('div', 'ed-tip-b', body), act);
    app.appendChild(tip);
    // 放在目標旁邊：工具列按鈕的下方、時間軸的上方、詳細內容的左邊
    const r = a.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    let x, y, side;
    if (anchorId === 'edInspector' && r.left - tw - 16 > 8) { x = r.left - tw - 14; y = r.top + 40; side = 'right'; }
    else if (anchorId === 'edTimeline') { x = r.left + 160; y = r.top - th - 14; side = 'down'; }
    else { x = r.left; y = r.bottom + 12; side = 'up'; }
    if (y + th > vh - 8) { y = Math.max(8, r.top - th - 14); side = 'down'; }
    tip.style.left = Math.max(8, Math.min(vw - tw - 8, x)) + 'px';
    tip.style.top = Math.max(8, Math.min(vh - th - 8, y)) + 'px';
    tip.classList.add(side);
    next.focus();
  }

  // =====================================================================================
  // 啟動：init 時由 main 呼叫
  // =====================================================================================
  function initSimple() {
    buildModeSwitch();
    buildSimpleBar();
    setUiMode(state.ui, false);
    // 自動暫存回復等等讓專案有內容時，開始畫面就收起來
    C.bus.addEventListener('change', () => { const s = $('edStart'); if (s && Object.keys(state.project.clips).length) s.remove(); });
    if (!Object.keys(state.project.clips).length && lsGet(START_KEY) !== '1') openStart();
    // 字幕樣式縮圖要等字型好了再畫一次
    if (F.ready) F.ready().then(refreshThumbs).catch(() => {});
    if (F.onFontLoad) F.onFontLoad((id, what) => { if (what === 'loaded') refreshThumbs(); });
  }

  Object.assign(UI, { initSimple, placeImported, renderQuick, setUiMode, showTips, trackLabel, openStart });
  void fmtNum; void R;
})(typeof window !== 'undefined' ? window : globalThis);
