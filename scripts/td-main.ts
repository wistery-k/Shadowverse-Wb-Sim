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
//   npm run td -- train --model m0.json --data d0.jsonl[,d1.jsonl] --out m1.json [--lambda 0.7] [--epochs 2] [--lr 0.001] [--l2 0.0001] [--batch 128] [--holdout 0.1] [--fitA 1] [--seed 1] [--ivWeight 1] [--v1Only 0] [--best 0]
//     --best 1 なら、確かめ用の局面の勝敗の交差エントロピーが一番小さかったエポック（学習前も含む）の重みを書き出す（途中で止めるのと同じ）。
//     --cmpWeight w（既定 0）なら、td selfplay --cmp の打ち比べ（同じ局面からの並びごとに最後まで打った勝率）も学ぶ:
//     同じ局面の並びどうしで、予測した勝つ確率の平均からのずれが、測った勝率の平均からのずれに合うように（二乗誤差 × w。--cmpBatch 局面ずつ）。
//     打ち比べの局面は TD の局面と同じ並びで学ぶ（ミニバッチを混ぜて並べ替える）。docs/ai-notes.md「同じ局面からの手の比べ合いを学ぶ」
//     λ 収益（G_t = (1-λ) V_{t+1} + λ G_{t+1}、最後は勝敗）を目標に、L と c（--fitA 1 なら a も）を交差エントロピーで学ぶ。
//     a を学ぶと、出発点の評価が勝敗をあまり当てないとき a が小さくなり、探索では補正 (c + L) / a の重みが増える。
//     V は今のモデルの予測で、エポックごとに計算し直す。試合の --holdout の割合は学習に使わず、予測の確かめに使う。
//     td selfplay --iv で書き出した介入の試合（手札から 1 枚抜いた局面から打った試合）の局面は --ivWeight の重みで学ぶ（0 なら読まない）
//   npm run td -- ivcheck --model m1.json --data d0.jsonl[,d1.jsonl] [--holdout 0]
//     介入の試合で、抜いたカードごとに「測った価値」（もとの試合の勝敗 − 抜いた試合の勝敗の平均）と、
//     モデルが見ている価値（その局面の勝つ確率の予測の差）を比べる（docs/ai-notes.md「介入データを TD 学習に混ぜる」）
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
  forwardRest,
  forwardValueNet,
  layerSizes,
  newActs,
  inputSize,
  loadValueNet,
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
  if (cmd === "selfplay") throw new Error("自己対戦は Rust 版で行う: rust/target/release/svwb td selfplay ...（cd rust && cargo build --release で作る）");
  if (cmd === "train") return train(args);
  if (cmd === "probe") return probe(args);
  if (cmd === "prune") return prune(args);
  if (cmd === "ivcheck") return ivcheck(args);
  throw new Error("npm run td -- init|extend|selfplay|train|probe|prune|ivcheck ...（scripts/td-main.ts の先頭の説明を参照）");
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
  writeFileSync(out, JSON.stringify({ ...model, zones, scalars, w1 }));
  console.log(`${out}: 入力 ${model.w1.length / H} → ${from.length}（足した ${from.filter((k) => k < 0).length} 個の重みは 0）`);
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
  writeFileSync(out, JSON.stringify({ ...model, hidden: H1, w1, b1, layers: [{ w, b }], w2 }));
  console.log(`${out}: 隠れ層 ${H0} → ${H1}・${H2}（補正は元のモデルと同じ）`);
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
  /** 介入の試合: もとの試合 g のプレイヤー p の k 番目の局面から、手札のカード card を 1 枚抜いて打った */
  iv?: { p: PlayerIndex; k: number; card: string };
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
  /** 局面の学習の重み（介入の試合の局面は --ivWeight） */
  weight: Float64Array;
  /** 介入の対（もとの局面と、カードを抜いた局面） */
  pairs: IvPair[];
}

interface IvPair {
  base: number;
  variant: number;
  card: string;
  deck: string;
}

function loadData(files: string[], holdout: number, ivWeight = 1, keep?: (i: number) => boolean): Dataset {
  const off: number[] = [0], idx: number[] = [], val: number[] = [], s: number[] = [], next: number[] = [], outcome: number[] = [], explored: number[] = [], hold: number[] = [], phase: number[] = [], weight: number[] = [];
  const pairs: IvPair[] = [];
  for (const file of files) {
    // もとの試合の各プレイヤーの最初の局面の添字（介入の対を作る）。介入の試合はもとの試合のすぐ後の行にある
    const firstOf = new Map<number, [number, number]>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) continue;
      if (r.iv && ivWeight === 0) continue;
      if (r.iv) {
        const first = firstOf.get(r.g);
        if (first && r.samples[r.iv.p].length > 0) pairs.push({ base: first[r.iv.p] + r.iv.k, variant: s.length + (r.iv.p === 1 ? r.samples[0].length : 0), card: r.iv.card, deck: r.decks[r.iv.p] });
      } else {
        firstOf.set(r.g, [s.length, s.length + r.samples[0].length]);
      }
      // 試合番号で決める（ファイルを足しても同じ試合は同じ側）
      const isHold = ((Math.imul(r.g, 2654435761) >>> 0) % 1000) / 1000 < holdout ? 1 : 0;
      r.samples.forEach((seq, p) => {
        seq.forEach((x, k) => {
          const i = s.length;
          for (let j = 0; j < x.x.length; j++) {
            if (keep && !keep(x.x[j]!)) continue;
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
          weight.push(r.iv ? ivWeight : 1);
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
    weight: Float64Array.from(weight),
    pairs,
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
}

function loadGroups(files: string[], holdout: number): CmpData {
  const off: number[] = [0], idx: number[] = [], val: number[] = [], s: number[] = [], win: number[] = [], search: number[] = [], goff: number[] = [0], hold: number[] = [];
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

/** 局面ごとの疎な入力 */
interface SparseRows {
  off: Int32Array;
  idx: Int32Array;
  val: Float32Array;
}

/** 局面 i の NN の出力（acts に各隠れ層の値（ReLU の後）を書く。forwardValueNet と同じ計算） */
function forwardAt(net: CompiledValueNet, d: SparseRows, i: number, acts: Float64Array[]): number {
  const H = net.model.hidden;
  const hidden = acts[0]!;
  hidden.set(net.b1);
  for (let q = d.off[i]!; q < d.off[i + 1]!; q++) {
    const row = d.idx[q]! * H, x = d.val[q]!;
    for (let j = 0; j < H; j++) hidden[j]! += x * net.w1[row + j]!;
  }
  return forwardRest(net, net.model.b2, acts);
}

/** 全局面の勝つ確率の予測 */
function predictAll(net: CompiledValueNet, d: SparseRows & { s: Float64Array }): Float64Array {
  const h = newActs(net.model);
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

/** 確かめ用の局面（holdout。ランダムに打った局面を除く）の、勝敗に対する交差エントロピー */
function holdoutLoss(d: Dataset, v: Float64Array): number {
  let sum = 0, n = 0;
  for (let i = 0; i < v.length; i++) {
    if (!d.holdout[i] || d.explored[i]) continue;
    sum += bce(v[i]!, d.outcome[i]!);
    n++;
  }
  return sum / Math.max(1, n);
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
  const iv = ivSummary(d, v, true);
  if (iv) parts.push(iv);
  console.log(`${label}: ${parts.join(" / ")}`);
}

/** 介入の対の、測った価値（勝敗の差の平均）とモデルが見ている価値（予測の差の平均） */
function ivSummary(d: Dataset, v: Float64Array, holdoutOnly: boolean): string | null {
  let n = 0, measured = 0, predicted = 0;
  for (const q of d.pairs) {
    if (holdoutOnly && !d.holdout[q.base]) continue;
    n++;
    measured += d.outcome[q.base]! - d.outcome[q.variant]!;
    predicted += v[q.base]! - v[q.variant]!;
  }
  if (n === 0) return null;
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${((x / n) * 100).toFixed(1)}%`;
  return `介入(${n}) 測った価値 ${pct(measured)} 予測の差 ${pct(predicted)}`;
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
  const keepBest = numArg(args, "best", 0) !== 0;
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
  const d = loadData(files, holdout, ivWeight, keep);
  const n = d.s.length;
  console.log(`${files.join(", ")}: 局面 ${n}（確かめ用 ${d.holdout.reduce((x, y) => x + y, 0)}、ランダムに打った ${d.explored.reduce((x, y) => x + y, 0)}）、読み込み ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const cmp = cmpWeight > 0 ? loadGroups(files, holdout) : null;
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
  const oW2 = o, oB2 = oW2 + sizes[L - 1]!, oC = oB2 + 1, oA = oC + 1, size = oA + 1;
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
  // 減衰させる重み（w1・足した層の w・w2。バイアスと c・a は減衰させない）
  const decayed = new Uint8Array(size);
  decayed.fill(1, 0, oB1);
  for (let k = 1; k < L; k++) decayed.fill(1, layerOff[k - 1]!.w, layerOff[k - 1]!.b);
  decayed.fill(1, oW2, oB2);
  const grad = new Float64Array(size), m1 = new Float64Array(size), m2 = new Float64Array(size);
  const beta1 = 0.9, beta2 = 0.999;
  let step = 0;

  // 推論用の CompiledValueNet は params と配列を共有する（学習中の値で予測する）
  const current = (): CompiledValueNet => {
    const mdl: ValueNetModel = { ...model, b2: params[oB2]!, c: params[oC]!, a: params[oA]! };
    const layers = layerOff.map((lo, k) => ({ w: params.subarray(lo.w, lo.b), b: params.subarray(lo.b, lo.b + sizes[k + 1]!) }));
    return { model: mdl, index: new Map(), w1: params.subarray(0, oB1), b1: params.subarray(oB1, oB1 + H), layers, w2: params.subarray(oW2, oB2) };
  };

  const trainIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !d.holdout[i] && !d.explored[i]);
  const trainGroups = cmp ? Array.from({ length: cmp.goff.length - 1 }, (_, g) => g).filter((g) => !cmp.holdout[g]) : [];
  const acts = newActs(model), dacts = newActs(model);

  /** 出力 z の勾配 dz の局面（入力は rows の i 番目、各隠れ層の値は a）の勾配を grad に足す */
  const backward = (dz: number, s: number, a: Float64Array[], rows: SparseRows, i: number): void => {
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
  };

  /** 打ち比べの局面 groups の勾配を grad に足し、損失（二乗誤差 × cmpWeight の和）を返す */
  const candActs: Float64Array[][] = [];
  const cmpStep = (net: CompiledValueNet, c: CmpData, groups: number[]): number => {
    let loss = 0;
    for (const g of groups) {
      const a = c.goff[g]!, b = c.goff[g + 1]!, k = b - a;
      while (candActs.length < k) candActs.push(newActs(model));
      const p: number[] = [];
      let mp = 0, mw = 0;
      for (let t = 0; t < k; t++) {
        const pr = sigmoid(net.model.a * c.s[a + t]! + net.model.c + forwardAt(net, c, a + t, candActs[t]!));
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
        backward(dz, c.s[a + t]!, candActs[t]!, c, a + t);
      }
    }
    return loss;
  };

  const v0 = predictAll(current(), d);
  report("学習前", d, v0, lambdaReturns(d, v0, lambda));
  if (cmp) console.log(`学習前: ${cmpReport(cmp, predictAll(current(), cmp))}`);
  // --best 1: 確かめ用の局面の勝敗の交差エントロピーが一番小さかったエポックの重み
  let best = { loss: holdoutLoss(d, v0), epoch: 0, params: keepBest ? params.slice() : params };
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
      if (job < 0) {
        const g0 = -1 - job;
        cmpLoss += cmpStep(net, cmp!, trainGroups.slice(g0, g0 + cmpBatch));
      } else {
        const b0 = job;
        const end = Math.min(trainIdx.length, b0 + batch);
        for (let k = b0; k < end; k++) {
          const i = trainIdx[k]!;
          const z = forwardAt(net, d, i, acts);
          const p = sigmoid(net.model.a * d.s[i]! + net.model.c + z);
          lossSum += bce(p, targets[i]!);
          const dz = (d.weight[i]! * (p - targets[i]!)) / (end - b0);
          backward(dz, d.s[i]!, acts, d, i);
        }
      }
      // Adam（重みは減衰させる）
      step++;
      const c1 = 1 - beta1 ** step, c2 = 1 - beta2 ** step;
      for (let q = 0; q < size; q++) {
        const gq = grad[q]!;
        m1[q] = beta1 * m1[q]! + (1 - beta1) * gq;
        m2[q] = beta2 * m2[q]! + (1 - beta2) * gq * gq;
        const decay = decayed[q] ? l2 * params[q]! : 0;
        params[q]! -= lr * ((m1[q]! / c1) / (Math.sqrt(m2[q]! / c2) + 1e-8) + decay);
      }
      // a が 0 に近いと補正 (c + L) / a が発散するので下限を置く
      if (params[oA]! < 0.005) params[oA] = 0.005;
    }
    const v = predictAll(current(), d);
    report(`エポック ${epoch + 1}（学習の TD ${(lossSum / trainIdx.length).toFixed(4)}、a ${params[oA]!.toFixed(4)}、c ${params[oC]!.toFixed(3)}）`, d, v, lambdaReturns(d, v, lambda));
    if (cmp) console.log(`エポック ${epoch + 1}（学習の打ち比べ ${(cmpLoss / Math.max(1, trainGroups.length)).toFixed(4)}）: ${cmpReport(cmp, predictAll(current(), cmp))}`);
    const loss = holdoutLoss(d, v);
    if (keepBest && loss < best.loss) best = { loss, epoch: epoch + 1, params: params.slice() };
  }
  if (keepBest) {
    params.set(best.params);
    console.log(`確かめ用の局面の勝敗の交差エントロピーが一番小さい ${best.epoch === 0 ? "学習前" : `エポック ${best.epoch}`}（${best.loss.toFixed(4)}）の重みを書き出す`);
  }
  // 補正の大きさ（評価の点数の単位）
  const net = current();
  const hBuf = newActs(model);
  let absSum = 0;
  for (let i = 0; i < n; i++) absSum += Math.abs((net.model.c + forwardAt(net, d, i, hBuf)) / net.model.a);
  console.log(`補正 (c + L) / a の絶対値の平均 ${(absSum / n).toFixed(2)} 点、${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const outModel: ValueNetModel = {
    ...model,
    w1: Array.from(params.subarray(0, oB1), (x) => round(x, 6)),
    b1: Array.from(params.subarray(oB1, oB1 + H), (x) => round(x, 6)),
    ...(L > 1 ? { layers: current().layers.map((l) => ({ w: Array.from(l.w, (x) => round(x, 6)), b: Array.from(l.b, (x) => round(x, 6)) })) } : {}),
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
  const zone = (name: (typeof VALUE_ZONES)[number]) => model.zones.indexOf(name) * V;
  const scalar = (name: (typeof VALUE_SCALARS)[number]) => base + model.scalars.indexOf(name);
  const nameOf = new Map([...ALL_CARDS.map((c): [string, string] => [c.id, c.name]), ...ALL_CRESTS.map((c): [string, string] => [`crest:${c.id}`, c.name])]);
  // デッキごとのターン末の局面
  const byDeck = new Map<string, SparseInput[]>();
  for (const file of need(args, "data").split(",")) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) continue;
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
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseLine(line);
      if (isCmp(r)) continue;
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

// ---- ivcheck ----

function ivcheck(args: Args): number {
  const model = loadValueNet(need(args, "model"));
  const d = loadData(need(args, "data").split(","), numArg(args, "holdout", 0));
  const v = predictAll(compileValueNet(model), d);
  const holdoutOnly = numArg(args, "holdout", 0) > 0;
  console.log(ivSummary(d, v, holdoutOnly) ?? "介入の試合がありません");
  const nameOf = new Map(ALL_CARDS.map((c): [string, string] => [c.id, c.name]));
  // デッキ・カードごと
  const by = new Map<string, { n: number; m: number; m2: number; p: number }>();
  let negN = 0, negM = 0, negP = 0;
  for (const q of d.pairs) {
    if (holdoutOnly && !d.holdout[q.base]) continue;
    const m = d.outcome[q.base]! - d.outcome[q.variant]!;
    const p = v[q.base]! - v[q.variant]!;
    const key = `${q.deck}\t${nameOf.get(q.card) ?? q.card}`;
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
  if (negN > 0) console.log(`モデルが手札の 1 枚をマイナスに見た対 ${negN}: 測った価値 ${pct(negM / negN)}、予測の差 ${pct(negP / negN)}`);
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
