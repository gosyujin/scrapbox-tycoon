# 技術的な注意点・変更禁止の不変条件

各節の経緯・原因調査は `docs/decisions/` の同番号のファイルにある。

## 変更禁止の不変条件 (修正内容と回帰テスト)

### 2. GitHub 同期失敗が `Uncaught (in promise)` として出る問題 (`291b9e3`)

一方で、**別の実バグ**を特定して修正した: `scheduleSync()` のデバウンス
タイマーと `runSync()` の失敗時リトライタイマー、この 2 箇所の内部発火
(`void this.syncNow()`) に `.catch()` が付いていなかった。`runSync()` は
失敗時に状態更新・リトライ予約まで済ませてから re-throw する
(直接 await している `syncNow()`/`listOrphanedRemotePages()` の呼び出し元に
知らせるための re-throw であり、内部発火側では拾う必要がない) にも
関わらず、内部発火側に `.catch()` がなかったせいで「処理済みのはずの失敗」が
未処理の Promise rejection としてコンソールに出ていた。両箇所に
`.catch(() => {})` を追加。

`test/sync-unhandled-rejection.test.mjs` で、ref 更新を強制的に 422 で
失敗させ続けても unhandled rejection が発生しないことを回帰テスト化。
修正前のコード (`.catch()` を外した状態) に戻すと、ユーザー報告と**全く同じ
エラーメッセージ・スタック形状**で failing することを確認済み —— テストが
実際にこのバグを捉えていることの裏付け。

### 4. ページを空にすると一覧と中身が食い違うバグ (`a6c1cbb`)

**修正:** 実 Scrapbox の export JSON (ユーザーが以前提示) が実際にこの挙動を
持つことを確認済みで、それに合わせた: 空になったページは "Untitled"
(既に存在するなら既存の `uniqueTitle()` ヘルパーで "Untitled_2" ...) に
リネームする、通常のタイトル変更と同じパスを通す形にした。ただし
`onChange` は「変更なしで開いて閉じただけ」でも blur ごとに毎回発火するため、
既に "Untitled" 系のページを無変更で再保存する度に "_2" → "_3" と番号が
増え続けないよう、`/^Untitled(_\d+)?$/` にマッチする場合は現在のタイトルを
維持するガードを入れている。

### 6. 同期直後にPC/スマホの表示が古い内容へ「巻き戻る」問題 (`0709f2c`)

**修正:** `GitHubStore` の全リクエストに `cache: 'no-store'` を付けて
ブラウザの HTTP キャッシュを明示的に無効化した (`git/commits/<sha>` や
`git/trees/<sha>` のような sha 直参照は本来キャッシュされても内容的には
無害だが、可変な ref の読み取りだけ区別して個別対応するより、全リクエスト
一律で無効化する方が単純で安全)。回帰テスト
`test/sync-http-cache.test.mjs` で、`GitHubStore`/`GitHubSyncStore` が
発行する全リクエストの `init.cache` が `'no-store'` であることを検証
(この変更を戻すと fail することを確認済み)。インメモリの API モックには
実ブラウザの HTTP キャッシュ自体は無いため、このテストは「不整合の再現」
ではなく「修正が確実に効いた状態を維持する」ためのもの。

### 7. 2台で同じページを編集すると片方の更新が無言で消える問題

**修正:** `pull()` で dirty なページを見つけたとき、そのページの
remote `updated` が最後に同期した時点の値と食い違っていれば
(＝本当に他デバイスがその後編集した)、リモートの内容を捨てずに
別ページとして保存し、既存の `mergeCandidate` / 統合バナーの仕組み
(タイトル衝突時に app.ts が使っているのと同じもの、`app.ts:742` 周辺)
で「〇〇 (sync conflict)」という別ページとして残すようにした
(`github-sync-store.ts` の `stashConflictIfDiverged()`)。同じ食い違いに対して
再送のたびに複製が増えないよう `meta.conflictSeen` で一度スタッシュした
差分を記録している。ページタイトルが同一で内容だけ食い違う「本当の
競合」だけを検出する狙いなので、両デバイスで同時に新規作成した場合の
タイトル衝突 (同期上一度も見たことのないタイトル) は対象外 —— そちらは
今回のバグとは無関係の別ケース。

回帰テスト `test/sync-conflict.test.mjs` で、2台の `GitHubSyncStore`
(ローカルストレージを分離し、1つの mock GitHub リモートを共有) を使って
この状況を再現し、負けた側の編集が別ページとして残ることを検証
(この変更を戻すと、実際の被害と全く同じ「消えたことを示すアサーションで
fail」することを確認済み)。

### 8. 自分自身の push が「(sync conflict)」として別ページになる問題

**修正 (`github-sync-store.ts`):**
1. `push()` が `pushBatch()` を呼ぶ**前**に `meta.pendingPush[title] = updated`
   を localStorage へ永続化し、確認応答後に消す。`stashConflictIfDiverged()` は
   remote の `updated` が `pendingPush` と一致したら自分の書き込みとして
   `lastSyncedUpdated` を進めるだけで stash しない。
2. 保険として、remote ページを取得した後にローカルと `lines` を比較し、同一内容
   なら競合扱いにしない (`pendingPush` を持たない旧 meta でも誤判定しない)。

回帰テスト: `test/sync-own-push-not-conflict.test.mjs` (mock に「PATCH は適用
されるが 500 を返す」`setLostAckOnRefUpdate` を追加。修正を外すと両ケースとも
fail することを確認済み)、`test/diff.test.mjs`。

## 既知の制限・未解決

- 「branch moved during save」の根本原因の特定は棚上げ。経緯は [decisions/02-sync-failure-unhandled-rejection.md](decisions/02-sync-failure-unhandled-rejection.md) の「調査の経緯」を参照。

## テスト手法上の注意

### 4. ページを空にすると一覧と中身が食い違うバグ (`a6c1cbb`)

**テスト方法上の注意点 (アプリのバグではない):** Browser pane 上で
`element.blur()` を JS から呼んでも、`document.hasFocus()` が `false` の
状態では `document.activeElement` は変わるのに実際の `blur` イベントは
発火しないことがある。`ta.dispatchEvent(new FocusEvent('blur'))` で
明示的にイベントを発火させる必要がある。これに気づかず「新規ページ限定の
バグ」と誤診しかけた。

