import { describe, expect, it } from "vitest";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { agentOf } from "../src/ai/registry";
import { legalActions } from "../src/engine";
import { branchPlayout, branchSeed, branchStats, diffStats } from "../src/sim/branch";
import { playMatch } from "../src/sim/match";
import { replayStates } from "../src/sim/replay";

describe("打ち比べ", () => {
  const decks: [string[], string[]] = [[...DEFAULT_DECKS[0]!.cards], [...DEFAULT_DECKS[1]!.cards]];
  const r = playMatch([agentOf("random"), agentOf("random")], { decks, seed: 9, record: true });
  const states = replayStates(decks, 9, r.log!);
  const step = Math.floor(states.length / 2);
  const state = states[step]!;

  it("途中の局面から、どの合法手でも最後まで打てて、同じシードなら同じ結果になる", () => {
    const legal = legalActions(state);
    for (const a of legal) {
      const x = branchPlayout(state, a, ["random", "random"], 5);
      expect(x).not.toBeNull();
      expect(x!.winner === 0 || x!.winner === 1).toBe(true);
      expect(branchPlayout(state, a, ["random", "random"], 5)).toEqual(x);
    }
    // 並べ直しが変われば結果も変わりうる（シードごとに別の試合）
    const seeds = Array.from({ length: 8 }, (_, i) => branchSeed(1, i));
    expect(new Set(seeds).size).toBe(8);
    const results = seeds.map((s) => JSON.stringify(branchPlayout(state, r.log![step]!, ["random", "random"], s)));
    expect(new Set(results).size).toBeGreaterThan(1);
  });

  it("打てない手は null", () => {
    expect(branchPlayout(state, { type: "attack", attacker: -12345, target: "leader" }, ["random", "random"], 1)).toBeNull();
  });

  it("勝率と、同じ試合どうしの差を集計する", () => {
    const s = branchStats([true, false, null, true]);
    expect(s).toMatchObject({ games: 3, wins: 2, skipped: 1 });
    expect(s.margin).toBeCloseTo(1.96 * Math.sqrt((2 / 3) * (1 / 3) / 3));
    const d = diffStats([true, false, false, null, undefined], [true, true, false, true, true]);
    // 比べられるのは 0〜2 番目: 差は 0, +1, 0
    expect(d.games).toBe(3);
    expect(d.diff).toBeCloseTo(1 / 3);
    expect(diffStats([], []).games).toBe(0);
  });
});
