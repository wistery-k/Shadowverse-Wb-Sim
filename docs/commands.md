# コマンドと引数の一覧

`package.json` の npm scripts が受け付ける引数のまとめ。引数は `npm run <名前> -- <引数>` のように `--` の後ろに書く
（`--` が無いと npm が自分の引数として受け取ってしまう）。各コマンドの本体は表の「本体」のファイルで、引数の扱いが変わったらこの表も直す。

## 共通

- **並列数**: `sim`・`compare`・`rhino-compare` 系・`yardstick`・`svwb` の対戦は CPU のコア数だけ並列に行う。環境変数 `THREADS` で変えられる
  （例: `THREADS=4 npm run sim`）。結果は並列数によらず同じ
- **決定的**: 試合はシードで決まるので、同じ引数なら同じ結果になる（AI・ルール・カードのデータが同じ限り）
- **最初のビルド**: `sim`・`game`・`sim-report`・`td` は WASM を、`svwb` 系（`compare`・`rhino-compare` 系・`yardstick`）は Rust の CLI を
  作ってから実行する。変更が無ければ作り直さないので 2 回目からは速い
- **デッキの名前**: 下の「デッキ」はデフォルトデッキ（`data/decks/*.txt`）のファイル名か、ファイルの中の「名前:」
  （AFネメシス・アマリアロイヤル・アミュレット疾走ビショップ・スペルウィッチ・ミッドレンジナイトメア・ランプドラゴン・リノセウスエルフ・疾走ドラゴン）。
  `compare`・`rhino-compare` 系・`yardstick` はランプドラゴンを除く 7 デッキを使う
- **AI の名前**（`sim`・`game`）: `search`（探索。今の既定）・`search-classic`（学習した補正なしの探索）・`yardstick`（物差しの相手）・
  `rhino`・`rhino-lethal`（リノセウス用）・`greedy`（貪欲法）・`greedy-base`（貪欲法・基準の重み）・`random`。一覧は `src/ai/registry.ts`

## 一覧

| コマンド | 何をするか | 本体 |
|---|---|---|
| `npm run dev` | 開発サーバー（Vite の引数をそのまま渡せる。例: `-- --host`） | `vite` |
| `npm run build` / `preview` / `typecheck` / `test` | 本番ビルド / ビルド結果の確認 / 型チェック / テスト（`test` は Vitest の引数を渡せる。例: `-- src/engine`） | |
| `npm run wasm` | エンジンの WASM を作る（引数なし） | `scripts/build-wasm.mjs` |
| `npm run cards` | `data/raw/*.json` からカードデータを作る（引数なし） | `scripts/convert-cards.ts` |
| `npm run rust-data` | Rust に埋め込むデータを書き出す（`[出力先] [AI データの出力先] [--quiet]`） | `scripts/rust-data-main.ts` |
| `npm run sim` | デフォルトデッキの総当たり（下） | `scripts/simulate-main.ts` |
| `npm run sim-report` | `sim --json` の結果を Markdown の表にする（下） | `scripts/sim-report-main.ts` |
| `npm run game` | 1 試合だけ打って行動の列を表示する（下） | `scripts/game-main.ts` |
| `npm run compare` | 探索 AI の設定 A と B の勝率（下） | `rust/engine/src/runner/compare.rs` |
| `npm run rhino-compare` 等 | デッキ 1 つと他の 6 デッキの勝率（下） | `rust/engine/src/runner/rhino_compare.rs` |
| `npm run deck-compare` | デッキのカードを入れ替えた案と元のデッキの勝率（下） | `rust/engine/src/runner/deck_compare.rs` |
| `npm run yardstick` | 固定した相手との勝率（強さの物差し。下） | `rust/engine/src/runner/yardstick.rs` |
| `npm run svwb` | Rust 版の CLI（下） | `rust/engine/src/main.rs` |
| `npm run td` | TD 学習のモデルの作成・学習・分析（下） | `scripts/td-main.ts` |

## sim

```sh
npm run sim -- [--games 20] [--seed 1] [--agents greedy] [--decks all] [--mirror] [--deck-agent <デッキ>=<AI>] [--json 結果.json] [--shard i/n]
```

| 引数 | 既定 | 意味 |
|---|---|---|
| `--games N` | 20 | 1 組（参加者 2 人の組み合わせ）あたりの試合数 |
| `--seed S` | 1 | 試合のシードの基準 |
| `--agents a,b,…` | `greedy` | 使う AI（カンマ区切り）。2 つ以上なら「デッキ × AI」が参加者になり、名前は `デッキ(AI)` |
| `--decks all` か `d1,d2,…` | `all` | 使うデッキ（`all` は 8 デッキ全部） |
| `--mirror` | なし | 同じ参加者どうしの試合も行う |
| `--deck-agent デッキ=AI` | なし | そのデッキだけ AI を変える（何回でも書ける。`--agents` が 1 つのときだけ） |
| `--json ファイル` | なし | 全試合の記録と集計を JSON に書き出す（`sim-report` に渡せる） |
| `--shard i/n` | `0/1` | 全試合を n 個に分けた i 番目（0 始まり）だけ行う（CI で並列に回す用） |

試合数は「参加者の組の数 × `--games`」。8 デッキ・AI 1 つなら 28 組なので、`--games 50` で 1400 試合。

例: `npm run sim -- --games 50 --agents search --deck-agent リノセウスエルフ=rhino`

## sim-report

```sh
npm run sim-report -- 結果.json [結果2.json …]
```

`sim --json` の出力（`--shard` で分けたものはまとめて渡す）を Markdown の表にして標準出力に出す。参加者・試合数・seed が同じファイルどうししか混ぜられない。

## game

```sh
npm run game -- --seed S --p0 AI --p0-deck デッキ --p1 AI --p1-deck デッキ [--quiet] [--json 出力.json]
```

| 引数 | 意味 |
|---|---|
| `--seed S` | 試合のシード（必須、整数） |
| `--p0` / `--p1` | 席 0（表示は P1）と席 1（P2）の AI（必須）。先攻はシードで決まる |
| `--p0-deck` / `--p1-deck` | デッキ（必須）。デフォルトデッキの名前か、`ID*枚数,ID*枚数,…` のカードIDの列 |
| `--quiet` | 行動の列を表示せず、結果だけ出す |
| `--json ファイル` | シード・AI・デッキ・勝者・行動の列を書き出す |

リプレイ画面の「再現に必要な情報」に、この形のコマンドが出る。

## compare

```sh
npm run compare -- [試合数 28] ['<A の設定>' '{}'] ['<B の設定>' '{}'] [最初の試合番号 0] [B のデッキ]
```

引数は名前なしで、この順に書く。1 試合番号ごとに席とデッキを入れ替えて 2 試合打つので、試合数 105 なら 210 試合。
A の勝率と、A のデッキごとの勝率を出す。5 番目にデッキ名を書くと、B がそのデッキの試合だけ行う。設定の JSON は下の「探索 AI の設定」。

例: `npm run compare -- 105 '{}' '{"lethal":false}'`

## rhino-compare（af-compare・spellwitch-compare・bishop-compare・dragon-compare・nightmare-compare・royal-compare）

```sh
npm run rhino-compare -- [--subject rhino] [--games 50] [--start 0] [--agent …] [--opts '<設定>'] [--out 結果.jsonl] [--matches 試合.jsonl]
```

| 引数 | 既定 | 意味 |
|---|---|---|
| `--subject` | `rhino` | 比べるデッキ: `rhino`（リノセウスエルフ）・`af`（AFネメシス）・`spellwitch`・`bishop`（アミュレット疾走ビショップ）・`dragon`（疾走ドラゴン）・`nightmare`（ミッドレンジナイトメア）・`royal`（アマリアロイヤル）。`af-compare` 等はこれを付けた別名 |
| `--games N` | 50 | 相手デッキ 1 つ・席 1 つあたりの試合数（全部で N × 6 デッキ × 2 席） |
| `--start S` | 0 | 最初の試合番号 |
| `--agent` | rhino は `rhino`、他は `search` | 比べるデッキの AI: `rhino`・`rhino-lethal`・`search`・`search-classic`。相手は `search-classic` |
| `--opts JSON` | `{}` | 比べるデッキの AI の設定（`search-classic` では使わない）。下の「探索 AI の設定」に加え、リノセウス用 AI の `"potential"`（数）と `"holds"`（`{"mystery":…, "rhino":…, "extraPp":…}`） |
| `--out ファイル` | なし | 試合ごとの結果を JSON Lines で書き出す |
| `--matches ファイル` | なし | 「人間との比較」タブで保存した試合（JSON Lines）と同じ試合だけ打ち、人間の勝敗と並べる |

## deck-compare

```sh
npm run deck-compare -- --deck <デッキ> [--variant '<変更>']… [--add <カード>[,<カード>…]] [--games 50] [--start 0] [--out 結果.jsonl]
```

デッキのカードを入れ替えた案を、元のデッキと同じ試合で比べる（デッキの最適化）。元のデッキと各案は、比較用の 7 デッキのうち自分以外と両方の席で打つ。
AI はどちらの側も今の既定（リノセウスエルフはリノセウス用 AI、他は探索 AI）。

| 引数 | 既定 | 意味 |
|---|---|---|
| `--deck` | 必須 | 比べるデッキ（デフォルトデッキの名前かファイル名） |
| `--variant` | なし | 案。「カード名-枚数」「カード名+枚数」をカンマで並べる（例: `'知恵の輝き-1,最果ての罪・サタン+1'`。カード ID も可）。抜く枚数と足す枚数は同じにする。何回でも書ける |
| `--add カード` | なし | デッキの各カードについて「そのカードを 1 枚抜いて、このカードを 1 枚足す」案をすべて作る |
| `--games N` | 50 | 相手デッキ 1 つ・席 1 つあたりの試合数（1 案あたり N × 6 デッキ × 2 席） |
| `--start S` | 0 | 最初の試合番号（シードは 2000000 + 13 × 試合番号 + 席。案どうしで同じ） |
| `--out ファイル` | なし | 試合ごとの結果（案・相手・試合番号・席・勝ち）を JSON Lines で書き出す |

- 抜いたカードの位置に足したカードを置くので、同じシードなら山札の並びは入れ替えたカードの所だけが違う。それでも 1 枚の入れ替えで 4 割ほどの試合の勝敗が入れ替わる
  （AI が自分の山札・相手の手札を並べ直して読むので、引く前から手が変わる）。1 案 2400 試合（`--games 200`）で差の標準誤差は 1.3 ポイントほど
- 学習した補正は比較用の 7 デッキのカードしか学んでいないので、それ以外のカードは手で作った評価だけで打つ

## yardstick

```sh
npm run yardstick -- [--opts '<設定>'] [--games 1000] [--start 0] [--label 名前] [--record]
npm run yardstick -- fingerprint
```

固定した相手（凍結した探索 AI）との勝率。試合の組み方は `compare` と同じで、`--games 1000` で 2000 試合。
`--record` で `docs/yardstick.md` の表に 1 行足す（`--label` が要る）。`fingerprint` は相手が変わっていないかの確認用。

## svwb（Rust 版の CLI）

```sh
npm run svwb -- golden [write] [組…]                     # ゴールデンテスト（write で保存し直す）
npm run svwb -- dump <試合> <手番> [--random-decks] [--json]  # ランダムな試合のその手番の局面
npm run svwb -- bench [試合数 2000]                       # 速さの計測
npm run svwb -- ai-play [試合数 14] [最初の試合 0] [search|rhino|rhino-lethal]  # AI どうしの試合の時間を測る
npm run svwb -- compare …                               # npm run compare と同じ
npm run svwb -- rhino-compare …                         # npm run rhino-compare と同じ
npm run svwb -- yardstick …                             # npm run yardstick と同じ
npm run svwb -- mulligan-compare [--games 50] [--start 0] [--seed 1] [--a '{"mulligan":"sample"}'] [--b '{}']
npm run svwb -- td selfplay --model m.json --out d.jsonl [--games 100] [--start 0] [--eps 0.1] [--opp greedy|beam]
                [--sampling classic|default] [--iv 0] [--ivZone hand|board|both] [--cmp 0] [--rollouts 8]
```

- `mulligan-compare`: マリガンの設定 A と B を同じシードの試合で打ち比べる（7 デッキ × 相手 6 デッキ × 席 2 × `--games`）。相手は今の探索 AI
- `td selfplay`: TD 学習の自己対戦。各引数の意味は `rust/engine/src/runner/td.rs` の先頭

## td

```sh
npm run td -- init --out m0.json [--hidden 32] [--seed 1] [--a 0.08] [--base stripped|current] [--inputs v2|v1]
npm run td -- extend --model data/value-net.json --out m0.json
npm run td -- widen --model m.json --hidden 256,32 --out w0.json [--seed 1]
npm run td -- train --model m0.json --data d0.jsonl[,d1.jsonl] --out m1.json [--lambda 0.7] [--epochs 2] [--lr 0.001] [--l2 0.0001]
                [--batch 128] [--holdout 0.1] [--fitA 1] [--seed 1] [--ivWeight 1] [--v1Only 0] [--best 0] [--cmpWeight 0] [--cmpBatch 16]
npm run td -- ivcheck --model m1.json --data d0.jsonl[,d1.jsonl] [--holdout 0]
npm run td -- prune --model m4.json --data d0.jsonl,d1.jsonl,… --out data/value-net.json
npm run td -- probe --model m1.json --data d0.jsonl [--per 2000]
```

自己対戦（`selfplay`）は Rust 版（`npm run svwb -- td selfplay`）で行う。各引数の意味は `scripts/td-main.ts` の先頭。

## 探索 AI の設定（compare の A・B、rhino-compare・yardstick の `--opts`）

JSON のオブジェクトで渡す。`{}` は今の探索 AI の既定。知らない項目はエラーになる。項目の意味は `rust/engine/src/ai/search.rs` の `SearchOptions`。

- 数: `samples`・`beamWidth`・`maxDepth`・`rescoreTop`・`planCandidates`・`perFirst`・`oppHandSamples`・`dangerRescore`・`mulliganSamples`・`nextLethal`・`beamPp`
- 真偽: `lethal`・`mulliganStatic`・`mulliganNet`・`dedup`・`sameHandOnce`・`chain`・`chainFuse`・`settleTrades`・`dominance`・`reusePlan`・
  `peekOppHand`・`oppFuse`・`oppHandCommon`・`reuseAgree`・`resampleDraws`・`drawFirst`
- `scoreTurnEnd`: `"none"`・`"terminal"`・`"all"`
- `mulligan`: `"model"`（既定）・`"weights"`・`"cost"`・`"sample"`
- `opponentSearch`: `null`（相手のターンを読まない）か `{"beamWidth": …, "maxDepth": …, "extraEval": true|false}`
- `weights`: `"default"`（基準の重み）か、変えたい項目だけのオブジェクト（`"holdScale"` で hold を何倍にするか）
- `valueNet`: 学習した補正のファイル名か `false`（補正なし）

例: `'{"lethal":false,"beamWidth":16,"weights":{"myHand":0.8}}'`
