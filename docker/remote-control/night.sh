#!/bin/sh
# 夜のキューを、ホストから Docker のコンテナの中で操作する（docs/night.md「ユーザーの手順」）。ホストで流す。
#
#   ~/Shadowverse-Wb-Sim/docker/remote-control/night.sh go <券>   夜に始める（券はスレッドが出す svwb-night-1 で始まる 1 行。そのまま貼る）
#   ~/Shadowverse-Wb-Sim/docker/remote-control/night.sh status     様子を見る（引数なしでも同じ）
#   ~/Shadowverse-Wb-Sim/docker/remote-control/night.sh stop       止める（回している区切りが終わったら。--now ですぐ）
#
# 中身はコンテナ（svwb-rc）の中の npm run night -- <引数>。朝の push は同じフォルダの night-push.sh。
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ $# -eq 0 ]; then
  set -- status
fi
if [ -z "$(docker compose -f "$here/compose.yaml" ps -q --status running rc 2> /dev/null || true)" ]; then
  echo "コンテナ（svwb-rc）が動いていません。$here で docker compose up -d を流してから、もう一度流してください" >&2
  exit 1
fi
# 端末から流したときは端末を渡す（go が昼に確かめるのに使う）
if [ -t 0 ] && [ -t 1 ]; then
  exec docker compose -f "$here/compose.yaml" exec rc npm run -s night -- "$@"
fi
exec docker compose -f "$here/compose.yaml" exec -T rc npm run -s night -- "$@"
