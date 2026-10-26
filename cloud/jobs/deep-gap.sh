#!/bin/bash
# 自己対戦の局面で、今の AI の手と時間をかけた深い読みの手を比べ、差の大きい局面を集める
# （docs/ai-notes.md「深い読みと食い違う局面を集める」。道具は svwb deep-gap、説明は rust/engine/src/runner/deep_gap.rs の先頭）。
#
# 1. 局面集め（deep-gap play）: 今の既定の AI どうしの GAMES 試合の、自分のターンの最初の局面ごとに、試合のターンと深い読みのターンを比べる
# 2. 途中のまとめ（report.md。最後まで打つ前のもの）
# 3. 最後まで打って確かめる（deep-gap rollout）: 差の大きい TOP 局面と、乱数で選んだ RANDOM_N 局面を、M 通りずつ最後まで打つ
# 4. 深い読みと今の既定の AI の勝率（compare CMP 組。深い読みが打ち合いでも強いか）
# 5. （DANGER_CMP > 0 のとき）読み直した手がどれも負けと読めたら終局面を読み足す（dangerRescore DANGER_N）と今の既定の AI の勝率（compare DANGER_CMP 組）
# 6. まとめ（report.md を最後まで打った結果込みで書き直す）
#
# クラウドで: cloud/gcp.sh run deepgap1 cloud/jobs/deep-gap.sh --hours 2 [--env GAMES=800] [--env TOP=150] …
# PC で（リポジトリの一番上で）: CLOUD_W=~/deep-gap bash cloud/jobs/deep-gap.sh 2>&1 | tee -a ~/deep-gap/job.log
# 小さく試す: CLOUD_W=/tmp/dg GAMES=3 TOP=1 RANDOM_N=1 M=2 CMP=1 bash cloud/jobs/deep-gap.sh
#
# 途中で止めても、局面集めは済んだ試合、最後まで打つ段は済んだ局面を飛ばして続きから回る。
set -euo pipefail
W=${CLOUD_W:?}
GAMES=${GAMES:-800}            # 局面を集める試合の数（試合 START から）
START=${START:-0}
K=${K:-4}                      # 差を測る決定化の数
TOP=${TOP:-150}                # 最後まで打つ局面: 差の大きい順
RANDOM_N=${RANDOM_N:-150}      # 最後まで打つ局面: 残りから乱数で
M=${M:-48}                     # 最後まで打つ決定化の数（1 局面あたり）
CMP=${CMP:-400}                # 深い読みと今の既定の AI の compare の組の数（試合はその 2 倍。0 なら打たない）
DANGER_CMP=${DANGER_CMP:-0}    # dangerRescore と今の既定の AI の compare の組の数（0 なら打たない）
DANGER_N=${DANGER_N:-16}       # dangerRescore で読み足す終局面の数
# 深い読みの設定（svwb deep-gap の既定 DEEP_DEFAULT と同じ）
DEEP=${DEEP:-'{"beamWidth":512,"rescoreTop":8,"planCandidates":3,"oppHandSamples":48,"opponentSearch":{"beamWidth":32,"maxDepth":8}}'}
B=rust/target/release/svwb
mkdir -p "$W"
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine

# 1. 局面集め
if [ ! -f "$W/play.done" ]; then
  $B deep-gap play --out "$W/gap.jsonl" --games "$GAMES" --start "$START" --k "$K" --deep "$DEEP" >> "$W/play.log" 2>&1
  touch "$W/play.done"
fi
echo "== 局面集め $(date '+%m-%d %H:%M')"; grep -E "^完了" "$W/play.log" | tail -n 1

# 2. 途中のまとめ
$B deep-gap report "$W/gap.jsonl" --top 40 > "$W/report.md.tmp"
mv "$W/report.md.tmp" "$W/report.md"
sed -n 1,8p "$W/report.md"

# 3. 最後まで打って確かめる
if [ ! -f "$W/rollout.done" ]; then
  $B deep-gap rollout --in "$W/gap.jsonl" --out "$W/roll.jsonl" --top "$TOP" --random "$RANDOM_N" --m "$M" >> "$W/rollout.log" 2>&1
  touch "$W/rollout.done"
fi
echo "== 最後まで打つ $(date '+%m-%d %H:%M')"; grep -E "^完了" "$W/rollout.log" | tail -n 1

# 4. 深い読みと今の既定の AI の打ち合い
if [ "$CMP" -gt 0 ] && [ ! -s "$W/cmp.log" ]; then
  $B compare "$CMP" "$DEEP" '{}' 0 > "$W/cmp.log.tmp" 2>&1
  mv "$W/cmp.log.tmp" "$W/cmp.log"
fi
[ -s "$W/cmp.log" ] && { echo "== 深い読みと今の既定"; tail -n 3 "$W/cmp.log"; }

# 5. 読み直した手がどれも負けと読めたら読み足す（dangerRescore）と今の既定の打ち合い
if [ "$DANGER_CMP" -gt 0 ] && [ ! -s "$W/danger.log" ]; then
  $B compare "$DANGER_CMP" "{\"dangerRescore\":$DANGER_N}" '{}' 0 > "$W/danger.log.tmp" 2>&1
  mv "$W/danger.log.tmp" "$W/danger.log"
fi
[ -s "$W/danger.log" ] && { echo "== dangerRescore $DANGER_N と今の既定"; tail -n 3 "$W/danger.log"; }

# 6. まとめ
$B deep-gap report "$W/gap.jsonl" --rollouts "$W/roll.jsonl" --top 40 > "$W/report.md.tmp"
mv "$W/report.md.tmp" "$W/report.md"
echo DONE "$(date '+%m-%d %H:%M')"
