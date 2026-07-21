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
  zoom: 1,             // board display zoom factor; 1 = fit the column width
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

// The layers panel sticks below the sticky controls bar. The bar's height
// varies (flex-wrap on narrow windows), so publish it as --controls-h for
// the panel's sticky offset instead of hardcoding it in CSS.
const controlsBar = document.querySelector(".controls");
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--controls-h", controlsBar.offsetHeight + "px");
}).observe(controlsBar);

// ============================================================
// Board zoom — Ctrl/Cmd +/- and 0, ctrl+wheel, trackpad pinch
// ============================================================
// Zoom multiplies the board's fit-to-column width. Display-only: asset coords
// live in layout px and every pointer conversion derives its ratio from the
// board's live rect (boardMetrics), so dragging works unchanged at any zoom.
const canvasWrap = document.querySelector(".canvas-wrap");
const zoomBadge = el("zoomBadge");
const MIN_ZOOM = 0.25, MAX_ZOOM = 4, ZOOM_STEP = 1.25;

function applyZoom() {
  const d = currentDims();
  if (!d) return;
  board.style.width = state.zoom * 100 + "%";
  board.style.maxWidth = d.W * state.zoom + "px";
}

let zoomBadgeTimer = 0;
function showZoomBadge() {
  zoomBadge.textContent = Math.round(state.zoom * 100) + "%";
  zoomBadge.classList.add("show");
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => zoomBadge.classList.remove("show"), 1400);
}

// Re-render the board at zoom `z`, keeping the point under (ax, ay) — client
// coords — visually fixed. Without an anchor, hold the visible board centre.
// Horizontal compensation goes to the viewport scroller, vertical to the page
// (the board scrolls with the document, only its overflow-x is local).
function setZoom(z, ax, ay) {
  if (!currentDims() || itx) return;   // no board yet / mid-drag (its k is cached per gesture)
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  if (ax === undefined) {
    const vr = viewport.getBoundingClientRect();
    ax = (Math.max(vr.left, 0) + Math.min(vr.right, innerWidth)) / 2;
    ay = (Math.max(vr.top, 0) + Math.min(vr.bottom, innerHeight)) / 2;
  }
  const r1 = board.getBoundingClientRect();
  const fx = (ax - r1.left) / r1.width, fy = (ay - r1.top) / r1.height;
  state.zoom = z;
  applyZoom();
  const r2 = board.getBoundingClientRect();
  viewport.scrollLeft += r2.left + fx * r2.width - ax;
  window.scrollBy(0, r2.top + fy * r2.height - ay);
  showZoomBadge();
}

// ctrl+wheel = zoom at the cursor. Chrome/Edge/Firefox surface trackpad pinch
// as exactly this event, so one listener covers both. Non-passive on purpose:
// preventDefault is what keeps the browser's own page zoom off.
canvasWrap.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (!currentDims()) return;          // empty board: leave the page zoom alone
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // Firefox line-mode wheels
  setZoom(state.zoom * Math.exp(-dy * 0.002), e.clientX, e.clientY);
}, { passive: false });

// Safari doesn't translate pinch into ctrl+wheel — it fires proprietary
// gesture events instead. Same handling; e.scale is cumulative per gesture.
if (typeof GestureEvent !== "undefined") {
  let pinchStart = 1;
  canvasWrap.addEventListener("gesturestart", (e) => { e.preventDefault(); pinchStart = state.zoom; });
  canvasWrap.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (currentDims()) setZoom(pinchStart * e.scale, e.clientX, e.clientY);
  });
  canvasWrap.addEventListener("gestureend", (e) => e.preventDefault());
}

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
  // Import order mirrors page structure: header* first, footer* last, the rest
  // natural-ordered by basename in between (s2 before s10) — FileList order
  // from folder uploads is filesystem/lexicographic and varies by browser.
  const basename = (f) => f.name.split("/").pop();
  const rank = (n) => (/^header/i.test(n) ? 0 : /^footer/i.test(n) ? 2 : 1);
  const files = [...fileList]
    .filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
    .sort((a, b) => {
      const an = basename(a), bn = basename(b);
      return rank(an) - rank(bn) ||
        an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
    });
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
  downloadBtn.disabled = !(state.bg && state.assets.length);
  updateAiButtons();   // owns autoPlaceBtn too, so the review-gate below covers it
}

// Placement buttons need refImg+bg (SSIM auto-place) or that PLUS an API key and
// a selection (AI). While a review set is still open (any a.suggest unresolved),
// ALL of them stay disabled — re-triggering would wipe the pending suggestions
// mid-review and, for the AI buttons, fire a redundant Gemini call. This is the
// single choke point (applySuggest/dismissSuggest re-run it via renderLayerList),
// so every button re-enables once the last suggestion is resolved.
function updateAiButtons() {
  const reviewing = state.assets.some((a) => a.suggest);
  autoPlaceBtn.disabled = !(state.refImg && state.bg) || reviewing;
  const ready = state.refImg && state.bg && state.assets.length && geminiKeyInput.value.trim();
  aiCheckBtn.disabled = !ready || reviewing;
  aiFixBtn.disabled = !(ready && state.selection.length) || reviewing;
}

function defaultLayout() {
  // Tile in rows, wrapping inside the board width; a single column runs off
  // the bottom as soon as the assets outgrow the design height.
  const M = 16;
  let x = M, y = M, rowH = 0;
  for (const a of state.assets) {
    const maxW = state.layoutW * 0.4;
    const s = a.nativeW > maxW ? maxW / a.nativeW : 1;
    a.w = a.nativeW * s;
    a.h = a.nativeH * s;
    if (x > M && x + a.w > state.layoutW - M) { x = M; y += rowH + M; rowH = 0; }
    a.x = x; a.y = y;
    x += a.w + M;
    rowH = Math.max(rowH, a.h);
  }
  // Still too tall? Shrink the whole staging grid uniformly to fit the board.
  const usedH = y + rowH + M;
  if (usedH > state.layoutH) {
    const k = state.layoutH / usedH;
    for (const a of state.assets) { a.x *= k; a.y *= k; a.w *= k; a.h *= k; }
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
  state.zoom = 1;   // fresh/reloaded content starts back at fit width
  board.style.display = "";
  board.style.aspectRatio = d.W + " / " + d.H;
  applyZoom();
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
    const sugFocus = !!a.suggest && i === single;   // the flagged asset being reviewed
    const elDiv = document.createElement("div");
    elDiv.className = "asset-el" + (state.selection.includes(i) ? " selected" : "") + (sugFocus ? " suggest-current" : "");
    elDiv.dataset.idx = i;
    elDiv.style.left = pct(a.x, W) + "%";
    elDiv.style.top = pct(a.y, H) + "%";
    elDiv.style.width = pct(a.w, W) + "%";
    // First in the array (top of the panel) stacks on top; 40 keeps the
    // reviewed asset above the rest but under the suggest overlay (41/45).
    elDiv.style.zIndex = sugFocus ? 40 : state.assets.length - i;
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
      sg.className = "sel-suggest" + (sugFocus ? " active" : "");
      sg.style.left = pct(a.suggest.x, W) + "%";
      sg.style.top = pct(a.suggest.y, H) + "%";
      sg.style.width = pct(a.suggest.w, W) + "%";
      sg.style.height = pct(a.suggest.h, H) + "%";
      if (sugFocus) {
        // a semi-transparent copy of the asset so you see WHAT moves there
        const ghost = document.createElement("img");
        ghost.className = "suggest-ghost"; ghost.src = a.img.src; ghost.draggable = false; ghost.alt = "";
        sg.appendChild(ghost);
        // On-board confirm: same resolution paths as the layer-panel buttons.
        // stopPropagation keeps the board's drag/selection handlers out of it.
        const acts = document.createElement("div");
        acts.className = "sug-actions";
        const ok = document.createElement("button");
        ok.type = "button"; ok.className = "sug-btn ok"; ok.textContent = "✓"; ok.title = "套用建議";
        const no = document.createElement("button");
        no.type = "button"; no.className = "sug-btn no"; no.textContent = "✕"; no.title = "忽略建議";
        for (const [btn, fn] of [[ok, applySuggest], [no, dismissSuggest]]) {
          btn.addEventListener("mousedown", (e) => e.stopPropagation());
          btn.addEventListener("click", (e) => { e.stopPropagation(); fn(i); });
        }
        acts.append(ok, no);
        sg.appendChild(acts);
      }
      assetLayer.appendChild(sg);
    }
  });

  // Arrow linking the reviewed asset's current centre → its suggested centre.
  const fa = single >= 0 ? state.assets[single] : null;
  if (fa && fa.suggest && fa.visible !== false) {
    const x1 = fa.x + fa.w / 2, y1 = fa.y + fa.h / 2;
    const x2 = fa.suggest.x + fa.suggest.w / 2, y2 = fa.suggest.y + fa.suggest.h / 2;
    const s = Math.max(4, W / 240);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "suggest-arrow");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    // Magenta (current) → mint (target) gradient, with flowing dashes unless
    // the user prefers reduced motion (SMIL keeps the dash period in viewBox
    // units, which vary per layout — CSS keyframes can't).
    const dashAnim = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? ""
      : `<animate attributeName="stroke-dashoffset" from="0" to="${-(s * 4)}" dur="0.9s" repeatCount="indefinite"/>`;
    svg.innerHTML =
      `<defs><linearGradient id="sugGrad" gradientUnits="userSpaceOnUse" ` +
      `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
      `<stop offset="0" stop-color="#ff3b8b"/><stop offset="1" stop-color="#35f0b0"/></linearGradient></defs>` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#sugGrad)" stroke-width="${s}" ` +
      `stroke-dasharray="${s * 2.4} ${s * 1.6}" stroke-linecap="round">${dashAnim}</line>` +
      `<circle cx="${x1}" cy="${y1}" r="${s * 1.3}" fill="#ff3b8b"/>` +
      `<circle cx="${x2}" cy="${y2}" r="${s * 1.6}" fill="none" stroke="#35f0b0" stroke-width="${s * .6}"/>`;
    assetLayer.appendChild(svg);
  }
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
  setBusy(true);
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
    setBusy(false);
  }
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================================
// Gemini AI assisted placement (second-pass fix after SSIM)
// ----------------------------------------------------------
// Two user-chosen paths:
//  A) tick misplaced assets in the layer panel → "AI 選取定位" asks Gemini
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

// Central token-usage ledger. Every Gemini call reports its usageMetadata here
// so AI cost is tracked in one place (api_usage_logs). Fire-and-forget: this is
// the ONLY non-Gemini outbound call, it must never block or break the placement
// flow. A CORS failure (this app can run from file://, Origin: null) or any HTTP
// error is swallowed with a console.warn — the user's work is unaffected.
const AI_USAGE_LOG_URL = "https://mapi.icantw.com/api/ai-usage-logs";
function logAiUsage(model, feature, usage) {
  if (!usage) return;                                   // no metadata → nothing to log
  const prompt = usage.promptTokenCount || 0;
  const total = usage.totalTokenCount || 0;
  // completion = total − prompt so thinking tokens (2.5-flash thoughtsTokenCount,
  // not in candidatesTokenCount) are counted; fall back to candidates if no total.
  const completion = total ? Math.max(0, total - prompt) : (usage.candidatesTokenCount || 0);
  fetch(AI_USAGE_LOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      service_name: "gemini",
      model_name: model,
      feature_name: feature,
      source: location.hostname || "layout_studio",
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total || prompt + completion,
      // Top-level cachedContentTokenCount lets the ledger bill cache hits at the
      // discounted rate; prompt_tokens stays the full count (discounted centrally).
      // Don't promote other usageMetadata keys — extras risk double billing there.
      response_metadata: { usage, cachedContentTokenCount: usage.cachedContentTokenCount || 0 },
    }),
  }).catch((e) => console.warn("AI usage log failed", e));
}

// One generateContent call with structured JSON output. Throws with a
// user-facing message on failure; callers surface it via statusEl. `feature`
// labels the call site (ai_replace / ai_double_check) in the usage ledger.
async function geminiCall(parts, responseSchema, feature) {
  const key = geminiKeyInput.value.trim();
  const model = geminiModelSelect.value;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts }],
        // temperature 0 = greedy decoding: the same layout in → the same
        // suggestions out (Gemini's default of 1.0 samples randomly, which
        // made repeat runs disagree on identical input).
        generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0 },
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
  logAiUsage(model, feature, data.usageMetadata);       // record tokens regardless of parse outcome
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
// tiny window + right region is exactly where SSIM is reliable. Only the
// reference sub-region is read, so the cost stays bounded. A confidence guard
// (REFINE_MIN_GAIN) leaves low-contrast / ambiguous assets where AI put them.
const REFINE_GEO = 90;        // template √area after scaling. Scaling by √(w·h) (not the long
                              //   side) keeps BOTH axes localisable — long-side scaling crushes a
                              //   wide/short text banner to a few px tall — and, since √area is
                              //   fixed, it also bounds the SSIM cost per asset.
const REFINE_RADIUS = 30;     // search radius in SCALED px — a small window (2·radius wide)
const REFINE_MIN_GAIN = 0.05; // confidence guard: only move if SSIM beats the AI position by this
                              //   much. Low-contrast / ambiguous assets have a flat, noisy SSIM
                              //   map, so the "best" spot is meaningless — leave AI's position.
function localRefine(a) {
  const LW = state.layoutW, LH = state.layoutH;
  if (!state.refImg || !a.img || a.w < 2 || a.h < 2) return;
  const sf = Math.min(1, REFINE_GEO / Math.sqrt(a.w * a.h));
  const Rd = REFINE_RADIUS / sf;   // design-space radius (small asset → small radius, and vice versa)
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
  // Score at the AI position (window is centred on it) vs the window's best.
  const sx = Math.max(0, Math.min(sw - tw, Math.round((a.x - rx0) * sf)));
  const sy = Math.max(0, Math.min(sh - th, Math.round((a.y - ry0) * sf)));
  const startScore = scanWindow(rdata, sw, td, tw, th, sx, sx, sy, sy, -Infinity).score;
  const m = scanWindow(rdata, sw, td, tw, th, 0, sw - tw, 0, sh - th, -Infinity);
  if (m.score === -Infinity) return;
  if (m.score - startScore < REFINE_MIN_GAIN) return;   // no confident gain → keep the AI position
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

// ---- A) Propose new positions for the SELECTED assets (review before applying) ----
aiFixBtn.addEventListener("click", async () => {
  const picked = state.selection.map((i) => ({ a: state.assets[i], i })).filter((p) => p.a);
  if (!picked.length) return;
  aiFixBtn.disabled = true; aiCheckBtn.disabled = true; setBusy(true);

  try {
    state.assets.forEach((a) => { a.suggest = null; });   // start a fresh review set
    let flagged = 0;
    for (let b = 0; b < picked.length; b += AI_BATCH) {
      const batch = picked.slice(b, b + AI_BATCH);
      statusEl.textContent = `AI 選取定位中… (${Math.min(b + AI_BATCH, picked.length)}/${picked.length})`;
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

      const out = await geminiCall(parts, BOX_SCHEMA, "ai_replace");
      for (const r of Array.isArray(out) ? out : []) {
        const p = batch[r.index];
        if (!p || !Array.isArray(r.box_2d) || r.box_2d.length !== 4) continue;
        p.a.suggest = boxToRect(p.a, r.box_2d);   // propose for review — don't move yet
        flagged++;
      }
    }
    statusEl.textContent = flagged
      ? `AI 選取定位完成：${flagged} 項建議，逐項確認`
      : "AI 選取定位完成：沒有可套用的建議";
    renderLayerList(); draw();
    focusNextSuggest();   // jump to the first proposal for review
  } catch (err) {
    console.error(err);
    statusEl.textContent = "⚠ AI 定位失敗：" + (err && err.message ? err.message : err);
  } finally {
    updateAiButtons();
    setBusy(false);
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
  aiFixBtn.disabled = true; aiCheckBtn.disabled = true; setBusy(true);
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

    const out = await geminiCall(parts, CHECK_SCHEMA, "ai_double_check");
    state.assets.forEach((a) => { a.suggest = null; });
    let flagged = 0;
    for (const r of Array.isArray(out) ? out : []) {
      const a = state.assets[r.index];
      if (!a || r.ok !== false || !Array.isArray(r.box_2d) || r.box_2d.length !== 4) continue;
      a.suggest = boxToRect(a, r.box_2d);
      flagged++;
    }
    statusEl.textContent = flagged
      ? `AI 檢查完成：${flagged} 項疑似錯位，已定位到第一項，逐項確認`
      : "✓ AI 檢查完成：全部位置正確";
    renderLayerList(); draw();
    focusNextSuggest();   // jump to the first flagged asset so it's immediately visible
  } catch (err) {
    console.error(err);
    statusEl.textContent = "⚠ AI 檢查失敗：" + (err && err.message ? err.message : err);
  } finally {
    updateAiButtons();
    setBusy(false);
  }
});

// Apply / dismiss a double-check suggestion (suggest is transient UI state —
// it is deliberately NOT persisted to IndexedDB).
// After handling one suggestion, jump to the next flagged asset (focused review).
function focusNextSuggest() {
  const i = state.assets.findIndex((a) => a.suggest);
  if (i >= 0) selectAsset(i, false);
}

function applySuggest(idx) {
  const a = state.assets[idx];
  if (!a || !a.suggest) return;
  beginChange();
  a.x = a.suggest.x; a.y = a.suggest.y; a.w = a.suggest.w; a.h = a.suggest.h;
  a.suggest = null;
  localRefine(a);   // SSIM snap the position within a small window (size kept)
  renderLayerList(); draw(); saveSession();
  focusNextSuggest();
}

function dismissSuggest(idx) {
  const a = state.assets[idx];
  if (!a) return;
  a.suggest = null;
  renderLayerList(); draw();
  focusNextSuggest();
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
  // Focused suggestion review: scroll the flagged asset into view on the board.
  const a = state.assets[i];
  if (!additive && a && a.suggest) {
    const el = assetLayer.querySelector('.asset-el[data-idx="' + i + '"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }
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

// Arrow-key nudge (Figma-style): move the whole selection by NUDGE_STEP layout
// px, Shift doubles the step. Consecutive nudges coalesce into ONE undo step —
// beginChange fires only when a run starts, and an idle timer closes the run so
// the next press after a pause opens a fresh step (mirrors the one-per-drag rule).
const NUDGE_STEP = 1;
let nudgeRunActive = false;
let nudgeIdleTimer = null;
function nudgeSelection(dx, dy) {
  if (!state.selection.length) return;
  if (!nudgeRunActive) { beginChange(); nudgeRunActive = true; }
  clearTimeout(nudgeIdleTimer);
  // Persist once the run goes idle (like save-on-mouseup), not per keypress —
  // holding an arrow key auto-repeats and would otherwise thrash IndexedDB.
  nudgeIdleTimer = setTimeout(() => { nudgeRunActive = false; saveSession(); }, 500);
  const W = state.layoutW, H = state.layoutH;
  for (const idx of state.selection) {
    const a = state.assets[idx];
    a.x = clamp(a.x + dx, 0, W - a.w);
    a.y = clamp(a.y + dy, 0, H - a.h);
  }
  renderLayerList(); draw();
}

// layout px per rendered px, plus the board's screen rect (for pointer math).
function boardMetrics() {
  const rect = board.getBoundingClientRect();
  return { rect, k: state.layoutW ? state.layoutW / rect.width : 1 };
}

let itx = null;   // active interaction: move or resize

// While an auto-positioning pass (SSIM / AI) runs, lock the board so the user
// can't drag an asset out from under the placement that's being written.
function setBusy(v) { state.busy = v; board.classList.toggle("busy", v); }

board.addEventListener("mousedown", (e) => {
  if (!state.bg || state.busy) return;
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
  // Empty board: press starts a marquee selection (Shift keeps and adds to the
  // current selection). Releasing without dragging keeps the old click
  // semantics — plain click clears, Shift-click leaves the selection alone.
  itx = { mode: "marquee", sx: e.clientX, sy: e.clientY, began: false,
    shift: e.shiftKey, base: e.shiftKey ? [...state.selection] : [] };
  e.preventDefault();
});

// Rubber-band selection: any visible asset intersecting the box is selected
// (Figma-style touch-to-select), live while dragging. The box div sits on the
// board in % coordinates — the same space the assets use — so it tracks any
// zoom exactly and survives draw() (which only clears the asset/guide layers).
function marqueeTo(e) {
  if (!itx.began) {
    if (Math.abs(e.clientX - itx.sx) + Math.abs(e.clientY - itx.sy) < 4) return;
    itx.began = true;
    itx.box = document.createElement("div");
    itx.box.className = "marquee";
    board.appendChild(itx.box);
  }
  const { rect, k } = boardMetrics();
  const W = state.layoutW, H = state.layoutH;
  // Design-space box, clamped to the layout.
  const dx1 = clamp(Math.min(itx.sx, e.clientX) - rect.left, 0, rect.width) * k;
  const dx2 = clamp(Math.max(itx.sx, e.clientX) - rect.left, 0, rect.width) * k;
  const dy1 = clamp(Math.min(itx.sy, e.clientY) - rect.top, 0, rect.height) * k;
  const dy2 = clamp(Math.max(itx.sy, e.clientY) - rect.top, 0, rect.height) * k;
  itx.box.style.left = pct(dx1, W) + "%";
  itx.box.style.top = pct(dy1, H) + "%";
  itx.box.style.width = pct(dx2 - dx1, W) + "%";
  itx.box.style.height = pct(dy2 - dy1, H) + "%";
  const merged = new Set(itx.base);
  state.assets.forEach((a, i) => {
    if (a.visible === false) return;
    if (a.x < dx2 && a.x + a.w > dx1 && a.y < dy2 && a.y + a.h > dy1) merged.add(i);
  });
  const next = [...merged];
  if (next.length !== state.selection.length || next.some((v, j) => v !== state.selection[j])) {
    state.selection = next;
    renderLayerList(); draw();
  }
}

window.addEventListener("mousemove", (e) => {
  if (!itx) return;
  if (itx.mode === "marquee") { marqueeTo(e); return; }   // selection only — no undo snapshot
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
  if (itx.mode === "marquee") {
    if (itx.box) itx.box.remove();
    else if (!itx.shift) clearSelection();   // plain click on empty board
    itx = null;
    return;   // selection isn't part of the saved session — nothing to persist
  }
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

// Keyboard: arrows nudge selection (Shift = 2×); Delete removes selection;
// Ctrl/Cmd+Z undo, +Shift or Ctrl+Y redo; Ctrl/Cmd+A selects every visible asset.
const NUDGE_DIRS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};
window.addEventListener("keydown", (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const meta = e.ctrlKey || e.metaKey;
  if (meta && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (meta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
  if (meta && (e.key === "a" || e.key === "A")) {
    if (!state.assets.length) return;
    e.preventDefault();   // keep the browser's own select-all off the page text
    // Hidden layers stay out: they're not on the board, so they can't be
    // dragged or reviewed — selecting them would only mislead the AI button.
    state.selection = state.assets.map((a, i) => (a.visible === false ? -1 : i)).filter((i) => i >= 0);
    renderLayerList(); draw();
    return;
  }
  if (meta && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
    if (!currentDims()) return;   // nothing on the board: let the browser zoom the page
    e.preventDefault();           // board loaded: these keys zoom the board, not the page
    if (e.key === "0") setZoom(1);
    else setZoom(state.zoom * (e.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP));
    return;
  }
  const dir = NUDGE_DIRS[e.key];
  if (dir && !meta && state.selection.length) {
    e.preventDefault();
    const step = NUDGE_STEP * (e.shiftKey ? 2 : 1);
    nudgeSelection(dir[0] * step, dir[1] * step);
    return;
  }
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

// Figma-style drag-to-reorder on pointer events: the grabbed row tracks the
// pointer 1:1, siblings glide aside (CSS transition), release settles the row
// into its slot before committing, and the panel auto-scrolls at its edges.
// HTML5 DnD can't give this feel — its ghost is a delayed snapshot and the
// old live-insertBefore approach made rows jump around under the cursor.
// (first in the array = top of the panel = stacked on top, as before.)
let layerDragClickGuard = false;   // a finished drag swallows the click it fires

function beginLayerDrag(e, li, from) {
  if (e.button !== 0 || state.busy) return;
  if (e.target.closest("button")) return;   // eye / suggest buttons keep their clicks
  const items = [...layerList.querySelectorAll(".layer-item")].filter((n) => !n.classList.contains("bg"));
  if (items.length < 2) return;

  // Geometry snapshot in offset coordinates — unaffected by panel scroll.
  const slots = items.map((n) => ({ el: n, top: n.offsetTop, h: n.offsetHeight }));
  const GAP = 8;                                // .layer-list flex gap
  const lift = slots[from].h + GAP;             // how far siblings step aside
  const minY = slots[0].top - slots[from].top;
  const last = slots[slots.length - 1];
  const maxY = last.top + last.h - slots[from].h - slots[from].top;
  const scroller = li.closest(".layers") || layerList;
  const startPointer = e.clientY, startScroll = scroller.scrollTop;
  let started = false, to = from, raf = 0, scrollVel = 0, lastY = e.clientY;

  // Capture routes every move/up to the row even outside the panel; without it
  // (stale pointer, synthetic events) bubbling still reaches us — just degraded.
  try { li.setPointerCapture(e.pointerId); } catch {}

  const update = () => {
    // Pointer delta + scroll delta, clamped to the list, drives the grabbed row.
    const dy = Math.max(minY, Math.min(maxY, (lastY - startPointer) + (scroller.scrollTop - startScroll)));
    li.style.transform = `translateY(${dy}px)`;
    // Target slot = where the row's centre sits; siblings shift by one row height.
    const centre = slots[from].top + dy + slots[from].h / 2;
    to = from;
    for (let j = 0; j < slots.length; j++) {
      if (j === from) continue;
      const mid = slots[j].top + slots[j].h / 2;
      if (j < from && centre < mid) to = Math.min(to, j);
      if (j > from && centre > mid) to = Math.max(to, j);
    }
    for (let j = 0; j < slots.length; j++) {
      if (j === from) continue;
      const shift = j >= to && j < from ? lift : j <= to && j > from ? -lift : 0;
      slots[j].el.style.transform = shift ? `translateY(${shift}px)` : "";
    }
  };

  const tick = () => {   // edge auto-scroll keeps flowing between pointermoves
    if (scrollVel) { scroller.scrollTop += scrollVel; update(); }
    raf = requestAnimationFrame(tick);
  };

  const onMove = (ev) => {
    lastY = ev.clientY;
    if (!started) {
      if (Math.abs(lastY - startPointer) < 5) return;   // a click until proven a drag
      started = true;
      li.classList.add("dragging");
      document.body.classList.add("layer-dragging");
      raf = requestAnimationFrame(tick);
    }
    const r = scroller.getBoundingClientRect(), EDGE = 28;
    scrollVel = lastY < r.top + EDGE ? -Math.ceil((r.top + EDGE - lastY) / 4)
      : lastY > r.bottom - EDGE ? Math.ceil((lastY - (r.bottom - EDGE)) / 4) : 0;
    update();
  };

  const finish = (commit) => {
    li.removeEventListener("pointermove", onMove);
    li.removeEventListener("pointerup", onUp);
    li.removeEventListener("pointercancel", onCancel);
    if (!started) return;                    // plain click — the click handler takes it
    cancelAnimationFrame(raf);
    document.body.classList.remove("layer-dragging");
    layerDragClickGuard = true;
    if (!commit) to = from;                  // pointercancel: glide back home
    const settleY = to === from ? 0
      : to < from ? slots[to].top - slots[from].top
      : slots[to].top + slots[to].h - slots[from].h - slots[from].top;
    li.style.transition = "transform .14s ease";
    li.style.transform = `translateY(${settleY}px)`;
    setTimeout(() => {                       // after the settle animation
      layerDragClickGuard = false;
      if (to !== from) {
        beginChange();
        const [moved] = state.assets.splice(from, 1);
        state.assets.splice(to, 0, moved);
        state.selection = [to];              // keep the moved layer selected, Figma-style
        renderLayerList();
        draw();
        saveSession();
      } else {
        li.classList.remove("dragging");
        li.style.transition = ""; li.style.transform = "";
        for (const s of slots) s.el.style.transform = "";
      }
    }, 150);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  li.addEventListener("pointermove", onMove);
  li.addEventListener("pointerup", onUp);
  li.addEventListener("pointercancel", onCancel);
}

function renderLayerList() {
  layerList.innerHTML = "";

  // List in array order — import order reads top-to-bottom (header → s1… → footer),
  // and stacking matches: top of the panel is drawn on top.
  for (let i = 0; i < state.assets.length; i++) {
    const a = state.assets[i];
    const hidden = a.visible === false;
    const li = document.createElement("li");
    li.className = "layer-item" + (hidden ? " hidden-layer" : "") + (state.selection.includes(i) ? " selected" : "");

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
    // The guard eats the click a finished drag fires on release.
    li.addEventListener("click", (e) => {
      if (layerDragClickGuard) { layerDragClickGuard = false; return; }
      selectAsset(i, e.shiftKey);
    });

    // Drag the whole row to reorder the stacking order (see beginLayerDrag).
    li.addEventListener("pointerdown", (e) => beginLayerDrag(e, li, i));

    layerList.appendChild(li);
  }

  if (state.bg) {
    const li = document.createElement("li");
    li.className = "layer-item bg";
    li.innerHTML = `<img src="${state.bg.img.src}" alt=""><span class="nm">${state.bg.name} (底圖)</span>`;
    layerList.appendChild(li);
  }

  updateAiButtons();   // "AI 選取定位" is gated on the current selection
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
    // z-index mirrors the board: first in the list stacks on top.
    itemsCSS +=
`.${cls} {
  left: ${pct(a.x, W)}%;
  top: ${pct(a.y, H)}%;
  width: ${pct(a.w, W)}%;
  z-index: ${state.assets.length - i};
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

// ============================================================
// Decorative backdrop: a morphing neon blob that wanders behind
// the page. Pure canvas (no libs); sits behind all content
// (z-index -1, pointer-events none) so it can't interfere with the
// editor. Honors prefers-reduced-motion by rendering a still frame.
// ============================================================
(function blobBackdrop() {
  const cv = el("fluidCanvas");
  if (!cv) return;
  const fx = cv.getContext("2d");
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    fx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // Outline = base radius modulated by low-order harmonics drifting in
  // time ([angular order, relative amp, time speed, phase]) — the shape
  // keeps morphing but stays smooth and roughly round.
  const HARM = [
    [3, .08, .00042, 0.0],
    [5, .05, -.00031, 2.1],
    [7, .03, .00057, 4.4],
  ];

  function blobRadius(a, R, t) {
    let r = R;
    for (const [n, amp, v, p] of HARM) r += R * amp * Math.sin(n * a + p + t * v);
    return r;
  }

  function tracePath(cx, cy, R, t) {
    const STEPS = 120;
    for (let i = 0; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2;
      const r = blobRadius(a, R, t);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) fx.moveTo(x, y); else fx.lineTo(x, y);
    }
  }

  // Feathered silhouette of the morphing outline: draw the path fully
  // offscreen and let its blurred shadow land onscreen — soft edges with
  // no ctx.filter (Safari-safe). Shadow offset/blur ignore the CTM, so
  // they're given in device px (× DPR).
  function softFill(cx, cy, R, t, scale, blur, color) {
    const off = H + R * 2;
    fx.save();
    fx.beginPath();
    tracePath(cx, cy - off, R * scale, t);
    fx.closePath();
    fx.shadowOffsetY = off * DPR;
    fx.shadowBlur = blur * DPR;
    fx.shadowColor = color;
    fx.fillStyle = "#000";
    fx.fill();
    fx.restore();
  }

  function paint(t) {
    fx.clearRect(0, 0, W, H);
    // Slow Lissajous drift keeps the blob roaming the whole viewport
    // without ever repeating an obvious loop.
    const cx = W * (.5 + .38 * Math.sin(t * .000037 + .8));
    const cy = H * (.5 + .34 * Math.sin(t * .000053 + 2.0));
    const R = Math.min(W, H) * (.204 + .036 * Math.sin(t * .00006));

    // Two blurred silhouettes (outer cyan, inner mint) + a soft core whose
    // gradient hits zero alpha well inside the outline — translucent
    // gradient throughout, no stroke, no hard edge anywhere.
    softFill(cx, cy, R, t, 1.0, 60, "rgba(0, 224, 255, .10)");
    softFill(cx, cy, R, t, .78, 44, "rgba(53, 240, 176, .09)");
    const g = fx.createRadialGradient(cx, cy, 0, cx, cy, R * .62);
    g.addColorStop(0, "rgba(140, 245, 255, .15)");
    g.addColorStop(1, "rgba(0, 224, 255, 0)");
    fx.fillStyle = g;
    fx.beginPath();
    fx.arc(cx, cy, R * .62, 0, Math.PI * 2);
    fx.fill();
  }

  window.addEventListener("resize", () => { resize(); paint(performance.now()); });
  resize();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    paint(0);
  } else {
    requestAnimationFrame(function loop(t) { paint(t); requestAnimationFrame(loop); });
  }
})();
