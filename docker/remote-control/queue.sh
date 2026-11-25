#!/bin/sh
# ジョブのキューを、ホストから Docker のコンテナの中で操作する（docs/queue.md「ユーザーの手順」）。ホストで流す。
#
#   ~/Shadowverse-Wb-Sim/docker/remote-control/queue.sh add <券>     積む（券はスレッドが出す svwb-queue-1 で始まる 1 行。そのまま貼る。いつ流してもよい。積むだけで回らない）
#   ~/Shadowverse-Wb-Sim/docker/remote-control/queue.sh start        キューを回す（積んだ順に。全部済むか pause まで。--until 07:00 でその時刻に一時停止）
#   ~/Shadowverse-Wb-Sim/docker/remote-control/queue.sh pause        キューを一時停止する（回している区切りは凍らせ、start で続きから。--wait なら済んでから）
#   ~/Shadowverse-Wb-Sim/docker/remote-control/queue.sh status       様子を見る（引数なしでも同じ）
#
# 中身はコンテナ（svwb-rc）の中の npm run queue -- <引数>。結果の push は同じフォルダの queue-push.sh。
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ $# -eq 0 ]; then
  set -- status
fi
if [ -z "$(docker compose -f "$here/compose.yaml" ps -q --status running rc 2> /dev/null || true)" ]; then
  echo "コンテナ（svwb-rc）が動いていません。$here で docker compose up -d を流してから、もう一度流してください" >&2
  exit 1
fi
exec docker compose -f "$here/compose.yaml" exec -T rc npm run -s queue -- "$@"
