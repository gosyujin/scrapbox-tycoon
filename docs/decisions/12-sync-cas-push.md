# 12. 同期の安全化 (段階1): compare-and-swap push

## 経緯

「競合コピーに対して競合コピーができる」「スマホだと判定できない」という報告を受け、同期プロトコル全体を
見直した。GitHub (private repo) を使う方針自体は問題ない: `PATCH git/refs` (`force:false`) は
そのまま compare-and-swap になり、履歴は常に安全網になる。問題は、それを活かさずに端末の時計の `updated`
と手動管理の dirty リストで判断していた実装側にある。以下はコード読みで経路を確認したもので、
実データでの再現ログは未取得。

## 見つかった欠陥と対処

| 欠陥 | 対処 |
|---|---|
| pull() の検査と push() の書き込みが別操作で、間に他端末が commit すると上書きされる | `PageChange.expectedUpdated` を `commit()` の試行ごとに base と照合。不一致は `PushConflictError` (再試行しない) → `runSync()` が再 pull して stash し再 push (最大 `MAX_SYNC_PASSES` 回) |
| ローカルで削除したページを他端末が編集すると、pull で復活した後 push の削除が走り編集が消える | pull が `deleted` から外す (編集側が勝つ)。push の削除にも CAS を付けた |
| `X (sync conflict)` を2台で編集すると `X (sync conflict) (sync conflict)` ができる | 競合コピー自体は stash 対象・CAS 対象から外す (使い捨て。後の push が勝つ) |
| 別端末で同じタイトルを新規作成すると無言で上書き (`lastSyncedUpdated` が未定義だと stash されなかった) | 未同期タイトルでも内容が違えば stash |
| `this.meta` がコンストラクタで一度読んだ古いコピーで、複数タブ/PWA が互いの dirty を消し合う | `fresh()` / `updateMeta()` で毎回 localStorage から読み直して書く。同期は Web Locks で端末内1本 (20 秒で待ちを諦めて無ロックで続行) |

stash 時に `lastSyncedUpdated` を remote の版へ進める (見て保全した版の上に自分の版を載せる)。
これをしないと push の CAS が、検出済みの競合でも毎回失敗する。

## 即時反映

編集から push までのデバウンスを 4 秒 → 2 秒、前面ポーリングを 30 秒 → 10 秒 (アイドル時は ref 読み取り1回。
以前は表示用 HEAD の再読み取りでさらに1回だった)。

## 今回やっていないこと (段階2以降の案)

- 基準版 (`baseSha`) を持った行単位の 3-way マージと、重なった箇所のページ内マーカー + 1タップ解決。
- `_index.json` の廃止 (tree 一覧の blob sha をバージョンにする)。
- rename を title フィールド変更にする (安定 ID)。データ移行が必要。

## 既存データ

過去に出来た `(sync conflict)` ページは自動では消えない。→ [troubleshooting](../troubleshooting.md)

## 回帰テスト

`test/sync-cas-push.test.mjs` (5 件。修正前は全て fail することを確認済み)。
