# 11. ページエディタを textarea から CodeMirror 6 に置き換えた

## 経緯

旧エディタは「ページ全体を 1 つの `<textarea>` で編集し、blur で描画ビューに戻す」
方式だった (旧 `editor.ts` 冒頭のコメントに理由あり)。「クリックした行だけ記法が
展開され、他の行は描画されたまま」(Scrapbox の挙動) は textarea では実現できない。
行ごとに textarea を持つ方式は過去に挫折している (カーソル移動・IME・複数行ペースト
を全部自前で再実装することになり、バグが出続けた)。

検証用に独立した `#/editor/` ページ (CodeMirror 6 + esbuild) で挙動を確認し、
そのまま本採用した。

## 選択: CodeMirror 6 の decoration による「ライブプレビュー」

- 文書は常に生の Scrapbox 記法のまま。表示だけを decoration で変える
  (非アクティブ行: `[` `]` や `[* ` を `Decoration.replace` で消し、中身に mark で装飾。
  アクティブ行 = 選択が触れている行: 同じ装飾を保ったまま記法文字を薄く表示)。
  コピー・undo・保存内容が生の記法で一貫する。
- カーソル移動・IME・複数行ペースト・undo/redo・折り返しは CodeMirror に任せる
  (旧方式が挫折した部分)。
- 未フォーカス時は全行を描画状態にする (Scrapbox と同じ)。

## 構成上の判断

- **バンドル**: tsc は単体モジュールを出力するだけで、ブラウザは `@codemirror/*` の
  bare import を解決できない。`cm-editor/` は tsc の対象外 (`src/` の外) に置き、
  esbuild で `js/cm-editor.js` に 1 本化する (`scripts/build-cm-editor.mjs`)。型チェックは
  `tsc -p cm-editor/tsconfig.json` (`npm run build` に含む)。
- **遅延読み込み**: `src/editor.ts` は薄いローダーで、`import('./cm-editor.js?v=<sha>')`
  する (参照ページ用の閲覧ビューは CodeMirror 不要)。読み込み中は従来の描画ビュー
  (`renderLinesInto`) を読み取り専用で出す。`?v=` は `import.meta.url` から引き継ぐ
  (cache-bust-imports.mjs は静的 import しか書き換えないため)。
- **`onChange` の契約は不変**: blur で 1 回 (毎回の blur で発火し、無変更は app 側が no-op
  保存にする — 旧実装と同じ)。加えて、リンクをたどる前 (dirty のときのみ) と、タブが
  hidden になるとき (dirty のときのみ) に commit する。後者 2 つは旧エディタに無かった
  データ消失対策 (route 変更は blur なしでエディタ DOM を捨てるため)。
- **リンク**: 非アクティブ行のリンクは通常クリックでたどる (旧ビューモードと同じ)。
  アクティブ行では通常クリックは編集、Ctrl/⌘+クリックは常にたどる。mousedown で処理する
  (キャレット移動で行が再描画され、click が置換後の要素に当たらないため)。
- **クラス名**: 装飾は parser.ts と同じクラス名 (`sb-h1` / `sb-strike` / `deco-\<` 等) を使い
  style.css の既存ルールで描画する。エディタ固有の CSS は `.sbe` 配下・`sbe-` 接頭辞のみ
  (`cm-editor/style.ts`、`<style>` として注入)。
- **アウトライン操作は `src/outline.ts` (DOM 非依存)** に切り出し、node でテストする
  (`test/outline.test.mjs`)。1 行目 (タイトル) は動かさず、タイトルより上へも動かさない
  (ページ名が黙って変わるため)。

## 追加機能

- 選択ポップアップ: `[ ]` リンク / 太字 `[* ]` / 見出し `[** ]` / 斜体 / 取消 / 下線 / コード /
  ページ切り出し。複数行選択は行ごとに囲む (記法は行をまたげない)。CodeMirror の tooltip なので
  位置決めは任せる。タッチ端末では OS のコピーメニューと被らないよう選択の下に出す。
- Ctrl+矢印 = 行 (選択行) の移動/インデント、Alt+矢印 = 段落 (行+配下) の移動/インデント。
  旧エディタの Ctrl+矢印・Alt+↑↓ に Alt+←→ (段落のインデント/アウトデント) を追加。
- スマホ: キーボードで隠れないようキャレットを可視領域 (visual viewport − 固定フッター)
  に収める。`cm-editor/mobile.ts`。

## 既知の制限

[technical-notes.md の「未検証」](../technical-notes.md) を参照 (実機の IME・iOS キーボード)。
