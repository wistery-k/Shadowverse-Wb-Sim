// AI の思考を UI のスレッドから外すための Web Worker

import { rngFrom, type Action, type GameState } from "../engine";
import { agentOf } from "./registry";

export interface AgentRequest {
  id: number;
  agent: string;
  state: GameState;
  legal: Action[];
  seed: number;
}

export interface AgentResponse {
  id: number;
  action?: Action;
  error?: string;
}

self.onmessage = (e: MessageEvent<AgentRequest>) => {
  const { id, agent, state, legal, seed } = e.data;
  let response: AgentResponse;
  try {
    response = { id, action: agentOf(agent).chooseAction(state, legal, rngFrom({ rng: seed })) };
  } catch (err) {
    response = { id, error: String(err) };
  }
  self.postMessage(response);
};
