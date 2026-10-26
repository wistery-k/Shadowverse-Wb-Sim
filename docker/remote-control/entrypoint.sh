#!/bin/bash
# コンテナが起動するたびに流れる（Dockerfile の ENTRYPOINT）。
# ~/svwb-data の中のフォルダごとに ~ にリンクを作る（~/td-royal → ~/svwb-data/td-royal）。
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
exec "$@"
