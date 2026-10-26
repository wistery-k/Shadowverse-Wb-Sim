#!/bin/bash
# マリガンの案を、BASE のマリガンと打ち比べる（svwb mulligan-compare。7 デッキ × 相手 6 デッキ × 席 2 × GAMES の組。相手は今の探索 AI）。
# BASE の既定は '{}'（今の既定。2026-10-26 から turn1・3 ターン）。2026-10-26 の記録は、その前の既定の手札の形のモデル
# BASE='{"mulligan":"model"}' と比べたもの。docs/ai-notes.md「引き直した後に先へ進めてから採点するマリガン」
#
# PC で（既定。リポジトリの一番上で。Docker のコンテナでは ~/svwb-data の下に置く）:
#   mkdir -p ~/svwb-data/mull-rollout && CLOUD_W=~/svwb-data/mull-rollout bash cloud/jobs/mulligan-rollout.sh 2>&1 | tee -a ~/svwb-data/mull-rollout/job.log
# 比べ用（1 枚も返さない・コスト 4 以上を返す・手札の形のモデル）:
#   CLOUD_W=~/svwb-data/mull-rollout GAMES=25 VARIANTS=refs bash cloud/jobs/mulligan-rollout.sh
# 重いカードの 1 枚目を必ず残す（自分のデッキはそのカードの入った 4 つだけ）:
#   CLOUD_W=~/svwb-data/mull-rollout GAMES=100 VARIANTS=heavy DECKS=スペルウィッチ,ミッドレンジナイトメア,AFネメシス,疾走ドラゴン bash cloud/jobs/mulligan-rollout.sh
# 小さく試す: CLOUD_W=/tmp/mr GAMES=1 bash cloud/jobs/mulligan-rollout.sh
#
# 終わった案（$W/<名前>-s<SEED>-g<START>-n<GAMES>.txt がある）は飛ばす（名前に BASE は入らないので、BASE を変えたら CLOUD_W も変える）。結果は $W/<名前>.txt（mulligan-compare の表）と $W/mulligan.md（全体の行を並べたもの）。
# 案を変えるときは VARIANTS に「名前=設定の JSON」を空白で区切って渡す。
set -euo pipefail
W=${CLOUD_W:?}
GAMES=${GAMES:-50}
START=${START:-0}
SEED=${SEED:-1}
VARIANTS=${VARIANTS:-'t0={"mulligan":"turn1","mulliganTurns":0} t3g={"mulligan":"turn1","mulliganTurns":3} t3s={"mulligan":"turn1","mulliganTurns":3,"mulliganNet":false} t3b={"mulligan":"turn1","mulliganTurns":3,"mulliganRolloutBeam":16,"mulliganSamples":32}'}
# 比べ用の案（VARIANTS=refs で回す。マリガンの効き目の大きさの目安）
REFS='keep={"mulligan":"keep"} cost={"mulligan":"cost"} model={"mulligan":"model"}'
[ "$VARIANTS" = refs ] && VARIANTS=$REFS
# 重いカードの 1 枚目を必ず残す（ユーザーの挙げたカード）
HEAVY='heavy={"mulligan":"model","mulliganKeep":["五行の果て・クオン","奔放なる獄炎・ケルベロス","プロシードハート・オーキス","龍人演義・ガリュウ"]}'
[ "$VARIANTS" = heavy ] && VARIANTS=$HEAVY
DECKS=${DECKS:-}            # 自分のデッキを絞る（mulligan-compare --decks）
BASE=${BASE:-'{}'}
B=rust/target/release/svwb
mkdir -p "$W"
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine
echo "commit $(git rev-parse --short HEAD) seed $SEED games $START..$((START + GAMES - 1)) base $BASE" | tee -a "$W/mulligan.md"
for v in $VARIANTS; do
  name=${v%%=*}
  opts=${v#*=}
  out=$W/$name-s$SEED-g$START-n$GAMES.txt
  [ -f "$out" ] && continue
  echo "== $name $opts $(date '+%m-%d %H:%M')"
  $B mulligan-compare --games "$GAMES" --start "$START" --seed "$SEED" --a "$opts" --b "$BASE" ${DECKS:+--decks "$DECKS"} > "$out.tmp" 2> "$out.log"
  mv "$out.tmp" "$out"
  cat "$out"
  echo "| $name | $opts | $(grep '^| 全体' "$out" | cut -d'|' -f3-) " >> "$W/mulligan.md"
done
cat "$W/mulligan.md"
