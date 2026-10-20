# 10. CSP (meta) を追加し、XSS / 外部スクリプト改ざん時にトークンを持ち出せないようにする

## 背景

`https://note.gosyujin.com/` には複数の個人アプリ (scrapbox-tycoon / hateb-tycoon / feed-tycoon /
gyazo-tycoon-viewer / fog-tycoon-viewer) が **同一オリジン** で同居しており、`localStorage` を共有する。
このアプリは GitHub の fine-grained PAT (`scrapbox_tycoon_settings_v1`) を `localStorage` に持つので、
**同居アプリのどれか 1 つで XSS や外部スクリプトの改ざんが起きると、この PAT も読み取られる**
(= 非公開の notes リポジトリに書き込める)。

## 対策

`index.html` に CSP を meta で入れた (GitHub Pages はレスポンスヘッダを付けられないため meta)。

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; connect-src 'self' https://api.github.com;
manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'
```

- `script-src 'self'`: インライン script / `on*=` / `eval` / 他ホストの script は実行されない。
  このアプリは ES modules (`js/app.js`) だけで、インライン script はない。
- `connect-src`: 通信先は自サイトと GitHub API だけ。スクリプトが動いてしまってもトークンの送信先を持てない。
- `img-src https:`: Scrapbox 記法の外部画像 (Gyazo など任意の https 画像) を表示する仕様のため広く許可している。
  画像 URL にデータを載せる持ち出しは理論上残る。
- `style-src 'unsafe-inline'`: 互換性のため。

## 検証

- ローカルで配信し、画面が通常どおり描画されること、任意ドメインへの `fetch` とインライン script が遮断されることを確認。
- **未確認 (実機):** PAT での pull / push、スマホ PWA、Service Worker (`sw.js`) の登録。
  CSP は `worker-src 'self'` で SW 登録を許可しているが、この環境の Browser pane は SW 登録自体ができず確認できていない。

## 今後の注意

新しい外部通信 (別 API、外部フォント、CDN など) を足すときは **CSP の `connect-src` / `script-src` /
`font-src` などに追加しないと、ブラウザにブロックされて動かない** (コンソールに `Refused to ...` が出る)。
