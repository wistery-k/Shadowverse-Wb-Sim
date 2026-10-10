import { describe, expect, it } from "vitest";
import { randomAgent } from "../src/ai/random";
import { createGame } from "../src/engine";
import { buildHumanRecord, parseHumanRecord, toJsonLines } from "../src/sim/humanRecord";
import { playMatch } from "../src/sim/match";
import { rhinoMatch, rhinoOpponents, RHINO_ELF } from "../src/sim/rhinoCompare";

describe("リノセウス比較の人間の記録", () => {
  it("rhino-compare と同じシード・席でデッキを並べる", () => {
    const opp = rhinoOpponents();
    expect(opp).toHaveLength(6);
    expect(opp.map((d) => d.name)).not.toContain(RHINO_ELF);
    const m = rhinoMatch(opp[0]!.name, 3, 1);
    expect(m.seed).toBe(900000 + 3 * 13 + 1);
    expect(m.decks[0]).toEqual(opp[0]!.cards);
  });

  it("勝敗・ターンごとの選択・行動の列を記録し、JSON Lines から読み戻せる", () => {
    const deck = rhinoOpponents()[1]!.name;
    for (const elfSeat of [0, 1] as const) {
      const m = rhinoMatch(deck, 0, elfSeat);
      const r = playMatch([randomAgent, randomAgent], { ...m, record: true });
      const rec = buildHumanRecord({ deck, g: 0, elfSeat, actions: r.log!, commit: "abc", playedAt: "2026-01-01T00:00:00.000Z" });
      expect(rec.won).toBe(r.winner === elfSeat);
      expect(rec.first).toBe(createGame(m).first === elfSeat);
      expect(rec.turns).toBe(r.turns);
      expect(rec.turnLog.flatMap((t) => t.choices)).toHaveLength(r.log!.length);
      expect(rec.turnLog[0]!.turn).toBe(0);
      expect(rec.turnLog.some((t) => t.by === "you") && rec.turnLog.some((t) => t.by === "opponent")).toBe(true);
      const line = toJsonLines([rec]);
      expect(line.endsWith("\n")).toBe(true);
      expect(parseHumanRecord(JSON.parse(line))).toEqual(rec);
    }
  });

  it("終わっていない試合は記録しない", () => {
    expect(() => buildHumanRecord({ deck: rhinoOpponents()[0]!.name, g: 0, elfSeat: 0, actions: [], commit: "", playedAt: "" })).toThrow();
    expect(parseHumanRecord({ kind: "other" })).toBeNull();
  });
});
