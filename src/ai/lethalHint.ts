// 対戦画面の「リーサル」表示と「リーサルを取る」ボタン用: 人間のプレイヤーから見て、このターンに確実に勝てる手順を探す。
// AI と同じく実際の局面は先読みせず、determinization（src/ai/determinize.ts）で探して別のサンプルでも勝てるかを確かめる。
// 探索はリノセウス用 AI と同じ（汎用のビームサーチ → リノセウス専用 → 全探索。リノセウスが無いデッキでは汎用のものだけ）。

import { rngFrom, type Action, type GameState, type PlayerIndex } from "../engine";
import { DEFAULT_LETHAL_OPTIONS, findLethalLine } from "./lethal";
import { searchLethalForRhinoTurn } from "./rhino";

export function lethalHint(real: GameState, p: PlayerIndex, seed: number): Action[] | null {
  if (real.phase !== "main" || real.active !== p) return null;
  return findLethalLine(real, p, rngFrom({ rng: seed }), DEFAULT_LETHAL_OPTIONS.samples, searchLethalForRhinoTurn)?.steps ?? null;
}
