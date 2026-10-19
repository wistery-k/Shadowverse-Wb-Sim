// 「AI の考え」を UI のスレッドから外すための Web Worker（src/ai/think.ts）

import { initEngine, type GameState } from "../engine";
import { think, type Thought } from "./think";

export interface ThinkRequest {
  agent: string;
  state: GameState;
  rng: number;
}

export type ThinkResponse = { type: "thought"; thought: Thought | null } | { type: "error"; message: string };

self.onmessage = async (e: MessageEvent<ThinkRequest>) => {
  const { agent, state, rng } = e.data;
  let response: ThinkResponse;
  try {
    await initEngine();
    response = { type: "thought", thought: think(agent, state, rng) };
  } catch (err) {
    response = { type: "error", message: String(err) };
  }
  self.postMessage(response);
};
