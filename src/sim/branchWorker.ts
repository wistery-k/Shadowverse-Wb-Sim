// 打ち比べの Web Worker。受け取った試合の番号ごとに、すべての手で 1 試合ずつ打って結果を返す。

import { initEngine, type Action, type GameState, type PlayerIndex } from "../engine";
import { branchPlayout, branchSeed, type Outcome } from "./branch";

export interface BranchRequest {
  state: GameState;
  /** 比べる手（0 番目が実戦の手） */
  actions: Action[];
  /** プレイヤー0・1の AI（src/ai/registry.ts のキー） */
  agents: [string, string];
  /** 勝ちを数えるプレイヤー（この局面の手番のプレイヤー） */
  viewer: PlayerIndex;
  seedBase: number;
  /** この Worker が打つ試合の番号 */
  games: number[];
}

export type BranchResponse =
  | { type: "game"; game: number; outcomes: Outcome[] }
  | { type: "error"; message: string }
  | { type: "done" };

self.onmessage = async (e: MessageEvent<BranchRequest>) => {
  const { state, actions, agents, viewer, seedBase, games } = e.data;
  try {
    await initEngine();
    for (const game of games) {
      const seed = branchSeed(seedBase, game);
      const outcomes = actions.map((a): Outcome => {
        try {
          const r = branchPlayout(state, a, agents, seed);
          return r && r.winner !== null ? r.winner === viewer : null;
        } catch {
          return null;
        }
      });
      const response: BranchResponse = { type: "game", game, outcomes };
      self.postMessage(response);
    }
  } catch (err) {
    const response: BranchResponse = { type: "error", message: String(err) };
    self.postMessage(response);
  }
  const done: BranchResponse = { type: "done" };
  self.postMessage(done);
};
