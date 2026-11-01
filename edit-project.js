// =====================================================================================
// 剪輯：專案存檔／開檔、自動暫存、重新連結素材
//
// 專案檔（.qcut，JSON）只存剪輯資料（時間軸、片段、字幕、轉場、設定）與每個素材的「檔名＋大小＋修改時間」，
// 不存影片本身，所以檔案只有幾 KB。開啟後缺少的素材依序這樣接回來：
//   1. 開檔前已經在媒體庫的檔案：檔名對得上就直接沿用
//   2. 記住的檔案位置（FileSystemFileHandle，存在 IndexedDB；Chrome／Edge）：已經有權限的自動接回，
//      沒有權限的在媒體庫上方按一次「允許存取」就全部接回
//   3. 選資料夾（showDirectoryPicker）：依檔名＋大小自動比對，子資料夾也會找
//   4. 手動選檔或拖進來：一樣自動比對
// 自動暫存：每次改動後約 1.5 秒存進 IndexedDB，下次打開會問要不要還原。
//
// 上半部是純函式（node 可測，module.exports）；下半部是瀏覽器端的接線（QPTEdit.project）。
// =====================================================================================
(function (root) {
  'use strict';

  const FORMAT = 'quickcut-project', FORMAT_VERSION = 1, EXT = '.qcut';
  const APP_VERSION = '4.50';            // 跟 changelog.json 最新版一致（test/edit-project.test.js 會檢查）

  // ---- 純函式 ------------------------------------------------------------------------
  const lc = s => String(s || '').toLowerCase();
  const fileKey = f => `${f.name}|${f.size > 0 ? f.size : ''}|${f.lastModified > 0 ? f.lastModified : ''}`;

  // 專案檔內容：project 是 core.serialize 過的物件，view 是畫面狀態（目前只有播放頭）
  function buildSave(project, view) {
    return {
      format: FORMAT, version: FORMAT_VERSION, app: 'QuickCut', appVersion: APP_VERSION,
      savedAt: new Date().toISOString(),
      view: { playhead: Math.max(0, Math.round((view && view.playhead) || 0)) },
      project: JSON.parse(JSON.stringify(project)),
    };
  }

  // 讀專案檔：{ ok, save } 或 { ok:false, reason }（繁中）
  function parseSave(text) {
    let o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return { ok: false, reason: '這不是 QuickCut 的專案檔（內容不是 JSON）' }; }
    if (!o || typeof o !== 'object' || o.format !== FORMAT) return { ok: false, reason: '這不是 QuickCut 的專案檔' };
    if (!(o.version >= 1)) return { ok: false, reason: '專案檔的版本資訊不正確' };
    if (o.version > FORMAT_VERSION) return { ok: false, reason: '這個專案檔是用較新版本的 QuickCut 存的，請重新整理頁面（強制重新整理）再開啟' };
    const p = o.project;
    if (!p || typeof p !== 'object' || !Array.isArray(p.tracks) || !p.clips || typeof p.clips !== 'object') return { ok: false, reason: '專案檔內容不完整，可能已經損壞' };
    return { ok: true, save: o };
  }

  // 專案裡需要、但 has(id) 回答沒有的素材。used＝時間軸上有片段在用（沒在用的只是媒體庫裡的素材），used 的排前面
  function missingMedia(project, has) {
    const used = new Map();
    for (const c of Object.values(project.clips || {})) if (c && c.type === 'media' && c.mediaId) used.set(c.mediaId, (used.get(c.mediaId) || 0) + 1);
    const out = [];
    for (const [id, info] of Object.entries(project.mediaInfo || {})) {
      if (has(id)) continue;
      out.push({ id, name: info.name || '', kind: info.kind, size: info.size || null, lastModified: info.lastModified || null, duration: info.duration, clips: used.get(id) || 0 });
    }
    // mediaInfo 被刪掉但還有片段在用（理論上不會發生）：也列出來，至少擋住匯出
    for (const [id, n] of used) if (!has(id) && !(project.mediaInfo || {})[id]) out.push({ id, name: '', kind: null, size: null, lastModified: null, duration: null, clips: n });
    return out.sort((a, b) => (b.clips > 0) - (a.clips > 0) || a.name.localeCompare(b.name));
  }

  // 把檔案配給缺少的素材：先找「檔名＋大小」都一樣的，再找只有檔名一樣的（不分大小寫）；一個素材只配一個檔案。
  // 回傳和 files 同長度的陣列：配到的素材 id 或 null；loose[i]＝只有檔名對得上（大小不同或存檔裡沒有大小）
  function matchFiles(missing, files) {
    const ids = files.map(() => null), loose = files.map(() => false), taken = new Set();
    const pass = strict => {
      files.forEach((f, i) => {
        if (ids[i] || !f) return;
        const m = missing.find(x => !taken.has(x.id) && x.name && lc(x.name) === lc(f.name) &&
          (strict ? x.size > 0 && x.size === f.size : true));
        if (m) { ids[i] = m.id; taken.add(m.id); loose[i] = !strict; }
      });
    };
    pass(true); pass(false);
    return { ids, loose };
  }

  const pure = { FORMAT, FORMAT_VERSION, EXT, APP_VERSION, fileKey, buildSave, parseSave, missingMedia, matchFiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof document === 'undefined') return;

  // =====================================================================================
  // 瀏覽器端
  // =====================================================================================
  const Q = root.QPTEdit = root.QPTEdit || {};
  const doc = root.document;
  const $ = id => doc.getElementById(id);
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ui = () => Q.ui, core = () => Q.core, media = () => Q.render && Q.render.media;
  const say = (m, k) => { if (ui() && ui().say) ui().say(m, k); };
  const fmtKB = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // ---- IndexedDB（讀寫失敗都當作沒有；無痕模式或被封鎖時功能退化，不影響剪輯） ----------------
  const DB_NAME = 'quickcut', STORES = ['kv', 'handles'];
  let dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(res => {
      try {
        if (!root.indexedDB) return res(null);
        const rq = root.indexedDB.open(DB_NAME, 1);
        rq.onupgradeneeded = () => { for (const s of STORES) if (!rq.result.objectStoreNames.contains(s)) rq.result.createObjectStore(s); };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
        rq.onblocked = () => res(null);
      } catch (_) { res(null); }
    });
    return dbP;
  }
  async function idb(store, mode, fn) {
    const d = await db();
    if (!d) return null;
    return new Promise(res => {
      try {
        const tx = d.transaction(store, mode), rq = fn(tx.objectStore(store));
        tx.oncomplete = () => res(rq ? rq.result : true);
        tx.onerror = tx.onabort = () => res(null);
      } catch (_) { res(null); }
    });
  }
  const idbGet = (s, k) => idb(s, 'readonly', st => st.get(k));
  const idbPut = (s, k, v) => idb(s, 'readwrite', st => st.put(v, k));
  const idbDel = (s, k) => idb(s, 'readwrite', st => st.delete(k));

  // ---- 狀態 --------------------------------------------------------------------------
  const st = {
    pending: new Map(),       // id → FileSystemFileHandle：記得位置、但還沒有讀取權限（要按「允許存取」）
    claimed: new Map(),       // id → 存檔裡的素材資訊（這次匯入要接回去的，afterImport 用來比對長度）
    ready: false,             // 啟動時的「還原上次的剪輯？」問完之前不自動暫存（免得蓋掉）
    saveTimer: 0,
  };
  const projectOf = () => ui() && ui().state && ui().state.project;
  const missing = () => { const p = projectOf(), m = media(); return p && m ? missingMedia(p, id => !!m.get(id)) : []; };

  // ---- 匯入時的配對（edit-ui.js 的 doImport 呼叫） ------------------------------------------
  function claim(files) {
    const miss = missing();
    st.claimed.clear();
    if (!miss.length) return files.map(() => null);
    const r = matchFiles(miss, files);
    r.ids.forEach(id => { if (id) st.claimed.set(id, miss.find(x => x.id === id)); });
    return r.ids;
  }
  // 匯入完成：記住檔案位置、標出哪些是接回來的、長度不同時警告；回傳要顯示的警告
  function afterImport(added) {
    const warns = [];
    for (const m of added) {
      if (m.handle) idbPut('handles', fileKey(m.file || m), m.handle);
      const was = st.claimed.get(m.id);
      if (!was) continue;
      m.relinked = true;
      st.pending.delete(m.id);
      if (was.duration > 0 && m.duration > 0 && Math.abs(was.duration - m.duration) > 0.5) {
        warns.push({ name: m.name, message: `「${m.name}」的長度（${m.duration.toFixed(1)} 秒）和存檔時（${was.duration.toFixed(1)} 秒）不一樣，可能不是同一個檔案，片段內容可能對不上` });
      }
    }
    st.claimed.clear();
    renderRelink();
    scheduleAutosave();
    return warns;
  }

  // ---- 儲存 --------------------------------------------------------------------------
  function currentSave() {
    const U = ui(), p = projectOf();
    return buildSave(JSON.parse(core().serialize(p)), { playhead: U.state.playhead });
  }
  function download(text, filename) {
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  function save() {
    const U = ui();
    if (!U || !projectOf()) return null;
    const text = JSON.stringify(currentSave());
    const filename = `剪輯專案_${stamp(new Date())}${EXT}`;
    download(text, filename);
    U.markSaved();
    say(`已儲存專案「${filename}」（${fmtKB(new Blob([text]).size)}，不含素材；開啟時再重新連結素材）`, 'ok');
    flushAutosave();
    return { filename, size: new Blob([text]).size, text };
  }

  // ---- 開啟 --------------------------------------------------------------------------
  async function openFile(file) {
    let text;
    try { text = await file.text(); } catch (_) { say(`讀不到「${file.name}」`, 'error'); return false; }
    return openText(text, file.name);
  }
  async function openText(text, name) {
    const r = parseSave(text);
    if (!r.ok) { say(r.reason, 'error'); return false; }
    const U = ui();
    if (U.hasContent() && U.state.dirty && typeof root.askConfirm === 'function') {
      const ok = await root.askConfirm({ title: '開啟專案？', message: `目前的剪輯還沒儲存，開啟「${name || '專案'}」會取代它（自動暫存也會換成新專案）。`, okText: '開啟' });
      if (!ok) return false;
    }
    await load(r.save);
    return true;
  }
  // 載入存檔內容：換掉專案，再依序嘗試接回素材
  async function load(saveObj) {
    const U = ui(), C = core(), M = media();
    const prev = M.list().map(m => ({ file: m.file, handle: m.handle || null }));
    for (const m of M.list()) M.remove(m.id);
    const p = C.deserialize(saveObj.project);
    M.reserve(Object.keys(p.mediaInfo || {}));
    U.replaceProject(p, saveObj.view);
    st.pending.clear();
    renderRelink();
    // 1. 開檔前就在媒體庫的檔案（配不上的也放回媒體庫，不會不見）
    if (prev.length) await U.importFiles(prev.map(x => x.file), prev.map(x => x.handle));
    // 2. 記住的檔案位置
    await tryRememberedHandles();
    renderRelink();
    const miss = missing();
    const clips = Object.keys(p.clips).length;
    if (!miss.length) say(`已開啟專案（${clips} 個片段），素材都接回來了`, 'ok');
    else say(`已開啟專案（${clips} 個片段），還缺 ${miss.length} 個素材，請在左側媒體庫重新連結`, miss.some(x => x.clips) ? 'error' : '');
    st.ready = true;
    scheduleAutosave();
  }

  // 記住的 handle：已經有權限的直接讀；沒權限的放進 pending，等使用者按「允許存取」
  async function tryRememberedHandles() {
    const files = [], handles = [];
    for (const x of missing()) {
      if (!x.name) continue;
      const h = await idbGet('handles', fileKey(x));
      if (!h || typeof h.getFile !== 'function') continue;
      let perm = 'prompt';
      try { perm = typeof h.queryPermission === 'function' ? await h.queryPermission({ mode: 'read' }) : 'granted'; } catch (_) { perm = 'denied'; }
      if (perm === 'granted') {
        try { files.push(await h.getFile()); handles.push(h); continue; } catch (_) { /* 檔案被移走或刪掉：當作沒有 */ }
      } else if (perm === 'prompt') st.pending.set(x.id, h);
    }
    if (files.length) await ui().importFiles(files, handles);
  }
  // 「允許存取並重新連結」：使用者點按鈕（有使用者動作），一個一個要權限
  async function grantPending() {
    const list = [...st.pending.entries()], files = [], handles = [];
    let denied = 0, gone = 0;
    for (const [, h] of list) {
      let perm;
      try { perm = await h.requestPermission({ mode: 'read' }); } catch (_) { perm = 'denied'; }
      if (perm !== 'granted') { denied++; continue; }
      try { files.push(await h.getFile()); handles.push(h); } catch (_) { gone++; }
    }
    st.pending.clear();
    if (files.length) await ui().importFiles(files, handles);
    renderRelink();
    if (denied || gone) say(`有 ${denied + gone} 個素材沒接回來（${denied ? `${denied} 個沒有允許存取` : ''}${denied && gone ? '、' : ''}${gone ? `${gone} 個已經被移動或刪除` : ''}），可以改用「選擇資料夾」`, 'error');
  }

  // 選資料夾：往下找最多 6 層、20000 個項目，只讀檔名對得上的檔案
  async function pickFolder() {
    let dir;
    try { dir = await root.showDirectoryPicker({ mode: 'read' }); } catch (e) { if (!e || e.name !== 'AbortError') say('無法開啟資料夾選擇視窗，請改用「選擇檔案」', 'error'); return; }
    const miss = missing(), want = new Set(miss.map(x => lc(x.name)).filter(Boolean));
    const found = [];
    let seen = 0;
    say(`正在「${dir.name}」裡尋找 ${miss.length} 個素材…`);
    const walk = async (d, depth) => {
      for await (const h of d.values()) {
        if (++seen > 20000) return;
        if (h.kind === 'file') { if (want.has(lc(h.name))) found.push(h); }
        else if (h.kind === 'directory' && depth < 6 && !h.name.startsWith('.')) await walk(h, depth + 1);
      }
    };
    try { await walk(dir, 0); } catch (_) { /* 某些子資料夾讀不到：用已經找到的 */ }
    const files = [], handles = [];
    for (const h of found) { try { files.push(await h.getFile()); handles.push(h); } catch (_) { /* 略過 */ } }
    const r = matchFiles(miss, files);
    const keep = files.map((f, i) => i).filter(i => r.ids[i]);
    if (!keep.length) { say(`在「${dir.name}」裡沒有找到缺少的素材（找的是同檔名的檔案）`, 'error'); return; }
    await ui().importFiles(keep.map(i => files[i]), keep.map(i => handles[i]));
  }

  // ---- 缺少素材的提示（媒體庫上方 #edRelink） ----------------------------------------------
  function renderRelink() {
    const host = $('edRelink');
    if (!host) return;
    const miss = missing();
    host.textContent = '';
    host.hidden = !miss.length;
    if (!miss.length) return;
    const used = miss.filter(x => x.clips).length;
    host.appendChild(el('div', 'ed-relink-t', `缺少 ${miss.length} 個素材`));
    host.appendChild(el('div', 'ed-relink-d', used
      ? '時間軸上灰色的片段要重新連結素材才能預覽與匯出。檔名一樣的檔案會自動配對，也可以直接把檔案拖進來。'
      : '這些是媒體庫裡的素材（時間軸沒有用到），需要的話再重新連結。'));
    const ul = el('ul', 'ed-relink-list');
    for (const x of miss.slice(0, 6)) {
      const li = el('li', null, x.name || '（沒有檔名）');
      if (x.clips) li.appendChild(el('span', 'ed-relink-n', `${x.clips} 個片段`));
      ul.appendChild(li);
    }
    if (miss.length > 6) ul.appendChild(el('li', 'more', `…還有 ${miss.length - 6} 個`));
    host.appendChild(ul);
    const row = el('div', 'ed-btnrow');
    const btn = (id, text, cls, fn, tip) => { const b = el('button', 'ed-btn small' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.id = id; if (tip) b.title = tip; b.addEventListener('click', fn); row.appendChild(b); return b; };
    if (st.pending.size) btn('edRelinkGrant', `允許存取並重新連結（${st.pending.size} 個）`, 'primary', grantPending, '這台電腦上次匯入時記住了檔案位置，允許讀取就能全部接回來');
    if (typeof root.showDirectoryPicker === 'function') btn('edRelinkDir', '選擇資料夾', st.pending.size ? '' : 'primary', pickFolder, '選素材所在的資料夾，依檔名＋大小自動配對（子資料夾也會找）');
    const inp = el('input'); inp.type = 'file'; inp.id = 'edRelinkFile'; inp.multiple = true; inp.hidden = true;
    inp.addEventListener('change', () => { const f = [...inp.files]; inp.value = ''; if (f.length) ui().importFiles(f); });
    btn('edRelinkPick', '選擇檔案…', '', () => inp.click(), '手動選擇素材檔案（可以一次選多個），檔名一樣的會自動配對');
    row.appendChild(inp);
    host.appendChild(row);
  }

  // ---- 自動暫存 ----------------------------------------------------------------------
  function scheduleAutosave() {
    if (!st.ready) return;
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(flushAutosave, 1500);
  }
  function flushAutosave() {
    clearTimeout(st.saveTimer); st.saveTimer = 0;
    if (!st.ready || !ui() || !ui().hasContent()) return Promise.resolve(null);
    const s = currentSave();
    return idbPut('kv', 'autosave', { savedAt: s.savedAt, clips: Object.keys(s.project.clips).length, media: Object.keys(s.project.mediaInfo || {}).length, text: JSON.stringify(s) });
  }
  async function checkAutosave() {
    const rec = await idbGet('kv', 'autosave');
    if (!rec || !rec.text || !(rec.clips > 0)) { st.ready = true; return false; }
    const r = parseSave(rec.text);
    if (!r.ok) { await idbDel('kv', 'autosave'); st.ready = true; return false; }
    const ask = typeof root.askConfirm === 'function' ? root.askConfirm({
      title: '還原上次的剪輯？',
      message: `上次自動暫存於 ${when(rec.savedAt)}（${rec.clips} 個片段、${rec.media} 個素材）。還原後再重新連結素材就能繼續剪。選「開新專案」會清掉這份暫存。`,
      okText: '還原', cancelText: '開新專案',
    }) : Promise.resolve(false);
    if (await ask) { await load(r.save); return true; }
    await idbDel('kv', 'autosave');
    st.ready = true;
    return false;
  }

  // ---- 頁首按鈕、快捷鍵 ----------------------------------------------------------------
  function wire() {
    const sb = $('edSaveBtn'), ob = $('edOpenBtn'), oi = $('edProjFile');
    if (sb) sb.addEventListener('click', save);
    if (ob && oi) ob.addEventListener('click', () => oi.click());
    if (oi) oi.addEventListener('change', () => { const f = oi.files[0]; oi.value = ''; if (f) openFile(f); });
    doc.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 's' && k !== 'o') return;
      if (doc.querySelector('dialog[open]') || doc.querySelector('.modal-overlay.open')) return;
      e.preventDefault();
      if (k === 's') save(); else if (oi) oi.click();
    });
    const C = core();
    if (C && C.bus) C.bus.addEventListener('change', () => { renderRelink(); scheduleAutosave(); });
    // 分頁切到背景或關掉前：馬上存一次（IndexedDB 是非同步的，關頁時不保證寫得完，所以平常也有 1.5 秒的延遲存檔）
    doc.addEventListener('visibilitychange', () => { if (doc.hidden && st.saveTimer) flushAutosave(); });
  }

  function init() {
    if (!Q.ui || !Q.core || !Q.render || !Q.ui.replaceProject) return;
    wire();
    renderRelink();
    checkAutosave();
  }

  Q.project = Object.assign(Q.project || {}, pure, {
    save, openFile, openText, load, claim, afterImport, missing, renderRelink, pickFolder, grantPending, flushAutosave, checkAutosave,
  });
  // getter 不能放進 Object.assign（會被複製成當下的值）
  Object.defineProperties(Q.project, {
    pendingCount: { get: () => st.pending.size, enumerable: true },
    ready: { get: () => st.ready, enumerable: true },
  });

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
