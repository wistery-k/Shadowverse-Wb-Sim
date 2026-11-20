import { describe, expect, it } from "vitest";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { agentOf } from "../src/ai/registry";
import { legalActions } from "../src/engine";
import { applyAction, actingPlayer } from "../src/engine";
import { branchLine, branchPlayout, branchSeed, branchStats, diffStats, quickCounts, quickEnd, tallyTurns } from "../src/sim/branch";
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

  it("手が 1 つの手の列は、前からの 1 手の打ち比べと同じ試合になる", () => {
    for (const a of legalActions(state)) {
      for (const seed of [5, branchSeed(3, 1)]) {
        const old = branchPlayout(state, a, ["random", "random"], seed);
        const line = branchLine(state, [a], ["random", "random"], seed);
        expect(line).not.toBeNull();
        expect({ winner: line!.winner, turns: line!.turns }).toEqual(old);
        expect(line!.followed).toBe(1);
        expect(line!.turn.length).toBeGreaterThan(0);
      }
    }
  });

  it("手の列を最後まで打ち、始めのターンに打った手を返す", () => {
    // 手番が続く手の後にターンを終える手の列
    const p = actingPlayer(state);
    const first = legalActions(state).find((a) => a.type !== "endTurn" && actingPlayer(applyAction(state, a)) === p && !applyAction(state, a).pending);
    if (!first) return;
    for (let i = 0; i < 4; i++) {
      const r = branchLine(state, [first, { type: "endTurn" }], ["random", "random"], branchSeed(2, i));
      expect(r).not.toBeNull();
      expect(r!.followed).toBe(2);
      expect(r!.turn[r!.turn.length - 1]).toBe("ターン終了");
      expect(branchLine(state, [first, { type: "endTurn" }], ["random", "random"], branchSeed(2, i))).toEqual(r);
    }
  });

  it("始めのターンの手順を、同じ手順の試合でまとめる", () => {
    const t = tallyTurns([
      { outcome: true, followed: 2, turn: ["A", "B"], quick: null },
      { outcome: false, followed: 2, turn: ["A", "B"], quick: null },
      { outcome: true, followed: 1, turn: ["A", "C"], quick: null },
      { outcome: null, followed: 0, turn: [], quick: null },
      undefined,
    ]);
    expect(t).toEqual([
      { text: "A → B", games: 2, wins: 1, decided: 2 },
      { text: "A → C", games: 1, wins: 1, decided: 1 },
    ]);
  });

  it("すぐ負けた（次のターンが来る前に負けた）・次勝った（次のターンまでに勝った）を数える", () => {
    // ふつうは手番のプレイヤー（0）のターン 15 の局面: 相手のターン 16 までの負けと、自分のターン 17 までの勝ち
    const own = { turn: 15, active: 0 as const };
    expect(quickEnd(own, 0, 1, 16)).toBe("lost");
    expect(quickEnd(own, 0, 1, 15)).toBe("lost");
    expect(quickEnd(own, 0, 1, 17)).toBeNull();
    expect(quickEnd(own, 0, 0, 15)).toBe("won");
    expect(quickEnd(own, 0, 0, 17)).toBe("won");
    expect(quickEnd(own, 0, 0, 19)).toBeNull();
    expect(quickEnd(own, 0, null, 16)).toBeNull();
    // 相手のターンの局面で選ぶとき: 自分の次のターンは 1 つ先
    const theirs = { turn: 16, active: 1 as const };
    expect(quickEnd(theirs, 0, 1, 16)).toBe("lost");
    expect(quickEnd(theirs, 0, 0, 17)).toBe("won");
    expect(quickEnd(theirs, 0, 1, 18)).toBeNull();
    expect(
      quickCounts([
        { outcome: false, followed: 1, turn: [], quick: "lost" },
        { outcome: true, followed: 1, turn: [], quick: "won" },
        { outcome: true, followed: 1, turn: [], quick: null },
        { outcome: null, followed: 0, turn: [], quick: null },
        undefined,
      ]),
    ).toEqual({ lost: 1, won: 1, decided: 3 });
  });

  it("試合の turns は決着したターン（最後の手で勝った試合は、その局面のターン）", () => {
    const last = r.log!.length - 1;
    const before = states[last]!;
    const x = branchLine(before, [r.log![last]!], ["random", "random"], 3)!;
    expect(x.winner).toBe(r.winner);
    expect(x.turns).toBe(states[last + 1]!.turn);
    expect(quickEnd(before, actingPlayer(before), x.winner, x.turns)).toBe(x.winner === actingPlayer(before) ? "won" : "lost");
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
