import { describe, expect, it } from "vitest";
import { searchLethalForRhino } from "../src/ai/rhino";
import { searchRhinoLethal } from "../src/ai/rhinoLethal";
import { applyAction, type Action, type GameState } from "../src/engine";
import { PUZZLES, puzzleState } from "./rhinoPuzzles";

function wins(s: GameState, seq: Action[] | null): boolean {
  if (!seq) return false;
  for (const a of seq) s = applyAction(s, a);
  return s.winner === 0;
}

/**
 * 全探索（このエンジンのルールで、ターン終了以外のすべての手を試す）では 4 問とも expected 点ちょうどが最大だった。
 * 現在のリーサル探索で見つからない問題は it.fails にしておき、見つかるようになったら普通の it に戻す（docs/ai-notes.md）
 */
const KNOWN_MISSES = new Set(["リノセウス2（鞄リノリノ）", "リノセウス3（あて先無し）", "リノセウス4（リノリノリノ）"]);

describe("リノセウスのリーサル問題集（相手の体力 = expected）", () => {
  for (const pz of PUZZLES) {
    const test = KNOWN_MISSES.has(pz.name) ? it.fails : it;
    test(pz.name, () => {
      const s = puzzleState(pz, pz.expected);
      expect(wins(s, searchLethalForRhino(s, 0))).toBe(true);
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
