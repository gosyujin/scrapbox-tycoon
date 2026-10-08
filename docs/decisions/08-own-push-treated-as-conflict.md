# 8. 自分自身の push が「(sync conflict)」として別ページになる問題

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

**続報 (競合コピーを編集すると `_2` になる問題):** 動作確認で `(sync conflict)`
ページに文字を足すと `心療内科_2` として保存され、競合状態ではなくなった。原因は
`stashConflictIfDiverged()` が `lines` をリモートのまま (`lines[0]` = 元タイトル)
保存していたこと。ページの identity は `lines[0]` と一致している前提
(`app.ts` の `onChange` は不一致を「リネーム」とみなす) なので、編集の度に元
タイトルへのリネーム → 衝突 → `_N` 付与になっていた。stash 時に
`lines[0]` をコピー自身のタイトルへ書き換えるよう修正 (diff/統合は `slice(1)`
なので影響なし)。また競合ページは保存後にバナーを再描画する (一致/不一致の
結果が編集で古くならないように)。**非遡及:** 修正前に作られた競合コピーは
`lines[0]` が元タイトルのまま残っているので、編集前に1行目を自分のタイトルへ
直すこと (または削除ボタンで消す)。

修正の詳細と回帰テスト: [technical-notes.md](../technical-notes.md) の「8.」 / 競合時の UI: [features.md](../features.md) / 復旧手順: [troubleshooting.md](../troubleshooting.md)
