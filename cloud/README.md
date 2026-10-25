# クラウドの Spot VM で対戦を回す

meta.sh や自己対戦のような重いジョブを、Google Cloud の Spot VM（既定は c3d-highcpu-360、360 スレッド）で回すためのスクリプト。
対戦は試合ごとに独立していて、1 スレッドあたりのメモリは 25 MB ほどなので、スレッドの多いマシンほどそのまま速くなる。
計画と見積もり（ユーザーの PC の 15〜25 倍、meta の 1 回りが 10 分ほど・1 時間 3.1 ドル）はプロジェクトの Claude Doc
「クラウドのスポットインスタンスで対戦を回す計画」（2026-10-25）にある。

- `cloud/gcp.sh`: 動かす側（Claude のクラウド環境か、ユーザーの PC）で使う。ソースを包んで送り、VM を立て、見張り、結果を取り出す
- `cloud/vm-startup.sh`: VM が起動したときに流れる。ツールを入れてビルドし、ゴールデンテストを通してからジョブを流す
- `cloud/vm-shutdown.sh`: Spot の中断（30 秒前の知らせ）で流れ、作業フォルダの小さいファイルを写す
- `cloud/jobs/`: ジョブの例（`bench.sh`: 速さを測る）
- `cloud/setup-billing-cap.sh`: 月の費用が予算を超えたら課金を外す仕組みを作る（Cloud Shell で一度だけ流す。「費用の上限」）

## 仕組み

```
動かす側 ──(1) ソース・ジョブ・入力を送る──▶ gs://<バケット>/runs/<名前>/ ◀──(3) 作業フォルダを 3 分ごとに写す── Spot VM
         ──(2) VM を立てる・消えたら作り直す────────────────────────────────────────────────▶ （終わったら DONE を書いて自分を消す）
         ◀─(4) 結果（作業フォルダ）を取り出す──
```

置き場所（`gs://<バケット>/runs/<名前>/`）の中身:

| 名前 | 中身 |
| --- | --- |
| `src.tar.gz`・`commit` | 送ったコミットのソース（`git archive`）と、そのコミット |
| `job.sh`・`job.env` | ジョブと、`--env` で渡した環境変数 |
| `run.env` | マシン・ゾーン・上限の時刻など（`watch` が作り直しに使う） |
| `vms.log` | 立てた VM（番号・ゾーン・時刻） |
| `work/` | 作業フォルダ。`--input` の入力もここに入る。ログは `cloud.log`（VM の動き）・`build.log`・`job.log` |
| `DONE`・`FAILED`・`STOPPED` | 終わり・失敗・止めたことの印 |

### 止められたとき

- VM は Spot で、止められると消える（`--instance-termination-action=DELETE`）。`watch` が 1 分ごとに見て、VM が無く、印も無ければ
  次の番号の VM を立てる（`--zones` の順に、立てられるゾーンを探す）
- 新しい VM は `work/` を戻してから、ジョブを最初から流す。ジョブは終わった部分を飛ばすので、続きから回る
- VM は最初にゴールデンテスト（`svwb golden`、1〜2 分）を通す。別の CPU で試合の結果がずれていれば、ここで FAILED になる
- 1 回の上限: `--hours`（既定 4 時間）は、最初の VM から数えた上限の時刻。どの VM もその時刻で必ず消え（`--max-run-duration`）、
  `watch` もそれ以降は作り直さない。立てる VM の数も `--max-vms`（既定 6）まで。延ばすときは `watch <名前> --extend <時間>`

## 準備（一度だけ）

ユーザーの手が要る（Cloud Shell で済む）。

1. Google Cloud のアカウントを作り、有料アカウントに切り替える（無料トライアルのままでは同時に 8 vCPU まで）
2. プロジェクトを作り、請求先アカウントをつなぐ
3. クォータの引き上げを申請する: us-central1 の「C3D CPUs」を 360、「CPUs (all regions)」を 400
4. 月の費用の上限を付ける（下の「費用の上限」。`cloud/setup-billing-cap.sh` を Cloud Shell で一度流す）
5. Cloud Shell で:

```sh
P=<プロジェクト ID>; B=<バケット名>
gcloud config set project $P
gcloud services enable compute.googleapis.com storage.googleapis.com
gcloud storage buckets create gs://$B --location=us-central1 --uniform-bucket-level-access
gcloud iam service-accounts create svwb-runner   # VM に付けるサービスアカウント
SA=svwb-runner@$P.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/compute.instanceAdmin.v1
gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser
gcloud storage buckets add-iam-policy-binding gs://$B --member=serviceAccount:$SA --role=roles/storage.objectAdmin
```

VM は `svwb-runner` で動き、自分を消すこととバケットの読み書きだけができる。「サービス アカウント ユーザー」を自分自身にだけ付けるのは、
既定の強いサービスアカウントで VM を立てられないようにするため。

動かす側の準備:

- **Claude のクラウド環境から動かす:** `gcloud iam service-accounts keys create key.json --iam-account=$SA` で鍵を作り、中身を
  プロジェクトのクラウド環境の秘密の値 `GCP_SA_KEY` に置く（`GCP_PROJECT`・`GCP_BUCKET` も）。鍵はチャットに貼らない。置いたら `key.json` は消す。
  `cloud/gcp.sh` は `GCP_SA_KEY` があればそれでログインする
- **PC から動かす:** gcloud を入れて `gcloud auth login`、`GCP_PROJECT`・`GCP_BUCKET` を環境変数に置く

### 費用の上限

費用の歯止めは 3 段ある。

| 歯止め | 止まる額 | 効き方 |
| --- | --- | --- |
| CPU のクォータ | 1 時間あたり（360 vCPU なら 3.1 ドルほど） | 申請した数より多くは立てられない |
| `--hours`・`--max-vms` | 1 回の `run` あたり | 上限の時刻で VM が消える（次の「使い方」） |
| 予算で課金を外す（`setup-billing-cap.sh`） | 月あたり（既定 30 ドル） | 月の初めからの費用が予算を超えると、プロジェクトの課金を外す |

Google Cloud の予算は、それだけでは通知しかしない。コンソールの「利用額上限の適用」は Cloud Run 等の API 型のサービスだけが対象で、
VM は止めない。そこで `setup-billing-cap.sh` が、予算の通知を Pub/Sub で関数に渡し、予算を超えていれば関数がプロジェクトから
請求先アカウントを外す（Google の文書の「課金を無効にして使用を停止する」と同じ形）。Cloud Shell で一度だけ流す
（プロジェクトのオーナーと、請求先アカウントの管理者の権限が要る）:

```sh
# リポジトリを開かずに流すときは、ファイルを Cloud Shell に上げてから
P=<プロジェクト ID> AMOUNT=30USD bash cloud/setup-billing-cap.sh
# 請求先アカウントが円なら AMOUNT=4500JPY のように、その通貨で
```

最後に予算内の試しの通知を送るので、1 分ほど後に `gcloud functions logs read billing-cap --region us-central1 --gen2 --limit 5` で
「上限内: 0.0 / 30.0 USD」（AMOUNT の額と通貨）と出ていればよい。

- 費用の反映には数時間の遅れがあるので、止まるのは超えてから数時間後（その間の分は超える）。1 時間 3.1 ドルなら数ドルほど
- 課金が外れると VM は止まる。Google の文書によれば、リソースが消えることもある（結果は毎回共有フォルダへ取り出しておく）
- 戻すとき: 先に予算を上げる（お支払い →「予算とアラート」の `svwb-cap`。同じ月のうちは費用が予算を超えたままで、次の通知でまた外れる）。
  それからお支払い →「プロジェクトの管理」で、このプロジェクトに請求先アカウントをつなぎ直す
- 関数と Pub/Sub の費用は、無料枠に収まるほど小さい

## 使い方

対戦を回す前に作業ブランチに push する（`run` は push していないコミットでは止まる）。1 時間を超える見積もりのものは、回す前にユーザーに確かめる。

```sh
# 速さを測る（最初の試し。15 分ほど）
cloud/gcp.sh run bench1 cloud/jobs/bench.sh --hours 1
# 見張りだけをやり直す（動かす側が止まったとき。VM が消えていれば作り直す）
cloud/gcp.sh watch bench1
cloud/gcp.sh status bench1
cloud/gcp.sh pull bench1 /mnt/project-files/logs/bench1
cloud/gcp.sh stop bench1          # VM を消す（watch で再開できる）
cloud/gcp.sh preempt bench1       # Spot の中断を起こす（試す用）
cloud/gcp.sh list
```

meta.sh（共有フォルダの `notes/meta/meta.sh`）を回す例。PC の `~/td-royal/meta` にある環境のファイル等を作業フォルダに入れ、
`TD` を作業フォルダにする（meta.sh は `W=$TD/meta` を使う）:

```sh
cloud/gcp.sh run meta-r5 /mnt/project-files/notes/meta/meta.sh --hours 3 \
  --input <PC から上げた meta のフォルダ>=meta \
  --env 'TD=$CLOUD_W' --env R=6 --env RETRAIN=0 --env ZMIN=3 --env 'NET0=$CLOUD_W/meta/rm1a.json'
```

`--env` の値はシングルクォートで渡すと、VM の上で展開される（`$CLOUD_W` は VM の作業フォルダ）。

### ジョブの書き方

- リポジトリの一番上で `bash` で流れる。作業フォルダは `CLOUD_W`。ジョブの出力（標準出力・標準エラー）は `work/job.log`
- 結果は作業フォルダに書く。止められて作り直されると、ジョブは最初から流れるので、終わった段階は出力のファイルがあれば飛ばす
  （meta.sh の `[ -f $W/s$r.json ]` や `run` のように）
- 書きかけのファイルは `*.tmp` に書いてから `mv` する（`*.tmp` は置き場所に写さない）。途中で写った書きかけを、終わったものと取り違えないため
- 並列数は既定で VM のスレッド数（`THREADS` で変えられる）

## 手元で試す

`CLOUD_LOCAL=<フォルダ>` なら、Cloud Storage の代わりに `<フォルダ>/store`、VM の代わりに手元のプロセスで動かす（ツールは入れず、VM も消さない）。
スクリプトを変えたら、これで止めて続きから回るところまで確かめる。

```sh
CLOUD_LOCAL=/tmp/cl CLOUD_WATCH_SEC=5 CLOUD_LOCAL_SYNC_SEC=5 cloud/gcp.sh run t1 cloud/jobs/bench.sh \
  --env GAMES=20 --env DECK_GAMES=2 --allow-unpushed --hours 1
CLOUD_LOCAL=/tmp/cl cloud/gcp.sh preempt t1   # 別の端末で。watch が次の VM を立て、続きから回る
```
