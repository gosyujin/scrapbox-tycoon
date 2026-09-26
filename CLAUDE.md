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
  ローカルのデータ整合性側を疑う方が早い —— **ただし例外として、
  ブラウザの HTTP キャッシュ絡みの不具合 (README の「6. 同期直後に
  PC/スマホの表示が古い内容へ『巻き戻る』問題」参照) はこのヒューリスティック
  をすり抜ける。** GitHub 側のレスポンスがそのまま古いだけなので `state=idle`
  かつ `lastError` なしで「正常に」完了して見える。「同期後もページ一覧/
  ページ本体の内容が古いまま」という報告では、ログが正常でも
  `github-store.ts` の fetch がキャッシュを無効化しているか
  (`cache: 'no-store'`) を併せて疑うこと。

- **`GitHubStore` 内の全 `fetch()` には `cache: 'no-store'` を必ず付ける。**
  `GET git/ref/heads/<branch>` (ブランチ先端を読む唯一の入口) は
  `Cache-Control: public, max-age=60, s-maxage=60` を返す (実 API で確認済み)。
  書き込み先の `PATCH git/refs/heads/<branch>` (複数形) はこの GET
  (単数形) と別 URL なので、ブラウザはこの PATCH でその GET のキャッシュを
  無効化する手段を持たない —— つまり指定なしだと、自分自身の commit
  直後でも最大60秒間、書き込み前の古い ref が返り得る。`pull()` はこれを
  「他デバイスの変更」と誤認してローカルを古い内容で上書きしてしまう
  (README の「6.」参照)。`git/commits/<sha>` や `git/trees/<sha>` のような
  sha 直参照はキャッシュされても内容的には無害だが、可変な ref だけ
  個別対応するより全リクエスト一律で無効化する方が単純。

- **`Could not save after 8 attempts: branch moved during save` のような
  「外的要因が絡む」エラーは、手元のモック (`test/helpers/mock-github-api.mjs`) だけで
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

- 新しい回帰テストを書くときは既存の `test/helpers/mock-github-api.mjs` (インメモリ
  Git Data API モデル、fast-forward-only な ref 更新) を使い、コンパイル後の
  `js/store/...` (再実装ではなく実際のビルド成果物) に対してテストする、
  という既存パターンに合わせる。
