# 14. ScrapboxShortcutKey (UserScript) 流のキー操作を組み込み、UserScript と連携できるようにした

## 経緯

作者は scrapbox.io 用に TamperMonkey の UserScript「ScrapboxShortcutKey」
(`/Users/kk/github/scrapbox-shortcutkey/scrapbox-shortcutkey.user.js`、1 ファイル) を使っており、
tycoon でも同じ手の動きで操作したい。UserScript は Scrapbox の実 DOM (`#text-input`、
`.lines .line`、`span.char-index`、`#editor .selections .popup-menu`、`scrapbox` グローバル) に
依存していて、tycoon (CodeMirror 6) にはどれも無い。`@match` を足すだけでは動かない。

## 選択肢と採用 (A + C)

- A: tycoon が CodeMirror のコマンドとして自前実装する (UserScript 非依存)。
- B: UserScript に tycoon 用アダプタ層を足す。擬似キー入力や外部からの CodeMirror 内部操作に
  依存して不安定になる。UserScript が肥大化する。→ 不採用。
- C: `window.tycoonShortcut` を公開し、UserScript があればキー割り当てだけ登録してもらう。

**A + C を採用**した。操作の実装 (堅牢さが要るところ) は tycoon 側にあり、キー割り当ては
UserScript の表をそのまま使える (UserScript 側でキーを変えたら tycoon に自動で反映される)。
方針は「導入を前提」= **UserScript の有無に関わらず、tycoon のキーを UserScript 流に揃える**。
UserScript が無いときは `DEFAULT_BINDINGS` (UserScript v23 の表の写し) が働く。

## 構成

- `src/keymap.ts` — UserScript のキー正規化 (`normalizeCombo` / `comboFromEvent`) の移植と
  `Keymap` (コンボ → ハンドラ)。DOM 非依存。**UserScript と同じ文字列に正規化されなければ、
  UserScript 側の登録が既定の割り当てを置き換えず二重になる**ので、ここを変えるときは UserScript と揃える。
  `key` が無い合成イベントと IME 変換中 (`isComposing` / `keyCode 229`) は常に無視する。
- `src/shortcuts.ts` — コンテキスト (browse / search / edit)、名前付きハンドラ、既定の割り当て、
  `window.tycoonShortcut` の公開。ハンドラは UserScript と同じ規約 (`false` を返すとキーを握りつぶす、
  それ以外はブラウザ/CodeMirror の既定動作に流す)。
- `cm-editor/shortcuts.ts` — ハンドラの実体 (CodeMirror の view とポップアップを直接操作)。
  UserScript のように `#text-input` へ擬似キーを投げたり `execCommand` で入れたりしない。
  文字の挿入は view の `inputHandler` を通すので `[` の自動閉じ・選択の囲みが入力時と同じになる。
- edit コンテキストは `cm-editor/index.ts` の `Prec.highest` の `keydown` で最初に受ける
  (キーマップより前。UserScript が「キャプチャフェーズで先に受ける」のと同じ目的)。
  browse / search は `installGlobalKeys()` が `document` で受ける。

## 振る舞い (UserScript と揃えたもの)

- 選択ポップアップ: Tab / Shift+Tab で次/前のボタンを強調、Enter で実行、数字 (0 = 10) で番号送り。
  何も強調していない複数行選択での Enter = 「ページ切り出し」(Scrapbox の New page に相当)。
  選択が変わる、ボタンを押す、で強調は消える。
- **Tab (ポップアップなし) = 半角スペース 1 個** (UserScript の方針)。従来の「行のインデント」から変更。
  `table:` の行だけは従来どおりタブ文字 (セル区切りなので)。Shift+Tab (ポップアップなし) は従来どおり
  行のアウトデント。Ctrl+←→ のインデントは変わらない。
- Ctrl+Q = `code:ㅤ` ブロックの頭、Ctrl+Enter = `[`、Ctrl+; = タブ文字、Ctrl+Shift+Enter = 行全体を
  `[ ]` で囲む (インデントと行末空白は外す)。
- Alt+P = ピン留めの切替 (`pin`。ページメニューと同じ。→ [decisions/15](15-page-menu-pin-duplicate.md))。`dup` / `del` ハンドラもあるが既定のキーは無い (UserScript が割り当てれば使える)。
- Alt+Q / Ctrl+1 = ランダムジャンプ (編集中なら先に保存してから)、Shift+H = ホーム、Shift+N = 新規ページ。
- `i` / `o` = 編集に戻る。**以前は先頭 / 末尾固定だったが、直前のキャレット位置に戻る (`o` はその行の下に
  新しい行) ように変更**。
- `defaultKeymap` の `Mod-Enter` (空行挿入) は外した (Windows / Linux で Ctrl+Enter の後に二重に走るため)。

## tycoon に無いので入れなかったもの

ChatGPT 連携、パーマリンク行へのジャンプ、関連ページへの
スクロール (Esc)、検索結果 1 件目へのフォーカス (search コンテキストの Tab)、
ポップアップの記号キー (`"` `>` `+` `~` `#` `.`)。最後のものは Scrapbox のポップアップにある
引用・箇条書き等のボタンを前提にしていて、tycoon のポップアップには対応するボタンが無い。
`popupBySymbol` は一致するボタンが無ければキーを握りつぶさず通常入力に流す。
`cm-editor/shortcuts.ts` の `POPUP_SYMBOL_LABELS` に「キー → ボタン名」を足せば効く (今は空)。

## UserScript 側で必要な変更 (未適用・要確認)

tycoon が `window.tycoonShortcut = { version, handlers, insertText, onBrowse, onSearch, onEditin, clear }` を
公開し、準備できたら `window` に `tycoon-shortcut-ready` を投げる。UserScript は tycoon 上では
**自前のキー受けと Scrapbox 依存の実装を使わず、同じキー表を tycoon の実装に結びつける**。

1. `@match` に `https://gosyujin.com/scrapbox-tycoon/*` を追加 (開発用に `http://localhost:8000/*` も)。
2. ホスト判定 `const ON_TYCOON = location.hostname !== 'scrapbox.io'` を作り、`ON_TYCOON` のときは
   - `document` の keydown と `watchElement('#text-input', ...)` を**付けない** (tycoon 側が受ける。二重発火を防ぐ)。
   - `window.tycoonShortcut` (無ければ `tycoon-shortcut-ready` を待つ) の `onBrowse` / `onSearch` / `onEditin` を
     `binders` として使う。`insertText` も `tycoonShortcut.insertText` に差し替える。
3. `keybindings` 表の値を「実装の名前」で引く形にする。例:
   `'tab': impl.popupTab` / `'o': impl.inputFocusBelowCursor` / `'ctrl+shift+enter': impl.lineBracketing` /
   `'alt+q': impl.random`。`impl` は Scrapbox では今の関数群、tycoon では `tycoonShortcut.handlers`。
   **キーの表 (どのキーに何を割り当てるか) は 1 つのまま**なので、キーを変えると両方に効く。
4. tycoon に無い機能 (`onelineAskChatGPT`、`focusResultHead`、`scrollToRelatedPageList`) は
   `impl` 側が `undefined` のとき登録をスキップする。
5. UserScript が入っていれば、tycoon 側の既定の割り当てはコンボ単位で置き換わる。全部自分で決めたいときは
   登録前に `tycoonShortcut.clear()`。

UserScript は 1 ファイル構成のまま。TamperMonkey へのコピペ運用は変わらない。

## 未検証

実機 (IME 変換中のキー、iOS) は [technical-notes.md の「未検証」](../technical-notes.md) に追記。
