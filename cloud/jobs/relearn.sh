#!/bin/bash
# 今の既定の AI の自己対戦で、評価の補正を学び直す（docs/ai-notes.md「強くなった探索の棋譜で補正を学び直す」）。
# 今の既定の補正 NET0 で自己対戦を G 試合作り（svwb td selfplay。今の既定の探索の読み方）、NET0 から学び直し（td train）、
# 学習データに出なかった入力を 0 にして（td prune）、学んでいないカードの行を属性の分で埋め（td attr --keepA 0）、
# 学び直した補正の点数で、ターン途中の見込み（potentialNet）も学び直し（POT=1。svwb beam-gap --sample --inputs → npm run potential -- train）、
# 今の既定の AI と打ち比べる（compare。選ぶのに使う試合と、確かめの試合）。強い相手・弱い相手の物差しとリノセウス用 AI も測る。
# 打ち方・学び方は今までの学び直しの手順（docs/ai-notes.md の「今の AI」の「補正を学び直すときの手順」）と同じ。
# 学習の出発点の評価 S は 0（BASE=zero、td train --base zero。手で作った評価を使わず補正だけで点数を付ける。2026-10-27 のユーザー判断、
# docs/ai-notes.md「評価関数の手作りの項を外す」）。今までどおり S ありで学ぶなら BASE=search。
# 見込みは評価の点数の差を当てるので、評価を変えたら学び直す（docs/ai-notes.md「ターン途中の見込みを学ぶ」）。学び方は potential-1 と同じ
# （今の既定の自己対戦の試合 POT_FROM〜 の POT_GAMES 試合で、見込みなしの幅 4096 のビームが残した局面を局面ごとに 100 個。最後の POT_VALID 試合は学ばず確かめに使う）。
# 判定は「学び直した補正 ＋ 学び直した見込み」で打つ（リノセウス用 AI は見込みを使わないので補正だけ）。補正だけ替えた版も CMPV 組だけ測る。
# 自己対戦はターン末の局面に探索の値の材料も書く（td selfplay --searchValue 1。打つ手は変わらない）。学習の目標に探索の値を混ぜるなら
# TRAIN_EXTRA='--searchTarget 0.5' のように渡す（docs/ai-notes.md「補正の学習の目標に探索の値を使う」）。
# 同じ自己対戦から学び方を変えた補正をいくつも作るときは、NAME を変えて流す（最後の 1 つの前までは KEEP=1 で学習のデータを残す）。
#
# PC で（既定。リポジトリの一番上で。Docker のコンテナでは ~/svwb-data の下に置く）:
#   mkdir -p ~/svwb-data/td-relearn7 && CLOUD_W=~/svwb-data/td-relearn7 bash cloud/jobs/relearn.sh 2>&1 | tee -a ~/svwb-data/td-relearn7/relearn.log
# クラウドで（使うたびにユーザーの承認が要る）: cloud/gcp.sh run relearn7 cloud/jobs/relearn.sh --hours 4
# 自己対戦だけクラウドで: cloud/gcp.sh run relearn7 cloud/jobs/relearn.sh --hours 3 --env STOP_AFTER=selfplay
#   → 作業フォルダの s<i>.jsonl.gz を PC の作業フォルダに写し、PC で上の形で流す（自己対戦は飛ばして学習から回る）
# 補正の学習までで止める: STOP_AFTER=model（できた ${NAME}pa.json を PC の作業フォルダに置いて流すと、見込みの学び直しと判定から回る）
# 小さく試す: CLOUD_W=/tmp/rl G=40 CHUNK=20 CMP=10 CMP2=10 CMPV=10 YS=10 RHINO=2 POT_GAMES=12 POT_VALID=4 bash cloud/jobs/relearn.sh
#
# 途中で止めても、終わった段階（自己対戦の CHUNK 試合ごと・学習・間引き・埋め・見込みのデータの 500 試合ごと・見込みの学習・比べごと）は飛ばして続きから回る。
# 自己対戦は CHUNK 試合ごとに s<i>.jsonl.gz に残す。学習・間引きに読むのは gzip する前の s<i>.jsonl.tmp
# （.tmp はクラウドの作業フォルダの写しに入らない。止められて作り直された VM では .gz から戻す）で、間引きが終わったら消す（KEEP=1 なら残す）。
# 結果は $W/relearn-$NAME.md。PC（CLOUD_W が ~/svwb-data の下）なら最後に pack-run でモデルとログだけを ~/svwb-data/upload/ にまとめる
# （共有フォルダに上げる用。自己対戦は大きいので入れない。PACK=0 でしない）。
set -euo pipefail
W=${CLOUD_W:?}
G=${G:-60000}                  # 自己対戦の試合数（介入の試合は別に数える）
CHUNK=${CHUNK:-3000}           # 自己対戦のファイル 1 つの試合数（止められたときにやり直す単位）
SEED0=${SEED0:-6000000}        # 自己対戦の最初の試合番号（今までの学び直し・狙い撃ちの試合番号と重ならない）
NET0=${NET0:-data/value-net.json}  # 自己対戦を打つ補正と、学習の出発点
NAME=${NAME:-t}                # 学んだ補正の名前（$NAME.json → 間引き ${NAME}p.json → 埋め ${NAME}pa.json）
IV=${IV:-3}                    # 介入の数（今までの学び直しの手順と同じ）
SP_EXTRA=${SP_EXTRA:-}         # td selfplay に足す引数（打つ手を変えないもの。例: --sDefault 1）
TRAIN_EXTRA=${TRAIN_EXTRA:-}   # td train に足す引数（例: --searchTarget 0.5）
LR=${LR:-0.0003}
EPOCHS=${EPOCHS:-3}
BASE=${BASE:-zero}             # 学習の出発点の評価 S（td train --base。zero・default・search）
CMP=${CMP:-3000}               # 今の既定の AI との比べの組の数（試合はその 2 倍）。g0 から
CMP2=${CMP2:-3000}             # 確かめの組の数。g$CMP から（選ぶのに使っていない試合）
YS=${YS:-1000}                 # 物差しの組の数（強い相手・弱い相手。試合はその 2 倍）
RHINO=${RHINO:-150}            # リノセウス用 AI の rhino-compare --games（試合は 12 倍）。今の既定も同じ試合で測る
CMPV=${CMPV:-1000}             # 補正だけ替えた版（見込みは今の既定のまま）と今の既定の比べの組の数（g0 から。0 なら測らない。POT=1 のときだけ）
POT=${POT:-1}                  # 見込み（potentialNet）も学び直す（1）。0 なら見込みは今の既定のまま判定する
POT_FROM=${POT_FROM:-1000}     # 見込みの学びのデータを作る試合（beam-gap の自己対戦。今の既定どうし）の最初の番号
POT_GAMES=${POT_GAMES:-2000}   # その試合数（500 試合ずつのファイルに分ける）
POT_VALID=${POT_VALID:-200}    # そのうち最後の何試合を学ばずに確かめに使うか
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
M=$W/$NAME.json; MP=$W/${NAME}p.json; MPA=$W/${NAME}pa.json; MPOT=$W/${NAME}pot.json

# 判定する補正（${NAME}pa.json）が作業フォルダにあれば、自己対戦・学習・間引き・埋めは飛ばして判定だけ回す
# （学習を別の場所で回して、判定だけ PC で回すとき）
if [ ! -f "$MPA" ]; then
  # 1. 自己対戦（両方の席が NET0 の今の既定の探索 AI。ランダムな手・介入・想像の局面は今までの学び直しと同じ）
  files=()
  for i in $(seq 0 $((NC - 1))); do
    f=$W/s$i.jsonl
    files+=("$f.tmp")
    [ -f "$f.gz" ] && continue
    n=$(( G - CHUNK * i < CHUNK ? G - CHUNK * i : CHUNK ))
    # shellcheck disable=SC2086
    $B td selfplay --model "$W/net0.json" --games "$n" --start $((SEED0 + CHUNK * i)) \
      --eps 0.1 --opp beam --sampling default --iv "$IV" --ivZone both --imagined 2 --searchValue 1 $SP_EXTRA --out "$f.tmp" > "$f.log" 2>&1
    gzip -c "$f.tmp" > "$f.gz.tmp"
    mv "$f.gz.tmp" "$f.gz"
    echo "== 自己対戦 s$i $(date '+%m-%d %H:%M')"; grep -E "試合、局面" "$f.log" | sed 's|^.*: ||'
  done
  if [ "${STOP_AFTER:-}" = selfplay ]; then
    # 自己対戦だけクラウドで作り、学習と判定は PC で回すとき。s<i>.jsonl.gz を PC の同じ作業フォルダに置いて流し直すと、続きから回る
    echo "== 自己対戦まで（STOP_AFTER=selfplay）"
    echo DONE "$(date '+%m-%d %H:%M')"
    exit 0
  fi
  restore() {
    for f in "${files[@]}"; do
      [ -f "$f" ] || { gunzip -c "${f%.tmp}.gz" > "$f.u.tmp"; mv "$f.u.tmp" "$f"; }
    done
  }
  DATA=$(IFS=,; echo "${files[*]}")

  # 2. NET0 から学び直す
  if [ ! -f "$M" ]; then
    restore
    # shellcheck disable=SC2086
    npm run -s td -- train --model "$W/net0.json" --data "$DATA" --out "$M.tmp" \
      --epochs "$EPOCHS" --lr "$LR" --l2 0.001 --best 1 --bestOn end,imagined --ivRes 0 --base "$BASE" $TRAIN_EXTRA > "$W/$NAME-train.log" 2>&1
    mv "$M.tmp" "$M"
  fi
  echo "== 学習 $NAME $(date '+%m-%d %H:%M')"; grep -hE "^(出発点|探索の値|学習前|エポック|確かめ用|補正)" "$W/$NAME-train.log" | cut -c1-240

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
else
  echo "== $MPA があるので、判定から回す"
  sha256sum "$MPA"
fi

if [ "${STOP_AFTER:-}" = model ]; then
  # 補正の学習までを別の場所（Claude のクラウド環境など）で回し、${NAME}pa.json を PC の作業フォルダに置いて、見込みと判定を PC で回すとき
  echo "== 補正の学習まで（STOP_AFTER=model）"
  echo DONE "$(date '+%m-%d %H:%M')"
  exit 0
fi

# 3.5 学び直した補正の点数で、見込み（potentialNet）を学び直す
OPTV="{\"valueNet\":\"$MPA\"}"
if [ "$POT" = 1 ]; then
  PREF="{\"beamWidth\":4096,\"potentialNet\":null,\"valueNet\":\"$MPA\"}"
  PVAR="{\"w32\":{\"beamWidth\":32,\"potentialNet\":null,\"valueNet\":\"$MPA\"}}"
  PT=$((POT_GAMES - POT_VALID))
  pfiles=()
  pot_chunk() { # pot_chunk <名前> <最初の試合> <試合数> [確かめの局面を書くか]
    local f=$W/pot-$1.jsonl
    pfiles+=("$f")
    [ -f "$f" ] || [ -f "$MPOT" ] && return 0
    local save=()
    [ -n "${4:-}" ] && save=(--savePositions "$W/pot-$1-pos.jsonl")
    $B beam-gap --games "$3" --from "$2" --ref "$PREF" --variants "$PVAR" --sample 100 --inputs "$f.tmp" ${save[@]+"${save[@]}"} \
      --out "$W/pot-$1-rows.jsonl" > "$W/pot-$1.txt" 2> "$W/pot-$1.log"
    mv "$f.tmp" "$f"
    echo "== 見込みのデータ pot-$1（g$2〜$(($2 + $3 - 1))） $(date '+%m-%d %H:%M')"
  }
  c=0
  for s in $(seq 0 500 $((PT - 1))); do
    pot_chunk "d$c" $((POT_FROM + s)) $(( PT - s < 500 ? PT - s : 500 ))
    c=$((c + 1))
  done
  pot_chunk val $((POT_FROM + PT)) "$POT_VALID" save
  if [ ! -f "$MPOT" ]; then
    npm run -s potential -- train --data "$(IFS=,; echo "${pfiles[*]}")" --valid "$((POT_FROM + PT))-$((POT_FROM + POT_GAMES - 1))" \
      --out "$MPOT.tmp" > "$W/$NAME-pot-train.log" 2>&1
    mv "$MPOT.tmp" "$MPOT"
  fi
  echo "== 見込みの学習 ${NAME}pot $(date '+%m-%d %H:%M')"; tail -n 3 "$W/$NAME-pot-train.log"
  [ -n "$KEEP" ] || rm -f "${pfiles[@]}"
  # 学ばなかった試合の局面で、ビームの取りこぼし（見込みなし・今の既定の見込み・学び直した見込み。どれも学び直した補正で採点）
  if [ ! -s "$W/$NAME-pot-eval.txt" ]; then
    EVAR="{\"w32\":{\"beamWidth\":32,\"potentialNet\":null,\"valueNet\":\"$MPA\"},\"w32cur\":{\"beamWidth\":32,\"valueNet\":\"$MPA\"},\"w32new\":{\"beamWidth\":32,\"potentialNet\":\"$MPOT\",\"valueNet\":\"$MPA\"},"
    EVAR+="\"w128\":{\"beamWidth\":128,\"potentialNet\":null,\"valueNet\":\"$MPA\"},\"w128cur\":{\"beamWidth\":128,\"valueNet\":\"$MPA\"},\"w128new\":{\"beamWidth\":128,\"potentialNet\":\"$MPOT\",\"valueNet\":\"$MPA\"}}"
    $B beam-gap --positions "$W/pot-val-pos.jsonl" --refFrom "$W/pot-val-rows.jsonl" --ref "$PREF" --variants "$EVAR" \
      > "$W/$NAME-pot-eval.txt.tmp" 2> "$W/$NAME-pot-eval.log"
    mv "$W/$NAME-pot-eval.txt.tmp" "$W/$NAME-pot-eval.txt"
  fi
  echo "== 見込みの取りこぼし（学ばなかった g$((POT_FROM + PT))〜）"; { grep -E "^(基準|全部|  )" "$W/$NAME-pot-eval.txt" || true; } | head -n 9 | sed "s|$W/||g"
  sha256sum "$MPOT"
  OPT="{\"valueNet\":\"$MPA\",\"potentialNet\":\"$MPOT\"}"
else
  OPT=$OPTV
fi

# 4. 判定（ログが空でなければ飛ばす）
run() { # run <ログ> <コマンド…>
  local log=$1; shift
  [ -s "$log" ] && return 0
  "$@" > "$log.tmp" 2>&1
  mv "$log.tmp" "$log"
}
run "$W/$NAME-cmp0.log" $B compare "$CMP" "$OPT" '{}' 0
echo "== $NAME と今の既定（g0〜$((CMP - 1))）"; tail -n 3 "$W/$NAME-cmp0.log"
run "$W/$NAME-cmp1.log" $B compare "$CMP2" "$OPT" '{}' "$CMP"
echo "== $NAME と今の既定（確かめ、g$CMP〜$((CMP + CMP2 - 1))）"; tail -n 3 "$W/$NAME-cmp1.log"
if [ "$POT" = 1 ] && [ "$CMPV" -gt 0 ]; then
  run "$W/$NAME-cmpv.log" $B compare "$CMPV" "$OPTV" '{}' 0
  echo "== $NAME の補正だけ（見込みは今の既定）と今の既定（g0〜$((CMPV - 1))）"; tail -n 3 "$W/$NAME-cmpv.log"
fi
run "$W/$NAME-ys-strong.log" $B yardstick --ref strong --opts "$OPT" --games "$YS"
run "$W/$NAME-ys-classic.log" $B yardstick --opts "$OPT" --games "$YS"
# リノセウス用 AI は見込みを使わない（rhino.rs の rhino_search_options）ので、補正だけ替える
run "$W/$NAME-rhino.log" $B rhino-compare --games "$RHINO" --opts "$OPTV"
run "$W/cur-rhino.log" $B rhino-compare --games "$RHINO"
for l in ys-strong ys-classic rhino; do echo "== $NAME $l"; tail -n 4 "$W/$NAME-$l.log"; done
echo "== 今の既定 rhino"; tail -n 4 "$W/cur-rhino.log"

# まとめ
pct() { grep -m 1 -oE '[0-9]+/[0-9]+ = [0-9.]+%' "$1" || true; }
{
  echo "# 補正の学び直し（$NAME、出発点 $NET0、S は --base $BASE${TRAIN_EXTRA:+、学習 $TRAIN_EXTRA}、自己対戦 $G 試合・g$SEED0〜）"
  echo
  echo "判定した設定（作業フォルダの中のファイル）: \`${OPT//$W\//}\`（リノセウス用 AI は \`${OPTV//$W\//}\`）"
  echo
  echo "| 判定 | 勝率 |"
  echo "| --- | ---: |"
  echo "| 今の既定と（g0〜$((CMP - 1))） | $(pct "$W/$NAME-cmp0.log") |"
  echo "| 今の既定と（確かめ、g$CMP〜$((CMP + CMP2 - 1))） | $(pct "$W/$NAME-cmp1.log") |"
  [ -s "$W/$NAME-cmpv.log" ] && echo "| 補正だけ（見込みは今の既定）と今の既定（g0〜$((CMPV - 1))） | $(pct "$W/$NAME-cmpv.log") |"
  echo "| 強い相手の物差し | $(pct "$W/$NAME-ys-strong.log") |"
  echo "| 物差し | $(pct "$W/$NAME-ys-classic.log") |"
  echo "| リノセウス用 AI（$NAME） | $(pct "$W/$NAME-rhino.log") |"
  echo "| リノセウス用 AI（今の既定） | $(pct "$W/cur-rhino.log") |"
  echo
  echo "デッキごと（比べの A のデッキ別）:"
  echo
  echo "- g0〜: $(sed -n 2p "$W/$NAME-cmp0.log")"
  echo "- 確かめ: $(sed -n 2p "$W/$NAME-cmp1.log")"
  if [ -s "$W/$NAME-pot-eval.txt" ]; then
    echo
    echo "見込みの取りこぼし（学ばなかった試合の局面。基準は見込みなしの幅 4096、どれも学び直した補正で採点。cur は今の既定の見込み、new は学び直した見込み）:"
    echo
    echo '```'
    { grep -E "^(基準|全部|  )" "$W/$NAME-pot-eval.txt" || true; } | head -n 9 | sed "s|$W/||g"
    echo '```'
  fi
} > "$W/relearn-$NAME.md"
cat "$W/relearn-$NAME.md"
case "$W" in
  */svwb-data/*) [ "$PACK" = 0 ] || npm run -s pack-run -- "$W" --name "$(basename "$W")" --note '強くなった探索の棋譜で補正を学び直す（relearn.sh）' \
    --out "$HOME/svwb-data/upload" --exclude 'net0.json' --only models,logs --force ;;
esac
echo DONE "$(date '+%m-%d %H:%M')"
