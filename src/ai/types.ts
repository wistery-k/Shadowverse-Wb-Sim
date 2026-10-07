import type { Action, GameState } from "../engine";
import type { Rng } from "../engine";

/**
 * AI の共通インターフェース。人間・ルールベース・MCTS を同じ対戦ループで差し替える。
 * TODO: 非公開情報を除いた観測（Observation）を渡すようにする。現状は GameState をそのまま渡す。
 */
export interface Agent {
  readonly name: string;
  chooseAction(state: GameState, legal: readonly Action[], rng: Rng): Action;
}
