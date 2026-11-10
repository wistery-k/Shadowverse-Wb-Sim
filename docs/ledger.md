# 実験の台帳（`docs/ledger.jsonl`）

AI の実験の結果を、1 行 1 件の JSON（JSON Lines）で残す台帳。2026-11-10 から。

- 数字を記録の文章に書き写さずに済むようにする（書き写しの間違いをなくす）
- 同じ比べの回を、後から足し合わせられるようにする
- 「どの項目がいつ、どの数字で既定に入ったか」を検索できるようにする（採否の行）

今の状態のまとめは [STATE.md](STATE.md)、詳しい記録は [ai-notes.md](ai-notes.md) と [ai-notes/](ai-notes/)。
台帳は足すだけで、前の行は書き換えない。判定が変わったら、同じ項目の行を新しく足す（後の行が今の判定）。

## 行の種類

### 回の行（`compare`・`yardstick`）: ランナーが自動で書く

`npm run compare`・`npm run yardstick` は、回すたびに 1 行足す（`rust/engine/src/runner/ledger.rs`）。

- `--label <名前>` で名前を付ける（yardstick は前からある `--label`）。後で `--label`・`--from-label` で引くので、比べの案ごとに付ける
- `--no-ledger` で書かない（動くかの確かめなど、残さない回）
- 書く先は環境変数 `SVWB_LEDGER` で替えられる（既定は `docs/ledger.jsonl`）
- 回した後は、増えた行を作業ブランチにコミットする（ユーザーの PC の Docker で回したときも、`/workspace/docs/ledger.jsonl` に足される）
- `.gitattributes` で `merge=union` にしてあるので、ブランチどうしで行を足し合っても、手元の `git merge` では衝突しない
  （GitHub の画面で衝突と出たら、手元で main をマージして push する）
- 書けたときは何も出さない（出力は前と同じ。ジョブが読む最後の行を変えないため）。書けなければ注意を出す（結果は失わない）
- `cloud/jobs/` のジョブも、回したチェックアウトの `docs/ledger.jsonl` に足す（速さだけを測る `bench.sh`・`bench-scale.sh` は `--no-ledger`）
- 夜のキュー（`npm run night`、[night.md](night.md)）は、区切りごとの行を回のフォルダの台帳（`SVWB_LEDGER`）に書き、朝の `finish` が
  ジョブの続いた区切りを 1 行にまとめてこの台帳に足す（1 回で回したときと同じ勝ち数・組・誤差。`queue`・`chunks` が付く）。
  コミットとブランチは環境変数 `SVWB_COMMIT`・`SVWB_BRANCH` で渡した、キューを組み立てたときのもの

| 項目 | 中身 |
| --- | --- |
| `v` | 形の版（1） |
| `kind` | `compare` か `yardstick` |
| `date`・`at` | 回し終えた日（マシンの時刻帯）と、UTC の時刻 |
| `commit`・`branch` | コミット（コミットしていない変更があれば末尾に `+`。台帳と物差しの表の変更は数えない）とブランチ |
| `label` | `--label` の名前（無ければ空） |
| `a`・`b` | 両方の設定（渡した JSON のまま）。yardstick の `b` は相手（`classic`・`strong`） |
| `vs`・`replays` | compare の B のデッキの絞り込み（5 番目の引数）と `--replays` のファイル（無ければ null） |
| `refVersion`・`refFingerprint`・`refFingerprintOk`・`recorded` | yardstick の相手の版・指紋・指紋が記録と合ったか・`--record` で表に足したか |
| `files` | 設定の中のファイル（`"valueNet":"tpa.json"` 等）の中身の指紋。同じ名前で中身の違うファイルを見分ける |
| `decks` | 使った 7 デッキ |
| `mirror` | 組の 2 試合を同じシードで打ったか（compare の既定と強い相手の物差しは true） |
| `g` | 最初と最後の試合番号（1 つの番号で席とデッキを入れ替えて 2 試合。シードは番号から決まる） |
| `n`・`wins`・`rate` | 試合の数・A の勝ち数・A の勝率（0〜1） |
| `se`・`seKind` | A の勝率の標準誤差（0〜1）と出し方（`pairs`: 組の勝率のばらつき、`binomial`: 試合ごと。弱い相手の物差しだけ） |
| `pairs` | A の勝ち数が 0・1・2 の組の数 |
| `perDeck` | A のデッキごとの [勝ち, 試合数] |
| `seconds`・`perGame` | かかった時間（秒）と 1 試合あたり |
| `threads`・`machine` | 並列数とマシン（環境変数 `SVWB_MACHINE`、無ければホスト名。PC の Docker は `svwb-docker`） |
| `cmd` | 回したコマンド（`svwb` の後ろ。シェルにそのまま貼れる形）。夜のキューのまとめた行は、1 回で回すときのコマンド |
| `queue`・`chunks` | 夜のキューのまとめた行だけ: 回の名前と、まとめた区切りの数（`seconds` は区切りの和） |

### 見落とし問題集の行（`misses`）: ランナーが自動で書く

`npm run misses -- run`（[misses.md](misses.md)）も、回すたびに 1 行足す（`--label`・`--no-ledger`・`SVWB_LEDGER` は回の行と同じ。
`--only` で問を絞った回は書かない）。試合ではなく問の合格を数えるので、回の行とは形が違い、`runs`・`sum` には出ない（`npm run ledger -- misses` で引く）。

| 項目 | 中身 |
| --- | --- |
| `v`・`date`・`at`・`commit`・`branch`・`label`・`a`・`files` | 回の行と同じ（`a` は AI の設定） |
| `kind` | `misses` |
| `problems`・`set` | 問の数と問題集の指紋（問の名前と中身。問を足す・直すと変わる。指紋の違う回の正解率はそのまま比べない） |
| `trials`・`seed` | 1 問を打つ回数と乱数の元 |
| `n`・`passes` | 打った回数（問の数 × 回数）と合格した回数 |
| `rate`・`se` | 正解率（問ごとの合格率の平均、0〜1）と標準誤差（問ごとの合格率のぶれから。問題集は決まったものとして） |
| `perProblem` | 問ごとの [合格, 回数] |
| `seconds`・`threads`・`machine`・`cmd` | 回の行と同じ |
| `queue`・`chunks` | 夜のキューで回した行だけ: 回の名前と区切りの数（いつも 1） |

### 採否の行（`decision`）: `npm run ledger -- decide` で足す

採否を決めたら 1 行足す。初めの 32 行は、2026-11-10 の既定に入っている項目を記録から写したもの（`"source":"notes"`）。
それより前の不採用の実験は台帳に入れていない（記録の索引にある）。

| 項目 | 中身 |
| --- | --- |
| `date` | 決めた日（TypeScript 版のころで記録に日付が無いものは null） |
| `item` | 項目の名前 |
| `decision` | `採用`・`不採用`・`保留`・`やめた` |
| `inDefault` | この判定の後、今の既定に入っているか |
| `keys` | 関わる設定の名前（`SearchOptions` の JSON の名前、`td` の引数等） |
| `vs` | 比べた相手（ふつうは当時の既定） |
| `result` | `{n, rate, se}`（勝率と誤差は 0〜1）。直接の比べでない数字（デッキ 1 つと他の比べ、マリガンの組等）は null にして `note` に書く |
| `labels` | 結果を足し合わせた回の名前 |
| `note` | 一言（思考の倍率、ユーザー判断か、等） |
| `ref` | 詳しい記録の節（`docs/ai-notes/<ファイル>「節の名前」`） |
| `source` | `notes`（記録から写した）・`runs`（台帳の回から計算した）・`manual`（手で書いた） |

## 表にする（`npm run ledger`）

```sh
npm run ledger                                   # 回の一覧（Markdown の表）
npm run ledger -- runs --label 幅 --since 2026-11-10 --kind compare --last 20
npm run ledger -- runs --grep potentialNet       # 行の JSON のどこかに含む（大文字小文字を区別しない）
npm run ledger -- sum --label 幅                  # 同じ比べ（種類・両方の設定・デッキ・鏡・相手・コミット）の回を足し合わせる
npm run ledger -- sum --any-commit               # コミットが違っても足す（手が変わらない変更をまたぐとき）
npm run ledger -- misses --label 定例             # 見落とし問題集の回（正解率と問ごとの合格）
npm run ledger -- items --in-default             # 今の既定に入っている項目と、採ったときの数字
npm run ledger -- items --grep drawSplit --all   # 項目の判定の移り変わり
npm run ledger -- decide --item '自分のターンのビームを幅 256 に' --decision 採用 --from-label 幅256 \
  --keys beamWidth --ref 'docs/ai-notes/12-2026-11-05.md「…」' --note '思考 1.08 倍'
npm run ledger -- check                          # 全部の行が形に合うか（npm test でも確かめる）
```

- `sum` は、回ごとの標準誤差を試合数で重みを付けて合わせる（回どうしは別の試合番号の前提）。試合番号が重なる回は「重なりあり」と出す（同じ試合を 2 回数えている）
- `decide --from-label` は、その名前の回を足し合わせた結果を `result` に入れる。違う比べが混ざる・試合番号が重なるときはエラーにする
- `decide` の `--in-default` は、既定は `採用` なら true、それ以外は false
- `grep` でも引ける（1 行 1 件なので `grep -n beamWidth docs/ledger.jsonl` で足りることが多い）
