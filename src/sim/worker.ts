// 自動対戦の Web Worker。受け取った試合を順に実行し、1試合ごとに結果を返す。

import { runGame, type Entrant, type GameRecord, type GameSpec } from "./tournament";

export interface WorkerRequest {
  entrants: Entrant[];
  specs: GameSpec[];
}

export type WorkerResponse = { type: "record"; record: GameRecord } | { type: "done" };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { entrants, specs } = e.data;
  for (const spec of specs) {
    const response: WorkerResponse = { type: "record", record: runGame(spec, entrants) };
    self.postMessage(response);
  }
  const done: WorkerResponse = { type: "done" };
  self.postMessage(done);
};
