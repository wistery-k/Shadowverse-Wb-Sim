// リーサル探索（src/ai/lethalHint.ts）を UI のスレッドから外すための Web Worker（探索は WASM の中で行う）。
// 局面が変わったら UI 側でこの Worker を止めて作り直す（古い探索を途中で打ち切るため）。

import { initEngine, type Action, type GameState, type PlayerIndex } from "../engine";
import { lethalHint } from "./lethalHint";

export interface LethalRequest {
  id: number;
  state: GameState;
  player: PlayerIndex;
  seed: number;
}

export interface LethalResponse {
  id: number;
  steps: Action[] | null;
  error?: string;
}

self.onmessage = async (e: MessageEvent<LethalRequest>) => {
  const { id, state, player, seed } = e.data;
  let response: LethalResponse;
  try {
    await initEngine();
    response = { id, steps: lethalHint(state, player, seed) };
  } catch (err) {
    response = { id, steps: null, error: String(err) };
  }
  self.postMessage(response);
};
