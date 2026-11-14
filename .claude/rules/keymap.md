---
paths:
  - "src/keymap.ts"
  - "src/shortcuts.ts"
  - "cm-editor/shortcuts.ts"
  - "cm-editor/index.ts"
---
# キー操作(src/keymap.ts / src/shortcuts.ts / cm-editor/shortcuts.ts)

経緯: [decisions/14](../../docs/decisions/14-scrapboxshortcutkey-integration.md)

- コンボの正規化は ScrapboxShortcutKey(UserScript)と同じ文字列にならないと、UserScript の登録が既定の割り当てを置き換えず二重になる。ハンドラは `false` を返すとキーを握りつぶし、それ以外は既定動作に流す。IME 変換中(`isComposing` / `keyCode 229`)と `key` の無い合成イベントは `Keymap` が無視する。
- edit コンテキストは `cm-editor/index.ts` の `Prec.highest` keydown で受ける。`document` に keydown を足して `i` / `o` 等を処理しない(`installGlobalKeys` と二重発火する)。
