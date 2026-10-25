#!/bin/bash
# クラウドの VM（Google Cloud の Spot VM）が起動したときに流すスクリプト（cloud/README.md）。cloud/gcp.sh が VM の
# startup-script として渡す。置き場所（STORE: Cloud Storage の gs://<バケット>/runs/<名前>）から、ソース・ジョブ・
# 作業フォルダを取ってきてビルドし、ジョブを流して、作業フォルダを STORE に写し続ける。終わったら DONE（失敗なら FAILED）を
# 書いて、自分の VM を消す。
#
# 止められて作り直された VM は、STORE の作業フォルダを戻してからジョブを最初から流す。ジョブは終わった部分を飛ばして
# 続きから回るように書く（meta.sh のように、出力のファイルがあればその段階を飛ばす）。
#
# 手元で試すとき（cloud/gcp.sh の CLOUD_LOCAL）は、VM の情報を環境変数で渡す:
#   SVWB_STORE=<置き場所のフォルダ> SVWB_ROOT=<作業の場所> SVWB_LOCAL=1 bash cloud/vm-startup.sh
#   SVWB_LOCAL=1 なら、ツールを入れず・VM を消さず、STORE はただのフォルダとして扱う
set -uo pipefail
export HOME=${HOME:-/root}

md() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
attr() { md "attributes/$1" 2>/dev/null || true; }

LOCAL=${SVWB_LOCAL:-}
STORE=${SVWB_STORE:-$(attr svwb-store)}
ROOT=${SVWB_ROOT:-/work}
RUST_VER=${SVWB_RUST:-$(attr svwb-rust)}
NODE_VER=${SVWB_NODE:-$(attr svwb-node)}
GOLDEN=${SVWB_GOLDEN:-$(attr svwb-golden)}
SYNC_SEC=${SVWB_SYNC_SEC:-$(attr svwb-sync-sec)}
RUST_VER=${RUST_VER:-stable}
NODE_VER=${NODE_VER:-v22.22.0}
GOLDEN=${GOLDEN:-1}
SYNC_SEC=${SYNC_SEC:-180}
[ -n "$STORE" ] || { echo "svwb-store がありません"; exit 1; }

W=$ROOT/w
mkdir -p "$W" "$ROOT/src"
log() { echo "[$(date -u '+%F %T')] $*" | tee -a "$W/cloud.log"; }

# --- 置き場所の読み書き（gs:// なら Cloud Storage、それ以外はただのフォルダ） ---
is_gs() { [[ $STORE == gs://* ]]; }
st_get() { if is_gs; then gcloud storage cp -q "$STORE/$1" "$2"; else cp "$STORE/$1" "$2"; fi; }
st_put() { if is_gs; then gcloud storage cp -q "$1" "$STORE/$2"; else mkdir -p "$(dirname "$STORE/$2")" && cp "$1" "$STORE/$2"; fi; }
st_has() { if is_gs; then gcloud storage ls "$STORE/$1" > /dev/null 2>&1; else [ -e "$STORE/$1" ]; fi; }
# 作業フォルダ: 書きかけ（*.tmp）は写さない。消したファイルも STORE からは消さない
pull_work() {
  if is_gs; then
    st_has work/ && gcloud storage rsync -r -q "$STORE/work" "$W"
  else
    [ -d "$STORE/work" ] && cp -a "$STORE/work/." "$W/"
  fi
  return 0
}
push_work() {
  if is_gs; then gcloud storage rsync -r -q -x '.*\.tmp$' "$W" "$STORE/work"
  else mkdir -p "$STORE/work" && tar -C "$W" --exclude='*.tmp' -cf - . | tar -C "$STORE/work" -xf -; fi
}

finish() {  # finish <DONE|FAILED> <説明>
  local mark=$1 what=$2
  FINISHED=1
  [ -n "${SYNC_PID:-}" ] && kill "$SYNC_PID" 2> /dev/null
  log "$mark: $what"
  push_work || log "作業フォルダを写せませんでした"
  local f
  f=$(mktemp)
  printf '%s\n%s\nvm %s\n' "$what" "$(date -u '+%F %T')" "${VM_NAME:-local}" > "$f"
  st_put "$f" "$mark"
  rm -f "$f"
  if [ -z "$LOCAL" ]; then
    log "VM を消します"
    gcloud compute instances delete "$VM_NAME" --zone "$VM_ZONE" --quiet
  fi
  [ "$mark" = DONE ]
  exit
}

pull_work
if [ -z "$LOCAL" ]; then
  VM_NAME=$(md name)
  VM_ZONE=$(md zone | awk -F/ '{print $NF}')
  log "起動: $VM_NAME（$VM_ZONE、$(md machine-type | awk -F/ '{print $NF}')）"
else
  log "起動（手元で試す）"
fi
# 止められたとき（SIGTERM）は印を書かずに終わる（watch が作り直す）。それ以外で途中で終わったときは FAILED を書いて VM を消す
# （VM が何もしないまま上限の時間まで残らないように）
# shellcheck disable=SC2329  # trap から呼ぶ
on_term() { TERMINATING=1; log "止められました（SIGTERM）"; exit 143; }
# shellcheck disable=SC2329
on_exit() {
  local rc=$?
  [ -n "${FINISHED:-}" ] || [ -n "${TERMINATING:-}" ] || finish FAILED "起動スクリプトが途中で終わった（終了コード $rc、cloud.log）"
}
trap on_term TERM
trap on_exit EXIT
log "CPU: $(nproc) スレッド、$(lscpu | sed -n 's/^Model name: *//p' | head -n 1)、メモリ $(free -g | awk '/^Mem:/{print $2}') GB"
if st_has DONE || st_has FAILED; then
  log "もう終わっています"
  FINISHED=1
  [ -z "$LOCAL" ] && gcloud compute instances delete "$VM_NAME" --zone "$VM_ZONE" --quiet
  exit 0
fi

# --- ツール（Debian 12 のイメージに Rust と Node を入れる） ---
if [ -z "$LOCAL" ]; then
  export DEBIAN_FRONTEND=noninteractive PATH=$HOME/.cargo/bin:$PATH
  if ! command -v cc > /dev/null; then
    log "ツールを入れます（Rust $RUST_VER、Node $NODE_VER）"
    { apt-get update -q && apt-get install -y -q build-essential pkg-config curl ca-certificates xz-utils; } > /dev/null ||
      finish FAILED "apt-get に失敗"
  fi
  if ! command -v node > /dev/null; then
    na=x64
    [ "$(uname -m)" = aarch64 ] && na=arm64
    { curl -sfL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$na.tar.xz" | tar -xJ -C /opt &&
      ln -sf /opt/node-"$NODE_VER"-linux-$na/bin/* /usr/local/bin/; } || finish FAILED "Node を入れられない"
  fi
  if ! command -v cargo > /dev/null; then
    curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain "$RUST_VER" > /dev/null ||
      finish FAILED "Rust を入れられない"
  fi
  # npm run td 等（scripts/vite-run.mjs）は先に WASM を作るので、wasm32 のターゲットも要る
  rustup target list --installed 2> /dev/null | grep -q '^wasm32-unknown-unknown$' ||
    rustup target add wasm32-unknown-unknown > /dev/null 2>&1 || finish FAILED "wasm32-unknown-unknown を入れられない"
fi

# --- ソースとジョブ ---
st_get src.tar.gz "$ROOT/src.tar.gz" || finish FAILED "src.tar.gz が無い"
st_get job.sh "$ROOT/job.sh" || finish FAILED "job.sh が無い"
st_has job.env && st_get job.env "$ROOT/job.env"
touch "$ROOT/job.env"
find "$ROOT/src" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name rust -exec rm -rf {} +
tar -xzf "$ROOT/src.tar.gz" -C "$ROOT/src" || finish FAILED "src.tar.gz を展開できない"
[ -n "$LOCAL" ] && [ -n "${SVWB_LOCAL_TARGET:-}" ] && mkdir -p "$SVWB_LOCAL_TARGET" && ln -sfn "$SVWB_LOCAL_TARGET" "$ROOT/src/rust/target"
st_get commit "$ROOT/commit" 2> /dev/null
log "ソース: $(cat "$ROOT/commit" 2> /dev/null || echo '?')"

# 作業フォルダは、ビルドの間も写し始める（ログを見られるように）
(while sleep "$SYNC_SEC"; do push_work > /dev/null 2>&1; done) &
SYNC_PID=$!

cd "$ROOT/src" || finish FAILED "ソースのフォルダが無い"
t0=$(date +%s)
{ npm ci --no-audit --no-fund --loglevel=error && npm run -s rust-data -- --quiet &&
  cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine; } >> "$W/build.log" 2>&1 ||
  finish FAILED "ビルドに失敗（build.log）"
log "ビルド $(($(date +%s) - t0)) 秒"
if [ "$GOLDEN" = 1 ]; then
  # 保存した試合の結果と同じになるか（別の CPU で結果がずれていないか）を、ジョブの前に確かめる
  t0=$(date +%s)
  rust/target/release/svwb golden >> "$W/build.log" 2>&1 || finish FAILED "ゴールデンテストが合わない（build.log）"
  log "ゴールデンテスト 一致（$(($(date +%s) - t0)) 秒）"
fi

# --- ジョブ ---
log "ジョブを始めます"
t0=$(date +%s)
(
  export CLOUD_W=$W
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/job.env"
  set +a
  exec bash "$ROOT/job.sh"
) >> "$W/job.log" 2>&1
rc=$?
if [ $rc -eq 0 ]; then
  finish DONE "ジョブが終わった（$(($(date +%s) - t0)) 秒）"
else
  finish FAILED "ジョブが終了コード $rc で止まった（job.log）"
fi
