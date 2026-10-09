import { describe, expect, it } from "vitest";
import { searchLethalForRhinoTurn } from "../src/ai/rhino";
import { searchRhinoLethal } from "../src/ai/rhinoLethal";
import { applyAction, type Action, type GameState } from "../src/engine";
import { PUZZLES, puzzleState } from "./rhinoPuzzles";

function wins(s: GameState, seq: Action[] | null): boolean {
  if (!seq) return false;
  for (const a of seq) s = applyAction(s, a);
  return s.winner === 0;
}

/** 全探索（このエンジンのルールで、ターン終了以外のすべての手を試す）では 4 問とも expected 点ちょうどが最大だった */

describe("リノセウスのリーサル問題集", () => {
  for (const pz of PUZZLES) {
    it(pz.name, () => {
      const s = puzzleState(pz, pz.expected);
      expect(wins(s, searchLethalForRhinoTurn(s, 0))).toBe(true);
    });

    it(`${pz.name}: 相手の体力が 1 多ければ見つからない`, () => {
      expect(searchLethalForRhinoTurn(puzzleState(pz, pz.expected + 1), 0)).toBeNull();
    });
  }

  it("リノセウス2・3 は準備のビーム幅を広げれば見つかる（既定の 16 では切られる）", () => {
    for (const [name, beamWidth] of [["リノセウス2（鞄リノリノ）", 128], ["リノセウス3（あて先無し）", 64]] as const) {
      const pz = PUZZLES.find((p) => p.name === name)!;
      const s = puzzleState(pz, pz.expected);
      expect(wins(s, searchRhinoLethal(s, 0, { beamWidth, maxDepth: 10 }))).toBe(true);
    }
  });
});
