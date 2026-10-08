# 7. 2台で同じページを編集すると片方の更新が無言で消える問題

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

修正の詳細と回帰テスト: [technical-notes.md](../technical-notes.md) の「7.」 / 復旧手順: [troubleshooting.md](../troubleshooting.md)
