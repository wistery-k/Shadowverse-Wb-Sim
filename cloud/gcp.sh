#!/bin/bash
# クラウド（Google Cloud の Spot VM）でジョブ（meta.sh 等のシェルスクリプト）を回す（cloud/README.md）。
#
#   cloud/gcp.sh run <名前> <ジョブ.sh> [--machine c3d-highcpu-180] [--zones us-central1-a,...] [--hours 4]
#                    [--input <手元のファイルかフォルダ>=<作業フォルダの中の名前>]... [--env K=V]... [--max-vms 6]
#                    [--no-golden] [--no-watch] [--allow-unpushed]
#       今のコミットのソース・ジョブ・入力を置き場所に送り、VM を立てて、終わるまで見張る
#   cloud/gcp.sh watch <名前> [--extend <時間>]   終わるまで見張る。VM が消えていて終わっていなければ作り直す
#   cloud/gcp.sh status <名前>                    VM と、作業フォルダのログの最後
#   cloud/gcp.sh pull <名前> <行き先のフォルダ>   作業フォルダを手元に写す
#   cloud/gcp.sh stop <名前>                      VM を消して見張りも止める（STOPPED を書く。watch で再開できる）
#   cloud/gcp.sh preempt <名前>                   Spot の中断を起こす（試す用。見張っていれば作り直して続きから回る）
#   cloud/gcp.sh list                             回した名前と状態の一覧
#
# 設定（環境変数）:
#   GCP_PROJECT・GCP_BUCKET  プロジェクト ID とバケット名（既定 shadowverse-wb-sim・shadowverse-wb-sim-runs）
#   GCP_SA                   VM に付けるサービスアカウント（既定 svwb-runner@<プロジェクト>.iam.gserviceaccount.com）
#   GCP_SA_KEY               サービスアカウントの鍵（JSON の中身か、`base64 -w0 key.json` の 1 行）。あれば、それで gcloud にログインする。
#                            Claude のクラウド環境では、鍵はネットワークのシークレット（GCP access token）に置くほうがよい。そのときは
#                            これを置かず、gcloud は環境の CLOUDSDK_AUTH_ACCESS_TOKEN（通信の出口で本物の token に差し替わる）で動く
#   CLOUD_LOCAL=<フォルダ>   手元で試す: Cloud Storage の代わりに <フォルダ>/store、VM の代わりに手元のプロセスで動かす
#
# ジョブは VM のソースのフォルダ（リポジトリの一番上）で bash で流れ、作業フォルダが環境変数 CLOUD_W に入る。
# 作業フォルダは 3 分ごとに置き場所（gs://<バケット>/runs/<名前>/work）に写り、止められて作り直された VM はそれを戻してから
# ジョブを最初から流す。ジョブは終わった部分を飛ばすように書く（cloud/README.md「ジョブの書き方」）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
LOCAL=${CLOUD_LOCAL:-}

die() { echo "エラー: $*" >&2; exit 1; }
say() { echo "[$(date '+%m-%d %H:%M:%S')] $*"; }

if [ -n "$LOCAL" ]; then
  mkdir -p "$LOCAL"
  LOCAL=$(cd "$LOCAL" && pwd)
  STORE_ROOT=$LOCAL/store/runs
else
  # このリポジトリのプロジェクトとバケット（どちらも秘密ではない。別のものを使うときは環境変数で）
  GCP_PROJECT=${GCP_PROJECT:-shadowverse-wb-sim}
  GCP_BUCKET=${GCP_BUCKET:-shadowverse-wb-sim-runs}
  STORE_ROOT=gs://$GCP_BUCKET/runs
  GCP_SA=${GCP_SA:-svwb-runner@$GCP_PROJECT.iam.gserviceaccount.com}
fi

auth() {
  [ -n "$LOCAL" ] && return 0
  [ -n "${GCP_SA_KEY:-}" ] || return 0
  local sa key=$GCP_SA_KEY
  # 環境変数の欄に 1 行で置けるよう、base64 にしたものも受ける
  [[ $key == *'{'* ]] || key=$(printf '%s' "$key" | tr -d ' \n' | base64 -d 2> /dev/null) || die "GCP_SA_KEY を base64 として読めません"
  sa=$(printf '%s' "$key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["client_email"])') ||
    die "GCP_SA_KEY が鍵の JSON（か、その base64）ではありません"
  # 環境が token を決めていると gcloud はそちらを使うので、鍵を使うときは外す
  unset CLOUDSDK_AUTH_ACCESS_TOKEN
  if [ "$(gcloud config get-value account 2> /dev/null)" != "$sa" ]; then
    local k
    k=$(mktemp)
    chmod 600 "$k"
    printf '%s' "$key" > "$k"
    gcloud auth activate-service-account --key-file="$k" --quiet > /dev/null 2>&1 || { rm -f "$k"; die "鍵でログインできません"; }
    rm -f "$k"
  fi
}

# --- 置き場所（STORE = <STORE_ROOT>/<名前>） ---
is_gs() { [[ $STORE == gs://* ]]; }
st_has() { if is_gs; then gcloud storage ls "$STORE/$1" > /dev/null 2>&1; else [ -e "$STORE/$1" ]; fi; }
st_cat() { if is_gs; then gcloud storage cat "$STORE/$1" 2> /dev/null; else cat "$STORE/$1" 2> /dev/null; fi; }
st_put() {  # st_put <手元のファイル> <置き場所の中の名前>
  if is_gs; then gcloud storage cp -q "$1" "$STORE/$2"; else mkdir -p "$(dirname "$STORE/$2")" && cp "$1" "$STORE/$2"; fi
}
st_put_text() { local f; f=$(mktemp); printf '%s\n' "$2" > "$f"; st_put "$f" "$1"; rm -f "$f"; }
st_put_dir() {  # st_put_dir <手元のフォルダ> <置き場所の中の名前>
  if is_gs; then gcloud storage rsync -r -q "$1" "$STORE/$2"; else mkdir -p "$STORE/$2" && cp -a "$1/." "$STORE/$2/"; fi
}
st_get_dir() {  # st_get_dir <置き場所の中の名前> <手元のフォルダ>
  mkdir -p "$2"
  if is_gs; then gcloud storage rsync -r -q "$STORE/$1" "$2"; else cp -a "$STORE/$1/." "$2/"; fi
}
st_rm() { if is_gs; then gcloud storage rm -q "$STORE/$1" > /dev/null 2>&1 || true; else rm -f "$STORE/$1"; fi; }

set_run() {
  NAME=$1
  [[ $NAME =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die "名前は英小文字で始まる英小文字・数字・- の 40 字以内（VM の名前に使う）: $NAME"
  STORE=$STORE_ROOT/$NAME
}
load_run() {
  local env
  env=$(st_cat run.env) || die "$NAME は置き場所にありません（run で始める）"
  eval "$env"
}

# --- VM ---
vm_list() {  # 名前 ゾーン 状態 を 1 行ずつ
  if [ -n "$LOCAL" ]; then
    local f
    for f in "$LOCAL"/vms/svwb-"$NAME"-*.pid; do
      [ -f "$f" ] || continue
      kill -0 "$(cat "$f")" 2> /dev/null && echo "$(basename "$f" .pid) local RUNNING"
    done
    return 0
  fi
  gcloud compute instances list --project "$GCP_PROJECT" --filter="labels.svwb-run=$NAME" \
    --format='value(name,zone.basename(),status)'
}
vm_status() {  # vm_status <VM の名前> <ゾーン>: RUNNING 等の状態、無ければ GONE、分からなければ UNKNOWN
  if [ -n "$LOCAL" ]; then
    if kill -0 "$(cat "$LOCAL/vms/$1.pid" 2> /dev/null)" 2> /dev/null; then echo RUNNING; else echo GONE; fi
    return 0
  fi
  local out
  if out=$(gcloud compute instances describe "$1" --project "$GCP_PROJECT" --zone "$2" --format='value(status)' 2>&1); then
    echo "$out"
  elif echo "$out" | grep -q 'was not found'; then
    echo GONE
  else
    echo UNKNOWN
  fi
}
vm_delete() {  # vm_delete <VM の名前> <ゾーン>
  if [ -n "$LOCAL" ]; then
    local pid
    pid=$(cat "$LOCAL/vms/$1.pid")
    kill -TERM -- -"$pid" 2> /dev/null || kill -TERM "$pid" 2> /dev/null || true
    return 0
  fi
  gcloud compute instances delete "$1" --project "$GCP_PROJECT" --zone "$2" --quiet
}
vm_create() {  # vm_create <番号> <ゾーン> <最長の秒数>
  local vm=svwb-$NAME-$1
  if [ -n "$LOCAL" ]; then
    mkdir -p "$LOCAL/vms"
    SVWB_STORE=$STORE SVWB_ROOT=$LOCAL/vms/$vm SVWB_LOCAL=1 SVWB_GOLDEN=$GOLDEN SVWB_SYNC_SEC=${CLOUD_LOCAL_SYNC_SEC:-10} \
      SVWB_LOCAL_TARGET=$LOCAL/target setsid bash cloud/vm-startup.sh > "$LOCAL/vms/$vm.out" 2>&1 < /dev/null &
    echo $! > "$LOCAL/vms/$vm.pid"
    return 0
  fi
  local image=debian-12 disk=pd-balanced
  case $MACHINE in
    c4a-* | t2a-*) image=debian-12-arm64 ;;
  esac
  case $MACHINE in
    c4-* | c4a-* | c4d-* | n4-* | n4d-*) disk=hyperdisk-balanced ;;
  esac
  gcloud compute instances create "$vm" --project "$GCP_PROJECT" --zone "$2" --machine-type "$MACHINE" \
    --provisioning-model=SPOT --instance-termination-action=DELETE --max-run-duration="${3}s" \
    --image-family="$image" --image-project=debian-cloud --boot-disk-size=50GB --boot-disk-type="$disk" \
    --service-account="$GCP_SA" --scopes=cloud-platform --labels="svwb-run=$NAME" \
    --metadata="svwb-store=$STORE,svwb-rust=$RUST,svwb-node=$NODE,svwb-golden=$GOLDEN" \
    --metadata-from-file=startup-script=cloud/vm-startup.sh,shutdown-script=cloud/vm-shutdown.sh \
    --quiet > /dev/null
}

tail_log() { st_cat "work/$1" | tail -n "${2:-1}"; }

cmd_run() {
  set_run "${1:-}"
  local job=${2:-}
  [ -f "$job" ] || die "ジョブのファイルがありません: $job"
  shift 2
  MACHINE=c3d-highcpu-180 ZONES=us-central1-a,us-central1-b,us-central1-c,us-central1-f HOURS=4 MAXVMS=6 GOLDEN=1
  local watch=1 pushed=1 inputs=() envs=()
  while [ $# -gt 0 ]; do
    case $1 in
      --machine) MACHINE=$2; shift 2 ;;
      --zones) ZONES=$2; shift 2 ;;
      --hours) HOURS=$2; shift 2 ;;
      --max-vms) MAXVMS=$2; shift 2 ;;
      --input) inputs+=("$2"); shift 2 ;;
      --env) envs+=("$2"); shift 2 ;;
      --no-golden) GOLDEN=0; shift ;;
      --no-watch) watch=0; shift ;;
      --allow-unpushed) pushed=0; shift ;;
      *) die "知らない引数: $1" ;;
    esac
  done
  auth
  st_has run.env && die "$NAME はもう置き場所にあります（続きは watch、やり直すなら別の名前）"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || [ $pushed = 0 ] || die "コミットしていない変更があります"
  [ -n "$(git branch -r --contains HEAD 2> /dev/null)" ] || [ $pushed = 0 ] || die "今のコミットを push してから回す（--allow-unpushed で外せる）"
  RUST=$(rustc --version 2> /dev/null | awk '{print $2}')
  RUST=${RUST:-stable}
  NODE=$(node --version 2> /dev/null || echo v22.22.0)
  local commit
  commit="$(git rev-parse --short HEAD) $(git branch --show-current) $(git log -1 --format=%s)"

  say "$NAME: ソース（$commit）・ジョブ・入力を $STORE に送ります"
  local tmp
  tmp=$(mktemp -d)
  git archive --format=tar.gz -o "$tmp/src.tar.gz" HEAD
  st_put "$tmp/src.tar.gz" src.tar.gz
  st_put "$job" job.sh
  st_put_text commit "$commit"
  local e text=""
  for e in "${envs[@]}"; do
    [[ $e == *=* ]] || die "--env は K=V: $e"
    text+="${e%%=*}=\"${e#*=}\""$'\n'
  done
  st_put_text job.env "$text"
  local i src dst
  for i in "${inputs[@]}"; do
    [[ $i == *=* ]] || die "--input は <手元>=<作業フォルダの中の名前>: $i"
    src=${i%%=*} dst=${i#*=}
    if [ -d "$src" ]; then st_put_dir "$src" "work/$dst"
    elif [ -f "$src" ]; then st_put "$src" "work/$dst"
    else die "入力がありません: $src"; fi
    say "入力: $src → work/$dst"
  done
  rm -rf "$tmp"
  local deadline=$(($(date +%s) + $(awk "BEGIN{print int($HOURS * 3600)}")))
  st_put_text run.env "MACHINE=$MACHINE ZONES=$ZONES MAXVMS=$MAXVMS GOLDEN=$GOLDEN RUST=$RUST NODE=$NODE DEADLINE=$deadline"
  if [ $watch = 1 ]; then watch_loop; else start_vm; fi
}

start_vm() {  # 次の番号の VM を、ゾーンを順に試して立てる。立てられたら 0
  local n z left
  n=$(($(st_cat vms.log | wc -l || true) + 1))
  [ "$n" -le "$MAXVMS" ] || { say "VM を立てた数が上限（$MAXVMS）に達しました"; return 2; }
  left=$((DEADLINE - $(date +%s)))
  [ $left -ge 600 ] || left=600
  for z in ${ZONES//,/ }; do
    if vm_create "$n" "$z" "$left"; then
      local prev
      prev=$(st_cat vms.log || true)
      st_put_text vms.log "${prev:+$prev$'\n'}$n $z $(date -u '+%F %T')"
      say "VM svwb-$NAME-$n を $z に立てました（$MACHINE、最長 $((left / 60)) 分）"
      return 0
    fi
    say "$z には立てられませんでした"
  done
  return 1
}

watch_loop() {
  local k=0 n z s
  load_run
  while true; do
    if st_has DONE; then
      say "終わりました: $(st_cat DONE | head -n 1)"
      tail_log job.log 5
      return 0
    fi
    if st_has FAILED; then
      say "失敗しました: $(st_cat FAILED | head -n 1)"
      tail_log cloud.log 5
      tail_log job.log 10
      tail_log build.log 10
      return 1
    fi
    if st_has STOPPED; then
      say "止めてあります（stop）。続けるなら watch"
      return 3
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      say "上限の時間を過ぎました（watch --extend <時間> で延ばせる）"
      vm_list | while read -r v z _; do [ -n "$v" ] && vm_delete "$v" "$z"; done
      return 2
    fi
    # 最後に立てた VM を名前で見る（一覧の取りこぼしで VM を余分に立てないように、無いと分かったときだけ作り直す）
    read -r n z _ <<< "$(st_cat vms.log | tail -n 1 || true)"
    s=GONE
    [ -n "${n:-}" ] && s=$(vm_status "svwb-$NAME-$n" "$z")
    case $s in
      GONE)
        [ -n "${n:-}" ] && say "VM svwb-$NAME-$n がありません（中断された）"
        start_vm || {
          local rc=$?
          [ $rc = 2 ] && return 2
          say "どのゾーンにも立てられませんでした。5 分後にもう一度"
          sleep 300
          continue
        }
        ;;
      TERMINATED) vm_delete "svwb-$NAME-$n" "$z" ;;
      UNKNOWN) say "VM の状態を取れませんでした" ;;
      *) [ $((k % 5)) = 0 ] && say "svwb-$NAME-$n $s | $(tail_log job.log 1 | cut -c1-160)" ;;
    esac
    k=$((k + 1))
    sleep "${CLOUD_WATCH_SEC:-60}"
  done
}

cmd_watch() {
  set_run "${1:-}"
  shift
  auth
  if [ "${1:-}" = --extend ]; then
    load_run
    local now
    now=$(date +%s)
    [ "$DEADLINE" -gt "$now" ] || DEADLINE=$now
    DEADLINE=$((DEADLINE + $(awk "BEGIN{print int($2 * 3600)}")))
    st_put_text run.env "MACHINE=$MACHINE ZONES=$ZONES MAXVMS=$MAXVMS GOLDEN=$GOLDEN RUST=$RUST NODE=$NODE DEADLINE=$DEADLINE"
    say "上限を $(date -d "@$DEADLINE" '+%m-%d %H:%M') まで延ばしました"
  fi
  st_rm STOPPED
  watch_loop
}

cmd_status() {
  set_run "${1:-}"
  auth
  load_run
  echo "== $NAME（$MACHINE、上限 $(date -d "@$DEADLINE" '+%m-%d %H:%M')）"
  echo "ソース: $(st_cat commit)"
  for m in DONE FAILED STOPPED; do st_has $m && echo "$m: $(st_cat $m | head -n 1)"; done
  echo "-- VM（立てた順: 番号 ゾーン 時刻）"
  st_cat vms.log || true
  vm_list
  echo "-- cloud.log"
  tail_log cloud.log 8
  echo "-- job.log"
  tail_log job.log 8
}

cmd_pull() {
  set_run "${1:-}"
  [ -n "${2:-}" ] || die "行き先のフォルダを書く"
  auth
  st_get_dir work "$2"
  say "$STORE/work → $2"
}

cmd_stop() {
  set_run "${1:-}"
  auth
  st_put_text STOPPED "$(date -u '+%F %T')"
  vm_list | while read -r v z _; do [ -n "$v" ] && vm_delete "$v" "$z" && say "$v を消しました"; done
  return 0
}

cmd_preempt() {
  set_run "${1:-}"
  auth
  vm_list | while read -r v z _; do
    [ -n "$v" ] || continue
    if [ -n "$LOCAL" ]; then vm_delete "$v" "$z"
    else gcloud compute instances simulate-maintenance-event "$v" --project "$GCP_PROJECT" --zone "$z" --quiet; fi
    say "$v を止めました（中断の試し）"
  done
}

cmd_list() {
  auth
  local runs r
  if [[ $STORE_ROOT == gs://* ]]; then
    runs=$(gcloud storage ls "$STORE_ROOT/" 2> /dev/null | awk -F/ '{print $(NF-1)}')
  else
    runs=$(ls "$STORE_ROOT" 2> /dev/null || true)
  fi
  for r in $runs; do
    STORE=$STORE_ROOT/$r
    local state=回している
    for m in STOPPED FAILED DONE; do st_has $m && state=$m; done
    echo "$r $state"
  done
}

case ${1:-} in
  run | watch | status | pull | stop | preempt)
    c=$1
    shift
    "cmd_$c" "$@"
    ;;
  list) cmd_list ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
