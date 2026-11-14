# td train・td prune の照らし合わせ（TypeScript 版と Rust 版）

補正の学習の TypeScript 版（`scripts/td-main.ts` の train・prune）と Rust 版（`svwb td train`・`prune`、`rust/engine/src/runner/td_train.rs`）が、
同じデータ・同じ引数で同じモデルのファイル（バイトまで）を書くことを、両方のテストで確かめる（`tests/tdRust.test.ts` と、`td_train.rs` の `fixtures_match_typescript`）。
docs/ai-notes.md「補正の学習を Rust に移す」。

- `data.jsonl`: `svwb td selfplay --model <入力を足した補正> --games 30 --start 7000000 --eps 0.1 --iv 1 --ivRes 1 --ivZone both --sDefault 1 --imagined 1 --searchValue 1` の
  最初の 6 試合（g7000001〜7000008）と、その介入の試合。入力を小さな並び（1 行目の `tdLayout`。3 ゾーン × 12 枚・数値 6 個）に読み替え、場のカードの属性 `"b"` を外し、S は 0.1、探索の値は 0.001 に丸めた
- `model.json`: 小さな補正（語彙はファイルの並びの 10 枚を逆の順に、数値の入力は 5 個。隠れ層 4・3。重みは乱数）。読み込みが並びを読み替える所も通る
- `cases.json`: 引数（ファイルの名前はこのフォルダから）。`train-*.json`・`prune-*.json` は TypeScript 版が書いたもの

学習の作りを変えて出力が変わるときは、両方の版を同じに直してから、TypeScript 版で書き直す（`npm run td -- train <cases.json の引数> --out <name>.json`。ファイルの名前はこのフォルダから）。
