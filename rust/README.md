# Rust 版エンジン

TypeScript 版のエンジン（`src/engine`）と探索 AI（`src/ai`）を Rust に移したもの。自己対戦の高速化のため
（段階 1: エンジン、段階 2: 探索 AI とリノセウス用 AI、段階 3: 実験のランナー。計画はプロジェクトのメモ `notes/speedup-port.md`）。
同じシード＋同じ行動列で TypeScript 版と同じ結果になり、AI は同じ局面・同じ乱数で TypeScript 版と同じ手を選ぶ。
カードの能力は書き直さず、TypeScript の定義（`src/cards/abilities`）を JSON に書き出して読む。AI の重み・学習した補正のモデル等も同じく書き出して読む。

## 使い方

```sh
npm run rust-data                      # カード・能力のデータを rust/engine/data/engine-data.json に、AI の重み等を ai-data.json に書き出す（ビルド前に必要。コミットしない）
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

# AI の差分テスト: TypeScript 版で AI どうしの試合を打ち、1 試合 1 行で行動の列を書き出して、Rust 版で同じ試合を打って突き合わせる
npm run rust-ai-diff -- expect --games 14 --out expected-ai.txt                 # 探索 AI どうし（npm run bench と同じ組み合わせ）
rust/target/release/svwb ai-diff expected-ai.txt
# リノセウス用 AI（片方の席をリノセウスエルフにする）。--probe はエルフの手番ごとに、相手の体力を上限の式の値にした局面で
# リーサル探索（全探索を含む）も行って結果を比べる（ふつうの試合では全探索がほとんど動かないため）
npm run rust-ai-diff -- expect --games 6 --agent rhino --probe --out expected-rhino.txt
rust/target/release/svwb ai-diff expected-rhino.txt
# AI どうしの試合の時間を測る（試合数・最初の試合・AI の種類 search|rhino|rhino-lethal）
rust/target/release/svwb ai-play 14 0 search
```

### 実験のランナー（段階 3）

TypeScript 版の `npm run compare`・`npm run rhino-compare`（`af-compare` 等の `--subject` も）・`npm run td -- selfplay` と
同じ引数で、同じ試合を打って同じ出力を出す（試合ごとの結果・勝率・書き出す JSON Lines まで同じ。秒数だけ違う）。7〜10 倍速い。
書き出したファイルは、そのまま TypeScript 版の集計や `npm run td -- train` に渡せる。
試合は CPU のコア数だけのスレッドで並列に行う（環境変数 `THREADS` で変えられる。並列数によらず同じ結果）。

```sh
rust/target/release/svwb compare 105 '{}' '{"lethal":false}'                         # npm run compare -- 105 '{}' '{"lethal":false}'
rust/target/release/svwb rhino-compare --games 50 --opts '{"nextLethal":10}' --out r.jsonl  # npm run rhino-compare -- …
rust/target/release/svwb rhino-compare --subject af --games 50                         # npm run af-compare -- --games 50
rust/target/release/svwb td selfplay --model m0.json --games 2000 --out d0.jsonl      # npm run td -- selfplay …（試合が終わった順に書く）
```

- 設定の JSON は TypeScript 版と同じ項目を受け付ける（`"valueNet"` に学習した補正のファイル、`"weights"` のオブジェクト・`"default"`・`"holdScale"`、
  リノセウス用 AI の `"potential"`・`"holds"` 等）。序盤のターンを全探索する `"exhaustive"` 等、TypeScript 版だけにある実験用の項目は
  エラーになる（既定の値なら受け付ける）。知らない項目もエラーにする
- rhino-compare の `--agent` は rhino・rhino-lethal・search・search-classic
- td は selfplay だけ（init・train・probe・prune は `npm run td -- …` で行う）

カードの能力やエンジンを TypeScript 側で変えたら、`npm run rust-data` で書き出し直し、差分テストを通すこと（CI でも行う）。
エンジンの処理を変えるときは Rust 側も同じ順番（乱数を引く順を含む）で変える。
AI を変えるときも Rust 側を同じに変え、AI の差分テストを通す。AI は浮動小数の足し算の順番、Map の挿入順、安定な並べ替え、
厳密な `>` の比較、`JSON.stringify` での同一判定の細かさ（何を同じと見なすか）まで TypeScript 版に合わせている。

## 構成

- `engine/src/data.rs`: カード・能力の DSL の型と読み込み（`src/engine/dsl.ts`）。カードID・スロット名等は読み込み時に整数にする
- `engine/src/state.rs`: 状態の型と基本操作（`types.ts`・`state.ts`・`rng.ts`）。複製は `Clone`
- `engine/src/effects.rs`: 能力の解釈と解決スタック（`effects.ts`）
- `engine/src/game.rs`: 対戦の生成・合法手・行動の適用（`game.ts`）
- `engine/src/canonical.rs`・`sim.rs`・`main.rs`: 差分テストと計測
- `engine/src/runner/`: 実験のランナー（`scripts/` の compare・rhino-compare・td selfplay）。`parallel.rs`（並列実行）、`options.rs`（設定の JSON）、
  `json.rs`（項目の順番を保つ JSON。`JSON.stringify` と同じ並びで表示する）、`jsnum.rs`（`Number#toString`・`toPrecision`・`toFixed` と同じ数の書き方）
- `engine/src/ai/`: 探索 AI（`src/ai`）。`search.rs`（ターン単位のビームサーチ・相手のターンの読み）、`eval.rs`（評価関数）、
  `valuenet.rs`（学習した補正の推論）、`lethal.rs`（リーサル探索）、`determinize.rs`、`keys.rs`（同じ局面の判定）、
  `greedy.rs`・`converging.rs`・`mulligan.rs`、リノセウス用 AI の `rhino.rs`・`rhino_lethal.rs`・`exact_lethal.rs`。
  AI のデータ（重み・マリガンのモデル・学習した補正の重み等）は `aidata.rs` が `ai-data.json` から読む
