// =====================================================================================
// 剪輯介面：一鍵成片（4.10）
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
//
// 對話框三步：① 選素材（媒體庫裡的影片／照片，點選切換、號碼＝順序）② 選音樂（或不要音樂）③ 選風格。
// 按「產生影片」：有音樂就先偵測節拍（edit-beat.js），再呼叫 core.autoEdit 一次排好（整批一筆復原）。
// 產生的是一般的片段、轉場、關鍵影格，之後在時間軸上照常修改。
// 入口：簡易工具列的「一鍵成片」（UI.openAuto）。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;
  const { $, app, doc, el, fmtNum, fmtSec, say, state } = UI;
  let C = null, R = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; });

  const STYLE_DESC = {
    beat: '每 2 拍換一段・放大縮小交替・閃白',
    gentle: '每小節換一段・慢慢推移・淡化・暖色',
    cinema: '每小節換一段・慢慢放大・浸入黑色・冷色',
  };
  const MAGIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 11-11M14 4l1.5 3L19 8.5 15.5 10 14 13l-1.5-3L9 8.5 12.5 7zM19 14l.8 1.7 1.7.8-1.7.8L19 19l-.8-1.7-1.7-.8 1.7-.8z"/></svg>';

  const auto = { sel: [], music: null, style: 'beat', busy: false };
  const visuals = () => R.media.list().filter(m => m.kind === 'video' || m.kind === 'image');
  const musics = () => R.media.list().filter(m => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio)).sort((a, b) => (a.kind === 'audio' ? 0 : 1) - (b.kind === 'audio' ? 0 : 1));   // 純音樂排前面

  function close() {
    const d = $('edAuto');
    if (d) d.remove();
    doc.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape' && $('edAuto') && !auto.busy) { e.preventDefault(); e.stopPropagation(); close(); }
  }

  // 對話框裡加素材：不要自動排到時間軸（等按「產生影片」才排）
  function addFiles(accept) {
    const old = $('edAutoFile'); if (old) old.remove();          // 上次取消選檔留下的
    const inp = el('input'); inp.type = 'file'; inp.multiple = true; inp.accept = accept; inp.hidden = true; inp.id = 'edAutoFile';
    inp.addEventListener('cancel', () => inp.remove());
    inp.addEventListener('change', async () => {
      const before = new Set(R.media.list().map(m => m.id));
      state.autoPicking = true;
      try { await UI.importFiles(inp.files); } finally { state.autoPicking = false; inp.remove(); }
      const fresh = R.media.list().filter(m => !before.has(m.id));
      for (const m of fresh) {
        if ((m.kind === 'video' || m.kind === 'image') && accept !== 'audio/*') auto.sel.push(m.id);
        else if (m.kind === 'audio' && (accept === 'audio/*' || !auto.music)) auto.music = m.id;   // 從「加音樂…」加的：直接選它
      }
      render();
    });
    doc.body.appendChild(inp);
    inp.click();
  }

  function openAuto() {
    if (auto.busy) return;
    close();
    UI.closePop();
    const vs = visuals(), ms = musics();
    auto.sel = vs.map(m => m.id);
    const pure = ms.filter(m => m.kind === 'audio');
    if (!auto.music || !ms.some(m => m.id === auto.music)) auto.music = pure.length ? pure[0].id : null;
    const dlg = el('div', 'ed-start ed-auto'); dlg.id = 'edAuto'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'edAutoH');
    dlg.addEventListener('pointerdown', e => { if (e.target === dlg && !auto.busy) close(); });
    app.appendChild(dlg);
    doc.addEventListener('keydown', onKey, true);
    render();
    const go = $('edAutoGo'); if (go && !go.disabled) go.focus();
  }

  function render() {
    const dlg = $('edAuto');
    if (!dlg) return;
    const keep = dlg.firstChild ? dlg.firstChild.scrollTop : 0;
    dlg.textContent = '';
    const card = el('div', 'ed-start-card ed-auto-card');
    const h = el('h2', null, '一鍵成片'); h.id = 'edAutoH';
    card.append(h, el('div', 'ed-start-sub', '選素材和音樂、挑一個風格，自動排好、對好拍子、加上動態和轉場。產生後每一段都還能再改。'));
    const steps = el('div', 'ed-auto-steps');
    const step = (n, title) => {
      const s = el('div', 'ed-auto-step');
      const hd = el('h3'); hd.append(el('span', 'ed-auto-n', String(n)), doc.createTextNode(title));
      s.appendChild(hd);
      steps.appendChild(s);
      return s;
    };

    // ① 素材
    const vs = visuals();
    auto.sel = auto.sel.filter(id => vs.some(m => m.id === id));
    const s1 = step(1, `選素材（${auto.sel.length}／${vs.length}）`);
    const grid = el('div', 'ed-auto-thumbs'); grid.id = 'edAutoMedia';
    for (const m of vs) {
      const i = auto.sel.indexOf(m.id);
      const b = el('button', 'ed-auto-th' + (i >= 0 ? ' on' : '')); b.type = 'button'; b.dataset.media = m.id;
      b.setAttribute('aria-pressed', String(i >= 0)); b.title = m.name + (m.kind === 'image' ? '' : `（${fmtSec(m.duration)}）`);
      const cv = el('canvas'); cv.width = 160; cv.height = 90;
      if (UI.paintMediaThumb) UI.paintMediaThumb(cv, m);
      b.append(cv, el('span', 'ed-auto-ord', i >= 0 ? String(i + 1) : ''), el('span', 'ed-auto-name', m.name));
      b.addEventListener('click', () => {
        const k = auto.sel.indexOf(m.id);
        if (k >= 0) auto.sel.splice(k, 1); else auto.sel.push(m.id);
        render();
      });
      grid.appendChild(b);
    }
    const addV = el('button', 'ed-auto-th ed-auto-add'); addV.type = 'button'; addV.id = 'edAutoAdd';
    addV.append(el('b', null, '＋'), el('span', 'ed-auto-name', '加素材'));
    addV.addEventListener('click', () => addFiles('video/*,image/*'));
    grid.appendChild(addV);
    s1.append(grid, el('div', 'ed-auto-hint', '點一下選取／取消，號碼是播放順序（取消再點會排到最後）'));

    // ② 音樂
    const s2 = step(2, '選音樂');
    const ml = el('div', 'ed-auto-list'); ml.id = 'edAutoMusic'; ml.setAttribute('role', 'radiogroup'); ml.setAttribute('aria-label', '音樂');
    const opt = (id, title, sub) => {
      const on = auto.music === id;
      const b = el('button', 'ed-auto-opt' + (on ? ' on' : '')); b.type = 'button'; b.dataset.music = id || '';
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
      b.append(el('b', null, title), el('span', null, sub));
      b.addEventListener('click', () => { auto.music = id; render(); });
      ml.appendChild(b);
    };
    for (const m of musics()) opt(m.id, m.name, `${m.kind === 'audio' ? '音樂' : '影片的聲音'}・${fmtSec(m.duration)}・跟著拍子換`);
    opt(null, '不要音樂', '每段固定長度，保留影片原聲');
    const addM = el('button', 'ed-linkbtn', '加音樂…'); addM.type = 'button'; addM.id = 'edAutoAddMusic';
    addM.addEventListener('click', () => addFiles('audio/*'));
    s2.append(ml, addM);

    // ③ 風格
    const s3 = step(3, '風格');
    const sl = el('div', 'ed-auto-list'); sl.id = 'edAutoStyle'; sl.setAttribute('role', 'radiogroup'); sl.setAttribute('aria-label', '風格');
    for (const k of Object.keys(C.AUTO_STYLES)) {
      const on = auto.style === k;
      const b = el('button', 'ed-auto-opt' + (on ? ' on' : '')); b.type = 'button'; b.dataset.style = k;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
      b.append(el('b', null, C.AUTO_STYLES[k].name), el('span', null, STYLE_DESC[k] || ''));
      b.addEventListener('click', () => { auto.style = k; render(); });
      sl.appendChild(b);
    }
    s3.appendChild(sl);
    card.appendChild(steps);

    // 摘要＋按鈕
    const st = C.AUTO_STYLES[auto.style], p = state.project;
    const sum = el('div', 'ed-auto-sum'); sum.id = 'edAutoSum';
    const outName = p.aspect === 'source' ? `${p.width}×${p.height}` : p.aspect;
    const has = Object.keys(p.clips).length > 0;
    sum.append(el('b', null, auto.sel.length ? `${auto.sel.length} 段` : '還沒選素材'),
      doc.createTextNode(auto.music ? `・跟著拍子換，至少每 ${st.every} 拍一段（素材少會拉長，盡量配滿整首歌）` : `・每段約 ${fmtNum(st.sec, 1)} 秒、共約 ${fmtNum(auto.sel.length * st.sec, 1)} 秒`),
      doc.createTextNode(`・輸出 ${outName}・比例不同的自動加模糊背景`),
      el('br'), el('span', 'ed-auto-hint', (has ? '會接在時間軸目前內容的後面。' : '') + '產生後整批按一次「復原」就能取消。'));
    const status = el('div', 'ed-auto-status'); status.id = 'edAutoStatus'; status.setAttribute('role', 'status');
    const foot = el('div', 'ed-auto-foot');
    const cancel = el('button', 'ed-btn', '取消'); cancel.type = 'button'; cancel.addEventListener('click', close);
    const go = el('button', 'ed-btn primary', '產生影片'); go.type = 'button'; go.id = 'edAutoGo'; go.disabled = !auto.sel.length || auto.busy;
    go.addEventListener('click', generate);
    foot.append(status, cancel, go);
    card.append(sum, foot);
    dlg.appendChild(card);
    card.scrollTop = keep;
  }

  // 音樂的拍點（來源秒數）；偵測不到就回空陣列（core 會用固定長度）
  async function musicBeats(id) {
    let buf = null;
    try { buf = await R.media.decodeAudio(id); } catch (_) { buf = null; }
    if (!buf) return null;
    const chans = []; for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) chans.push(buf.getChannelData(i));
    return Q.beat.detect(chans, buf.sampleRate, {});
  }

  async function generate() {
    if (auto.busy || !auto.sel.length) return;
    auto.busy = true;
    const go = $('edAutoGo'), status = $('edAutoStatus');
    if (go) go.disabled = true;
    let beats = [], bpm = 0;
    try {
      if (auto.music) {
        if (status) status.textContent = '分析音樂節拍中…';
        const r = await musicBeats(auto.music);
        if (!r) { auto.busy = false; if (go) go.disabled = false; if (status) status.textContent = ''; say('讀不到音樂的聲音，換一首或選「不要音樂」', 'error'); return; }
        beats = r.beats; bpm = r.bpm;
      }
    } catch (e) { beats = []; }
    auto.busy = false;
    const res = UI.op('一鍵成片', p => C.autoEdit(p, { mediaIds: auto.sel.slice(), musicId: auto.music, beats, style: auto.style }), null);
    if (!res || !res.ok) { if (go) go.disabled = false; if (status) status.textContent = ''; return; }
    close();
    UI.selectClips([]);
    UI.seekTimeline(res.start);
    const secs = (res.end - res.start) / state.project.fps;
    const beatMsg = auto.music ? (beats.length ? `，跟著約 ${fmtNum(bpm, 0)} BPM 的拍子` : '（音樂沒抓到明顯的節拍，用固定長度）') : '';
    say(`已產生 ${res.count} 段、${fmtNum(secs, 1)} 秒的影片${beatMsg}。按空白鍵播放；不滿意按「復原」`, 'ok');
  }

  function initAuto() {
    const bar = $('edSimpleBar');
    if (bar && !$('edSAuto')) {
      const b = el('button', 'ed-sbtn ed-sbtn-hi'); b.type = 'button'; b.id = 'edSAuto';
      b.title = '選素材和音樂、挑風格，自動排好、對拍子、加動態和轉場';
      b.innerHTML = MAGIC; b.append(el('span', null, '一鍵成片'));
      b.addEventListener('click', openAuto);
      const hint = bar.querySelector('.ed-shint');
      bar.insertBefore(el('span', 'ed-ssep'), hint);
      bar.insertBefore(b, hint);
    }
  }

  Object.assign(UI, { initAuto, openAuto });
})(typeof window !== 'undefined' ? window : globalThis);
