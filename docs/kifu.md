# 棋譜

対戦を打つランナーは、試合ごとの棋譜を 1 つの形で書く（2026-11-16 から）。調べ物は、専用の処理をランナーに足すのでなく、
この棋譜を打ち直して数える形にそろえていく（審査の文書「AI の設計の審査と今後の方針」のタブ「棋譜を 1 つの形にそろえる」。段取りの 1 がここ）。

- 書くのは `compare`・`yardstick`・`profile`・`td selfplay`（svwb。`npm run compare` 等も同じ）。打つ手・試合は変わらない
- 本体は `rust/engine/src/runner/kifu.rs`。開発サーバーの「リプレイ検索」タブ（`docs/commands.md`「リプレイ検索」）もこの形を読む
- 名前は「棋譜」（コマンドと引数は `kifu`。ユーザー決定 2026-11-16）。前の名前の「リプレイ」（`--replays`）も引数としては使える

## どこに書くか

| 場合 | 書く先 |
| --- | --- |
| 何も付けない | 環境変数 `SVWB_KIFU_DIR` のフォルダ（無ければ `~/svwb-data/kifu/`）に、下の名前で |
| `--kifu <ファイル>`（前の名前 `--replays`） | そのファイル |
| `--no-kifu` | 書かない |
| 夜のキュー（`npm run night`） | 回のフォルダの `kifu/`（キューが `SVWB_KIFU_DIR` を渡す）。区切りが済むと `.jsonl.gz` にする。`--kifu`・`--no-kifu` はキューの行には書けない |

- 既定の名前は `<種類>-<回の名前>-g<最初>-<最後>-<引数の指紋>-<コミット>.jsonl`（回の名前は `--label`。無ければ飛ばす。引数の指紋は、棋譜の引数を含む
  引数の並びの FNV-1a）。同じ引数・同じコミットなら同じ名前で、同じ試合なので上書きする。設定だけが違う回（夜のキューの 2 つの profile 等）は指紋で分かれる
- 書いている間は `<ファイル>.tmp` に書き、全部の試合を書き終えてから名前を替える。途中で止まった回は `.tmp` のまま残る（`pack-run` は入れない）
- 終わると、書いたファイルと試合の数を出す（`棋譜: <ファイル>（N 試合）`）。compare・yardstick は、台帳の行の `kifu` にもファイルを書く
- `profile` は、`--baseline` を渡した回（`npm run profile` の測るビルドの方。試合は測らないビルドと同じ）では、`--kifu` が無ければ書かない
- 0 試合（夜のキューが設定を確かめる回）は書かない
- 大きさは 1 試合 4〜5 KB（gzip で 0.4 KB ほど）。新しいプールの compare 1.2 万試合で 60 MB ほど（gzip で 5 MB ほど）、自己対戦 6 万試合で 300 MB ほど（gzip で 30 MB ほど）

## 持ち帰り方（夜のキュー）

- 朝の `npm run night -- finish --pack` が、ログと一緒に棋譜もまとめる（`pack-run --only logs,kifu`）
- `npm run pack-run` は、フォルダの中の `kifu/` の下と、1 行目が `{"kind":"replay", …}` の `.jsonl` を棋譜として `data/kifu/<名前>/` に入れる。
  共有フォルダに展開すると `/mnt/project-files/data/kifu/<名前>/` に入る

## 1 行の形（版 2）

1 行 1 試合の JSON。項目はこの順に書く。

| 項目 | 中身 |
| --- | --- |
| `kind` | `"replay"` |
| `version` | 形の版。2（2026-11-16 から）。1 は前の `--replays` の行（下） |
| `source` | 書いたランナー（`"compare"`・`"yardstick"`・`"profile"`・`"td selfplay"`） |
| `run` | 回の名前（台帳の名前 `--label`。無ければ空） |
| `engine` | エンジンの版（コミット。手元の変更があれば末尾に `+`。夜のキューは組み立てたときのもの。台帳の `commit` と同じ） |
| `pool` | カードプール（`"starter"`・`"azvaldt"`。両方のデッキのカードが入るプール。ベーシックだけなら `"starter"`。どちらにも入らなければ `"mixed"`） |
| `g` | 試合番号 |
| `swap` | 組（同じ試合番号で席とデッキを入れ替えた 2 試合）のどちらか。組の相手は、同じ回の同じ `g` で `swap` の違う試合。自己対戦（組が無い）には無い |
| `names` | 席ごとのデッキの名前 |
| `agents` | 席ごとの表示名（compare は `"A <設定>"`・`"B <設定>"`、yardstick の相手は `"B <物差しの名前>"`、profile は `"profile <設定>"`、自己対戦は `"td"`・`"td-frozen"`） |
| `sides` | 席ごとの側（compare・yardstick は `"A"`（測る側）・`"B"`（相手）、自己対戦の `--frozen` は `"learner"`・`"frozen"`）。比べでなければ無い |
| `ai` | 席ごとの AI の設定。compare・profile は渡した設定の JSON（`{}` は今の既定）、yardstick の相手は `{"yardstick": <名前>, "version", "fingerprint"}`、自己対戦は `{"model", "eps", "sampling", "opp", "potential"}`（固定した側は `--frozen` の設定）、profile の `--rhino` のリノセウスエルフは `{"rhino": true}` |
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
