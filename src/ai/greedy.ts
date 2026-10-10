// 貪欲法の AI: 各合法手を適用した後の盤面を評価し、最も良いものを選ぶ。
// 改善する手が無ければターンを終了する。
// 手は実際の局面ではなく determinization した局面（determinize.ts）で試すため、
// 相手の手札・山札の中身や、ドロー・ランダム対象の結果を事前に知ることはない。

import {
  applyAction,
  tryApplyAction,
  cardOf,
  legalActions,
  type Action,
  type GameState,
  type PlayerIndex,
  type Rng,
} from "../engine";
import { determinize } from "./determinize";
import { DEFAULT_WEIGHTS, evaluateWith, type EvalWeights } from "./evaluate";
import { weightsFor } from "./weights";
import type { Agent } from "./types";

export { evaluate } from "./evaluate";

/** 選択待ちを含め、手を適用した後の最善の評価値（選択待ちは再帰的に最善の選択をする） */
function valueAfter(state: GameState, action: Action, p: PlayerIndex, w: EvalWeights, depth = 0): number {
  let next: GameState | null;
  try {
    next = tryApplyAction(state, action);
  } catch {
    return -Infinity;
  }
  if (!next) return -Infinity;
  if (next.pending && next.pending.player === p && depth < 3) {
    return Math.max(...legalActions(next).map((a) => valueAfter(next, a, p, w, depth + 1)));
  }
  return evaluateWith(next, p, w);
}

/** エクストラPPは、使った後に打てる最善手の価値で評価する（使うだけでは盤面は良くならないため） */
function valueAfterExtraPp(state: GameState, p: PlayerIndex, w: EvalWeights): number {
  const next = applyAction(state, { type: "extraPp" });
  const values = legalActions(next)
    .filter((a) => a.type !== "endTurn" && a.type !== "extraPp")
    .map((a) => valueAfter(next, a, p, w));
  return values.length > 0 ? Math.max(...values) : -Infinity;
}

function bestAction(state: GameState, legal: readonly Action[], p: PlayerIndex, w: EvalWeights): Action {
  let best: Action | undefined;
  let bestValue = -Infinity;
  for (const a of legal) {
    if (a.type === "endTurn") continue;
    const value = a.type === "extraPp" ? valueAfterExtraPp(state, p, w) : valueAfter(state, a, p, w);
    if (value > bestValue) {
      bestValue = value;
      best = a;
    }
  }
  const end = legal.find((a) => a.type === "endTurn");
  if (end && (best === undefined || bestValue <= evaluateWith(state, p, w) + 0.01)) return end;
  return best ?? (legal[0] as Action);
}

function mulligan(state: GameState, legal: readonly Action[], p: PlayerIndex): Action {
  // コスト4以上のカードを入れ替える
  const swap = state.players[p].hand.filter((h) => cardOf(h.cardId).cost >= 4).map((h) => h.iid);
  return (
    legal.find((a) => a.type === "mulligan" && JSON.stringify([...a.swap].sort()) === JSON.stringify([...swap].sort())) ??
    (legal[0] as Action)
  );
}

/**
 * 貪欲法の AI を作る。omniscient は比較実験用（見えない情報を使う。対戦には使わない）
 */
export function createGreedyAgent(opts: { omniscient?: boolean; weights?: EvalWeights | "byClass" } = {}): Agent {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  return {
    name: opts.omniscient ? "greedy-omniscient" : "greedy",
    chooseAction: (real, legal, rng) => {
      const p = real.pending ? real.pending.player : real.active;
      const w = weights === "byClass" ? weightsFor(real, p) : weights;
      return chooseGreedy(real, legal, rng, opts.omniscient ?? false, w);
    },
  };
}

/** 基準の重みの貪欲法 AI（自己対戦での重みの調整や、探索 AI が相手の手番を予想するときの基準） */
export const greedyAgent: Agent = createGreedyAgent();

/**
 * クラスごとに調整した重み（data/ai-weights.json）を使う貪欲法 AI（対戦相手の「ふつう」）。
 * 調整は貪欲法の自己対戦で行っているので、効果を確かめられているのはこの AI
 */
export const tunedGreedyAgent: Agent = createGreedyAgent({ weights: "byClass" });

function chooseGreedy(real: GameState, legal: readonly Action[], rng: Rng, omniscient: boolean, w: EvalWeights): Action {
    const first = legal[0];
    if (!first) throw new Error("合法手がありません");
    if (first.type === "mulligan") return mulligan(real, legal, first.player);
    const p = real.pending ? real.pending.player : real.active;
    const state = omniscient ? real : determinize(real, p, rng);
    if (first.type === "choose" || first.type === "mode") {
      let best: Action = first;
      let bestValue = -Infinity;
      for (const a of legal) {
        const value = valueAfter(state, a, p, w);
        if (value > bestValue) {
          bestValue = value;
          best = a;
        }
      }
      return best;
    }
    return bestAction(state, legal, p, w);
}
