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
- 瀏覽器流程測試：`node test/edit-ui.e2e.js`、`edit-render.e2e.js`、`edit-export.e2e.js`、`edit-fx.e2e.js`、`edit-project.e2e.js`。沙盒用 `/opt/pw-browsers/chromium`（測試檔已預設），**不要**執行 `playwright install`。
- 暫存腳本、截圖放 scratchpad，不要放進專案。

## 和 QuickPatterntool 的關係
- 程式邏輯（`edit-*.js`）沿用原專案，刻意保留 `QPTEdit` 命名空間與 `app.hidden` 判斷，方便兩邊互相移植修正。差異見 `DESIGN.md` 第 1 節。
- `localStorage` 的 key 用 `qc-*`（原專案是 `qpt-edit-*`，兩個網站同一個來源，不能撞名）。
