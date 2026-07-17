# Layout Studio

用 **SSIM（Structural Similarity）模板比對**,把素材依「示意圖」自動定位成可下載的切版。純前端、無相依套件,直接用瀏覽器開 `index.html` 即可使用。

## 功能

- **彈窗工作流**:上傳示意圖(layout reference)+ 含 `bg.png` 的素材資料夾(或多張圖片,Firefox 相容)。
- **SSIM 自動定位**:以 `bg.png` 為底圖,將每張素材在示意圖上比對,找出最佳位置。
  採用 **SSIM（Structural Similarity）** 的**多解析度金字塔 + top-K 候選**搜尋,可處理大底圖(如 1197×4490)與數十張素材,像素級精準。
- **AI 輔助定位(Gemini,選用)**:SSIM 之後的第二道修正,需自備 Gemini API key(填入工具列,存於瀏覽器 localStorage,模型可選 flash/pro):
  - **AI 選取定位**:在圖層面板點選(可 Shift 多選)定位錯誤的素材,交給 Gemini 視覺定位。
  - **AI 全面檢查**:Gemini 比對示意圖與目前排版,列出疑似錯位項。
  - 兩者都不會自動覆蓋:結果以綠色虛線建議框顯示在畫布上,由你逐項「套用/忽略」;
    尚有未處理的建議時,三顆定位按鈕會暫時鎖住,避免中途重跑洗掉正在審核的建議。
  - 只有按下這兩顆按鈕時才會把示意圖與素材送到 Google API;其餘功能完全離線。
- **手動微調**:畫布上自由拖曳,等比例不變形、可自由重疊。
- **圖層面板**:每張圖可顯示/隱藏(眼睛)、上移/下移控制堆疊順序。
- **自動存檔 / 還原**:工作進度存於 IndexedDB,閃退或重開都不會遺失;可一鍵「重新開始」。
- **匯出切版**:下載 `layout-export.zip`,內含 `index.html` / `styles.css` / `script.js`。
  使用**絕對定位 + 百分比**(`height:auto` 保持等比、`z-index` 對應圖層),整體等比縮放、RWD 友善,圖片內嵌為 data URL,可獨立執行。

## 使用

1. 用瀏覽器開啟 `index.html`(建議 Chrome / Edge / Safari)。
2. 點「開始建立切版」→ 上傳示意圖與素材資料夾。
3. 按「SSIM 自動定位」,需要時拖曳微調、調整圖層。
4. 按「下載切版」取得 zip。

## 測試素材

`make_samples.js` 會產生一組示範用的素材與示意圖:

```bash
node make_samples.js   # 產生 sample/ (bg.png + 素材) 與 sample_ref.png
```

- 示意圖 → 選 `sample_ref.png`
- 素材資料夾 → 選 `sample/`

## 檔案結構

| 檔案 | 說明 |
|------|------|
| `index.html` | 平台頁面(按鈕 + 彈窗 + 畫布) |
| `styles.css` | 介面樣式 |
| `app.js` | SSIM 比對、拖曳、圖層、存檔、匯出 |
| `make_samples.js` | 產生示範素材(內含無相依的 PNG 編碼器) |
| `sample/`, `sample_ref.png` | 示範資料 |
