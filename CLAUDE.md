# QuickCut（網頁版影片剪輯）— 協作規則

純網頁（GitHub Pages）的多軌時間軸剪輯工具，從 QuickPatterntool 的「剪輯」分頁獨立出來。使用方式見 `README.md`，設計邏輯（為什麼這樣做）見 `DESIGN.md`，改動功能前先讀它，改完要同步更新。

## 溝通
- 一律用**繁體中文（台灣口吻）**，絕不用簡體。
- **結論先行**，再展開；善用標題、粗體、清單、表格。
- 區分「已知事實」和「推論」；決策類問題給多方案優缺比較。

## 作業流程（最重要）
1. 所有改動都在**分支＋PR** 上做，**不直接推 `main`**。
2. **先改好、測好、給我看（截圖／測試結果）**，再推到 PR 分支、更新 PR 說明。
3. 我明確說「**推**」才把 PR 併入 `main`。說「推」之後依序做：
   1. 把當時的 `origin/main` 推一份備份到 `backup/vX.Y-<簡述>`（版本號是**併入前**的那版）。
   2. 確認 PR 分支已包含最新的 `main`（落後就把 `main` **merge** 進來，不要 rebase／force），測試全過。
   3. 併入 PR（merge commit）。
   4. 回報：併入的 commit、備份分支名、請我確認什麼（GitHub Pages 要等 1～2 分鐘部署，並強制重新整理）。
4. commit 結尾加兩行：`Co-Authored-By: …` 與 `Claude-Session: <本次 session 連結>`。
5. Stop hook 提醒「有未提交變更」時，回「Not committing until you say OK」並列出變更的檔案，不要因此提交。

## 版本號（`changelog.json`）
| 這次改了什麼 | 遞增 | 例 |
|---|---|---|
| 更改功能或介面（大改版、新增主要功能） | 主版本 +1，後兩位歸零 | `1.52` → `2.00` |
| 部分小功能 | 十位數 +1，個位歸零 | `1.52` → `1.60` |
| 介面完善、小 BUG | 個位數 +1 | `1.52` → `1.53` |

- 混合類型取最大的。數字照一般進位（`1.59` → `1.60`）。
- 升版時在 `changelog.json` 新增一筆（繁體中文）：`"1.53": { "summary": "一行簡述", "items": ["…"] }`，**PR 說明也要寫版本號與變更**。
- 只改文件（`README.md`、`DESIGN.md`、`CLAUDE.md`）或測試時不升版。

## 測試
- 單元測試：`node --test test/*.test.js`（要全過）。
- 瀏覽器流程測試：`node test/edit-ui.e2e.js`、`edit-render.e2e.js`、`edit-export.e2e.js`、`edit-fx.e2e.js`、`edit-project.e2e.js`、`ux.e2e.js`、`edit-simple.e2e.js`、`edit-auto.e2e.js`。PR 會由 GitHub Actions（`.github/workflows/test.yml`）自動跑全部測試。沙盒用 `/opt/pw-browsers/chromium`（測試檔已預設），**不要**執行 `playwright install`。
- 暫存腳本、截圖放 scratchpad，不要放進專案。

## 省 token 規則
1. **一個版本一個對話**：版本併入 `main` 後就開新對話。開頭只寫「接著做 X.YZ：〇〇」，不貼歷史脈絡（流程看 CLAUDE.md，設計看 DESIGN.md）。
2. **先判斷大小再動手**：
   - 小改動（修 BUG、改文字、調樣式、單一檔案）→ 主對話直接做，不派子代理。
   - 大功能有 2 件以上互不相干、檔案不重疊 → 才派子代理平行做。
   - 會改到同一個函式的工作 → 先在主對話做好共用的掛點、commit，再分派。
3. **子代理預設：Sonnet 5.5＋中等（medium）程度**。要升到 Opus、提高程度或改用 Haiku，都要先說明理由，我同意後才換。派出去的子代理不中途換模型（停掉重來會浪費已花的用量），除非我要求。
4. **子代理的指示要完整**：檔案範圍、不能碰的地方、要跑哪幾支測試、截圖存哪、回報格式，一次寫清楚，避免來回補問。回報要精簡。
5. **測試分層**：
   - 子代理只跑和自己改動相關的測試。
   - 全部 e2e 只在整合時由主對話跑一次。
   - 匯出測試以 CI 為準（沙盒的 6 項編碼差異不重跑、不查）。
6. **讀檔要精準**：用 grep 找位置、只讀需要的行數，不整支讀大檔（edit-fx.js、edit-core.js、e2e 測試檔）。
7. **回覆精簡**：結論＋表格，不重複前面講過的內容。Stop hook 提醒時只回固定句子和檔案清單。
8. **截圖只在要給我確認時拍**，一次拍齊，不要反覆拍同一個畫面。

## 和 QuickPatterntool 的關係
- QuickPatterntool 的「剪輯」已停用，使用者都導到這裡；**不用再和原專案保持可互相移植**，可以自由重構。
- 全域命名空間仍叫 `QPTEdit`（內部名稱，改名牽動所有檔案與測試，沒有實際好處）。
- `localStorage` 的 key 用 `qc-*`（原專案是 `qpt-edit-*`，兩個網站同一個來源，不能撞名）。
- 介面程式拆成 `edit-ui.js`（共用）＋`edit-ui-*.js`（各區塊），拆檔方式見 `edit-ui.js` 檔頭與 `DESIGN.md` 第 7 節。
