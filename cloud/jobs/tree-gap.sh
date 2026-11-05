#!/bin/bash
# 段階 1 の計測: 自分のターンの木の探索（SearchOptions.tree。案 A0・A（B*）・B（MCTS）・A'（下限を後回し））を、今のビームと
# 読んだ局面の数あたりの取りこぼしで比べる（docs/ai-notes.md「自分のターンの探索を B*・MCTS に」。道具は svwb beam-gap・svwb tree-gap）。
#
# 1. 楽観の値の学びのデータ: 試合 FIT_FROM から FIT_GAMES 試合の局面で幅 4096 のビームを打ち、途中の局面を FIT_SAMPLE 個ずつ書く
# 2. 伸びしろの上側の表（tau 0.8・0.9・0.95）と、案 A' の下限と上限のネットワーク（tau 0.95）を作る
# 3. 確かめの局面（VAL。relearn9 の確かめの 3869 局面）で、基準（幅 4096・見込みなし）と今のビーム 12 通り
# 4. 同じ局面で、木の探索 14 通り（予算 64000、途中 250〜64000 の最善も書く）
# 5. まとめ（tree-gap report。report.txt と report.tsv）
#
# PC の Docker コンテナで（リポジトリの一番上で）:
#   mkdir -p ~/svwb-data/tree-gap1 && CLOUD_W=~/svwb-data/tree-gap1 VAL=<pot-val-pos.jsonl> bash cloud/jobs/tree-gap.sh 2>&1 | tee -a ~/svwb-data/tree-gap1/job.log
# 小さく試す: CLOUD_W=/tmp/tg FIT_GAMES=4 VAL_EVERY=200 bash cloud/jobs/tree-gap.sh
#
# 途中で止めても、済んだ段（できたファイル）は飛ばして続きから回る。
set -euo pipefail
W=${CLOUD_W:?}
VAL=${VAL:-}                    # 確かめの局面（beam-gap --savePositions の形）。無ければ試合 2800〜2999 から集める
VAL_EVERY=${VAL_EVERY:-1}       # 確かめの局面を間引く（k 局面に 1 つ）
FIT_FROM=${FIT_FROM:-1000}
FIT_GAMES=${FIT_GAMES:-200}
FIT_SAMPLE=${FIT_SAMPLE:-48}
BUDGET=${BUDGET:-64000}
MARKS=${MARKS:-250,500,1000,2000,4000,8000,16000,32000,64000}
REF='{"beamWidth":4096,"potentialNet":null}'
B=rust/target/release/svwb
mkdir -p "$W"
log() { echo "== $* $(date '+%m-%d %H:%M')"; }
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine

# 1. 楽観の値の学びのデータ
if [ ! -s "$W/fit-ref.jsonl" ]; then
  log "学びのデータ 開始"
  $B beam-gap --games "$FIT_GAMES" --from "$FIT_FROM" --ref "$REF" --variants '{}' --sample "$FIT_SAMPLE" \
    --nodes "$W/fit-nodes.jsonl" --inputs "$W/fit-inputs.jsonl" --out "$W/fit-ref.jsonl.tmp" > "$W/fit.log" 2>&1
  mv "$W/fit-ref.jsonl.tmp" "$W/fit-ref.jsonl"
fi

# 2. 表とネットワーク
for t in 0.8 0.9 0.95; do
  [ -s "$W/upper-$t.json" ] || $B tree-gap upper-fit --nodes "$W/fit-nodes.jsonl" --tau "$t" --out "$W/upper-$t.json" > "$W/upper-$t.txt"
done
if [ ! -s "$W/bounds-0.95.json" ]; then
  log "下限と上限のネットワーク 開始"
  last=$((FIT_FROM + FIT_GAMES - 1))
  npm run -s potential -- bounds --data "$W/fit-inputs.jsonl" --out "$W/bounds-0.95.json" --tau 0.95 \
    --valid "$((last - FIT_GAMES / 10 + 1))-$last" > "$W/bounds-0.95.log" 2>&1
fi

# 3. 基準と今のビーム
if [ -z "$VAL" ]; then
  VAL="$W/val-pos.jsonl"
  [ -s "$VAL" ] || $B beam-gap --games 200 --from 2800 --ref '{"beamWidth":1}' --variants '{}' --savePositions "$VAL" > "$W/val.log" 2>&1
fi
POS="$W/positions.jsonl"
[ -s "$POS" ] || awk -v k="$VAL_EVERY" '(NR - 1) % k == 0' "$VAL" > "$POS"
BEAMS='{'
for w in 16 32 64 128 256 512; do BEAMS="$BEAMS\"w$w\":{\"beamWidth\":$w},"; done
for w in 32 64 128 256 512 1024; do BEAMS="$BEAMS\"w$w-nopot\":{\"beamWidth\":$w,\"potentialNet\":null},"; done
BEAMS="${BEAMS%,}}"
if [ ! -s "$W/beams.jsonl" ]; then
  log "基準とビーム 開始"
  $B beam-gap --positions "$POS" --ref "$REF" --variants "$BEAMS" --out "$W/beams.jsonl.tmp" > "$W/beams.log" 2>&1
  mv "$W/beams.jsonl.tmp" "$W/beams.jsonl"
fi

# 4. 木の探索
T="\"budget\":$BUDGET"
U95="\"upper\":\"$W/upper-0.95.json\""
L="\"lazy\":\"$W/bounds-0.95.json\""
TREES="{\
\"a0-95\":{\"tree\":{\"mode\":\"a0\",$T,$U95}},\
\"a0-95x4\":{\"tree\":{\"mode\":\"a0\",$T,$U95,\"upperScale\":4}},\
\"a0-95x16\":{\"tree\":{\"mode\":\"a0\",$T,$U95,\"upperScale\":16}},\
\"bstar-80\":{\"tree\":{\"mode\":\"bstar\",$T,\"upper\":\"$W/upper-0.8.json\"}},\
\"bstar-90\":{\"tree\":{\"mode\":\"bstar\",$T,\"upper\":\"$W/upper-0.9.json\"}},\
\"bstar-95\":{\"tree\":{\"mode\":\"bstar\",$T,$U95}},\
\"bstar-95x4\":{\"tree\":{\"mode\":\"bstar\",$T,$U95,\"upperScale\":4}},\
\"bstar-95x16\":{\"tree\":{\"mode\":\"bstar\",$T,$U95,\"upperScale\":16}},\
\"mcts-c0.3\":{\"tree\":{\"mode\":\"mcts\",$T,\"c\":0.3}},\
\"mcts-c1\":{\"tree\":{\"mode\":\"mcts\",$T,\"c\":1}},\
\"mcts-c3\":{\"tree\":{\"mode\":\"mcts\",$T,\"c\":3}},\
\"lazy-95\":{\"tree\":{\"mode\":\"a0\",$T,$L}},\
\"lazy-95x4\":{\"tree\":{\"mode\":\"a0\",$T,$L,\"upperScale\":4}},\
\"lazy-95x16\":{\"tree\":{\"mode\":\"a0\",$T,$L,\"upperScale\":16}}}"
if [ ! -s "$W/trees.jsonl" ]; then
  log "木の探索 開始"
  $B beam-gap --positions "$POS" --refFrom "$W/beams.jsonl" --variants "$TREES" --marks "$MARKS" \
    --out "$W/trees.jsonl.tmp" > "$W/trees.log" 2>&1
  mv "$W/trees.jsonl.tmp" "$W/trees.jsonl"
fi

# 5. まとめ
$B tree-gap report --runs "$W/beams.jsonl,$W/trees.jsonl" --tsv "$W/report.tsv" > "$W/report.txt"
log "終わり"
grep -vE "@" "$W/report.txt" | head -n 40
