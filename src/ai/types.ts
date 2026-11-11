import type { Action, GameState } from "../engine";
import type { Rng } from "../engine";

/**
 * AI の共通インターフェース。人間・ルールベース・MCTS を同じ対戦ループで差し替える。
 * TODO: 非公開情報を除いた観測（Observation）を渡すようにする。現状は GameState をそのまま渡す。
 */
export interface Agent {
  readonly name: string;
  chooseAction(state: GameState, legal: readonly Action[], rng: Rng): Action;
  /**
   * 試合の中で、思考用の乱数を 1 試合に 1 本、順に使う古い取り方にするか（物差しの相手。src/sim/match.ts の playFrom。
   * rust/engine/src/ai/mod.rs の Agent::sequential_rng）。無ければ判断ごとに作った乱数を使う
   */
  readonly sequentialRng?: boolean;
}
