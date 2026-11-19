#!/bin/sh
# 夜のキューの結果を GitHub に上げる（docs/night.md「朝」）。ホストで流す（コンテナには GitHub の認証情報が無い）。
#
#   ~/Shadowverse-Wb-Sim/docker/remote-control/night-push.sh
#
# キューは止まるときに、台帳の行を足したコミットをブランチ night/<回の名前> に作る（作業中のブランチやファイルには触らない）。
# これは次の 3 つをするだけ。何度流してもよい。
#   1. 電源が切れた回など、まとめが済んでいない回があれば、コンテナの中でまとめる（npm run night -- wrap --pending）
#   2. まだ上げていない night/ のブランチを push する
#   3. 台帳の行が全部 GitHub の main の台帳に入った回のブランチは、上げ直さず、GitHub から消す（手元のブランチは続きを回すときに使うので残す）
# 上げたら、スレッドに「<回の名前> を push した」と伝える。スレッドが npm run night -- ingest <回の名前> で台帳に足す。
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../.."

# 1. まとめが済んでいない回をまとめる（コンテナが動いていなければ飛ばす）
if [ -n "$(docker compose -f "$here/compose.yaml" ps -q --status running rc 2> /dev/null || true)" ]; then
  if ! docker compose -f "$here/compose.yaml" exec -T rc npm run -s night -- wrap --pending; then
    echo "（まとめが済んでいない回があるかを確かめられませんでした。push は続けます）"
  fi
else
  echo "（コンテナが動いていないので、まとめが済んでいない回があるかは見ていません。push は続けます）"
fi

# 2・3 のために GitHub の main と night/ のブランチを取ってくる（GitHub で消したブランチは手元の origin/night/… からも消える）
git fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main' '+refs/heads/night/*:refs/remotes/origin/night/*'
main_ledger=$(mktemp)
rows=$(mktemp)
trap 'rm -f "$main_ledger" "$rows"' EXIT
git show origin/main:docs/ledger.jsonl > "$main_ledger" 2> /dev/null || : > "$main_ledger"

# その回の行（"queue":"<回の名前>"）が 1 つ以上あり、全部が main の台帳にそのままあるか
in_main() {
  git show "refs/heads/$1:docs/ledger.jsonl" 2> /dev/null | grep -F "\"queue\":\"${1#night/}\"" > "$rows" || true
  [ -s "$rows" ] && ! grep -vxFf "$main_ledger" "$rows" > /dev/null
}

todo=""
gone=""
for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/night/'); do
  remote=$(git rev-parse -q --verify "refs/remotes/origin/$b" || true)
  if in_main "$b"; then
    # main に入った回。GitHub に残っていれば消す
    if [ -n "$remote" ]; then
      git push --quiet origin --delete "$b"
      gone="$gone $b"
    fi
  elif [ "$remote" != "$(git rev-parse "refs/heads/$b")" ]; then
    todo="$todo $b"
  fi
done

if [ -n "$gone" ]; then
  echo "台帳の行が main に入ったので、GitHub から消したブランチ:$gone"
fi
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
