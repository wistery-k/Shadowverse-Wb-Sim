import { describe, expect, it } from "vitest";
import { randomAgent } from "../src/ai/random";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, cloneState, createGame, legalActions, rngFrom } from "../src/engine";
import { randomDeck } from "../src/sim/decks";

const CLASSES = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"] as const;

describe("cloneState", () => {
  it("structuredClone と同じ内容を作り、applyAction は元の状態を一切変更しない", () => {
    const rng = rngFrom({ rng: 11 });
    for (let g = 0; g < 80; g++) {
      const decks: [readonly string[], readonly string[]] =
        g % 2 === 0
          ? [DEFAULT_DECKS[g % DEFAULT_DECKS.length]!.cards, DEFAULT_DECKS[(g + 2) % DEFAULT_DECKS.length]!.cards]
          : [randomDeck(CLASSES[g % 7]!, rng), randomDeck(CLASSES[(g + 4) % 7]!, rng)];
      let s = createGame({ decks, seed: g + 1 });
      while (s.phase !== "ended") {
        const before = JSON.stringify(s);
        expect(cloneState(s)).toEqual(structuredClone(s));
        const next = applyAction(s, randomAgent.chooseAction(s, legalActions(s), rng));
        // 元の状態が書き換わっていれば、複製の漏れ（共有された可変オブジェクト）がある
        if (JSON.stringify(s) !== before) throw new Error(`applyAction が元の状態を変更した (game ${g}, turn ${s.turn}, actor ${actingPlayer(s)})`);
        s = next;
      }
    }
  }, 30_000);
});
