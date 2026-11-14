---
paths:
  - "test/**"
---
# テスト(test/)

- 新しい回帰テストは既存の `test/helpers/mock-github-api.mjs`(インメモリの Git Data API モデル、fast-forward-only な ref 更新)を使う。
- テスト対象はコンパイル後の `js/store/...`(再実装ではなく実際のビルド成果物)。既存パターンに合わせる。
- `Could not save after 8 attempts: branch moved during save` のような外的要因が絡むエラーを、このモックだけで無理に再現しようとしない(単一操作や2インスタンス同時同期では再現しなかった)。
