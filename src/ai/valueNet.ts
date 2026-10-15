// 学習した評価の補正（TD 学習の実験。docs/ai-notes.md「評価の項目を手で作らない（TD 学習）」）。
//
// 評価関数の項を手で作らず、生の入力（カード ID ごとの枚数など、視点のプレイヤーに見える情報だけ）から
// 小さな NN（隠れ層 1 つ）で補正を出す。勝つ確率を σ(a × 探索の評価の点数 + c + NN の出力) とみなし、
// 探索には SearchOptions.extraEval として (c + NN の出力) / a を足す（評価の点数の単位）。
// a は固定（評価 1 点が勝率何 % か）。c と NN の重みを、学んだ評価で打った自己対戦から TD(λ) で学ぶ（scripts/td-main.ts）。
//
// 入力は、相手の手札の中身（公開済みのもの以外）と山札の中身・順番を見ない。探索は決定化した局面（相手の手札を作り直したもの）を
// 評価するので、見えない情報を入力にすると、推論のときにでたらめな手札に振り回される。

import { ALL_CARDS, ALL_CRESTS } from "../cards";
import type { GameState, PlayerIndex } from "../engine";

/** 評価する局面の種類。end: 自分のターン末（ターン終了時の処理の後）、after: 相手のターンを終えて自分のターンが始まった局面 */
export type ValuePhase = "end" | "after";

/** カード・クレストごとの入力の種類 */
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
] as const;

/** 数値の入力（おおよそ 0〜1 に収まるように割る） */
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
] as const;

/** 学習した補正（JSON で保存する） */
export interface ValueNetModel {
  kind: "td-value-net";
  version: 1;
  /** カード ID と、"crest:" を付けたクレスト ID */
  vocab: string[];
  zones: string[];
  scalars: string[];
  hidden: number;
  /** 入力 × 隠れ層（入力ごとに hidden 個ずつ並べる） */
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number;
  /** 探索の評価 1 点あたりのロジット（固定） */
  a: number;
  /** ロジットの切片 */
  c: number;
  /** 出発点の評価関数（SEARCH_WEIGHTS からの差分。compare の "weights" と同じ形） */
  baseWeights: Record<string, unknown>;
}

/** JSON から読んだ値を ValueNetModel として検証する（大きさの整合は compileValueNet で見る） */
export function parseValueNetModel(raw: unknown): ValueNetModel {
  if (typeof raw !== "object" || raw === null) throw new Error("ValueNetModel がオブジェクトではありません");
  const o = raw as Record<string, unknown>;
  const nums = (k: string): number[] => {
    const v = o[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error(`ValueNetModel の ${k} が数の配列ではありません`);
    return v as number[];
  };
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
  return {
    kind: "td-value-net",
    version: 1,
    vocab: strs("vocab"),
    zones: strs("zones"),
    scalars: strs("scalars"),
    hidden: num("hidden"),
    w1: nums("w1"),
    b1: nums("b1"),
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
  w2: Float64Array;
}

export function compileValueNet(model: ValueNetModel): CompiledValueNet {
  const zonesOk = model.zones.length === VALUE_ZONES.length && model.zones.every((z, i) => z === VALUE_ZONES[i]);
  const scalarsOk = model.scalars.length === VALUE_SCALARS.length && model.scalars.every((s, i) => s === VALUE_SCALARS[i]);
  if (!zonesOk || !scalarsOk) throw new Error("ValueNetModel の入力の並びが今のコードと違います");
  const n = inputSize(model);
  if (model.w1.length !== n * model.hidden || model.b1.length !== model.hidden || model.w2.length !== model.hidden) {
    throw new Error("ValueNetModel の重みの大きさが合いません");
  }
  return {
    model,
    index: new Map(model.vocab.map((id, i) => [id, i])),
    w1: Float64Array.from(model.w1),
    b1: Float64Array.from(model.b1),
    w2: Float64Array.from(model.w2),
  };
}

const zoneOf = (name: (typeof VALUE_ZONES)[number]): number => VALUE_ZONES.indexOf(name);
const Z = {
  myHand: zoneOf("myHand"),
  myHandBoost: zoneOf("myHandBoost"),
  myBoard: zoneOf("myBoard"),
  myBoardCountdown: zoneOf("myBoardCountdown"),
  myBoardEvolved: zoneOf("myBoardEvolved"),
  myCrest: zoneOf("myCrest"),
  oppBoard: zoneOf("oppBoard"),
  oppBoardEvolved: zoneOf("oppBoardEvolved"),
  oppCrest: zoneOf("oppCrest"),
  oppHandRevealed: zoneOf("oppHandRevealed"),
};

/** 局面 state をプレイヤー p から見た入力にする（同じ添字は足し合わせる） */
export function encodeState(net: Pick<CompiledValueNet, "index" | "model">, state: GameState, p: PlayerIndex, phase: ValuePhase): SparseInput {
  const V = net.model.vocab.length;
  const acc = new Map<number, number>();
  const add = (zone: number, id: string, v: number) => {
    const k = net.index.get(id);
    if (k === undefined || v === 0) return;
    const i = zone * V + k;
    acc.set(i, (acc.get(i) ?? 0) + v);
  };
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  for (const h of me.hand) {
    add(Z.myHand, h.cardId, 1);
    add(Z.myHandBoost, h.cardId, Math.min(h.boosts, 10) / 5);
  }
  for (const c of me.board) {
    add(Z.myBoard, c.cardId, 1);
    if (c.kind === "amulet" && c.countdown !== null) add(Z.myBoardCountdown, c.cardId, c.countdown / 3);
    if (c.kind === "follower" && c.evolve !== "none") add(Z.myBoardEvolved, c.cardId, 1);
  }
  for (const c of me.crests) add(Z.myCrest, `crest:${c.crestId}`, 1);
  for (const c of opp.board) {
    add(Z.oppBoard, c.cardId, 1);
    if (c.kind === "follower" && c.evolve !== "none") add(Z.oppBoardEvolved, c.cardId, 1);
  }
  for (const c of opp.crests) add(Z.oppCrest, `crest:${c.crestId}`, 1);
  for (const h of opp.hand) if (h.revealed) add(Z.oppHandRevealed, h.cardId, 1);

  const base = net.model.zones.length * V;
  const scalars: Record<(typeof VALUE_SCALARS)[number], number> = {
    myHp: me.leaderHp / 20,
    oppHp: opp.leaderHp / 20,
    myMaxPp: me.maxPp / 10,
    oppMaxPp: opp.maxPp / 10,
    myTurn: me.turnCount / 10,
    oppTurn: opp.turnCount / 10,
    myPp: me.pp / 10,
    myEp: me.ep / 3,
    mySep: me.sep / 2,
    oppEp: opp.ep / 3,
    oppSep: opp.sep / 2,
    myExtraPp: me.extraPpAvailable ? 1 : 0,
    oppExtraPp: opp.extraPpAvailable ? 1 : 0,
    myHandSize: me.hand.length / 9,
    oppHandSize: opp.hand.length / 9,
    myDeck: me.deck.length / 40,
    oppDeck: opp.deck.length / 40,
    myGraveyard: Math.min(me.graveyard, 30) / 20,
    oppGraveyard: Math.min(opp.graveyard, 30) / 20,
    after: phase === "after" ? 1 : 0,
    first: state.first === p ? 1 : 0,
  };
  VALUE_SCALARS.forEach((name, j) => {
    const v = scalars[name];
    if (v !== 0) acc.set(base + j, v);
  });
  const idx = [...acc.keys()];
  return { idx, val: idx.map((i) => acc.get(i)!) };
}

/** NN の出力（ロジットへの補正）。hidden を渡すと隠れ層の値（ReLU の後）を書き込む */
export function forwardValueNet(net: CompiledValueNet, x: SparseInput, hidden?: Float64Array): number {
  const H = net.model.hidden;
  const h = hidden ?? new Float64Array(H);
  h.set(net.b1);
  for (let k = 0; k < x.idx.length; k++) {
    const row = x.idx[k]! * H;
    const v = x.val[k]!;
    for (let j = 0; j < H; j++) h[j]! += v * net.w1[row + j]!;
  }
  let z = net.model.b2;
  for (let j = 0; j < H; j++) {
    if (h[j]! < 0) h[j] = 0;
    z += h[j]! * net.w2[j]!;
  }
  return z;
}

/** 探索の extraEval に渡す関数（評価の点数の単位の補正） */
export function valueNetExtraEval(net: CompiledValueNet): (state: GameState, p: PlayerIndex, phase?: ValuePhase) => number {
  const hidden = new Float64Array(net.model.hidden);
  return (state, p, phase = "end") => {
    if (state.phase === "ended") return 0;
    const z = forwardValueNet(net, encodeState(net, state, p, phase), hidden);
    return (net.model.c + z) / net.model.a;
  };
}
