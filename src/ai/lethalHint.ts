// 対戦画面の「リーサル」表示と「リーサルを取る」ボタン用: 人間のプレイヤーから見て、このターンに確実に勝てる手順を探す。
// 探索は Rust 版（rust/engine/src/ai/lethal_hint.rs）が WASM の中で行う。

import type { Action, GameState, PlayerIndex } from "../engine";
import { callEngine } from "../engine/wasm";

export function lethalHint(real: GameState, p: PlayerIndex, seed: number): Action[] | null {
  return callEngine({ f: "lethalHint", state: real, player: p, seed: seed >>> 0 }) as Action[] | null;
}

/** AI が覚えている探索のメモ（全探索のリーサル探索のメモ・実行中のリーサルの手順）を捨てる（結果を試合の順番によらないようにする） */
export function resetAiCaches(): void {
  callEngine({ f: "resetCaches" });
}
