import { describe, expect, it } from "vitest";
import { greedyAgent } from "../src/ai/greedy";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { planGames, runGame, summarize, type Entrant, type GameRecord } from "../src/sim/tournament";
import { playMatch } from "../src/sim/match";

describe("総当たりの計画と集計", () => {
  it("組み合わせごとに指定数の試合を計画し、席を交互に入れ替える", () => {
    const specs = planGames(3, { gamesPerPair: 4, seed: 1 });
    expect(specs).toHaveLength(3 * 4);
    expect(specs.filter((s) => s.a === 0 && s.b === 1).map((s) => s.aIsPlayer0)).toEqual([true, false, true, false]);
    expect(new Set(specs.map((s) => s.seed)).size).toBe(specs.length);
    expect(planGames(3, { gamesPerPair: 2, seed: 1, mirror: true })).toHaveLength(6 * 2);
    expect(planGames(3, { gamesPerPair: 4, seed: 1 })).toEqual(specs); // 決定的
  });

  it("勝敗・先攻の勝率・エラーを集計する", () => {
    const records: GameRecord[] = [
      { a: 0, b: 1, seed: 1, winner: 0, first: 0, turns: 10 },
      { a: 0, b: 1, seed: 2, winner: 1, first: 0, turns: 20 },
      { a: 0, b: 2, seed: 3, winner: 0, first: 2, turns: 12 },
      { a: 1, b: 2, seed: 4, winner: null, first: null, turns: 0, error: "x" },
    ];
    const s = summarize(3, records);
    expect(s.totalGames).toBe(3);
    expect(s.wins[0]).toEqual([0, 1, 1]);
    expect(s.wins[1]).toEqual([1, 0, 0]);
    expect(s.games[0]).toEqual([0, 2, 1]);
    expect(s.entrants).toEqual([
      { games: 3, wins: 2 },
      { games: 2, wins: 1 },
      { games: 1, wins: 0 },
    ]);
    expect(s.firstPlayerWins).toBe(1);
    expect(s.averageTurns).toBe(14);
    expect(s.errors).toHaveLength(1);
  });

  it("runGame は勝者と先攻を参加者の添字で返す", () => {
    const entrants: Entrant[] = DEFAULT_DECKS.slice(0, 2).map((d) => ({ name: d.name, deck: d.cards, agent: "random" }));
    for (const spec of planGames(2, { gamesPerPair: 2, seed: 5 })) {
      const r = runGame(spec, entrants);
      expect(r.error).toBeUndefined();
      expect([0, 1]).toContain(r.winner);
      expect([0, 1]).toContain(r.first);
    }
  });
});

describe("デフォルトデッキ同士の自己対戦", () => {
  it("すべての組み合わせで貪欲法 AI 同士が不変条件を破らずに終わる", () => {
    const decks = DEFAULT_DECKS;
    let seed = 1;
    for (let i = 0; i < decks.length; i++) {
      for (let j = i; j < decks.length; j++) {
        playMatch([greedyAgent, greedyAgent], { decks: [decks[i]!.cards, decks[j]!.cards], seed: seed++, checkInvariants: true });
      }
    }
  });
});
