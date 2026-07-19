# pdf-redactor — スキャンPDF 墨消しツール（ブラウザ完結）

裁判資料などスキャンPDFの氏名・住所などを黒塗り（墨消し）するツール。
**処理はすべてブラウザ内で完結し、PDFはサーバーに送信されません。**
公開方法は `court-calendar` と同じ Cloudflare Pages。

## 仕組み（案1：ブラウザ完結）

- `pdf.js` … PDFの各ページを画面に表示
- ドラッグで黒塗り範囲を指定（枠クリックで削除、元に戻す、ページ単位クリア）
- 「墨消しを適用」で **各ページを画像化し、黒塗りを画素に焼き込み**、`pdf-lib` で新しいPDFを生成
  - 出力は画像PDFなので、**元の文字・画素は一切含まれない＝確実な墨消し**
  - 元PDFのメタデータも引き継がれない
- React / Next.js は不使用（素のHTML＋バニラJS）

## オフライン版

Web公開版はライブラリをCDNから読み込むため、通信が発生すること自体に不安を感じる人もいる。
そのための単一HTMLファイル版を用意している。サイドバーの「オフライン版をダウンロード」からDLできる。

- `pdf.js` / `pdf-lib` を含めて全部を1枚のHTMLに埋め込み、**保存後はネット接続なしで動く**
- ソースはテキストエディタでそのまま読める＝処理内容を自分の目で確認できる
- `scripts/build-offline.js` が `public/index.html` + `public/app.js` + `vendor/*.js` から自動生成する
  （ロジックは公開版と共通、手作業での二重管理はしない）
- `npm run build:offline` で再生成（`npm run dev` / `npm run deploy` 実行時にも自動で実行される）
- `vendor/` の中身を更新したとき（pdf.js / pdf-lib のバージョンアップ等）は再生成を忘れないこと
- 制約：`file://` で直接開くとpdf.js側の実ワーカー起動がブラウザにブロックされ、
  自動的にメインスレッド処理へフォールバックする（動作はするがページ数が多いと重くなりうる）。
  実ワーカーを使いたい場合は下記のローカルサーバー経由で開く。

## ローカルで動かす

```bash
npm install          # wrangler を入れる
npm run dev          # http://localhost:8788 で確認（file:// では pdf.js ワーカーが動かない）
```
`python -m http.server -d public 8000` でも可（http で配信すること）。

## 公開（Cloudflare Pages）

```bash
npm run deploy       # wrangler pages deploy
```
本人・関係者限定にする場合は Cloudflare Access（Google ログイン）を前段に設定。

## 運用上の注意

- **墨消しは適用前に必ず目視レビュー**（自動検出ではなく手動指定なので、消し忘れに注意）。
- 出力後、別途PDFを開いて**墨消し漏れ・下地露出がないか確認**する。
- 入力・出力PDFは `.gitignore` で除外済み。**PIIを含むPDFはコミット/pushしない。**

## 今後（案2）

Yomitoku をローカルで前処理して bbox JSON を出力 → この画面に読み込ませ、
氏名等の候補枠を自動表示 → 人が確定して墨消し、という自動検出の上乗せが可能。
その場合も処理はブラウザ内のまま（Cloudflare Pages で公開可）。
