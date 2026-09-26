# CLAUDE.md

作業を始める前に [README.md](README.md) を読むこと。アーキテクチャ概要と
直近の変更の経緯がまとまっている。

## この codebase 特有の注意点

- **`editor.ts` の `onChange` は blur/commit 時に一度だけ発火する。**
  キー入力の度に呼ばれるものではない。「編集途中の一時的な状態かもしれない」
  という前提で `app.ts` 側にフォールバック処理を書くと、過去に実際に
  タイトル/内容の不整合バグを生んだ (README の「4. ページを空にすると…」参照)。
  `onChange` 内で lines[0] が空 / 想定外の値になるケースは、「編集完了として
  確定した値」として扱う。

- **同期関連の不具合報告を受けたら、まず設定画面の「同期ログをコピー
  （デバッグ用）」の結果 (`GitHubSyncStore.getStatusLogText()`,
  localStorage の `scrapbox_tycoon_sync_log_v1`) を確認する。** ここで
  `state=idle` かつ `lastError` なしで完了していれば、GitHub 同期層
  (`github-store.ts` / `github-sync-store.ts`) は無関係と判断してよく、
  ローカルのデータ整合性側を疑う方が早い。

- **`Could not save after 8 attempts: branch moved during save` のような
  「外的要因が絡む」エラーは、手元のモック (`test/mock-github-api.mjs`) だけで
  無理に再現しようとしない。** このリポジトリでの調査では、単一操作や
  2 インスタンス同時同期のシミュレーションでは再現せず、実際には複数タブ/
  デバイスの同時書き込みや回線起因である可能性が高いという結論に至った。
  再現しないこと自体はバグがないことの証明にはならないが、確証のない推測で
  リトライ回数を増やす、待機時間を延ばす等の対症療法を先回りして入れない。
  具体的な再現手順やタイミングの証拠が新たに出てから対応する。

- **Page レコードの形が変わるような修正 (フィールドの意味変更、フォールバック
  ロジックの変更等) は既存の保存済みデータを遡って直さない。** 修正後も
  ユーザーの実データに壊れたレコードが残っている前提で、手動修復の方法を
  必ず伝えること。

- **内部で fire-and-forget している `Promise` (`void foo()` の形) には必ず
  `.catch()` を付ける。** `runSync()` のように呼び出し元 (直接 await する側)
  への通知のために re-throw している関数を、内部のタイマー等から await せず
  呼ぶ場合、その関数側で失敗が既に完全に処理済みであっても、呼び出し側に
  `.catch()` がないと「未処理の Promise rejection」としてコンソールに出る。

- **Browser pane (このセッションの組み込みブラウザ) でテキストエリアの
  blur を JS から発生させたい場合、`element.blur()` ではなく
  `element.dispatchEvent(new FocusEvent('blur'))` を使う。** Browser pane
  では `document.hasFocus()` が fronted なタブでも `false` になることがあり、
  この状態だと `.blur()` は `document.activeElement` を変えるだけで実際の
  `blur` イベントリスナーを発火させないことがある (新規ページ限定の
  バグに見えたが、実際はテスト手法側の問題だった)。

- 新しい回帰テストを書くときは既存の `test/mock-github-api.mjs` (インメモリ
  Git Data API モデル、fast-forward-only な ref 更新) を使い、コンパイル後の
  `js/store/...` (再実装ではなく実際のビルド成果物) に対してテストする、
  という既存パターンに合わせる。
