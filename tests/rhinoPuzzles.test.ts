import { beforeEach, describe, expect, it } from "vitest";
import { resetExactLethalCache } from "../src/ai/exactLethal";
import { rhinoDamageBound, searchLethalForRhinoTurn } from "../src/ai/rhino";
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
  // 問題はどれも同じターン番号なので、ターンごとのメモと局面数の上限を問題ごとに戻す
  beforeEach(() => resetExactLethalCache());

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

  it("ダメージの上限の式（ユーザーの式）: 1〜3 問目は正解以上、4 問目はリノセウス 3 回なので式の外", () => {
    const bounds = PUZZLES.map((pz) => rhinoDamageBound(puzzleState(pz, pz.expected), 0));
    expect(bounds).toEqual([10, 17, 17, 17]);
  });
});
