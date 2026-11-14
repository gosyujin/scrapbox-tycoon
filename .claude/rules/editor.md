---
paths:
  - "src/app.ts"
  - "src/editor.ts"
  - "src/editor-types.ts"
  - "cm-editor/**"
---
# ページ編集・タイトル処理(app.ts の onChange / editor.ts / cm-editor/)

全般: [docs/technical-notes.md](../../docs/technical-notes.md)、[decisions/11](../../docs/decisions/11-codemirror-editor.md)

- **エディタ(`src/editor.ts` → `cm-editor/index.ts`)の `onChange` は blur / commit 時に一度だけ発火する。** キー入力の度ではない。「編集途中の一時的な状態かもしれない」前提で `app.ts` 側にフォールバックを書くと、過去にタイトルと内容の不整合バグを生んだ。`onChange` 内で `lines[0]` が空・想定外でも「編集完了として確定した値」として扱う。→ [decisions/04](../../docs/decisions/04-empty-page-title-desync.md)
- 1行目が空になったページは "Untitled"(衝突時は `uniqueTitle()` で `_N`)にリネームし、`/^Untitled(_\d+)?$/` なら現在のタイトルを維持する(無変更の blur で番号が増え続けないため)。
- `cm-editor/` は tsc の対象外(bare import を解決できないため)。esbuild で `js/cm-editor.js` にバンドルされ、`src/editor.ts` が `import('./cm-editor.js?v=…')` で遅延ロードする。`src/` に移したり、静的 import にしない。
- エディタの CSS は `.sbe` 配下 / `sbe-` 接頭辞のみ(`cm-editor/style.ts`)。parser.ts と共通の装飾クラス(`sb-h1` 等)は `css/style.css` 側で定義済みなので再定義しない。
- インデント(`cm-editor/style.ts` の `.sbe-ws`): 空白1文字 = 1セルは `letter-spacing` で作る。`inline-block` に戻すとキャレットがセル内にずれ、`white-space: pre` を外すと長い URL でバレットが孤立する([technical-notes #10](../../docs/technical-notes.md))。
