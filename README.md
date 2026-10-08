# scrapbox-tycoon

Scrapbox 風のローカルファースト・ノートアプリ。編集内容はまず `LocalStore`
(localStorage) に即書き込まれ、`GitHubSyncStore` がバックグラウンドで
GitHub リポジトリ (`gosyujin/scrapbox-tycoon-notes`) にまとめてコミットする。
本体は `https://note.gosyujin.com/scrapbox-tycoon/` (GitHub Pages) にデプロイ。

## 機能

- Scrapbox 記法のページ編集 (テキストエリアベースのエディタ)、ページ一覧のカード表示
- ローカルファースト保存 (localStorage) と GitHub へのバックグラウンド同期
- 同期ステータス履歴のコピー (デバッグ用)
- 同期競合の退避 (「(sync conflict)」ページ) と競合バナー・行単位 diff
- 実 Scrapbox プロジェクトの export JSON を参照専用で読み込み

## ドキュメント

- [docs/features.md](docs/features.md) — 機能の詳細
- [docs/architecture.md](docs/architecture.md) — 構成・コンポーネント
- [docs/technical-notes.md](docs/technical-notes.md) — 技術的な注意点・変更禁止の不変条件
- [docs/troubleshooting.md](docs/troubleshooting.md) — 復旧手順
- [docs/decisions/](docs/decisions/) — 調査・意思決定の経緯
- [CHANGELOG.md](CHANGELOG.md) — 変更履歴

## セットアップ・使い方

```bash
npm run build   # tsc + build-info 埋め込み + import のキャッシュバスティング
npm run dev     # build して簡易サーバーを起動
npm test        # build してから test/*.test.mjs を実行
```
