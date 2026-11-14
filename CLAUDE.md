# CLAUDE.md

作業を始める前に [README.md](README.md) の概要を読むこと。アーキテクチャは
[docs/architecture.md](docs/architecture.md)、経緯は [docs/decisions/](docs/decisions/) にある。
ファイル別の「触ると壊れる箇所」は `.claude/rules/` にあり、該当ファイルを開くと自動で読み込まれる
(同期層 `src/store/github-*.ts` / `src/merge.ts`、エディタ `src/app.ts` / `src/editor.ts` / `cm-editor/`、キー操作 `src/keymap.ts` / `src/shortcuts.ts`、ページツールバー・pin `src/pins.ts`、`test/`)。

## 不具合報告を受けたとき

- **同期関連の報告は、まず設定画面の「同期ログをコピー(デバッグ用)」の結果**
  (`GitHubSyncStore.getStatusLogText()`、localStorage の `scrapbox_tycoon_sync_log_v1`)を見る。
  `state=idle` かつ `lastError` なしで完了していれば、GitHub 同期層は無関係と見てよく、ローカルのデータ整合性側を疑う方が早い。
- **例外: 「同期後もページ一覧/本体が古いまま」は、ログが正常でも `github-store.ts` の fetch に `cache: 'no-store'` が付いているかを疑う。**
  ブラウザの HTTP キャッシュが古い ref を返すだけなので、ログ上は正常に完了して見える
  ([docs/decisions/06-stale-ref-http-cache.md](docs/decisions/06-stale-ref-http-cache.md) の「6.」)。
  `GET git/ref/heads/<branch>` は `max-age=60` で返るため、`no-store` が無いと自分の commit 直後でも最大60秒古い ref が返り、
  `pull()` がそれを他デバイスの変更と誤認してローカルを巻き戻す。**`no-store` は外さない。**
- `Could not save after 8 attempts: branch moved during save` のような外的要因が絡むエラーは、手元のモックで無理に再現しようとしない。
  複数タブ/デバイスの同時書き込みや回線起因の可能性が高い。確証のない推測でリトライ回数・待機時間を増やす対症療法を先回りして入れず、再現手順やタイミングの証拠が出てから対応する。

## 変更の進め方

- **Page レコードの形が変わる修正(フィールドの意味変更、フォールバックの変更等)は、既存の保存済みデータを遡って直さない。**
  ユーザーの実データに壊れたレコードが残っている前提で、手動修復の方法を必ず伝える([docs/troubleshooting.md](docs/troubleshooting.md))。
- 内部で fire-and-forget している `Promise`(`void foo()` の形)には必ず `.catch()` を付ける。
  `runSync()` のように呼び出し元への通知のために re-throw する関数を、タイマー等から await せずに呼ぶと、
  失敗が処理済みでも「未処理の Promise rejection」としてコンソールに出る。
- **Browser pane(組み込みブラウザ)でテキストエリアの blur を JS から起こすときは、`element.blur()` ではなく
  `element.dispatchEvent(new FocusEvent('blur'))` を使う。** Browser pane では `document.hasFocus()` が前面のタブでも
  `false` になることがあり、`.blur()` は `document.activeElement` を変えるだけでリスナーを発火させないことがある
  (新規ページ限定のバグに見えたが、テスト手法側の問題だった)。

## ドキュメント運用ルール
- 作業開始時は CLAUDE.md と README の概要だけ読む。docs/ は `.claude/rules/` の指示に従い、該当作業のときだけ読む。CHANGELOG は全文を読まず直近のエントリだけ見る。
- README に経緯・実装ログ・機能の詳細を書かない。機能を追加したら README には一行、詳細は docs/features.md に書く。
- 実装完了時は CHANGELOG に1〜3行で追記する。調査や判断に経緯がある場合は docs/decisions/ に書き、CHANGELOG からリンクする。
- 触ると壊れる箇所・変更禁止の理由は docs/technical-notes.md に書き、`.claude/rules/` の該当ファイル(`paths` に対象ファイルを書く)に1行で要約する。特定のファイルに結びつかない注意だけ CLAUDE.md に書く。
- 実機確認が必要で未確認の項目は technical-notes.md の「未検証」に書く。確認できたら削除し、CHANGELOG に「確認済み」と1行残す。
- README が150行、CLAUDE.md が200行を超えたら、追記せず分割を提案する。
