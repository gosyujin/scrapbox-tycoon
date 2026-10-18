# 09. 同期ラグ感と、リロードを繰り返すと「(sync conflict)」が出る問題

## 報告

スマホで追加したメモを PC で見ようとしたとき、「スマホの送信が終わっていない」のか
「PC がまだ取りに行っていない」のか分からない。両方リロードを繰り返していると
結局コンフリクトページができる。

## 原因 (コードから特定。実データでの再現ログは未取得)

1. **何も編集していないページが dirty になっていた (競合の主因)。**
   `Editor.commit()` は blur の度に `onChange` を呼び、`app.ts` は無変更でも
   `store.savePage()` する。`GitHubSyncStore.savePage()` はそれを無条件に
   `LocalStore` へ書く (`updated` が現在時刻に更新される) うえ `markDirty()` していた。
   つまり PC でページを開いて閉じるだけで「PC が編集した」ことになり、スマホが
   同じページを編集して push した後の PC の `pull()` で「dirty かつ remote の
   `updated` が `lastSyncedUpdated` と食い違う」= 競合と判定され、
   「(sync conflict)」コピーができる。リロードと見比べを繰り返すほど踏みやすい。
2. **PC 側が自動で取りに行く契機がなかった。** `pull()` は起動時・`visibilitychange`
   (visible)・自分の編集のデバウンス後にしか走らない。前面に開きっぱなしの PC タブは
   手動リロードするまで更新されない。
3. **スマホ側は編集直後に画面を閉じると送れない。** push は編集の 4 秒後。その間に
   バックグラウンドへ行くとタイマーが凍結し、戻るまで送信されない。
4. **状態表示が曖昧。** 「同期済み」だけでは、いつ GitHub を確認したのか分からない。

## 修正

- `GitHubSyncStore.savePage()`: lines / created / updated / mergeCandidate が既存と
  同一なら何も書かず dirty にもしない (`isNoopSave()`)。
- `app.ts`: 前面表示中は 30 秒ごとに `syncNow()`。バックグラウンドへ移る
  (`visibilitychange` hidden) 時に未送信の変更があれば即 `syncNow()`。
- `runSync()`: dirty が無く、ブランチ HEAD が前回 pull 前に読んだ値
  (`meta.lastPulledHeadSha`) と同じなら pull を省略 (ポーリングは ref 読み取り 1 回
  + 表示用 HEAD 読み取りだけで済む)。pull が実際にローカルを変えた時だけ
  `SyncStatus.dataVersion` を増やし、ページ一覧の再描画はそれを見て行う
  (ポーリングの度に再描画してスクロールが戻らないように)。
- 表示: 「未送信の変更: N件 (まもなく送信)」/「同期済み (確認 H:MM:SS)」。
  画面下の同期バッジをタップすると即同期。

## 切り分け方 (次に同じ報告が来たら)

- スマホ側が「未送信の変更」のまま → スマホ→GitHub が未完了。
- スマホが「同期済み」で PC の「確認」時刻が古い → PC 側がまだ取りに行っていない
  (バッジをタップ)。
- 既に出来てしまった「(sync conflict)」ページは自動では消えない。内容が一致なら
  ページ下部の「このページを削除」(競合バナーに一致/不一致が出る)。
  → [troubleshooting](../troubleshooting.md)

## 回帰テスト

`test/sync-noop-save-and-poll.test.mjs` (無変更 re-save で競合が出ない / 実編集は保存される /
アイドル時のポーリングが ref 読み取りのみ + `dataVersion`)。no-op 判定を外すと 1 件目が fail することを確認済み。
