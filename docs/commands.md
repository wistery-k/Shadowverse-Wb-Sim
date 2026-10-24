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
| `npm run meta` | 環境（デッキと使用率）のアジャスト合戦を 1 回りずつ回す（下） | `rust/engine/src/runner/meta.rs` |
| `npm run yardstick` | 固定した相手との勝率（強さの物差し。下） | `rust/engine/src/runner/yardstick.rs` |
| `npm run svwb` | Rust 版の CLI（下） | `rust/engine/src/main.rs` |
| `npm run td` | TD 学習のモデルの作成・学習・分析（下） | `scripts/td-main.ts` |
| `npm run pack-run` | PC で回した 1 回分の出力（自己対戦・モデル・ログ）を、共有フォルダに上げる `.tar.gz` にまとめる（下） | `scripts/pack-run-main.ts` |

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
npm run rhino-compare -- [--subject rhino] [--games 50] [--start 0] [--agent …] [--opts '<設定>'] [--opp search-classic|search] [--out 結果.jsonl] [--matches 試合.jsonl]
```

| 引数 | 既定 | 意味 |
|---|---|---|
| `--subject` | `rhino` | 比べるデッキ: `rhino`（リノセウスエルフ）・`af`（AFネメシス）・`spellwitch`・`bishop`（アミュレット疾走ビショップ）・`dragon`（疾走ドラゴン）・`nightmare`（ミッドレンジナイトメア）・`royal`（アマリアロイヤル）。`af-compare` 等はこれを付けた別名 |
| `--games N` | 50 | 相手デッキ 1 つ・席 1 つあたりの試合数（全部で N × 6 デッキ × 2 席） |
| `--start S` | 0 | 最初の試合番号 |
| `--agent` | rhino は `rhino`、他は `search` | 比べるデッキの AI: `rhino`・`rhino-lethal`・`search`・`search-classic` |
| `--opp` | `search-classic` | 相手の AI: `search-classic`（物差しと同じ手を指す）・`search`（今の既定の探索 AI） |
| `--opts JSON` | `{}` | 比べるデッキの AI の設定（`search-classic` では使わない）。下の「探索 AI の設定」に加え、リノセウス用 AI の `"potential"`（数）と `"holds"`（`{"mystery":…, "rhino":…, "extraPp":…}`） |
| `--out ファイル` | なし | 試合ごとの結果を JSON Lines で書き出す |
| `--matches ファイル` | なし | 「人間との比較」タブで保存した試合（JSON Lines）と同じ試合だけ打ち、人間の勝敗と並べる。人間の相手が `--opp` と同じ試合だけを使う（`search-classic` なら相手が物差しの試合、`search` なら最新版の試合） |

## deck-compare

```sh
npm run deck-compare -- --deck <デッキ> [--variant '<変更>']… [--add <カード>[,<カード>…]] [--file <デッキ>]…
                        [--vs <デッキ>[,<デッキ>…]] [--net <補正.json>] [--netSide both|subject] [--games 50] [--start 0] [--out 結果.jsonl]
npm run deck-compare -- --deck リノセウスエルフ --variant '舞い踊る妖精-2,言の葉のエルダーウィードマン+2' --vs アマリアロイヤル --games 100
npm run deck-compare -- --deck スペルウィッチ --file my-witch.txt --file ミッドレンジナイトメア --vs アマリアロイヤル  # デッキを丸ごと比べる
```

デッキのカードを入れ替えた案を、元のデッキと同じ試合で比べる（デッキの最適化）。元のデッキと各案は、比較用の 7 デッキのうち自分以外と両方の席で打つ（`--vs` で相手を絞れる）。
AI はどちらの側も今の既定（リノセウスエルフはリノセウス用 AI、他は探索 AI）。
マリガンの学習したモデルはデッキのカードの並びで引くので、案のデッキも元のデッキのモデルでマリガンする（足したカードは役割なし・係数 0）。
ファイルから読んだデッキ（とその案）は元にするモデルが無いので、返し方ごとに引き直しを試して選ぶ（`mulligan: "sample"`。今のモデルとの差は −0.5% ほど）。

| 引数 | 既定 | 意味 |
|---|---|---|
| `--deck` | 必須 | 比べるデッキ（デフォルトデッキの名前か `data/decks` のファイル名（拡張子なし）。どちらでもなければ、デッキのテキストファイル（`data/decks/*.txt` と同じ形式）のパス） |
| `--variant` | なし | 案。「カード名-枚数」「カード名+枚数」をカンマで並べる（例: `'知恵の輝き-1,最果ての罪・サタン+1'`。カード ID も可）。抜く枚数と足す枚数は同じにする。何回でも書ける |
| `--add カード` | なし | デッキの各カードについて「そのカードを 1 枚抜いて、このカードを 1 枚足す」案をすべて作る |
| `--file デッキ` | なし | デッキを丸ごと案にする（`--deck` と同じくデフォルトデッキかテキストファイル。元のデッキと違うクラスでもよい。山札の並びの対応は無い）。何回でも書ける |
| `--vs デッキ,…` | 比較用の 7 デッキのうち自分以外 | 相手のデッキ（デフォルトデッキならどれでも。元のデッキと同じデッキ・ランプドラゴンも可） |
| `--net ファイル` | なし | 両方の席の学習した補正を、このファイルのものに替える（学び直した補正で比べ直す用。リノセウス用 AI も。`baseWeights` の無いモデルだけ） |
| `--netSide subject` | `both` | `--net` の補正に替えるのを比べるデッキ（元のデッキと案）の側だけにする。相手は今の既定のまま |
| `--games N` | 50 | 相手デッキ 1 つ・席 1 つあたりの試合数（1 案あたり N × 相手のデッキの数 × 2 席） |
| `--start S` | 0 | 最初の試合番号（シードは 2000000 + 13 × 試合番号 + 席。案どうしで同じ） |
| `--out ファイル` | なし | 試合ごとの結果（案・相手・試合番号・席・勝ち）を JSON Lines で書き出す |

- 抜いたカードの位置に足したカードを置くので、同じシードなら山札の並びは入れ替えたカードの所だけが違う。それでも 1 枚の入れ替えで 2〜3 割の試合の勝敗が入れ替わる
  （AI が自分の山札・相手の手札を並べ直して読むので、引く前から手が変わる）。1 案 2400 試合（`--games 200`）で差の標準誤差は 1 ポイントほど
- 学習した補正は比較用の 7 デッキのカードしか学んでいないので、それ以外のカードは手で作った評価だけで打つ。
  そのカードの入ったデッキを `td selfplay --decks` で自己対戦に混ぜて学び直し、`--net` で比べ直せる
- 同じデッキでも、試合の組（`--start`）で勝率が 7〜10 ポイント動くことがある（ロイヤル戦 200 試合で g0〜99 と g100〜199）。良かった案は別の組で確かめる

## meta

```sh
npm run meta -- init --out 環境.json [--decks <デッキ>,…] [--usage class|uniform]
npm run meta -- round --state 環境.json [--out 次.json] [--classes witch,bishop] [--games 30] [--draw 1]
                [--stages 150:10,450:3] [--confirm 1200] [--zmin 2] [--eta 1] [--minUsage 0.02]
                [--pool <カード>,…] [--net 補正.json] [--report 記録.md] [--jsonl 試合.jsonl]
npm run meta -- export --state 環境.json --dir <フォルダ> [--top 1]  # 環境のデッキを td selfplay --decks 用のファイルに（--top 1 ならクラスごとに一番のデッキだけ。compare --decks 用）
npm run meta -- show --state 環境.json
```

環境（デッキと使用率）を持ち、1 回りごとに、各クラスが今の環境に一番効く入れ替えを探して採り、使用率を更新する（docs/ai-notes.md「環境を自動で回す」）。
環境のファイル（JSON）に、デッキ（カードの並び・元にしたデフォルトデッキ・使用率・入れ替えの履歴・引いた瞬間の価値）と回りのまとめが入る。
AI は deck-compare と同じ（どちらの側も今の既定）。

`init`:

| 引数 | 既定 | 意味 |
|---|---|---|
| `--out` | 必須 | 書き出す環境のファイル |
| `--decks デッキ,…` | 比較用の 7 デッキ | 環境のデッキ（デフォルトデッキの名前か、デッキのテキストファイルのパス）。ファイルのデッキは、同じクラスのデフォルトデッキと 30 枚以上同じならそれを元にする（マリガンのモデルとリノセウス用 AI）。元が無ければマリガンは引き直しを試して選ぶ |
| `--usage` | `class` | 最初の使用率。`class` はクラスごとに 1/クラス数 を、そのクラスのデッキで等分。`uniform` はデッキごとに等分 |

`round`（1 回り。総当たり → 使用率の更新 → 案 → ふるい → 確かめ → 採る）:

| 引数 | 既定 | 意味 |
|---|---|---|
| `--state` | 必須 | 環境のファイル |
| `--out` | `--state` と同じ | 回りの後の環境を書き出すファイル |
| `--classes` | 環境のすべてのクラス | 入れ替えを探すクラス（`elf`・`royal`・`witch`・`dragon`・`nightmare`・`bishop`・`nemesis` か日本語の名前） |
| `--games N` | 30 | 総当たりの 1 組・席 1 つあたりの試合数（0 なら総当たりをせず、使用率も変えない） |
| `--draw p` | 1 | 総当たりの各試合で、各席について「引いた瞬間に抜く」介入をする確率（td selfplay `--ivZone drawn` と同じ選び方）。カードの価値は環境のファイルに足していく |
| `--eta` | 1 | 使用率の更新 u ← u × (2 × 全体の勝率)^eta |
| `--minUsage` | 0.02 | これ未満になったデッキは環境から外す（クラスで一番のデッキは残す） |
| `--stages 試合:残す数,…` | `150:10,450:3` | ふるいの段。各段で新しい試合番号の試合（相手は使用率に比例して割り当て、両方の席）を足し、元のデッキとの差の上位を残す |
| `--confirm N` | 1200 | 確かめの試合数（新しい試合番号）。元のデッキに z ≥ `--zmin` で勝つ案のうち、差の一番大きいものを採る |
| `--zmin` | 2 | 採る z の下限 |
| `--pool カード,…` | クラスとニュートラルの全カード | 足すカードを絞る |
| `--net ファイル` | なし | 両方の席の学習した補正をこのファイルのものに替える（学び直した補正で回す用。`baseWeights` の無いモデルだけ） |
| `--report ファイル` | なし | 回りのまとめ（Markdown。標準出力と同じ）を書き足す |
| `--jsonl ファイル` | なし | 試合ごとの結果（段・デッキ・案・相手・試合番号・席・勝ち・介入）を JSON Lines で書き足す |

- 案は、クラスごとに使用率が一番のデッキについて、クラスとニュートラルの各カードを 2 枚（3 枚を超えるなら入るだけ）足し、
  引いた瞬間の価値の低いカード（2 枚以上入っているもの）を 1 枚ずつ同じ枚数抜く。1 クラス 40 案ほど
- 採った案は元のデッキに替わる（使用率はそのまま。名前に「改 n」が付き、履歴に残る）
- 試合番号は環境のファイルの `nextG` から順に使う（シードは 5000000 + 13 × 試合番号 + 席）。同じ環境のファイルと引数なら同じ結果
- 試合数の目安（既定、クラス 7 つ・環境 14 デッキ）: 総当たり 5460 試合と介入、ふるいと確かめで 1 クラス 1.6 万試合ほど、全部で 12 万試合ほど

## yardstick

```sh
npm run yardstick -- [--ref classic|strong] [--opts '<設定>'] [--games 1000] [--start 0] [--label 名前] [--record]
npm run yardstick -- fingerprint [--ref classic|strong]
```

固定した相手（凍結した探索 AI）との勝率。`--games 1000` で 2000 試合。相手は `--ref` で選ぶ:
`classic`（既定。学習した補正なしの 2026-10-16 の探索 AI。組の 2 試合は `compare --no-mirror` と同じく別のシード）と
`strong`（2026-10-22 の既定の探索 AI。組の 2 試合は `compare` の既定と同じく同じシードで、その日の既定の AI はちょうど 50%）。
`--record` で `docs/yardstick.md` のその相手の表に 1 行足す（`--label` が要る）。`fingerprint` は相手が変わっていないかの確認用。

## svwb（Rust 版の CLI）

```sh
npm run svwb -- golden [write] [組…]                     # ゴールデンテスト（write で保存し直す）
npm run svwb -- dump <試合> <手番> [--random-decks] [--json]  # ランダムな試合のその手番の局面
npm run svwb -- bench [試合数 2000]                       # 速さの計測
npm run svwb -- ai-play [試合数 14] [最初の試合 0] [search|rhino|rhino-lethal]  # AI どうしの試合の時間を測る
npm run svwb -- compare …                               # npm run compare と同じ
npm run svwb -- rhino-compare …                         # npm run rhino-compare と同じ
npm run svwb -- yardstick …                             # npm run yardstick と同じ
npm run svwb -- meta …                                  # npm run meta と同じ
npm run svwb -- mulligan-compare [--games 50] [--start 0] [--seed 1] [--a '{"mulligan":"sample"}'] [--b '{}']
npm run svwb -- td selfplay --model m.json --out d.jsonl [--games 100] [--start 0] [--eps 0.1] [--opp greedy|beam]
                [--sampling classic|default] [--iv 0] [--ivZone hand|board|both|drawn] [--cmp 0] [--rollouts 8] [--board 1] [--check 0]
                [--decks <デッキ>,…] [--vs <デッキ>]
```

- `mulligan-compare`: マリガンの設定 A と B を同じシードの試合で打ち比べる（7 デッキ × 相手 6 デッキ × 席 2 × `--games`）。相手は今の探索 AI
- `td selfplay`: TD 学習の自己対戦。各引数の意味は `rust/engine/src/runner/td.rs` の先頭。
  `--decks` で、比較用の 7 デッキの代わりに並べたデッキ（デフォルトデッキの名前かデッキのテキストファイル）の全組を回す（例: `rust/engine/td-pool/royal-counter/*.txt`）。
  `--ivZone drawn` は、カードを引いた瞬間に手札から抜いて最後まで打つ介入（`td ivcheck` で「（引いたとき）」の行。デッキに 1 枚入れる価値に近い）。
  `--vs <デッキ>` で、どの試合も片方をそのデッキにし、もう片方（挑戦する側）だけ並べたデッキを回して、介入も挑戦する側だけにする（特定の相手との試合でのカードの価値を測る用）

## td

```sh
npm run td -- init --out m0.json [--hidden 32] [--seed 1] [--a 0.08] [--base stripped|current] [--inputs v2|v1]
npm run td -- extend --model data/value-net.json --out m0.json
npm run td -- widen --model m.json --hidden 256,32 --out w0.json [--seed 1]
npm run td -- board --model m.json --out b0.json [--layers 32,16] [--seed 1]
npm run td -- check --model m.json --data d.jsonl
npm run td -- train --model m0.json --data d0.jsonl[,d1.jsonl] --out m1.json [--lambda 0.7] [--epochs 2] [--lr 0.001] [--l2 0.0001]
                [--batch 128] [--holdout 0.1] [--fitA 1] [--seed 1] [--ivWeight 1] [--v1Only 0] [--best 0] [--cmpWeight 0] [--cmpBatch 16]
npm run td -- ivcheck --model m1.json --data d0.jsonl[,d1.jsonl] [--holdout 0] [--opp <デッキ名>] [--min 30]
npm run td -- prune --model m4.json --data d0.jsonl,d1.jsonl,… --out data/value-net.json
npm run td -- probe --model m1.json --data d0.jsonl [--per 2000]
```

自己対戦（`selfplay`）は Rust 版（`npm run svwb -- td selfplay`）で行う。各引数の意味は `scripts/td-main.ts` の先頭。

## pack-run（PC で回した結果をクラウドから見られるようにする）

```sh
npm run pack-run -- <フォルダ> [--name 名前] [--note 'メモ'] [--out ~/svwb-upload] [--only selfplay,models,logs]
                    [--include 'f*,rf*'] [--exclude 'r*'] [--max-mb 0] [--force]
npm run pack-run -- ~/td-royal --name royal-9 --note 'ロイヤル対策 9 回目（rf.sh）' --include 'f*,rf*'
```

PC で回した 1 回分の出力（フォルダの中のファイル）を、1 つの `.tar.gz` にまとめる。
これをプロジェクトのファイル（共有フォルダ。クラウドでは `/mnt/project-files/`）に上げると、クラウドのスレッドから読める。

1. PC で、リポジトリの一番上で `npm run pack-run -- <フォルダ> --name <名前>` を実行する（数秒〜数分）
2. できた `~/svwb-upload/<名前>.tar.gz` を、プロジェクトのファイルに上げる。WSL なら Windows のエクスプローラーから
   `\\wsl.localhost\<ディストリ名>\home\<ユーザー名>\svwb-upload` で開ける（最後にこの場所を表示する）
3. スレッドで「<名前> を上げた」と伝える。Claude が展開して、共有フォルダの `data/`・`logs/` に置く

アーカイブの中は共有フォルダと同じ形にしてある（展開するとこの場所に入る）:

| 種類 | 何か | 入る場所 |
|---|---|---|
| 自己対戦 | `td selfplay` の `.jsonl`（1 行目に `"samples"` があるもの） | `data/selfplay/<名前>/`（1 ファイルずつ gzip して `.jsonl.gz`） |
| モデル | 学習した補正（`"kind":"td-value-net"` で始まる `.json`） | `data/models/<名前>/` |
| ログ等 | それ以外（`.log`・`.sh`・`.txt`、`--out` で書いた試合ごとの結果の `.jsonl`（gzip する）など） | `logs/<名前>/` |
| 一覧 | メモ、まとめた日時・元のフォルダ・その時の commit、ファイルごとの元の大きさ・行数・更新日時・sha256、入れなかったファイル | `logs/<名前>/MANIFEST.md` |

`.done`・`.tmp`・`.` で始まるファイルと、サブフォルダ（の中）は入れない（一覧の「入れなかったもの」に出る）。

| 引数 | 既定 | 意味 |
|---|---|---|
| `<フォルダ>` | 必須 | まとめるフォルダ（例: `~/td-royal`）。中のファイルだけを見る |
| `--name 名前` | フォルダ名と日付（例: `td-royal-20261024`） | まとめの名前。アーカイブのファイル名と、共有フォルダの中のフォルダ名になる（空白・`/` 等は使えない） |
| `--note 'メモ'` | なし | 一覧（MANIFEST.md）の先頭に書く。何の実験か（例: `ロイヤル対策 9 回目（rf.sh）`） |
| `--out フォルダ` | `~/svwb-upload` | アーカイブを書く場所 |
| `--only 種類,…` | 全部 | 入れる種類（`selfplay`・`models`・`logs`）。例: `--only models,logs` でログとモデルだけ（小さい） |
| `--include パターン,…` | 全部 | ファイル名がどれかに当たるものだけ入れる（`*` と `?` が使える。シェルに展開されないよう `'` で囲む） |
| `--exclude パターン,…` | なし | ファイル名がどれかに当たるものを入れない（例: 前に上げた自己対戦 `--exclude 'r*,d*'`） |
| `--max-mb N` | 0（分けない） | 1 つのアーカイブをおよそ N MB までにして、いくつかに分ける（`<名前>-1of3.tar.gz` …）。どれも単独で展開でき、どれにも同じ一覧が入る |
| `--force` | なし | 同じ名前のまとめが `--out` にあっても作り直す（前のものは消す）。無ければエラーにする |

- 大きさ: 自己対戦の `.jsonl` は gzip で 1/7〜1/8 ほどになる（3000 試合の 70 MB が 9 MB。`notes/big-net/r0a.jsonl.gz`）。
  モデルは 4〜9 MB ほどで、アーカイブ全体の gzip で 1/3 ほどになる
- スレッドへの添付は 30 MB を超えると注意が出るが、194 MB の `royal-9.tar.gz` は途中で切れずに全部届いた（2026-10-24）。
  上がらないときは `--max-mb` で分ける
- 自己対戦を回している途中でまとめると、まとめ始めたときの長さまでを入れる（1 分以内に書き換わったファイルがあれば注意を出す）
- 同じフォルダに何回分もの出力がたまっているとき（`~/td-royal` など）は、`--include`・`--exclude` でその回のファイルだけにする
- 実験用の `.sh` の最後に `npm run -s pack-run -- $W --name <名前> --include '…'` を入れておくと、回し終わったときにまとまる

### クラウドで展開する（Claude 向け）

```sh
F=<上がったファイル>   # 上がった場所。スレッドに添付したものは /mnt/project-files/<ファイル名>（前は uploads/hearth/<id> で拡張子なしのこともあった）
gzip -t "$F"          # 途中で切れていないか（切れていればエラー）
tar -tzf "$F" | head  # 中身を見る（1 つ目が logs/<名前>/MANIFEST.md）
tar -xzf "$F" -C /mnt/project-files/ --skip-old-files  # 共有フォルダの data/・logs/ に展開する（あるファイルは上書きしない）
zcat /mnt/project-files/data/selfplay/<名前>/f0.jsonl.gz | head -c 500
```

- 展開したら `logs/<名前>/MANIFEST.md` を読む（何の実験か、どのファイルがあるか、モデルの sha256）
- `npm run td` は `.jsonl.gz` をそのまま読めない。学習・分析に使うときは `zcat` でスクラッチに展開してから渡す
- 分けたアーカイブは、どれから展開してもよい

## 探索 AI の設定（compare の A・B、rhino-compare・yardstick の `--opts`）

JSON のオブジェクトで渡す。`{}` は今の探索 AI の既定。知らない項目はエラーになる。項目の意味は `rust/engine/src/ai/search.rs` の `SearchOptions`。

- 数: `samples`・`beamWidth`・`maxDepth`・`rescoreTop`・`planCandidates`・`perFirst`・`oppHandSamples`・`dangerRescore`・`mulliganSamples`・`nextLethal`・`beamPp`
- 真偽: `lethal`・`mulliganStatic`・`mulliganNet`・`dedup`・`sameHandOnce`・`chain`・`chainFuse`・`settleTrades`・`dominance`・`reusePlan`・
  `peekOppHand`・`oppFuse`・`oppHandCommon`・`reuseAgree`・`resampleDraws`・`drawFirst`
- `rescoreMix`: 0〜1 の数。上位の手を相手のターンまで読み直した点数に、ターン末の点数をこの割合で混ぜる（既定 0.5。0 で 2026-10-22 より前の読み方）
- `scoreTurnEnd`: `"none"`・`"terminal"`・`"all"`
- `mulligan`: `"model"`（既定）・`"weights"`・`"cost"`・`"sample"`
- `opponentSearch`: `null`（相手のターンを読まない）か `{"beamWidth": …, "maxDepth": …, "extraEval": true|false}`
- `weights`: `"default"`（基準の重み）か、変えたい項目だけのオブジェクト（`"holdScale"` で hold を何倍にするか）
- `valueNet`: 学習した補正のファイル名か `false`（補正なし）

例: `'{"lethal":false,"beamWidth":16,"weights":{"myHand":0.8}}'`
