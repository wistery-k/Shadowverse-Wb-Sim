#!/bin/bash
# クラウドの VM の速さを測るジョブ（cloud/README.md「最初の試し」）。並列数を 1/4・1/2・全部にして同じ試合を打ち、
# 1 試合あたりの時間を bench.md に書く。段階ごとに結果を書くので、止められても続きから回る（中断の試しにも使う）。
#   cloud/gcp.sh run bench1 cloud/jobs/bench.sh --hours 1 [--env GAMES=3000] [--env DECK_GAMES=100]
# 手元で: CLOUD_W=/tmp/bench GAMES=50 DECK_GAMES=2 bash cloud/jobs/bench.sh
set -euo pipefail
W=${CLOUD_W:?}
GAMES=${GAMES:-3000}          # compare の組の数（試合はその 2 倍。同じ設定どうしなので、速さだけを見る）
DECK_GAMES=${DECK_GAMES:-100} # deck-compare（スペルウィッチの入れ替え案 1 つ）の、相手 1 つ・席 1 つあたりの試合数
B=rust/target/release/svwb
N=$(nproc)
mkdir -p "$W/bench"
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine

ms() { date +%s%3N; }
step() {  # step <名前> <試合数> <並列数> <コマンド...>
  local name=$1 games=$2 t=$3
  shift 3
  local f=$W/bench/$name.txt
  [ -s "$f" ] && return 0
  echo "== $name（並列 $t、$games 試合）$(date '+%H:%M:%S')"
  local s e
  s=$(ms)
  THREADS=$t "$@" > "$W/bench/$name.log" 2>&1
  e=$(ms)
  echo "$name $t $games $((e - s))" > "$f.tmp"
  mv "$f.tmp" "$f"
}

for t in $((N / 4)) $((N / 2)) "$N"; do
  step "compare-t$t" $((GAMES * 2)) "$t" $B compare "$GAMES" '{}' '{}' 0
done
step "deck-t$N" $((DECK_GAMES * 6 * 2 * 2)) "$N" $B deck-compare --deck スペルウィッチ --variant '知恵の輝き-1,最果ての罪・サタン+1' --games "$DECK_GAMES"

{
  echo "# 速さ（$(lscpu | sed -n 's/^Model name: *//p' | head -n 1)、$N スレッド）"
  echo
  echo "| 仕事 | 並列 | 試合 | 秒 | 秒/試合 | スレッド秒/試合 |"
  echo "| --- | ---: | ---: | ---: | ---: | ---: |"
  cat "$W"/bench/*.txt | awk '{printf "| %s | %d | %d | %.1f | %.4f | %.2f |\n", $1, $2, $3, $4 / 1000, $4 / 1000 / $3, $4 / 1000 / $3 * $2}'
} > "$W/bench.md"
cat "$W/bench.md"
