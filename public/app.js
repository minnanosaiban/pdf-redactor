"use strict";

// pdf.js のワーカー（PDF解析はワーカースレッドで走る）
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const { PDFDocument } = PDFLib;

const DISPLAY_SCALE = 1.5;   // 画面表示用の描画倍率

// ---- 状態 ----
let pdf = null;              // pdf.js のドキュメント
let numPages = 0;
let searchable = false;      // 文字入りPDF（サーチャブル）か
const rectsByPage = {};      // { ページ番号: [{x,y,w,h} すべて 0..1 の正規化座標] }
const dom = {};              // { ページ番号: {wrap,stage,view,overlay,rendered,rendering,preview} }
const history = [];          // 枠を追加した順のページ番号（「元に戻す」用）
let io = null;               // IntersectionObserver（遅延レンダリング）
let applying = false;        // 墨消し適用中フラグ
let outputBlob = null;

// ---- 要素 ----
const $ = (id) => document.getElementById(id);
const pagesEl = $("pages");
const statusEl = $("status");
const countEl = $("count");
const dlBtn = $("download");
const dpiSel = $("dpi");
const qInput = $("q");
const ptype = $("ptype");

const setStatus = (m) => { statusEl.textContent = m || ""; };
const rectsOf = (p) => rectsByPage[p] || (rectsByPage[p] = []);
const totalBoxes = () => Object.values(rectsByPage).reduce((n, a) => n + a.length, 0);
const updateCount = () => { countEl.textContent = `枠: ${totalBoxes()}`; };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---- ツールバー ----
$("file").onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); };
$("undo").onclick = () => {
  const p = history.pop();
  if (p == null) return;
  rectsOf(p).pop();
  if (dom[p]) dom[p].redacted = false;
  drawOverlay(p); updateCount();
};
$("clearAll").onclick = () => {
  for (const k of Object.keys(rectsByPage)) rectsByPage[k] = [];
  history.length = 0;
  for (const k of Object.keys(dom)) { dom[k].redacted = false; drawOverlay(+k); }
  updateCount();
};
$("search").onclick = () => searchAndAdd(qInput.value);
qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchAndAdd(qInput.value); });

// ---- 読み込み ----
async function loadFile(file) {
  outputBlob = null; dlBtn.disabled = true;
  if (io) { io.disconnect(); io = null; }
  pagesEl.innerHTML = "";
  for (const k of Object.keys(rectsByPage)) delete rectsByPage[k];
  for (const k of Object.keys(dom)) delete dom[k];
  history.length = 0; updateCount();
  setSearchUI(false, "判定中…");

  const buf = await file.arrayBuffer();
  pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  numPages = pdf.numPages;

  // 1ページ目の寸法をプレースホルダの基準に（多くの資料はページサイズ均一）
  const p1 = await pdf.getPage(1);
  const vp1 = p1.getViewport({ scale: DISPLAY_SCALE });
  buildPages(vp1.width, vp1.height);

  io = new IntersectionObserver(onIntersect, { root: null, rootMargin: "800px 0px", threshold: 0 });
  for (const k of Object.keys(dom)) io.observe(dom[k].wrap);

  // 文字入り（サーチャブル）か判定
  searchable = await detectSearchable();
  setSearchUI(searchable);
  const mode = searchable
    ? "文字入りPDFです。上の検索で文字を指定して墨消し、または各ページをドラッグで墨消しできます。"
    : "スキャンPDF（文字なし）です。文字検索は使えません。各ページをドラッグで墨消ししてください。";
  setStatus(`${file.name}（${numPages}ページ）を読み込みました。${mode} 枠はクリックで削除。`);
}

async function detectSearchable() {
  let chars = 0;
  const lim = Math.min(numPages, 5);
  for (let p = 1; p <= lim; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) chars += (it.str || "").trim().length;
    if (chars >= 30) break;
  }
  return chars >= 30;
}

function setSearchUI(on, label) {
  qInput.disabled = !on;
  $("search").disabled = !on;
  ptype.textContent = label || (on ? "文字あり（検索可）" : "スキャン（文字なし）");
  ptype.className = "badge " + (label ? "" : (on ? "ok" : "warn"));
}

function buildPages(w, h) {
  for (let p = 1; p <= numPages; p++) {
    const wrap = document.createElement("div");
    wrap.className = "page"; wrap.dataset.page = p;

    const head = document.createElement("div"); head.className = "phead";
    const lbl = document.createElement("span"); lbl.textContent = `p.${p}`;
    const clr = document.createElement("button"); clr.textContent = "このページの枠を消去"; clr.className = "mini";
    clr.onclick = () => {
      rectsByPage[p] = [];
      for (let i = history.length - 1; i >= 0; i--) if (history[i] === p) history.splice(i, 1);
      dom[p].redacted = false;
      drawOverlay(p); updateCount();
    };
    head.appendChild(lbl); head.appendChild(clr);

    const stage = document.createElement("div"); stage.className = "stage";
    stage.style.width = w + "px";
    stage.style.aspectRatio = `${w} / ${h}`;

    const view = document.createElement("canvas"); view.className = "view";
    const overlay = document.createElement("canvas"); overlay.className = "overlay";
    stage.appendChild(view); stage.appendChild(overlay);

    wrap.appendChild(head); wrap.appendChild(stage);
    pagesEl.appendChild(wrap);

    dom[p] = { wrap, stage, view, overlay, rendered: false, rendering: false, preview: null, redacted: false };
    attachDraw(p);
  }
}

function onIntersect(entries) {
  for (const en of entries) {
    const p = +en.target.dataset.page;
    if (en.isIntersecting) renderPage(p);
    else freePage(p);
  }
}

async function renderPage(p) {
  if (applying) return;
  const d = dom[p];
  if (!d || d.rendered || d.rendering) return;
  d.rendering = true;
  try {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: DISPLAY_SCALE });
    d.stage.style.width = vp.width + "px";
    d.stage.style.aspectRatio = `${vp.width} / ${vp.height}`;
    d.view.width = d.overlay.width = Math.floor(vp.width);
    d.view.height = d.overlay.height = Math.floor(vp.height);
    await page.render({ canvasContext: d.view.getContext("2d"), viewport: vp }).promise;
    d.rendered = true;
    drawOverlay(p);
  } finally {
    d.rendering = false;
  }
}

function freePage(p) {
  const d = dom[p];
  if (!d || !d.rendered) return;
  d.view.width = d.view.height = 0;      // バッファを解放してメモリを節約
  d.overlay.width = d.overlay.height = 0;
  d.rendered = false;
}

function drawOverlay(p) {
  const d = dom[p];
  if (!d || !d.rendered) return;
  const o = d.overlay, ctx = o.getContext("2d"), W = o.width, H = o.height;
  ctx.clearRect(0, 0, W, H);
  const draw = (r, fill, stroke) => {
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2;
    ctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
    ctx.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
  };
  const [fill, stroke] = d.redacted
    ? ["rgba(0,0,0,0.95)", "rgba(0,0,0,1)"]
    : ["rgba(220,0,0,0.35)", "rgba(220,0,0,0.9)"];
  for (const r of rectsOf(p)) draw(r, fill, stroke);
  if (d.preview) draw(d.preview, "rgba(0,0,0,0.25)", "rgba(0,0,0,0.7)");
}

// 赤枠→黒塗りへ短いアニメーションで遷移させる（「墨消しを適用」の視覚フィードバック用）
function markRedacted(p) {
  const d = dom[p];
  if (!d) return;
  d.redacted = true;
  if (!d.rendered || !rectsOf(p).length) return;
  const rects = rectsOf(p);
  const DURATION = 260;
  const from = [220, 0, 0], to = [0, 0, 0];
  const t0 = performance.now();
  const step = (now) => {
    if (!d.rendered) return;   // アニメ中にページが画面外へ流れて解放された
    const t = Math.min(1, (now - t0) / DURATION);
    const rgb = from.map((v, i) => Math.round(v + (to[i] - v) * t));
    const alpha = 0.35 + (0.95 - 0.35) * t;
    const o = d.overlay, ctx = o.getContext("2d"), W = o.width, H = o.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;
    ctx.lineWidth = 2;
    for (const r of rects) {
      ctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
      ctx.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
    }
    if (t < 1) requestAnimationFrame(step);
    else drawOverlay(p);       // 最終状態を通常描画で確定
  };
  requestAnimationFrame(step);
}

// ---- 文字検索して墨消し枠を自動追加（サーチャブルPDFのみ） ----
async function searchAndAdd(term) {
  term = (term || "").trim();
  if (!term) return;
  if (!searchable) { setStatus("このPDFは文字が埋め込まれていないため検索できません。ドラッグで囲ってください。"); return; }
  const needle = term.toLowerCase();
  let added = 0;
  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });     // 座標は pt（scale 1）で扱う
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = it.str || "";
      if (!s) continue;
      const hay = s.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx !== -1) {
        const box = itemRect(it, idx, idx + term.length, vp);
        if (box) { rectsOf(p).push(box); history.push(p); added++; }
        idx = hay.indexOf(needle, idx + 1);
      }
    }
    if (dom[p]) dom[p].redacted = false;
    drawOverlay(p);   // 描画済みページなら即反映（未描画はスクロール時に反映）
  }
  updateCount();
  setStatus(added
    ? `「${term}」に ${added} 箇所の墨消し枠を追加しました。位置がずれていないか確認し、不要な枠はクリックで削除してください。`
    : `「${term}」は見つかりませんでした。`);
}

// テキストアイテム内の [start,end) 文字範囲の矩形を 0..1 正規化で返す
function itemRect(it, start, end, vp) {
  const tx = pdfjsLib.Util.transform(vp.transform, it.transform);  // 左上原点のデバイス座標へ
  const fh = Math.hypot(tx[2], tx[3]);                             // 文字の高さ（フォントサイズ相当）
  const width = it.width;                                          // scale 1 での文字幅(pt)
  if (!width || !fh) return null;
  const len = it.str.length || 1;
  const left = tx[4] + width * (start / len);
  const right = tx[4] + width * (end / len);
  const top = tx[5] - fh;                                          // ベースラインの上へ
  const padX = fh * 0.12, padY = fh * 0.18;                        // 少し余白を持たせて塗り漏れ防止
  const x = clamp01((Math.min(left, right) - padX) / vp.width);
  const y = clamp01((top - padY) / vp.height);
  const w = Math.min(1 - x, (Math.abs(right - left) + 2 * padX) / vp.width);
  const h = Math.min(1 - y, (fh + 2 * padY) / vp.height);
  return { x, y, w, h };
}

// ---- 各ページの描画操作（ドラッグ追加 / クリック削除） ----
function attachDraw(p) {
  const d = dom[p], o = d.overlay;
  const norm = (e) => {
    const r = o.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const rf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  let start = null, moved = false;

  o.addEventListener("pointerdown", (e) => {
    if (!d.rendered) return;
    o.setPointerCapture(e.pointerId);
    start = norm(e); moved = false;
  });
  o.addEventListener("pointermove", (e) => {
    if (!start) return;
    const q = norm(e);
    if (Math.abs(q.x - start.x) > 0.004 || Math.abs(q.y - start.y) > 0.004) moved = true;
    d.preview = rf(start, q); drawOverlay(p);
  });
  o.addEventListener("pointerup", (e) => {
    if (!start) return;
    const q = norm(e);
    if (moved) {
      const r = rf(start, q);
      if (r.w > 0.005 && r.h > 0.005) { rectsOf(p).push(r); history.push(p); }   // ドラッグ→追加
    } else {
      const arr = rectsOf(p);                                                     // クリック→その枠を削除
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if (q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h) {
          arr.splice(i, 1);
          for (let j = history.length - 1; j >= 0; j--) if (history[j] === p) { history.splice(j, 1); break; }
          break;
        }
      }
    }
    start = null; moved = false; d.preview = null; d.redacted = false; drawOverlay(p); updateCount();
  });
}

// ---- 墨消し適用（各ページをラスタライズ＋黒塗りして新規PDFを生成） ----
$("apply").onclick = async () => {
  if (!pdf) { setStatus("先にPDFを選んでください。"); return; }
  const total = totalBoxes();
  const dpi = parseInt(dpiSel.value, 10);
  const scale = dpi / 72;
  dlBtn.disabled = true;
  applying = true;
  if (io) io.disconnect();            // 適用中は遅延レンダリングを止める
  setStatus(`墨消しを適用中…（${total}枠 / ${dpi}dpi）`);
  try {
    const out = await PDFDocument.create();
    for (let p = 1; p <= numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const cx = c.getContext("2d");
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      // 黒塗りをピクセルに焼き込む（＝下地は出力に残らない）
      cx.fillStyle = "#000";
      for (const r of (rectsByPage[p] || [])) {
        cx.fillRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
      }
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const img = await out.embedPng(bytes);
      const vp1 = page.getViewport({ scale: 1 });   // 元のページ寸法(pt)を保持
      const pg = out.addPage([vp1.width, vp1.height]);
      pg.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      markRedacted(p);
      setStatus(`墨消し中… ${p}/${numPages}`);
    }
    out.setTitle($("metaTitle").value.replace(/\s+/g, " ").trim());
    out.setAuthor(""); out.setSubject("");
    out.setKeywords([]); out.setProducer("pdf-redactor"); out.setCreator("pdf-redactor");
    const outBytes = await out.save();
    outputBlob = new Blob([outBytes], { type: "application/pdf" });
    dlBtn.disabled = false;
    setStatus(`完了：${numPages}ページをラスタライズし ${total}箇所を黒塗りしました。下地の画素・文字は出力に含まれません（出力は画像PDF＝文字検索不可）。DL後、PDFを開いて墨消し漏れがないか目視確認してください。`);
  } finally {
    applying = false;
    if (io) for (const k of Object.keys(dom)) io.observe(dom[k].wrap);   // 遅延レンダリング再開
  }
};

dlBtn.onclick = () => {
  if (!outputBlob) return;
  const url = URL.createObjectURL(outputBlob);
  const a = document.createElement("a");
  a.href = url; a.download = "redacted.pdf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
