#!/bin/sh
# 夜のキューの結果を GitHub に上げる（docs/night.md「朝」）。ホストで流す（コンテナには GitHub の認証情報が無い）。
#
#   ~/Shadowverse-Wb-Sim/docker/remote-control/night-push.sh
#
# キューは止まるときに、台帳の行を足したコミットをブランチ night/<回の名前> に作る（作業中のブランチやファイルには触らない）。
# これは、まだ上げていない night/ のブランチを push するだけ。何度流してもよい。
# 上げたら、スレッドに「<回の名前> を push した」と伝える。スレッドが npm run night -- ingest <回の名前> で台帳に足す。
set -eu
cd "$(dirname "$0")/../.."
todo=""
for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/night/'); do
  # 前に上げたときから変わっていないものは飛ばす（origin/<ブランチ> は push すると新しくなる）
  if [ "$(git rev-parse -q --verify "refs/remotes/origin/$b" || true)" != "$(git rev-parse "refs/heads/$b")" ]; then
    todo="$todo $b"
  fi
done
if [ -z "$todo" ]; then
  echo "新しい夜のキューの結果はありません（night/ のブランチは全部上げてあります）"
  exit 0
fi
for b in $todo; do
  git push origin "refs/heads/$b:refs/heads/$b"
done
echo
echo "上げたブランチ:"
names=""
for b in $todo; do
  echo "  $b  $(git log -1 --format=%s "$b")"
  names="${names:+$names・}${b#night/}"
done
echo
echo "スレッドに「${names} を push した」と伝えてください。"
