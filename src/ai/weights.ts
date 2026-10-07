// クラスごとに調整した評価関数の重み（data/ai-weights.json、npm run tune -- --write で更新）。
// 記載のない項目は DEFAULT_WEIGHTS を使う。

import table from "../../data/ai-weights.json";
import { cardOf, type GameState, type PlayerIndex } from "../engine";
import type { ClassId } from "../cards";
import { DEFAULT_WEIGHTS, type EvalWeights } from "./evaluate";

export type WeightTable = Partial<Record<ClassId, Partial<EvalWeights>>>;

const TABLE = table as WeightTable;

export function weightsForClass(cls: ClassId, source: WeightTable = TABLE): EvalWeights {
  const o = source[cls];
  return o ? { ...DEFAULT_WEIGHTS, ...o, hold: { ...DEFAULT_WEIGHTS.hold, ...(o.hold ?? {}) } } : DEFAULT_WEIGHTS;
}

/** プレイヤーのデッキのクラス（山札・手札・場のニュートラル以外のカードから決める） */
export function deckClassOf(state: GameState, p: PlayerIndex): ClassId {
  const pl = state.players[p];
  for (const c of [...pl.hand, ...pl.board, ...pl.deck]) {
    const cls = cardOf(c.cardId).class;
    if (cls !== "neutral") return cls;
  }
  return "neutral";
}

/** プレイヤー p の AI が使う重み */
export function weightsFor(state: GameState, p: PlayerIndex): EvalWeights {
  return weightsForClass(deckClassOf(state, p));
}
