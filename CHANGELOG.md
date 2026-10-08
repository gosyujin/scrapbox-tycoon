# CHANGELOG

1エントリ1〜3行。経緯のあるものは `docs/decisions/` にリンクする。コミットは新しい順。

- 2026-10-07 (`5d4ed64`) Changed/Added: 競合コピー (sync conflict) を編集しても `_N` にならないよう stash 時に `lines[0]` を書き換え、「このページを削除」ボタンを追加。 → [decisions/08](docs/decisions/08-own-push-treated-as-conflict.md)
- 2026-10-07 (`6132a11`) Fixed/Added: 応答が届かなかった自分の push を「(sync conflict)」と誤認する問題を修正 (`meta.pendingPush`)、競合専用バナーと行単位 diff を追加。 → [decisions/08](docs/decisions/08-own-push-treated-as-conflict.md)
- 2026-09-26 (`927f121`) Fixed: 2台で同じページを編集すると片方が無言で消える問題を、競合を「(sync conflict)」ページに退避して修正。 → [decisions/07](docs/decisions/07-concurrent-edit-silently-lost.md)
- 2026-09-26 (`8854425`) Added: ページ一覧に接続先リポジトリへのリンク・最終同期コミット hash/時刻・`[Modified]` を表示。 → [features](docs/features.md)
- 2026-09-26 (`0709f2c`) Fixed: `GitHubStore` の全 fetch に `cache: 'no-store'` を付け、ブラウザ HTTP キャッシュで同期直後に表示が巻き戻る問題を修正。 → [decisions/06](docs/decisions/06-stale-ref-http-cache.md)
- 2026-09-26 (`a6c1cbb`) Fixed: ページを空にすると一覧と中身が食い違うバグを修正 (空ページは "Untitled" にリネーム)。 → [decisions/04](docs/decisions/04-empty-page-title-desync.md)
- 2026-09-26 (`e26e462`) Added: 設定画面に「同期ログをコピー（デバッグ用）」ボタン。 → [features](docs/features.md)
- 2026-09-26 (`291b9e3`) Fixed: 内部発火の同期失敗が `Uncaught (in promise)` として出る問題を修正 (`.catch()` 追加)。 → [decisions/02](docs/decisions/02-sync-failure-unhandled-rejection.md)
- 2026-09-26 (`38adcfe`) Changed: ヘッダーのアイコン群を PC・スマホ共に右寄せ。 → [features](docs/features.md)
