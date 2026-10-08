import { describe, expect, it } from "vitest";
import { jsonEqual, KeySet, stateHash, turnOrderHash, turnOrderKey, type HashScope } from "../src/ai/keySet";
import { randomAgent } from "../src/ai/random";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { ALL_CARDS } from "../src/cards";
import { applyAction, createGame, legalActions, newHandCard, rngFrom, type GameState } from "../src/engine";

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

describe("turnOrderKey（手の順番だけが違う局面）", () => {
  const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
  const elf = DEFAULT_DECKS.find((d) => d.class === "elf")!;
  const royal = DEFAULT_DECKS.find((d) => d.class === "royal")!;

  function elfTurn(hand: string[]): GameState {
    let s = createGame({ decks: [elf.cards, royal.cards], seed: 1 });
    while (s.phase === "mulligan") s = applyAction(s, legalActions(s)[0]!);
    s.active = 0;
    const pl = s.players[0];
    pl.pp = pl.maxPp = 7;
    pl.hand = hand.map((n) => newHandCard(s, id(n)));
    return s;
  }
  /** 名前のカードをプレイする（末尾が "!" なら同名のうち最後に加わったもの） */
  const play = (s: GameState, name: string) => {
    const last = name.endsWith("!");
    const cards = s.players[s.active].hand.filter((c) => ALL_CARDS.find((x) => x.id === c.cardId)!.name === name.replace(/!$/, ""));
    return applyAction(s, { type: "play", iid: (last ? cards[cards.length - 1] : cards[0])!.iid });
  };

  it("効果で加わったカードの iid や場に出た順が違っても、同じ局面としてまとめる", () => {
    const root = elfTurn(["フェアリーテイマー", "燐光の岩", "フェアリー"]);
    // 前のターンのスペルでスペルブーストの回数だけが増えているフェアリー
    root.players[0].hand[2]!.boosts = 1;
    const a = ["フェアリーテイマー", "燐光の岩", "フェアリー"].reduce(play, root);
    const b = ["燐光の岩", "フェアリー!", "フェアリーテイマー"].reduce(play, root);
    expect(jsonEqual(a, b)).toBe(false);
    expect(jsonEqual(turnOrderKey(a), turnOrderKey(b))).toBe(true);
    expect(turnOrderHash(a)).toBe(turnOrderHash(b));
    // 中身が違う局面はまとめない（コンボ 3 で岩を出すと森の神秘が加わる）
    const c = ["フェアリーテイマー", "フェアリー", "燐光の岩"].reduce(play, root);
    expect(jsonEqual(turnOrderKey(a), turnOrderKey(c))).toBe(false);
  });

  it("キーが同じ局面は同じハッシュになる", () => {
    const rng = rngFrom({ rng: 7 });
    let merged = 0;
    for (let g = 0; g < 6; g++) {
      const decks: [readonly string[], readonly string[]] = [
        DEFAULT_DECKS[g % DEFAULT_DECKS.length]!.cards,
        DEFAULT_DECKS[(g + 2) % DEFAULT_DECKS.length]!.cards,
      ];
      let s = createGame({ decks, seed: g + 11 });
      while (s.phase !== "ended") {
        const states: GameState[] = [];
        for (const a of legalActions(s)) {
          const t = applyAction(s, a);
          if (t.phase === "ended") continue;
          for (const b of legalActions(t)) states.push(applyAction(t, b));
        }
        const hashes = new Map<string, number>();
        for (const t of states) {
          const json = JSON.stringify(turnOrderKey(t));
          const h = turnOrderHash(t);
          if (hashes.has(json)) {
            expect(hashes.get(json)).toBe(h);
            merged++;
          }
          hashes.set(json, h);
        }
        s = applyAction(s, randomAgent.chooseAction(s, legalActions(s), rng));
      }
    }
    expect(merged).toBeGreaterThan(100);
  }, 60_000);
});
