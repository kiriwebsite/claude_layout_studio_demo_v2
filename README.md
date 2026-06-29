# Layout Studio

用 **Sum of Squared Differences (SSD) 模板比對**,把素材依「示意圖」自動定位成可下載的切版。純前端、無相依套件,直接用瀏覽器開 `index.html` 即可使用。

## 功能

- **彈窗工作流**:上傳示意圖(layout reference)+ 含 `bg.png` 的素材資料夾(或多張圖片,Firefox 相容)。
- **SSD 自動定位**:以 `bg.png` 為底圖,將每張素材在示意圖上比對,找出最佳位置。
  採用 **Sum of Squared Differences** 的**多解析度金字塔 + top-K 候選**搜尋,可處理大底圖(如 1197×4490)與數十張素材,像素級精準。
- **手動微調**:畫布上自由拖曳,等比例不變形、可自由重疊。
- **圖層面板**:每張圖可顯示/隱藏(眼睛)、上移/下移控制堆疊順序。
- **自動存檔 / 還原**:工作進度存於 IndexedDB,閃退或重開都不會遺失;可一鍵「重新開始」。
- **匯出切版**:下載 `layout-export.zip`,內含 `index.html` / `styles.css` / `script.js`。
  使用**絕對定位 + 百分比**(`height:auto` 保持等比、`z-index` 對應圖層),整體等比縮放、RWD 友善,圖片內嵌為 data URL,可獨立執行。

## 使用

1. 用瀏覽器開啟 `index.html`(建議 Chrome / Edge / Safari)。
2. 點「開始建立切版」→ 上傳示意圖與素材資料夾。
3. 按「SSD 自動定位」,需要時拖曳微調、調整圖層。
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
| `app.js` | SSD 比對、拖曳、圖層、存檔、匯出 |
| `make_samples.js` | 產生示範素材(內含無相依的 PNG 編碼器) |
| `sample/`, `sample_ref.png` | 示範資料 |
