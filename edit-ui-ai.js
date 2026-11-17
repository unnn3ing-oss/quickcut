// =====================================================================================
// 剪輯介面：AI 剪輯（5.00）
// 從 edit-ui.js 拆出來的一段（共用的狀態、小工具與拆檔方式見 edit-ui.js 檔頭）。
//
// 對話框兩步：
//   ① 匯出素材摘要包：逐支影片取樣（亮度、過曝、清晰度、位移、晃動）、畫聯絡表（每格印「代號 秒數」）、
//      分析音樂節拍與能量，存成 summary.json＋sheet-NN.jpg。使用者把這包交給 Claude、描述想要的風格。
//   ② 貼上 Claude 回的剪輯腳本 → core.applyScript 一次排好（整批一筆復原）。
// 計算都在 edit-ai.js（純函式）與 core.applyScript；這裡只負責抓畫面、畫圖、存檔與對話框。
// 工具本身不連網：送給 Claude 的只有縮圖與數據，由使用者自己上傳。
// 入口：簡易工具列與專業工具列的「AI 剪輯」（UI.openAi）。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit;
  const UI = Q && Q.uiParts;
  if (!UI) return;
  const { $, app, doc, el, fmtSec, say, state } = UI;
  let C = null, R = null, F = null, A = null;
  UI.binders.push(() => { C = Q.core; R = Q.render; F = Q.fx; A = Q.ai; });

  const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>';
  const THUMB_W = 384, THUMB_H = 216;
  const BUILTIN = '__builtin';

  // gamma：使用者選的（或從檔案讀到的）伽瑪；cache：分析結果（換素材才重算）；refs：上次匯出的 代號 → mediaId
  const ai = { busy: false, cancel: false, music: null, gamma: {}, gammaFrom: {}, lut: '', cache: new Map(), refs: {}, text: '', errors: [], warnings: [], done: '', beats: new Map() };
  const visuals = () => R.media.list().filter(m => m.kind === 'video' || m.kind === 'image');
  const musics = () => R.media.list().filter(m => m.kind === 'audio');
  const codeOf = i => 'C' + String(i + 1).padStart(2, '0');
  const isLog = id => ai.gamma[id] === 'slog3';

  function close() {
    if (ai.busy) { ai.cancel = true; return; }
    const d = $('edAi');
    if (d) d.remove();
    doc.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape' && $('edAi')) { e.preventDefault(); e.stopPropagation(); close(); }
  }
  const setStatus = t => { const s = $('edAiStatus'); if (s) s.textContent = t || ''; };

  // ---- 伽瑪：讀 Sony 檔案內嵌的資訊（檔頭與檔尾各 4MB）-------------------------------------
  async function sniffGamma(m) {
    if (ai.gamma[m.id] || !m.file || m.kind !== 'video') return;
    ai.gamma[m.id] = 'std'; ai.gammaFrom[m.id] = 'default';
    const SPAN = 4 << 20;
    try {
      const parts = [[0, Math.min(SPAN, m.file.size)]];
      if (m.file.size > SPAN) parts.push([Math.max(SPAN, m.file.size - SPAN), m.file.size]);
      for (const [a, b] of parts) {
        const r = A.detectGamma(new Uint8Array(await m.file.slice(a, b).arrayBuffer()));
        if (r) { ai.gamma[m.id] = r.gamma; ai.gammaFrom[m.id] = 'file'; return; }
      }
    } catch (_) { /* 讀不到就當標準 */ }
  }

  // ---- 抓畫面 ---------------------------------------------------------------------------
  function openVideo(m) {
    return new Promise((res, rej) => {
      const v = doc.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true;
      const to = setTimeout(() => rej(new Error('timeout')), 20000);
      v.addEventListener('loadeddata', () => { clearTimeout(to); res(v); }, { once: true });
      v.addEventListener('error', () => { clearTimeout(to); rej(new Error('error')); }, { once: true });
      v.src = m.url;
    });
  }
  function seek(v, t) {
    return new Promise(res => {
      t = Math.max(0, Math.min(t, (v.duration || t) - 0.04));
      if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) { res(); return; }
      const to = setTimeout(res, 8000);
      v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
      v.currentTime = t;
    });
  }
  // 縮圖：完整放進 384×216（直拍左右留黑）
  function grabThumb(src, sw, sh) {
    const cv = doc.createElement('canvas'); cv.width = THUMB_W; cv.height = THUMB_H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#111'; g.fillRect(0, 0, THUMB_W, THUMB_H);
    const k = Math.min(THUMB_W / sw, THUMB_H / sh), w = sw * k, h = sh * k;
    g.drawImage(src, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
    return cv;
  }
  // 一支影片：每 step 秒取樣一次數據；thumbTimes 的時間點另外留縮圖。結果存在 ai.cache（之後只補缺的縮圖）
  async function analyze(m, thumbTimes, onProg) {
    let c = ai.cache.get(m.id);
    if (!c) { c = { samples: null, step: A.sampleStep(m.duration), thumbs: new Map() }; ai.cache.set(m.id, c); }
    const need = thumbTimes.filter(t => !c.thumbs.has(t));
    if (c.samples && !need.length) return c;
    const v = await openVideo(m);
    try {
      const cv = doc.createElement('canvas'); cv.width = A.AW; cv.height = A.AH;
      const g = cv.getContext('2d', { willReadFrequently: true });
      const stats = () => { g.drawImage(v, 0, 0, A.AW, A.AH); return A.frameStats(g.getImageData(0, 0, A.AW, A.AH).data, A.AW, A.AH); };
      const want = new Set(need);
      if (!c.samples) {
        const out = [], n = Math.max(1, Math.ceil((m.duration - 0.05) / c.step));
        let prev = null;
        for (let i = 0; i < n; i++) {
          if (ai.cancel) throw new Error('cancel');
          const t = Math.round(i * c.step * 100) / 100;
          await seek(v, t);
          const s = stats();
          if (want.has(t)) { c.thumbs.set(t, grabThumb(v, v.videoWidth, v.videoHeight)); want.delete(t); }
          let vx = 0, vy = 0;
          if (t + A.PAIR < m.duration - 0.05) {
            await seek(v, t + A.PAIR);
            const s2 = stats(), d = A.shift(s.gray, s2.gray, A.AW, A.AH);
            vx = d.dx / A.AW * 100 / A.PAIR; vy = d.dy / A.AH * 100 / A.PAIR;
          }
          out.push({ t, luma: s.luma, over: s.over, under: s.under, p1: s.p1, p99: s.p99, sat: s.sat, sharp: s.sharp, vx, vy, change: prev ? A.diff(prev, s.gray) : 0 });
          prev = s.gray;
          if (onProg) onProg((i + 1) / n);
        }
        c.samples = out;
      }
      for (const t of want) {
        if (ai.cancel) throw new Error('cancel');
        await seek(v, t);
        c.thumbs.set(t, grabThumb(v, v.videoWidth, v.videoHeight));
      }
    } finally { v.removeAttribute('src'); v.load(); }
    return c;
  }

  // ---- 聯絡表 ---------------------------------------------------------------------------
  function drawSheet(cells, lut) {
    const { cols, width } = A.SHEET, cw = width / cols, ch = Math.round(cw * 9 / 16), rows = Math.ceil(cells.length / cols);
    const cv = doc.createElement('canvas'); cv.width = width; cv.height = rows * ch;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    cells.forEach((c, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      let th = c.thumb;
      if (th && c.log && lut) {                       // Log 素材：先轉成正常顏色，Claude 才看得出真實的樣子
        const t2 = doc.createElement('canvas'); t2.width = th.width; t2.height = th.height;
        const g2 = t2.getContext('2d'), id = th.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, th.width, th.height);
        A.applyLut(id.data, lut); g2.putImageData(id, 0, 0); th = t2;
      }
      if (th) g.drawImage(th, x + 1, y + 1, cw - 2, ch - 2);
      const label = c.kind === 'image' ? `${c.code} 照片` : `${c.code} ${c.t.toFixed(1)}s`;
      g.font = 'bold 22px ui-monospace, Menlo, Consolas, monospace';
      const tw = g.measureText(label).width;
      g.fillStyle = 'rgba(0,0,0,.78)'; g.fillRect(x + 1, y + 1, tw + 14, 30);
      g.fillStyle = c.first ? '#ffe14d' : '#fff'; g.textBaseline = 'middle'; g.fillText(label, x + 8, y + 17);
    });
    return new Promise(res => cv.toBlob(b => res(b), 'image/jpeg', 0.82));
  }

  // 音樂的拍點與能量（快取）
  async function musicInfo(id) {
    if (ai.beats.has(id)) return ai.beats.get(id);
    let buf = null;
    try { buf = await R.media.decodeAudio(id); } catch (_) { buf = null; }
    if (!buf) return null;
    const chans = []; for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) chans.push(buf.getChannelData(i));
    const b = Q.beat.detect(chans, buf.sampleRate, {});
    const r = { beats: b.beats, bpm: b.bpm, energy: A.energy(chans, buf.sampleRate) };
    ai.beats.set(id, r);
    return r;
  }
  function caps() {
    const tp = {};
    for (const [k, v] of Object.entries(F.TITLE_PRESETS || {})) tp[k] = v.name;
    return { aspects: Object.keys(C.ASPECTS), transitions: C.TRANSITION_TYPES, motions: C.KF_PRESETS, looks: C.LOOKS, cc: C.SCRIPT_CC, fits: C.FIT_MODES, letterboxes: C.LETTERBOXES, titlePresets: tp };
  }
  // S-Log3 用哪個 LUT：專案裡的（使用者匯入的 .cube）或內建近似。回傳 { size, data } 或 null
  function lutFor() {
    if (ai.lut === BUILTIN) return A.slog3Lut();
    return ai.lut ? C.lutData(state.project, ai.lut) : null;
  }

  // 分析全部素材，回傳 { summary, files: [{ name, blob }] }（不存檔；測試也用這個）
  async function buildPack(onStatus) {
    const vs = visuals(), items = vs.map((m, i) => ({ code: codeOf(i), duration: m.kind === 'video' ? m.duration : 0 }));
    const plan = A.planSheets(items);
    const byCode = new Map(vs.map((m, i) => [codeOf(i), m]));
    const lut = lutFor();
    const clips = [], cells = [];
    for (let i = 0; i < vs.length; i++) {
      const m = vs[i], code = codeOf(i), mine = plan.cells.filter(c => c.code === code);
      const base = { code, name: m.name, kind: m.kind, width: m.width, height: m.height };
      if (m.kind === 'image') {
        clips.push(base);
        cells.push({ code, t: 0, kind: 'image', first: true, thumb: m.image ? grabThumb(m.image, m.image.width, m.image.height) : null });
        continue;
      }
      const c = await analyze(m, mine.map(x => x.t), f => onStatus && onStatus(`分析素材 ${i + 1}／${vs.length}：${m.name}（${Math.round(f * 100)}%）`));
      let gamma = ai.gamma[m.id] || 'std', from = ai.gammaFrom[m.id] || 'default';
      if (from === 'default' && A.looksLog(c.samples)) from = 'looks-like-log';
      clips.push(Object.assign(base, { duration: m.duration, fps: m.fps, hasAudio: m.hasAudio, gamma, gammaFrom: from, samples: c.samples.map(s => Object.assign({}, s)), step: c.step }));
      mine.forEach((x, k) => cells.push({ code, t: x.t, kind: 'video', first: k === 0, log: isLog(m.id), thumb: c.thumbs.get(x.t) || null }));
    }
    let music = null;
    const mm = ai.music && R.media.get(ai.music);
    if (mm) {
      if (onStatus) onStatus('分析音樂節拍…');
      const r = await musicInfo(mm.id);
      if (r) music = { code: 'M1', name: mm.name, duration: mm.duration, bpm: r.bpm, beats: r.beats, energy: r.energy };
    }
    const files = [], per = plan.perSheet;
    for (let i = 0, n = 1; i < cells.length; i += per, n++) {
      if (onStatus) onStatus(`畫聯絡表 ${n}／${Math.ceil(cells.length / per)}…`);
      files.push({ name: `sheet-${String(n).padStart(2, '0')}.jpg`, blob: await drawSheet(cells.slice(i, i + per), lut) });
    }
    const summary = A.buildSummary({ project: state.project, clips, music, caps: caps(), interval: plan.interval, sheets: files.map(f => f.name) });
    ai.refs = {};
    for (const [code, m] of byCode) ai.refs[code] = m.id;
    if (mm) ai.refs.M1 = mm.id;
    files.unshift({ name: 'summary.json', blob: new Blob([JSON.stringify(summary)], { type: 'application/json' }) });
    return { summary, files };
  }

  // 存檔：能選資料夾就寫進「qc-pack-日期時間」子資料夾；不行就一個一個下載
  async function savePack(files) {
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const stamp = `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    if (typeof root.showDirectoryPicker === 'function' && !UI.aiNoPicker) {
      let dir = null;
      try { dir = await root.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { if (e && e.name === 'AbortError') return null; dir = null; }
      if (dir) {
        try {
          const sub = await dir.getDirectoryHandle(`qc-pack-${stamp}`, { create: true });
          for (const f of files) { const h = await sub.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.blob); await w.close(); }
          return `資料夾「${sub.name}」`;
        } catch (_) { /* 寫不進去：改用下載 */ }
      }
    }
    for (const f of files) {
      const a = doc.createElement('a');
      a.download = `qc-pack-${stamp}-${f.name}`; a.href = URL.createObjectURL(f.blob);
      doc.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      await new Promise(r => setTimeout(r, 250));           // 連續下載太快瀏覽器會擋
    }
    return '下載資料夾';
  }

  async function exportPack() {
    if (ai.busy) return;
    const vs = visuals();
    if (!vs.length) { say('先匯入要剪的影片或照片', 'error'); return; }
    if (vs.some(m => isLog(m.id)) && !ai.lut) { say('有 S-Log3 素材：先選一個轉換用的 LUT（匯入 .cube，或用內建近似轉換）', 'error'); return; }
    ai.busy = true; ai.cancel = false; ai.done = '';
    render();
    let pack = null, where = null, err = '';
    try {
      pack = await buildPack(setStatus);
      setStatus('選擇要存的位置…');
      where = await savePack(pack.files);
    } catch (e) { err = e && e.message === 'cancel' ? 'cancel' : '分析失敗：' + ((e && e.message) || e); }
    ai.busy = false; ai.cancel = false;
    if (err === 'cancel') { render(); setStatus('已取消'); return; }
    if (err) { render(); say(err, 'error'); return; }
    if (where) {
      const maybe = pack.summary.clips.filter(c => c.gammaFrom === 'looks-like-log').map(c => c.file);
      ai.done = `已存到${where}：summary.json＋${pack.files.length - 1} 張聯絡表。把整包上傳給 Claude，描述你要的風格。` + (maybe.length ? `（${maybe.join('、')} 看起來像 Log：如果是，把伽瑪改成 S-Log3 再匯出一次）` : '');
    }
    render();
  }

  // ---- 套用腳本 -------------------------------------------------------------------------
  async function applyText() {
    if (ai.busy) return;
    const ta = $('edAiText'); if (ta) ai.text = ta.value;
    ai.errors = []; ai.warnings = [];
    const parsed = A.parseScriptText(ai.text);
    if (!parsed.ok) { ai.errors = [parsed.reason]; render(); return; }
    const s = parsed.script, p = state.project;
    // 音樂的拍點（腳本的 media 對照表 → 檔名 → 素材）
    let beats = [];
    const mref = s.music && s.music.ref, mname = mref != null && s.media && s.media[mref] != null ? s.media[mref] : mref;
    const mm = mref == null ? null : R.media.list().find(m => m.name === mname) || R.media.get(ai.refs[mref]);
    if (mm) {
      ai.busy = true; render(); setStatus('分析音樂節拍…');
      try { const r = await musicInfo(mm.id); if (r) beats = r.beats; } catch (_) { beats = []; }
      ai.busy = false;
    }
    const logs = R.media.list().filter(m => isLog(m.id));
    if (logs.length && !ai.lut) { ai.errors = ['有 S-Log3 素材：先在左邊選一個轉換用的 LUT']; render(); return; }
    const res = UI.op('AI 剪輯', q => {
      const lutByMedia = {};
      if (logs.length) {
        let id = ai.lut;
        if (id === BUILTIN) { const a = C.addLut(q, A.slog3Lut()); if (!a.ok) return a; id = a.id; }
        for (const m of logs) lutByMedia[m.id] = id;
      }
      return C.applyScript(q, s, { beats, refs: ai.refs, lutByMedia, titlePresets: Object.keys(F.TITLE_PRESETS || {}), makeTitle: (preset, text) => F.makeTitle(preset, text) });
    }, null);
    if (!res || !res.ok) { ai.errors = res && res.errors ? res.errors : [(res && res.reason) || '套用失敗']; render(); return; }
    ai.warnings = res.warnings || [];
    UI.selectClips([]);
    UI.seekTimeline(res.start);
    const msg = `已照腳本排好 ${res.count} 段、${(( res.end - res.start) / p.fps).toFixed(1)} 秒。按空白鍵播放；不滿意按「復原」`;
    if (ai.warnings.length) { ai.done = msg; render(); } else { ai.done = ''; close(); }
    say(msg + (ai.warnings.length ? `（有 ${ai.warnings.length} 個提醒）` : ''), 'ok');
  }
  function pickScriptFile() {
    const inp = el('input'); inp.type = 'file'; inp.accept = '.json,.txt,.md,application/json,text/plain'; inp.hidden = true; inp.id = 'edAiFile';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      try { ai.text = await f.text(); } catch (_) { say('讀不到這個檔案', 'error'); return; }
      render();
    });
    doc.body.appendChild(inp); inp.click();
  }
  function pickLut() {
    const inp = el('input'); inp.type = 'file'; inp.accept = '.cube'; inp.hidden = true; inp.id = 'edAiLutFile';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      let text; try { text = await f.text(); } catch (_) { say('讀不到 LUT 檔', 'error'); return; }
      const lut = C.parseCube(text, f.name);
      if (!lut.ok) { say(lut.reason, 'error'); return; }
      const r = UI.op('匯入 LUT', p => C.addLut(p, lut), `已匯入 LUT「${lut.name}」`);
      if (r && r.ok) { ai.lut = r.id; render(); }
    });
    doc.body.appendChild(inp); inp.click();
  }

  // ---- 對話框 ---------------------------------------------------------------------------
  function openAi() {
    if ($('edAi')) return;
    UI.closePop();
    const ms = musics();
    if (!ai.music || !ms.some(m => m.id === ai.music)) ai.music = ms.length ? ms[0].id : null;
    const luts = state.project.luts || {};
    if (ai.lut && ai.lut !== BUILTIN && !luts[ai.lut]) ai.lut = '';
    if (!ai.lut && Object.keys(luts).length) ai.lut = Object.keys(luts)[0];
    ai.errors = []; ai.warnings = []; ai.done = '';
    const dlg = el('div', 'ed-start ed-auto ed-ai'); dlg.id = 'edAi'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'edAiH');
    dlg.addEventListener('pointerdown', e => { if (e.target === dlg && !ai.busy) close(); });
    app.appendChild(dlg);
    doc.addEventListener('keydown', onKey, true);
    render();
    Promise.all(visuals().map(sniffGamma)).then(() => { if ($('edAi') && !ai.busy) render(); });
  }

  function render() {
    const dlg = $('edAi');
    if (!dlg) return;
    const ta0 = $('edAiText'); if (ta0) ai.text = ta0.value;
    dlg.textContent = '';
    const card = el('div', 'ed-start-card ed-auto-card');
    const h = el('h2', null, 'AI 剪輯'); h.id = 'edAiH';
    card.append(h, el('div', 'ed-start-sub', '讓 Claude 當剪輯師：工具把素材整理成「摘要包」（縮圖＋數據，原始影片不會離開電腦），你上傳給 Claude 並描述風格，再把它回的「剪輯腳本」貼回來，自動排好。'));
    const steps = el('div', 'ed-auto-steps ed-ai-steps');
    const step = (n, title) => {
      const s = el('div', 'ed-auto-step');
      const hd = el('h3'); hd.append(el('span', 'ed-auto-n', String(n)), doc.createTextNode(title));
      s.appendChild(hd); steps.appendChild(s);
      return s;
    };

    // ① 摘要包
    const vs = visuals();
    const s1 = step(1, `匯出素材摘要包（${vs.length} 個素材）`);
    const list = el('div', 'ed-ai-media'); list.id = 'edAiMedia';
    vs.forEach((m, i) => {
      const row = el('div', 'ed-ai-row'); row.dataset.media = m.id;
      row.append(el('b', null, codeOf(i)), el('span', 'ed-ai-name', m.name), el('span', 'ed-ai-dur', m.kind === 'image' ? '照片' : fmtSec(m.duration)));
      if (m.kind === 'video') {
        const sel = el('select', 'ed-ai-gamma'); sel.setAttribute('aria-label', `${m.name} 的伽瑪`); sel.disabled = ai.busy;
        for (const k of ['std', 'scinetone', 'slog3']) { const o = el('option', null, A.GAMMAS[k]); o.value = k; sel.appendChild(o); }
        const cur = ai.gamma[m.id] || 'std';
        if (!['std', 'scinetone', 'slog3'].includes(cur)) { const o = el('option', null, A.GAMMAS[cur] || cur); o.value = cur; sel.appendChild(o); }
        sel.value = cur;
        sel.title = ai.gammaFrom[m.id] === 'file' ? '從檔案讀到的' : '檔案裡沒有伽瑪資訊：請自己選';
        sel.addEventListener('change', () => { ai.gamma[m.id] = sel.value; ai.gammaFrom[m.id] = 'user'; render(); });
        row.appendChild(sel);
      }
      list.appendChild(row);
    });
    if (!vs.length) list.appendChild(el('div', 'ed-auto-hint', '媒體庫裡還沒有影片或照片：先關掉這個視窗匯入素材。'));
    s1.appendChild(list);
    const field = (label, sel) => { const f = el('label', 'ed-ai-field'); f.append(el('span', null, label), sel); return f; };
    if (vs.some(m => isLog(m.id))) {
      const sel = el('select'); sel.id = 'edAiLut'; sel.disabled = ai.busy;
      const add = (v, t) => { const o = el('option', null, t); o.value = v; sel.appendChild(o); };
      add('', '請選擇…');
      for (const [id, r] of Object.entries(state.project.luts || {})) add(id, r.name);
      add(BUILTIN, '內建近似轉換（沒有 LUT 檔時用）');
      add('__import', '匯入 .cube 檔…');
      sel.value = ai.lut;
      sel.addEventListener('change', () => { if (sel.value === '__import') { sel.value = ai.lut; pickLut(); } else { ai.lut = sel.value; render(); } });
      s1.append(field('S-Log3 轉換 LUT', sel), el('div', 'ed-auto-hint', '聯絡表和排好的片段都會套這個 LUT。建議用 Sony 官方或你平常用的 S-Log3 → 709 LUT。'));
    }
    const msel = el('select'); msel.id = 'edAiMusic'; msel.disabled = ai.busy;
    { const o = el('option', null, '不要音樂'); o.value = ''; msel.appendChild(o); }
    for (const m of musics()) { const o = el('option', null, `${m.name}（${fmtSec(m.duration)}）`); o.value = m.id; msel.appendChild(o); }
    msel.value = ai.music || '';
    msel.addEventListener('change', () => { ai.music = msel.value || null; });
    s1.appendChild(field('配樂', msel));
    const go = el('button', 'ed-btn primary', ai.busy ? '分析中…' : '分析並匯出摘要包'); go.type = 'button'; go.id = 'edAiExport'; go.disabled = ai.busy || !vs.length;
    go.addEventListener('click', exportPack);
    s1.append(go, el('div', 'ed-auto-hint', '4K 素材每分鐘大約要分析半分鐘到一分半鐘。同一批素材第二次匯出不用重算。'));

    // ② 腳本
    const s2 = step(2, '貼上 Claude 回的剪輯腳本');
    const ta = el('textarea', 'ed-ai-text'); ta.id = 'edAiText'; ta.spellcheck = false; ta.value = ai.text; ta.disabled = ai.busy;
    ta.placeholder = '把 Claude 的回覆整段貼在這裡（有 ```json 的那一段就可以，前後的說明文字不用刪）';
    ta.setAttribute('aria-label', '剪輯腳本');
    const file = el('button', 'ed-linkbtn', '或選腳本檔…'); file.type = 'button'; file.id = 'edAiPick'; file.addEventListener('click', pickScriptFile);
    const apply = el('button', 'ed-btn primary', '照腳本排到時間軸'); apply.type = 'button'; apply.id = 'edAiApply'; apply.disabled = ai.busy;
    apply.addEventListener('click', applyText);
    s2.append(ta, file);
    const box = (id, cls, title, items) => {
      const b = el('div', 'ed-ai-msg ' + cls); b.id = id; b.setAttribute('role', cls === 'err' ? 'alert' : 'status');
      b.appendChild(el('b', null, title));
      const ul = el('ul'); for (const t of items) ul.appendChild(el('li', null, t)); b.appendChild(ul);
      return b;
    };
    if (ai.errors.length) s2.appendChild(box('edAiErrors', 'err', ai.errors.length > 1 ? `腳本有 ${ai.errors.length} 個問題，沒有套用。把下面這些貼回去請 Claude 修正：` : '沒有套用：', ai.errors));
    if (ai.warnings.length) s2.appendChild(box('edAiWarnings', 'warn', '已排好，有幾個地方和腳本不一樣：', ai.warnings));
    s2.append(apply, el('div', 'ed-auto-hint', '會接在時間軸目前內容的後面；整批按一次「復原」就能取消。想修改就回去跟 Claude 說要改哪裡，復原後再貼一次新腳本。'));
    card.appendChild(steps);

    const status = el('div', 'ed-auto-status'); status.id = 'edAiStatus'; status.setAttribute('role', 'status'); status.textContent = ai.done;
    const foot = el('div', 'ed-auto-foot');
    const cancel = el('button', 'ed-btn', ai.busy ? '取消分析' : '關閉'); cancel.type = 'button'; cancel.id = 'edAiClose'; cancel.addEventListener('click', close);
    foot.append(status, cancel);
    card.appendChild(foot);
    dlg.appendChild(card);
  }

  function initAi() {
    const bar = $('edSimpleBar');
    if (bar && !$('edSAi')) {
      const b = el('button', 'ed-sbtn ed-sbtn-hi'); b.type = 'button'; b.id = 'edSAi';
      b.title = '把素材整理成摘要包交給 Claude，再照它寫的剪輯腳本自動排好';
      b.innerHTML = SPARK; b.append(el('span', null, 'AI 剪輯'));
      b.addEventListener('click', openAi);
      bar.insertBefore(b, bar.querySelector('.ed-shint'));
    }
  }

  Object.assign(UI, { initAi, openAi, aiBuildPack: buildPack, aiState: ai });
})(typeof window !== 'undefined' ? window : globalThis);
