# 消した実験経路とランナー

2026-11-10 に、採らなかった実験の設定・経路と、1 回きりの調べに使ったランナーを消した（[STATE.md](STATE.md)「前提」の「足す前に引く」）。
ここには、何を消したか、最後の結果、どのコミットにあったか、戻し方を置く。実験の中身は [ai-notes.md](ai-notes.md) の「節の索引」から辿る。

- **残したもの**: 既定の経路、診断用（`peekOppHand`・`recordReads`）、物差しの凍結した設定（`reference_options`・`strong_reference_options`・`with_classic_sampling`）、
  リノセウス用 AI と UI が使うもの、打ち比べのランナー（`human-plan-value`・`deep-gap`・`two-turn`・`defer-playout`）、`beam-gap`・`profile`・`meta`
- **`fuseMinimal` は残した**（ユーザーの判断）。筋が通っていて損が無く（前の測りで勝率は同じ、思考は 2〜3 割速い。今のプール特有の最適化ではある）、既定にする候補（STATE.md「次」）
- **振る舞いは変わっていない**: 消した項目は、既定でも物差しの相手でも「使わない」値だった。消した後もゴールデンテスト（`rust/engine/tests/golden/`）は
  1 文字も変わらず（`npm run svwb -- golden write` で差分なし）、物差しの指紋（弱い相手 `efc7e5ba`・強い相手 `8492c675`）も同じ
- **大きさ**: `search.rs` 4401 → 2691 行、ランナー（`runner/*.rs`）17317 → 13958 行、探索 AI（`ai/`、テストを除く）13769 → 10580 行、`SearchOptions` 72 → 46 項目、`rust/engine/src` の `.rs` 全体 44445 → 36968 行

## 戻し方

- 消す直前の版は **`6cfa6a7`**（main）。ファイルを見るには `git show 6cfa6a7:rust/engine/src/ai/search.rs` など
- 消したコミットは、このファイルを足したコミット（`git log --diff-filter=A --format=%h -- docs/removed.md`）。`git show <それ> -- rust/engine/src/ai/search.rs` で、消した部分が差分で見える
- 1 つだけ戻すなら、下の表の「入れたコミット」で入れたときの形を見て、今の `search.rs` に入れ直すのが早い（後の変更が多いので、コミットごと revert するとぶつかる）
- 戻したら、使わない値のときにゴールデンテストと物差しの指紋が変わらないことを確かめる（`cd rust && cargo test --release --workspace`）

## 設定の JSON に消した項目を書いたとき

`--opts`・`npm run compare` 等の JSON に消した項目を書くと、下の表の「使わない値」なら黙って受け付け、それ以外の値ならこのファイルを指すエラーになる
（`rust/engine/src/runner/options.rs` の `REMOVED`）。古い記録のコマンドをそのまま打っても、知らないうちに違う設定で回らないようにするため。
`nextLethalRange`・`passLethalWard`・`beamKey` は使わない値が無い（書かなければ使わない）ので、書けばエラーになる。

## 消した設定（`SearchOptions`）

「記録」は ai-notes の詳しい記録の節の名前（索引から辿る）。日付は最後に測った日。

| 設定（JSON） | 中身 | 使わない値 | 最後の結果 | 記録 | 入れたコミット |
| --- | --- | --- | --- | --- | --- |
| `tree` | 自分のターンをビームの代わりに木の探索（A0・B*・MCTS・A'）にする | `null` | 同じ読んだ数でビーム＋見込みより 2.6〜14 倍取りこぼす。段階 1 で不採用（2026-11-05） | 11「自分のターンの探索を B*・MCTS にする」 | `eb56b49` |
| `bestFirst` | 段を作らず、見込みの高い局面から広げる | `0` | 段のあるビームに遠く及ばない（取りこぼし 1.6〜2.5 倍。2026-10-30） | 10「ターン途中の評価の見直し」 | `56c41ec` |
| `beamKey` | ビームの並べ替えのキーに手で決めた重みの項（残り PP・攻撃の伸びしろ等）を足す | ―（書かない） | 学習した見込み（`potentialNet`）に置き換えた（2026-10-30） | 10「ターン途中の評価の見直し」 | `f19b416` |
| `beamPp` | ビームで残す局面を選ぶときだけ残り PP を足す | `0` | TypeScript 版で不採用 | 02「深さ 10・ビームの選別に残り PP を足す」 | `a8c2b21`（Rust に移したとき） |
| `perPlan` | 手の組ごとにビームの枠を設ける | `0` | 50.0〜51.5%、不採用（2026-10-26） | 08「人間なら見える手順の取りこぼしを掘る」 | `944953d` |
| `attackLater` | 攻撃以外の手で並びを作り、攻撃は貪欲に済ませてから採点する | `0` | 600 試合で 50.2%、不採用（2026-10-26） | 08「攻撃を後にまとめるビーム」 | `3c269e5` |
| `chainFuse` | 融合を続く自分の手とまとめて 1 手として展開する | `false` | TypeScript 版で不採用（全デッキで 51.1%、遅い） | 02「融合を挟む手順がビームで切られる」 | `a8c2b21` |
| `fuseRoot` | 長い融合の並びを先に作った局面からもビームを打つ | `false` | 前の版に +0.3 ± 0.2、思考は 1 割遅い。不採用（2026-10-29） | 09「長い融合の並びの取りこぼしを直す」 | `f796ead` |
| `deferFuseKeepSet` | 融合を回すとき、α・β・γ の種類が増える融合は残す | `false` | 前の版と並ぶ。S=0 の補正では効かない（2026-10-29） | 09「融合を回した局面で探索が取りこぼすか」 | `ea12ac9` |
| `scoreTurnEnd` | ターン終了時の処理を進めてから採点する範囲 | `"all"` | `"all"` を採用（TypeScript 版）。今は常にそうするので項目を消した | 02「融合を挟む手順がビームで切られる」 | `a8c2b21` |
| `potentialDrawSplit` | 引く手の直前で区切った組み直しのビームにも見込みを使う | `false` | 同じ勝率で重い（2026-10-30） | 10「ターン途中の見込みを学ぶ」 | `c518381` |
| `drawSplit.stratify` | 引きを作り直すとき、引くカードを層別に選ぶ | `false` | ぶれが減らず不採用（2026-10-28） | 09「引く手の直前で区切って引きを作り直す」 | `e5d13b4` |
| `drawSplit.class` | 引く手の直前で区切るのを、決めたクラスのときだけにする | `null` | 同じ日に全クラスへ広げて要らなくなった（2026-10-28） | 09「どのクラスでも引く手の直前で区切る」 | `c63e378` |
| `nextLethal`・`nextLethalRange` | 相手が何もしなければ次のターンに倒しきれる終局面に点を足す（と、足す体力の上限） | `0`・―（書かない） | リノセウス用 AI で 3600 試合 64.9% → 65.0%、勝ち負けが入れ替わって差し引き 0。不採用（2026-11-05） | 11「nextLethal をリノセウス用 AI の勝率で測り直す」 | `a8c2b21`・`14f0e8c` |
| `passLethal`・`passLethalWard` | 次のターンに倒しきれる終局面を、相手のターンを読む候補に足す（と、守護へのダメージの見積もりで絞る） | `0`・―（書かない） | リノセウス用 AI で 69.0%（+0.8）、不採用（2026-10-18） | 05「相手が何もしなければ次のターンに倒しきれる並びを、相手のターンを読む候補に足す」 | `14f0e8c`・`60cfa29` |
| `ownNext` | 読み直しの後、次の自分のターン末まで読む（`reply` で相手の次の次のターンまで） | `null` | 46.5%（2026-10-18）、47.8%（2026-10-27）。`reply` をスペルウィッチだけで +0.3 ± 2.2 | 05「読み直す候補を広げる・次の自分のターン末まで読む」 | `eeced47` |
| `twoTurnGate` | 2 ターン読みの差が大きいときだけ手を変える | `null` | 12800 試合で 50.52% ± 0.25、思考 5 倍。ユーザーの判断でやめた（2026-11-05） | 12「2 ターン読みの先生役を全デッキで測る」 | `de45b05` |
| `lethalRead` | 相手が持っていればリーサルだったカードを、その手札の決定化から外す | `false` | 3200 試合で 50.0%。手札を完全に知っても上限 +1.5。不採用（2026-11-02） | 11「見逃したリーサルから相手の手札を絞る」 | `88b500f` |
| `dangerRescore` | 読み直した手がどれも負けなら、候補を足して読み足す | `0` | 1 万試合で 50.1%（2026-10-25） | 08「深い読みと食い違う局面を集める」 | `a8c2b21` |
| `rescoreAverage` | 読み直しの点数を勝率にしてから平均する | `"score"` | 6400 試合で 49.97%・50.02%、不採用（2026-10-31） | 10「読み直しを勝率にしてから平均する」 | `9fb3e6b` |
| `oppFuse` | 相手のターンの読みで、融合を「融合した後に打てる最善手」の価値でも評価する | `false` | AF が相手の試合だけで 1600 試合 54.8%、不採用（2026-10-14）。相手の読みをビームにした後は効いていなかった | 04「人間の手順と AI の手順を打ち比べる」 | `a8c2b21` |
| `reuseAgree` | 使い回す並びを、すべての引き直しで一致する所までに限る | `false` | 1600 試合で 50.3%、不採用（2026-10-14） | 04「人間の手順と AI の手順を打ち比べる」 | `a8c2b21` |
| `resampleDraws` | ターンの途中で引くカードを引き直す | `false` | 3200 試合で 50.7%、不採用（2026-10-16） | 05「棋譜の指摘: ルミナスランサー・先ドロー・ビームの幅」 | `a4fc453` |
| `drawFirst` | 引く手を先に打つ | `false` | 3200 試合で 51.0%、不採用（2026-10-16） | 05「棋譜の指摘: ルミナスランサー・先ドロー・ビームの幅」 | `a4fc453` |

JSON で渡さない内部の項目（`next_lethal_search`・`pass_lethal_search`・`hand_reading`）も、上の設定と一緒に消した。

## 消したファイル・ランナー・関数

| もの | 何のためか | 入れたコミット |
| --- | --- | --- |
| `ai/search/tree.rs`・`ai/bounds.rs`・`ai/upper.rs` | `tree`（木の探索と、見込みの上限・下限） | `eb56b49` |
| `ai/hand_read.rs`・`Agent::observe`・`determinize_read`・`exact_lethal::with_isolated_cache` | `lethalRead`（相手の手番の局面を見せて、手札の候補を絞る） | `88b500f` |
| `svwb tree-gap`（`runner/tree_gap.rs`）・`cloud/jobs/tree-gap.sh`・`svwb beam-gap --marks` | `tree` の読み比べ | `eb56b49` |
| `svwb fuse-gap`（`runner/fuse_gap.rs`） | 融合を回した局面の読み比べ（09「融合を回した局面で探索が取りこぼすか」） | `680c272` |
| `svwb read-log`（`runner/read_log.rs`）と `search.rs` の読み直しの記録（`record_rescores` 等） | 読み直しの打ち切りの決まりを試合を打たずに比べる。結果は `rescoreRace` として採用済み（10「読み直しの記録で、見込みのない候補を途中で打ち切る」） | `910cc3f` |
| `svwb read-gap`（`runner/read_gap.rs`）と `SearchAgent::read_trace` | 相手のターンの読みのギャップを測る（11「相手のターンの読みのギャップがどこで生まれるか」ほか 2 節、測定のみ） | `3b71502` |
| `svwb lethal-read`（`runner/lethal_read.rs`）・`svwb lethal-diff`（`runner/lethal_diff.rs`） | `lethalRead` の調べ | `88b500f`・`bd43bca` |
| `svwb draw-stability`（`runner/draw_stability.rs`） | 同じ局面で乱数を変えたときの手のぶれ（`stratify` の調べ） | `53047b2` |
| `npm run potential -- bounds` と `--groups position`（`scripts/potential-main.ts`） | `tree` の見込みの上限・下限の学習と、`bestFirst` の見込みを局面ごとに学ぶ形 | `eb56b49`・`e8015d2` |
| `cloud/jobs/deep-gap.sh` の `dangerRescore` の比べの段 | `dangerRescore` | `6cfa6a7` にある |
| `rhino-compare` の `twoTurnGate` の記録（`gate_events_json` 等） | `twoTurnGate` | `de45b05`・`2cb9ef3` |
| `greedy` の `fuse_follow_up`（`value_after_fuse`） | `oppFuse` | `a8c2b21` |
| `rhino.rs` の `rhino_next_lethal`・`rhino_pass_lethal`・`ward_clear_damage` | リノセウス用 AI の `nextLethal`・`passLethalWard` | `14f0e8c`・`60cfa29` |
| `beam_key.rs` の `BeamKey` | `beamKey`（項を出す `beam_features` は見込みと `beam-gap` が使うので残した） | `f19b416` |
| `fusion.rs` の `fuse_root_chains` | `fuseRoot` | `f796ead` |
| テスト `ai/tests/` の `tree.rs`・`attack_later.rs`・`per_plan.rs`・`fuse_root.rs`・`hand_read.rs`・`rescore_average.rs` と、ほかのファイルの中の消した設定のテスト | 上の設定の単体テスト | 上と同じ |

## 書き足し方

不採用にした設定・ランナーを消したら、この表に 1 行足す（最後の結果・記録の節・入れたコミット）。消す直前のコミットが上の `6cfa6a7` と違うなら、行に書く。
