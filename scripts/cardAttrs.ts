// カード・クレストの属性と、補正の最初の層のカードの行を属性で表す計算（docs/ai-notes.md「カードの重みを属性とカードごとの残りに分ける」）。
// 学習（scripts/td-main.ts の attr・attrcheck・train --attr）が使う。推論（Rust）は使わない。
//
// 補正の最初の層のうち、ゾーン z・カード c の行を W1[z,c] = Σ_k attr_k(c) · A[z,k] + R[z,c] と分ける。
// attr はカードのデータ（種類・クラス・コスト・攻撃力・体力・キーワード・タイプ等）と能力の定義（src/cards/abilities の
// きっかけ × 効果のプリミティブ）から作る。テキストは使わない（キーワード・エンハンスは src/engine と同じ読み取り）。
// 学習データに出なかったカードは R = 0、つまり属性の分 A だけで見る（初見のカードがそれらしい値から始まる）。
// 最初の層は線形なので、A と R を足してカードごとの行に戻して書き出せば、推論は今のまま。

import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";
import type { CardAbilities, Effect, Target, Value } from "../src/engine/dsl";
import { enhanceCost, staticOf } from "../src/engine";

const CARD_BY_ID = new Map(ALL_CARDS.map((c) => [c.id, c]));
const CREST_BY_ID = new Map(ALL_CRESTS.map((c) => [c.id, c]));

/** 数値（変数・枚数等で決まる値は 1 とみなす） */
const amountOf = (v: Value | "max"): number => (typeof v === "number" ? v : 1);

/** 効果の対象の大まかな種類（相手のリーダーを含む: face、場全体: aoe、選ぶ・ランダム・これ等 1 体: single） */
function targetKinds(t: Target): string[] {
  switch (t.kind) {
    case "leader":
      return t.side === "self" ? ["self"] : ["face"];
    case "board":
      return t.side === "self" ? ["ally"] : ["aoe"];
    case "union":
      return t.of.flatMap(targetKinds);
    case "hand":
      return ["hand"];
    default:
      return ["single"];
  }
}

/** 召喚・手札に加えるカードの攻撃力 + 体力（フォロワーでなければ コスト × 2） */
function statsOf(cardId: string): number {
  const c = CARD_BY_ID.get(cardId);
  if (!c) return 0;
  return c.type === "follower" ? c.attack + c.defense : 2 * c.cost;
}

/** 能力の属性を足す（きっかけ、効果のプリミティブ、きっかけ × 効果、条件、ダメージ等の量） */
function addAbilities(ca: CardAbilities | undefined, add: (k: string, v?: number) => void): void {
  if (!ca) return;
  if (ca.fusion) add("fusion");
  if (ca.banishOnLeave) add("banishOnLeave");
  if (ca.unplayable) add("unplayable");
  const walk = (effects: Effect[], on: string): void => {
    for (const e of effects) {
      add(`op:${e.op}`);
      add(`${on}/${e.op}`);
      switch (e.op) {
        case "damage":
        case "distribute":
          for (const k of e.op === "distribute" ? ["single"] : targetKinds(e.target)) add(`damage:${k}`, amountOf(e.amount) / 5);
          break;
        case "destroy":
        case "banish":
        case "bounce":
          for (const k of targetKinds(e.target)) add(`remove:${k}`);
          break;
        case "heal":
          add("heal", amountOf(e.amount) / 5);
          break;
        case "draw":
          add("draw", amountOf(e.count));
          break;
        case "addToHand":
          add("addToHand", amountOf(e.count));
          break;
        case "summon":
          add("summonStats", (amountOf(e.count) * statsOf(e.cardId)) / 10);
          break;
        case "buff":
          for (const k of targetKinds(e.target)) add(`buff:${k}`, (amountOf(e.attack) + amountOf(e.defense)) / 5);
          break;
        case "grant":
          for (const kw of e.keywords ?? []) add(`grant:${kw}`);
          if (e.abilities?.length) add("grant:ability");
          break;
        case "gainPp":
          add("gainPp", e.amount === "max" ? 5 : amountOf(e.amount));
          break;
        case "if":
          add(`cond:${e.cond.kind === "not" ? e.cond.cond.kind : e.cond.kind}`);
          walk(e.then, on);
          if (e.else) walk(e.else, on);
          break;
        case "repeat":
          walk(e.effects, on);
          break;
        case "earthRite":
        case "necromancy":
          walk(e.then, on);
          break;
        case "mode":
          for (const o of e.options) walk(o, on);
          break;
        default:
          break;
      }
    }
  };
  for (const ab of ca.abilities) {
    add(`on:${ab.trigger.on}`);
    walk(ab.effects, ab.trigger.on);
  }
}

/**
 * vocab の 1 項目（カード ID か "crest:" を付けたクレスト ID）の属性（名前 → 値。値はおおよそ 0〜2）。
 * 全カード共通の切片 "card"（クレストは "crest"）を持つので、ゾーンごとの平均的な行も属性の分に入る
 */
export function rawAttributes(vocabId: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string, v = 1): void => {
    if (v !== 0) out.set(k, (out.get(k) ?? 0) + v);
  };
  if (vocabId.startsWith("crest:")) {
    const cr = CREST_BY_ID.get(vocabId.slice("crest:".length));
    if (!cr) throw new Error(`クレストがありません: ${vocabId}`);
    add("crest");
    const src = CARD_BY_ID.get(cr.source);
    if (src) add(`class:${src.class}`);
    if (cr.countdown !== undefined) add("countdown", cr.countdown / 5);
    addAbilities(CREST_ABILITIES[cr.id], add);
    return out;
  }
  const c = CARD_BY_ID.get(vocabId);
  if (!c) throw new Error(`カードがありません: ${vocabId}`);
  add("card");
  add(`type:${c.type}`);
  add(`class:${c.class}`);
  if (c.set === "token") add("token");
  add("cost", c.cost / 5);
  add(`cost=${Math.min(c.cost, 10)}`);
  if (c.type === "follower") {
    add("atk", c.attack / 5);
    add("def", c.defense / 5);
  }
  if (c.type === "amulet" && c.countdown !== undefined) add("countdown", c.countdown / 5);
  const st = staticOf(c.id);
  for (const k of st.keywords) add(`kw:${k}`);
  if (st.maxAttacks > 1) add("maxAttacks", st.maxAttacks - 1);
  if (st.earthSigil) add("earthSigil");
  const enh = enhanceCost(c.text);
  if (enh !== null) {
    add("enhance");
    add("enhanceCost", enh / 10);
  }
  for (const t of c.tribes ?? []) add(`tribe:${t}`);
  addAbilities(CARD_ABILITIES[c.id], add);
  return out;
}

/**
 * ゾーン zone（scripts/valueNet.ts の VALUE_ZONES）に、vocab の項目 vocabId の行が入力として現れうるか（rust/engine/src/ai/valuenet.rs の encode）。
 * 現れない行（スペルの場の行、アミュレットの攻撃力の行等）は属性の分で埋めない（ファイルが大きくなるだけ）
 */
export function rowCanOccur(zone: string, vocabId: string): boolean {
  const crest = vocabId.startsWith("crest:");
  if (zone === "myCrest" || zone === "oppCrest") return crest;
  if (crest) return false;
  const c = CARD_BY_ID.get(vocabId);
  if (!c) return true;
  switch (zone) {
    case "myHand":
    case "myHandBoost":
    case "oppHandRevealed":
      return true;
    case "myBoard":
    case "oppBoard":
      return c.type !== "spell";
    case "myBoardCountdown":
      return c.type === "amulet";
    case "myBoardEvolved":
    case "oppBoardEvolved":
    case "myBoardAtk":
    case "myBoardDef":
    case "oppBoardAtk":
    case "oppBoardDef":
      return c.type === "follower";
    default:
      return true;
  }
}

/** 切片（属性の重みを罰しない）。ゾーンの平均的な行 */
export const INTERCEPTS: readonly string[] = ["card", "crest"];

/**
 * 属性の名前の一覧: vocab のうち minSupport 項目以上が持つ属性（切片は必ず入れる）。名前の順（決まった順）。
 * 1〜2 枚にしかない属性はカードごとの残りと見分けられないので入れない
 */
export function attributeNames(vocab: readonly string[], minSupport = 3): string[] {
  const support = new Map<string, number>();
  for (const id of vocab) for (const k of rawAttributes(id).keys()) support.set(k, (support.get(k) ?? 0) + 1);
  const names = [...support].filter(([k, n]) => n >= minSupport || INTERCEPTS.includes(k)).map(([k]) => k);
  return names.sort();
}

/** 属性の表（vocab × 名前。行優先の密な配列）。名前に無い属性は捨てる */
export function attributeMatrix(vocab: readonly string[], names: readonly string[]): Float64Array {
  const K = names.length;
  const col = new Map(names.map((n, k): [string, number] => [n, k]));
  const x = new Float64Array(vocab.length * K);
  vocab.forEach((id, c) => {
    for (const [k, v] of rawAttributes(id)) {
      const j = col.get(k);
      if (j !== undefined) x[c * K + j] = v;
    }
  });
  return x;
}

/** 属性の表の各行の 0 でない列（疎。行の重みを足すときに使う） */
export function sparseRows(x: Float64Array, rows: number, K: number): { idx: Int32Array; val: Float64Array }[] {
  const out: { idx: Int32Array; val: Float64Array }[] = [];
  for (let c = 0; c < rows; c++) {
    const idx: number[] = [], val: number[] = [];
    for (let k = 0; k < K; k++) {
      const v = x[c * K + k]!;
      if (v !== 0) {
        idx.push(k);
        val.push(v);
      }
    }
    out.push({ idx: Int32Array.from(idx), val: Float64Array.from(val) });
  }
  return out;
}

/** (gram + diag(penalty)) のコレスキー分解 L（下三角、K × K） */
export function choleskyFactor(gram: Float64Array, K: number, penalty: Float64Array): Float64Array {
  const L = new Float64Array(K * K);
  for (let i = 0; i < K; i++) {
    for (let j = 0; j <= i; j++) {
      let s = gram[i * K + j]! + (i === j ? penalty[i]! : 0);
      for (let k = 0; k < j; k++) s -= L[i * K + k]! * L[j * K + k]!;
      if (i === j) {
        if (s <= 0) throw new Error("リッジ回帰の行列が正定値ではありません（罰を強くする）");
        L[i * K + i] = Math.sqrt(s);
      } else {
        L[i * K + j] = s / L[j * K + j]!;
      }
    }
  }
  return L;
}

/** L Lᵀ A = B を解く（B は K × H、A を返す。choleskyFactor の L） */
export function choleskySolve(L: Float64Array, K: number, b: ArrayLike<number>, H: number): Float64Array {
  const a = Float64Array.from(b);
  for (let i = 0; i < K; i++) {
    const d = L[i * K + i]!;
    for (let k = 0; k < i; k++) {
      const l = L[i * K + k]!;
      if (l === 0) continue;
      for (let h = 0; h < H; h++) a[i * H + h]! -= l * a[k * H + h]!;
    }
    for (let h = 0; h < H; h++) a[i * H + h]! /= d;
  }
  for (let i = K - 1; i >= 0; i--) {
    const d = L[i * K + i]!;
    for (let k = i + 1; k < K; k++) {
      const l = L[k * K + i]!;
      if (l === 0) continue;
      for (let h = 0; h < H; h++) a[i * H + h]! -= l * a[k * H + h]!;
    }
    for (let h = 0; h < H; h++) a[i * H + h]! /= d;
  }
  return a;
}

/**
 * 重み付きのリッジ回帰を正規方程式で解く: min Σ_i w_i ‖Y_i − X_i A‖² + Σ_k λ_k ‖A_k‖²。
 * gram = Σ w_i X_iᵀX_i（K × K）、xty = Σ w_i X_iᵀY_i（K × H）を渡し、A（K × H）を返す。penalty は列ごとの λ_k
 */
export function ridgeSolve(gram: Float64Array, xty: Float64Array, K: number, H: number, penalty: Float64Array): Float64Array {
  return choleskySolve(choleskyFactor(gram, K, penalty), K, xty, H);
}

/** 列ごとの罰（切片はほぼ罰しない） */
export function ridgePenalty(names: readonly string[], lambda: number): Float64Array {
  return Float64Array.from(names, (n) => (INTERCEPTS.includes(n) ? 1e-6 : lambda));
}

/**
 * ゾーン 1 つ分の正規方程式の材料: 行 rows（vocab の添字）の属性 x と重み w、目標 y(c)（H 個）から gram と xty を作る
 */
export function normalEquations(
  x: Float64Array,
  K: number,
  H: number,
  rows: readonly number[],
  weight: (c: number) => number,
  y: (c: number) => ArrayLike<number>,
): { gram: Float64Array; xty: Float64Array } {
  const gram = new Float64Array(K * K), xty = new Float64Array(K * H);
  for (const c of rows) {
    const w = weight(c);
    if (w === 0) continue;
    const yc = y(c);
    for (let i = 0; i < K; i++) {
      const xi = x[c * K + i]!;
      if (xi === 0) continue;
      for (let j = 0; j < K; j++) gram[i * K + j]! += w * xi * x[c * K + j]!;
      for (let h = 0; h < H; h++) xty[i * H + h]! += w * xi * yc[h]!;
    }
  }
  return { gram, xty };
}

/** 属性から出す行: out（H 個）= Σ_k x[c,k] · A[k,·]（A は K × H） */
export function attributeRow(x: Float64Array, K: number, H: number, c: number, a: ArrayLike<number>, out: Float64Array): void {
  out.fill(0);
  for (let k = 0; k < K; k++) {
    const v = x[c * K + k]!;
    if (v === 0) continue;
    for (let h = 0; h < H; h++) out[h]! += v * a[k * H + h]!;
  }
}
