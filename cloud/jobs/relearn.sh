#!/bin/bash
# 今の既定の AI の自己対戦で、評価の補正を学び直す（docs/ai-notes.md「強くなった探索の棋譜で補正を学び直す」）。
# 今の既定の補正 NET0 で自己対戦を G 試合作り（svwb td selfplay。今の既定の探索の読み方）、NET0 から学び直し（td train）、
# 学習データに出なかった入力を 0 にして（td prune）、学んでいないカードの行を属性の分で埋め（td attr --keepA 0）、
# 今の既定の AI と打ち比べる（compare。選ぶのに使う試合と、確かめの試合）。強い相手・弱い相手の物差しとリノセウス用 AI も測る。
# 打ち方・学び方は今までの学び直しの手順（docs/ai-notes.md の「今の AI」の「補正を学び直すときの手順」）と同じ。
#
# PC で（既定。リポジトリの一番上で。Docker のコンテナでは ~/svwb-data の下に置く）:
#   mkdir -p ~/svwb-data/td-relearn7 && CLOUD_W=~/svwb-data/td-relearn7 bash cloud/jobs/relearn.sh 2>&1 | tee -a ~/svwb-data/td-relearn7/relearn.log
# クラウドで（使うたびにユーザーの承認が要る）: cloud/gcp.sh run relearn7 cloud/jobs/relearn.sh --hours 4
# 小さく試す: CLOUD_W=/tmp/rl G=40 CHUNK=20 CMP=10 CMP2=10 YS=10 RHINO=2 bash cloud/jobs/relearn.sh
#
# 途中で止めても、終わった段階（自己対戦の CHUNK 試合ごと・学習・間引き・埋め・比べごと）は飛ばして続きから回る。
# 自己対戦は CHUNK 試合ごとに s<i>.jsonl.gz に残す。学習・間引きに読むのは gzip する前の s<i>.jsonl.tmp
# （.tmp はクラウドの作業フォルダの写しに入らない。止められて作り直された VM では .gz から戻す）で、間引きが終わったら消す（KEEP=1 なら残す）。
# 結果は $W/relearn.md。PC（CLOUD_W が ~/svwb-data の下）なら最後に pack-run でまとめる（PACK=0 でしない）。
set -euo pipefail
W=${CLOUD_W:?}
G=${G:-60000}                  # 自己対戦の試合数（介入の試合は別に数える）
CHUNK=${CHUNK:-3000}           # 自己対戦のファイル 1 つの試合数（止められたときにやり直す単位）
SEED0=${SEED0:-6000000}        # 自己対戦の最初の試合番号（今までの学び直し・狙い撃ちの試合番号と重ならない）
NET0=${NET0:-data/value-net.json}  # 自己対戦を打つ補正と、学習の出発点
NAME=${NAME:-t}                # 学んだ補正の名前（$NAME.json → 間引き ${NAME}p.json → 埋め ${NAME}pa.json）
IV=${IV:-3}                    # 介入の数（今までの学び直しの手順と同じ）
SP_EXTRA=${SP_EXTRA:-}         # td selfplay に足す引数（打つ手を変えないもの。例: --sDefault 1）
LR=${LR:-0.0003}
EPOCHS=${EPOCHS:-3}
CMP=${CMP:-3000}               # 今の既定の AI との比べの組の数（試合はその 2 倍）。g0 から
CMP2=${CMP2:-3000}             # 確かめの組の数。g$CMP から（選ぶのに使っていない試合）
YS=${YS:-1000}                 # 物差しの組の数（強い相手・弱い相手。試合はその 2 倍）
RHINO=${RHINO:-150}            # リノセウス用 AI の rhino-compare --games（試合は 12 倍）。今の既定も同じ試合で測る
PACK=${PACK:-1}
KEEP=${KEEP:-}
B=rust/target/release/svwb
mkdir -p "$W"
npm run -s rust-data -- --quiet
cargo build --quiet --release --manifest-path rust/Cargo.toml -p svwb-engine
[ -f "$NET0" ] || { echo "$NET0 が無い"; exit 1; }
[ -f "$W/net0.json" ] || cp "$NET0" "$W/net0.json"
echo "== $(git rev-parse --short HEAD 2>/dev/null || cat commit 2>/dev/null || echo '?') $(date '+%m-%d %H:%M')"
sha256sum "$W/net0.json"
NC=$(( (G + CHUNK - 1) / CHUNK ))
M=$W/$NAME.json; MP=$W/${NAME}p.json; MPA=$W/${NAME}pa.json

# 1. 自己対戦（両方の席が NET0 の今の既定の探索 AI。ランダムな手・介入・想像の局面は今までの学び直しと同じ）
files=()
for i in $(seq 0 $((NC - 1))); do
  f=$W/s$i.jsonl
  files+=("$f.tmp")
  [ -f "$f.gz" ] && continue
  n=$(( G - CHUNK * i < CHUNK ? G - CHUNK * i : CHUNK ))
  # shellcheck disable=SC2086
  $B td selfplay --model "$W/net0.json" --games "$n" --start $((SEED0 + CHUNK * i)) \
    --eps 0.1 --opp beam --sampling default --iv "$IV" --ivZone both --imagined 2 $SP_EXTRA --out "$f.tmp" > "$f.log" 2>&1
  gzip -c "$f.tmp" > "$f.gz.tmp"
  mv "$f.gz.tmp" "$f.gz"
  echo "== 自己対戦 s$i $(date '+%m-%d %H:%M')"; grep -E "試合、局面" "$f.log" | sed 's|^.*: ||'
done
restore() {
  for f in "${files[@]}"; do
    [ -f "$f" ] || { gunzip -c "${f%.tmp}.gz" > "$f.u.tmp"; mv "$f.u.tmp" "$f"; }
  done
}
DATA=$(IFS=,; echo "${files[*]}")

# 2. NET0 から学び直す
if [ ! -f "$M" ]; then
  restore
  npm run -s td -- train --model "$W/net0.json" --data "$DATA" --out "$M.tmp" \
    --epochs "$EPOCHS" --lr "$LR" --l2 0.001 --best 1 --bestOn end,imagined --ivRes 0 > "$W/$NAME-train.log" 2>&1
  mv "$M.tmp" "$M"
fi
echo "== 学習 $NAME $(date '+%m-%d %H:%M')"; grep -hE "^(学習前|エポック|確かめ用|補正)" "$W/$NAME-train.log" | cut -c1-240

# 3. 学習データに出なかった入力を 0 にし（td prune）、学んでいないカードの行を属性の分で埋める（td attr --keepA 0、λ 3）
if [ ! -f "$MP" ]; then
  restore
  npm run -s td -- prune --model "$M" --data "$DATA" --out "$MP.tmp" > "$W/$NAME-prune.log" 2>&1
  mv "$MP.tmp" "$MP"
fi
[ -n "$KEEP" ] || rm -f "${files[@]}"
if [ ! -f "$MPA" ]; then
  npm run -s td -- attr --model "$MP" --out "$MPA.tmp" --keepA 0 > "$W/$NAME-attr.log" 2>&1
  mv "$MPA.tmp" "$MPA"
fi
cat "$W/$NAME-prune.log" "$W/$NAME-attr.log"
sha256sum "$M" "$MP" "$MPA"

# 4. 判定（ログが空でなければ飛ばす）
run() { # run <ログ> <コマンド…>
  local log=$1; shift
  [ -s "$log" ] && return 0
  "$@" > "$log.tmp" 2>&1
  mv "$log.tmp" "$log"
}
OPT="{\"valueNet\":\"$MPA\"}"
run "$W/$NAME-cmp0.log" $B compare "$CMP" "$OPT" '{}' 0
echo "== $NAME と今の既定（g0〜$((CMP - 1))）"; tail -n 3 "$W/$NAME-cmp0.log"
run "$W/$NAME-cmp1.log" $B compare "$CMP2" "$OPT" '{}' "$CMP"
echo "== $NAME と今の既定（確かめ、g$CMP〜$((CMP + CMP2 - 1))）"; tail -n 3 "$W/$NAME-cmp1.log"
run "$W/$NAME-ys-strong.log" $B yardstick --ref strong --opts "$OPT" --games "$YS"
run "$W/$NAME-ys-classic.log" $B yardstick --opts "$OPT" --games "$YS"
run "$W/$NAME-rhino.log" $B rhino-compare --games "$RHINO" --opts "$OPT"
run "$W/cur-rhino.log" $B rhino-compare --games "$RHINO"
for l in ys-strong ys-classic rhino; do echo "== $NAME $l"; tail -n 4 "$W/$NAME-$l.log"; done
echo "== 今の既定 rhino"; tail -n 4 "$W/cur-rhino.log"

# まとめ
pct() { grep -m 1 -oE '[0-9]+/[0-9]+ = [0-9.]+%' "$1" || true; }
{
  echo "# 補正の学び直し（$NAME、出発点 $NET0、自己対戦 $G 試合・g$SEED0〜）"
  echo
  echo "| 判定 | 勝率 |"
  echo "| --- | ---: |"
  echo "| 今の既定と（g0〜$((CMP - 1))） | $(pct "$W/$NAME-cmp0.log") |"
  echo "| 今の既定と（確かめ、g$CMP〜$((CMP + CMP2 - 1))） | $(pct "$W/$NAME-cmp1.log") |"
  echo "| 強い相手の物差し | $(pct "$W/$NAME-ys-strong.log") |"
  echo "| 物差し | $(pct "$W/$NAME-ys-classic.log") |"
  echo "| リノセウス用 AI（$NAME） | $(pct "$W/$NAME-rhino.log") |"
  echo "| リノセウス用 AI（今の既定） | $(pct "$W/cur-rhino.log") |"
  echo
  echo "デッキごと（比べの A のデッキ別）:"
  echo
  echo "- g0〜: $(sed -n 2p "$W/$NAME-cmp0.log")"
  echo "- 確かめ: $(sed -n 2p "$W/$NAME-cmp1.log")"
} > "$W/relearn.md"
cat "$W/relearn.md"
case "$W" in
  */svwb-data/*) [ "$PACK" = 0 ] || npm run -s pack-run -- "$W" --name "$(basename "$W")" --note '強くなった探索の棋譜で補正を学び直す（relearn.sh）' \
    --out "$HOME/svwb-data/upload" --exclude 'net0.json' --force ;;
esac
echo DONE "$(date '+%m-%d %H:%M')"
