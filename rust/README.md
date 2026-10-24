# Rust 版エンジン・AI

対戦シミュレータのルールエンジンと AI。ブラウザでは WASM にして使い、自己対戦・勝率の比較は CLI（`svwb`）で行う。
もとは TypeScript で書いたもの（`src/engine`・`src/ai`）を自己対戦の高速化のために移した
（段階 1: エンジン、段階 2: 探索 AI とリノセウス用 AI、段階 3: 実験のランナー、段階 4: ブラウザも WASM にして TypeScript 版を消す。
計画はプロジェクトのメモ `notes/speedup-port.md`）。TypeScript 版は main の d0dd121 までにある。
コードのコメントの「TypeScript 版」はその版を指す（処理の順番などをその版に合わせてあることの説明）。

カードの能力は TypeScript の定義（`src/cards/abilities`）を JSON に書き出して読む。AI の重み・学習した補正のモデル等も同じく書き出して読む。

## 準備

Rust（cargo）と、WASM 向けのターゲットが要る。

```sh
rustup target add wasm32-unknown-unknown
```

`npm run rust-data` でカード・能力のデータを `rust/engine/data/engine-data.json` に、AI の重み等を `ai-data.json` に書き出す
（コミットしない）。`npm run wasm`・`npm test`・`npm run dev`・`npm run build`・`npm run svwb` は自動で書き出してからビルドする。
`cargo build` だけでは書き出さないので、`rust/target/release/svwb` を直に使うときは先に `npm run rust-data` する。
書き出すときに元のファイル（`data/`・`src/cards/`・`src/engine/` の `.ts`・`src/ai/data.ts`）の中身の指紋を `sources.txt` に書き、
`engine/build.rs` がビルドのときに確かめる。書き出した後に元のファイルが変わっていれば（`git pull` で補正が変わった等）、
ビルドは「埋め込むデータが古くなっています」で止まる（古い補正のまま動かさないため）。

## WASM（ブラウザ・Node）

`npm run wasm`（`scripts/build-wasm.mjs`）が `rust/wasm` を `wasm32-unknown-unknown` 向けにビルドし、`src/engine/svwb.wasm` に置く
（コミットしない。`npm test`・`npm run dev`・`npm run build` の前に自動で行う）。
`src/engine/wasm.ts` が読み込み、`src/engine/game.ts`（エンジン）・`src/ai/registry.ts`（AI）の関数として呼ぶ。
wasm-bindgen は使わず、要求と結果を JSON の文字列で受け渡す（局面・行動の形は `src/engine/types.ts`、変換は `engine/src/state_json.rs`）。

## テスト

```sh
cd rust && cargo test --release --workspace    # AI の単体テスト（engine/src/ai/tests）とゴールデンテスト（engine/tests/golden.rs）
cargo fmt --check && cargo clippy --release --workspace --all-targets -- -D warnings
```

ゴールデンテストは、決まった組み合わせ・シードの試合（ランダムな手の試合と AI どうしの試合）を打ち、
結果を `engine/tests/golden/*.txt` に保存したものと比べる（`engine/src/golden.rs`）。TypeScript 版を消す前に、
TypeScript 版と同じ結果になることを確かめてから保存した。ルール・カード能力・AI を意図して変えたときは保存し直し、
変わった試合を確かめてからコミットする。

```sh
npm run svwb -- golden                 # 保存したものと比べる（組の名前を並べるとその組だけ）
npm run svwb -- golden write           # 保存し直す
```

## CLI（svwb）

`npm run svwb -- <サブコマンド> …`（`scripts/svwb.mjs`）は、データを書き出して `cargo build --release` してから
`rust/target/release/svwb` を実行する。

```sh
npm run svwb -- dump 12 34 [--random-decks] [--json]   # ランダムな試合 12 の手番 34 の正規化した文字列（--json なら局面の JSON）
npm run svwb -- bench 2000                              # 速さの計測
npm run svwb -- ai-play 14 0 search                     # AI どうしの試合の時間を測る（試合数・最初の試合・AI の種類 search|rhino|rhino-lethal）
```

### 実験のランナー

試合は CPU のコア数だけのスレッドで並列に行う（環境変数 `THREADS` で変えられる。並列数によらず同じ結果）。

```sh
npm run compare -- 105 '{}' '{"lethal":false}'                          # 探索 AI の設定どうしの勝率（組の 2 試合は同じシードの鏡。--no-mirror で前の試合）
npm run rhino-compare -- --games 50 --opts '{"nextLethal":10}' --out r.jsonl
npm run af-compare -- --games 50                                         # rhino-compare --subject af
npm run deck-compare -- --deck スペルウィッチ --variant '知恵の輝き-1,最果ての罪・サタン+1'  # デッキのカードを入れ替えた案を元のデッキと比べる
npm run meta -- round --state 環境.json --report 記録.md  # 環境（デッキと使用率）のアジャスト合戦を 1 回り回す（init・export・show も。docs/commands.md）
npm run svwb -- mulligan-compare --games 50 --a '{"mulligan":"sample"}'  # マリガンの設定どうしを同じシードの試合で打ち比べる（相手は今の探索 AI）
npm run svwb -- human-plan-value --out d.jsonl --m 32 <人間の記録.jsonl>...  # 人間の手順と AI の手順を同じ局面から打ち比べる（集計は human-plan-value report d.jsonl）
npm run svwb -- td selfplay --model m0.json --games 2000 --out d0.jsonl  # TD 学習の自己対戦（試合が終わった順に書く。--opp beam・--iv k・--sampling default は td.rs の先頭の説明）
npm run yardstick -- --opts '{}' --games 1000 --label 名前 --record    # 固定した相手との勝率を docs/yardstick.md の表に足す（強さの物差し。--ref strong で強い相手）
```

- 設定の JSON は `"valueNet"` に学習した補正のファイル、`"weights"` のオブジェクト・`"default"`・`"holdScale"`、
  リノセウス用 AI の `"potential"` 等を受け付ける。TypeScript 版とともに消した実験用の項目（序盤のターンを全探索する
  `"exhaustive"` 等）はエラーになる（既定の値なら受け付ける）。知らない項目もエラーにする
- rhino-compare の `--agent` は rhino・rhino-lethal・search・search-classic。相手は `--opp`（既定は search-classic、`search` なら今の既定の探索 AI）
- マリガンの設定 `"mulligan"` は model（既定）・weights・cost・sample（返し方 16 通りごとに引き直しを `"mulliganSamples"` 回（既定 100）試し、評価関数の平均で選ぶ）
- td の init・extend・train・probe・prune は `npm run td -- …`（`scripts/td-main.ts`）で行い、td selfplay の書き出したファイルをそのまま渡せる

## 構成

- `engine/src/data.rs`: カード・能力の DSL の型と読み込み（`src/engine/dsl.ts` と同じ形）。カードID・スロット名等は読み込み時に整数にする
- `engine/src/state.rs`: 状態の型と基本操作。複製は `Clone`
- `engine/src/state_json.rs`: 局面・行動を TypeScript の型（`src/engine/types.ts`）の形の JSON で書き出し・読み込む
- `engine/src/effects.rs`: 能力の解釈と解決スタック
- `engine/src/game.rs`: 対戦の生成・合法手・行動の適用
- `engine/src/golden.rs`・`canonical.rs`・`sim.rs`・`main.rs`: ゴールデンテスト・計測・CLI
- `engine/src/runner/`: 実験のランナー（compare・rhino-compare・deck-compare・meta・mulligan-compare・td selfplay・yardstick・human-plan-value）。`parallel.rs`（並列実行）、`options.rs`（設定の JSON）、
  `json.rs`（項目の順番を保つ JSON）、`jsnum.rs`（JavaScript の `Number#toString`・`toPrecision`・`toFixed` と同じ数の書き方）
- `engine/src/ai/`: AI。`registry.rs`（選べる AI の一覧）、`search.rs`（ターン単位のビームサーチ・相手のターンの読み）、`eval.rs`（評価関数）、
  `valuenet.rs`（学習した補正の推論）、`lethal.rs`（リーサル探索）、`lethal_hint.rs`（対戦画面の「リーサル」表示）、`determinize.rs`、
  `keys.rs`（同じ局面の判定）、`greedy.rs`・`converging.rs`・`mulligan.rs`、リノセウス用 AI の `rhino.rs`・`rhino_lethal.rs`・`exact_lethal.rs`。
  AI のデータ（重み・マリガンのモデル・学習した補正の重み等）は `aidata.rs` が `ai-data.json` から読む。テストは `tests/`
- `wasm/src/lib.rs`: ブラウザ・Node から呼ぶ入口（`alloc`・`call`・`out_ptr`・`out_len`）
