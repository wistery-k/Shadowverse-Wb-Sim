#!/bin/bash
# コンテナが起動するたびに流れる（Dockerfile の ENTRYPOINT）。
# ~/svwb-data の中のフォルダごとに ~ にリンクを作る（~/td-royal → ~/svwb-data/td-royal）。積むキュー（pueue）の設定が無ければ作る（下）。
# ホストで ~ の直下に置いていたころのパス（/home/wk/td-royal/... など）を書いたスクリプトやメモが、コンテナでもそのまま使える。
# 同じ名前のものが ~ に既にあれば（リンクでなければ）触らない。終わったら、渡されたコマンドに替わる。
data="$HOME/svwb-data"
if [ -d "$data" ]; then
  for p in "$data"/*/; do
    [ -d "$p" ] || continue
    name=$(basename "$p")
    link="$HOME/$name"
    if [ -L "$link" ] || [ ! -e "$link" ]; then
      ln -sfn "$data/$name" "$link"
    fi
  done
fi
# 積むキュー（pueue。docs/night.md「積むキュー」）の設定が無ければ作る。状態とログは ~/svwb-data/pueue（コンテナを作り直しても残る）、
# つなぐ口（socket）と pid はコンテナの中の /tmp/pueue-<UID>。起動のたびに前の pid とつなぐ口を消す（コンテナの pid は使い回されるので、
# 前の pid が残っていると、別のプロセスを pueued と見て立ち上がらない）
if [ -n "${PUEUE_CONFIG_PATH:-}" ] && [ -d "$data" ]; then
  runtime="/tmp/pueue-$(id -u)"
  mkdir -m 700 -p "$runtime"
  rm -f "$runtime/pueue.pid" "$runtime"/pueue_*.socket
  if [ ! -e "$PUEUE_CONFIG_PATH" ]; then
    mkdir -p "$(dirname "$PUEUE_CONFIG_PATH")"
    printf 'shared:\n  pueue_directory: %s\n  runtime_directory: %s\n' "$data/pueue" "$runtime" > "$PUEUE_CONFIG_PATH"
  fi
fi
exec "$@"
