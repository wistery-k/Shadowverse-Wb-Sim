import { describe, expect, it } from "vitest";
import { greedyAgent } from "../src/ai/greedy";
import { randomAgent } from "../src/ai/random";
import { rngFrom } from "../src/engine";
import { randomDeck } from "../src/sim/decks";
import { playMatch } from "../src/sim/match";

const CLASSES = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"] as const;

describe("AI", () => {
  it("貪欲法の AI はランダムの AI に大きく勝ち越す", () => {
    let wins = 0;
    const games = 20;
    for (let seed = 1; seed <= games; seed++) {
      const rng = rngFrom({ rng: seed });
      const decks: [string[], string[]] = [randomDeck(CLASSES[seed % 7]!, rng), randomDeck(CLASSES[(seed + 3) % 7]!, rng)];
      const result = playMatch([greedyAgent, randomAgent], { decks, seed, checkInvariants: true });
      if (result.winner === 0) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(16);
  });
});
