# scrapbox-tycoon

Scrapbox 風のローカルファースト・ノートアプリ。編集内容はまず `LocalStore`
(localStorage) に即書き込まれ、`GitHubSyncStore` がバックグラウンドで
GitHub リポジトリ (`gosyujin/scrapbox-tycoon-notes`) にまとめてコミットする。
本体は `https://note.gosyujin.com/scrapbox-tycoon/` (GitHub Pages) にデプロイ。

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
  デバウンス (`AUTO_SYNC_DEBOUNCE_MS = 4000`) してから `GitHubStore` へ
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
- `src/editor.ts` — テキストエリアベースのエディタ。`onChange` は **キー入力毎
  ではなく blur/commit 時に一度だけ**発火する (この前提を誤ると
  app.ts 側でバグを作り込む — 実例は下記)。
- `src/app.ts` — ルーティング・ページ描画・設定画面など UI 全般。

## このセッションでの変更と経緯

### 1. ヘッダーのアイコン群を右寄せ (`38adcfe`)

📖 参照リンク / 🔀 ランダム / ⚙️ 設定のアイコンを PC・スマホ共に右端に揃えたい
という要望。デスクトップでは隣接する検索ボックス (`quick-open-row`) の
`flex: 1` が結果的にこれを実現していたが、モバイル幅では `quick-open-row` が
自分の行に折り返すため、ブランド名の隣にアイコン群が来てしまっていた。
`.topbar nav { margin-left: auto; }` を追加し、幅に関わらずアイコン群自体を
行の右端に押し出す形にした。

### 2. GitHub 同期失敗が `Uncaught (in promise)` として出る問題 (`291b9e3`)

**報告されたエラー:**
```
Uncaught (in promise) Error: Could not save after 8 attempts: branch moved during save
```

**調査の経緯:** 「既存ページの内容を全部消す」という操作単体では、モック
GitHub API 上で再現しなかった。2 インスタンスを同時に同期させて競合させても
1 回のリトライで自己回復し、8 回使い切ることはなかった。つまり
「branch moved during save」自体を起こすには、複数タブ/デバイスの同時書き込み
や回線の問題など、このコードベース側では再現も防止もできない外的要因が
実際に必要と考えられる —— **この根本原因の特定は棚上げ**にした
(over-engineering を避ける方針)。

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

**教訓:** 「サーバーに問題があった」という報告に対して、まず自分の手元で
再現を試みたが再現しなかった。再現しないこと自体は「バグがない」ことの
証明にはならない —— ログ機構がなければ、この関連バグは見つからずコンソール
ノイズとして放置されていた可能性が高い。次のセクションの同期ログはその
反省から生まれた。

### 3. 同期ステータス履歴のコピー機能 (`e26e462`)

上記の調査で、「同期中のまま止まった」のようなユーザー体験を後から正確に
追うための材料が何もないことが分かった。`GitHubSyncStore.setStatus()` が
状態遷移の度に `{t, state, dirtyCount, lastError}` を localStorage
(`scrapbox_tycoon_sync_log_v1`, 直近 300 件) に追記するようにした。
**あえて localStorage に永続化**しているのは、リロードや `GitHubSyncStore`
インスタンスの再生成を跨いで残す必要があるため —— 問題が起きたその場で
デバッグできるとは限らない、という前提。

`SyncCapable.getStatusLogText()` でテキスト化し、設定画面に
「同期ログをコピー（デバッグ用）」ボタンを追加。バグ報告時にこれをそのまま
貼ってもらう想定。

### 4. ページを空にすると一覧と中身が食い違うバグ (`a6c1cbb`)

**報告:** 「test」というページを作って内容を空にすると、同期は正常に完了する
のに、一覧には「test」のカードが残り、開くと空っぽになる。

**この報告が重要だった理由:** 同期ログを実際に貼ってもらったところ、同期は
`idle, dirty=0` まで完全に正常完了していた。つまり (2) の GitHub 同期層とは
無関係で、**純粋にローカルのデータ整合性バグ**だと即座に切り分けられた ——
デバッグログ機能を作った直後に、その機能自体がこの切り分けに役立った形。

**根本原因:** `app.ts` の `onChange` ハンドラが
`let newTitle = lines[0] || currentTitle;` としており、1 行目が空になった
場合に「古いタイトルにフォールバックする」実装になっていた。これは
「`onChange` は編集中に何度も呼ばれるので、空文字は編集途中の一時的な状態
かもしれない」という誤った前提に基づくものだった。実際には `editor.ts` の
`commit()` を読むと `onChange` は **blur 時に一度だけ**呼ばれる。つまり
本当にページを空にして確定した場合でも、ページの「識別子」であるはずの
`title` フィールド (一覧のカード、URL ルーティング、`knownTitles` が参照する)
だけが古い値のまま残り、実体の `lines[0]` は空という、内部矛盾した
`Page` レコードを黙って保存していた。

**修正:** 実 Scrapbox の export JSON (ユーザーが以前提示) が実際にこの挙動を
持つことを確認済みで、それに合わせた: 空になったページは "Untitled"
(既に存在するなら既存の `uniqueTitle()` ヘルパーで "Untitled_2" ...) に
リネームする、通常のタイトル変更と同じパスを通す形にした。ただし
`onChange` は「変更なしで開いて閉じただけ」でも blur ごとに毎回発火するため、
既に "Untitled" 系のページを無変更で再保存する度に "_2" → "_3" と番号が
増え続けないよう、`/^Untitled(_\d+)?$/` にマッチする場合は現在のタイトルを
維持するガードを入れている。

**注意 (既存データへの非遡及):** この修正はコードのバグを直すものであり、
**既にこのバグで壊れた既存ページを自動修復しない**。実運用データに残っていた
`title: "test", lines: ['']` のようなページは、開いて 1 行目に何か 1 文字
入力する (通常のリネーム経路を通させる) ことで手動修復が必要。

**副産物 (未対応):** 個別ページの「削除」ボタンは UI に存在しない
(削除が起きるのは現状リネーム/マージ時の暗黙処理と、リモートにだけ残った
孤立ページの掃除機能のみ)。要望が出たら検討。

**テスト方法上の注意点 (アプリのバグではない):** Browser pane 上で
`element.blur()` を JS から呼んでも、`document.hasFocus()` が `false` の
状態では `document.activeElement` は変わるのに実際の `blur` イベントは
発火しないことがある。`ta.dispatchEvent(new FocusEvent('blur'))` で
明示的にイベントを発火させる必要がある。これに気づかず「新規ページ限定の
バグ」と誤診しかけた。

### 5. ページ一覧に接続先リポジトリへのリンクと最終同期コミットを表示 (`8854425`)

デバッグ用に、ページ一覧上部のバッジを実リポジトリへのリンクにし、隣に
最終同期時点のコミット短縮 hash・時刻・未同期の変更があるときの
`[Modified]` を表示するようにした。`SyncStatus.lastSyncedCommitSha` を
新設し、`GitHubStore.getHeadCommitSha()` で毎回の同期成功後に HEAD を
読み直して埋める (push しなかった pull-only の同期でも更新される)。

### 6. 同期直後にPC/スマホの表示が古い内容へ「巻き戻る」問題 (`0709f2c`)

**報告:** PCでページの内容を編集して同期完了 (リポジトリには正しく反映
済み) の後、ページ間を行き来していると表示内容が編集前に戻ることがある。
リロードを繰り返すとやがて正しい内容に落ち着く。スマホ側はリポジトリの
反映を確認した後もページ内容が反映されず、アプリの終了/再起動を繰り返す
とやがて反映される。両方とも「時間が解決している」ようだった。

**調査:** `GitHubSyncStore.getPage()` は常に `LocalStore` (localStorage)
だけを読むので、ページ間移動そのものが GitHub と通信することはない ——
つまり「戻る」ように見えたのは `pull()` が実際に localStorage を古い内容
で **上書きしていた**、という話になる。`pull()` は
`remote.listPages()` (`GET git/ref/heads/<branch>` → `GET git/trees/...`)
で取得した `updated` と `meta.lastSyncedUpdated` を比較し、食い違って
いれば「他デバイスの変更」とみなして `remote.getPage()` の内容で
ローカルを上書きする実装 (`github-sync-store.ts` の `pull()` 参照)。

実際に GitHub API を叩いて確認したところ、`GET git/ref/heads/<branch>`
(ブランチの現在地を読む唯一の入口) のレスポンスは
`Cache-Control: public, max-age=60, s-maxage=60` だった。`github-store.ts`
の `fetch()` はキャッシュ方針を何も指定していなかったため、既定の
ブラウザ HTTP キャッシュが効き、**自分自身の commit 直後でも最大60秒間、
書き込み前の古いブランチ先端 sha が返ってくる**ことがある。しかも
書き込み (`PATCH git/refs/heads/<branch>`, 複数形) はこの読み取り
(`GET git/ref/heads/<branch>`, 単数形) と別 URL なので、ブラウザ側は
「この PATCH で GET のキャッシュが無効になった」と気づく手段がない。

その結果 `pull()` は「自分がさっき書いた新しい内容」を、たまたま
キャッシュされていた古い ref 越しに読んだ「他デバイスの変更」だと誤認し、
ローカルの localStorage を古い内容へ上書きしてしまう。60秒経てば
キャッシュが失効して正しい ref が返るようになるため、リロードや
タスクキル再起動を繰り返すうちに「そのうち直る」ように見えていた ——
実体は原因不明の自己修復ではなく、単純なキャッシュ TTL 切れ。

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

**副産物:** 個別ページの画面にも、この店の最終同期コミット hash・時刻と
そのページ自身の `updated` を並べて表示する行を追加した (同期関連の不具合
調査で「このページの表示は本当に同期済みの内容か」をページを開いたまま
その場で確認できるように)。

### 7. 2台で同じページを編集すると片方の更新が無言で消える問題

**報告:** スマホでページに追記して同期完了 (GitHub に反映済み) の直後、PC で
同期したら一覧・内容ともにスマホの追記が跡形もなく消え、PC 側の (古い) 内容に
戻ってしまった。

**調査:** 実際の3コミット
(スマホ [`b66065c`](https://github.com/gosyujin/scrapbox-tycoon-notes/commit/b66065c83a3e9244c53d467eddbe9a17d3c632bb) →
[`8994df4`](https://github.com/gosyujin/scrapbox-tycoon-notes/commit/8994df470737990f5e3311454107da47bfd38e49) →
PC [`0f9e937`](https://github.com/gosyujin/scrapbox-tycoon-notes/commit/0f9e93734bcc22ad5b6f6c52a8befd5d80b2dcbb))
を比較すると、PC のコミットの親は確かにスマホの最新コミットで、PC は一度その
内容を取得していた。しかし最終的に書き込まれた内容はスマホの追記を含まない
PC 側の古い内容だった —— キャッシュ (6.) は無関係で、GitHub 側のレスポンスも
コミット親子関係も正しい。

**根本原因:** これは `github-sync-store.ts` 冒頭のコメントに明記されている
**意図的な仕様**の実害だった: `pull()` はローカルで dirty なページを
「push で勝つので気にしなくていい」として無条件にスキップしており
(`if (this.meta.dirty.includes(entry.title)) continue;`)、リモート側が
実際に (別デバイスの同期で) 変化していたかどうかを一切見ていなかった。
PC は同じページをオフライン等でまだ push していない編集を抱えたまま
同期しており、`pull()` はスマホの追記を無視し、`push()` は PC のその
古い内容をまるごと GitHub に書き込んで上書きした。「同じページを2台で
編集した場合は新しい方が勝つ」という設計自体は残す判断をしたが、
負けた側の内容が**無言で完全に消える**のは望ましくないため、そこだけ直した。

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

**既存データへの非遡及:** 今回のバグで既に上書きされてしまった
`scrapbox-tycoon-notesテスト` ページの追記内容は、このページを開いて
再編集しても自動では戻らない (今回の修正は「これから起きる競合」を
検出するもので、過去に失われた内容を遡って復元するものではない)。
GitHub 上の [`8994df4`](https://github.com/gosyujin/scrapbox-tycoon-notes/commit/8994df470737990f5e3311454107da47bfd38e49)
時点の内容 (上書き前) がまだ履歴に残っているので、手動で復元したい場合は
そのコミットの `pages/scrapbox-tycoon-notesテスト.json` を見て該当行を
ページに書き戻す。

### 8. 自分自身の push が「(sync conflict)」として別ページになる問題

**報告:** スマホ操作のみのはずなのにコンフリクトが発生した。実リポジトリの
`心療内科 (sync conflict).json` を元ページ `心療内科.json` と比べると、
`lines`/`created`/`updated` が**完全一致**していた (=別端末の編集ではない)。

**根本原因:** 7. の競合判定は「ローカルが dirty かつ remote の `updated` ≠
`lastSyncedUpdated`」だけで成立する。一方 `lastSyncedUpdated` は
`pushBatch()` の**レスポンスを受け取った後**にしか更新されない。push の
コミットが GitHub に着地したのに応答が届かない場合 (iOS が PATCH 直後に PWA を
凍結/終了、モバイル回線の切断、リトライ上限到達) は dirty のまま・
`lastSyncedUpdated` は古いままになり、次回 `pull()` が自分の書き込みを
「別端末の変更」と誤認していた。

**修正 (`github-sync-store.ts`):**
1. `push()` が `pushBatch()` を呼ぶ**前**に `meta.pendingPush[title] = updated`
   を localStorage へ永続化し、確認応答後に消す。`stashConflictIfDiverged()` は
   remote の `updated` が `pendingPush` と一致したら自分の書き込みとして
   `lastSyncedUpdated` を進めるだけで stash しない。
2. 保険として、remote ページを取得した後にローカルと `lines` を比較し、同一内容
   なら競合扱いにしない (`pendingPush` を持たない旧 meta でも誤判定しない)。

**それでも本物の競合が起きた場合の UI (`app.ts`):** `(sync conflict)` ページには
通常の「同名ページ」バナーより目立つ競合専用バナーを出し、元ページとの行単位
diff (`src/diff.ts`) の結果を「一致 / 不一致 (N 行の違い)」で表示、「違いを見る」
で +/- の差分を展開できる。一致なら「このコピーを削除」を主ボタンにし、統合
ボタンは出さない (同内容を統合すると全行が重複するため)。

回帰テスト: `test/sync-own-push-not-conflict.test.mjs` (mock に「PATCH は適用
されるが 500 を返す」`setLostAckOnRefUpdate` を追加。修正を外すと両ケースとも
fail することを確認済み)、`test/diff.test.mjs`。

**既存データへの非遡及:** 既にできた `心療内科 (sync conflict)` は自動では消えない。
ページを開くと「一致」と表示されるので「このコピーを削除」で消す。

## 開発

```bash
npm run build   # tsc + build-info 埋め込み + import のキャッシュバスティング
npm run dev     # build して簡易サーバーを起動
npm test        # build してから test/*.test.mjs を実行
```
