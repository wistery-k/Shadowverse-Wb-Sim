#!/bin/bash
# VM が止められるとき（Spot の中断。知らせから 30 秒ほど）に流すスクリプト（cloud/README.md）。cloud/gcp.sh が VM の
# shutdown-script として渡す。作業フォルダの小さいファイルだけを、間に合う範囲で置き場所に写す
# （大きいファイルは 3 分ごとの写しに任せる。間に合わなかった分は、作り直した VM がやり直す）。
md() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
STORE=$(md attributes/svwb-store) || exit 0
W=/work/w
[ -d "$W" ] || exit 0
echo "[$(date -u '+%F %T')] 止められます（shutdown-script）" >> "$W/cloud.log"
timeout 20 gcloud storage rsync -r -q -x '.*\.tmp$|.*\.jsonl$|.*\.gz$' "$W" "$STORE/work"
