// 学習した評価の補正のモデル（TD 学習の実験。docs/ai-notes.md「評価の項目を手で作らない（TD 学習）」）。学習（scripts/td-main.ts）が使う。
//
// 評価関数の項を手で作らず、生の入力（カード ID ごとの枚数など、視点のプレイヤーに見える情報だけ）から
// NN（隠れ層 1 つ。layers で隠れ層を足せる）で補正を出す。勝つ確率を σ(a × 探索の評価の点数 + c + NN の出力) とみなし、
// 探索には (c + NN の出力) / a を足す（評価の点数の単位）。
// a は固定（評価 1 点が勝率何 % か）。c と NN の重みを、学んだ評価で打った自己対戦から TD(λ) で学ぶ。
// 局面から入力を作るのと探索で使うのは Rust 版（rust/engine/src/ai/valuenet.rs）。入力の並び（VALUE_ZONES・VALUE_SCALARS）はそれと同じにする。
//
// board を持つモデルは、場のカード 1 枚ずつを同じ小さなネットワークに通して足した値も最初の隠れ層の入力にする（ValueNetBoard）。
//
// 入力は、相手の手札の中身（公開済みのもの以外）と山札の中身・順番を見ない。探索は決定化した局面（相手の手札を作り直したもの）を
// 評価するので、見えない情報を入力にすると、推論のときにでたらめな手札に振り回される。

import { readFileSync } from "node:fs";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";

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

/**
 * 数値の入力（おおよそ 0〜1 に収まるように割る。VALUE_ZONES と同じく、モデルはこの並びの部分列を持つ）。"first" より後ろは場のフォロワーの合計とキーワードを持つ数。
 * 最後の "imagined" は、探索が相手のターンを読んだ後の想像の局面か（自己対戦の "ph": 2。docs/ai-notes.md「読みの中の相手のずれを学習で直す・資源の介入」）
 */
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
  "imagined",
] as const;

/**
 * 場のカード 1 枚ごとの数値の入力（場のカードのネットワーク。rust/engine/src/ai/valuenet.rs の BOARD_FEATURES と同じ並び。
 * モデルはこの並びの部分列を持つ）。9 つのキーワード（ward〜aura）はエンジンのキーワードの名前と同じ
 */
export const BOARD_FEATURES = [
  "follower",
  "atk",
  "def",
  "damage",
  "evolved",
  "superEvolved",
  "ward",
  "storm",
  "rush",
  "bane",
  "drain",
  "ambush",
  "intimidate",
  "barrier",
  "aura",
  "extraAttacks",
  "cannotAttack",
  "countdown",
  "sigils",
] as const;

/**
 * 場のカード 1 枚（svwb td selfplay が局面の "b" に書く。rust/engine/src/runner/td.rs の write_board_card。学習の入力に直す前の値）。
 * 書いていない項目は既定の値（無い・0・1 等）。元の攻撃力・体力（カードに書かれた値。進化の +2/+2 もバフの扱い）はカード ID から分かるので書かない。
 * x は書くが、場のカードのネットワークの入力にはしない（場のカードの X を後で使うカードがプールに無い）
 */
export interface BoardCard {
  /** カード ID */
  c: string;
  /** フォロワーだけ: 攻撃力（ターン中だけの増減も込み）・体力・体力の上限 */
  a?: number;
  d?: number;
  md?: number;
  /** 1: 進化した、2: 超進化した（無ければ進化していない） */
  e?: 1 | 2;
  /** 1 ターンに攻撃できる回数（無ければ 1） */
  ma?: number;
  /** 攻撃できない効果を受けている */
  na?: 1;
  /** カードが覚えている X の値 */
  x?: number;
  /** アミュレットだけ: カウントダウン、土の印の数 */
  cd?: number;
  sg?: number;
  /** キーワード（ターン中だけのものも込み、付いた順） */
  k?: string[];
  /** 付与された能力（src/engine/dsl.ts の Ability の JSON） */
  g?: unknown[];
}

/**
 * 場のカードのネットワーク（docs/ai-notes.md「場のフォロワーごとのネットワーク」）。場のカード 1 枚ずつを同じ層に通し、
 * 最後の層の値（ReLU の後）を自分の場・相手の場ごとに足して、補正の最初の層の入力の末尾（自分の K 個、相手の K 個）に入れる
 */
export interface ValueNetBoard {
  /** 数値の入力（BOARD_FEATURES の部分列） */
  features: string[];
  /** 見分ける付与された能力（Ability の JSON.stringify） */
  grants: string[];
  /** 層（最初の層の入力は vocab のカード・grants・features の順。w は前の層 × この層） */
  layers: ValueNetLayer[];
}

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
  /** 場のカードのネットワーク（無ければ使わない。npm run td -- board で足す） */
  board?: ValueNetBoard;
  /**
   * 最初の層のカードの行を属性で表す分（scripts/cardAttrs.ts。npm run td -- attr・train --attr が書く）。推論は使わない（w1 に足し込み済み）。
   * w1 のゾーン z・カード c の行 = Σ_k 属性 k(c) · a[z,k,·] + カードごとの残り。a はゾーン × names × 隠れ層の大きさ
   */
  attr?: ValueNetAttr;
}

/** 最初の層のカードの行の、属性で表す分 */
export interface ValueNetAttr {
  /** 属性の名前（scripts/cardAttrs.ts の attributeNames） */
  names: string[];
  /** ゾーン × 属性 × 隠れ層 */
  a: number[];
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
  const layersOf = (v: unknown, k: string): ValueNetLayer[] => {
    if (!Array.isArray(v)) throw new Error(`ValueNetModel の ${k} が配列ではありません`);
    return v.map((l: unknown, i): ValueNetLayer => {
      if (typeof l !== "object" || l === null) throw new Error(`ValueNetModel の ${k}[${i}] がオブジェクトではありません`);
      const r = l as Record<string, unknown>;
      return { w: numsOf(r.w, `${k}[${i}].w`), b: numsOf(r.b, `${k}[${i}].b`) };
    });
  };
  const strsOf = (v: unknown, k: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`ValueNetModel の ${k} が文字列の配列ではありません`);
    return v as string[];
  };
  const layers = o.layers === undefined ? undefined : layersOf(o.layers, "layers");
  let board: ValueNetBoard | undefined;
  if (o.board !== undefined) {
    if (typeof o.board !== "object" || o.board === null) throw new Error("ValueNetModel の board がオブジェクトではありません");
    const r = o.board as Record<string, unknown>;
    board = { features: strsOf(r.features, "board.features"), grants: strsOf(r.grants, "board.grants"), layers: layersOf(r.layers, "board.layers") };
  }
  let attr: ValueNetAttr | undefined;
  if (o.attr !== undefined) {
    if (typeof o.attr !== "object" || o.attr === null) throw new Error("ValueNetModel の attr がオブジェクトではありません");
    const r = o.attr as Record<string, unknown>;
    attr = { names: strsOf(r.names, "attr.names"), a: numsOf(r.a, "attr.a") };
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
    ...(board ? { board } : {}),
    ...(attr ? { attr } : {}),
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

/** 局面から作る入力（自己対戦の書き出しの "x"）の数。場のカードのネットワークの出力はこの後ろに入る */
export function baseInputSize(m: Pick<ValueNetModel, "vocab" | "zones" | "scalars">): number {
  return m.zones.length * m.vocab.length + m.scalars.length;
}

/** 場のカードのネットワークの出力の大きさ K（無ければ 0） */
export function boardOut(m: Pick<ValueNetModel, "board">): number {
  const ls = m.board?.layers;
  return ls && ls.length > 0 ? ls[ls.length - 1]!.b.length : 0;
}

/** 場のカードのネットワークの最初の層の入力の数（vocab のカード・grants・features） */
export function boardInputSize(m: Pick<ValueNetModel, "vocab" | "board">): number {
  return m.board ? m.vocab.length + m.board.grants.length + m.board.features.length : 0;
}

/** 補正の最初の層の入力の数（局面から作る入力と、場のカードのネットワークの出力 2K 個） */
export function inputSize(m: Pick<ValueNetModel, "vocab" | "zones" | "scalars"> & { board?: ValueNetBoard }): number {
  return baseInputSize(m) + 2 * boardOut(m);
}

/** 推論用にまとめたもの */
export interface CompiledValueNet {
  model: ValueNetModel;
  index: Map<string, number>;
  w1: Float64Array;
  b1: Float64Array;
  layers: { w: Float64Array; b: Float64Array }[];
  w2: Float64Array;
  board?: CompiledBoard;
}

/** 場のカードのネットワーク（推論用） */
export interface CompiledBoard {
  /** カード ID → vocab の添字 */
  index: Map<string, number>;
  /** BOARD_FEATURES の各項目の、モデルの features での添字（無ければ -1） */
  featureSlot: number[];
  grantIndex: Map<string, number>;
  /** vocab・grants の数（features の入力はこの後ろ） */
  nVocab: number;
  nGrants: number;
  layers: { w: Float64Array; b: Float64Array }[];
  /** 最後の層の大きさ K */
  out: number;
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
  const index = new Map(model.vocab.map((id, i): [string, number] => [id, i]));
  return {
    model,
    index,
    w1: Float64Array.from(model.w1),
    b1: Float64Array.from(model.b1),
    layers: (model.layers ?? []).map((l) => ({ w: Float64Array.from(l.w), b: Float64Array.from(l.b) })),
    w2: Float64Array.from(model.w2),
    ...(model.board ? { board: compileBoard(model.board, index) } : {}),
  };
}

function compileBoard(b: ValueNetBoard, index: Map<string, number>): CompiledBoard {
  if (!isSubsequence(b.features, BOARD_FEATURES)) throw new Error("ValueNetModel の board.features の並びが今のコードと違います");
  let last = index.size + b.grants.length + b.features.length;
  const ok =
    b.layers.length > 0 &&
    b.layers.every((l) => {
      const fits = l.b.length > 0 && l.w.length === last * l.b.length;
      last = l.b.length;
      return fits;
    });
  if (!ok) throw new Error("ValueNetModel の board の重みの大きさが合いません");
  return {
    index,
    featureSlot: BOARD_FEATURES.map((f) => b.features.indexOf(f)),
    grantIndex: new Map(b.grants.map((g, i): [string, number] => [g, i])),
    nVocab: index.size,
    nGrants: b.grants.length,
    layers: b.layers.map((l) => ({ w: Float64Array.from(l.w), b: Float64Array.from(l.b) })),
    out: last,
  };
}

/**
 * カード・クレストの能力で付与される能力（grant の abilities。JSON.stringify、見つけた順に重複なし）。場のカードのネットワークの grants。
 * Rust 版は場のカードの能力を同じ文字列（rust/engine/src/state_json.rs の ability_json_texts）で見分ける
 */
export function boardGrantKeys(): string[] {
  const keys: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    if (o.op === "grant" && Array.isArray(o.abilities)) {
      for (const a of o.abilities) {
        const k = JSON.stringify(a);
        if (!keys.includes(k)) keys.push(k);
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(CARD_ABILITIES);
  walk(CREST_ABILITIES);
  return keys;
}

/** 場のカード 1 枚の入力（疎。rust/engine/src/ai/valuenet.rs の BoardNet::card_input と同じ並びと値） */
export function boardCardInput(b: CompiledBoard, c: BoardCard): SparseInput {
  const idx: number[] = [], val: number[] = [];
  const k = b.index.get(c.c);
  if (k !== undefined) {
    idx.push(k);
    val.push(1);
  }
  for (const g of c.g ?? []) {
    const j = b.grantIndex.get(JSON.stringify(g));
    if (j !== undefined) {
      idx.push(b.nVocab + j);
      val.push(1);
    }
  }
  const f = new Array<number>(BOARD_FEATURES.length).fill(0);
  if (c.a !== undefined) {
    const d = c.d ?? 0, md = c.md ?? 0;
    f[0] = 1;
    f[1] = c.a / 5;
    f[2] = d / 5;
    f[3] = (md - d) / 5;
    f[4] = c.e === 1 ? 1 : 0;
    f[5] = c.e === 2 ? 1 : 0;
    f[15] = (c.ma ?? 1) - 1;
    f[16] = c.na ? 1 : 0;
  } else {
    f[17] = (c.cd ?? 0) / 3;
    f[18] = (c.sg ?? 0) / 3;
  }
  for (const name of c.k ?? []) {
    const j = (BOARD_FEATURES as readonly string[]).indexOf(name);
    if (j >= 0) f[j] = 1;
  }
  const base = b.nVocab + b.nGrants;
  f.forEach((x, j) => {
    const s = b.featureSlot[j]!;
    if (s >= 0 && x !== 0) {
      idx.push(base + s);
      val.push(x);
    }
  });
  return { idx, val };
}

/**
 * 局面の場のカード（疎な入力の並び。cards[k] の側は side[k]、0: 自分、1: 相手）を層に通して、側ごとに足した値を sums（2K）に書く。
 * acts を渡すと、カード k の各層の値（ReLU の後）を acts[k] に書く（学習の逆伝播用）
 */
export function boardSums(b: CompiledBoard, cards: { side: number; input: SparseInput }[], sums: Float64Array, acts?: Float64Array[][]): void {
  sums.fill(0);
  cards.forEach((c, k) => {
    const a = acts?.[k] ?? b.layers.map((l) => new Float64Array(l.b.length));
    boardCardForward(b, c.input.idx, c.input.val, 0, c.input.idx.length, a);
    const out = a[a.length - 1]!;
    for (let j = 0; j < b.out; j++) sums[c.side * b.out + j]! += out[j]!;
  });
}

/** 場のカード 1 枚を層に通す（入力は idx・val の from〜to。各層の値（ReLU の後）を a に書く） */
export function boardCardForward(b: CompiledBoard, idx: ArrayLike<number>, val: ArrayLike<number>, from: number, to: number, a: Float64Array[]): void {
  const l0 = b.layers[0]!;
  const h = a[0]!;
  const m0 = h.length;
  h.set(l0.b);
  for (let q = from; q < to; q++) {
    const row = idx[q]! * m0, x = val[q]!;
    for (let j = 0; j < m0; j++) h[j]! += x * l0.w[row + j]!;
  }
  for (let j = 0; j < m0; j++) if (h[j]! < 0) h[j] = 0;
  for (let k = 1; k < b.layers.length; k++) {
    const l = b.layers[k]!, hin = a[k - 1]!, out = a[k]!;
    const m = out.length;
    out.set(l.b);
    for (let i = 0; i < hin.length; i++) {
      const x = hin[i]!;
      if (x === 0) continue;
      const row = i * m;
      for (let j = 0; j < m; j++) out[j]! += x * l.w[row + j]!;
    }
    for (let j = 0; j < m; j++) if (out[j]! < 0) out[j] = 0;
  }
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

/**
 * NN の出力（ロジットへの補正）。acts を渡すと各隠れ層の値（ReLU の後）を書き込む。
 * 場のカードのネットワークを持つモデルは、局面の場のカード（自己対戦の書き出しの "b"。[自分の場, 相手の場]）も使う
 */
export function forwardValueNet(net: CompiledValueNet, x: SparseInput, acts?: Float64Array[], board?: [BoardCard[], BoardCard[]]): number {
  const H = net.model.hidden;
  const a = acts ?? newActs(net.model);
  const h = a[0]!;
  h.set(net.b1);
  for (let k = 0; k < x.idx.length; k++) {
    const row = x.idx[k]! * H;
    const v = x.val[k]!;
    for (let j = 0; j < H; j++) h[j]! += v * net.w1[row + j]!;
  }
  if (net.board) {
    if (!board) throw new Error("場のカードのネットワークを持つモデルには、局面の場のカード（\"b\"）が要ります");
    const b = net.board;
    const sums = new Float64Array(2 * b.out);
    boardSums(b, board.flatMap((cs, side) => cs.map((c) => ({ side, input: boardCardInput(b, c) }))), sums);
    const base = baseInputSize(net.model);
    for (let t = 0; t < sums.length; t++) {
      const v = sums[t]!;
      if (v === 0) continue;
      const row = (base + t) * H;
      for (let j = 0; j < H; j++) h[j]! += v * net.w1[row + j]!;
    }
  }
  return forwardRest(net, net.model.b2, a);
}

export function loadValueNet(path: string): ValueNetModel {
  return parseValueNetModel(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
