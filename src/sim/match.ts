// 2つの Agent を対戦させる

import type { Agent } from "../ai/types";
import {
  actingPlayer,
  applyAction,
  createGame,
  invariantViolations,
  legalActions,
  rngFrom,
  type GameState,
  type PlayerIndex,
} from "../engine";

export interface MatchResult {
  winner: PlayerIndex;
  turns: number;
  actions: number;
  final: GameState;
}

export interface MatchOptions {
  decks: [readonly string[], readonly string[]];
  seed: number;
  /** 各アクションの後に不変条件を検査する（遅い） */
  checkInvariants?: boolean;
  /** 無限ループ検出用の上限 */
  maxActions?: number;
}

export function playMatch(agents: [Agent, Agent], opts: MatchOptions): MatchResult {
  let state = createGame({ decks: opts.decks, seed: opts.seed });
  const agentRng = rngFrom({ rng: (opts.seed ^ 0x9e3779b9) >>> 0 });
  const maxActions = opts.maxActions ?? 10000;
  let actions = 0;

  while (state.phase !== "ended") {
    if (++actions > maxActions) throw new Error(`アクション数が上限 ${maxActions} を超えました`);
    const legal = legalActions(state);
    const actor = actingPlayer(state);
    state = applyAction(state, agents[actor].chooseAction(state, legal, agentRng));
    if (opts.checkInvariants) {
      const v = invariantViolations(state);
      if (v.length > 0) throw new Error(`不変条件違反 (seed ${opts.seed}):\n${v.join("\n")}`);
    }
  }
  if (state.winner === null) throw new Error("勝者がいません");
  return { winner: state.winner, turns: state.turn, actions, final: state };
}
