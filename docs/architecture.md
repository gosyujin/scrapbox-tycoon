# アーキテクチャ

> 旧 README 冒頭の注記 (原文のまま移動):

このファイルは実装の詳細な API ドキュメントではなく、**なぜ今の形になっているか**
を残すためのもの。次のセッションを始める前に一読すること。

## アーキテクチャ概要

- `src/store/local-store.ts` — localStorage 上の `Store` 実装。トークン不要の
  デモ/開発用、かつ `GitHubSyncStore` のローカルバッファそのもの。
- `src/store/github-store.ts` — GitHub Git Data API (blob/tree/commit + ref) の
  薄いラッパー。楽観的並行制御で ref 更新をリトライする
  (`MAX_COMMIT_ATTEMPTS = 8`, 線形バックオフ)。他デバイス/タブと ref 更新が
  衝突し続けるとここで諦めて `Could not save after 8 attempts: branch moved
  during save` を投げる。
- `src/store/github-sync-store.ts` — 編集を即座に `LocalStore` に書き、
  デバウンス (`AUTO_SYNC_DEBOUNCE_MS = 2000`) してから `GitHubStore` へ
  まとめて push する本体。失敗時は `RETRY_AFTER_FAILURE_MS = 15000` 後に
  自動リトライ (self-healing)。フッターの同期状態表示・デバッグログの
  ソースでもある。
- `src/store/reference-store.ts` — 実 Scrapbox プロジェクトの export JSON を
  読み込んだ、編集不可の参照用スナップショット (IndexedDB)。編集対象の
  ノートとは完全に独立。
- `src/parser.ts` — Scrapbox 記法パーサ。姉妹プロジェクト
  [scrapbox-pwa-viewer](https://github.com/gosyujin/scrapbox-pwa-viewer) の
  `build.py` からの移植で、レンダリング結果をそちらと合わせるためにロジックを
  意図的に同期させている。
- `src/editor.ts` — app.ts から見たエディタの窓口 (薄いローダー)。実体は
  `cm-editor/` の CodeMirror 6 エディタで、esbuild が `js/cm-editor.js` に 1 本化し
  オンデマンドで読み込む (経緯: [decisions/11](decisions/11-codemirror-editor.md))。
  `onChange` は **キー入力毎ではなく blur/commit 時に一度だけ**発火する (この前提を
  誤ると app.ts 側でバグを作り込む — 実例は下記)。
- `cm-editor/` — CodeMirror エディタ本体 (tsc の対象外、`npm run build` が型チェック +
  バンドル)。`decorations.ts` (記法の描画/展開)、`commands.ts` (キー操作)、
  `popup.ts`/`format.ts` (選択ポップアップ)、`mobile.ts` (キーボード追従)、`index.ts` (組み立て)。
- `src/outline.ts` — アウトライン移動/インデントの純粋ロジック (DOM 非依存、テスト対象)。
- `src/app.ts` — ルーティング・ページ描画・設定画面など UI 全般。

