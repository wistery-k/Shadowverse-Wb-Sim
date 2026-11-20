// 打ち比べの Web Worker。受け取った 1 つの仕事（試合の番号と手の列）を 1 試合打って結果を返す。
// 仕事は src/sim/pool.ts の runPool が 1 つずつ配る（終わったら次をもらう）。

import { initEngine, type Action, type GameState, type PlayerIndex } from "../engine";
import { branchLine, branchSeed, type Played } from "./branch";

export interface BranchRequest {
  state: GameState;
  /** 比べる手の列（0 番目が基準。手が 1 つの列は、前からの 1 手の打ち比べと同じ試合になる） */
  lines: Action[][];
  /** プレイヤー0・1の AI（src/ai/registry.ts のキー） */
  agents: [string, string];
  /** 勝ちを数えるプレイヤー（この局面の手番のプレイヤー） */
  viewer: PlayerIndex;
  seedBase: number;
  /** 打つ試合の番号（シードを決める） */
  game: number;
  /** 打つ手の列の添字（lines の何番目か） */
  line: number;
}

export type BranchResponse =
  | { type: "outcome"; game: number; line: number; played: Played }
  | { type: "error"; message: string }
  | { type: "done" };

self.onmessage = async (e: MessageEvent<BranchRequest>) => {
  const { state, lines, agents, viewer, seedBase, game, line } = e.data;
  try {
    await initEngine();
    const l = lines[line];
    let played: Played = { outcome: null, followed: 0, turn: [] };
    if (l !== undefined && l.length > 0) {
      try {
        const r = branchLine(state, l, agents, branchSeed(seedBase, game));
        if (r) played = { outcome: r.winner !== null ? r.winner === viewer : null, followed: r.followed, turn: r.turn };
      } catch {
        // 打てなかった試合として数える
      }
    }
    const response: BranchResponse = { type: "outcome", game, line, played };
    self.postMessage(response);
  } catch (err) {
    const response: BranchResponse = { type: "error", message: String(err) };
    self.postMessage(response);
  }
  const done: BranchResponse = { type: "done" };
  self.postMessage(done);
};
