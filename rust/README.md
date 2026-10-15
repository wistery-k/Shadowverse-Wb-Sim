# Rust 版エンジン

TypeScript 版のエンジン（`src/engine`）を Rust に移したもの。自己対戦の高速化のため（段階 1: エンジンだけを移して速さを測る）。
同じシード＋同じ行動列で TypeScript 版と同じ結果になる。カードの能力は書き直さず、TypeScript の定義（`src/cards/abilities`）を JSON に書き出して読む。

## 使い方

```sh
npm run rust-data                      # カード・能力のデータを rust/engine/data/engine-data.json に書き出す（ビルド前に必要。コミットしない）
cd rust && cargo build --release       # rust/target/release/svwb ができる

# 差分テスト: TypeScript 版でランダムな対戦を打ち、手番ごとの「局面＋合法手＋ターン終了時の処理」のハッシュを書き出して、Rust 版で突き合わせる
npm run rust-diff -- expect --games 1000 --out expected.txt
rust/target/release/svwb diff expected.txt
# --random-decks: クラスのカードからランダムに組んだデッキで打つ（デフォルトデッキに無いカードの能力も試す）
npm run rust-diff -- expect --games 1000 --random-decks --out expected-random.txt
rust/target/release/svwb diff expected-random.txt
# 食い違ったら、その手番の正規化した文字列を両方で出して見比べる
npm run rust-diff -- dump --game 12 --step 34
rust/target/release/svwb dump 12 34

# 速さの比較
npm run rust-diff -- bench --games 2000
rust/target/release/svwb bench 2000
```

カードの能力やエンジンを TypeScript 側で変えたら、`npm run rust-data` で書き出し直し、差分テストを通すこと（CI でも行う）。
エンジンの処理を変えるときは Rust 側も同じ順番（乱数を引く順を含む）で変える。

## 構成

- `engine/src/data.rs`: カード・能力の DSL の型と読み込み（`src/engine/dsl.ts`）。カードID・スロット名等は読み込み時に整数にする
- `engine/src/state.rs`: 状態の型と基本操作（`types.ts`・`state.ts`・`rng.ts`）。複製は `Clone`
- `engine/src/effects.rs`: 能力の解釈と解決スタック（`effects.ts`）
- `engine/src/game.rs`: 対戦の生成・合法手・行動の適用（`game.ts`）
- `engine/src/canonical.rs`・`sim.rs`・`main.rs`: 差分テストと計測
