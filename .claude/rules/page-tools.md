---
paths:
  - "src/pins.ts"
  - "src/app.ts"
---
# ページツールバー・pin・複製(app.ts の pageToolsHtml / wirePageTools、src/pins.ts)

経緯: [decisions/15](../../docs/decisions/15-page-menu-pin-duplicate.md)

- pin は端末ローカル(localStorage)で **Page レコードに入れない**(入れると同期層の no-op 判定・pull の内容同一判定・3-way マージ・push CAS の全部に手が入る)。
- ツールバーのボタンは `mousedown` を `preventDefault` して、エディタを blur(= commit)させない。
