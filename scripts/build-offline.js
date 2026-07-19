"use strict";
// public/index.html + public/app.js + vendor/*.js から、外部通信なしで動く
// 単一HTMLファイル（オフライン版）を public/pdf-redactor-offline.html に生成する。
// 依存パッケージなし（Node標準機能のみ）。ロジックはWeb公開版と同じソースから生成するため、
// 手作業での二重管理は発生しない。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const VENDOR = path.join(ROOT, "vendor");
const OUT = path.join(PUBLIC, "pdf-redactor-offline.html");

const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const pdfjs = fs.readFileSync(path.join(VENDOR, "pdf.min.js"), "utf8");
const pdfjsWorker = fs.readFileSync(path.join(VENDOR, "pdf.worker.min.js"), "utf8");
const pdfLib = fs.readFileSync(path.join(VENDOR, "pdf-lib.min.js"), "utf8");

// </script> をライブラリ本文がそのまま含んでいた場合にHTMLを壊さないようにエスケープ
const escapeScriptClose = (s) => s.replace(/<\/script/gi, "<\\/script");

// ---- app.js: CDN からワーカーを取得する行を、埋め込み済みワーカーのBlob URL生成に差し替え ----
const CDN_SCRIPT_TAGS =
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>\n' +
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>';

const WORKER_LINE =
  'pdfjsLib.GlobalWorkerOptions.workerSrc =\n' +
  '  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";';

const WORKER_LINE_OFFLINE =
  'pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob(\n' +
  '  [document.getElementById("pdfjs-worker-src").textContent],\n' +
  '  { type: "text/javascript" }\n' +
  '));';

if (!html.includes(CDN_SCRIPT_TAGS)) {
  throw new Error("index.html の CDN <script> タグが見つかりません。build-offline.js の CDN_SCRIPT_TAGS を確認してください。");
}
if (!appJs.includes(WORKER_LINE)) {
  throw new Error("app.js のワーカー設定行が見つかりません。build-offline.js の WORKER_LINE を確認してください。");
}
// 表示文言が変わっても壊れないよう、リンク先(href)基準の正規表現で検出する
const OFFLINE_LINK_RE = /\n[ \t]*<a class="link" href="pdf-redactor-offline\.html" download>[^<]*<\/a>/;
if (!OFFLINE_LINK_RE.test(html)) {
  throw new Error("index.html のオフライン版ダウンロードリンクが見つかりません。build-offline.js の OFFLINE_LINK_RE を確認してください。");
}

// replace の第2引数を文字列にすると "$&" 等がライブラリ本文に含まれた場合に
// 特殊置換パターンとして誤解釈され出力が破損するため、必ず関数で返す。
const appJsOffline = appJs.replace(WORKER_LINE, () => WORKER_LINE_OFFLINE);

const inlineLibs =
  `<script>\n${escapeScriptClose(pdfjs)}\n</script>\n` +
  `<script type="text/plain" id="pdfjs-worker-src">${escapeScriptClose(pdfjsWorker)}</script>\n` +
  `<script>\n${escapeScriptClose(pdfLib)}\n</script>`;

let out = html.replace(CDN_SCRIPT_TAGS, () => inlineLibs);
out = out.replace(
  '<script src="app.js"></script>',
  () => `<script>\n${escapeScriptClose(appJsOffline)}\n</script>`
);
out = out.replace("<title>PDF 墨消し</title>", () => "<title>PDF 墨消し（オフライン版）</title>");
// オフライン版自身の中に「オフライン版をダウンロード」リンク（自己参照）は不要なので取り除く
out = out.replace(OFFLINE_LINK_RE, () => "");
out = out.replace(
  "処理はすべてお使いのブラウザ内で行われ、<b>PDFはどこにも送信されません</b>。出力は元の画素・文字ごと消えた画像PDFです。",
  () => "これはオフライン版です。<b>ライブラリも含めて外部通信を一切行いません</b>（このHTMLファイル単体で完結）。出力は元の画素・文字ごと消えた画像PDFです。"
);

fs.writeFileSync(OUT, out, "utf8");
console.log(`generated: ${path.relative(ROOT, OUT)} (${(Buffer.byteLength(out) / 1024).toFixed(0)} KB)`);
