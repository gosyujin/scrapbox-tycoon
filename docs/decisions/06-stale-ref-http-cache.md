# 6. 同期直後にPC/スマホの表示が古い内容へ「巻き戻る」問題 (`0709f2c`)

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

修正の詳細と回帰テスト: [technical-notes.md](../technical-notes.md) の「6.」
