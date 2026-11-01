// 4.00 之後預設是簡易模式、空專案會跳開始畫面。既有的瀏覽器測試測的是專業模式的介面：
// 每個新 context 先設好 qc-ui＝pro、不顯示開始畫面與教學（測試自己切換過就沿用，不覆蓋）。
// 用法：const browser = proMode(await chromium.launch(...));
module.exports = function proMode(browser) {
  const init = () => {
    try {
      if (!localStorage.getItem('qc-ui')) localStorage.setItem('qc-ui', 'pro');
      localStorage.setItem('qc-start-off', '1');
      localStorage.setItem('qc-tips', 'done');
    } catch (_) { /* localStorage 不能用（測試故意弄壞）就算了 */ }
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async o => { const ctx = await newContext(o); await ctx.addInitScript(init); return ctx; };
  browser.newPage = async o => { const ctx = await browser.newContext(o); const page = await ctx.newPage(); page.once('close', () => ctx.close().catch(() => {})); return page; };
  return browser;
};
