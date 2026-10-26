#!/bin/bash
# 引き直した後に先へ進めてから採点するマリガン（`mulligan: "turn1"`）を、今のマリガン（手札の形のモデル）と打ち比べる
# （svwb mulligan-compare。7 デッキ × 相手 6 デッキ × 席 2 × GAMES の組。相手は今の探索 AI）。
# docs/ai-notes.md「引き直した後に先へ進めてから採点するマリガン」
#
# PC で（既定。リポジトリの一番上で。Docker のコンテナでは ~/svwb-data の下に置く）:
#   mkdir -p ~/svwb-data/mull-rollout && CLOUD_W=~/svwb-data/mull-rollout bash cloud/jobs/mulligan-rollout.sh 2>&1 | tee -a ~/svwb-data/mull-rollout/job.log
# 比べ用（1 枚も返さない・コスト 4 以上を返す）:
#   CLOUD_W=~/svwb-data/mull-rollout GAMES=25 VARIANTS=refs bash cloud/jobs/mulligan-rollout.sh
# 小さく試す: CLOUD_W=/tmp/mr GAMES=1 bash cloud/jobs/mulligan-rollout.sh
#
# 終わった案（$W/<名前>.txt がある）は飛ばす。結果は $W/<名前>.txt（mulligan-compare の表）と $W/mulligan.md（全体の行を並べたもの）。
# 案を変えるときは VARIANTS に「名前=設定の JSON」を空白で区切って渡す。
set -euo pipefail
W=${CLOUD_W:?}
GAMES=${GAMES:-50}
START=${START:-0}
SEED=${SEED:-1}
VARIANTS=${VARIANTS:-'t0={"mulligan":"turn1"} t3g={"mulligan":"turn1","mulliganTurns":3} t3s={"mulligan":"turn1","mulliganTurns":3,"mulliganNet":false} t3b={"mulligan":"turn1","mulliganTurns":3,"mulliganRolloutBeam":16,"mulliganSamples":32}'}
# 比べ用の案（VARIANTS=refs で回す。マリガンの効き目の大きさの目安）
REFS='keep={"mulligan":"keep"} cost={"mulligan":"cost"}'
[ "$VARIANTS" = refs ] && VARIANTS=$REFS
B=rust/target/release/svwb
mkdir -p "$W"
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine
echo "commit $(git rev-parse --short HEAD) seed $SEED games $START..$((START + GAMES - 1))" | tee -a "$W/mulligan.md"
for v in $VARIANTS; do
  name=${v%%=*}
  opts=${v#*=}
  out=$W/$name-s$SEED-g$START.txt
  [ -f "$out" ] && continue
  echo "== $name $opts $(date '+%m-%d %H:%M')"
  $B mulligan-compare --games "$GAMES" --start "$START" --seed "$SEED" --a "$opts" --b '{}' > "$out.tmp" 2> "$out.log"
  mv "$out.tmp" "$out"
  cat "$out"
  echo "| $name | $opts | $(grep '^| 全体' "$out" | cut -d'|' -f3-) " >> "$W/mulligan.md"
done
cat "$W/mulligan.md"
