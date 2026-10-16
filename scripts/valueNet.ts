// 学習した評価の補正のモデル（TD 学習の実験。docs/ai-notes.md「評価の項目を手で作らない（TD 学習）」）。学習（scripts/td-main.ts）が使う。
//
// 評価関数の項を手で作らず、生の入力（カード ID ごとの枚数など、視点のプレイヤーに見える情報だけ）から
// NN（隠れ層 1 つ。layers で隠れ層を足せる）で補正を出す。勝つ確率を σ(a × 探索の評価の点数 + c + NN の出力) とみなし、
// 探索には (c + NN の出力) / a を足す（評価の点数の単位）。
// a は固定（評価 1 点が勝率何 % か）。c と NN の重みを、学んだ評価で打った自己対戦から TD(λ) で学ぶ。
// 局面から入力を作るのと探索で使うのは Rust 版（rust/engine/src/ai/valuenet.rs）。入力の並び（VALUE_ZONES・VALUE_SCALARS）はそれと同じにする。
//
// 入力は、相手の手札の中身（公開済みのもの以外）と山札の中身・順番を見ない。探索は決定化した局面（相手の手札を作り直したもの）を
// 評価するので、見えない情報を入力にすると、推論のときにでたらめな手札に振り回される。

import { readFileSync } from "node:fs";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";

/**
 * カード・クレストごとの入力の種類。モデルはこの並びの部分列を持つ（足す前のモデルも読める）。
 * 後ろの 4 つは場のフォロワーの攻撃力・体力（カードごとの合計を 5 で割る）
 */
export const VALUE_ZONES = [
  "myHand",
  "myHandBoost",
  "myBoard",
  "myBoardCountdown",
  "myBoardEvolved",
  "myCrest",
  "oppBoard",
  "oppBoardEvolved",
  "oppCrest",
  "oppHandRevealed",
  "myBoardAtk",
  "myBoardDef",
  "oppBoardAtk",
  "oppBoardDef",
] as const;

/** 数値の入力（おおよそ 0〜1 に収まるように割る。VALUE_ZONES と同じく、モデルはこの並びの部分列を持つ）。"first" より後ろは場のフォロワーの合計とキーワードを持つ数 */
export const VALUE_SCALARS = [
  "myHp",
  "oppHp",
  "myMaxPp",
  "oppMaxPp",
  "myTurn",
  "oppTurn",
  "myPp",
  "myEp",
  "mySep",
  "oppEp",
  "oppSep",
  "myExtraPp",
  "oppExtraPp",
  "myHandSize",
  "oppHandSize",
  "myDeck",
  "oppDeck",
  "myGraveyard",
  "oppGraveyard",
  "after",
  "first",
  "myAtkSum",
  "myDefSum",
  "oppAtkSum",
  "oppDefSum",
  "myWard",
  "oppWard",
  "myBane",
  "oppBane",
  "myBarrier",
  "oppBarrier",
  "myAmbush",
  "oppAmbush",
] as const;

/** 足す前（2026-10-16 まで）の入力の並び（npm run td -- init --inputs v1） */
export const VALUE_ZONES_V1 = VALUE_ZONES.slice(0, 10);
export const VALUE_SCALARS_V1 = VALUE_SCALARS.slice(0, 21);

/** names が all の部分列（順番を保つ）か */
function isSubsequence(names: readonly string[], all: readonly string[]): boolean {
  let j = 0;
  for (const n of names) {
    while (j < all.length && all[j] !== n) j++;
    if (j === all.length) return false;
    j++;
  }
  return true;
}

/** 学習した補正（JSON で保存する） */
export interface ValueNetModel {
  kind: "td-value-net";
  version: 1;
  /** カード ID と、"crest:" を付けたクレスト ID */
  vocab: string[];
  zones: string[];
  scalars: string[];
  /** 最初の隠れ層の大きさ */
  hidden: number;
  /** 入力 × 隠れ層（入力ごとに hidden 個ずつ並べる） */
  w1: number[];
  b1: number[];
  /**
   * 最初の隠れ層の後に足す隠れ層（無ければ隠れ層 1 つ。大きさは b の長さ）。w は前の層 × この層（前の層の値ごとに b.length 個ずつ並べる）。
   * 足す前のモデル（項目なし）もそのまま読める。docs/ai-notes.md「大きなネットワークで一から学び直す」
   */
  layers?: ValueNetLayer[];
  /** 最後の隠れ層 → 出力 */
  w2: number[];
  b2: number;
  /** 探索の評価 1 点あたりのロジット（固定） */
  a: number;
  /** ロジットの切片 */
  c: number;
  /** 出発点の評価関数（SEARCH_WEIGHTS からの差分。compare の "weights" と同じ形） */
  baseWeights: Record<string, unknown>;
}

/** 足した隠れ層 */
export interface ValueNetLayer {
  w: number[];
  b: number[];
}

/** JSON から読んだ値を ValueNetModel として検証する（大きさの整合は compileValueNet で見る） */
export function parseValueNetModel(raw: unknown): ValueNetModel {
  if (typeof raw !== "object" || raw === null) throw new Error("ValueNetModel がオブジェクトではありません");
  const o = raw as Record<string, unknown>;
  const numsOf = (v: unknown, k: string): number[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error(`ValueNetModel の ${k} が数の配列ではありません`);
    return v as number[];
  };
  const nums = (k: string): number[] => numsOf(o[k], k);
  const strs = (k: string): string[] => {
    const v = o[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`ValueNetModel の ${k} が文字列の配列ではありません`);
    return v as string[];
  };
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`ValueNetModel の ${k} が数ではありません`);
    return v;
  };
  if (o.kind !== "td-value-net" || o.version !== 1) throw new Error("ValueNetModel の kind・version が違います");
  const baseWeights = o.baseWeights;
  if (typeof baseWeights !== "object" || baseWeights === null || Array.isArray(baseWeights)) throw new Error("ValueNetModel の baseWeights がオブジェクトではありません");
  let layers: ValueNetLayer[] | undefined;
  if (o.layers !== undefined) {
    if (!Array.isArray(o.layers)) throw new Error("ValueNetModel の layers が配列ではありません");
    layers = o.layers.map((l: unknown, i): ValueNetLayer => {
      if (typeof l !== "object" || l === null) throw new Error(`ValueNetModel の layers[${i}] がオブジェクトではありません`);
      const r = l as Record<string, unknown>;
      return { w: numsOf(r.w, `layers[${i}].w`), b: numsOf(r.b, `layers[${i}].b`) };
    });
  }
  return {
    kind: "td-value-net",
    version: 1,
    vocab: strs("vocab"),
    zones: strs("zones"),
    scalars: strs("scalars"),
    hidden: num("hidden"),
    w1: nums("w1"),
    b1: nums("b1"),
    ...(layers ? { layers } : {}),
    w2: nums("w2"),
    b2: num("b2"),
    a: num("a"),
    c: num("c"),
    baseWeights: baseWeights as Record<string, unknown>,
  };
}

/** 疎な入力（添字と値） */
export interface SparseInput {
  idx: number[];
  val: number[];
}

/** 今のカード・クレストの一覧（新しいモデルを作るとき用） */
export function defaultVocab(): string[] {
  return [...ALL_CARDS.map((c) => c.id), ...ALL_CRESTS.map((c) => `crest:${c.id}`)];
}

export function inputSize(m: Pick<ValueNetModel, "vocab" | "zones" | "scalars">): number {
  return m.zones.length * m.vocab.length + m.scalars.length;
}

/** 推論用にまとめたもの */
export interface CompiledValueNet {
  model: ValueNetModel;
  index: Map<string, number>;
  w1: Float64Array;
  b1: Float64Array;
  layers: { w: Float64Array; b: Float64Array }[];
  w2: Float64Array;
}

/** 隠れ層の大きさ（最初の層から順に） */
export function layerSizes(m: Pick<ValueNetModel, "hidden" | "layers">): number[] {
  return [m.hidden, ...(m.layers ?? []).map((l) => l.b.length)];
}

export function compileValueNet(model: ValueNetModel): CompiledValueNet {
  if (!isSubsequence(model.zones, VALUE_ZONES) || !isSubsequence(model.scalars, VALUE_SCALARS)) throw new Error("ValueNetModel の入力の並びが今のコードと違います");
  const n = inputSize(model);
  const sizes = layerSizes(model);
  const layersOk = (model.layers ?? []).every((l, i) => l.b.length > 0 && l.w.length === sizes[i]! * l.b.length);
  if (model.w1.length !== n * model.hidden || model.b1.length !== model.hidden || !layersOk || model.w2.length !== sizes[sizes.length - 1]) {
    throw new Error("ValueNetModel の重みの大きさが合いません");
  }
  return {
    model,
    index: new Map(model.vocab.map((id, i) => [id, i])),
    w1: Float64Array.from(model.w1),
    b1: Float64Array.from(model.b1),
    layers: (model.layers ?? []).map((l) => ({ w: Float64Array.from(l.w), b: Float64Array.from(l.b) })),
    w2: Float64Array.from(model.w2),
  };
}

/** 隠れ層の後ろの層を順に計算して出力を返す（acts[0] に最初の隠れ層の ReLU の前の値が入っている。各層の ReLU の後の値を acts に書く） */
export function forwardRest(net: Pick<CompiledValueNet, "layers" | "w2">, b2: number, acts: Float64Array[]): number {
  let h = acts[0]!;
  for (let j = 0; j < h.length; j++) if (h[j]! < 0) h[j] = 0;
  net.layers.forEach((l, k) => {
    const out = acts[k + 1]!;
    const m = out.length;
    out.set(l.b);
    for (let i = 0; i < h.length; i++) {
      const x = h[i]!;
      if (x === 0) continue;
      const row = i * m;
      for (let j = 0; j < m; j++) out[j]! += x * l.w[row + j]!;
    }
    for (let j = 0; j < m; j++) if (out[j]! < 0) out[j] = 0;
    h = out;
  });
  let z = b2;
  for (let j = 0; j < h.length; j++) z += h[j]! * net.w2[j]!;
  return z;
}

/** 隠れ層の値を書く場所（forwardRest の acts） */
export function newActs(m: Pick<ValueNetModel, "hidden" | "layers">): Float64Array[] {
  return layerSizes(m).map((k) => new Float64Array(k));
}

/** NN の出力（ロジットへの補正）。acts を渡すと各隠れ層の値（ReLU の後）を書き込む */
export function forwardValueNet(net: CompiledValueNet, x: SparseInput, acts?: Float64Array[]): number {
  const H = net.model.hidden;
  const a = acts ?? newActs(net.model);
  const h = a[0]!;
  h.set(net.b1);
  for (let k = 0; k < x.idx.length; k++) {
    const row = x.idx[k]! * H;
    const v = x.val[k]!;
    for (let j = 0; j < H; j++) h[j]! += v * net.w1[row + j]!;
  }
  return forwardRest(net, net.model.b2, a);
}

export function loadValueNet(path: string): ValueNetModel {
  return parseValueNetModel(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
