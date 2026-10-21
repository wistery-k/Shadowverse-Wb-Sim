// 打ち比べの Web Worker。受け取った 1 つの仕事（試合の番号と手）を 1 試合打って結果を返す。
// 仕事は src/sim/pool.ts の runPool が 1 つずつ配る（終わったら次をもらう）。

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
  /** 打つ試合の番号（シードを決める） */
  game: number;
  /** 打つ手の添字（actions の何番目か） */
  action: number;
}

export type BranchResponse =
  | { type: "outcome"; game: number; action: number; outcome: Outcome }
  | { type: "error"; message: string }
  | { type: "done" };

self.onmessage = async (e: MessageEvent<BranchRequest>) => {
  const { state, actions, agents, viewer, seedBase, game, action } = e.data;
  try {
    await initEngine();
    const a = actions[action];
    let outcome: Outcome = null;
    if (a !== undefined) {
      try {
        const r = branchPlayout(state, a, agents, branchSeed(seedBase, game));
        outcome = r && r.winner !== null ? r.winner === viewer : null;
      } catch {
        outcome = null;
      }
    }
    const response: BranchResponse = { type: "outcome", game, action, outcome };
    self.postMessage(response);
  } catch (err) {
    const response: BranchResponse = { type: "error", message: String(err) };
    self.postMessage(response);
  }
  const done: BranchResponse = { type: "done" };
  self.postMessage(done);
};
