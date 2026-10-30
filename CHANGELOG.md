# CHANGELOG

1エントリ1〜3行。経緯のあるものは `docs/decisions/` にリンクする。コミットは新しい順。

- 2026-10-30 Changed/Fixed: 競合時に「(sync conflict)」コピーを作るのをやめ、基準版 (git 履歴) との行単位 3-way マージに変更。同じ行の衝突はページ内マーカーで両方残し、ページ上のバナーで 1 タップ解消 (解消しても競合が連鎖しない)。一覧に「⚠ 競合」表示、pull は 1 コミットのスナップショットから読む。 → [decisions/13](docs/decisions/13-three-way-merge-in-page-markers.md)
- 2026-10-29 Added: 同期バッジを段階表示に (待機中 → 同期開始 → 同期中[スピナー・受信/送信] → 完了 / 競合あり / エラー、4 段バーと色付き)。`SyncStatus.phase` / `conflictCount` を追加し、アイドルのポーリングは同期ログに残さないようにした。 → [features](docs/features.md)
- 2026-10-29 Fixed/Changed: 同期の安全化 (段階1)。push を compare-and-swap 化 (pull〜push の間に他端末が書いたページを上書きしない)、ローカル削除が他端末の編集を消す問題・競合コピー同士の連鎖競合・複数タブの古い meta を修正。編集後 2 秒で push、前面ポーリングを 10 秒に短縮。 → [decisions/12](docs/decisions/12-sync-cas-push.md)
- 2026-10-28 Changed/Added: ページエディタを textarea から CodeMirror 6 に置換 (クリックした行だけ記法を展開、他は描画済み)。選択ポップアップ (リンク/装飾)、Ctrl+矢印 (行) / Alt+矢印 (段落) のアウトライン移動・インデント、スマホでキーボードに隠れないキャレット追従を追加。 → [decisions/11](docs/decisions/11-codemirror-editor.md)
- 2026-10-18 Fixed/Changed: 無変更のページ保存が dirty になり「(sync conflict)」を量産していた問題を修正。前面表示中の 30 秒ポーリング・バックグラウンド移行時の即送信・同期バッジの時刻表示/タップで即同期を追加。 → [decisions/09](docs/decisions/09-noop-save-conflict-and-polling.md)
- 2026-10-11 Changed: 追加ボタンと検索フォームを画面下のフッターに固定 (gyazo-tycoon-viewer と同レイアウト、キーボード追従あり)。 → [features](docs/features.md)
- 2026-10-09 Added: ファビコン / apple-touch-icon / PWA アイコンを追加 (`icons/`、deploy workflow にも `cp -r icons` を追加)。
- 2026-10-07 (`5d4ed64`) Changed/Added: 競合コピー (sync conflict) を編集しても `_N` にならないよう stash 時に `lines[0]` を書き換え、「このページを削除」ボタンを追加。 → [decisions/08](docs/decisions/08-own-push-treated-as-conflict.md)
- 2026-10-07 (`6132a11`) Fixed/Added: 応答が届かなかった自分の push を「(sync conflict)」と誤認する問題を修正 (`meta.pendingPush`)、競合専用バナーと行単位 diff を追加。 → [decisions/08](docs/decisions/08-own-push-treated-as-conflict.md)
- 2026-09-26 (`927f121`) Fixed: 2台で同じページを編集すると片方が無言で消える問題を、競合を「(sync conflict)」ページに退避して修正。 → [decisions/07](docs/decisions/07-concurrent-edit-silently-lost.md)
- 2026-09-26 (`8854425`) Added: ページ一覧に接続先リポジトリへのリンク・最終同期コミット hash/時刻・`[Modified]` を表示。 → [features](docs/features.md)
- 2026-09-26 (`0709f2c`) Fixed: `GitHubStore` の全 fetch に `cache: 'no-store'` を付け、ブラウザ HTTP キャッシュで同期直後に表示が巻き戻る問題を修正。 → [decisions/06](docs/decisions/06-stale-ref-http-cache.md)
- 2026-09-26 (`a6c1cbb`) Fixed: ページを空にすると一覧と中身が食い違うバグを修正 (空ページは "Untitled" にリネーム)。 → [decisions/04](docs/decisions/04-empty-page-title-desync.md)
- 2026-09-26 (`e26e462`) Added: 設定画面に「同期ログをコピー（デバッグ用）」ボタン。 → [features](docs/features.md)
- 2026-09-26 (`291b9e3`) Fixed: 内部発火の同期失敗が `Uncaught (in promise)` として出る問題を修正 (`.catch()` 追加)。 → [decisions/02](docs/decisions/02-sync-failure-unhandled-rejection.md)
- 2026-09-26 (`38adcfe`) Changed: ヘッダーのアイコン群を PC・スマホ共に右寄せ。 → [features](docs/features.md)
