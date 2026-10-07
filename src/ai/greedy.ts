// 貪欲法の AI: 各合法手を適用した後の盤面を評価し、最も良いものを選ぶ。
// 改善する手が無ければターンを終了する。
// 注意: 現状は GameState をそのまま使って手を試すため、乱数の結果（ドロー・ランダム対象）を
// 事前に知ってしまう。MCTS では未観測部分を determinization で扱う予定（CLAUDE.md）。

import {
  applyAction,
  cardOf,
  legalActions,
  type Action,
  type FollowerOnBoard,
  type GameState,
  type OnBoard,
  type PlayerIndex,
} from "../engine";
import type { Agent } from "./types";

const KEYWORD_VALUE: Partial<Record<string, number>> = {
  ward: 1,
  bane: 2,
  barrier: 1,
  drain: 1,
  ambush: 1,
  intimidate: 1,
  aura: 0.5,
};

function followerValue(f: FollowerOnBoard): number {
  let v = f.attack + f.tempAttack * 0.3 + f.defense * 0.8 + 1;
  for (const k of [...f.keywords, ...f.tempKeywords]) v += KEYWORD_VALUE[k] ?? 0;
  return v;
}

function boardValue(c: OnBoard): number {
  if (c.kind === "follower") return followerValue(c);
  return 1.5 + (c.sigils ?? 0) * 0.5;
}

/** プレイヤー p から見た盤面の評価値 */
export function evaluate(state: GameState, p: PlayerIndex): number {
  if (state.phase === "ended") return state.winner === p ? 1e6 : -1e6;
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  let v = 0;
  v += me.leaderHp * 0.7 - opp.leaderHp * 1.0;
  v += me.board.reduce((s, c) => s + boardValue(c), 0);
  v -= opp.board.reduce((s, c) => s + boardValue(c), 0) * 1.1;
  v += me.hand.length * 0.6 - opp.hand.length * 0.3;
  v += me.ep * 1.5 + me.sep * 2.5;
  if (me.extraPpAvailable) v += 1;
  v += me.crests.length * 1.5 - opp.crests.length * 1.5;
  v += Math.min(me.graveyard, 10) * 0.05;
  // 相手リーダーの体力が少ないほど、こちらの盤面の攻撃力を重く見る
  if (opp.leaderHp <= 10) {
    v += me.board.reduce((s, c) => s + (c.kind === "follower" ? c.attack * 0.3 : 0), 0);
  }
  return v;
}

/** 選択待ちを含め、手を適用した後の最善の評価値（選択待ちは再帰的に最善の選択をする） */
function valueAfter(state: GameState, action: Action, p: PlayerIndex, depth = 0): number {
  let next: GameState;
  try {
    next = applyAction(state, action);
  } catch {
    return -Infinity;
  }
  if (next.pending && next.pending.player === p && depth < 3) {
    return Math.max(...legalActions(next).map((a) => valueAfter(next, a, p, depth + 1)));
  }
  return evaluate(next, p);
}

/** エクストラPPは、使った後に打てる最善手の価値で評価する（使うだけでは盤面は良くならないため） */
function valueAfterExtraPp(state: GameState, p: PlayerIndex): number {
  const next = applyAction(state, { type: "extraPp" });
  const values = legalActions(next)
    .filter((a) => a.type !== "endTurn" && a.type !== "extraPp")
    .map((a) => valueAfter(next, a, p));
  return values.length > 0 ? Math.max(...values) : -Infinity;
}

function bestAction(state: GameState, legal: readonly Action[], p: PlayerIndex): Action {
  let best: Action | undefined;
  let bestValue = -Infinity;
  for (const a of legal) {
    if (a.type === "endTurn") continue;
    const value = a.type === "extraPp" ? valueAfterExtraPp(state, p) : valueAfter(state, a, p);
    if (value > bestValue) {
      bestValue = value;
      best = a;
    }
  }
  const end = legal.find((a) => a.type === "endTurn");
  if (end && (best === undefined || bestValue <= evaluate(state, p) + 0.01)) return end;
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

export const greedyAgent: Agent = {
  name: "greedy",
  chooseAction(state, legal) {
    const first = legal[0];
    if (!first) throw new Error("合法手がありません");
    if (first.type === "mulligan") return mulligan(state, legal, first.player);
    const p = state.pending ? state.pending.player : state.active;
    if (first.type === "choose" || first.type === "mode") {
      let best: Action = first;
      let bestValue = -Infinity;
      for (const a of legal) {
        const value = valueAfter(state, a, p);
        if (value > bestValue) {
          bestValue = value;
          best = a;
        }
      }
      return best;
    }
    return bestAction(state, legal, p);
  },
};
