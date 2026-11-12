# 夜のキュー（`npm run night`）

ユーザーの PC で対戦を回すのは、夜だけ、それもユーザーが「今夜は回す」と決めた夜だけ（昼はゲームがカクつく。夜も電源を切る日がある。2026-11-10）。
そのための道具が夜のキュー。ジョブを並べたファイルを上から順に、5〜10 分の区切りに分けて回し、区切りごとに結果を残す。

- 始めるのは `start`・`resume` だけ。PC やコンテナの起動で勝手には始まらない
- 電源が切れても、失うのは回していた区切りだけ。次に回すと決めた夜に `resume` で続きから回る
- 朝の決めた時刻（既定 07:00、東京）までに次の区切りが終わらない見込みなら、区切りの切れ目で止まる。手で止めるのは `stop`
- 回す本体は、セッションから切り離して立てる（`setsid`）。Remote Control のセッションが終わっても続く
- 本体は `scripts/night-main.ts`。テストは `tests/night.test.ts`（svwb の代わりに台帳の行だけを書く偽物で、区切り・再開・止め方・まとめを確かめる）

## 1 晩の流れ

1. **昼（クラウドのスレッド）**: 変更を作業ブランチに push し、ジョブのファイルを書く（下の「ジョブのファイル」。ブランチの `night/` に置いてコミットする）。
   `npm run night -- plan <ファイル> --machine svwb-docker` で PC での見込みを出し、表をそのまま見せて「今夜これを回してよいか」を 1 回だけ聞く。
   承認は 1 晩分まとめて取る（CLAUDE.md「実験を回す場所」）。キューの中のジョブを 1 つずつは聞かない
2. **夜（ユーザーが「今夜は回す」と言ったら）**: PC の Docker の Remote Control（`svwb-docker-…`）で、ブランチを取り込んでから
   `npm run night -- start <ファイル> --yes`。svwb を組み立て（数分）、設定の書き間違いを確かめてから、切り離して回し始めて戻る。
   ユーザーが自分で始めるなら、ホストの `docker/remote-control` で `docker compose exec rc npm run night -- start <ファイル> --yes`
3. **朝**: `npm run night -- status` で様子を見て、`npm run night -- finish --commit` でジョブごとに 1 行にまとめて台帳に足し、台帳だけをコミットする
   （下の「台帳の行のコミット」）。push はホストで
4. **途中で止まった回の続き**: 次に回すと決めた夜に `npm run night -- resume --yes`（済んだ区切りを飛ばす）

1 晩に回すキューは 1 つ（動いている回があれば `start`・`resume` は断る）。1 つのキューは 1 つのコミットで回す。
違う版どうしは、新しい読み方を設定の項目にして既定を切っておけば、同じコミットの compare で比べられる（今までと同じ）。

## コマンド

```sh
npm run night -- plan <ジョブのファイル> [--until 07:00] [--threads N] [--machine 名前] [--chunk-min 7.5] [--tz Asia/Tokyo]
npm run night -- start <ジョブのファイル> --yes [--name 名前] [--until 07:00] [--threads N] [--chunk-min 7.5] [--allow-dirty]
npm run night -- status [名前]
npm run night -- stop [名前] [--now]
npm run night -- resume [名前] --yes [--until 07:00] [--threads N]
npm run night -- finish [名前] [--commit] [--pack] [--ledger 台帳]
npm run night -- list
```

| 引数 | 既定 | 意味 |
| --- | --- | --- |
| `--until` | `07:00` | 止める時刻。`HH:MM` は時刻帯（`--tz`、既定 `Asia/Tokyo`。コンテナの時計は UTC）で次に来るその時刻。`+90m`・`+2h`（今から）や ISO の日時も書ける |
| `--threads N` | そのマシンの全部 | 使うスレッド数（svwb の `THREADS`）。結果は変わらず、速さだけが変わる。`resume` で替えてもよい |
| `--machine 名前` | このマシン | `plan` の見込みに使うマシン（PC は `svwb-docker`）。そのマシンの決めておいたスレッド数も使う |
| `--chunk-min` | 7.5 | 区切りのおよその長さ（分）。見込みから区切りの大きさを決める |
| `--name` | `night-<日付>-<時刻>` | 回の名前（フォルダの名前） |
| `--yes` | なし | 付けないと、計画の表を出すだけで始めない。付けるのは、ユーザーが今夜回すと決めた後だけ |
| `--allow-dirty` | なし | コミットしていない変更があっても始める（試すとき用。ふつうは push してから回す） |
| `stop --now` | なし | 回している区切りをすぐ止める（その区切りは次の `resume` で回し直す）。付けなければ、回している区切りが終わってから止まる |
| `finish --commit` | なし | 足した台帳（`docs/ledger.jsonl`）だけをコミットする。push はしない |
| `finish --pack` | なし | 回のフォルダを `pack-run --only logs` でまとめる（`~/svwb-upload/<名前>.tar.gz`。共有フォルダに上げる用） |

回は `~/svwb-data/night/<名前>/` に置く（環境変数 `SVWB_NIGHT_DIR` か `--root` で替えられる）。名前を省くと、`status`・`finish` は最後の回、
`stop` は動いている回、`resume` は済んでいない最後の回を選ぶ。

## ジョブのファイル

1 行 1 ジョブで、svwb のコマンドと同じ形（`compare`・`yardstick`・`profile`・`misses`・`survey`。行の頭の `svwb` は書いても書かなくてもよい）。
`#` から行の終わりまでは書き添え。上から順に回す。例:

```sh
# 定例（night/routine.txt を先頭に写してもよい）
yardstick --ref strong --opts '{}' --games 4000 --start 0 --label 定例-強い相手
# 補正の入れ替え（1.1 万試合で 1 ポイントを見る）
compare 5600 '{"valueNet":"data/models/x.json"}' '{}' 200000 --label 補正x
profile --games 49
```

- **compare**: `compare <試合数> '<A>' '<B>' [最初の試合番号] [B のデッキ] [--no-mirror] [--decks …] --label 名前`（`npm run compare` と同じ）
- **yardstick**: `yardstick [--ref classic|strong] [--opts '<設定>'] [--games 1000] [--start 0] --label 名前`
- **profile**（速さ）: `profile [--opts '<設定>'] [--games 49] [--start 0] [--rhino]`。結果は回のフォルダの `speed-<番号>.md`・`.json`（`svwb profile` の報告）
- **misses**（見落とし問題集、`docs/misses.md`）: `misses [run] [--opts '<設定>'] [--trials 24] [--seed 1] --label 名前`。分けずに 1 区切りで回す。
  見込みの「1 試合」は、全部の問を 1 回ずつ解く秒（台帳の前の回から、問の数の違いを割り直して見込む）。`--only`・`--dir`・`--out` は使えない（問題集全体を解く）
- **survey**（候補の打ち比べ調査、`docs/survey.md`）: `survey [run] --games a-b [--rate 0.1] [--m 32] [--extra 4] [--confirm 96] [--flag 10] [--batch 8] --label 名前`
  （`--games N --start S` でもよい）。試合番号の範囲で区切り、どの区切りも回のフォルダの `survey-<番号>.jsonl` に足す（1 つの番号で 1 試合。
  見込みの「1 試合」は、その試合から取った局面の打ち比べを含む秒）。区切りごとの台帳の行は無く、ジョブの区切りが全部済んだ後の `finish` が
  `svwb survey report` で 1 行を足す（報告は `survey-<番号>.md`、問題集に足す候補の局面は `survey-<番号>-states/`）。`--out` は使えない
- `--label` は compare・yardstick・misses・survey に要る（区切りの結果を後で足し合わせ、台帳を引くため）。比べの案ごとに付ける
- 試合番号（シード）の範囲は、前の回と重ならないように選ぶ（同じ試合を 2 回数えない。`npm run ledger -- runs --grep <名前>` で前の範囲を見る）
- キューでは使えない引数: `--no-ledger`（結果は台帳から集める）・`--replays`（区切りごとにファイルが替わる）・`yardstick --record`
  （物差しの表に足すのは、終わった後に足し合わせた数字で）・`profile --json/--report/--baseline/--record`（キューが回のフォルダに書く）
- `--est <秒>`: 1 試合の見込みの秒（回すマシン・スレッド数で）。キューだけが読む。読み方を大きく変える設定（深い読み等）で、台帳にまだ回が無いときに

## 見積もりと区切り

1 試合の秒を、次の順に見積もる。

1. `--est`
2. 台帳（`docs/ledger.jsonl`）の、同じ比べ（種類・両方の設定・絞り込み・鏡・相手）・同じマシンの最近の 5 回。同じスレッド数の回があればその速さ、
   無ければスレッド秒（1 試合の秒 × スレッド数）で割り直す。夜のキューの回もマシン（`svwb-docker`）とスレッド数を台帳に書くので、回すほど当たる
3. 決めておいた値（`scripts/night-main.ts` の `SPEEDS`。PC は compare 3200 試合 5 分ほど・物差しは `docs/yardstick.md` の「（PC）」の行から、
   クラウド環境は 2026-11-10 に測った値。どれも今の既定どうし。設定が違えば「設定の違いは見ていない」と出る。
   survey は 2026-11-11 にクラウド環境で小さく試した値（`docs/survey.md`「速さ」）で、局面の割合（`--rate`）にだけ比べる）

区切りの大きさは、見込みで `--chunk-min` 分ほどになる組の数（大きさはそろえる）。区切りは `start` のときに決めて `plan.json` に書き、
`resume` でも同じ区切りを使う。回の途中では、そのジョブで済んだ区切りの速さで次の区切りの長さを見込む。

## 止まり方と再開

| こと | どうなるか |
| --- | --- |
| 区切りが済んだ | 台帳の行（回のフォルダの `ledger.jsonl`）を書いた後、`done/<区切り>.json` の印を書く（どちらも fsync） |
| 止める時刻 | 区切りを始める前に、「今 + その区切りの見込み」が止める時刻を過ぎるなら止まる。見込みが外れて止める時刻を 15 分過ぎても終わらない区切りは止める（その区切りは失う） |
| `stop` | 回している区切りが終わったら止まる（`STOP` を置く。`resume` で消える） |
| `stop --now` | 回している区切りを止める（その区切りは失う） |
| 電源が切れた・コンテナが止まった | 回していた区切りを失う。`status` は「止まっている（電源が切れたか、途中で落ちた）」。`resume` で続きから |
| 台帳の行を書いた直後に電源が切れた（印が無い） | `resume` で、台帳に同じ引数の行があれば回さずに印を作る（survey は、出力に区切りの試合が全部あれば） |
| survey の区切りが途中で止まった | 書いた試合（`--batch` 試合ごとに書く）は残る。`resume` で回し直すと、出力に既にある試合を飛ばして続きから |
| 区切りが失敗した（svwb が 0 以外で終わった） | そのジョブの残りを飛ばし、次のジョブへ。`status` の「メモ」に出る。`resume` でやり直す |

- 回すのは `start` のときに回のフォルダに写した svwb（`bin/svwb`）。夜の間にほかのセッションが同じ `/workspace` で組み立て直しても、
  `resume` が次の夜でも、同じコードで回る。台帳の行のコミットとブランチも `start` のときのもの（`SVWB_COMMIT`・`SVWB_BRANCH`）
- 設定の中のファイル（`"valueNet":"…json"` 等）は、回すたびにリポジトリから読む。夜の間はそのファイルを替えない（台帳の `files` に中身の指紋が残る）
- コンテナ（`docker/remote-control`）が止まると、中のキューも止まる。`compose.yaml` は、`claude remote-control` が終わっても（ネットワークが切れた等）
  コンテナを止めずに中で立ち上げ直す形にしてある（2026-11-10。前の形では、`claude` が終わるとコンテナごと立ち上げ直り、キューが止まった）。
  この形にするには、一度ホストで `docker compose up -d` を流してコンテナを作り直す。PC の再起動・`docker compose down`・作り直しでは止まる（`resume` で続きから）
- 2026-11-12 の朝（打ち比べ調査の本番、58 区切りの 57 番目の途中、05:19）に、PC の電源は入ったまま Docker が止まっていた。
  コンテナから見えるカーネル（WSL2 の VM）は朝に起動し直されていて、コンテナだけでなく VM ごと止まっていた。Windows Update の更新が原因らしい（ユーザーの見立て）。
  失ったのは回していた区切りの書いていない 7 試合だけで、朝に `resume` で残り 9 試合を回した。
  ユーザーが同じ日に Windows Update の「アクティブ時間」を夜を含むように設定した（その間は更新による自動の再起動をしない。再起動の要らない更新まで止まるかは分からない。
  長い回の夜に止まるのが続くなら、その夜だけ「更新の一時停止」も足す）。止まった朝は `/proc/uptime` で、VM ごと止まったのか worker だけが落ちたのかを見分ける

## 回のフォルダ（`~/svwb-data/night/<名前>/`）

| ファイル | 中身 |
| --- | --- |
| `plan.json`・`jobs.txt` | 計画（ジョブ・区切り・見込み・コミット）と、渡したジョブのファイルの写し |
| `session.json` | 今の `start`・`resume` の設定（止める時刻・スレッド数・マシン） |
| `night.log` | 進み具合（区切りごとに始め・済み・失敗。時刻は `--tz`） |
| `status.json`・`worker.pid`・`STOP` | 本体の今の状態・pid・止める印 |
| `ledger.jsonl` | 区切りごとの台帳の行（svwb が `SVWB_LEDGER` に書く） |
| `done/`・`chunks/`・`failed.json` | 済んだ区切りの印・区切りごとの svwb の出力・失敗したジョブ |
| `speed-<番号>.md`・`.json` | profile の報告 |
| `survey-<番号>.jsonl`・`.md`・`-states/` | survey の局面ごとの結果（全部の区切りが足す）・`finish` が出す報告・問題集に足す候補の局面 |
| `ledger-jobs.jsonl`・`summary.md`・`merged.json` | `finish` がまとめた行・まとめの表・台帳に足した区切り |
| `bin/svwb` | 回す svwb の写し（`pack-run` には入らない） |

## 台帳の行のコミット（決めたこと、2026-11-10）

- キューは commit も push もしない。夜の間は、回のフォルダの `ledger.jsonl` にだけ書く（リポジトリの台帳を夜の間に触らないので、
  同じ `/workspace` でほかのスレッドが作業しても混ざらない）
- 朝の `finish` が、ジョブの済んだ区切りを、試合番号の続いたまとまりごとに 1 行にまとめて、リポジトリの台帳（`docs/ledger.jsonl`）に足す（misses は区切りの行に `queue`・`chunks` を足してそのまま写す）。
  まとめた行は、同じ試合番号を 1 回で回したときと同じ勝ち数・組の数・誤差になる（組の勝率のばらつきから出し直す。クラウド環境で確かめた）。
  survey は、ジョブの区切りが全部済んでから `svwb survey report` の行に `queue`・`chunks` を足して 1 行（途中なら `finish` の表の下に「まだ途中」と出る）。
  `queue`（回の名前）と `chunks`（区切りの数）が付き、`cmd` は 1 回で回すときのコマンド。区切りごとの行は回のフォルダに残る
- 2 回 `finish` しても、同じ区切りは 2 回足さない（`merged.json`）。途中で止まった回は、済んだ分だけ足し、続きを回した後の `finish` で残りを足す
- `--commit` で `docs/ledger.jsonl` だけを、チェックアウトしているブランチにコミットする（ふつうはキューのブランチ。違えば `finish` の表に出るコミットで見分ける）。
  コンテナには GitHub の認証情報が無いので、push はユーザーがホストで（`git push`）
- コミットには git の名前とメールが要る。コンテナでは `docker/remote-control/.env` に `GIT_AUTHOR_NAME`・`GIT_AUTHOR_EMAIL`・`GIT_COMMITTER_NAME`・
  `GIT_COMMITTER_EMAIL` を書き、ホストで `docker compose up -d` を流しておく（2026-11-11 の初めての試しでは入っていなかった）。
  `finish --commit` は台帳に足す前にこれを確かめ、決まらなければ何も足さずに止まる。足した後でコミットが失敗したときは、直して `finish --commit` を
  流し直せば、前に足したこの回の行をコミットする
- push されるまでは、`finish` が出す表（`summary.md`）の数字をスレッドに貼って使う。採否を決めるとき（`npm run ledger -- decide --from-label`）は、
  push された台帳から引き直す

## 定例（`night/routine.txt`）

物差し 2 つと速さと見落とし問題集を測るジョブのファイル。既定を変えた後の夜に、キューの先頭に置く（毎晩でなくてよい）。PC で 20 分ほど。

- 弱い相手の物差し `yardstick --ref classic` と強い相手の物差し `--ref strong` を、それぞれ g0〜3999（8000 試合。誤差 0.4〜0.5 ポイントほど）。
  台帳の名前は `定例-弱い相手`・`定例-強い相手`。前に物差しの表に足した g0〜999 の試合を含む
- 速さ `profile --games 49`（`docs/profile.md` と同じ 98 試合）
- 見落とし問題集 `misses --trials 24 --seed 1`（台帳の名前は `定例-見落とし問題集`。PC で 1 分かからない）
- 結果は `npm run ledger -- runs --label 定例`・`npm run ledger -- misses --label 定例` で引き、`docs/STATE.md` の「追う数字」を直す。物差しの表（`docs/yardstick.md`）に足すのは、採用した版だけ（今までどおり）

## 長い回（自己対戦・学習）を区切れるか（2026-11-10 に調べた）

今のキューに入れられるのは compare・yardstick・profile・misses・survey だけ。自己対戦と学習は、今までどおり `cloud/jobs/relearn.sh` 等を回すと決めた夜に流す。

- **`td selfplay`**: コマンドの中には再開の仕組みが無い（`--out` を最初から書き直し、終わった順に書く）。ただし試合は番号（`--start` から）とモデルで決まるので、
  番号の範囲で分けて別のファイルに書けば、1 回で回したのと同じ試合の集まりになる（6 試合を 1 回と 3＋3 で回し、行を並べ替えると一致した）。
  `relearn.sh` は `CHUNK` 試合ごとに `s<i>.jsonl.gz` に残して済んだファイルを飛ばすので、もう区切って再開できる。
  PC で `CHUNK=3000`（介入の試合を含む）が 13〜16 分（relearn9 の `relearn-t.log`）なので、`CHUNK=1500` にすれば 1 区切り 7 分ほど
- **`td train`**: 再開できない。学んだ重みは最後にだけ書き、途中の状態（エポックごとの重み・乱数・一番良かったエポック）を残さない。
  `--seed` が同じなら最初からやり直して同じモデルになる。PC で 60000 試合・3 エポックが 27 分（relearn9 の `t-train.log`、1646 秒）。
  エポックの終わりに重みと乱数を書き出せば、エポックの切れ目（9 分ほどごと）から再開できる（直すかは決めていない）
- **`relearn.sh` のほかの段**（間引き・埋め・見込みのデータ・見込みの学習・比べ）: 段ごとに出力のファイルがあれば飛ばすので、段の切れ目から再開できる。
  比べ（compare・yardstick）は 1 段が数分〜十数分
- キューに入れるなら、ジョブの種類に「シェルのジョブ」（`CLOUD_W` を渡して流し、止める時刻には止めて、次の夜に流し直す）を足すのが近道。
  止めたときに失うのは、そのとき回していた段（学習なら最大 27 分）
