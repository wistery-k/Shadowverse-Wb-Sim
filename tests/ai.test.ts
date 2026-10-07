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

import { determinize } from "../src/ai/determinize";
import { searchAgent } from "../src/ai/search";
import { applyAction, createGame, legalActions, newHandCard } from "../src/engine";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";

describe("determinization", () => {
  it("自分の手札と場はそのまま、相手の手札と山札は未公開カードの並べ直し、トークンは残す", () => {
    let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 3 });
    s = applyAction(s, legalActions(s)[0]!);
    s = applyAction(s, legalActions(s)[0]!);
    const viewer = s.active;
    const opp = viewer === 0 ? 1 : 0;
    const fairy = ALL_CARDS.find((c) => c.name === "フェアリー")!.id;
    s.players[opp].hand.push(newHandCard(s, fairy));
    const hidden = (st: typeof s) =>
      [...st.players[opp].hand.filter((h) => h.cardId !== fairy), ...st.players[opp].deck].map((c) => c.cardId).sort();

    const rng = rngFrom({ rng: 1 });
    const d = determinize(s, viewer, rng);
    expect(d.players[viewer].hand).toEqual(s.players[viewer].hand);
    expect(d.players[viewer].board).toEqual(s.players[viewer].board);
    expect(d.players[viewer].deck.map((c) => c.cardId).sort()).toEqual(s.players[viewer].deck.map((c) => c.cardId).sort());
    expect(d.players[opp].hand.map((h) => h.iid)).toEqual(s.players[opp].hand.map((h) => h.iid));
    expect(d.players[opp].hand.at(-1)?.cardId).toBe(fairy);
    expect(hidden(d)).toEqual(hidden(s));
    expect(d.rng).not.toBe(s.rng);
    // 元の局面は変更しない
    expect(determinize(s, viewer, rngFrom({ rng: 1 }))).toEqual(d);
  });
});

describe("探索 AI", () => {
  it("不変条件を破らずに対戦を終え、貪欲法 AI に勝ち越す", () => {
    let wins = 0;
    for (let g = 0; g < 8; g++) {
      const i = g % 7;
      const j = (g * 3 + 1) % 7;
      const searchSeat = g % 2;
      const decks: [string[], string[]] = [DEFAULT_DECKS[i]!.cards, DEFAULT_DECKS[j]!.cards];
      const r = playMatch(searchSeat === 0 ? [searchAgent, greedyAgent] : [greedyAgent, searchAgent], {
        decks,
        seed: 100 + g,
        checkInvariants: true,
      });
      if (r.winner === searchSeat) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

import { findLethal, searchLethal } from "../src/ai/lethal";

describe("リーサルの探索", () => {
  function rhinoceusPosition() {
    let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    s = applyAction(s, legalActions(s)[0]!);
    s = applyAction(s, legalActions(s)[0]!);
    const me = s.active;
    const opp = me === 0 ? 1 : 0;
    const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
    s.players[me].hand = [newHandCard(s, id("殺戮のリノセウス")), newHandCard(s, id("森の神秘")), newHandCard(s, id("森の神秘"))];
    s.players[me].pp = s.players[me].maxPp = 3;
    s.players[opp].leaderHp = 3;
    return { s, me, rhinoceus: s.players[me].hand[0]!.iid };
  }

  it("コンボを稼いでからリノセウスで倒す並びを見つける", () => {
    const { s, me, rhinoceus } = rhinoceusPosition();
    const seq = searchLethal(s, me);
    expect(seq).not.toBeNull();
    // リノセウスを先に出すと1点しか出ないので、最初の手は森の神秘
    expect(seq![0]).not.toEqual({ type: "play", iid: rhinoceus });
    let t = s;
    for (const a of seq!) t = applyAction(t, a);
    expect(t.winner).toBe(me);
  });

  it("勝てなければ null を返す", () => {
    const { s, me } = rhinoceusPosition();
    s.players[me === 0 ? 1 : 0].leaderHp = 4;
    expect(searchLethal(s, me)).toBeNull();
    expect(findLethal(s, me, rngFrom({ rng: 1 }))).toBeNull();
  });

  it("探索 AI はリーサルを取りこぼさない", () => {
    let { s, me } = rhinoceusPosition();
    while (s.phase !== "ended" && s.active === me) s = applyAction(s, searchAgent.chooseAction(s, legalActions(s), rngFrom({ rng: 2 })));
    expect(s.winner).toBe(me);
  });
});
