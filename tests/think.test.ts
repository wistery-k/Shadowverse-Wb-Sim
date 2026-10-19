import { describe, expect, it } from "vitest";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { agentOf } from "../src/ai/registry";
import { think } from "../src/ai/think";
import { legalActions, rngFrom, tryApplyAction } from "../src/engine";
import { playMatch } from "../src/sim/match";
import { replayStates } from "../src/sim/replay";

describe("AI の考え", () => {
  const decks: [string[], string[]] = [[...DEFAULT_DECKS[0]!.cards], [...DEFAULT_DECKS[1]!.cards]];
  const r = playMatch([agentOf("random"), agentOf("random")], { decks, seed: 4, record: true });
  const states = replayStates(decks, 4, r.log!);
  // 手番のプレイヤーが打てる手が 2 つ以上ある、マリガンでない局面
  const steps = states.flatMap((s, i) => (s.phase === "main" && legalActions(s).length > 1 ? [i] : [])).filter((_, k) => k % 7 === 3);

  it("探索 AI が選ぶ手と同じ手を選び、比べた手の並びは決定化した局面から打てる", () => {
    expect(steps.length).toBeGreaterThan(2);
    for (const i of steps.slice(0, 3)) {
      const state = states[i]!;
      const t = think("search", state, 77);
      expect(t).not.toBeNull();
      const chosen = agentOf("search").chooseAction(state, legalActions(state), rngFrom({ rng: 77 }));
      expect(t!.chosen).toEqual(chosen);
      expect(t!.roots.length).toBe(1);
      const read = t!.candidates.filter((c) => c.read);
      expect(read.length).toBeGreaterThan(0);
      expect(read.length).toBeLessThanOrEqual(4);
      for (const c of t!.candidates) {
        let cur = t!.roots[c.sample]!;
        expect(c.steps[0]).toEqual(c.action);
        for (const a of c.steps) {
          const next = tryApplyAction(cur, a);
          expect(next).not.toBeNull();
          cur = next!;
        }
      }
    }
  });

  it("マリガンと、考えを示せない AI は null", () => {
    expect(think("search", states[0]!, 1)).toBeNull();
    expect(think("random", states[steps[0]!]!, 1)).toBeNull();
  });
});
