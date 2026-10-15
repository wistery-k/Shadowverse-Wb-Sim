// TD 学習の実験（npm run td）。docs/ai-notes.md「評価の項目を手で作らない（TD 学習）」
//
// 評価関数から、人が見つけたデッキ専用の項（STRIPPED）を外した点数 S を出発点にし、
// 勝つ確率 σ(a × S + c + L(局面)) の補正 L（src/ai/valueNet.ts）を、その評価で打った自己対戦から TD(λ) で学ぶ。
// 外した項を学習で取り戻せるか（今の AI との勝率の差が縮まるか）で、学習が「眺めるだけ」を越えるかを確かめる。
//
//   npm run td -- init --out m0.json [--hidden 32] [--seed 1] [--a 0.08] [--base stripped|current]
//     L = 0 のモデルを作る（--base current なら今の評価関数をそのまま出発点にする）
//   rust/target/release/svwb td selfplay --model m0.json --games 2000 [--start 0] [--eps 0.1] --out d0.jsonl
//     自己対戦は Rust 版で行う（rust/engine/src/runner/td.rs。cd rust && cargo build --release で作る）。
//     両方の席がモデルの評価で打つ探索 AI の自己対戦（7 デッキの全 49 組を順に回す）。
//     各自分のターンの最初の局面（after）とターン末の局面（end）を、入力と S と一緒に JSON Lines で書き出す。
//     --eps の確率で、自分のターンの最初の手をランダムに打つ（探索。その局面は学習に使わず、1 つ前の局面の目標もそこで切る）
//   npm run td -- train --model m0.json --data d0.jsonl[,d1.jsonl] --out m1.json [--lambda 0.7] [--epochs 2] [--lr 0.001] [--l2 0.0001] [--batch 128] [--holdout 0.1] [--fitA 1] [--seed 1]
//     λ 収益（G_t = (1-λ) V_{t+1} + λ G_{t+1}、最後は勝敗）を目標に、L と c（--fitA 1 なら a も）を交差エントロピーで学ぶ。
//     a を学ぶと、出発点の評価が勝敗をあまり当てないとき a が小さくなり、探索では補正 (c + L) / a の重みが増える。
//     V は今のモデルの予測で、エポックごとに計算し直す。試合の --holdout の割合は学習に使わず、予測の確かめに使う
//   npm run td -- prune --model m4.json --data d0.jsonl,d1.jsonl,... --out data/value-net.json
//     学習データに一度も現れなかった入力（デフォルトデッキに無いカードなど）の重みを 0 にする。学ばれずに初期値の乱数のまま残っているので、
//     そのカードを使う自作デッキで補正がでたらめに動かないようにする（ファイルも小さくなる）
//   npm run td -- probe --model m1.json --data d0.jsonl [--per 2000]
//     学んだ補正が何を見ているか: デッキごとのターン末の局面で、入力を 1 つ増やしたときの補正 (c + L) / a の変化（評価の点数の単位）の平均。
//     PP 最大値・EP・SEP を 1 増やす、手札・場にカードを 1 枚足す（変化の大きい順）
//

import { readFileSync, writeFileSync } from "node:fs";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { nextRandom, type PlayerIndex } from "../src/engine";
import {
  compileValueNet,
  defaultVocab,
  forwardValueNet,
  inputSize,
  loadValueNet,
  VALUE_SCALARS,
  VALUE_ZONES,
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
  if (cmd === "selfplay") throw new Error("自己対戦は Rust 版で行う: rust/target/release/svwb td selfplay ...（cd rust && cargo build --release で作る）");
  if (cmd === "train") return train(args);
  if (cmd === "probe") return probe(args);
  if (cmd === "prune") return prune(args);
  throw new Error("npm run td -- init|selfplay|train|probe|prune ...（scripts/td-main.ts の先頭の説明を参照）");
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
  const hidden = numArg(args, "hidden", 32);
  const base = args.get("base") ?? "stripped";
  if (base !== "stripped" && base !== "current") throw new Error(`--base は stripped か current: ${base}`);
  const holder = { rng: numArg(args, "seed", 1) >>> 0 };
  const vocab = defaultVocab();
  const n = inputSize({ vocab, zones: [...VALUE_ZONES], scalars: [...VALUE_SCALARS] });
  // 出力の重み w2 を 0 にするので、最初は L = 0（出発点の評価そのもの）
  const model: ValueNetModel = {
    kind: "td-value-net",
    version: 1,
    vocab,
    zones: [...VALUE_ZONES],
    scalars: [...VALUE_SCALARS],
    hidden,
    w1: Array.from({ length: n * hidden }, () => round(gaussian(holder) * 0.1, 6)),
    b1: Array.from({ length: hidden }, () => 0.1),
    w2: Array.from({ length: hidden }, () => 0),
    b2: 0,
    a: numArg(args, "a", 0.08),
    c: 0,
    baseWeights: base === "stripped" ? STRIPPED : {},
  };
  writeFileSync(out, JSON.stringify(model));
  console.log(`${out}: 入力 ${n}（カード・クレスト ${vocab.length} × ${VALUE_ZONES.length} ＋ 数値 ${VALUE_SCALARS.length}）、隠れ層 ${hidden}、出発点 ${base}`);
  return 0;
}

// ---- 自己対戦のデータ（svwb td selfplay が書き出す） ----

/** 自己対戦で記録する局面 1 つ */
interface Sample {
  /** 0: ターン末（end）、1: 自分のターンの最初（after） */
  ph: 0 | 1;
  /** 出発点の評価の点数 S */
  s: number;
  x: number[];
  v: number[];
  /** この局面からランダムに打った（学習に使わない） */
  ex?: 1;
}

interface GameRecord {
  g: number;
  decks: [string, string];
  winner: PlayerIndex;
  turns: number;
  samples: [Sample[], Sample[]];
}

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
}

function loadData(files: string[], holdout: number): Dataset {
  const off: number[] = [0], idx: number[] = [], val: number[] = [], s: number[] = [], next: number[] = [], outcome: number[] = [], explored: number[] = [], hold: number[] = [], phase: number[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as GameRecord;
      // 試合番号で決める（ファイルを足しても同じ試合は同じ側）
      const isHold = ((Math.imul(r.g, 2654435761) >>> 0) % 1000) / 1000 < holdout ? 1 : 0;
      r.samples.forEach((seq, p) => {
        seq.forEach((x, k) => {
          const i = s.length;
          for (let j = 0; j < x.x.length; j++) {
            idx.push(x.x[j]!);
            val.push(x.v[j]!);
          }
          off.push(idx.length);
          s.push(x.s);
          next.push(k + 1 < seq.length ? i + 1 : -1);
          outcome.push(r.winner === p ? 1 : 0);
          explored.push(x.ex ? 1 : 0);
          hold.push(isHold);
          phase.push(x.ph);
        });
      });
    }
  }
  return {
    off: Int32Array.from(off),
    idx: Int32Array.from(idx),
    val: Float32Array.from(val),
    s: Float64Array.from(s),
    next: Int32Array.from(next),
    outcome: Float64Array.from(outcome),
    explored: Uint8Array.from(explored),
    holdout: Uint8Array.from(hold),
    phase: Uint8Array.from(phase),
  };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** 局面 i の NN の出力（hidden に隠れ層の値（ReLU の後）を書く。forwardValueNet と同じ計算） */
function forwardAt(net: CompiledValueNet, d: Dataset, i: number, hidden: Float64Array): number {
  const H = net.model.hidden;
  hidden.set(net.b1);
  for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
    const row = d.idx[q]! * H, x = d.val[q]!;
    for (let j = 0; j < H; j++) hidden[j]! += x * net.w1[row + j]!;
  }
  let z = net.model.b2;
  for (let j = 0; j < H; j++) {
    if (hidden[j]! < 0) hidden[j] = 0;
    z += hidden[j]! * net.w2[j]!;
  }
  return z;
}

/** 全局面の勝つ確率の予測 */
function predictAll(net: CompiledValueNet, d: Dataset): Float64Array {
  const h = new Float64Array(net.model.hidden);
  const v = new Float64Array(d.s.length);
  for (let i = 0; i < v.length; i++) v[i] = sigmoid(net.model.a * d.s[i]! + net.model.c + forwardAt(net, d, i, h));
  return v;
}

/** λ 収益（局面 i の目標）。次の局面がランダムに打った局面なら、その局面の予測で切る */
function lambdaReturns(d: Dataset, v: Float64Array, lambda: number): Float64Array {
  const g = new Float64Array(v.length);
  // 各列の局面は添字の順に並んでいるので、後ろから計算すれば次の局面の目標は計算済み
  for (let i = v.length - 1; i >= 0; i--) {
    const j = d.next[i]!;
    if (j < 0) g[i] = d.outcome[i]!;
    else if (d.explored[j]) g[i] = v[j]!;
    else g[i] = (1 - lambda) * v[j]! + lambda * g[j]!;
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

/** 確かめ用の局面（holdout）での、勝敗に対する交差エントロピーと AUC（全体・ターン末・ターンの最初） */
function report(label: string, d: Dataset, v: Float64Array, targets: Float64Array): void {
  const parts: string[] = [];
  for (const [name, ph] of [["全体", -1], ["end", 0], ["after", 1]] as const) {
    const pred: number[] = [], y: number[] = [];
    let td = 0;
    for (let i = 0; i < v.length; i++) {
      if (!d.holdout[i] || d.explored[i] || (ph >= 0 && d.phase[i] !== ph)) continue;
      pred.push(v[i]!);
      y.push(d.outcome[i]!);
      td += bce(v[i]!, targets[i]!);
    }
    const n = pred.length;
    const ll = pred.reduce((x, p, k) => x + bce(p, y[k]!), 0) / Math.max(1, n);
    parts.push(`${name}(${n}) 勝敗の交差エントロピー ${ll.toFixed(4)} AUC ${auc(pred, y).toFixed(3)} TD ${(td / Math.max(1, n)).toFixed(4)}`);
  }
  console.log(`${label}: ${parts.join(" / ")}`);
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

  const t0 = Date.now();
  const d = loadData(files, holdout);
  const n = d.s.length;
  console.log(`${files.join(", ")}: 局面 ${n}（確かめ用 ${d.holdout.reduce((x, y) => x + y, 0)}、ランダムに打った ${d.explored.reduce((x, y) => x + y, 0)}）、読み込み ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const H = model.hidden;
  const nIn = inputSize(model);
  // 学ぶ値を 1 つの配列に並べる: [w1 | b1 | w2 | b2 | c | a]
  const oB1 = nIn * H, oW2 = oB1 + H, oB2 = oW2 + H, oC = oB2 + 1, oA = oC + 1, size = oA + 1;
  const params = new Float64Array(size);
  params.set(model.w1, 0);
  params.set(model.b1, oB1);
  params.set(model.w2, oW2);
  params[oB2] = model.b2;
  params[oC] = model.c;
  params[oA] = model.a;
  const grad = new Float64Array(size), m1 = new Float64Array(size), m2 = new Float64Array(size);
  const beta1 = 0.9, beta2 = 0.999;
  let step = 0;

  // 推論用の CompiledValueNet は params と配列を共有する（学習中の値で予測する）
  const current = (): CompiledValueNet => {
    const mdl: ValueNetModel = { ...model, b2: params[oB2]!, c: params[oC]!, a: params[oA]! };
    return { model: mdl, index: new Map(), w1: params.subarray(0, oB1), b1: params.subarray(oB1, oW2), w2: params.subarray(oW2, oB2) };
  };

  const trainIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !d.holdout[i] && !d.explored[i]);
  const h = new Float64Array(H), dh = new Float64Array(H);
  const v0 = predictAll(current(), d);
  report("学習前", d, v0, lambdaReturns(d, v0, lambda));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const targets = lambdaReturns(d, predictAll(current(), d), lambda);
    // 並べ替え（Fisher-Yates）
    for (let i = trainIdx.length - 1; i > 0; i--) {
      const j = Math.floor(nextFloat(holder) * (i + 1));
      [trainIdx[i], trainIdx[j]] = [trainIdx[j]!, trainIdx[i]!];
    }
    let lossSum = 0;
    for (let b0 = 0; b0 < trainIdx.length; b0 += batch) {
      const net = current();
      const end = Math.min(trainIdx.length, b0 + batch);
      grad.fill(0);
      for (let k = b0; k < end; k++) {
        const i = trainIdx[k]!;
        const z = forwardAt(net, d, i, h);
        const p = sigmoid(net.model.a * d.s[i]! + net.model.c + z);
        lossSum += bce(p, targets[i]!);
        const dz = (p - targets[i]!) / (end - b0);
        grad[oC]! += dz;
        if (fitA) grad[oA]! += dz * d.s[i]!;
        grad[oB2]! += dz;
        for (let j = 0; j < H; j++) {
          grad[oW2 + j]! += dz * h[j]!;
          dh[j] = h[j]! > 0 ? dz * params[oW2 + j]! : 0;
          grad[oB1 + j]! += dh[j]!;
        }
        for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
          const row = d.idx[q]! * H, x = d.val[q]!;
          for (let j = 0; j < H; j++) grad[row + j]! += dh[j]! * x;
        }
      }
      // Adam（重み w1・w2 は減衰させる）
      step++;
      const c1 = 1 - beta1 ** step, c2 = 1 - beta2 ** step;
      for (let q = 0; q < size; q++) {
        const gq = grad[q]!;
        m1[q] = beta1 * m1[q]! + (1 - beta1) * gq;
        m2[q] = beta2 * m2[q]! + (1 - beta2) * gq * gq;
        const decay = q < oB1 || (q >= oW2 && q < oB2) ? l2 * params[q]! : 0;
        params[q]! -= lr * ((m1[q]! / c1) / (Math.sqrt(m2[q]! / c2) + 1e-8) + decay);
      }
      // a が 0 に近いと補正 (c + L) / a が発散するので下限を置く
      if (params[oA]! < 0.005) params[oA] = 0.005;
    }
    const v = predictAll(current(), d);
    report(`エポック ${epoch + 1}（学習の TD ${(lossSum / trainIdx.length).toFixed(4)}、a ${params[oA]!.toFixed(4)}、c ${params[oC]!.toFixed(3)}）`, d, v, lambdaReturns(d, v, lambda));
  }
  // 補正の大きさ（評価の点数の単位）
  const net = current();
  const hBuf = new Float64Array(H);
  let absSum = 0;
  for (let i = 0; i < n; i++) absSum += Math.abs((net.model.c + forwardAt(net, d, i, hBuf)) / net.model.a);
  console.log(`補正 (c + L) / a の絶対値の平均 ${(absSum / n).toFixed(2)} 点、${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const outModel: ValueNetModel = {
    ...model,
    w1: Array.from(params.subarray(0, oB1), (x) => round(x, 6)),
    b1: Array.from(params.subarray(oB1, oW2), (x) => round(x, 6)),
    w2: Array.from(params.subarray(oW2, oB2), (x) => round(x, 6)),
    b2: round(params[oB2]!, 6),
    c: round(params[oC]!, 6),
    a: round(params[oA]!, 6),
  };
  writeFileSync(out, JSON.stringify(outModel));
  console.log(`${out} に書き出しました`);
  return 0;
}

// ---- probe ----

function probe(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const net = compileValueNet(model);
  const per = numArg(args, "per", 2000);
  const V = model.vocab.length;
  const base = model.zones.length * V;
  const zone = (name: (typeof VALUE_ZONES)[number]) => VALUE_ZONES.indexOf(name) * V;
  const scalar = (name: (typeof VALUE_SCALARS)[number]) => base + VALUE_SCALARS.indexOf(name);
  const nameOf = new Map([...ALL_CARDS.map((c): [string, string] => [c.id, c.name]), ...ALL_CRESTS.map((c): [string, string] => [`crest:${c.id}`, c.name])]);
  // デッキごとのターン末の局面
  const byDeck = new Map<string, SparseInput[]>();
  for (const file of need(args, "data").split(",")) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as GameRecord;
      r.samples.forEach((seq, p) => {
        const list = byDeck.get(r.decks[p]!) ?? [];
        for (const x of seq) if (x.ph === 0 && list.length < per) list.push({ idx: x.x, val: x.v });
        byDeck.set(r.decks[p]!, list);
      });
    }
  }
  const points = (x: SparseInput) => (model.c + forwardValueNet(net, x)) / model.a;
  const bump = (x: SparseInput, i: number, d: number): SparseInput => {
    const k = x.idx.indexOf(i);
    if (k < 0) return { idx: [...x.idx, i], val: [...x.val, d] };
    const val = [...x.val];
    val[k] = val[k]! + d;
    return { idx: x.idx, val };
  };
  /** 局面の一覧で、添字 i を d 増やしたときの点数の変化の平均（has を渡すと、その添字が既に正の局面だけ） */
  const effect = (list: SparseInput[], i: number, d: number, has = false): [number, number] => {
    let sum = 0, n = 0;
    for (const x of list) {
      if (has && !(x.val[x.idx.indexOf(i)]! > 0)) continue;
      sum += points(bump(x, i, d)) - points(x);
      n++;
    }
    return [n === 0 ? 0 : sum / n, n];
  };
  for (const [deck, list] of byDeck) {
    const mean = list.reduce((x, s) => x + points(s), 0) / Math.max(1, list.length);
    const sc = ([["myMaxPp", 0.1, "PP最大値+1"], ["myEp", 1 / 3, "EP+1"], ["mySep", 0.5, "SEP+1"], ["myHp", 0.05, "体力+1"], ["oppHp", 0.05, "相手の体力+1"]] as const)
      .map(([name, d, label]) => `${label} ${effect(list, scalar(name), d)[0].toFixed(2)}`)
      .join("、");
    console.log(`== ${deck}（${list.length} 局面、補正の平均 ${mean.toFixed(1)} 点）: ${sc}`);
    for (const z of ["myHand", "myBoard"] as const) {
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
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as GameRecord;
      for (const seq of r.samples) for (const x of seq) for (const i of x.x) used.add(i);
    }
  }
  const H = model.hidden;
  const n = inputSize(model);
  const w1 = model.w1.map((w, k) => (used.has(Math.floor(k / H)) ? w : 0));
  writeFileSync(out, JSON.stringify({ ...model, w1 }));
  console.log(`${out}: 入力 ${n} のうち、データに現れた ${used.size} 個の重みを残し、${n - used.size} 個を 0 にしました`);
  return 0;
}
