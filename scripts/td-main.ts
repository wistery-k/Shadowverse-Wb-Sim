// TD 学習の実験（npm run td）。docs/ai-notes.md「評価の項目を手で作らない（TD 学習）」
//
// 評価関数から、人が見つけたデッキ専用の項（STRIPPED）を外した点数 S を出発点にし、
// 勝つ確率 σ(a × S + c + L(局面)) の補正 L（scripts/valueNet.ts。探索で使う推論は rust/engine/src/ai/valuenet.rs）を、その評価で打った自己対戦から TD(λ) で学ぶ。
// 外した項を学習で取り戻せるか（今の AI との勝率の差が縮まるか）で、学習が「眺めるだけ」を越えるかを確かめる。
//
//   npm run td -- init --out m0.json [--hidden 32] [--seed 1] [--a 0.08] [--base stripped|current] [--inputs v2|v1]
//     L = 0 のモデルを作る（--base current なら今の評価関数をそのまま出発点にする。--inputs v1 なら場の攻撃力・体力等を足す前の入力）。
//     --hidden 256,32 のように並べると隠れ層を重ねる（最初の層の後ろは全結合。docs/ai-notes.md「大きなネットワークで一から学び直す」）
//   npm run td -- extend --model data/value-net.json --out m0.json
//     モデルの入力を今の並び（VALUE_ZONES・VALUE_SCALARS）に広げる。足した入力の重みは 0 なので、補正は元のモデルと同じ
//   npm run td -- widen --model m.json --hidden 256,32 --out w0.json [--seed 1]
//     隠れ層 1 つのモデルを、補正を変えずに大きい形に移す。最初の層の先頭に元の層を写し、足した部分は乱数で始めて、
//     2 つ目の層は元の層の値をそのまま通す（足した部分からの重みは 0）。docs/ai-notes.md「今のモデルを広げて学習を続ける」
//   rust/target/release/svwb td selfplay --model m0.json --games 2000 [--start 0] [--eps 0.1] --out d0.jsonl
//     自己対戦は Rust 版で行う（rust/engine/src/runner/td.rs。cd rust && cargo build --release で作る）。
//     両方の席がモデルの評価で打つ探索 AI の自己対戦（7 デッキの全 49 組を順に回す）。
//     各自分のターンの最初の局面（after）とターン末の局面（end）を、入力と S と一緒に JSON Lines で書き出す。
//     --eps の確率で、自分のターンの最初の手をランダムに打つ（探索。その局面は学習に使わず、1 つ前の局面の目標もそこで切る）
//     各局面には場のカードの属性 "b"（BoardCard）も書く（--board 0 なら書かない）。場のカードのネットワークを持つモデル（board）の学習が使う。
//     --check 1 なら補正の値 "z" も書く（下の check 用）
//   npm run td -- board --model m.json --out b0.json [--layers 32,16] [--seed 1]
//     場のカードのネットワークを足す（docs/ai-notes.md「場のフォロワーごとのネットワーク」）。場のカード 1 枚ずつ（カード・付与された能力・
//     攻撃力等の数値。valueNet.ts の boardCardInput）を同じ層（--layers。各層の後に ReLU）に通し、最後の層の値を自分の場・相手の場ごとに足して、
//     最初の隠れ層の入力の末尾に入れる。出力の意味は決めず、勝敗から一緒に学ぶ。足した入力の重みは 0 なので、補正は元のモデルと同じ。
//     このモデルの学習には "b" のある自己対戦（td selfplay の既定）が要る
//   npm run td -- check --model m.json --data d.jsonl
//     td selfplay --check 1 で書いた "z"（探索の補正）と、このファイルの計算で "x"・"b" から出した補正を比べる（"x" は 4 桁に丸めてあるので少しずれる）
//   npm run td -- train --model m0.json --data d0.jsonl[,d1.jsonl] --out m1.json [--lambda 0.7] [--epochs 2] [--lr 0.001] [--l2 0.0001] [--batch 128] [--holdout 0.1] [--fitA 1] [--seed 1] [--ivWeight 1] [--v1Only 0] [--best 0]  [--bestOn end,after]
//     --best 1 なら、確かめ用の局面の勝敗の交差エントロピーが一番小さかったエポック（学習前も含む）の重みを書き出す（途中で止めるのと同じ）。
//     --cmpWeight w（既定 0）なら、td selfplay --cmp の打ち比べ（同じ局面からの並びごとに最後まで打った勝率）も学ぶ:
//     同じ局面の並びどうしで、予測した勝つ確率の平均からのずれが、測った勝率の平均からのずれに合うように（二乗誤差 × w。--cmpBatch 局面ずつ）。
//     打ち比べの局面は TD の局面と同じ並びで学ぶ（ミニバッチを混ぜて並べ替える）。docs/ai-notes.md「同じ局面からの手の比べ合いを学ぶ」
//     λ 収益（G_t = (1-λ) V_{t+1} + λ G_{t+1}、最後は勝敗）を目標に、L と c（--fitA 1 なら a も）を交差エントロピーで学ぶ。
//     a を学ぶと、出発点の評価が勝敗をあまり当てないとき a が小さくなり、探索では補正 (c + L) / a の重みが増える。
//     V は今のモデルの予測で、エポックごとに計算し直す。試合の --holdout の割合は学習に使わず、予測の確かめに使う。
//     td selfplay --iv で書き出した介入の試合（手札から 1 枚抜いた局面か、--ivZone board で場のカードを 1 枚消した局面から打った試合）の局面は --ivWeight の重みで学ぶ（0 なら読まない）。
//     --ivRes 0 なら、資源を ±1 した介入の試合（td selfplay --ivRes）を読まない（既定 1 は読む）。
//     td selfplay --imagined で書き出した想像の局面（"ph": 2。探索が相手のターンを読んだ後の局面）は、目標を同じターンのターン末の局面と同じ
//     （本物の次の自分のターンの最初の局面からの λ 収益）にして、--imaginedWeight の重み（既定 1。0 なら読まない）で学ぶ。
//     確かめ用の交差エントロピーは今までどおり end・after の局面だけで測り、想像の局面は別に出す。
//     --bestOn end,imagined なら、--best の判定をターン末と想像の局面（探索が点数に使う局面）の交差エントロピーで行う（既定 end,after）。
//     想像の局面を学ぶと after の予測が少し悪くなり、既定の判定では学習前が選ばれた（docs/ai-notes.md の同じ節）。
//     docs/ai-notes.md「読みの中の相手のずれを学習で直す・資源の介入」
//   npm run td -- ivcheck --model m1.json --data d0.jsonl[,d1.jsonl] [--holdout 0] [--opp <デッキ名>] [--min 30]
//     介入の試合で、抜いたカードごとに「測った価値」（もとの試合の勝敗 − 抜いた試合の勝敗の平均）と、
//     モデルが見ている価値（その局面の勝つ確率の予測の差）を比べる（docs/ai-notes.md「介入データを TD 学習に混ぜる」）。
//     --opp なら、カードの持ち主の相手がそのデッキの試合だけで数える（そのデッキとの対戦でのカードの価値。
//     docs/ai-notes.md「ロイヤルに勝ち越せるデッキを探す」）。--min 未満の対しかないカードは表に出さない
//   npm run td -- prune --model m4.json --data d0.jsonl,d1.jsonl,... --out data/value-net.json
//     学習データに一度も現れなかった入力（デフォルトデッキに無いカードなど）の重みを 0 にする。学ばれずに初期値の乱数のまま残っているので、
//     そのカードを使う自作デッキで補正がでたらめに動かないようにする（ファイルも小さくなる）。
//     場のカードのネットワークを持つモデルなら、場に現れなかったカード・付与された能力の行も 0 にする（そのカードは数値の入力だけで見る）
//   npm run td -- probe --model m1.json --data d0.jsonl [--per 2000] [--ep 1 --min 30 --minMaxPp 0 --zone myHand]
//     学んだ補正が何を見ているか: デッキごとのターン末の局面で、入力を 1 つ増やしたときの補正 (c + L) / a の変化（評価の点数の単位）の平均。
//     PP 最大値・EP・SEP を 1 増やす、手札・場にカードを 1 枚足す（変化の大きい順）
//     --ep 1 なら、EP が残っているターン末の局面で、残りの EP 1 つの価値（EP を 1 減らしたときの点数の下がり）が、手札のカードでどれだけ変わるか
//     （そのカードを手札から 1 枚抜くと EP 1 つの価値がどれだけ下がるか）をカードごとに出す。--min 局面より少ないカードは出さない。
//     --minMaxPp k なら、PP 最大値が k 以上の局面だけ（重いカードを次のターンに出せる局面）。--zone myBoard なら手札でなく場のカード
//
// カードの重みを属性とカードごとの残りに分ける（docs/ai-notes.md の同じ名前の節。属性は scripts/cardAttrs.ts）:
//   最初の層のゾーン z・カード c の行を W1[z,c] = Σ_k 属性 k(c) · A[z,k] + R[z,c] と見る。属性はカードのデータと能力の定義から作る
//   （種類・クラス・コスト・攻撃力・体力・キーワード・タイプ・能力のきっかけ × 効果のプリミティブ等）。学習データに出なかったカードは
//   R = 0 で属性の分だけになるので、初見のカードもそれらしい行から始まる。書き出す w1 は足し込んだ行なので、推論（Rust）は今のまま。
//   npm run td -- attr --model m.json --out m2.json [--data d.jsonl,...] [--ridge 3] [--n0 0] [--keepA 1]
//     学び直さずに、学んだ行に A をリッジ回帰で当てはめ、学んでいない行を属性の分で埋める（関数の先頭の説明）
//   npm run td -- train ... --attr 1 [--ridge 3] [--l2Res <l2>] [--l2Attr <l2>] [--lrAttr 1]
//     A と R を一緒に学ぶ。A はモデルの attr か、無ければ今の行への当てはめから始める。R の減衰は --l2Res、A は --l2Attr。
//     A の学習率は lr × --lrAttr（0 なら A を当てはめたまま動かさない）。
//     書き出すモデルは A（attr）も持つ。td prune は、データに出なかったカードの行を 0 でなく属性の分にし、A を外す
//   npm run td -- train ... --exclude <カード名,...>（td prune にも同じものを渡す）
//     そのカードが入力にある試合を学ばない（知らないカードを作って、属性の分の効き目を確かめる用）
//   npm run td -- attrcheck --model m.json --data d.jsonl [--ridge 3] [--min 300]
//     学んだカードを 1 枚ずつ抜いて当てはめた属性の行と 0 の行とで、そのカードの局面の予測を比べる（関数の先頭の説明）
//   npm run td -- eval --model a.json,b.json --data d.jsonl [--cards <カード名,...>]
//     モデルどうしの予測（勝敗の交差エントロピー・AUC）を同じ局面で比べる。--cards ならそのカードが入力にある局面だけでも
//

import { readFileSync, writeFileSync } from "node:fs";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { attributeMatrix, attributeNames, attributeRow, choleskyFactor, choleskySolve, normalEquations, ridgePenalty, ridgeSolve, rowCanOccur, sparseRows } from "./cardAttrs";
import { nextRandom, type PlayerIndex } from "../src/engine";
import {
  baseInputSize,
  BOARD_FEATURES,
  boardCardForward,
  boardGrantKeys,
  boardCardInput,
  boardInputSize,
  boardOut,
  compileValueNet,
  defaultVocab,
  forwardRest,
  forwardValueNet,
  layerSizes,
  newActs,
  inputSize,
  loadValueNet,
  type BoardCard,
  type CompiledBoard,
  VALUE_SCALARS,
  VALUE_SCALARS_V1,
  VALUE_ZONES,
  VALUE_ZONES_V1,
  type CompiledValueNet,
  type SparseInput,
  type ValueNetModel,
} from "./valueNet";

/**
 * 評価関数から外す、人が見つけたデッキ専用の項（過去に勝率で確かめて足したもの。docs/ai-notes.md）。
 * maxPp: 疾走ドラゴン、hold・fusionSet: AFネメシス、boostCard・boost・kuonReserve: スペルウィッチ、
 * countdownDecay・sevoReserve: アミュレット疾走ビショップ、lastWordsSummon: ミッドレンジナイトメア
 */
const STRIPPED: Record<string, unknown> = { maxPp: 0, hold: {}, fusionSet: 0, boostCard: 0, boost: 0, kuonReserve: 0, countdownDecay: 0, sevoReserve: 0, lastWordsSummon: 0 };

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (cmd === "init") return init(args);
  if (cmd === "extend") return extend(args);
  if (cmd === "widen") return widen(args);
  if (cmd === "board") return board(args);
  if (cmd === "check") return check(args);
  if (cmd === "selfplay") throw new Error("自己対戦は Rust 版で行う: rust/target/release/svwb td selfplay ...（cd rust && cargo build --release で作る）");
  if (cmd === "train") return train(args);
  if (cmd === "probe") return probe(args);
  if (cmd === "prune") return prune(args);
  if (cmd === "ivcheck") return ivcheck(args);
  if (cmd === "attr") return attr(args);
  if (cmd === "attrcheck") return attrcheck(args);
  if (cmd === "eval") return evalModels(args);
  throw new Error("npm run td -- init|extend|widen|board|selfplay|train|check|probe|prune|ivcheck|attr|attrcheck|eval ...（scripts/td-main.ts の先頭の説明を参照）");
}

type Args = Map<string, string>;

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`引数の形が違います: ${k}`);
    m.set(k.slice(2), v);
  }
  return m;
}

const need = (args: Args, k: string): string => {
  const v = args.get(k);
  if (v === undefined) throw new Error(`--${k} がありません`);
  return v;
};
const numArg = (args: Args, k: string, def: number): number => {
  const v = args.get(k);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${k} は数: ${v}`);
  return n;
};

/** 0 以上 1 未満の乱数（holder の状態を進める） */
const nextFloat = (holder: { rng: number }): number => {
  const [v, next] = nextRandom(holder.rng);
  holder.rng = next;
  return v;
};

/** 標準正規分布（Box-Muller） */
const gaussian = (holder: { rng: number }): number => Math.sqrt(-2 * Math.log(1 - nextFloat(holder))) * Math.cos(2 * Math.PI * nextFloat(holder));

const round = (x: number, digits: number): number => Number(x.toPrecision(digits));

// ---- init ----

function init(args: Args): number {
  const out = need(args, "out");
  const sizes = (args.get("hidden") ?? "32").split(",").map(Number);
  if (!sizes.every((k) => Number.isInteger(k) && k > 0)) throw new Error(`--hidden は正の整数をコンマで並べる: ${args.get("hidden")}`);
  const hidden = sizes[0]!;
  const base = args.get("base") ?? "stripped";
  if (base !== "stripped" && base !== "current") throw new Error(`--base は stripped か current: ${base}`);
  const inputs = args.get("inputs") ?? "v2";
  if (inputs !== "v1" && inputs !== "v2") throw new Error(`--inputs は v2 か v1: ${inputs}`);
  const zones: string[] = inputs === "v1" ? [...VALUE_ZONES_V1] : [...VALUE_ZONES];
  const scalars: string[] = inputs === "v1" ? [...VALUE_SCALARS_V1] : [...VALUE_SCALARS];
  const holder = { rng: numArg(args, "seed", 1) >>> 0 };
  const vocab = defaultVocab();
  const n = inputSize({ vocab, zones, scalars });
  // 出力の重み w2 を 0 にするので、最初は L = 0（出発点の評価そのもの）
  const model: ValueNetModel = {
    kind: "td-value-net",
    version: 1,
    vocab,
    zones,
    scalars,
    hidden,
    w1: Array.from({ length: n * hidden }, () => round(gaussian(holder) * 0.1, 6)),
    b1: Array.from({ length: hidden }, () => 0.1),
    // 足す隠れ層は He の初期化（ReLU の前の値の分散を前の層と同じくらいに保つ）
    ...(sizes.length > 1
      ? {
          layers: sizes.slice(1).map((m, k) => ({
            w: Array.from({ length: sizes[k]! * m }, () => round(gaussian(holder) * Math.sqrt(2 / sizes[k]!), 6)),
            b: Array.from({ length: m }, () => 0.1),
          })),
        }
      : {}),
    w2: Array.from({ length: sizes[sizes.length - 1]! }, () => 0),
    b2: 0,
    a: numArg(args, "a", 0.08),
    c: 0,
    baseWeights: base === "stripped" ? STRIPPED : {},
  };
  writeFileSync(out, JSON.stringify(model));
  console.log(`${out}: 入力 ${n}（カード・クレスト ${vocab.length} × ${zones.length} ＋ 数値 ${scalars.length}）、隠れ層 ${sizes.join("・")}、出発点 ${base}`);
  return 0;
}

// ---- extend ----

function extend(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  compileValueNet(model);
  const out = need(args, "out");
  const H = model.hidden;
  const V = model.vocab.length;
  const zones: string[] = [...VALUE_ZONES];
  const scalars: string[] = [...VALUE_SCALARS];
  // 新しい入力の添字ごとに、元のモデルの入力の添字（無ければ -1）
  const from: number[] = [];
  for (const z of zones) {
    const k = model.zones.indexOf(z);
    for (let i = 0; i < V; i++) from.push(k < 0 ? -1 : k * V + i);
  }
  for (const sc of scalars) {
    const k = model.scalars.indexOf(sc);
    from.push(k < 0 ? -1 : model.zones.length * V + k);
  }
  const w1: number[] = [];
  for (const k of from) for (let j = 0; j < H; j++) w1.push(k < 0 ? 0 : model.w1[k * H + j]!);
  // 場のカードのネットワークの出力の重み（入力の末尾）はそのまま
  w1.push(...model.w1.slice(baseInputSize(model) * H));
  writeFileSync(out, JSON.stringify({ ...withoutAttr(model), zones, scalars, w1 }));
  console.log(`${out}: 入力 ${baseInputSize(model)} → ${from.length}（足した ${from.filter((k) => k < 0).length} 個の重みは 0）`);
  return 0;
}

// ---- widen ----

function widen(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  compileValueNet(model);
  if (model.layers?.length) throw new Error("widen は隠れ層 1 つのモデルだけ");
  const out = need(args, "out");
  const sizes = need(args, "hidden").split(",").map(Number);
  const H0 = model.hidden;
  if (sizes.length !== 2 || !sizes.every((k) => Number.isInteger(k) && k >= H0)) throw new Error(`--hidden は元の隠れ層（${H0}）以上の 2 つの数: ${args.get("hidden")}`);
  const [H1, H2] = sizes as [number, number];
  const holder = { rng: numArg(args, "seed", 1) >>> 0 };
  const nIn = inputSize(model);
  // 最初の層: 各入力の行の先頭 H0 個は元の重み、足した H1 - H0 個は init と同じ乱数
  const w1: number[] = [];
  for (let i = 0; i < nIn; i++) {
    for (let j = 0; j < H0; j++) w1.push(model.w1[i * H0 + j]!);
    for (let j = H0; j < H1; j++) w1.push(round(gaussian(holder) * 0.1, 6));
  }
  const b1 = [...model.b1, ...Array.from({ length: H1 - H0 }, () => 0.1)];
  // 2 つ目の層: 元の層の値 j は自分の j 番目にそのまま通す（ReLU を 2 回かけても同じ）。足した値からの重みは 0。
  // 足した H2 - H0 個は元の層の値から He の初期化で受け、出力への重みは 0
  const w: number[] = [];
  for (let i = 0; i < H1; i++) {
    for (let j = 0; j < H2; j++) {
      if (j < H0) w.push(i === j ? 1 : 0);
      else w.push(i < H0 ? round(gaussian(holder) * Math.sqrt(2 / H0), 6) : 0);
    }
  }
  const b = [...Array.from({ length: H0 }, () => 0), ...Array.from({ length: H2 - H0 }, () => 0.1)];
  const w2 = [...model.w2, ...Array.from({ length: H2 - H0 }, () => 0)];
  writeFileSync(out, JSON.stringify({ ...withoutAttr(model), hidden: H1, w1, b1, layers: [{ w, b }], w2 }));
  console.log(`${out}: 隠れ層 ${H0} → ${H1}・${H2}（補正は元のモデルと同じ）`);
  return 0;
}

// ---- board ----

/**
 * 場のカードのネットワークを足す（docs/ai-notes.md「場のフォロワーごとのネットワーク」）。層は乱数で始め、
 * 出力を受ける最初の層の重み（入力の末尾 2K 個）は 0 にするので、補正は元のモデルと同じ
 */
function board(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  compileValueNet(model);
  if (model.board) throw new Error("このモデルには場のカードのネットワークがもうあります");
  const out = need(args, "out");
  const sizes = (args.get("layers") ?? "32,16").split(",").map(Number);
  if (!sizes.every((k) => Number.isInteger(k) && k > 0)) throw new Error(`--layers は正の整数をコンマで並べる: ${args.get("layers")}`);
  const holder = { rng: numArg(args, "seed", 1) >>> 0 };
  const grants = boardGrantKeys();
  const features = [...BOARD_FEATURES];
  const nIn = model.vocab.length + grants.length + features.length;
  // 最初の層は 1 枚あたり 5 個ほどの入力（カード 1 つと数値）を受けるので、その数で He の初期化
  const layers = sizes.map((m, k) => {
    const prev = k === 0 ? nIn : sizes[k - 1]!;
    const sd = Math.sqrt(2 / (k === 0 ? 5 : prev));
    return { w: Array.from({ length: prev * m }, () => round(gaussian(holder) * sd, 6)), b: Array.from({ length: m }, () => 0.1) };
  });
  const K = sizes[sizes.length - 1]!;
  const w1 = [...model.w1, ...Array.from({ length: 2 * K * model.hidden }, () => 0)];
  writeFileSync(out, JSON.stringify({ ...model, w1, board: { features, grants, layers } }));
  console.log(`${out}: 場のカードのネットワーク（入力 ${nIn}: カード ${model.vocab.length}・付与された能力 ${grants.length}・数値 ${features.length}、層 ${sizes.join("・")}）を足しました（補正は元のモデルと同じ）`);
  return 0;
}

// ---- 自己対戦のデータ（svwb td selfplay が書き出す） ----

/** 自己対戦で記録する局面 1 つ */
interface Sample {
  /** 0: ターン末（end）、1: 自分のターンの最初（after）、2: 探索が相手のターンを読んだ後の想像の局面（td selfplay --imagined。直前のターン末の局面のもの） */
  ph: 0 | 1 | 2;
  /** 出発点の評価の点数 S */
  s: number;
  x: number[];
  v: number[];
  /** この局面からランダムに打った（学習に使わない） */
  ex?: 1;
  /**
   * 場のカードの属性（[自分の場, 相手の場]、場の並び順。形は scripts/valueNet.ts の BoardCard）。td selfplay --board 0 なら無い。
   * 場のカードのネットワーク（npm run td -- board）を持つモデルの学習で使う
   */
  b?: [BoardCard[], BoardCard[]];
  /** 自己対戦のモデルの補正（評価の点数の単位。td selfplay --check 1 のときだけ。npm run td -- check で使う） */
  z?: number;
}

interface GameRecord {
  g: number;
  decks: [string, string];
  winner: PlayerIndex;
  turns: number;
  /**
   * 介入の試合: もとの試合 g のプレイヤー p の k 番目の局面から、カード card を 1 枚消して打った。zone が無ければ p の手札、board は p の場、oppBoard は相手の場。
   * drawn は p の手札の、そのターンの始めに引いたカード（td selfplay --ivZone drawn。1 ターン目は手札のどれか）。
   * zone が res・oppRes なら、card の代わりに p・相手の資源 res（ep・sep・hp・maxPp）を d（±1）だけ変えて打った（td selfplay --ivRes）
   */
  iv?: { p: PlayerIndex; k: number; card?: string; zone?: IvZone; res?: string; d?: number };
  samples: [Sample[], Sample[]];
}

/** 打ち比べ（td selfplay --cmp）の行。試合の行の直後にある */
interface CmpRecord {
  g: number;
  decks: [string, string];
  cmp: {
    p: PlayerIndex;
    turn: number;
    /** 並びごとに最後まで打った回数 */
    n: number;
    /** 探索の点数の高い順。val は探索の点数、w は勝ち数、sample はターン末の局面 */
    cands: { val: number; w: number; sample: Sample }[];
  };
}

/** JSON Lines の 1 行（試合か打ち比べ） */
const parseLine = (line: string): GameRecord | CmpRecord => JSON.parse(line) as GameRecord | CmpRecord;
const isCmp = (r: GameRecord | CmpRecord): r is CmpRecord => "cmp" in r;

// ---- train ----

/** 学習用にまとめた局面 */
interface Dataset {
  /** 局面 i の入力は idx・val の off[i]〜off[i+1] */
  off: Int32Array;
  idx: Int32Array;
  val: Float32Array;
  s: Float64Array;
  /** 局面 i の次の局面（同じプレイヤーの。最後なら -1） */
  next: Int32Array;
  /** 局面 i を打ったプレイヤーの勝敗（1: 勝ち） */
  outcome: Float64Array;
  explored: Uint8Array;
  holdout: Uint8Array;
  phase: Uint8Array;
  /** 想像の局面（ph 2）なら、目標を同じにする局面（直前のターン末の局面）の添字。ほかは -1 */
  anchor: Int32Array;
  /** 局面の学習の重み（介入の試合の局面は --ivWeight、想像の局面は --imaginedWeight を掛ける） */
  weight: Float64Array;
  /** 介入の対（もとの局面と、カードを抜いた局面） */
  pairs: IvPair[];
  /** 場のカード（場のカードのネットワークを持つモデルのときだけ） */
  board?: BoardRows;
  /** 局面 i の試合（読んだ順の通し番号。介入の試合も 1 試合と数える） */
  game: Int32Array;
}

type IvZone = "hand" | "drawn" | "board" | "oppBoard" | "res" | "oppRes";

const isResZone = (z: IvZone): boolean => z === "res" || z === "oppRes";

/**
 * 介入の対。測った価値・予測の差は、消したカードの持ち主から見た値（相手の場のカードなら符号を逆にする）。
 * 資源の介入なら、資源の持ち主から見た 1 増やす価値（減らした介入は符号を逆にする）
 */
interface IvPair {
  base: number;
  variant: number;
  /** 消したカードの ID（資源の介入なら資源の名前） */
  card: string;
  /** カード・資源の持ち主のデッキ */
  deck: string;
  /** 持ち主の相手のデッキ */
  opp: string;
  zone: IvZone;
  /** 資源の増減（カードの介入は 0） */
  d: number;
}

/** 持ち主から見た向き（カードは「あった価値」、資源は「1 増やした価値」） */
const ivSign = (q: IvPair): number => (q.zone === "oppBoard" || q.zone === "oppRes" ? -1 : 1) * (isResZone(q.zone) ? -q.d : 1);

type Typed = Int32Array | Float32Array | Float64Array | Uint8Array | Uint16Array;

/**
 * 末尾に足していける型付き配列。学習データを JS の配列に積むと、3 万試合（局面 270 万・入力 9000 万）で
 * 7GB ほど使うので、はじめから型付き配列に積む（入る値は Int32Array.from 等で変換していたときと同じ）
 */
class Grow<T extends Typed> {
  buf: T;
  length = 0;
  constructor(private readonly make: (n: number) => T) {
    this.buf = make(1024);
  }
  push(x: number): void {
    if (this.length === this.buf.length) {
      const b = this.make(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.length++] = x;
  }
  /** ちょうどの長さに切り詰めた配列 */
  done(): T {
    const b = this.make(this.length);
    b.set(this.buf.subarray(0, this.length));
    return b;
  }
}

const i32 = (n: number): Int32Array => new Int32Array(n);
const f32 = (n: number): Float32Array => new Float32Array(n);
const f64 = (n: number): Float64Array => new Float64Array(n);
const u8 = (n: number): Uint8Array => new Uint8Array(n);
const u16 = (n: number): Uint16Array => new Uint16Array(n);

/**
 * 局面ごとの場のカードの入力（場のカードのネットワーク用）。局面 i のカードは cOff[i]〜cOff[i+1]、
 * カード k の側は cSide[k]（0: 自分、1: 相手）、入力（疎）は fIdx・fVal の fOff[k]〜fOff[k+1]
 */
interface BoardRows {
  cOff: Int32Array;
  cSide: Uint8Array;
  fOff: Int32Array;
  fIdx: Uint16Array;
  fVal: Float32Array;
}

/** 局面の場のカードを読んで BoardRows に積む */
class BoardGrow {
  private readonly cOff = new Grow(i32);
  private readonly cSide = new Grow(u8);
  private readonly fOff = new Grow(i32);
  private readonly fIdx = new Grow(u16);
  private readonly fVal = new Grow(f32);
  constructor(private readonly b: CompiledBoard) {
    if (b.nVocab + b.nGrants + BOARD_FEATURES.length > 65535) throw new Error("場のカードのネットワークの入力が多すぎます");
    this.cOff.push(0);
    this.fOff.push(0);
  }
  /** 局面 1 つの場のカード */
  add(board: [BoardCard[], BoardCard[]] | undefined): void {
    if (!board) throw new Error('場のカードのネットワークを学ぶには、局面の場のカード（"b"。svwb td selfplay の既定）が要ります');
    board.forEach((cards, side) => {
      for (const c of cards) {
        const x = boardCardInput(this.b, c);
        for (let j = 0; j < x.idx.length; j++) {
          this.fIdx.push(x.idx[j]!);
          this.fVal.push(x.val[j]!);
        }
        this.fOff.push(this.fIdx.length);
        this.cSide.push(side);
      }
    });
    this.cOff.push(this.cSide.length);
  }
  done(): BoardRows {
    return { cOff: this.cOff.done(), cSide: this.cSide.done(), fOff: this.fOff.done(), fIdx: this.fIdx.done(), fVal: this.fVal.done() };
  }
}

/** loadData の読み方（train の --imaginedWeight・--ivRes） */
interface LoadOptions {
  /** 想像の局面（ph 2）の重み（0 なら読まない。既定 1） */
  imaginedWeight?: number;
  /** 資源の介入の試合を読む（既定 true） */
  ivRes?: boolean;
  /** 真を返した試合は読まない（train の --exclude） */
  skipGame?: (r: GameRecord) => boolean;
}

function loadData(files: string[], holdout: number, ivWeight = 1, keep?: (i: number) => boolean, board?: CompiledBoard, opts: LoadOptions = {}): Dataset {
  const imaginedWeight = opts.imaginedWeight ?? 1;
  const off = new Grow(i32), idx = new Grow(i32), val = new Grow(f32), s = new Grow(f64), next = new Grow(i32), outcome = new Grow(f64);
  const cards = board ? new BoardGrow(board) : null;
  const explored = new Grow(u8), hold = new Grow(u8), phase = new Grow(u8), weight = new Grow(f64), anchor = new Grow(i32), game = new Grow(i32);
  off.push(0);
  const pairs: IvPair[] = [];
  let games = 0;
  for (const file of files) {
    // もとの試合の各プレイヤーの局面の、試合の中の位置 → 添字（介入の対を作る）。介入の試合はもとの試合のすぐ後の行にある
    const posOf = new Map<number, [number[], number[]]>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) continue;
      if (r.iv && ivWeight === 0) continue;
      if (r.iv && isResZone(r.iv.zone ?? "hand") && opts.ivRes === false) continue;
      if (opts.skipGame?.(r)) continue;
      games++;
      // 試合番号で決める（ファイルを足しても同じ試合は同じ側）
      const isHold = ((Math.imul(r.g, 2654435761) >>> 0) % 1000) / 1000 < holdout ? 1 : 0;
      const pos: [number[], number[]] = [[], []];
      r.samples.forEach((seq, p) => {
        // 同じプレイヤーの 1 つ前の（想像の局面でない）局面
        let prev = -1;
        for (const x of seq) {
          if (x.ph === 2 && (imaginedWeight === 0 || prev < 0)) {
            pos[p]!.push(-1);
            continue;
          }
          const i = s.length;
          pos[p]!.push(i);
          for (let j = 0; j < x.x.length; j++) {
            if (keep && !keep(x.x[j]!)) continue;
            idx.push(x.x[j]!);
            val.push(x.v[j]!);
          }
          off.push(idx.length);
          cards?.add(x.b);
          s.push(x.s);
          next.push(-1);
          game.push(games);
          outcome.push(r.winner === p ? 1 : 0);
          explored.push(x.ex ? 1 : 0);
          hold.push(isHold);
          phase.push(x.ph);
          const w = r.iv ? ivWeight : 1;
          if (x.ph === 2) {
            anchor.push(prev);
            weight.push(w * imaginedWeight);
          } else {
            anchor.push(-1);
            weight.push(w);
            if (prev >= 0) next.buf[prev] = i;
            prev = i;
          }
        }
      });
      if (r.iv) {
        const base = posOf.get(r.g)?.[r.iv.p][r.iv.k];
        const variant = pos[r.iv.p][0];
        const zone = r.iv.zone ?? "hand";
        const owner = zone === "oppBoard" || zone === "oppRes" ? 1 - r.iv.p : r.iv.p;
        if (base !== undefined && base >= 0 && variant !== undefined && variant >= 0) {
          pairs.push({ base, variant, card: r.iv.card ?? r.iv.res ?? "", deck: r.decks[owner]!, opp: r.decks[1 - owner]!, zone, d: r.iv.d ?? 0 });
        }
      } else {
        posOf.set(r.g, pos);
      }
    }
  }
  return {
    off: off.done(),
    idx: idx.done(),
    val: val.done(),
    s: s.done(),
    next: next.done(),
    outcome: outcome.done(),
    explored: explored.done(),
    holdout: hold.done(),
    phase: phase.done(),
    anchor: anchor.done(),
    weight: weight.done(),
    pairs,
    ...(cards ? { board: cards.done() } : {}),
    game: game.done(),
  };
}

/** 打ち比べの局面（td selfplay --cmp） */
interface CmpData {
  /** 並び i のターン末の局面の入力は idx・val の off[i]〜off[i+1] */
  off: Int32Array;
  idx: Int32Array;
  val: Float32Array;
  s: Float64Array;
  /** 並び i の測った勝率（勝ち数 / 打った回数） */
  win: Float64Array;
  /** 並び i の探索の点数 */
  search: Float64Array;
  /** 局面 g の並びは goff[g]〜goff[g+1] */
  goff: Int32Array;
  holdout: Uint8Array;
  board?: BoardRows;
}

function loadGroups(files: string[], holdout: number, board?: CompiledBoard): CmpData {
  const off: number[] = [0], idx: number[] = [], val: number[] = [], s: number[] = [], win: number[] = [], search: number[] = [], goff: number[] = [0], hold: number[] = [];
  const cards = board ? new BoardGrow(board) : null;
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (!isCmp(r)) continue;
      for (const c of r.cmp.cands) {
        for (let j = 0; j < c.sample.x.length; j++) {
          idx.push(c.sample.x[j]!);
          val.push(c.sample.v[j]!);
        }
        off.push(idx.length);
        cards?.add(c.sample.b);
        s.push(c.sample.s);
        win.push(c.w / r.cmp.n);
        search.push(c.val);
      }
      goff.push(s.length);
      // 試合の行と同じ決め方（同じ試合の打ち比べは同じ側）
      hold.push(((Math.imul(r.g, 2654435761) >>> 0) % 1000) / 1000 < holdout ? 1 : 0);
    }
  }
  return {
    off: Int32Array.from(off),
    idx: Int32Array.from(idx),
    val: Float32Array.from(val),
    s: Float64Array.from(s),
    win: Float64Array.from(win),
    search: Float64Array.from(search),
    goff: Int32Array.from(goff),
    holdout: Uint8Array.from(hold),
    ...(cards ? { board: cards.done() } : {}),
  };
}

/**
 * 打ち比べの確かめ用（holdout）の局面での、平均からのずれの二乗誤差（局面ごとの和の平均）と、
 * 測った勝率の差が 25% 以上ある並びの対で、予測（と探索の点数）の大小が測った勝率の大小と合う割合
 */
function cmpReport(c: CmpData, v: Float64Array): string {
  let groups = 0, sq = 0, pairs = 0, agree = 0, searchAgree = 0;
  for (let g = 0; g + 1 < c.goff.length; g++) {
    if (!c.holdout[g]) continue;
    const a = c.goff[g]!, b = c.goff[g + 1]!;
    let mp = 0, mw = 0;
    for (let i = a; i < b; i++) {
      mp += v[i]!;
      mw += c.win[i]!;
    }
    mp /= b - a;
    mw /= b - a;
    for (let i = a; i < b; i++) sq += (v[i]! - mp - (c.win[i]! - mw)) ** 2;
    groups++;
    for (let i = a; i < b; i++) {
      for (let j = i + 1; j < b; j++) {
        const dw = c.win[i]! - c.win[j]!;
        if (Math.abs(dw) < 0.25) continue;
        pairs++;
        if ((v[i]! - v[j]!) * dw > 0) agree++;
        if ((c.search[i]! - c.search[j]!) * dw > 0) searchAgree++;
      }
    }
  }
  const pct = (x: number) => `${((x / Math.max(1, pairs)) * 100).toFixed(1)}%`;
  return `打ち比べ(${groups}) ずれの二乗誤差 ${(sq / Math.max(1, groups)).toFixed(4)} 大小が合う ${pct(agree)}（探索の点数 ${pct(searchAgree)}、${pairs} 対）`;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** 局面ごとの疎な入力（場のカードのネットワークを持つモデルなら、場のカードも） */
interface SparseRows {
  off: Int32Array;
  idx: Int32Array;
  val: Float32Array;
  board?: BoardRows;
}

/** 場のカードのネットワークの計算の値（局面 1 つ分。cards[k] は局面の k 枚目のカードの各層の値（ReLU の後）、sums は側ごとに足した値） */
interface BoardActs {
  cards: Float64Array[][];
  sums: Float64Array;
}

const newBoardActs = (m: ValueNetModel): BoardActs => ({ cards: [], sums: new Float64Array(2 * boardOut(m)) });

/** 局面 i の NN の出力（acts に各隠れ層の値（ReLU の後）を、ba に場のカードのネットワークの値を書く。forwardValueNet と同じ計算） */
function forwardAt(net: CompiledValueNet, d: SparseRows, i: number, acts: Float64Array[], ba: BoardActs): number {
  preActAt(net, d, i, acts[0]!, ba);
  return forwardRest(net, net.model.b2, acts);
}

/** 局面 i の最初の隠れ層の ReLU の前の値を hidden に書く（ba に場のカードのネットワークの値を書く） */
function preActAt(net: CompiledValueNet, d: SparseRows, i: number, hidden: Float64Array, ba: BoardActs): void {
  const H = net.model.hidden;
  hidden.set(net.b1);
  for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
    const row = d.idx[q]! * H, x = d.val[q]!;
    for (let j = 0; j < H; j++) hidden[j]! += x * net.w1[row + j]!;
  }
  const b = net.board;
  if (b) {
    const rows = d.board;
    if (!rows) throw new Error("場のカードのネットワークを持つモデルですが、データに場のカードがありません");
    const sums = ba.sums, K = b.out;
    sums.fill(0);
    const c0 = rows.cOff[i]!, c1 = rows.cOff[i + 1]!;
    for (let k = c0; k < c1; k++) {
      while (ba.cards.length <= k - c0) ba.cards.push(b.layers.map((l) => new Float64Array(l.b.length)));
      const a = ba.cards[k - c0]!;
      boardCardForward(b, rows.fIdx, rows.fVal, rows.fOff[k]!, rows.fOff[k + 1]!, a);
      const out = a[a.length - 1]!, o = rows.cSide[k]! * K;
      for (let j = 0; j < K; j++) sums[o + j]! += out[j]!;
    }
    const base = baseInputSize(net.model);
    for (let t = 0; t < sums.length; t++) {
      const x = sums[t]!;
      if (x === 0) continue;
      const row = (base + t) * H;
      for (let j = 0; j < H; j++) hidden[j]! += x * net.w1[row + j]!;
    }
  }
}

/** 全局面の勝つ確率の予測 */
function predictAll(net: CompiledValueNet, d: SparseRows & { s: Float64Array }): Float64Array {
  const h = newActs(net.model), ba = newBoardActs(net.model);
  const v = new Float64Array(d.s.length);
  for (let i = 0; i < v.length; i++) v[i] = sigmoid(net.model.a * d.s[i]! + net.model.c + forwardAt(net, d, i, h, ba));
  return v;
}

/** λ 収益（局面 i の目標）。次の局面がランダムに打った局面なら、その局面の予測で切る。想像の局面は、直前のターン末の局面と同じ目標 */
function lambdaReturns(d: Dataset, v: Float64Array, lambda: number): Float64Array {
  const g = new Float64Array(v.length);
  // 各列の局面は添字の順に並んでいるので、後ろから計算すれば次の局面の目標は計算済み
  for (let i = v.length - 1; i >= 0; i--) {
    if (d.anchor[i]! >= 0) continue;
    const j = d.next[i]!;
    if (j < 0) g[i] = d.outcome[i]!;
    else if (d.explored[j]) g[i] = v[j]!;
    else g[i] = (1 - lambda) * v[j]! + lambda * g[j]!;
  }
  for (let i = 0; i < v.length; i++) {
    const a = d.anchor[i]!;
    if (a >= 0) g[i] = g[a]!;
  }
  return g;
}

const bce = (p: number, y: number): number => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};

/** 勝敗に対する AUC（予測が勝ちの局面で高いほど 1 に近い） */
function auc(pred: number[], y: number[]): number {
  const order = pred.map((_, i) => i).sort((a, b) => pred[a]! - pred[b]!);
  let pos = 0, rankSum = 0;
  order.forEach((i, r) => {
    if (y[i] === 1) {
      pos++;
      rankSum += r + 1;
    }
  });
  const neg = y.length - pos;
  return pos === 0 || neg === 0 ? 0.5 : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** --bestOn の局面の種類（end・after・imagined）→ ph */
const PHASE_OF: Record<string, 0 | 1 | 2> = { end: 0, after: 1, imagined: 2 };

/** 確かめ用の局面（holdout。ランダムに打った局面を除く）のうち、phases の種類（既定はターン末とターンの最初）の勝敗に対する交差エントロピー */
function holdoutLoss(d: Dataset, v: Float64Array, phases: ReadonlySet<number> = new Set([0, 1])): number {
  let sum = 0, n = 0;
  for (let i = 0; i < v.length; i++) {
    if (!d.holdout[i] || d.explored[i] || !phases.has(d.phase[i]!)) continue;
    sum += bce(v[i]!, d.outcome[i]!);
    n++;
  }
  return sum / Math.max(1, n);
}

/**
 * 確かめ用の局面（holdout）での、勝敗に対する交差エントロピーと AUC（全体・ターン末・ターンの最初。全体に想像の局面は入れない）。
 * 想像の局面があれば、それも別に出す（予測の平均 − 目標の平均は、読みの中の局面をどれだけ楽観しているか）
 */
function report(label: string, d: Dataset, v: Float64Array, targets: Float64Array): void {
  const parts: string[] = [];
  for (const [name, ph] of [["全体", -1], ["end", 0], ["after", 1], ["imagined", 2]] as const) {
    const pred: number[] = [], y: number[] = [];
    let td = 0, bias = 0;
    for (let i = 0; i < v.length; i++) {
      if (!d.holdout[i] || d.explored[i] || (ph >= 0 ? d.phase[i] !== ph : d.phase[i] === 2)) continue;
      pred.push(v[i]!);
      y.push(d.outcome[i]!);
      td += bce(v[i]!, targets[i]!);
      bias += v[i]! - targets[i]!;
    }
    const n = pred.length;
    if (ph === 2 && n === 0) continue;
    const ll = pred.reduce((x, p, k) => x + bce(p, y[k]!), 0) / Math.max(1, n);
    const extra = ph === 2 ? ` 予測の平均 − 目標の平均 ${(bias / Math.max(1, n) >= 0 ? "+" : "") + ((bias / Math.max(1, n)) * 100).toFixed(1)}%` : "";
    parts.push(`${name}(${n}) 勝敗の交差エントロピー ${ll.toFixed(4)} AUC ${auc(pred, y).toFixed(3)} TD ${(td / Math.max(1, n)).toFixed(4)}${extra}`);
  }
  const iv = ivSummary(d, v, true);
  if (iv) parts.push(iv);
  console.log(`${label}: ${parts.join(" / ")}`);
}

/** 介入の対の、測った価値（勝敗の差の平均）とモデルが見ている価値（予測の差の平均） */
const IV_ZONE_NAME: Record<IvZone, string> = { hand: "", drawn: "引いたとき", board: "自分の場", oppBoard: "相手の場", res: "自分の", oppRes: "相手の" };
/** 資源の介入の資源の名前（td selfplay --ivRes の res） */
const RES_NAME: Record<string, string> = { ep: "EP", sep: "SEP", hp: "体力", maxPp: "PP 最大値" };

/** 介入の対をまとめる名前（カードは場所ごと、資源は持ち主と資源ごと） */
const ivGroup = (q: IvPair): string => (isResZone(q.zone) ? `${IV_ZONE_NAME[q.zone]}${RES_NAME[q.card] ?? q.card}（1 あたり）` : IV_ZONE_NAME[q.zone]);

function ivSummary(d: Dataset, v: Float64Array, holdoutOnly: boolean): string | null {
  // 手札・自分の場・相手の場・資源（自分・相手、EP・SEP・体力・PP 最大値）の順
  const order = (q: IvPair): number => ["hand", "drawn", "board", "oppBoard", "res", "oppRes"].indexOf(q.zone) * 10 + (isResZone(q.zone) ? Object.keys(RES_NAME).indexOf(q.card) + 1 : 0);
  const groups = new Map<string, { o: number; n: number; measured: number; predicted: number }>();
  for (const q of d.pairs) {
    if (holdoutOnly && !d.holdout[q.base]) continue;
    const key = ivGroup(q);
    const c = groups.get(key) ?? { o: order(q), n: 0, measured: 0, predicted: 0 };
    c.n++;
    c.measured += ivSign(q) * (d.outcome[q.base]! - d.outcome[q.variant]!);
    c.predicted += ivSign(q) * (v[q.base]! - v[q.variant]!);
    groups.set(key, c);
  }
  const parts = [...groups]
    .sort((x, y) => x[1].o - y[1].o)
    .map(([key, c]) => {
      const pct = (x: number) => `${x >= 0 ? "+" : ""}${((x / c.n) * 100).toFixed(1)}%`;
      return `介入${key}(${c.n}) 測った価値 ${pct(c.measured)} 予測の差 ${pct(c.predicted)}`;
    });
  return parts.length > 0 ? parts.join(" / ") : null;
}

function train(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const files = need(args, "data").split(",");
  const out = need(args, "out");
  const lambda = numArg(args, "lambda", 0.7);
  const epochs = numArg(args, "epochs", 2);
  const lr = numArg(args, "lr", 0.001);
  const l2 = numArg(args, "l2", 0.0001);
  const batch = numArg(args, "batch", 128);
  const holdout = numArg(args, "holdout", 0.1);
  const fitA = numArg(args, "fitA", 1) !== 0;
  const holder = { rng: numArg(args, "seed", 1) >>> 0 };
  const ivWeight = numArg(args, "ivWeight", 1);
  const imaginedWeight = numArg(args, "imaginedWeight", 1);
  const ivRes = numArg(args, "ivRes", 1) !== 0;
  const keepBest = numArg(args, "best", 0) !== 0;
  // --bestOn end,imagined: --best の判定に使う局面の種類（既定 end,after）。探索が点数に使うのはターン末と想像の局面
  const bestOn = new Set(
    (args.get("bestOn") ?? "end,after").split(",").map((x) => {
      const ph = PHASE_OF[x.trim()];
      if (ph === undefined) throw new Error(`--bestOn は end・after・imagined をカンマで並べます: ${x}`);
      return ph;
    }),
  );
  const cmpWeight = numArg(args, "cmpWeight", 0);
  const cmpBatch = numArg(args, "cmpBatch", 16);

  const t0 = Date.now();
  // --v1Only 1: 場の攻撃力・体力等を足す前の入力（VALUE_ZONES_V1・VALUE_SCALARS_V1）だけで学ぶ（足した入力の効き目を分ける対照）
  const v1Only = numArg(args, "v1Only", 0) !== 0;
  const V = model.vocab.length;
  const keep = v1Only
    ? (i: number): boolean => {
        const z = Math.floor(i / V);
        if (z < model.zones.length) return (VALUE_ZONES_V1 as readonly string[]).includes(model.zones[z]!);
        return (VALUE_SCALARS_V1 as readonly string[]).includes(model.scalars[i - model.zones.length * V]!);
      }
    : undefined;
  const compiled0 = compileValueNet(model);
  // --exclude: そのカードが入力にある試合を学ばない（知らないカードを作る確かめ用。docs/ai-notes.md「カードの重みを属性とカードごとの残りに分ける」）
  const skipGame = excludeGames(model, args.get("exclude"));
  const d = loadData(files, holdout, ivWeight, keep, compiled0.board, { imaginedWeight, ivRes, ...(skipGame ? { skipGame } : {}) });
  const n = d.s.length;
  const nImagined = d.anchor.reduce((x, a) => x + (a >= 0 ? 1 : 0), 0);
  console.log(
    `${files.join(", ")}: 局面 ${n}（確かめ用 ${d.holdout.reduce((x, y) => x + y, 0)}、ランダムに打った ${d.explored.reduce((x, y) => x + y, 0)}、想像の局面 ${nImagined}、介入の対 ${d.pairs.length}（うち資源 ${d.pairs.filter((q) => isResZone(q.zone)).length}））、読み込み ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  const cmp = cmpWeight > 0 ? loadGroups(files, holdout, compiled0.board) : null;
  if (cmp) console.log(`打ち比べ ${cmp.goff.length - 1} 局面・${cmp.s.length} 並び（確かめ用 ${cmp.holdout.reduce((x, y) => x + y, 0)} 局面）`);
  const H = model.hidden;
  const sizes = layerSizes(model);
  const L = sizes.length;
  const nIn = inputSize(model);
  // 学ぶ値を 1 つの配列に並べる: [w1 | b1 | (足した層の w | b)… | w2 | b2 | c | a]
  const oB1 = nIn * H;
  const layerOff: { w: number; b: number }[] = [];
  let o = oB1 + H;
  for (let k = 1; k < L; k++) {
    layerOff.push({ w: o, b: o + sizes[k - 1]! * sizes[k]! });
    o += (sizes[k - 1]! + 1) * sizes[k]!;
  }
  const oW2 = o, oB2 = oW2 + sizes[L - 1]!, oC = oB2 + 1, oA = oC + 1;
  // 場のカードのネットワークの層（[w | b]…）は a の後ろ
  const bSizes = (model.board?.layers ?? []).map((l) => l.b.length);
  const bIn = boardInputSize(model);
  const boardOff: { w: number; b: number }[] = [];
  o = oA + 1;
  bSizes.forEach((m, k) => {
    const prev = k === 0 ? bIn : bSizes[k - 1]!;
    boardOff.push({ w: o, b: o + prev * m });
    o += (prev + 1) * m;
  });
  // --attr 1: 最初の層のカードの行を「属性 × A ＋ カードごとの残り R」に分けて学ぶ（A は場のカードのネットワークの後ろ。docs/ai-notes.md「カードの重みを属性とカードごとの残りに分ける」）
  const attrOn = numArg(args, "attr", 0) !== 0;
  if (attrOn && cmp) throw new Error("--attr と --cmpWeight は一緒に使えません");
  const Z = model.zones.length, ZV = Z * V;
  const basis = attrOn ? attrBasis(model, numArg(args, "minSupport", 3)) : null;
  const KA = basis?.K ?? 0;
  const oAttr = o;
  o += Z * KA * H;
  const size = o;
  const params = new Float64Array(size);
  params.set(model.w1, 0);
  params.set(model.b1, oB1);
  (model.layers ?? []).forEach((l, k) => {
    params.set(l.w, layerOff[k]!.w);
    params.set(l.b, layerOff[k]!.b);
  });
  params.set(model.w2, oW2);
  params[oB2] = model.b2;
  params[oC] = model.c;
  params[oA] = model.a;
  (model.board?.layers ?? []).forEach((l, k) => {
    params.set(l.w, boardOff[k]!.w);
    params.set(l.b, boardOff[k]!.b);
  });
  // 重みの減衰の係数（w1・足した層の w・w2 は l2。バイアスと c・a は減衰させない）。
  // --attr 1 なら、カードの行の残り R は --l2Res（既定 l2）、属性の分 A は --l2Attr（既定 l2）
  const l2Res = numArg(args, "l2Res", l2), l2Attr = numArg(args, "l2Attr", l2);
  const decayCoef = new Float64Array(size);
  decayCoef.fill(l2, 0, oB1);
  if (attrOn) decayCoef.fill(l2Res, 0, ZV * H);
  for (let k = 1; k < L; k++) decayCoef.fill(l2, layerOff[k - 1]!.w, layerOff[k - 1]!.b);
  decayCoef.fill(l2, oW2, oB2);
  for (const lo of boardOff) decayCoef.fill(l2, lo.w, lo.b);
  decayCoef.fill(l2Attr, oAttr, size);

  // 属性の分: params の w1 のカードの行は残り R を持ち、予測と逆伝播は足し込んだ行 effW1（R + 属性 × A）を使う
  const effW1 = attrOn ? new Float64Array(oB1) : null;
  /** 学習データに出たカードの行（予測に使う行）と、全部のカードの行 */
  const dataRows: number[] = [];
  const allCardRows = Array.from({ length: attrOn ? ZV : 0 }, (_, r) => r);
  /** effW1 を params から作り直す（all なら全部のカードの行、でなければ学習データに出た行だけ。カードでない行は写す） */
  const materialize = (all: boolean): void => materializeRows(all ? allCardRows : dataRows);
  /** effW1 のカードの行 rows とカードでない行を params から作り直す */
  const materializeRows = (rows: readonly number[]): void => {
    if (!effW1 || !basis) return;
    effW1.set(params.subarray(ZV * H, oB1), ZV * H);
    for (const r of rows) {
      const sp = basis.sparse[r % V]!, base = oAttr + Math.floor(r / V) * KA * H, e = r * H;
      for (let j = 0; j < H; j++) effW1[e + j] = params[e + j]!;
      for (let t = 0; t < sp.idx.length; t++) {
        const ak = base + sp.idx[t]! * H, x = sp.val[t]!;
        for (let j = 0; j < H; j++) effW1[e + j]! += x * params[ak + j]!;
      }
    }
  };
  /** Adam で更新する範囲と学習率の倍率（--attr 1 なら、学習データに出なかったカードの行の R は 0 のまま動かないので飛ばす。A は --lrAttr 倍） */
  const active: [number, number, number][] = [[0, size, 1]];
  const lrAttr = numArg(args, "lrAttr", 1);
  if (attrOn && basis) {
    const seen = new Uint8Array(ZV);
    for (const r of d.idx) if (r < ZV) seen[r] = 1;
    for (let r = 0; r < ZV; r++) if (seen[r]) dataRows.push(r);
    const fromModel = model.attr && model.attr.names.join("\n") === basis.names.join("\n") && model.attr.a.length === Z * KA * H;
    const a0 = fromModel ? Float64Array.from(model.attr!.a) : fitAttr(model, basis, numArg(args, "ridge", 3));
    params.set(a0, oAttr);
    // R: 0 でない行（学んだ行）は今の行から属性の分を引いたもの、0 の行（学んでいない・td prune で 0 にした行）は 0（属性の分から始める）
    const tmp = new Float64Array(H);
    let learned = 0;
    for (let r = 0; r < ZV; r++) {
      if (rowIsZero(model.w1, r, H)) {
        params.fill(0, r * H, r * H + H);
        continue;
      }
      learned++;
      const z = Math.floor(r / V);
      attributeRow(basis.x, KA, H, r % V, a0.subarray(z * KA * H, (z + 1) * KA * H), tmp);
      for (let j = 0; j < H; j++) params[r * H + j] = model.w1[r * H + j]! - tmp[j]!;
    }
    materialize(true);
    active.length = 0;
    for (const r of dataRows) {
      const last = active[active.length - 1];
      if (last && last[1] === r * H) last[1] += H;
      else active.push([r * H, r * H + H, 1]);
    }
    active.push([ZV * H, oAttr, 1]);
    if (lrAttr !== 0) active.push([oAttr, size, lrAttr]);
    console.log(
      `属性 ${KA} 個（${fromModel ? "モデルの A から" : `今の行にリッジ回帰（λ ${numArg(args, "ridge", 3)}）で当てはめて`}始める）、カードの行 ${ZV} のうち学んだ行 ${learned}・学習データに出た行 ${dataRows.length}、` +
        `減衰 R ${l2Res}・A ${l2Attr}、A の学習率 ×${lrAttr}`,
    );
  }
  const touched: number[] = [], touchedMark = new Uint8Array(attrOn ? ZV : 0);
  const grad = new Float64Array(size), m1 = new Float64Array(size), m2 = new Float64Array(size);
  const beta1 = 0.9, beta2 = 0.999;
  let step = 0;

  // 推論用の CompiledValueNet は params と配列を共有する（学習中の値で予測する）
  const boardLayers = boardOff.map((lo, k) => ({ w: params.subarray(lo.w, lo.b), b: params.subarray(lo.b, lo.b + bSizes[k]!) }));
  const current = (): CompiledValueNet => {
    const mdl: ValueNetModel = { ...model, b2: params[oB2]!, c: params[oC]!, a: params[oA]! };
    const layers = layerOff.map((lo, k) => ({ w: params.subarray(lo.w, lo.b), b: params.subarray(lo.b, lo.b + sizes[k + 1]!) }));
    return {
      model: mdl,
      index: new Map(),
      w1: effW1 ?? params.subarray(0, oB1),
      b1: params.subarray(oB1, oB1 + H),
      layers,
      w2: params.subarray(oW2, oB2),
      ...(compiled0.board ? { board: { ...compiled0.board, layers: boardLayers } } : {}),
    };
  };

  const trainIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !d.holdout[i] && !d.explored[i]);
  const trainGroups = cmp ? Array.from({ length: cmp.goff.length - 1 }, (_, g) => g).filter((g) => !cmp.holdout[g]) : [];
  const acts = newActs(model), dacts = newActs(model), bacts = newBoardActs(model);
  const nBase = baseInputSize(model), K = boardOut(model);
  const dSums = new Float64Array(2 * K), dBoard = bSizes.map((m) => new Float64Array(m));

  /** 場のカードのネットワークの勾配を grad に足す（dh は最初の隠れ層の ReLU の前の値の勾配、ba は forwardAt が書いた値） */
  const backwardBoard = (dh: Float64Array, rows: SparseRows, i: number, ba: BoardActs): void => {
    const br = rows.board!;
    // 補正の最初の層の入力の末尾（2K 個）
    for (let t = 0; t < 2 * K; t++) {
      const x = ba.sums[t]!, row = (nBase + t) * H;
      let back = 0;
      for (let j = 0; j < H; j++) {
        if (x !== 0) grad[row + j]! += dh[j]! * x;
        back += params[row + j]! * dh[j]!;
      }
      dSums[t] = back;
    }
    const LB = bSizes.length, c0 = br.cOff[i]!;
    for (let k = c0; k < br.cOff[i + 1]!; k++) {
      const a = ba.cards[k - c0]!, o = br.cSide[k]! * K;
      const last = a[LB - 1]!, dLast = dBoard[LB - 1]!;
      for (let j = 0; j < K; j++) dLast[j] = last[j]! > 0 ? dSums[o + j]! : 0;
      for (let l = LB - 1; l >= 1; l--) {
        const lo = boardOff[l]!, m = bSizes[l]!;
        const hin = a[l - 1]!, dout = dBoard[l]!, din = dBoard[l - 1]!;
        for (let j = 0; j < m; j++) grad[lo.b + j]! += dout[j]!;
        for (let r = 0; r < hin.length; r++) {
          const x = hin[r]!;
          if (x <= 0) {
            din[r] = 0;
            continue;
          }
          const row = lo.w + r * m;
          let back = 0;
          for (let j = 0; j < m; j++) {
            grad[row + j]! += x * dout[j]!;
            back += params[row + j]! * dout[j]!;
          }
          din[r] = back;
        }
      }
      const lo = boardOff[0]!, m0 = bSizes[0]!, d0 = dBoard[0]!;
      for (let j = 0; j < m0; j++) grad[lo.b + j]! += d0[j]!;
      for (let q = br.fOff[k]!; q < br.fOff[k + 1]!; q++) {
        const row = lo.w + br.fIdx[q]! * m0, x = br.fVal[q]!;
        for (let j = 0; j < m0; j++) grad[row + j]! += d0[j]! * x;
      }
    }
  };

  /** 出力 z の勾配 dz の局面（入力は rows の i 番目、各隠れ層の値は a、場のカードのネットワークの値は ba）の勾配を grad に足す */
  const backward = (dz: number, s: number, a: Float64Array[], rows: SparseRows, i: number, ba: BoardActs): void => {
    grad[oC]! += dz;
    if (fitA) grad[oA]! += dz * s;
    grad[oB2]! += dz;
    const last = a[L - 1]!, dLast = dacts[L - 1]!;
    for (let j = 0; j < last.length; j++) {
      grad[oW2 + j]! += dz * last[j]!;
      dLast[j] = last[j]! > 0 ? dz * params[oW2 + j]! : 0;
    }
    // 足した層を後ろから（ReLU の後の値が 0 の所は、その前の値が負なので勾配も 0）
    for (let k = L - 1; k >= 1; k--) {
      const lo = layerOff[k - 1]!, m = sizes[k]!;
      const hin = a[k - 1]!, dout = dacts[k]!, din = dacts[k - 1]!;
      for (let j = 0; j < m; j++) grad[lo.b + j]! += dout[j]!;
      for (let r = 0; r < hin.length; r++) {
        const x = hin[r]!;
        if (x <= 0) {
          din[r] = 0;
          continue;
        }
        const row = lo.w + r * m;
        let back = 0;
        for (let j = 0; j < m; j++) {
          grad[row + j]! += x * dout[j]!;
          back += params[row + j]! * dout[j]!;
        }
        din[r] = back;
      }
    }
    const dh = dacts[0]!;
    for (let j = 0; j < H; j++) grad[oB1 + j]! += dh[j]!;
    for (let q = rows.off[i]!; q < rows.off[i + 1]!; q++) {
      const row = rows.idx[q]! * H, x = rows.val[q]!;
      for (let j = 0; j < H; j++) grad[row + j]! += dh[j]! * x;
    }
    if (K > 0) backwardBoard(dh, rows, i, ba);
  };

  /** 打ち比べの局面 groups の勾配を grad に足し、損失（二乗誤差 × cmpWeight の和）を返す */
  const candActs: Float64Array[][] = [], candBoard: BoardActs[] = [];
  const cmpStep = (net: CompiledValueNet, c: CmpData, groups: number[]): number => {
    let loss = 0;
    for (const g of groups) {
      const a = c.goff[g]!, b = c.goff[g + 1]!, k = b - a;
      while (candActs.length < k) {
        candActs.push(newActs(model));
        candBoard.push(newBoardActs(model));
      }
      const p: number[] = [];
      let mp = 0, mw = 0;
      for (let t = 0; t < k; t++) {
        const pr = sigmoid(net.model.a * c.s[a + t]! + net.model.c + forwardAt(net, c, a + t, candActs[t]!, candBoard[t]!));
        p.push(pr);
        mp += pr;
        mw += c.win[a + t]!;
      }
      mp /= k;
      mw /= k;
      for (let t = 0; t < k; t++) {
        const e = p[t]! - mp - (c.win[a + t]! - mw);
        loss += cmpWeight * e * e;
        // ずれの和は 0 なので、平均を引く分の勾配は消える
        const dz = (cmpWeight * 2 * e * p[t]! * (1 - p[t]!)) / groups.length;
        backward(dz, c.s[a + t]!, candActs[t]!, c, a + t, candBoard[t]!);
      }
    }
    return loss;
  };

  const v0 = predictAll(current(), d);
  report("学習前", d, v0, lambdaReturns(d, v0, lambda));
  if (cmp) console.log(`学習前: ${cmpReport(cmp, predictAll(current(), cmp))}`);
  // --best 1: 確かめ用の局面の勝敗の交差エントロピーが一番小さかったエポックの重み
  let best = { loss: holdoutLoss(d, v0, bestOn), epoch: 0, params: keepBest ? params.slice() : params };
  for (let epoch = 0; epoch < epochs; epoch++) {
    const targets = lambdaReturns(d, predictAll(current(), d), lambda);
    // 並べ替え（Fisher-Yates）
    for (let i = trainIdx.length - 1; i > 0; i--) {
      const j = Math.floor(nextFloat(holder) * (i + 1));
      [trainIdx[i], trainIdx[j]] = [trainIdx[j]!, trainIdx[i]!];
    }
    let lossSum = 0, cmpLoss = 0;
    // ミニバッチの並び（TD の局面の b0 は 0 以上、打ち比べの局面の g0 は -1 - g0。打ち比べが無ければ今までどおり TD の順）
    const jobs: number[] = [];
    for (let b0 = 0; b0 < trainIdx.length; b0 += batch) jobs.push(b0);
    if (cmp) {
      for (let i = trainGroups.length - 1; i > 0; i--) {
        const j = Math.floor(nextFloat(holder) * (i + 1));
        [trainGroups[i], trainGroups[j]] = [trainGroups[j]!, trainGroups[i]!];
      }
      for (let g0 = 0; g0 < trainGroups.length; g0 += cmpBatch) jobs.push(-1 - g0);
      for (let i = jobs.length - 1; i > 0; i--) {
        const j = Math.floor(nextFloat(holder) * (i + 1));
        [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!];
      }
    }
    for (const job of jobs) {
      const net = current();
      grad.fill(0);
      // 属性の分: このミニバッチの局面に出るカードの行だけ作り直す（A が変わると全部の行が変わるが、使う行だけで足りる）
      if (basis && job >= 0) {
        const end = Math.min(trainIdx.length, job + batch);
        for (let k = job; k < end; k++) {
          const i = trainIdx[k]!;
          for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
            const r = d.idx[q]!;
            if (r < ZV && !touchedMark[r]) {
              touchedMark[r] = 1;
              touched.push(r);
            }
          }
        }
        materializeRows(touched);
      }
      if (job < 0) {
        const g0 = -1 - job;
        cmpLoss += cmpStep(net, cmp!, trainGroups.slice(g0, g0 + cmpBatch));
      } else {
        const b0 = job;
        const end = Math.min(trainIdx.length, b0 + batch);
        for (let k = b0; k < end; k++) {
          const i = trainIdx[k]!;
          const z = forwardAt(net, d, i, acts, bacts);
          const p = sigmoid(net.model.a * d.s[i]! + net.model.c + z);
          lossSum += bce(p, targets[i]!);
          const dz = (d.weight[i]! * (p - targets[i]!)) / (end - b0);
          backward(dz, d.s[i]!, acts, d, i, bacts);
        }
      }
      // 属性の分: 足し込んだ行の勾配（grad の w1 のカードの行。そのまま R の勾配）を A にも足す（A[z,k] の勾配 = Σ_c 属性 k(c) × 行 (z,c) の勾配）
      if (basis && job >= 0) {
        for (const r of touched) {
          touchedMark[r] = 0;
          const sp = basis.sparse[r % V]!, base = oAttr + Math.floor(r / V) * KA * H, g = r * H;
          for (let t = 0; t < sp.idx.length; t++) {
            const ak = base + sp.idx[t]! * H, x = sp.val[t]!;
            for (let j = 0; j < H; j++) grad[ak + j]! += x * grad[g + j]!;
          }
        }
        touched.length = 0;
      }
      // Adam（重みは減衰させる）
      step++;
      const c1 = 1 - beta1 ** step, c2 = 1 - beta2 ** step;
      for (const [q0, q1, scale] of active) {
        const lrq = lr * scale;
        for (let q = q0; q < q1; q++) {
          const gq = grad[q]!;
          m1[q] = beta1 * m1[q]! + (1 - beta1) * gq;
          m2[q] = beta2 * m2[q]! + (1 - beta2) * gq * gq;
          const decay = decayCoef[q]! * params[q]!;
          params[q]! -= lrq * ((m1[q]! / c1) / (Math.sqrt(m2[q]! / c2) + 1e-8) + decay);
        }
      }
      // a が 0 に近いと補正 (c + L) / a が発散するので下限を置く
      if (params[oA]! < 0.005) params[oA] = 0.005;
    }
    materialize(false);
    const v = predictAll(current(), d);
    report(`エポック ${epoch + 1}（学習の TD ${(lossSum / trainIdx.length).toFixed(4)}、a ${params[oA]!.toFixed(4)}、c ${params[oC]!.toFixed(3)}）`, d, v, lambdaReturns(d, v, lambda));
    if (cmp) console.log(`エポック ${epoch + 1}（学習の打ち比べ ${(cmpLoss / Math.max(1, trainGroups.length)).toFixed(4)}）: ${cmpReport(cmp, predictAll(current(), cmp))}`);
    const loss = holdoutLoss(d, v, bestOn);
    if (keepBest && loss < best.loss) best = { loss, epoch: epoch + 1, params: params.slice() };
  }
  if (keepBest) {
    params.set(best.params);
    materialize(false);
    const on = [...bestOn].map((ph) => Object.keys(PHASE_OF).find((k) => PHASE_OF[k] === ph)).join("・");
    console.log(`確かめ用の局面（${on}）の勝敗の交差エントロピーが一番小さい ${best.epoch === 0 ? "学習前" : `エポック ${best.epoch}`}（${best.loss.toFixed(4)}）の重みを書き出す`);
  }
  // 補正の大きさ（評価の点数の単位）
  const net = current();
  const hBuf = newActs(model), bBuf = newBoardActs(model);
  let absSum = 0;
  for (let i = 0; i < n; i++) absSum += Math.abs((net.model.c + forwardAt(net, d, i, hBuf, bBuf)) / net.model.a);
  console.log(`補正 (c + L) / a の絶対値の平均 ${(absSum / n).toFixed(2)} 点、${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 属性の分を足し込んで書き出す（学習データに出なかったカードの行は属性の分だけ）。A も残す（続きを学ぶ・td prune で埋める用）
  materialize(true);
  const outModel: ValueNetModel = {
    ...model,
    w1: Array.from(effW1 ?? params.subarray(0, oB1), (x) => round(x, 6)),
    b1: Array.from(params.subarray(oB1, oB1 + H), (x) => round(x, 6)),
    ...(L > 1 ? { layers: current().layers.map((l) => ({ w: Array.from(l.w, (x) => round(x, 6)), b: Array.from(l.b, (x) => round(x, 6)) })) } : {}),
    w2: Array.from(params.subarray(oW2, oB2), (x) => round(x, 6)),
    b2: round(params[oB2]!, 6),
    c: round(params[oC]!, 6),
    a: round(params[oA]!, 6),
    ...(model.board ? { board: { ...model.board, layers: boardLayers.map((l) => ({ w: Array.from(l.w, (x) => round(x, 6)), b: Array.from(l.b, (x) => round(x, 6)) })) } } : {}),
    ...(basis ? { attr: { names: basis.names, a: Array.from(params.subarray(oAttr, size), (x) => round(x, 6)) } } : {}),
  };
  writeFileSync(out, JSON.stringify(outModel));
  console.log(`${out} に書き出しました`);
  return 0;
}

// ---- check ----

/**
 * 学習側の補正の計算が探索（Rust）と同じかを確かめる: svwb td selfplay --check 1 で書き出した各局面の "z"（自己対戦のモデルの補正）と、
 * 同じモデルでこのファイルの計算（"x" と "b" から）で出した補正を比べる。"x" の値は 4 桁に丸めて書かれているので、少しはずれる
 */
function check(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const net = compileValueNet(model);
  let n = 0, maxDiff = 0, sumDiff = 0, sumBoard = 0, withCards = 0;
  const one = (x: Sample): void => {
    if (x.z === undefined) return;
    const z = (model.c + forwardValueNet(net, { idx: x.x, val: x.v }, undefined, x.b)) / model.a;
    const diff = Math.abs(z - x.z);
    n++;
    maxDiff = Math.max(maxDiff, diff);
    sumDiff += diff;
    if (net.board && x.b) {
      // 場のカードのネットワークの寄与（場のカードを空にしたときとの差）
      sumBoard += Math.abs(z - (model.c + forwardValueNet(net, { idx: x.x, val: x.v }, undefined, [[], []])) / model.a);
      if (x.b[0].length + x.b[1].length > 0) withCards++;
    }
  };
  for (const file of need(args, "data").split(",")) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) r.cmp.cands.forEach((c) => one(c.sample));
      else r.samples.forEach((seq) => seq.forEach(one));
    }
  }
  if (n === 0) throw new Error('"z" のある局面がありません（svwb td selfplay --check 1 で書き出す）');
  console.log(`局面 ${n}: 探索の補正とのずれ 最大 ${maxDiff.toExponential(2)} 点・平均 ${(sumDiff / n).toExponential(2)} 点`);
  if (net.board) console.log(`場のカードのネットワークの寄与の絶対値の平均 ${(sumBoard / n).toFixed(3)} 点（場にカードがある局面 ${withCards}）`);
  return 0;
}

// ---- probe ----

function probe(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const net = compileValueNet(model);
  const per = numArg(args, "per", 2000);
  const V = model.vocab.length;
  const base = model.zones.length * V;
  const zone = (name: (typeof VALUE_ZONES)[number]) => model.zones.indexOf(name) * V;
  const scalar = (name: (typeof VALUE_SCALARS)[number]) => base + model.scalars.indexOf(name);
  const nameOf = new Map([...ALL_CARDS.map((c): [string, string] => [c.id, c.name]), ...ALL_CRESTS.map((c): [string, string] => [`crest:${c.id}`, c.name])]);
  // デッキごとのターン末の局面
  // 局面の入力と、場のカード（場のカードのネットワークを持つモデル用。カードを足す・減らす入力の変化は場のカードのネットワークには入らない）
  type ProbeInput = SparseInput & { b?: [BoardCard[], BoardCard[]] };
  const byDeck = new Map<string, ProbeInput[]>();
  for (const file of need(args, "data").split(",")) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) continue;
      r.samples.forEach((seq, p) => {
        const list = byDeck.get(r.decks[p]!) ?? [];
        for (const x of seq) if (x.ph === 0 && list.length < per) list.push({ idx: x.x, val: x.v, ...(x.b ? { b: x.b } : {}) });
        byDeck.set(r.decks[p]!, list);
      });
    }
  }
  const points = (x: ProbeInput) => (model.c + forwardValueNet(net, x, undefined, x.b)) / model.a;
  const bump = (x: ProbeInput, i: number, d: number): ProbeInput => {
    const k = x.idx.indexOf(i);
    if (k < 0) return { ...x, idx: [...x.idx, i], val: [...x.val, d] };
    const val = [...x.val];
    val[k] = val[k]! + d;
    return { ...x, idx: x.idx, val };
  };
  /** 局面の一覧で、添字 i を d 増やしたときの点数の変化の平均（has を渡すと、その添字が既に正の局面だけ） */
  const effect = (list: ProbeInput[], i: number, d: number, has = false): [number, number] => {
    let sum = 0, n = 0;
    for (const x of list) {
      if (has && !(x.val[x.idx.indexOf(i)]! > 0)) continue;
      sum += points(bump(x, i, d)) - points(x);
      n++;
    }
    return [n === 0 ? 0 : sum / n, n];
  };
  if (numArg(args, "ep", 0) !== 0) {
    const zoneName = args.get("zone") ?? "myHand";
    if (!(VALUE_ZONES as readonly string[]).includes(zoneName) || !model.zones.includes(zoneName)) throw new Error(`--zone ${zoneName} はこのモデルの入力にありません`);
    const iEp = scalar("myEp"), hand0 = zone(zoneName as (typeof VALUE_ZONES)[number]), iMaxPp = scalar("myMaxPp");
    const minMaxPp = numArg(args, "minMaxPp", 0);
    const valOf = (x: ProbeInput, i: number) => {
      const k = x.idx.indexOf(i);
      return k < 0 ? 0 : x.val[k]!;
    };
    const per = new Map<number, { n: number; sum: number; sq: number; ep: number }>();
    let n = 0, epSum = 0;
    for (const x of [...byDeck.values()].flat()) {
      if (valOf(x, iEp) < 1e-9 || valOf(x, iMaxPp) * 10 < minMaxPp - 1e-6) continue;
      const lessEp = bump(x, iEp, -1 / 3);
      const epValue = points(x) - points(lessEp);
      n++;
      epSum += epValue;
      x.idx.forEach((i, k) => {
        if (i < hand0 || i >= hand0 + V || !(x.val[k]! > 0)) return;
        const d = epValue - (points(bump(x, i, -1)) - points(bump(lessEp, i, -1)));
        const a = per.get(i) ?? { n: 0, sum: 0, sq: 0, ep: 0 };
        a.n++;
        a.sum += d;
        a.sq += d * d;
        a.ep += epValue;
        per.set(i, a);
      });
    }
    console.log(`EP が残っているターン末の局面${minMaxPp > 0 ? `（PP 最大値 ${minMaxPp} 以上）` : ""} ${n}: 残りの EP 1 つの価値の平均 ${(epSum / Math.max(1, n)).toFixed(2)} 点`);
    const min = numArg(args, "min", 30);
    const rows = [...per]
      .filter(([, a]) => a.n >= min)
      .map(([i, a]) => {
        const mean = a.sum / a.n;
        return { name: nameOf.get(model.vocab[i - hand0]!) ?? model.vocab[i - hand0]!, n: a.n, mean, se: Math.sqrt(Math.max(0, a.sq / a.n - mean * mean) / a.n), ep: a.ep / a.n };
      })
      .sort((x, y) => y.mean - x.mean);
    console.log(`${zoneName} のカード（局面の数）: そのカードがあることで EP 1 つの価値が上がる分 ± 標準誤差（そのカードがあるときの EP 1 つの価値）`);
    for (const r of rows) console.log(`  ${r.name}（${r.n}）: ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(2)} ± ${r.se.toFixed(2)}（${r.ep.toFixed(2)}）`);
    return 0;
  }
  for (const [deck, list] of byDeck) {
    const mean = list.reduce((x, s) => x + points(s), 0) / Math.max(1, list.length);
    const sc = ([["myMaxPp", 0.1, "PP最大値+1"], ["myEp", 1 / 3, "EP+1"], ["mySep", 0.5, "SEP+1"], ["myHp", 0.05, "体力+1"], ["oppHp", 0.05, "相手の体力+1"]] as const)
      .map(([name, d, label]) => `${label} ${effect(list, scalar(name), d)[0].toFixed(2)}`)
      .join("、");
    console.log(`== ${deck}（${list.length} 局面、補正の平均 ${mean.toFixed(1)} 点）: ${sc}`);
    for (const z of ["myHand", "myBoard", "oppBoard"] as const) {
      // その局面で使われているカード（そのゾーンに 1 回でも現れたもの）
      const seen = new Set<number>();
      for (const x of list) for (const i of x.idx) if (i >= zone(z) && i < zone(z) + V) seen.add(i);
      const rows = [...seen]
        .map((i) => {
          const [d, n] = effect(list, i, 1);
          return { name: nameOf.get(model.vocab[i - zone(z)]!) ?? model.vocab[i - zone(z)]!, d, n };
        })
        .sort((x, y) => y.d - x.d);
      const fmt = (r: (typeof rows)[number]) => `${r.name} ${r.d >= 0 ? "+" : ""}${r.d.toFixed(2)}`;
      console.log(`  ${z} +1 枚: 高い ${rows.slice(0, 8).map(fmt).join("、")}`);
      console.log(`  ${z} +1 枚: 低い ${rows.slice(-5).map(fmt).join("、")}`);
    }
  }
  return 0;
}

// ---- prune ----

function prune(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const files = need(args, "data").split(",");
  const out = need(args, "out");
  const used = new Set<number>();
  // --exclude: train --exclude で学ばなかった試合は数えない
  const skipGame = excludeGames(model, args.get("exclude"));
  // 場のカードのネットワーク: 場に現れたカードと付与された能力
  const onBoard = new Set<string>(), grants = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r) || skipGame?.(r)) continue;
      for (const seq of r.samples) {
        for (const x of seq) {
          for (const i of x.x) used.add(i);
          if (!model.board) continue;
          if (!x.b) throw new Error("場のカードのネットワークを持つモデルですが、データに場のカード（\"b\"）がありません");
          for (const c of x.b.flat()) {
            onBoard.add(c.c);
            for (const g of c.g ?? []) grants.add(JSON.stringify(g));
          }
        }
      }
    }
  }
  const H = model.hidden;
  const n = baseInputSize(model);
  // 場のカードのネットワークの出力の重み（入力の末尾）は残す
  const w1 = model.w1.map((w, k) => (used.has(Math.floor(k / H)) || Math.floor(k / H) >= n ? w : 0));
  console.log(`${out}: 入力 ${n} のうち、データに現れた ${used.size} 個の重みを残し、${n - used.size} 個を 0 にしました`);
  // 属性の分を持つモデル（train --attr・td attr）: データに現れなかったカードの行は 0 でなく属性の分にする。書き出すモデルには A を残さない（推論は使わない）
  if (model.attr) {
    const filled = fillFromAttr(model, w1, (r) => !used.has(r));
    console.log(`属性の分を持つモデルなので、データに現れなかったカードの行のうち現れうる ${filled} 個を 0 でなく属性の分にしました`);
  }
  if (!model.board) {
    writeFileSync(out, JSON.stringify({ ...withoutAttr(model), w1 }));
    return 0;
  }
  // 場のカードのネットワークの最初の層: 場に現れなかったカード・付与された能力の行を 0 にする（数値の入力の行は残す）
  const b = model.board;
  const V = model.vocab.length;
  const keep = [...model.vocab.map((c) => onBoard.has(c)), ...b.grants.map((g) => grants.has(g))];
  const l0 = b.layers[0]!;
  const m0 = l0.b.length;
  const w0 = l0.w.map((w, k) => (Math.floor(k / m0) >= keep.length || keep[Math.floor(k / m0)] ? w : 0));
  const layers = [{ ...l0, w: w0 }, ...b.layers.slice(1)];
  writeFileSync(out, JSON.stringify({ ...withoutAttr(model), w1, board: { ...b, layers } }));
  const kept = (from: number, to: number) => keep.slice(from, to).filter((x) => x).length;
  console.log(`場のカードのネットワーク: 場に現れたカード ${kept(0, V)}/${V}・付与された能力 ${kept(V, keep.length)}/${b.grants.length} の重みを残しました`);
  return 0;
}

/** カード名か ID（"crest:" を付けたクレスト ID も）→ vocab の添字 */
function vocabIndexOf(model: ValueNetModel, nameOrId: string): number {
  const id = ALL_CARDS.find((c) => c.name === nameOrId)?.id ?? ALL_CRESTS.find((c) => c.name === nameOrId || c.name === `クレスト：${nameOrId}`)?.id;
  const k = model.vocab.indexOf(id === undefined ? nameOrId : ALL_CRESTS.some((c) => c.id === id) ? `crest:${id}` : id);
  if (k < 0) throw new Error(`モデルの vocab にないカードです: ${nameOrId}`);
  return k;
}

/** カードの行（どのゾーンでも）が入力にあるか（cards は vocab の添字） */
function rowsOfCards(model: ValueNetModel, cards: readonly number[]): Set<number> {
  const V = model.vocab.length;
  const rows = new Set<number>();
  for (let z = 0; z < model.zones.length; z++) for (const c of cards) rows.add(z * V + c);
  return rows;
}

/** --exclude（カード名か ID をカンマで並べたもの）: そのカードの行が入力にある局面を含む試合を除く述語（無ければ undefined） */
function excludeGames(model: ValueNetModel, list: string | undefined): ((r: GameRecord) => boolean) | undefined {
  if (list === undefined) return undefined;
  const rows = rowsOfCards(
    model,
    list
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x)
      .map((x) => vocabIndexOf(model, x)),
  );
  return (r) => r.samples.some((seq) => seq.some((x) => x.x.some((i) => rows.has(i))));
}

/**
 * npm run td -- eval --model a.json[,b.json,...] --data d.jsonl[,...] [--cards 名前,...]
 * モデルごとに、局面（ランダムに打った局面と介入の試合を除く）の勝敗の交差エントロピーと AUC を出す（ターン末とターンの最初・想像の局面）。
 * --cards なら、そのカードが入力にある局面だけでも出す（知らないカードの局面の予測を比べる用）。
 * 2 つ目からのモデルは 1 つ目との交差エントロピーの差と、その標準誤差（試合ごとにまとめたばらつきから）も出す。場のカードのネットワークを持たないモデルだけ
 */
function evalModels(args: Args): number {
  const models = need(args, "model").split(",").map((f) => ({ file: f, net: compileValueNet(loadValueNet(f)) }));
  if (models.some((m) => m.net.board)) throw new Error("eval は場のカードのネットワークを持たないモデルだけ");
  const first = models[0]!.net.model;
  if (models.some((m) => m.net.model.vocab.join() !== first.vocab.join() || m.net.model.zones.join() !== first.zones.join() || m.net.model.scalars.join() !== first.scalars.join())) {
    throw new Error("eval のモデルは入力の並び（vocab・zones・scalars）が同じものだけ");
  }
  const d = loadData(need(args, "data").split(","), 0, 0);
  const cards = args.get("cards");
  const rows = cards === undefined ? null : rowsOfCards(first, cards.split(",").map((x) => vocabIndexOf(first, x.trim())));
  const hasCard = new Uint8Array(d.s.length);
  if (rows) for (let i = 0; i < d.s.length; i++) for (let q = d.off[i]!; q < d.off[i + 1]!; q++) if (rows.has(d.idx[q]!)) hasCard[i] = 1;
  const preds = models.map((m) => predictAll(m.net, d));
  const subsets: [string, (i: number) => boolean][] = [
    ["end・after", (i) => d.phase[i] !== 2],
    ["imagined", (i) => d.phase[i] === 2],
  ];
  if (rows) {
    subsets.push([`カードあり end・after`, (i) => hasCard[i] === 1 && d.phase[i] !== 2]);
    subsets.push([`カードあり imagined`, (i) => hasCard[i] === 1 && d.phase[i] === 2]);
  }
  console.log(`局面 ${d.s.length}（ランダムに打った ${d.explored.reduce((x, y) => x + y, 0)} を除く）${cards ? `、カード ${cards}` : ""}`);
  for (const [label, inSubset] of subsets) {
    const idx: number[] = [];
    for (let i = 0; i < d.s.length; i++) if (!d.explored[i] && inSubset(i)) idx.push(i);
    if (idx.length === 0) continue;
    const y = idx.map((i) => d.outcome[i]!);
    const ce = (v: Float64Array) => idx.map((i) => bce(v[i]!, d.outcome[i]!));
    const base = ce(preds[0]!);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const parts = models.map((m, k) => {
      const c = ce(preds[k]!);
      const head = `${m.file} ${mean(c).toFixed(4)}（AUC ${auc(idx.map((i) => preds[k]![i]!), y).toFixed(3)}）`;
      if (k === 0) return head;
      // 試合ごとの差の和のばらつきから、差の平均の標準誤差
      const byGame = new Map<number, number>();
      idx.forEach((i, t) => byGame.set(d.game[i]!, (byGame.get(d.game[i]!) ?? 0) + c[t]! - base[t]!));
      const diff = mean(c) - mean(base);
      let ss = 0, cnt = new Map<number, number>();
      for (const i of idx) cnt.set(d.game[i]!, (cnt.get(d.game[i]!) ?? 0) + 1);
      for (const [g, sum] of byGame) ss += (sum - cnt.get(g)! * diff) ** 2;
      const se = Math.sqrt(ss) / idx.length;
      return `${head} 差 ${diff >= 0 ? "+" : ""}${diff.toFixed(4)} ± ${se.toFixed(4)}`;
    });
    console.log(`${label}(${idx.length}): ${parts.join(" / ")}`);
  }
  return 0;
}

// ---- 属性（scripts/cardAttrs.ts。docs/ai-notes.md「カードの重みを属性とカードごとの残りに分ける」） ----

/** 最初の層のカードの行を属性で表す材料 */
interface AttrBasis {
  names: string[];
  K: number;
  /** vocab × 属性 */
  x: Float64Array;
  /** vocab の各項目の 0 でない属性 */
  sparse: { idx: Int32Array; val: Float64Array }[];
}

/** モデルの属性（A を持つモデルならその名前、無ければ今のカードから作る。minSupport 項目以上が持つ属性） */
function attrBasis(model: ValueNetModel, minSupport: number): AttrBasis {
  const names = model.attr?.names ?? attributeNames(model.vocab, minSupport);
  const x = attributeMatrix(model.vocab, names);
  return { names, K: names.length, x, sparse: sparseRows(x, model.vocab.length, names.length) };
}

/** w1 の行 row が全部 0 か（学んでいない・td prune で 0 にした行） */
function rowIsZero(w1: ArrayLike<number>, row: number, H: number): boolean {
  for (let j = 0; j < H; j++) if (w1[row * H + j] !== 0) return false;
  return true;
}

/** A を外したモデル（入力の並び・隠れ層を変えたモデルや、推論に使うモデル） */
function withoutAttr(m: ValueNetModel): ValueNetModel {
  const { attr: _attr, ...rest } = m;
  return rest;
}

/**
 * ゾーンごとに、カードの行のうち fitRow が真の行（既定は 0 でない行 = 学んだ行）に属性の重み A をリッジ回帰で当てはめる。
 * 返すのはゾーン × 属性 × 隠れ層。weight(row) は行の重み（既定 1）
 */
function fitAttr(model: ValueNetModel, basis: AttrBasis, lambda: number, opts: { fitRow?: (row: number) => boolean; weight?: (row: number) => number } = {}): Float64Array {
  const H = model.hidden, V = model.vocab.length, Z = model.zones.length, K = basis.K;
  const w1 = Float64Array.from(model.w1);
  const a = new Float64Array(Z * K * H);
  const penalty = ridgePenalty(basis.names, lambda);
  for (let z = 0; z < Z; z++) {
    const rows: number[] = [];
    for (let c = 0; c < V; c++) if (opts.fitRow ? opts.fitRow(z * V + c) : !rowIsZero(w1, z * V + c, H)) rows.push(c);
    if (rows.length === 0) continue;
    const { gram, xty } = normalEquations(
      basis.x,
      K,
      H,
      rows,
      (c) => opts.weight?.(z * V + c) ?? 1,
      (c) => w1.subarray((z * V + c) * H, (z * V + c + 1) * H),
    );
    a.set(ridgeSolve(gram, xty, K, H, penalty), z * K * H);
  }
  return a;
}

/**
 * モデルの A（model.attr）で、fill が真のカードの行を属性の分にする（w1 を書き換える）。埋めた行の数を返す。
 * そのゾーンに現れえない行（スペルの場の行等。cardAttrs.ts の rowCanOccur）は 0 にする
 */
function fillFromAttr(model: ValueNetModel, w1: number[] | Float64Array, fill: (row: number) => boolean): number {
  const at = model.attr;
  if (!at) throw new Error("モデルに属性の分（attr）がありません");
  const H = model.hidden, V = model.vocab.length, Z = model.zones.length;
  const basis = attrBasis(model, 0);
  const K = basis.K;
  if (at.a.length !== Z * K * H) throw new Error("モデルの attr.a の大きさが合いません");
  const a = Float64Array.from(at.a);
  const tmp = new Float64Array(H);
  let filled = 0;
  for (let r = 0; r < Z * V; r++) {
    if (!fill(r)) continue;
    const z = Math.floor(r / V);
    if (!rowCanOccur(model.zones[z]!, model.vocab[r % V]!)) {
      w1.fill(0, r * H, (r + 1) * H);
      continue;
    }
    attributeRow(basis.x, K, H, r % V, a.subarray(z * K * H, (z + 1) * K * H), tmp);
    for (let j = 0; j < H; j++) w1[r * H + j] = round(tmp[j]!, 6);
    filled++;
  }
  return filled;
}

/** 学習データ（試合の行）の各入力が現れた局面の数 */
function inputCounts(files: string[], n: number): Float64Array {
  const counts = new Float64Array(n);
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) continue;
      for (const seq of r.samples) for (const x of seq) for (const i of x.x) if (i < n) counts[i]!++;
    }
  }
  return counts;
}

/**
 * npm run td -- attr --model m.json --out m2.json [--data d0.jsonl,...] [--ridge 3] [--n0 0] [--minSupport 3]
 * 学び直さずに、モデルのカードの行に属性の重み A を当てはめ（ゾーンごとのリッジ回帰）、学んでいない行を属性の分で埋める。
 * --data があれば、そのデータに現れた行を学んだ行とみなす（現れなかった行は td prune と同じく捨てて、カードの行は属性の分、数値の入力は 0 にする）。
 * --n0 > 0 なら、現れた局面の数 n で n / (n + n0) の重みを付けて当てはめる（めったに出ない行は学べていない）。
 * --data が無ければ、0 でない行を学んだ行とみなす（td prune した後のモデル用）。A は attr に残す（train --attr の出発点になる）。
 * --keepA 0 なら A を残さない（推論に使うだけのモデル。data/value-net.json 等）
 */
function attr(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  compileValueNet(model);
  const out = need(args, "out");
  const H = model.hidden, V = model.vocab.length, ZV = model.zones.length * V, n = baseInputSize(model);
  const basis = attrBasis(model, numArg(args, "minSupport", 3));
  const lambda = numArg(args, "ridge", 3), n0 = numArg(args, "n0", 0);
  const data = args.get("data");
  const counts = data ? inputCounts(data.split(","), n) : null;
  const w1 = Float64Array.from(model.w1);
  const learned = (r: number): boolean => (counts ? counts[r]! > 0 : !rowIsZero(w1, r, H));
  const a = fitAttr(model, basis, lambda, { fitRow: learned, ...(counts && n0 > 0 ? { weight: (r: number) => counts[r]! / (counts[r]! + n0) } : {}) });
  const withA: ValueNetModel = { ...model, attr: { names: basis.names, a: Array.from(a, (x) => round(x, 6)) } };
  const outW1 = Array.from(w1, (x) => round(x, 6));
  const filled = fillFromAttr(withA, outW1, (r) => !learned(r));
  // 数値の入力で、データに現れなかったものは td prune と同じく 0 にする
  if (counts) for (let r = ZV; r < n; r++) if (counts[r] === 0) outW1.fill(0, r * H, r * H + H);
  writeFileSync(out, JSON.stringify({ ...(numArg(args, "keepA", 1) !== 0 ? withA : model), w1: outW1 }));
  let nLearned = 0;
  for (let r = 0; r < ZV; r++) if (learned(r)) nLearned++;
  console.log(
    `${out}: 属性 ${basis.K} 個、カードの行 ${ZV} のうち学んだ ${nLearned} 行に当てはめ（λ ${lambda}${n0 > 0 ? `、n0 ${n0}` : ""}）、` +
      `残りのうち現れうる ${filled} 行を属性の分で埋めました`,
  );
  return 0;
}

/**
 * npm run td -- attrcheck --model m.json --data d.jsonl[,...] [--ridge 3] [--n0 0] [--min 300] [--per 3000] [--minSupport 3]
 * 属性の分で、知らないカードがどこまで見えるかを予測で確かめる（学び直さない。td prune した後のモデルに使う。0 の行を学んでいない行とみなす）。
 * - 学んだカード（どれかのゾーンの行が 0 でない）: そのカードの行を、そのカードを抜いて当てはめた A から出した行に替えたとき（属性）と、
 *   0 にしたとき（今の初見のカードの扱い）とで、そのカードが入力にある局面の勝敗の交差エントロピーがどれだけ増えるかを比べる。
 *   埋まった割合 = (0 にしたときの増え − 属性の行の増え) / 0 にしたときの増え（1 なら学んだ行と同じだけ当たる、0 なら 0 の行と同じ）
 * - 学んでいないカード（全部の行が 0）でデータに出るもの: 属性の分で埋めたときの交差エントロピーの差（負なら良くなった）
 * 局面はランダムに打った局面と介入の試合を除く全部（ターン末・ターンの最初・想像の局面）。--min 局面未満のカードは出さない。1 枚あたり --per 局面まで（等間隔に間引く）
 */
function attrcheck(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const net = compileValueNet(model);
  const H = model.hidden, V = model.vocab.length, Z = model.zones.length, ZV = Z * V;
  const basis = attrBasis(model, numArg(args, "minSupport", 3));
  const K = basis.K;
  const lambdas = (args.get("ridge") ?? "3").split(",").map(Number);
  const n0 = numArg(args, "n0", 0), minN = numArg(args, "min", 300), per = numArg(args, "per", 3000);
  const d = loadData(need(args, "data").split(","), 0, 0, undefined, net.board);
  // 行が現れた局面の数と、カードごとの局面
  const counts = new Float64Array(ZV);
  const byCard: number[][] = Array.from({ length: V }, () => []);
  const lastPos = new Int32Array(V).fill(-1);
  for (let i = 0; i < d.s.length; i++) {
    if (d.explored[i]) continue;
    for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
      const r = d.idx[q]!;
      if (r >= ZV) continue;
      counts[r]!++;
      const c = r % V;
      if (lastPos[c] !== i) {
        lastPos[c] = i;
        byCard[c]!.push(i);
      }
    }
  }
  const w1 = Float64Array.from(model.w1);
  const learned = (r: number): boolean => !rowIsZero(w1, r, H);
  const weight = (r: number): number => (n0 > 0 ? counts[r]! / (counts[r]! + n0) : 1);
  const eqs = Array.from({ length: Z }, (_, z) => {
    const rows: number[] = [];
    for (let c = 0; c < V; c++) if (learned(z * V + c)) rows.push(c);
    return normalEquations(basis.x, K, H, rows, (c) => weight(z * V + c), (c) => w1.subarray((z * V + c) * H, (z * V + c + 1) * H));
  });
  const penalties = lambdas.map((l) => ridgePenalty(basis.names, l));
  /** 行 (z, c) を、c を抜いて当てはめた A から出した行（c を学んでいなければ全部で当てはめたものと同じ） */
  const predictRow = (z: number, c: number, li: number): Float64Array => {
    const r = z * V + c, xc = basis.x.subarray(c * K, (c + 1) * K);
    let { gram, xty } = eqs[z]!;
    if (learned(r)) {
      gram = gram.slice();
      xty = xty.slice();
      const w = weight(r), yc = w1.subarray(r * H, (r + 1) * H);
      for (let i = 0; i < K; i++) {
        const xi = xc[i]!;
        if (xi === 0) continue;
        for (let j = 0; j < K; j++) gram[i * K + j]! -= w * xi * xc[j]!;
        for (let h = 0; h < H; h++) xty[i * H + h]! -= w * xi * yc[h]!;
      }
    }
    // 行 = xcᵀ (G + P)⁻¹ xty
    const u = choleskySolve(choleskyFactor(gram, K, penalties[li]!), K, xc, 1);
    const out = new Float64Array(H);
    for (let k = 0; k < K; k++) {
      const uk = u[k]!;
      if (uk === 0) continue;
      for (let h = 0; h < H; h++) out[h]! += uk * xty[k * H + h]!;
    }
    return out;
  };
  const nameOf = new Map([...ALL_CARDS.map((c): [string, string] => [c.id, c.name]), ...ALL_CRESTS.map((c): [string, string] => [`crest:${c.id}`, c.name])]);
  const acts = newActs(model), ba = newBoardActs(model), h0 = new Float64Array(H);
  const nv = 1 + lambdas.length;
  const results: { name: string; learned: boolean; n: number; ce: number; diff: number[] }[] = [];
  for (let c = 0; c < V; c++) {
    const list = byCard[c]!;
    if (list.length < minN) continue;
    const isLearned = Array.from({ length: Z }, (_, z) => learned(z * V + c)).some((x) => x);
    // 変える行の差（変えた行 − 今の行）。[0 にした行, 属性の行（λ ごと）] × ゾーン
    const deltas: (Float64Array | null)[][] = Array.from({ length: nv }, (_, v) =>
      Array.from({ length: Z }, (_, z) => {
        const r = z * V + c;
        if (counts[r] === 0) return null;
        const cur = w1.subarray(r * H, (r + 1) * H);
        const target = v === 0 ? new Float64Array(H) : predictRow(z, c, v - 1);
        return target.map((x, j) => x - cur[j]!);
      }),
    );
    const step = Math.ceil(list.length / per);
    let n = 0, base = 0;
    const sums = new Float64Array(nv);
    for (let t = 0; t < list.length; t += step) {
      const i = list[t]!;
      n++;
      preActAt(net, d, i, h0, ba);
      const ce = (delta: (Float64Array | null)[] | null): number => {
        const h = acts[0]!;
        h.set(h0);
        if (delta) {
          for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
            const r = d.idx[q]!;
            if (r >= ZV || r % V !== c) continue;
            const dz = delta[Math.floor(r / V)];
            if (!dz) continue;
            const x = d.val[q]!;
            for (let j = 0; j < H; j++) h[j]! += x * dz[j]!;
          }
        }
        const p = sigmoid(model.a * d.s[i]! + model.c + forwardRest(net, model.b2, acts));
        return bce(p, d.outcome[i]!);
      };
      base += ce(null);
      for (let v = 0; v < nv; v++) sums[v]! += ce(deltas[v]!);
    }
    results.push({ name: nameOf.get(model.vocab[c]!) ?? model.vocab[c]!, learned: isLearned, n, ce: base / n, diff: Array.from(sums, (x) => x / n - base / n) });
  }
  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
  const lam = lambdas.map((l) => `属性 λ${l}`);
  console.log(`属性 ${K} 個、局面 ${d.s.length}、カード ${results.length} 枚（${minN} 局面以上、1 枚 ${per} 局面まで）${n0 > 0 ? `、行の重み n / (n + ${n0})` : ""}`);
  console.log("");
  console.log(`| カード | 学んだ | 局面 | 交差エントロピー | 0 にした差 | ${lam.map((x) => `${x} の差`).join(" | ")} |`);
  console.log(`| --- | --- | ---: | ---: | ---: | ${lam.map(() => "---:").join(" | ")} |`);
  for (const r of results) {
    console.log(`| ${r.name} | ${r.learned ? "○" : ""} | ${r.n} | ${r.ce.toFixed(4)} | ${r.learned ? f(r.diff[0]!) : "（今のまま）"} | ${r.diff.slice(1).map(f).join(" | ")} |`);
  }
  console.log("");
  const known = results.filter((r) => r.learned), unknown = results.filter((r) => !r.learned);
  const mean = (rs: typeof results, v: number) => rs.reduce((x, r) => x + r.diff[v]!, 0) / Math.max(1, rs.length);
  if (known.length > 0) {
    const z0 = mean(known, 0);
    const parts = lambdas.map((l, k) => {
      const m = mean(known, k + 1);
      const worse = known.filter((r) => r.diff[k + 1]! > r.diff[0]!).length;
      return `λ${l} ${f(m)}（埋まった割合 ${(((z0 - m) / z0) * 100).toFixed(1)}%、0 より悪いカード ${worse}）`;
    });
    console.log(`学んだカード ${known.length} 枚（そのカードを抜いて当てはめ）の交差エントロピーの差の平均: 0 にした ${f(z0)}、属性 ${parts.join("、")}`);
  }
  if (unknown.length > 0) {
    const parts = lambdas.map((l, k) => `λ${l} ${f(mean(unknown, k + 1))}（良くなったカード ${unknown.filter((r) => r.diff[k + 1]! < 0).length}）`);
    console.log(`学んでいないカード ${unknown.length} 枚を属性の分で埋めたときの交差エントロピーの差の平均: ${parts.join("、")}`);
  }
  return 0;
}

// ---- ivcheck ----

function ivcheck(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const net = compileValueNet(model);
  const loaded = loadData(need(args, "data").split(","), numArg(args, "holdout", 0), 1, undefined, net.board);
  const v = predictAll(net, loaded);
  const holdoutOnly = numArg(args, "holdout", 0) > 0;
  const opp = args.get("opp");
  if (opp !== undefined && !loaded.pairs.some((q) => q.opp === opp)) throw new Error(`相手が ${opp} の介入の試合がありません`);
  const d: Dataset = opp === undefined ? loaded : { ...loaded, pairs: loaded.pairs.filter((q) => q.opp === opp) };
  if (opp !== undefined) console.log(`相手が ${opp} の試合だけ（介入の対 ${d.pairs.length}）`);
  console.log(ivSummary(d, v, holdoutOnly) ?? "介入の試合がありません");
  const nameOf = new Map(ALL_CARDS.map((c): [string, string] => [c.id, c.name]));
  // デッキ・カードごと
  const by = new Map<string, { n: number; m: number; m2: number; p: number }>();
  let negN = 0, negM = 0, negP = 0;
  for (const q of d.pairs) {
    if (holdoutOnly && !d.holdout[q.base]) continue;
    const m = ivSign(q) * (d.outcome[q.base]! - d.outcome[q.variant]!);
    const p = ivSign(q) * (v[q.base]! - v[q.variant]!);
    const key = isResZone(q.zone) ? `${q.deck}\t${ivGroup(q)}` : `${q.deck}\t${nameOf.get(q.card) ?? q.card}${q.zone === "hand" ? "" : q.zone === "drawn" ? "（引いたとき）" : "（場）"}`;
    const c = by.get(key) ?? { n: 0, m: 0, m2: 0, p: 0 };
    c.n++;
    c.m += m;
    c.m2 += m * m;
    c.p += p;
    by.set(key, c);
    if (p < 0) {
      negN++;
      negM += m;
      negP += p;
    }
  }
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  if (negN > 0) console.log(`モデルがカードの 1 枚をマイナスに見た対 ${negN}: 測った価値 ${pct(negM / negN)}、予測の差 ${pct(negP / negN)}`);
  console.log("");
  console.log("| デッキ | カード | 対 | 測った価値 | SE | 予測の差 | ずれ / SE |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  const rows = [...by].map(([key, c]) => {
    const mean = c.m / c.n;
    const se = Math.sqrt(Math.max(c.m2 / c.n - mean * mean, 0.01) / c.n);
    return { key, c, mean, se, p: c.p / c.n, z: (mean - c.p / c.n) / se };
  });
  rows.sort((x, y) => x.key.localeCompare(y.key) || y.c.n - x.c.n);
  for (const r of rows) {
    if (r.c.n < numArg(args, "min", 30)) continue;
    const [deck, card] = r.key.split("\t");
    console.log(`| ${deck} | ${card} | ${r.c.n} | ${pct(r.mean)} | ${(r.se * 100).toFixed(1)}% | ${pct(r.p)} | ${r.z.toFixed(2)} |`);
  }
  return 0;
}
