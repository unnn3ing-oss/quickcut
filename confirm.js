// 確認對話框：window.askConfirm({ title, message, okText, cancelText }) → Promise<boolean>。
// 介面和 QuickPatterntool app.js 的 askConfirm 一樣（edit-ui.js 刪除有片段的軌道前會呼叫它；沒有這個函式時會直接刪）。
// 按「取消」、點外面、按 Esc 都是 false。
(function (root) {
  'use strict';
  const doc = root.document;
  const $ = id => doc.getElementById(id);
  const overlay = $('confirmOverlay'), okBtn = $('confirmOkBtn'), cancelBtn = $('confirmCancelBtn');
  const titleEl = $('confirmTitle'), msgEl = $('confirmMessage');
  if (!overlay) return;
  let pending = null;

  function askConfirm({ title = '確定嗎？', message = '', okText = '確定', cancelText = '取消' } = {}) {
    if (pending) close(false);              // 前一個還沒回答就當作取消
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    overlay.classList.add('open');
    okBtn.focus();
    return new Promise(resolve => { pending = resolve; });
  }
  function close(result) {
    overlay.classList.remove('open');
    if (pending) { const r = pending; pending = null; r(result); }
  }
  cancelBtn.addEventListener('click', () => close(false));
  okBtn.addEventListener('click', () => close(true));
  overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  // 對話框開著時鍵盤只給它用：Esc 取消，其他按鍵不傳給剪輯的快捷鍵（捕捉階段攔下）
  doc.addEventListener('keydown', e => {
    if (!overlay.classList.contains('open')) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
  }, true);

  root.askConfirm = askConfirm;
})(typeof window !== 'undefined' ? window : globalThis);
