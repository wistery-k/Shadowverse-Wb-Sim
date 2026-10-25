#!/bin/bash
# 並列数を増やしても速くならない原因を調べるジョブ（cloud/README.md）。同じ compare の試合を、プロセス数・1 プロセスの
# スレッド数・glibc の malloc の設定を変えて回し、壁時計・user・sys の秒を scale.md に書く。
# - 1 プロセス 180 スレッドより 2 プロセス × 90 スレッドが速ければ、プロセスの中の取り合い（メモリの割り当て等）が原因
# - どれも同じなら、マシン全体のメモリの帯域かキャッシュが原因
# 段階ごとに結果を書くので、止められても続きから回る。
#   cloud/gcp.sh run scale1 cloud/jobs/bench-scale.sh --hours 1 [--env GAMES=3000]
# 手元で: CLOUD_W=/tmp/scale GAMES=40 bash cloud/jobs/bench-scale.sh
set -euo pipefail
W=${CLOUD_W:?}
GAMES=${GAMES:-3000} # compare の組の数（試合はその 2 倍）。プロセスで等分する
B=rust/target/release/svwb
N=$(nproc)
mkdir -p "$W/scale"
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine
# 大きい割り当てを mmap にせず、空いた分を OS に返さない（mmap・munmap・madvise はプロセスの中で取り合いになる）
TUNED=glibc.malloc.mmap_threshold=33554432:glibc.malloc.trim_threshold=4294967296:glibc.malloc.top_pad=67108864

step() { # step <名前> <プロセス数> <1 プロセスのスレッド数> [GLIBC_TUNABLES]
  local name=$1 procs=$2 t=$3 tun=${4:-} f=$W/scale/$1.txt
  [ -s "$f" ] && return 0
  local per=$((GAMES / procs)) i
  echo "== $name（$procs プロセス × $t スレッド、${tun:-既定の malloc}）$(date '+%H:%M:%S')"
  local TIMEFORMAT='%R %U %S'
  {
    time {
      for ((i = 0; i < procs; i++)); do
        THREADS=$t GLIBC_TUNABLES=$tun $B compare "$per" '{}' '{}' $((i * per)) > "$W/scale/$name-$i.log" 2>&1 &
      done
      wait
    }
  } 2> "$f.time"
  echo "$name $procs $t $((per * procs * 2)) $(cat "$f.time")" > "$f.tmp"
  mv "$f.tmp" "$f"
}

step p1-t$((N / 2)) 1 $((N / 2))
step p1-t"$N" 1 "$N"
step p2-t$((N / 2)) 2 $((N / 2))
step p4-t$((N / 4)) 4 $((N / 4))
step p1-t"$N"-tuned 1 "$N" "$TUNED"
step p2-t$((N / 2))-tuned 2 $((N / 2)) "$TUNED"

{
  echo "# 並列の伸び（$(lscpu | sed -n 's/^Model name: *//p' | head -n 1)、$N スレッド、glibc $(ldd --version | head -n 1 | awk '{print $NF}')）"
  echo
  echo "user・sys は全スレッドの合計の CPU 秒。sys が大きければ OS の中（メモリの割り当て等）で待っている。"
  echo
  echo "| 段階 | プロセス | スレッド/プロセス | 試合 | 秒 | 秒/試合 | user 秒/試合 | sys 秒/試合 |"
  echo "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  for f in "$W"/scale/*.txt; do
    awk '{printf "| %s | %d | %d | %d | %.1f | %.4f | %.2f | %.2f |\n", $1, $2, $3, $4, $5, $5 / $4, $6 / $4, $7 / $4}' "$f"
  done
} > "$W/scale.md"
cat "$W/scale.md"
