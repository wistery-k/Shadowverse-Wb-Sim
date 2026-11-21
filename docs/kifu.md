# 棋譜

対戦を打つランナーは、試合ごとの棋譜を 1 つの形で書く（2026-11-16 から）。調べ物は、専用の処理をランナーに足すのでなく、
この棋譜を打ち直して数える形にそろえていく（審査の文書「AI の設計の審査と今後の方針」のタブ「棋譜を 1 つの形にそろえる」。
段取り 1 は「どこに書くか」〜「1 行の形」、段取り 2 は「出来事」と「数える」）。

- 書くのは `compare`・`yardstick`・`profile`・`td selfplay`・`survey run`（svwb。`npm run compare` 等も同じ）と、
  `rhino-compare`・`deck-compare`・`review zero`・`deep-gap play`・`beam-gap`（自己対戦を打つ回。2026-11-17 から。段取り 4 の案 1）。打つ手・試合は変わらない。
  `meta round` は `--kifu <ファイル>` を付けたときだけ書く（2026-11-17 から。段取り 4 の案 3。回りの試合は 10 万を超えるので、既定では書かない）
- 試合ごとの勝ち負けだけの行（`rhino-compare --out`・`deck-compare --out`）は消し、棋譜から `svwb kifu seats` で出す（2026-11-17 から。段取り 4 の案 3）。
  `meta round --jsonl` は、棋譜に入らない引いた瞬間に抜く介入の価値を持つので残した
- 本体は `rust/engine/src/runner/kifu.rs`。開発サーバーの「リプレイ検索」タブ（`docs/commands.md`「リプレイ検索」）もこの形を読む
- 1 試合を調べる道具も棋譜を読む（2026-11-17 から。段取り 4 の案 2）: `npm run think-at -- --json <棋譜> --line N`・`npm run diverge -- --a <棋譜> --b <棋譜>`・
  `svwb defer-playout --kifu <棋譜>`・`npm run misses -- add --replay <棋譜> --line N`（どれも `.jsonl.gz` のままでよい）。
  `npm run game -- … --json` もこの形の 1 行を書く（`source` は `"game"`。エンジンの版・プール・補正の指紋は無い）。1 試合 1 ファイルを書く `rhino-compare --record` は消した
- 名前は「棋譜」（コマンドと引数は `kifu`。ユーザー決定 2026-11-16）。前の名前の「リプレイ」（`--replays`）も引数としては使える

## どこに書くか

| 場合 | 書く先 |
| --- | --- |
| 何も付けない | 環境変数 `SVWB_KIFU_DIR` のフォルダ（無ければ `~/svwb-data/kifu/`）に、下の名前で |
| `--kifu <ファイル>`（前の名前 `--replays`） | そのファイル |
| `--no-kifu` | 書かない |
| 夜のキュー（`npm run night`） | 回のフォルダの `kifu/`（キューが `SVWB_KIFU_DIR` を渡す）。区切りが済むと、その区切りが書いたものを `.jsonl.gz` にする（止まった survey の書きかけは、続きから回して済むまでそのまま）。`--kifu`・`--no-kifu` はキューの行には書けない |

- 既定の名前は `<種類>-<回の名前>-g<最初>-<最後>-<引数の指紋>-<コミット>.jsonl`（回の名前は `--label`。無ければ飛ばす。引数の指紋は、棋譜の引数を除いた
  引数の並びの FNV-1a）。同じ引数・同じコミットなら同じ名前で、同じ試合なので上書きする。設定だけが違う回（夜のキューの 2 つの profile 等）は指紋で分かれる
- 手元の変更がある（コミットの末尾が `+`）回は、名前の末尾に書き始めた時刻（UTC。`-20261116T172114Z`）を足し、上書きしない（変更の中身が違う 2 回が同じ名前になるので）
- 書いている間は `<ファイル>.tmp` に書き、全部の試合を書き終えてから名前を替える。途中で止まった回は `.tmp` のまま残る（`pack-run` は入れない）
- `survey run`・`review zero`・`deep-gap play` は、`.tmp` を使わず、そのファイルに 1 試合ずつ書き足す（同じ引数で続きから回せるので）。結果の行より先に棋譜を書き、
  開くときに書いてある試合を読んで、同じ試合番号は 2 度書かない（途中で切れた最後の行は消す）。止まった回のファイルには、そこまでの試合が入っている
- `beam-gap` は、自己対戦を打つ回だけ書く（`--positions` で局面を読む回は打たないので書かない）
- 終わると、書いたファイルと試合の数を出す（`棋譜: <ファイル>（N 試合）`）。compare・yardstick は、台帳の行の `kifu` にファイルの名前を書く
  （フォルダは入れない。台帳は公開のリポジトリにコミットするので。持ち帰った後は共有フォルダの `data/kifu/<回の名前>/` の下で、夜のキューの分は `.gz` が付く。
  夜のキューが区切りの行を 1 行にまとめるときは、区切りごとの名前を試合番号の順に並べた列にする）
- `profile` は、`--baseline` を渡した回（`npm run profile` の測るビルドの方。試合は測らないビルドと同じ）では、`--kifu` が無ければ書かない
- 0 試合（夜のキューが設定を確かめる回）は書かない
- 大きさは 1 試合 4〜5 KB（gzip で 0.4 KB ほど）。新しいプールの compare 1.2 万試合で 60 MB ほど（gzip で 5 MB ほど）、自己対戦 6 万試合で 300 MB ほど（gzip で 30 MB ほど）

## 持ち帰り方（夜のキュー）

- キューが止まるときに、ログと一緒に棋譜も出口のフォルダ（`~/svwb-data/outbox/<回の名前>/`）にまとめる。要るときにユーザーに上げてもらい、
  スレッドが `npm run night -- ingest <ファイル…>` で `/mnt/project-files/data/kifu/<回の名前>/` に展開する（[night.md](night.md)「止まったときのまとめ」。
  前の `npm run night -- finish --pack` も残してある）
- `npm run pack-run` は、フォルダの中の `kifu/` の下と、1 行目が `{"kind":"replay", …}` の `.jsonl` を棋譜として `data/kifu/<名前>/` に入れる。
  共有フォルダに展開すると `/mnt/project-files/data/kifu/<名前>/` に入る

## 1 行の形（版 2）

1 行 1 試合の JSON。項目はこの順に書く。

| 項目 | 中身 |
| --- | --- |
| `kind` | `"replay"` |
| `version` | 形の版。2（2026-11-16 から）。1 は前の `--replays` の行（下） |
| `source` | 書いたランナー（`"compare"`・`"yardstick"`・`"profile"`・`"td selfplay"`・`"survey"`・`"rhino-compare"`・`"deck-compare"`・`"review zero"`・`"deep-gap"`・`"beam-gap"`・`"meta round"`・`"game"`（`npm run game --json`）） |
| `run` | 回の名前（台帳の名前 `--label`。無ければ空） |
| `engine` | エンジンの版（コミット。手元の変更があれば末尾に `+`。夜のキューは組み立てたときのもの。台帳の `commit` と同じ） |
| `pool` | カードプール（`"starter"`・`"azvaldt"`。両方のデッキのカードが入るプール。ベーシックだけなら `"starter"`。どちらにも入らなければ `"mixed"`） |
| `g` | 試合番号 |
| `swap` | 組（同じ試合番号で席とデッキを入れ替えた 2 試合）のどちらか。組の相手は、同じ回の同じ `g` で `swap` の違う試合。自己対戦（組が無い）と、席ごとにシードが違う rhino-compare・deck-compare・meta round には無い |
| `names` | 席ごとのデッキの名前 |
| `agents` | 席ごとの表示名（compare は `"A <設定>"`・`"B <設定>"`、yardstick の相手は `"B <物差しの名前>"`、profile は `"profile <設定>"`、survey は `"survey <設定>"`、自己対戦は `"td"`・`"td-frozen"`、rhino-compare は `"A <AI> <設定>"`・`"B <相手の AI>"`、deck-compare は `"A rhino"`・`"A search"` 等（meta round も同じ。総当たりは側の無い `"rhino"`・`"search"`）、review zero・deep-gap・beam-gap は `"<ランナー> <設定>"`） |
| `sides` | 席ごとの側（compare・yardstick は `"A"`（測る側）・`"B"`（相手）、rhino-compare・deck-compare と meta round のふるい・確かめは `"A"`（比べるデッキ）・`"B"`（相手）、自己対戦の `--frozen` は `"learner"`・`"frozen"`）。比べでなければ無い |
| `variants` | 席ごとのデッキの案の名前（deck-compare と meta round のふるい・確かめの、比べるデッキの席。カードの入れ替えなら `"知恵の輝き-1,最果ての罪・サタン+1"` の形、元のデッキは `"元のデッキ"`。相手の席は null）。案を比べない回には無い |
| `ai` | 席ごとの AI の設定。compare・profile・survey・review zero は渡した設定の JSON（`{}` は今の既定。何が既定かは `engine` のコミットで決まり、補正は `nets` の指紋で分かる）、yardstick の相手は `{"yardstick": <名前>, "version", "fingerprint"}`、自己対戦は `{"model", "eps", "sampling", "opp", "potential"}`（固定した側は `--frozen` の設定）、profile の `--rhino` のリノセウスエルフは `{"rhino": true}`、rhino-compare は `{"agent": <AI の名前>, "opts": <設定>}`・相手は `{"agent": "search-classic"}` 等、deck-compare・meta round は `{"agent": "rhino" か "search", "net": <--net のファイル>}`、deep-gap・beam-gap は `{}` |
| `nets` | 席ごとの補正と見込みの指紋 `{"valueNet", "potentialNet"}`（ファイルの中身の FNV-1a。台帳の `files` と同じ。書かなければ組み立てたときの `data/value-net.json`・`data/potential-net.json` の指紋、使わなければ null）。yardstick の相手・リノセウス用 AI は null（版と指紋で見分ける） |
| `seed` | 試合のシード |
| `decks` | 席ごとのデッキ（カード ID の列。並び順も山札のシャッフルに効く） |
| `first` | 先攻の席 |
| `winner` | 勝った席（無ければ null） |
| `turns` | 終わったときのターン番号 |
| `actions` | 打った行動の列（`src/engine/types.ts` の Action の JSON） |

打ち直すには、`decks`・`seed`・`actions` があればよい（エンジンは決定的）。`rust/engine/src/runner/kifu.rs` の `parse_replay` が読み、
`rust/engine/src/replay_index.rs` の `replay_index` が打ち直してターンごとにまとめる。ルールやカードの能力を直すと、古い棋譜は打てない手で止まるか、
勝者が変わる（`engine` で見分ける）。

前の形（版 1。2026-11-16 までの `compare --replays`・`td selfplay --replays`）は `kind`・`version`・`source`・`g`・`names`・`agents`・`seed`・`decks`・`winner`・`turns`・`actions`
だけ。リプレイ検索はどちらも読む。

## 出来事

`replay_index`（`rust/engine/src/replay_index.rs`）は、棋譜を打ち直して、ターンごとの始めと終わりの様子と、そのターンに起きたこと（出来事）の列にする。
下の `svwb kifu` とリプレイ検索はこれを読む。出来事は `{"k": 種類, "p": プレイヤー, "at": 起こした行動の添字, …}` で、起きた順に並ぶ。
ターン終了の行動で起きたことは、ターンの終わりに起きたこと（終了時の能力など）を終えたターンに、次のターンの始めに起きたこと（ドロー・PP・開始時の能力など）を次のターンに入れる。
最初のターンの前に起きたこと（始めから持っているクレスト。デッキに入れると置かれる信仰など。とマリガンの間のこと）は `pre` に入れる（`svwb kifu` は、手番の無いターン 0 として数える）。

| 種類 | p | ほかの項目 | いつ |
| --- | --- | --- | --- |
| `mulligan` | マリガンをした側 | `c`・`i`・`ret`（返したら true） | 初手のカード 1 枚ごとに 1 つ（`pre` に入る。2026-11-20 から。ダストデイズの調べ） |
| `play` | 行動した側 | `c`・`i`・`mode`（`"accelerate"`・`"crystal"`・`"enhance"`。アクセラレート・結晶はプレイしたときの姿が違うもの（`as` がその姿のカード）、エンハンスはエンハンスのコストを払ったもの）・`ougi`（【奥義】を持つカードを奥義ゲージ 10 以上でプレイしたら 1、15 以上なら 2（解放奥義）。効果が奥義の条件を見るかによらない） | 手札からプレイした |
| `attack` | 行動した側 | `c`・`i`・`t`（攻撃先のカード ID か `"leader"`）・`ti` | 攻撃した |
| `act`・`fuse`・`extraPp` | 行動した側 | `c`・`i`（`fuse` は素材の `m` も） | アクト・融合・エクストラPP を使った |
| `enter`・`leave`・`evolve`・`superEvolve` | 場のカードの持ち主 | `c`・`i`（進化ポイント・超進化ポイントを使った進化は `ep` が true） | 場に出た・場から離れた・進化した・超進化した（行動の前と後の場の差。進化ポイントを使った進化は行動そのものから） |
| `trigger` | 能力を持つ側 | `c`（カードかクレストの ID）・`i`・`crest`（クレストなら true）・`ab`（能力の番号。1 から。profile の表と同じ）・`own`（その持ち主のターンか） | 能力が誘発した（誘発待ちの列 `state.queue` に入った。クレストの能力・ラストワード・場に出たとき・ターンの開始と終了・自分がプレイしたとき・引いたとき等。プレイや行動でそのまま解決するファンファーレ・スペル・進化・アクト・融合・攻撃と交戦のときの能力は入らない。それは `play`・`evolve` 等で数える） |
| `draw` | 手札の持ち主 | `c`・`search`（条件を付けて山札から引いた）・`burned`（手札があふれて墓場に行った） | 山札から引いた |
| `addHand` | 手札の持ち主 | `c`・`burned` | 引く以外で手札に加えた（作って加える・場から手札に戻す等） |
| `damage`・`heal` | 受けた側 | `c`（カード ID か `"leader"`）・`i`（カードのとき）・`n`（量） | ダメージを受けた（0 は入れない）・回復した |
| `destroy`・`banish`・`bounce` | カードの持ち主 | `c`・`i` | 場から離れた理由（破壊・消滅・手札に戻った） |
| `crestIn`・`crestOut` | 持ち主 | `c`・`i` | クレスト（信仰を含む）を持った・無くなった |
| `pp`・`maxPp` | 持ち主 | `n`（増減） | PP・PP の最大値が変わった |
| `turnEnd` | ターンを終えた側 | `pp`（残した PP）・`playable`（そのとき手札からプレイできたカード。同じカードは 1 回）・`combo`（そのターンのコンボの数）・`crests`（持っているクレスト。信仰も） | ターンを終えた（ターン終了を選ぶ直前の局面）。`combo`・`crests` は 2026-11-20 から（ダストデイズの調べ） |

`trigger` から `bounce` までは、エンジンが打ち直しの間に残したもの（`rust/engine/src/trace.rs`。試合は変えない。前の profile のクレストの数え方 `crest_tally.rs` はこれに替えて消した）。
どの出来事を足しても、打つ手・試合は変わらない。

## 数える（svwb kifu）

```sh
svwb kifu count <棋譜>… --event '<種類>[|<種類>…] [<条件>…]' [--where '<条件>,…'] [--per seat|game|turn] [--by <分け方>,…]
svwb kifu winrate <棋譜>… [--where '<条件>,…'] [--by <分け方>,…]
svwb kifu events <棋譜>… [--where '<条件>,…'] [--event '…'] [--out 出来事.jsonl]
svwb kifu seats <棋譜>… [--where '<条件>,…'] [--out 席.jsonl]
svwb kifu values <棋譜>… [--opts '<設定>'] [--reads N] [--opp-lethal 1] [--where '<条件>,…'] [--out ターン末.jsonl]
```

- 棋譜は、ファイルかフォルダ（中の `.jsonl`・`.jsonl.gz` を全部。`.tmp` は読まない）。何個並べてもよい。`npm run svwb -- kifu …` でも同じ
- **席を単位にする**: 1 試合は 2 席で、`--where` は席ごとに、その席から見て調べる。条件は「,」で区切り（全部に合う席だけ）、値は「|」で並べる（どれかに合えばよい）
- `count`: 合った席の、その席が `p` の出来事を数える（`damage` なら受けた数、`trigger` ならその席の能力の誘発）。`--per seat`（既定）は席ごと、
  `--per game` は試合ごと（合った席を足す。分け方は合った最初の席から見る）、`--per turn` はその席の自分のターンごと。
  表は、数・1 つあたり（平均 ± 標準誤差）・1 回以上あった数と割合・あったものだけの平均・最初にあった自分のターンの平均
- `winrate`: 合った席の勝率（引き分けは負け）。打ち直さないので速い。誤差は、同じ棋譜の同じ試合番号（席とデッキを入れ替えた組）をまとまりにした誤差で、
  compare の組の誤差と同じ値になる。組が 2 勝・1 勝・0 勝の数も出す
- `events`: 合った出来事を 1 行ずつ JSON で出す（試合・ターン・席の項目と、カードの名前 `name` を足す）。表にない数え方は、これを `jq` 等で数える
- `seats`: 合った席を 1 行ずつ JSON で出す（`file`・`run`・`source`・`g`・`swap`・`seat`・`deck`・`opp`・`side`・`agent`・`variant`・`first`・`won`。
  無い項目は書かない）。打ち直さない。前の `rhino-compare --out`・`deck-compare --out` の試合ごとの勝ち負けの行の代わり（`--where side=A`）。
  表にない比べ方（同じ試合での案と元のデッキの入れ替わりなど）は、これを `jq` 等で突き合わせる
- `count`・`events` は試合を打ち直すので、エンジンの版（`engine`）が違うと打てない手で止まるか、勝者が変わることがある。そういう試合は数えず、その数と版を出す

席の条件（`--where`）:

| 条件 | 意味 |
| --- | --- |
| `deck`・`arch` | 自分のデッキの名前・型（名前の「（」の前） |
| `opp`・`oppArch` | 相手のデッキの名前・型 |
| `pair` | どちらかの席のデッキ（`pair~クキシロB` で、クキシロB の絡む組。`!~` は両方の席が合わないもの） |
| `side`・`agent`・`variant`・`run`・`source`・`engine`・`pool` | 棋譜の行の項目（`side=A` で compare の測る側。`variant` は deck-compare・meta round の案の名前。meta round の `run~s1` でふるいの 1 段目） |
| `g`・`seat`・`swap` | 試合番号（`g=0-999` で範囲）・席（0・1）・組のどちらか（0・1） |
| `first`・`second`・`won`・`lost`・`draw` | 先攻・後攻・勝った・負けた・引き分け（値を付けない） |

出来事の条件（`--event` の種類の後に空白で並べる）:

| 条件 | 意味 |
| --- | --- |
| `card`・`target`・`as` | カード（`c`）・攻撃先（`t`。リーダーは `leader`）・プレイしたときの姿（`as`）の ID か名前 |
| `mode` | プレイの仕方（`mode=accelerate`・`crystal`・`enhance`） |
| `crest` | クレストの能力の誘発・クレストの出入り（値を付けなければクレストのものだけ、`crest~クキシロ` で名前も） |
| `holds` | `turnEnd` の、持っているクレスト（`holds~ダストデイズ`。どれかが合えばよい。`!~`・`!=` はどれにも合わない） |
| `own`・`opp` | その席の自分のターン・相手のターンに起きた |
| `search`・`burned`・`ep`・`ret` | 上の表の同じ名前の項目が true |
| `turn`・`tc` | 全体のターン番号・その手番のプレイヤーの何ターン目か |
| `n`・`pp`・`ab`・`playable`・`combo`・`i`・`ougi` | 数の項目（`playable` は数。`playable>0 pp>0` で、プレイできるカードと PP を残してターンを終えた。`combo=2 playable>0` で、あと 1 枚打てたのにコンボ 2 で終えた） |

文字の条件は `~`（含む）・`!~`（含まない）・`=`・`!=`、数の条件は `=`・`!=`・`>=`・`<=`・`>`・`<`。分け方（`--by`）は
`deck`・`arch`・`opp`・`oppArch`・`side`・`agent`・`variant`・`first`（先攻・後攻）・`result`（勝ち・負け・引き分け）・`seat`・`run`・`source`・`engine`・`pool`・`file`。

例（2026-11-16 の合格の確かめ。棋譜は共有フォルダの `data/kifu/kukishiro-check/`、中身は `logs/kukishiro-check/MANIFEST.md`）:

```sh
# クキシロのクレストが自分のターンに誘発した回数（補正ごと）。前の profile の表と同じ数（v0 10.3・R1 12.1・R2 11.3・R3 10.3）
svwb kifu count data/kifu/kukishiro-check --where 'deck~クキシロ,source=profile' --event 'trigger crest~クキシロ own' --by agent
# R3 対 R2 の、アグロNi・クキシロB の絡む組の勝率（台帳の行と同じ 49.11% ± 0.90）と、クキシロB だけ（47.89% ± 2.54）
svwb kifu winrate data/kifu/kukishiro-check/compare-r3-r2-involving.jsonl.gz --where side=A
svwb kifu winrate data/kifu/kukishiro-check/compare-r3-r2-involving.jsonl.gz --where 'side=A,pair~クキシロB'
# クキシロのクレストを持った席の割合と、持った席の勝率
svwb kifu count data/kifu/kukishiro-check --where 'deck~クキシロ' --event 'crestIn crest~クキシロ' --by agent
svwb kifu count data/kifu/kukishiro-check --where 'deck~クキシロ' --event 'turnEnd pp>0 playable>0' --per turn
# ダストデイズのクレストを持って終えたターンと、そのうちあと 1 枚打てたのにコンボ 2 で終えたターン（2026-11-20。棋譜は共有フォルダの data/kifu/night-20261117-0328/）
svwb kifu count data/kifu/night-20261117-0328 --where 'deck~コンボE' --event 'turnEnd holds~ダストデイズ' --by agent
svwb kifu count data/kifu/night-20261117-0328 --where 'deck~コンボE' --event 'turnEnd holds~ダストデイズ combo=2 playable>0' --by agent
# 初手にあったダストデイズと、マリガンで返したダストデイズ（先攻・後攻ごと）
svwb kifu count data/kifu/night-20261117-0328 --where 'deck~コンボE' --event 'mulligan card~ダストデイズ' --by agent,first
svwb kifu count data/kifu/night-20261117-0328 --where 'deck~コンボE' --event 'mulligan card~ダストデイズ ret' --by agent,first
```

本体は `rust/engine/src/runner/kifu_cmd.rs`。

## ターン末の値（svwb kifu values）

棋譜を打ち直して、合った席（`--where`）のターン末（ターン終了を選ぶ直前で、選択の途中でないもの）ごとに、`--opts` の設定（compare と同じ JSON。既定は `{}`）の探索 AI が付ける値と、
その後の決着の印を 1 行ずつ JSON で出す（2026-11-21。補正と読みが相手の次のターンのリーサルを見分けているかの調べ。[ai-notes/14](ai-notes/14-2026-11-16.md)「補正と読みは相手の次のターンのリーサルを見分けているか」）。
棋譜を書いた AI と違う設定でも付けられる（R3 の試合の局面を R4 で採点する等）。試合は変えない。

| 項目 | 中身 |
| --- | --- |
| `file`・`g`・`swap`・`seat`・`deck`・`opp`・`side`・`agent`・`first` | 棋譜・試合・席（seats の行と同じ） |
| `turn`・`tc` | 全体のターン番号・その席の何ターン目か |
| `hp`・`oppHp`・`oppHand`・`oppMaxPp` | 自分と相手のリーダーの体力・相手の手札の枚数・相手の PP 最大値（比べるための単純な数） |
| `myAtk`・`oppAtk`・`myWard`・`oppWard` | 場のフォロワーの攻撃力の合計（攻撃できるかは見ない）・守護の数 |
| `won`・`endIn` | 試合に勝ったか・決着したターンまでのターンの数（このターンの終わりに決着なら 0。決着しなければ null） |
| `lostNext`・`wonNext` | 次の相手のターンに負けた（`endIn` 1 で相手の勝ち）・自分の次のターンに勝った（`endIn` 2 で自分の勝ち） |
| `finalSteps`・`finalMoves` | 決着したターンの行動の数（全部・選択とターン終了を除く。リーサルの長さの目安） |
| `end`・`endWin` | ビームがこのターン末に付ける点数（`SearchAgent::turn_end_value`。合流する相打ちとターン終了時の処理の後に評価し、残り PP の罰を引く）と、σ(a·点数) の勝率（%。a は `--opts` の補正のもの） |
| `readLoss`・`readWin`・`pickWin` | `--reads N` のときだけ。相手の手札を N 通り引き直して相手のターンを読んだ点数（`read_values`。探索の読み直しと同じ）のうち、相手のリーサルになった割合・引き直しごとに勝率にした平均・探索が選ぶときの値（読みとターン末を `rescoreMix` で混ぜた点数）を引き直しごとに勝率にした平均。引き直しの種は試合のシードとターン番号から作る（試合のときの種とは違う） |
| `readLethal`・`readLossL`・`pickWinL` | `--opp-lethal 1` のときだけ（`--reads` が要る）。読みの中の相手が、相手のターンの初めにリーサル探索（`--opts` の AI と同じもの。`SearchAgent::finds_lethal`）を先にしたら、の数。引き直しごとに、読みと同じ決定化の局面（`read_view`）でターンを終えて探す。リーサル探索が見つけた引き直しの割合・それを負けとした `readLoss`・`pickWin`（調べもの用。AI の振る舞いは変えない） |

- 速さ（クラウド環境の 4 スレッド）: 新しいプールの 600 試合・ターン末 1 万で、`--reads 12` 込みで 18 秒、`--opp-lethal 1` も付けると 5 分半（リーサル探索が引き直しごとに走る）
- 打ち直せない試合・勝者の違う試合は書かず、count と同じく数を出す

`svwb profile` の報告の「仕組みを使った回数」「PP を残して終えた」「クレストの能力が誘発した回数」も、打った試合をこの出来事の列にして、
同じ書き方の出来事で数える（2026-11-16 から。`rust/engine/src/runner/profile.rs` の `USAGE`）:

| 列 | 出来事 |
| --- | --- |
| プレイ・アクセラレート・結晶・エンハンス | `play`・`play mode=accelerate`・`play mode=crystal`・`play mode=enhance` |
| 奥義・解放奥義 | `play ougi=1`・`play ougi=2` |
| 進化・超進化（と最初のターン） | `evolve ep`・`superEvolve ep` |
| 融合・アクト・エクストラPP | `fuse`・`act`・`extraPp` |
| リーダー・フォロワーへの攻撃 | `attack target=leader`・`attack target!=leader` |
| PP を残して終えた（とプレイできたカード） | `turnEnd pp>0 playable>0` |
| クレストの誘発・持った席 | `trigger crest`（`ab`・`own` で分ける）・`crestIn crest` |

compare の `--involving`（ある型の絡む組だけを打つ）は消した。全部の組を打った回の棋譜を `svwb kifu winrate --where 'side=A,pair~<型>'` で絞る（同じ試合番号は同じ試合なので、同じ数になる）。
