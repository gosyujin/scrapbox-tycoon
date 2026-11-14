---
paths:
  - "src/store/github-store.ts"
  - "src/store/github-sync-store.ts"
  - "src/merge.ts"
---
# 同期層(src/store/github-*.ts, src/merge.ts)

全般: [docs/technical-notes.md](../../docs/technical-notes.md)、[docs/architecture.md](../../docs/architecture.md)

- **`GitHubStore` の全 `fetch()` に `cache: 'no-store'` を付ける。** `GET git/ref/heads/<branch>`(ブランチ先端を読む唯一の入口)は `Cache-Control: public, max-age=60` を返す(実 API で確認済み)。書き込みの `PATCH git/refs/heads/<branch>` は別 URL なので、この GET のキャッシュを無効化できない。指定が無いと自分の commit 直後でも最大60秒古い ref が返り、`pull()` がそれを「他デバイスの変更」と誤認してローカルを古い内容で巻き戻す。sha 直参照は無害だが、全リクエスト一律で無効化する方が単純。→ [decisions/06](../../docs/decisions/06-stale-ref-http-cache.md)
- 内部で fire-and-forget する Promise(`void this.syncNow()` 等)には必ず `.catch()` を付ける。
- `pull()` は dirty なページでも、remote の `updated` が `lastSyncedUpdated` と食い違えば `mergeDiverged()` で 3-way マージする(基準版は `meta.baseCommit[title]` のコミットから `getPageAt()`。無ければ `commonLines()`)。**「(sync conflict)」コピーページはもう作らない**(配られて複数端末で同時に解消され、解消自体が新しい競合になった)。同じ行の衝突は `merge.ts` のマーカーでページ内に残す。マージは対称・決定的でなければならない(マーカーに端末名・時刻を入れない、両側は `updated` 順)。2台が同じ食い違いをマージして同一内容になるのが収束の条件。→ [decisions/13](../../docs/decisions/13-three-way-merge-in-page-markers.md)
- `push()` の各変更は `expectedUpdated`(最後に見た remote の `updated`)を持ち、`pushBatch()` が commit 試行ごとに照合して、食い違えば `PushConflictError` を投げる(`runSync()` が再 pull → 再 push、最大4回)。`meta` は他タブと共有の localStorage なので、判断・更新は必ず `fresh()` / `updateMeta()` 経由(インスタンスの `this.meta` を直接書き戻さない)。→ [decisions/12](../../docs/decisions/12-sync-cas-push.md)
- `push()` は `pushBatch()` の前に `meta.pendingPush` を永続化する(応答が届かなかった自分の push を競合と誤認しないため)。remote とローカルの `lines` が同一なら競合扱いにしない。
- `savePage()` は既存と同一内容なら no-op(blur の度に呼ばれる `onChange` が無変更ページを dirty にして偽の競合を作るため)。pull 省略用の `lastPulledHeadSha` は pull「前」に読んだ HEAD を保存する。→ [decisions/09](../../docs/decisions/09-noop-save-conflict-and-polling.md)
- 旧版が作った `(sync conflict)` コピーは残っているので、`isSyncConflictTitle()` は競合判定の対象外(後の push が勝つ)として残している。`lines[0]` はページの identity: マージ対象から除外し、マーカーが1行目に来ないようにしている。
