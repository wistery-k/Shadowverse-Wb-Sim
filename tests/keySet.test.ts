import { describe, expect, it } from "vitest";
import { jsonEqual, KeySet, stateHash, type HashScope } from "../src/ai/keySet";
import { randomAgent } from "../src/ai/random";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, rngFrom, type GameState } from "../src/engine";

describe("jsonEqual", () => {
  it("JSON にしたときに同じかどうかを判定する", () => {
    const cases: [unknown, unknown, boolean][] = [
      [1, 1, true],
      [0, -0, true],
      [NaN, null, true],
      [Infinity, null, true],
      ["a", "a", true],
      ["1", 1, false],
      [null, undefined, true], // 配列の要素としては同じ
      [[1, undefined], [1, null], true],
      [{ a: 1, b: undefined }, { a: 1 }, true],
      [{ a: null }, {}, false],
      [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, true],
      [{ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }, false],
      [[1, 2], [1, 2, 3], false],
      [[], {}, false],
      [{ a: 1 }, { b: 1 }, false],
    ];
    for (const [a, b, expected] of cases) {
      expect(jsonEqual(a, b), JSON.stringify([a, b])).toBe(expected);
      expect(jsonEqual(b, a), JSON.stringify([b, a])).toBe(expected);
    }
  });
});

/** 局面の一部だけを取り出したキー（lethal.ts・rhinoLethal.ts と同じ形） */
const projections: { scope: HashScope; key: (s: GameState) => unknown }[] = [
  { scope: {}, key: (s) => s },
  {
    scope: { graveyard: false },
    key: (s) => [
      s.players.map((pl) => [pl.leaderHp, pl.pp, pl.combo, pl.ep, pl.sep, pl.extraPpAvailable, pl.hand, pl.board, pl.crests, pl.deck.length]),
      s.pending,
      s.stack,
    ],
  },
  {
    scope: { leaderHp: false, graveyard: false },
    key: (s) => [s.players.map((pl) => [pl.pp, pl.combo, pl.ep, pl.sep, pl.extraPpAvailable, pl.hand, pl.board, pl.crests]), s.pending, s.stack],
  },
];

describe("KeySet", () => {
  it("JSON 文字列の Set と同じものをまとめ、JSON が同じ局面は同じハッシュになる", () => {
    const rng = rngFrom({ rng: 5 });
    let merged = 0;
    for (let g = 0; g < 12; g++) {
      const decks: [readonly string[], readonly string[]] = [
        DEFAULT_DECKS[g % DEFAULT_DECKS.length]!.cards,
        DEFAULT_DECKS[(g + 3) % DEFAULT_DECKS.length]!.cards,
      ];
      let s = createGame({ decks, seed: g + 1 });
      while (s.phase !== "ended") {
        // この局面から 2 手進めた局面（手の順番が違うだけの同じ局面を含む）
        const states: GameState[] = [];
        for (const a of legalActions(s)) {
          const t = applyAction(s, a);
          if (t.phase === "ended") continue;
          for (const b of legalActions(t)) states.push(applyAction(t, b));
        }
        for (const { scope, key } of projections) {
          const strings = new Set<string>();
          const keys = new KeySet();
          const hashes = new Map<string, number>();
          for (const t of states) {
            const k = key(t);
            const json = JSON.stringify(k);
            const h = stateHash(t, scope);
            if (hashes.has(json)) expect(hashes.get(json)).toBe(h);
            hashes.set(json, h);
            const isNew = !strings.has(json);
            strings.add(json);
            expect(keys.add(k, h)).toBe(isNew);
            if (!isNew) merged++;
          }
        }
        s = applyAction(s, randomAgent.chooseAction(s, legalActions(s), rng));
      }
    }
    // 同じ局面をまとめる場面を実際に試していること
    expect(merged).toBeGreaterThan(100);
  }, 60_000);
});
