"use strict";

/* ============================================================
   Layout Studio
   - Upload a reference mock-up (示意圖) + an asset folder (含 bg.png)
   - Use SSIM (Structural Similarity) template matching to find
     where each asset belongs inside the reference layout
   - Snap to a CSS grid, let the user drag to fine-tune
   - Export a self-contained HTML / CSS / JS slice
   ============================================================ */

const el = (id) => document.getElementById(id);

// ---- DOM ----
const refInput = el("refInput");
const folderInput = el("folderInput");
const filesInput = el("filesInput");
const refName = el("refName");
const folderName = el("folderName");
const canvas = el("canvas");
const ctx = canvas.getContext("2d");
const statusEl = el("status");
const layerList = el("layerList");
const autoPlaceBtn = el("autoPlaceBtn");
const downloadBtn = el("downloadBtn");
const saveStatus = el("saveStatus");
const resetBtn = el("resetBtn");
const showRefToggle = el("showRefToggle");
const refOpacitySlider = el("refOpacity");
const refOpacityVal = el("refOpacityVal");
const geminiKeyInput = el("geminiKey");
const geminiModelSelect = el("geminiModel");
const aiFixBtn = el("aiFixBtn");
const aiCheckBtn = el("aiCheckBtn");
// DOM editor board (display layer). The canvas above is kept only for SSIM/Gemini.
const viewport = el("viewport");
const board = el("board");
const boardBg = el("boardBg");
const boardRef = el("boardRef");
const assetLayer = el("assetLayer");
const guideLayer = el("guideLayer");

// Cap source images so huge uploads don't blow up memory / crash the tab.
const MAX_DIM = 1600;

// ---- State ----
const state = {
  refImg: null,        // HTMLImageElement of the reference mock-up
  refBlob: null,       // stored blob for the reference
  bg: null,            // { name, img, blob }
  assets: [],          // [{ name, img, blob, x, y, w, h, score }] in layout space (bg pixels)
  layoutW: 0,
  layoutH: 0,
  scale: 1,            // display scale: canvas px = layout px * scale
  drag: null,          // { idx, offX, offY }
  selection: [],       // indices of currently-selected assets (DOM editor)
};

// ============================================================
// View controls: reference opacity (fade the target under opaque assets)
// ============================================================
showRefToggle.addEventListener("change", draw);
refOpacitySlider.addEventListener("input", () => {
  refOpacityVal.textContent = refOpacitySlider.value + "%";
  draw();
});

// ============================================================
// File loading helpers
// ============================================================
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Load a blob into an Image. Anything over `maxDim` on its longest side is
// downscaled so big uploads can't exhaust memory / crash the tab. We ALSO
// return nativeW/nativeH — the original pixel size — because SSIM matching
// needs every asset and the bg to share one coordinate system (the design
// space). Downscaling the stored copy is fine; matching uses nativeW/H.
async function normalizeImage(srcBlob, maxDim = MAX_DIM) {
  const img = await loadImage(URL.createObjectURL(srcBlob));
  const nativeW = img.width, nativeH = img.height;
  const max = Math.max(nativeW, nativeH);
  if (max <= maxDim) return { img, blob: srcBlob, nativeW, nativeH };

  const s = maxDim / max;
  const c = document.createElement("canvas");
  c.width = Math.round(nativeW * s);
  c.height = Math.round(nativeH * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const img2 = await loadImage(URL.createObjectURL(blob));
  return { img: img2, blob, nativeW, nativeH };
}

refInput.addEventListener("change", async () => {
  const f = refInput.files[0];
  if (!f) return;
  refName.textContent = f.name;
  // Keep the reference at high resolution (same cap as bg) so it stays crisp
  // on the canvas — the default MAX_DIM would over-shrink a tall mock-up.
  const norm = await normalizeImage(f, 6000);
  state.refImg = norm.img;
  state.refBlob = norm.blob;
  // Show the reference on the canvas immediately, even before a bg is chosen.
  setupCanvas();
  draw();
  tryEnableAutoPlace();
  saveSession();
});

folderInput.addEventListener("change", () => processAssetFiles(folderInput.files));
filesInput.addEventListener("change", () => processAssetFiles(filesInput.files));

async function processAssetFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
  if (!files.length) { folderName.textContent = "找不到圖片檔"; return; }

  state.bg = null;
  state.assets = [];

  for (const f of files) {
    const base = f.name.split("/").pop();
    if (/^bg\.(png|jpe?g|webp)$/i.test(base)) {
      // bg defines the design coordinate space — keep it at full resolution
      // (cap only enormous backgrounds) so matching ratios and export stay crisp.
      const { img, blob, nativeW, nativeH } = await normalizeImage(f, 6000);
      state.bg = { name: base, img, blob, nativeW, nativeH };
    } else {
      const { img, blob, nativeW, nativeH } = await normalizeImage(f);
      state.assets.push({ name: base, img, blob, nativeW, nativeH, x: 0, y: 0, w: nativeW, h: nativeH, score: null, visible: true });
    }
  }

  if (!state.bg) { folderName.textContent = "⚠ 資料夾需包含 bg.png"; return; }

  folderName.textContent = `bg.png + ${state.assets.length} 張素材`;
  state.layoutW = state.bg.nativeW;
  state.layoutH = state.bg.nativeH;

  // Default: stack assets in a tidy column so the canvas is usable before SSIM runs.
  defaultLayout();
  setupCanvas();
  renderLayerList();
  draw();
  tryEnableAutoPlace();
  saveSession();
}

function tryEnableAutoPlace() {
  const ready = state.refImg && state.bg;
  autoPlaceBtn.disabled = !ready;
  downloadBtn.disabled = !(state.bg && state.assets.length);
  updateAiButtons();
}

// AI buttons need everything SSIM needs PLUS an API key; re-place also
// needs at least one asset selected in the layer panel (click / Shift-click).
function updateAiButtons() {
  const ready = state.refImg && state.bg && state.assets.length && geminiKeyInput.value.trim();
  aiCheckBtn.disabled = !ready;
  aiFixBtn.disabled = !(ready && state.selection.length);
}

function defaultLayout() {
  let y = 16;
  for (const a of state.assets) {
    const maxW = state.layoutW * 0.4;
    const s = a.nativeW > maxW ? maxW / a.nativeW : 1;
    a.w = a.nativeW * s;
    a.h = a.nativeH * s;
    a.x = 16;
    a.y = y;
    y += a.h + 16;
  }
}

// ============================================================
// Canvas setup & drawing
// ============================================================
// The canvas coordinate space = the bg/design space if a bg is loaded,
// otherwise the reference image's own size (so the reference can preview
// before any bg is chosen).
function currentDims() {
  if (state.bg) return { W: state.layoutW, H: state.layoutH };
  if (state.refImg) return { W: state.refImg.width, H: state.refImg.height };
  return null;
}

// Size the DOM board to the design's aspect ratio and wire the bg/reference
// images. Assets themselves are positioned in % by draw(), so the board scales
// fluidly with the column (and never upscales past the native width).
function setupCanvas() {
  const d = currentDims();
  if (!d) { canvas.width = 0; canvas.height = 0; board.style.display = "none"; return; }
  state.scale = 1;
  board.style.display = "";
  board.style.aspectRatio = d.W + " / " + d.H;
  board.style.maxWidth = d.W + "px";
  if (state.bg) { boardBg.src = state.bg.img.src; boardBg.style.display = ""; }
  else { boardBg.removeAttribute("src"); boardBg.style.display = "none"; }
  if (state.refImg) boardRef.src = state.refImg.src;
  else boardRef.removeAttribute("src");
}

// Render the whole board from state. `guides` (optional) draws alignment lines
// during a drag. Rebuilding the asset DOM each call is fine for tens of assets.
function draw(guides) {
  const d = currentDims();
  if (!d) { assetLayer.innerHTML = ""; guideLayer.innerHTML = ""; return; }

  // Reference — sits above bg and below all assets. Its opacity is adjustable
  // so you can fade the target while the opaque assets on top stay solid.
  if (showRefToggle.checked && state.refImg) {
    boardRef.style.display = "";
    boardRef.style.opacity = (parseInt(refOpacitySlider.value, 10) || 100) / 100;
  } else {
    boardRef.style.display = "none";
  }

  renderAssets(d);
  renderGuides(guides);
}

// Each visible asset becomes an absolutely-positioned, %-sized <div><img></div>
// — identical to the exported markup, so the board is a live preview of it.
function renderAssets(d) {
  const W = d.W, H = d.H;
  assetLayer.innerHTML = "";
  const single = state.selection.length === 1 ? state.selection[0] : -1;
  state.assets.forEach((a, i) => {
    if (a.visible === false) return;
    const elDiv = document.createElement("div");
    elDiv.className = "asset-el" + (state.selection.includes(i) ? " selected" : "");
    elDiv.dataset.idx = i;
    elDiv.style.left = pct(a.x, W) + "%";
    elDiv.style.top = pct(a.y, H) + "%";
    elDiv.style.width = pct(a.w, W) + "%";
    elDiv.style.zIndex = i + 1;
    const im = document.createElement("img");
    im.src = a.img.src; im.draggable = false; im.alt = a.name;
    elDiv.appendChild(im);
    if (i === single) {
      for (const c of ["nw", "ne", "sw", "se"]) {
        const hd = document.createElement("div");
        hd.className = "handle " + c; hd.dataset.corner = c;
        elDiv.appendChild(hd);
      }
    }
    assetLayer.appendChild(elDiv);

    if (a.suggest) {
      const sg = document.createElement("div");
      sg.className = "sel-suggest";
      sg.style.left = pct(a.suggest.x, W) + "%";
      sg.style.top = pct(a.suggest.y, H) + "%";
      sg.style.width = pct(a.suggest.w, W) + "%";
      sg.style.height = pct(a.suggest.h, H) + "%";
      assetLayer.appendChild(sg);
    }
  });
}

function renderGuides(guides) {
  guideLayer.innerHTML = "";
  if (!guides || !guides.length) return;
  const W = state.layoutW, H = state.layoutH;
  for (const g of guides) {
    const l = document.createElement("div");
    if (g.type === "v") { l.className = "guide-line v"; l.style.left = pct(g.pos, W) + "%"; }
    else { l.className = "guide-line h"; l.style.top = pct(g.pos, H) + "%"; }
    guideLayer.appendChild(l);
  }
}


// ============================================================
// SSIM Template Matching  (multi-resolution pyramid + top-K)
// ----------------------------------------------------------
// A naive single full-resolution sliding-window SSIM over an 80-asset,
// 1197x4490 design takes ~70s and freezes the tab. A coarse spatial
// stride is fast but unreliable: the SSIM peak is sharp, so when the true
// spot sits between grid points another better-aligned region can win.
//
// Instead we use an image pyramid. We search the WHOLE reference at a
// small "coarse" resolution (stride 1 → no aliasing), keep the top-K
// non-overlapping candidates, then refine each in a tiny window at a
// higher "fine" resolution and take the global best. ~6s for 80 assets
// at ~96-100% accuracy; the few misses are fixed by dragging.
// ============================================================
const MATCH_COARSE = 120;   // coarse pyramid width
const MATCH_FINE = 360;     // fine pyramid width
const TOPK = 12;            // candidates carried from coarse to fine

// Reuse one scratch canvas — matching calls this thousands of times.
const _scaleCanvas = document.createElement("canvas");
const _scaleCtx = _scaleCanvas.getContext("2d", { willReadFrequently: true });
function getScaledData(img, w, h) {
  _scaleCanvas.width = w; _scaleCanvas.height = h;
  _scaleCtx.clearRect(0, 0, w, h);
  _scaleCtx.drawImage(img, 0, 0, w, h);
  return _scaleCtx.getImageData(0, 0, w, h);
}

// Full dense SSIM score map of a template over a reference (higher = better, range ~[-1,1]).
const C1 = 6.5025, C2 = 58.5225; // (0.01*255)^2, (0.03*255)^2
function ssimMap(rd, refW, refH, td, tmW, tmH) {
  const W = refW - tmW + 1, H = refH - tmH + 1;
  if (W <= 0 || H <= 0) return { map: new Float64Array(1).fill(-1), W: 1, H: 1 };

  // Precompute template mean & variance per channel (reused for every window position).
  let sumT = [0, 0, 0], sumT2 = [0, 0, 0], nOpaque = 0;
  for (let ty = 0; ty < tmH; ty++) {
    for (let tx = 0; tx < tmW; tx++) {
      const ti = (ty * tmW + tx) * 4;
      if (td[ti + 3] < 24) continue;
      nOpaque++;
      for (let c = 0; c < 3; c++) { sumT[c] += td[ti + c]; sumT2[c] += td[ti + c] * td[ti + c]; }
    }
  }
  if (nOpaque === 0) return { map: new Float64Array(W * H).fill(-1), W, H };
  const muT = sumT.map(s => s / nOpaque);
  const sigT2 = sumT2.map((s, c) => s / nOpaque - muT[c] * muT[c]);

  const map = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ssimSum = 0;
      for (let c = 0; c < 3; c++) {
        let sumR = 0, sumR2 = 0, sumTR = 0, n = 0;
        for (let ty = 0; ty < tmH; ty++) {
          const ryB = (y + ty) * refW, tyB = ty * tmW;
          for (let tx = 0; tx < tmW; tx++) {
            const ti = (tyB + tx) * 4;
            if (td[ti + 3] < 24) continue;
            n++;
            const rv = rd[(ryB + x + tx) * 4 + c];
            sumR += rv; sumR2 += rv * rv; sumTR += rv * td[ti + c];
          }
        }
        const muR = sumR / n;
        const sigR2 = sumR2 / n - muR * muR;
        const sigTR = sumTR / n - muT[c] * muR;
        ssimSum += (2 * muT[c] * muR + C1) * (2 * sigTR + C2) /
                   ((muT[c] * muT[c] + muR * muR + C1) * (sigT2[c] + sigR2 + C2));
      }
      map[y * W + x] = ssimSum / 3;
    }
  }
  return { map, W, H };
}

// Extract the K highest-SSIM positions, suppressing a neighbourhood around
// each pick so candidates are spatially distinct (non-maximum suppression).
function topKCandidates(map, W, H, K, sepX, sepY) {
  const work = Float64Array.from(map);
  const out = [];
  for (let k = 0; k < K; k++) {
    let best = -Infinity, bi = -1;
    for (let i = 0; i < work.length; i++) if (work[i] > best) { best = work[i]; bi = i; }
    if (bi < 0 || best === -Infinity) break;
    const cx = bi % W, cy = (bi / W) | 0;
    out.push({ x: cx, y: cy, score: best });
    for (let yy = Math.max(0, cy - sepY); yy <= Math.min(H - 1, cy + sepY); yy++)
      for (let xx = Math.max(0, cx - sepX); xx <= Math.min(W - 1, cx + sepX); xx++)
        work[yy * W + xx] = -Infinity;
  }
  return out;
}

// Dense SSIM over a small window (fine-pass refinement).
function scanWindow(rd, refW, td, tmW, tmH, xs, xe, ys, ye, initBest) {
  let best = initBest, bx = xs, by = ys;
  // Precompute template stats once for all positions in this window.
  let sumT = [0, 0, 0], sumT2 = [0, 0, 0], nOpaque = 0;
  for (let ty = 0; ty < tmH; ty++) {
    for (let tx = 0; tx < tmW; tx++) {
      const ti = (ty * tmW + tx) * 4;
      if (td[ti + 3] < 24) continue;
      nOpaque++;
      for (let c = 0; c < 3; c++) { sumT[c] += td[ti + c]; sumT2[c] += td[ti + c] * td[ti + c]; }
    }
  }
  if (nOpaque === 0) return { x: bx, y: by, score: best };
  const muT = sumT.map(s => s / nOpaque);
  const sigT2 = sumT2.map((s, c) => s / nOpaque - muT[c] * muT[c]);

  for (let y = ys; y <= ye; y++) {
    for (let x = xs; x <= xe; x++) {
      let ssimSum = 0;
      for (let c = 0; c < 3; c++) {
        let sumR = 0, sumR2 = 0, sumTR = 0, n = 0;
        for (let ty = 0; ty < tmH; ty++) {
          const ryB = (y + ty) * refW, tyB = ty * tmW;
          for (let tx = 0; tx < tmW; tx++) {
            const ti = (tyB + tx) * 4;
            if (td[ti + 3] < 24) continue;
            n++;
            const rv = rd[(ryB + x + tx) * 4 + c];
            sumR += rv; sumR2 += rv * rv; sumTR += rv * td[ti + c];
          }
        }
        const muR = sumR / n;
        const sigR2 = sumR2 / n - muR * muR;
        const sigTR = sumTR / n - muT[c] * muR;
        ssimSum += (2 * muT[c] * muR + C1) * (2 * sigTR + C2) /
                   ((muT[c] * muT[c] + muR * muR + C1) * (sigT2[c] + sigR2 + C2));
      }
      const s = ssimSum / 3;
      if (s > best) { best = s; bx = x; by = y; }
    }
  }
  return { x: bx, y: by, score: best };
}

// Build a reusable pyramid context for the SSIM fallback search.
function buildPyramidCtx() {
  const designW = state.layoutW, designH = state.layoutH;
  const fc = Math.min(MATCH_COARSE, designW) / designW;
  const ff = Math.min(MATCH_FINE, designW) / designW;
  const cW = Math.round(designW * fc), cH = Math.round(designH * fc);
  const fW = Math.round(designW * ff), fH = Math.round(designH * ff);
  return {
    designW, designH, fc, ff, cW, cH, fW, fH,
    refCoarse: getScaledData(state.refImg, cW, cH).data,
    refFine: getScaledData(state.refImg, fW, fH).data,
    ratio: ff / fc, pad: Math.ceil(ff / fc) + 3,
  };
}

// Vertical search band per asset from the sN_/footer_ filename convention.
// On a very tall page the coarse pyramid shrinks small/thin assets to a few
// pixels, so their SSIM peak is meaningless and they scatter into the wrong
// section. Restricting each prefixed asset's search to its section's band
// (with ±1 section of slack, since sections aren't equal height) removes the
// cross-section false matches. Assets with no prefix search the whole page.
function sectionBands(assets) {
  const secOf = (name) => {
    const s = /^s(\d+)[_-]/i.exec(name);
    if (s) return parseInt(s[1], 10);
    if (/^footer[_-]/i.test(name)) return "footer";
    return null;
  };
  const secs = assets.map((a) => secOf(a.name));
  let maxN = 0, hasFooter = false;
  for (const s of secs) { if (s === "footer") hasFooter = true; else if (s) maxN = Math.max(maxN, s); }
  const T = maxN + (hasFooter ? 1 : 0);
  if (T === 0) return assets.map(() => null);
  const MARGIN = 1;   // ±1 section of slack
  return secs.map((s) => {
    if (!s) return null;
    const ord = s === "footer" ? T : s;   // 1-based top→bottom position
    return { yLo: Math.max(0, (ord - 1 - MARGIN) / T), yHi: Math.min(1, (ord + MARGIN) / T) };
  });
}

// SSIM pyramid + top-K match for a single asset (the fallback path).
// `band` ({yLo,yHi} fractions, or null) confines the coarse candidate search
// to the asset's section — see sectionBands.
function pyramidMatchAsset(a, p, band) {
  let dispW = Math.min(a.nativeW, p.designW);
  let dispH = a.nativeH * (dispW / a.nativeW);
  if (dispH > p.designH) { dispH = p.designH; dispW = a.nativeW * (dispH / a.nativeH); }

  const ctw = Math.max(2, Math.round(dispW * p.fc));
  const cth = Math.max(2, Math.round(dispH * p.fc));
  const ctd = getScaledData(a.img, ctw, cth).data;
  const { map, W, H } = ssimMap(p.refCoarse, p.cW, p.cH, ctd, ctw, cth);
  if (band) {
    const yLo = band.yLo * H, yHi = band.yHi * H;   // drop out-of-band candidates
    for (let i = 0; i < map.length; i++) { const yy = (i / W) | 0; if (yy < yLo || yy > yHi) map[i] = -Infinity; }
  }
  const cands = topKCandidates(map, W, H, TOPK, Math.ceil(ctw / 2), Math.ceil(cth / 2));

  const ftw = Math.max(2, Math.round(dispW * p.ff));
  const fth = Math.max(2, Math.round(dispH * p.ff));
  const ftd = getScaledData(a.img, ftw, fth).data;
  let best = { x: 0, y: 0, score: -Infinity };
  for (const c of cands) {
    const cx = Math.round(c.x * p.ratio), cy = Math.round(c.y * p.ratio);
    const x0 = Math.max(0, cx - p.pad), x1 = Math.min(p.fW - ftw, cx + p.pad);
    const y0 = Math.max(0, cy - p.pad), y1 = Math.min(p.fH - fth, cy + p.pad);
    if (x1 < x0 || y1 < y0) continue;
    const m = scanWindow(p.refFine, p.fW, ftd, ftw, fth, x0, x1, y0, y1, best.score);
    if (m.score > best.score) best = m;
  }
  a.w = dispW; a.h = dispH;
  if (best.score !== -Infinity) { a.x = best.x / p.ff; a.y = best.y / p.ff; }
  a.score = best.score === -Infinity ? null : best.score;
}

autoPlaceBtn.addEventListener("click", async () => {
  autoPlaceBtn.disabled = true;
  statusEl.textContent = "分析示意圖中…";
  await new Promise((r) => setTimeout(r, 30));

  try {
    beginChange();   // one undo step reverts the whole SSIM pass
    const pctx = buildPyramidCtx();
    const bands = sectionBands(state.assets);   // sN_/footer_ → per-asset vertical band
    for (let i = 0; i < state.assets.length; i++) {
      statusEl.textContent = `SSIM 比對 (${i + 1}/${state.assets.length}) ${state.assets[i].name}`;
      await new Promise((r) => setTimeout(r, 0));   // yield so the UI stays alive
      pyramidMatchAsset(state.assets[i], pctx, bands[i]);
    }

    statusEl.textContent = "✓ 定位完成，可拖曳微調";
    downloadBtn.disabled = false;
    renderLayerList();
    draw();
    saveSession();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "⚠ 定位失敗：" + (err && err.message ? err.message : err);
  } finally {
    autoPlaceBtn.disabled = false;
  }
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================================
// Gemini AI assisted placement (second-pass fix after SSIM)
// ----------------------------------------------------------
// Two user-chosen paths:
//  A) tick misplaced assets in the layer panel → "AI 重新定位" asks Gemini
//     to locate each ticked asset inside the reference and applies directly.
//  B) "AI 全面檢查" (double check) sends the reference + current layout and
//     asks which assets look misplaced; results become per-asset suggestions
//     the user applies/dismisses one by one — never auto-overwritten.
// This is the project's ONLY network call, fired only by these two buttons.
// Box convention: box_2d = [ymin, xmin, ymax, xmax] normalized to 0-1000.
// ============================================================
const GEMINI_LS_KEY = "gemini-key";
const GEMINI_LS_MODEL = "gemini-model";
const AI_BATCH = 8;            // assets per request (free-tier RPM is tight)

geminiKeyInput.value = localStorage.getItem(GEMINI_LS_KEY) || "";
geminiModelSelect.value = localStorage.getItem(GEMINI_LS_MODEL) || "gemini-2.5-flash";
geminiKeyInput.addEventListener("input", () => {
  localStorage.setItem(GEMINI_LS_KEY, geminiKeyInput.value.trim());
  updateAiButtons();
});
geminiModelSelect.addEventListener("change", () =>
  localStorage.setItem(GEMINI_LS_MODEL, geminiModelSelect.value));

// Downscale an image and wrap it as an inline_data part. Coordinates come
// back normalized (0-1000) so shrinking never hurts positional accuracy.
function imgToInlinePart(img, maxDim) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  _scaleCanvas.width = w; _scaleCanvas.height = h;
  _scaleCtx.clearRect(0, 0, w, h);
  _scaleCtx.drawImage(img, 0, 0, w, h);
  return { inline_data: { mime_type: "image/png", data: _scaleCanvas.toDataURL("image/png").split(",")[1] } };
}

// Snapshot of the CURRENT layout (bg + visible assets, no reference overlay)
// so Gemini can compare it against the reference in double-check mode.
function currentLayoutPart(maxDim = 1536) {
  const s = Math.min(1, maxDim / Math.max(state.layoutW, state.layoutH));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(state.layoutW * s));
  c.height = Math.max(1, Math.round(state.layoutH * s));
  const cx = c.getContext("2d");
  cx.drawImage(state.bg.img, 0, 0, c.width, c.height);
  for (const a of state.assets) {
    if (a.visible === false) continue;
    cx.drawImage(a.img, a.x * s, a.y * s, a.w * s, a.h * s);
  }
  return { inline_data: { mime_type: "image/png", data: c.toDataURL("image/png").split(",")[1] } };
}

// One generateContent call with structured JSON output. Throws with a
// user-facing message on failure; callers surface it via statusEl.
async function geminiCall(parts, responseSchema) {
  const key = geminiKeyInput.value.trim();
  const model = geminiModelSelect.value;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema },
      }),
    }
  );
  if (!res.ok) {
    let apiMsg = "";
    try { apiMsg = (await res.json()).error?.message || ""; } catch { /* keep generic */ }
    if (res.status === 401 || res.status === 403 || /api key/i.test(apiMsg))
      throw new Error("API key 無效或無權限");
    if (res.status === 429) throw new Error("已達速率上限，請稍後再試");
    throw new Error(apiMsg || "HTTP " + res.status);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini 回應為空");
  return JSON.parse(text);
}

// box_2d (0-1000 on the reference) → layout-space rect. Gemini's box only
// decides WHERE the asset goes; its SIZE stays the asset's native size (the
// same sizing the SSIM path uses), so a loose/tight box can't distort it.
// The asset is centred on the box centre.
function boxToRect(a, box) {
  const [ymin, xmin, ymax, xmax] = box;
  let w = Math.min(a.nativeW, state.layoutW);
  let h = a.nativeH * (w / a.nativeW);
  if (h > state.layoutH) { h = state.layoutH; w = a.nativeW * (h / a.nativeH); }
  const cx = (xmin + xmax) / 2 / 1000 * state.layoutW;
  const cy = (ymin + ymax) / 2 / 1000 * state.layoutH;
  return {
    x: clamp(cx - w / 2, 0, Math.max(0, state.layoutW - w)),
    y: clamp(cy - h / 2, 0, Math.max(0, state.layoutH - h)),
    w, h,
  };
}

// Local SSIM snap after an AI placement. AI gets the SIZE (native) and section
// right but the position can be a few px off; this slides the asset to the best
// SSIM match in a SMALL window around it — size is never touched. Right scale +
// tiny window + right region is exactly where SSIM is reliable. The scale is
// picked per asset so the template's long side ≈ REFINE_TARGET, which bounds the
// cost no matter how large the asset is. Only the reference sub-region is read.
const REFINE_TARGET = 100;   // template long-side after scaling (keeps the SSIM cost bounded)
const REFINE_RADIUS = 30;    // search radius in SCALED px — a small window (2·radius wide)
function localRefine(a) {
  const LW = state.layoutW, LH = state.layoutH;
  if (!state.refImg || !a.img || a.w < 2 || a.h < 2) return;
  // Scale so the template long-side ≈ REFINE_TARGET; the scan window is then a
  // fixed ±REFINE_RADIUS in scaled px, so cost stays bounded for any asset size
  // (a larger asset just means a larger design-space search radius, and vice
  // versa). This keeps the search a genuinely SMALL window near the AI spot.
  const sf = Math.min(1, REFINE_TARGET / Math.max(a.w, a.h));
  const Rd = REFINE_RADIUS / sf;   // design-space radius
  const rx0 = Math.max(0, a.x - Rd), ry0 = Math.max(0, a.y - Rd);
  const rx1 = Math.min(LW, a.x + a.w + Rd), ry1 = Math.min(LH, a.y + a.h + Rd);
  const regW = rx1 - rx0, regH = ry1 - ry0;
  if (regW <= a.w || regH <= a.h) return;
  const sw = Math.max(2, Math.round(regW * sf)), sh = Math.max(2, Math.round(regH * sf));
  const tw = Math.max(2, Math.round(a.w * sf)), th = Math.max(2, Math.round(a.h * sf));
  if (tw >= sw || th >= sh) return;
  // Draw the reference sub-region into the scratch canvas and read it out BEFORE
  // getScaledData reuses the same canvas for the template.
  const rimg = state.refImg;
  const kx = (rimg.naturalWidth || rimg.width) / LW, ky = (rimg.naturalHeight || rimg.height) / LH;
  _scaleCanvas.width = sw; _scaleCanvas.height = sh;
  _scaleCtx.clearRect(0, 0, sw, sh);
  _scaleCtx.drawImage(rimg, rx0 * kx, ry0 * ky, regW * kx, regH * ky, 0, 0, sw, sh);
  const rdata = _scaleCtx.getImageData(0, 0, sw, sh).data;
  const td = getScaledData(a.img, tw, th).data;
  const m = scanWindow(rdata, sw, td, tw, th, 0, sw - tw, 0, sh - th, -Infinity);
  if (m.score === -Infinity) return;
  a.x = rx0 + m.x / sf;   // top-left in region px → design space
  a.y = ry0 + m.y / sf;
  a.score = m.score;
}

// Shared filename convention for BOTH AI modes. Prefix → vertical section:
//   `s<N>_...` (s1_logo.png, s2_banner.png…) = Nth section from the top.
//   `footer_...` (footer_logo.png…)          = the footer, always at the bottom.
// On event pages that stack near-identical blocks downward, these prefixes are
// a strong vertical-band prior that pure image matching can't recover on its own.
const SECTION_NAMING_HINT =
  "命名慣例：整個版面由上到下分成數個區塊；素材檔名的前綴代表它所屬的區塊。" +
  "「s + 數字」開頭（例如 s1_logo.png、s2_banner.png）代表由上往下數第 N 個區塊，" +
  "s1 在最上方、數字越大越往下；「footer」開頭（例如 footer_logo.png）代表版面最底部的頁尾區塊，" +
  "永遠位在所有 sN 區塊之下。請把前綴當成該素材「垂直落在哪個區塊」的強提示：" +
  "先據此鎖定所屬區塊，再靠圖像內容決定精確位置。沒有這種前綴的素材就純粹依圖像內容判斷。";

const BOX_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      index: { type: "INTEGER" },
      box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
    },
    required: ["index", "box_2d"],
  },
};

// ---- A) Re-place the ticked assets ----
aiFixBtn.addEventListener("click", async () => {
  const picked = state.selection.map((i) => ({ a: state.assets[i], i })).filter((p) => p.a);
  if (!picked.length) return;
  aiFixBtn.disabled = true; aiCheckBtn.disabled = true;

  try {
    for (let b = 0; b < picked.length; b += AI_BATCH) {
      const batch = picked.slice(b, b + AI_BATCH);
      statusEl.textContent = `AI 重新定位中… (${Math.min(b + AI_BATCH, picked.length)}/${picked.length})`;
      const parts = [
        { text:
          "第一張圖是完整的版面示意圖。之後每張圖是一個素材，依序編號 asset_0、asset_1…。" +
          "請在示意圖中找出每個素材出現的位置，回傳 JSON 陣列，每個元素為 " +
          '{"index": 素材編號, "box_2d": [ymin, xmin, ymax, xmax]}，' +
          "box_2d 是該素材在示意圖上的範圍，normalized 到 0-1000。\n" +
          SECTION_NAMING_HINT },
        imgToInlinePart(state.refImg, 1536),
      ];
      batch.forEach((p, bi) => {
        parts.push({ text: `asset_${bi}（檔名 ${p.a.name}）：` });
        parts.push(imgToInlinePart(p.a.img, 512));
      });

      const out = await geminiCall(parts, BOX_SCHEMA);
      for (const r of Array.isArray(out) ? out : []) {
        const p = batch[r.index];
        if (!p || !Array.isArray(r.box_2d) || r.box_2d.length !== 4) continue;
        const rect = boxToRect(p.a, r.box_2d);
        p.a.x = rect.x; p.a.y = rect.y; p.a.w = rect.w; p.a.h = rect.h;
      }
    }
    statusEl.textContent = "SSIM 微調位置中…";
    await new Promise((r) => setTimeout(r, 0));
    for (const p of picked) localRefine(p.a);   // snap each to the local SSIM optimum
    statusEl.textContent = "✓ AI 重新定位完成，可拖曳微調";
    renderLayerList(); draw(); saveSession();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "⚠ AI 定位失敗：" + (err && err.message ? err.message : err);
  } finally {
    updateAiButtons();
  }
});

// ---- B) Double check the whole layout → per-asset suggestions ----
const CHECK_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      index: { type: "INTEGER" },
      ok: { type: "BOOLEAN" },
      box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
    },
    required: ["index", "ok"],
  },
};

aiCheckBtn.addEventListener("click", async () => {
  aiFixBtn.disabled = true; aiCheckBtn.disabled = true;
  statusEl.textContent = "AI 全面檢查中…";

  try {
    const layoutList = state.assets.map((a, i) => ({
      index: i,
      name: a.name,
      box_2d: [
        Math.round(a.y / state.layoutH * 1000),
        Math.round(a.x / state.layoutW * 1000),
        Math.round((a.y + a.h) / state.layoutH * 1000),
        Math.round((a.x + a.w) / state.layoutW * 1000),
      ],
    }));
    const parts = [
      { text:
        "第一張圖是目標版面示意圖，第二張圖是目前的排版結果。" +
        "以下 JSON 是目前每個素材的位置（box_2d = [ymin, xmin, ymax, xmax]，normalized 0-1000）：\n" +
        JSON.stringify(layoutList) + "\n" +
        SECTION_NAMING_HINT + "\n" +
        "請逐一比對示意圖，判斷每個素材的位置是否正確" +
        "（含檔名有「s + 數字」或「footer」前綴者是否落在對應區塊）。回傳 JSON 陣列，每個元素為 " +
        '{"index": 編號, "ok": true 或 false, "box_2d": [...]}；' +
        "ok 為 false 時 box_2d 必須給出該素材在示意圖上的正確位置，ok 為 true 時省略 box_2d。" },
      imgToInlinePart(state.refImg, 1536),
      currentLayoutPart(),
    ];

    const out = await geminiCall(parts, CHECK_SCHEMA);
    state.assets.forEach((a) => { a.suggest = null; });
    let flagged = 0;
    for (const r of Array.isArray(out) ? out : []) {
      const a = state.assets[r.index];
      if (!a || r.ok !== false || !Array.isArray(r.box_2d) || r.box_2d.length !== 4) continue;
      a.suggest = boxToRect(a, r.box_2d);
      flagged++;
    }
    statusEl.textContent = flagged
      ? `AI 檢查完成：${flagged} 項疑似錯位，請在左側逐項確認`
      : "✓ AI 檢查完成：全部位置正確";
    renderLayerList(); draw();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "⚠ AI 檢查失敗：" + (err && err.message ? err.message : err);
  } finally {
    updateAiButtons();
  }
});

// Apply / dismiss a double-check suggestion (suggest is transient UI state —
// it is deliberately NOT persisted to IndexedDB).
function applySuggest(idx) {
  const a = state.assets[idx];
  if (!a || !a.suggest) return;
  beginChange();
  a.x = a.suggest.x; a.y = a.suggest.y; a.w = a.suggest.w; a.h = a.suggest.h;
  a.suggest = null;
  localRefine(a);   // SSIM snap the position within a small window (size kept)
  renderLayerList(); draw(); saveSession();
}

function dismissSuggest(idx) {
  const a = state.assets[idx];
  if (!a) return;
  a.suggest = null;
  renderLayerList(); draw();
}

// ============================================================
// Selection, undo history, and direct manipulation on the board
// ============================================================
// Selection is a list of asset indices. Clicking selects one; Shift toggles.
function selectAsset(i, additive) {
  if (additive) {
    const p = state.selection.indexOf(i);
    if (p >= 0) state.selection.splice(p, 1); else state.selection.push(i);
  } else {
    state.selection = [i];
  }
  renderLayerList(); draw();
}
function clearSelection() {
  if (!state.selection.length) return;
  state.selection = [];
  renderLayerList(); draw();
}

// Undo/redo. A snapshot keeps each asset's object reference plus its geometry
// and visibility, so deletes and reorders are fully reversible.
const undoStack = [], redoStack = [];
function snapAssets() {
  return state.assets.map((a) => ({ a, x: a.x, y: a.y, w: a.w, h: a.h, visible: a.visible !== false }));
}
function restoreAssets(entry) {
  state.assets = entry.map((e) => { e.a.x = e.x; e.a.y = e.y; e.a.w = e.w; e.a.h = e.h; e.a.visible = e.visible; return e.a; });
}
function beginChange() {
  undoStack.push(snapAssets());
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapAssets());
  restoreAssets(undoStack.pop());
  state.selection = [];
  renderLayerList(); draw(); saveSession();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapAssets());
  restoreAssets(redoStack.pop());
  state.selection = [];
  renderLayerList(); draw(); saveSession();
}
function deleteSelected() {
  if (!state.selection.length) return;
  beginChange();
  for (const i of [...state.selection].sort((a, b) => b - a)) state.assets.splice(i, 1);
  state.selection = [];
  renderLayerList(); draw(); saveSession();
}

// layout px per rendered px, plus the board's screen rect (for pointer math).
function boardMetrics() {
  const rect = board.getBoundingClientRect();
  return { rect, k: state.layoutW ? state.layoutW / rect.width : 1 };
}

let itx = null;   // active interaction: move or resize

board.addEventListener("mousedown", (e) => {
  if (!state.bg) return;
  const handle = e.target.closest(".handle");
  const elDiv = e.target.closest(".asset-el");
  const { k } = boardMetrics();

  if (handle && state.selection.length === 1) {
    const i = state.selection[0], a = state.assets[i];
    itx = { mode: "resize", corner: handle.dataset.corner, k, began: false,
      orig: { x: a.x, y: a.y, w: a.w, h: a.h, right: a.x + a.w, bottom: a.y + a.h, aspect: a.nativeH / a.nativeW } };
    e.preventDefault(); return;
  }
  if (elDiv) {
    const i = +elDiv.dataset.idx;
    if (e.shiftKey) { selectAsset(i, true); e.preventDefault(); return; }
    if (!state.selection.includes(i)) { state.selection = [i]; renderLayerList(); draw(); }
    itx = { mode: "move", k, sx: e.clientX, sy: e.clientY, began: false,
      orig: state.selection.map((idx) => ({ i: idx, x: state.assets[idx].x, y: state.assets[idx].y })) };
    e.preventDefault(); return;
  }
  if (!e.shiftKey) clearSelection();   // click on empty board
});

window.addEventListener("mousemove", (e) => {
  if (!itx) return;
  if (!itx.began) { beginChange(); itx.began = true; }
  if (itx.mode === "move") {
    const dx = (e.clientX - itx.sx) * itx.k, dy = (e.clientY - itx.sy) * itx.k;
    itx.orig.forEach((o) => { const a = state.assets[o.i]; a.x = o.x + dx; a.y = o.y + dy; });
    const guides = snapSelection();
    const W = state.layoutW, H = state.layoutH;
    for (const idx of state.selection) { const a = state.assets[idx]; a.x = clamp(a.x, 0, W - a.w); a.y = clamp(a.y, 0, H - a.h); }
    draw(guides);
  } else {
    resizeTo(e);
    draw();
  }
});

window.addEventListener("mouseup", () => {
  if (!itx) return;
  const changed = itx.began;
  itx = null;
  guideLayer.innerHTML = "";
  if (changed) { renderLayerList(); draw(); saveSession(); }
});

// Snap the selection's bounding box to nearby asset edges/centers and to the
// board's own edges/centerlines. Returns guide lines to draw at the snap.
function snapSelection() {
  const W = state.layoutW, H = state.layoutH, thr = 6 * itx.k;
  const sel = new Set(state.selection);
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const idx of state.selection) { const a = state.assets[idx]; minX = Math.min(minX, a.x); minY = Math.min(minY, a.y); maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const targX = [0, W / 2, W], targY = [0, H / 2, H];
  state.assets.forEach((a, idx) => {
    if (sel.has(idx) || a.visible === false) return;
    targX.push(a.x, a.x + a.w / 2, a.x + a.w);
    targY.push(a.y, a.y + a.h / 2, a.y + a.h);
  });
  const best = (srcs, targs) => {
    let b = null;
    for (const s of srcs) for (const t of targs) { const d = Math.abs(s - t); if (d <= thr && (!b || d < b.d)) b = { d, off: t - s, pos: t }; }
    return b;
  };
  const bx = best([minX, cx, maxX], targX), by = best([minY, cy, maxY], targY);
  const guides = [];
  if (bx) { for (const idx of state.selection) state.assets[idx].x += bx.off; guides.push({ type: "v", pos: bx.pos }); }
  if (by) { for (const idx of state.selection) state.assets[idx].y += by.off; guides.push({ type: "h", pos: by.pos }); }
  return guides;
}

// Four-corner proportional resize (height derives from width to keep aspect,
// matching the exported height:auto). The opposite corner stays anchored.
function resizeTo(e) {
  const { rect, k } = boardMetrics();
  const W = state.layoutW, H = state.layoutH, MIN = 8;
  const px = (e.clientX - rect.left) * k, py = (e.clientY - rect.top) * k;
  const o = itx.orig, c = itx.corner, asp = o.aspect;
  let w = (c === "se" || c === "ne") ? clamp(px - o.x, MIN, W - o.x) : clamp(o.right - px, MIN, o.right);
  let h = w * asp;
  if (c === "se" || c === "sw") { if (o.y + h > H) { h = H - o.y; w = h / asp; } }
  else { if (o.bottom - h < 0) { h = o.bottom; w = h / asp; } }
  let x, y;
  if (c === "se") { x = o.x; y = o.y; }
  else if (c === "sw") { x = o.right - w; y = o.y; }
  else if (c === "ne") { x = o.x; y = o.bottom - h; }
  else { x = o.right - w; y = o.bottom - h; }
  const a = state.assets[itx.i !== undefined ? itx.i : state.selection[0]];
  a.w = w; a.h = h; a.x = clamp(x, 0, W - w); a.y = clamp(y, 0, H - h);
}

// Keyboard: Delete removes selection; Ctrl/Cmd+Z undo, +Shift or Ctrl+Y redo.
window.addEventListener("keydown", (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const meta = e.ctrlKey || e.metaKey;
  if (meta && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (meta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && state.selection.length) { e.preventDefault(); deleteSelected(); }
});

// ============================================================
// Layer list
// ============================================================
// Toggle a layer's visibility (the eye button).
function toggleVisible(idx) {
  const a = state.assets[idx];
  if (!a) return;
  beginChange();
  a.visible = a.visible === false;   // flips false<->true; undefined treated as visible
  renderLayerList();
  draw();
  saveSession();
}

// Drag-to-reorder: after a drop the panel's DOM order is the source of truth.
// The panel shows front-most first, so state.assets is the reverse of DOM order.
let dragEl = null;
function commitReorderFromDom() {
  const visual = [...layerList.querySelectorAll(".layer-item")].map((el) => el._asset).filter(Boolean);
  if (visual.length !== state.assets.length) return;   // bg row / stale DOM — bail safely
  const next = visual.slice().reverse();
  if (next.every((a, k) => a === state.assets[k])) return;   // order unchanged
  beginChange();
  state.assets = next;
  state.selection = [];   // indices shifted on reorder
  renderLayerList();
  draw();
  saveSession();
}

function renderLayerList() {
  layerList.innerHTML = "";

  // Show front-most first (last in array = drawn on top = top of the panel).
  for (let i = state.assets.length - 1; i >= 0; i--) {
    const a = state.assets[i];
    const hidden = a.visible === false;
    const li = document.createElement("li");
    li.className = "layer-item" + (hidden ? " hidden-layer" : "") + (state.selection.includes(i) ? " selected" : "");
    li._asset = a;                          // drag-reorder reads DOM order back through this

    const eye = document.createElement("button");
    eye.className = "eye-btn";
    eye.title = hidden ? "顯示" : "隱藏";
    eye.textContent = hidden ? "🙈" : "👁";
    eye.addEventListener("click", (e) => { e.stopPropagation(); toggleVisible(i); });

    const thumb = document.createElement("img");
    thumb.src = a.img.src;
    thumb.alt = "";
    thumb.draggable = false;                // let the <li> own the drag, not the image

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = a.name;

    li.append(eye, thumb, nm);
    if (a.suggest) {
      // Double-check flagged this asset. The apply/dismiss controls live on
      // their own full-width row below (.suggest-row) so they wrap downward
      // instead of pushing the layer row off the edge of the panel.
      const sgRow = document.createElement("div");
      sgRow.className = "suggest-row";
      const bd = document.createElement("span");
      bd.className = "suggest-badge"; bd.textContent = "建議移動";
      const ap = document.createElement("button");
      ap.className = "mini-btn"; ap.textContent = "套用";
      ap.title = "移動到畫布上綠色虛線框的位置";
      ap.addEventListener("click", (e) => { e.stopPropagation(); applySuggest(i); });
      const ig = document.createElement("button");
      ig.className = "mini-btn dismiss"; ig.textContent = "忽略";
      ig.addEventListener("click", (e) => { e.stopPropagation(); dismissSuggest(i); });
      sgRow.append(bd, ap, ig);
      li.appendChild(sgRow);
    } else if (a.score != null) {
      const sc = document.createElement("span");
      sc.className = "score"; sc.textContent = "ssim " + (a.score * 100).toFixed(1) + "%";
      li.appendChild(sc);
    }

    // Click to select; Shift-click adds/removes from the multi-selection.
    li.addEventListener("click", (e) => selectAsset(i, e.shiftKey));

    // Drag the whole row to reorder the stacking order (replaces the ▲▼ buttons).
    li.draggable = true;
    li.addEventListener("dragstart", (e) => {
      dragEl = li; li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");   // Firefox won't start a drag without data
    });
    li.addEventListener("dragover", (e) => {
      if (!dragEl || dragEl === li) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      layerList.insertBefore(dragEl, after ? li.nextSibling : li);
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      dragEl = null;
      commitReorderFromDom();
    });

    layerList.appendChild(li);
  }

  if (state.bg) {
    const li = document.createElement("li");
    li.className = "layer-item bg";
    li.innerHTML = `<img src="${state.bg.img.src}" alt=""><span class="nm">${state.bg.name} (底圖)</span>`;
    layerList.appendChild(li);
  }

  updateAiButtons();   // "AI 重新定位" is gated on the current selection
}

// ============================================================
// Export: build self-contained HTML / CSS / JS
// ============================================================
function imgToDataURL(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

// Percentage of a length relative to the design dimension, to 2 decimals.
function pct(value, total) {
  return (Math.round((value / total) * 10000) / 100).toFixed(2);
}

function buildExport() {
  const bgURL = imgToDataURL(state.bg.img);
  const W = state.layoutW, H = state.layoutH;

  let itemsHTML = "";
  let itemsCSS = "";
  state.assets.forEach((a, i) => {
    if (a.visible === false) return;   // hidden layers are excluded from export
    const cls = `item-${i + 1}`;
    const safeName = a.name.replace(/"/g, "");
    itemsHTML += `      <img class="${cls}" src="${imgToDataURL(a.img)}" alt="${safeName}" />\n`;
    // Absolute + %: position and width scale fluidly with the container;
    // height:auto (from the rule below) preserves each image's aspect ratio.
    // z-index follows stacking order so overlapping images keep their layering.
    itemsCSS +=
`.${cls} {
  left: ${pct(a.x, W)}%;
  top: ${pct(a.y, H)}%;
  width: ${pct(a.w, W)}%;
  z-index: ${i + 1};
}
`;
  });

  const css =
`/* Generated by Layout Studio */
* { margin: 0; padding: 0; box-sizing: border-box; }

.layout {
  position: relative;
  width: 100%;
  max-width: ${W}px;
  margin: 0 auto;
  aspect-ratio: ${W} / ${H};
  background-image: url("${bgURL}");
  background-size: cover;
  background-position: center;
}

/* Every piece is absolutely positioned by % and keeps its own aspect ratio,
   so the whole layout scales fluidly (RWD) and images never distort. */
.layout img {
  position: absolute;
  height: auto;
  display: block;
}

${itemsCSS}`;

  const html =
`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Exported Layout</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="layout">
${itemsHTML}  </div>
  <script src="script.js"><\/script>
</body>
</html>
`;

  const js =
`/* Generated by Layout Studio */
document.addEventListener("DOMContentLoaded", () => {
  const layout = document.querySelector(".layout");
  console.log("Layout ready:", "${W}x${H}", "${state.assets.length} items");

  // Toggle element outlines with the "g" key (handy for verifying placement).
  let outline = false;
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "g") return;
    outline = !outline;
    layout.querySelectorAll("img").forEach((el) => {
      el.style.outline = outline ? "1px solid rgba(91,140,255,.8)" : "none";
    });
  });
});
`;

  return { html, css, js };
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Minimal ZIP encoder (store / no compression) ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  // entries: [{ name, bytes:Uint8Array }]
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]);

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
      nameBytes, e.bytes,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  central.forEach((c) => { chunks.push(c); centralSize += c.length; });
  chunks.push(concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralSize), u32(centralStart), u16(0),
  ]));
  return new Blob(chunks, { type: "application/zip" });
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

downloadBtn.addEventListener("click", () => {
  if (!state.bg || !state.assets.length) return;
  const { html, css, js } = buildExport();
  const enc = new TextEncoder();
  const zip = makeZip([
    { name: "index.html", bytes: enc.encode(html) },
    { name: "styles.css", bytes: enc.encode(css) },
    { name: "script.js", bytes: enc.encode(js) },
  ]);
  downloadBlob("layout-export.zip", zip);
  statusEl.textContent = "✓ 已下載 layout-export.zip(含 index.html / styles.css / script.js)";
});

// ============================================================
// Auto-save / restore (IndexedDB)
// ----------------------------------------------------------
// The whole working session (reference, bg, assets + positions and
// grid settings) is persisted to IndexedDB so a crash, reload, or
// accidental close never loses your work. Images are stored as blobs
// (after the MAX_DIM downscale) so this stays well within quota.
// ============================================================
const DB_NAME = "layout-studio";
const STORE = "session";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let saveTimer = null;
function saveSession() {
  // Debounce: many rapid edits (dragging, typing) collapse to one write.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}

async function doSave() {
  if (!state.bg && !state.refBlob) return;
  try {
    const record = {
      refBlob: state.refBlob || null,
      refNameTxt: refName.textContent,
      bg: state.bg ? { name: state.bg.name, blob: state.bg.blob, nativeW: state.bg.nativeW, nativeH: state.bg.nativeH } : null,
      assets: state.assets.map((a) => ({
        name: a.name, blob: a.blob, nativeW: a.nativeW, nativeH: a.nativeH,
        x: a.x, y: a.y, w: a.w, h: a.h, score: a.score, visible: a.visible !== false,
      })),
      layoutW: state.layoutW,
      layoutH: state.layoutH,
    };
    await idbPut("current", record);
    const t = new Date();
    saveStatus.textContent = `已自動存檔 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  } catch (err) {
    console.error(err);
    saveStatus.textContent = "⚠ 自動存檔失敗";
  }
}

async function restoreSession() {
  let record;
  try { record = await idbGet("current"); } catch { return; }
  if (!record) return;

  try {
    if (record.refBlob) {
      state.refImg = await loadImage(URL.createObjectURL(record.refBlob));
      state.refBlob = record.refBlob;
      refName.textContent = record.refNameTxt || "（已還原）";
    }
    if (record.bg) {
      const img = await loadImage(URL.createObjectURL(record.bg.blob));
      state.bg = { name: record.bg.name, img, blob: record.bg.blob,
        nativeW: record.bg.nativeW || img.width, nativeH: record.bg.nativeH || img.height };
    }
    state.assets = [];
    for (const a of record.assets || []) {
      const img = await loadImage(URL.createObjectURL(a.blob));
      const nativeW = a.nativeW || img.width, nativeH = a.nativeH || img.height;
      // Keep aspect ratio: height always derives from width (fixes any legacy
      // distorted saves from the old grid-cell snapping).
      const w = a.w, h = w * (nativeH / nativeW);
      state.assets.push({ name: a.name, img, blob: a.blob, nativeW, nativeH,
        x: a.x, y: a.y, w, h, score: a.score, visible: a.visible !== false });
    }
    state.layoutW = record.layoutW;
    state.layoutH = record.layoutH;

    if (state.bg) {
      folderName.textContent = `bg.png + ${state.assets.length} 張素材（已還原）`;
      renderLayerList();
    }
    if (state.refImg && record.refNameTxt) refName.textContent = record.refNameTxt;
    // Draw whatever we have (bg+assets, or reference-only preview).
    if (state.bg || state.refImg) { setupCanvas(); draw(); }
    tryEnableAutoPlace();
    saveStatus.textContent = "✓ 已還原上次工作進度";
  } catch (err) {
    console.error(err);
    saveStatus.textContent = "⚠ 還原失敗";
  }
}

// Wipe the whole working session (in-memory + UI + autosave) for a fresh start.
resetBtn.addEventListener("click", async () => {
  if (!confirm("確定要清空目前所有內容並重新開始嗎？(會一併刪除自動存檔)")) return;

  state.refImg = null; state.refBlob = null;
  state.bg = null; state.assets = [];
  state.layoutW = 0; state.layoutH = 0; state.drag = null;
  state.selection = []; undoStack.length = 0; redoStack.length = 0;

  refInput.value = ""; folderInput.value = ""; filesInput.value = "";
  refName.textContent = "未選擇";
  folderName.textContent = "未選擇";
  statusEl.textContent = "";
  layerList.innerHTML = "";
  assetLayer.innerHTML = ""; guideLayer.innerHTML = "";
  board.style.display = "none";
  boardBg.removeAttribute("src"); boardRef.removeAttribute("src");
  showRefToggle.checked = true;
  refOpacitySlider.value = 100; refOpacityVal.textContent = "100%";
  autoPlaceBtn.disabled = true;
  downloadBtn.disabled = true;

  try { await idbDelete("current"); } catch (e) { console.error(e); }
  saveStatus.textContent = "已清空，可重新上傳";
});

// Restore any previous session as soon as the page loads.
restoreSession();
