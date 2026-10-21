// =====================================================================================
// 頁首：「說明」面板（快捷鍵與基本流程；按 ? 也能打開），窄視窗時把次要按鈕收進「⋯」選單。
// 頁首按鈕本身在 index.html；開啟／儲存專案由 edit-project.js、匯出由 edit-ui.js、深色由 edit-ui.js 接上，
// 這裡的選單只是代按原本的按鈕，不重複實作功能。
// =====================================================================================
(function (root) {
  'use strict';
  const doc = root.document;
  const $ = id => doc.getElementById(id);
  const isMac = /Mac|iPhone|iPad/.test((root.navigator && (navigator.platform || navigator.userAgent)) || '');
  const MOD = isMac ? '⌘' : 'Ctrl';

  // ---- 說明面板 ----------------------------------------------------------------------
  // [按鍵, 說明]；按鍵裡的 MOD 會換成 Ctrl 或 ⌘
  const KEYS = [
    ['工具與編輯', [
      ['A／B／T', '選取／刀片／修剪工具'],
      ['MOD＋B', '在播放頭切開'],
      ['Delete', '刪除選取的片段（留下空隙）'],
      ['Shift＋Delete／Backspace', '波紋刪除（後面的片段補上空隙）'],
      ['F9／F10／F11／F12', '插入／覆蓋／替換／加到結尾'],
      ['MOD＋A', '全選片段'],
      ['MOD＋Z', '復原（MOD＋Shift＋Z 重做）'],
      ['Shift＋R／MOD＋R', '定格／變速'],
      ['V', '在播放頭加一段字幕（字幕分頁或選取字幕時）'],
    ]],
    ['播放與移動', [
      ['空白鍵', '播放／暫停'],
      ['J／K／L', '倒播／暫停／正播（連按加速）'],
      ['← →', '前後一格（Shift＋← → 前後一秒）'],
      ['↑ ↓', '上一個／下一個剪輯點'],
      ['Home／End', '跳到開頭／結尾'],
    ]],
    ['範圍與標記', [
      ['I／O', '設定入點／出點'],
      ['X', '把選取片段的範圍設為入點／出點'],
      ['Alt＋X', '清除入點／出點'],
      ['M', '在播放頭加標記'],
    ]],
    ['時間軸與檢視', [
      ['+／-', '放大／縮小時間軸（也可以 MOD＋滾輪）'],
      ['Shift＋Z', '整個時間軸放進視窗'],
      ['N', '吸附開關'],
      ['MOD＋Shift＋L', '連結選取開關'],
      ['Esc', '取消選取、關閉彈窗'],
    ]],
    ['專案', [
      ['MOD＋S', '儲存專案（.qcut，不含素材）'],
      ['MOD＋O', '開啟專案'],
      ['?', '打開這個說明'],
    ]],
  ];
  const STEPS = [
    ['匯入素材', '把影片、音訊、圖片拖進左側「媒體」，或點匯入區選檔（也可以 MOD＋V 貼上）。'],
    ['放上時間軸', '雙擊素材在檢視器預覽、用 I／O 設定範圍，再按「加到結尾」（F12）、插入（F9）或覆蓋（F10）；也可以直接拖到時間軸。'],
    ['剪輯', '刀片（B）切開、修剪（T）拖邊緣；點軌道標頭可以選取整條軌，在右側「詳細內容」一次調整。轉場、字幕在左側「特效」「字幕」分頁。'],
    ['儲存與匯出', '「儲存專案」下載幾 KB 的專案檔（不含素材，開啟時再接回素材）；「匯出影片」選畫質、尺寸、格式，或用 YouTube／Instagram／Facebook 的建議設定。'],
  ];
  const TIPS = [
    '每次改動都會自動暫存在這個瀏覽器裡；不小心關掉分頁，下次打開會問要不要還原。',
    '素材只在你的電腦上處理，不會上傳。',
    '建議用最新版 Chrome 或 Edge（匯出影片需要 WebCodecs）。',
  ];
  const kbd = k => k.replace(/MOD/g, MOD).split(/(／|＋)/).map(p => (p === '／' || p === '＋' ? p : `<kbd>${p}</kbd>`)).join('');
  function buildHelp() {
    const d = doc.createElement('dialog');
    d.id = 'edHelp'; d.className = 'ed-help';
    d.setAttribute('aria-labelledby', 'edHelpTitle');
    d.innerHTML = `
<div class="ed-help-head"><h2 id="edHelpTitle">使用說明</h2><button type="button" class="ed-help-x" id="edHelpClose" aria-label="關閉說明" title="關閉（Esc）">✕</button></div>
<div class="ed-help-body">
  <section><h3>基本流程</h3><ol class="ed-help-steps">${STEPS.map(([t, x]) => `<li><b>${t}</b><span>${x.replace(/MOD/g, MOD)}</span></li>`).join('')}</ol></section>
  <section><h3>快捷鍵</h3><div class="ed-help-keys">${KEYS.map(([g, rows]) => `<div class="ed-help-group"><h4>${g}</h4><dl>${rows.map(([k, v]) => `<dt>${kbd(k)}</dt><dd>${v.replace(/MOD/g, MOD)}</dd>`).join('')}</dl></div>`).join('')}</div></section>
  <section><h3>小提醒</h3><ul class="ed-help-tips">${TIPS.map(t => `<li>${t}</li>`).join('')}</ul></section>
</div>`;
    doc.body.appendChild(d);
    $('edHelpClose').addEventListener('click', () => d.close());
    d.addEventListener('click', e => { if (e.target === d) d.close(); });    // 點面板外面（backdrop）關閉
    return d;
  }
  function openHelp() {
    const d = $('edHelp') || buildHelp();
    if (!d.open) d.showModal();
    $('edHelpClose').focus();
  }

  // ---- 窄視窗的「⋯」選單 ----------------------------------------------------------------
  // [選單文字, 要代按的按鈕 id]；按鈕本身在窄視窗用 CSS 藏起來
  const MORE = [['開啟專案', 'edOpenBtn'], ['儲存專案', 'edSaveBtn'], ['使用說明', 'edHelpBtn'], ['切換深色／淺色', 'edThemeBtn']];
  function wireMore() {
    const btn = $('edMoreBtn'), menu = $('edMoreMenu');
    if (!btn || !menu) return;
    menu.textContent = '';
    for (const [t, id] of MORE) {
      const it = doc.createElement('button');
      it.type = 'button'; it.className = 'ed-more-item'; it.setAttribute('role', 'menuitem'); it.textContent = t;
      it.addEventListener('click', () => { close(); const b = $(id); if (b) b.click(); });
      menu.appendChild(it);
    }
    const items = () => [...menu.querySelectorAll('.ed-more-item')];
    const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); items()[0].focus(); };
    function close(refocus) { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    menu.addEventListener('keydown', e => {
      const list = items(), i = list.indexOf(doc.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Tab') close();
    });
    doc.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close(); });
    root.addEventListener('resize', () => close());
  }

  function init() {
    const hb = $('edHelpBtn');
    if (hb) hb.addEventListener('click', openHelp);
    wireMore();
    // ? 打開說明（打字中、或有其他對話框開著時不攔）
    doc.addEventListener('keydown', e => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (doc.querySelector('dialog[open]') || doc.querySelector('.modal-overlay.open')) return;
      e.preventDefault();
      openHelp();
    });
  }

  root.QPTEdit = root.QPTEdit || {};
  root.QPTEdit.topbar = { openHelp };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
