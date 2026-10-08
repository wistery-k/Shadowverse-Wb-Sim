// 記録した試合の再生。エンジンは決定的なので、デッキ・シード・行動の列から各時点の局面を作り直せる。

import { applyAction, createGame, type Action, type GameState } from "../engine";

/** 各行動の前の局面と最後の局面（長さは actions.length + 1） */
export function replayStates(
  decks: readonly [readonly string[], readonly string[]],
  seed: number,
  actions: readonly Action[],
): GameState[] {
  const states = [createGame({ decks: [decks[0], decks[1]], seed })];
  for (const action of actions) states.push(applyAction(states[states.length - 1]!, action));
  return states;
}
