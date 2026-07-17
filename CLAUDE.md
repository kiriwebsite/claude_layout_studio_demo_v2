# CLAUDE.md — Layout Studio

<!-- 2026-07-06 建立（Fable 5 盤點）。事實會漂移，引用前先驗證。 -->

回覆一律用繁體中文。全域守則（~/.claude/CLAUDE.md）照常適用——
找東西（不知道在哪個檔案）派 Explore；但本專案很小（核心就 4 個檔），
多數定位自己讀就好，別過度委派。

## 紅線（不讀其他檔也要遵守）
- **相容性**：目標瀏覽器 Chrome/Edge/Safari，Firefox 需相容（素材上傳走
  `filesInput` 多檔 fallback，不是只靠資料夾 `folderInput`）。改上傳流程別弄壞 Firefox 路徑。
- **副作用幾乎都在本地，可放心實跑**：IndexedDB 自動存檔、下載 zip、
  `node make_samples.js` 產生 `sample/`——都只寫本機，不碰任何正式資料/帳號。
  **這個專案沒有「會寫正式資料」的危險路徑**，全域那套部署/副作用謹慎在這裡不適用。
  唯一例外（2026-07-09 起）：Gemini AI 輔助定位會把示意圖/素材圖送到
  Google generativelanguage API——但只在使用者自己填了 API key 並主動按
  「AI 選取定位 / AI 全面檢查」時才發送，key 存 localStorage（`gemini-key`）。
  第二個例外（2026-07-15 起）：每次 Gemini 呼叫成功後，`logAiUsage()` 會
  fire-and-forget POST token 用量到 `mapi.icantw.com/api/ai-usage-logs`（只送
  model/feature/token 數，不含圖片或內容；失敗只 console.warn，不影響定位流程）。
  除上述 Gemini 兩鍵與這個用量回報外，禁止新增其他對外網路呼叫。
- **commit 慣例**：既有 2 個 commit 為中英混合描述式、**無 AI 署名**；
  跟隨此慣例（與全域預設的 Co-Authored-By 不同，以專案慣例為準）。使用者自己 push。

## 環境事實（2026-07-06 盤點快照）
- 入口：瀏覽器直接開 `index.html`（無 dev server）。要看畫面用 preview/run skill，
  或 `node make_samples.js` 產生示範素材後手動操作。
- 程式組織：核心全在 `app.js`（878 行，單檔、`"use strict"`、全域函式、
  `el(id)` 取 DOM、`state` 物件集中狀態、`draw()` 重繪 canvas）。改邏輯進 `app.js`，
  介面樣式進 `styles.css`，DOM 結構進 `index.html`——三者靠 element id 對應。
- 核心演算法：SSIM（Structural Similarity）模板比對，多解析度金字塔 + top-K 候選；
  改比對邏輯前先讀 README 的「功能」段理解不變式（大底圖、數十素材、像素級）。
- 驗證手段：**無測試框架**。什麼算完成 = 瀏覽器實際跑一次改動路徑
  （上傳→SSIM 定位→拖曳→下載 zip 能開）。lint/語法過不算驗證。
- 匯出物：`layout-export.zip` 內含 index.html/styles.css/script.js，圖片內嵌 data URL、
  絕對定位+百分比、RWD。改匯出邏輯後要驗證產出的 zip 能獨立在瀏覽器打開。
