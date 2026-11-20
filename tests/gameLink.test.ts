// 試合の URL（src/sim/gameLink.ts。ユーザーの依頼 2026-11-20）

import { describe, expect, it } from "vitest";
import { AZVALDT_DECK_OPTIONS, AZVALDT_LINK_DECKS } from "../src/azvaldt/decks";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { gameHash, isGameHash, linkMatch, parseGameHash, recordLink, STARTER_LINK_DECKS, type GameLink } from "../src/sim/gameLink";
import { deckArg } from "../src/sim/reproduce";
import { planGames, runGame, type Entrant } from "../src/sim/tournament";

const AGENTS = { random: "ランダム", greedy: "貪欲法", search: "探索" };

describe("試合の URL", () => {
  it("seed・両者の AI・デッキを # に書いて読める（日本語のデッキの ID も）", () => {
    const link: GameLink = { seed: 4294967295, agents: ["search", "greedy"], decks: ["ps26-27-09a/CR_エルフ", "a*3,b&c=d"] };
    const hash = gameHash(link);
    expect(isGameHash(hash)).toBe(true);
    expect(hash).not.toMatch(/[ぁ-んァ-ン]/);
    expect(parseGameHash(hash)).toEqual(link);
  });

  it("読めない指定は null（seed の範囲外・欠け・別の #）", () => {
    expect(parseGameHash("#misses/foo")).toBeNull();
    expect(parseGameHash("#game?seed=4294967296&p0=a&d0=x&p1=b&d1=y")).toBeNull();
    expect(parseGameHash("#game?seed=-1&p0=a&d0=x&p1=b&d1=y")).toBeNull();
    expect(parseGameHash("#game?seed=1&p0=a&d0=x&p1=b")).toBeNull();
    expect(parseGameHash("#game?seed=1&p0=a&d0=x&p1=b&d1=y")).toEqual({ seed: 1, agents: ["a", "b"], decks: ["x", "y"] });
  });

  it("アズヴォルト環境のページは、プロのデッキの ID だけを書いて読む（カードの列は読まない）", () => {
    for (const o of AZVALDT_DECK_OPTIONS) {
      const key = AZVALDT_LINK_DECKS.encode(o.cards);
      expect(key).not.toBeNull();
      const d = AZVALDT_LINK_DECKS.decode(key!);
      expect(typeof d === "string" ? d : d.cards).toEqual(o.cards);
    }
    const o = AZVALDT_DECK_OPTIONS[0]!;
    expect(AZVALDT_LINK_DECKS.encode([...o.cards].reverse())).toBeNull();
    expect(typeof AZVALDT_LINK_DECKS.decode(deckArg(o.cards))).toBe("string");
    expect(typeof AZVALDT_LINK_DECKS.decode("no-such/deck")).toBe("string");
  });

  it("スターターのページは、デフォルトデッキのキーか、スターターで組めるカードの列を読む", () => {
    const d = DEFAULT_DECKS[0]!;
    expect(STARTER_LINK_DECKS.encode(d.cards)).toBe(d.key);
    expect(STARTER_LINK_DECKS.decode(d.key)).toEqual({ cards: d.cards, label: d.name });
    const reordered = [...d.cards].reverse();
    const arg = STARTER_LINK_DECKS.encode(reordered)!;
    const back = STARTER_LINK_DECKS.decode(arg);
    expect(typeof back === "string" ? back : back.cards).toEqual(reordered);
    // スターターに無いカード・組めないデッキ（枚数）は使えない
    expect(typeof STARTER_LINK_DECKS.decode(deckArg(AZVALDT_DECK_OPTIONS[0]!.cards))).toBe("string");
    expect(typeof STARTER_LINK_DECKS.decode(deckArg(d.cards.slice(1)))).toBe("string");
  });

  it("ページで選べない AI・デッキは理由を返す", () => {
    const d = DEFAULT_DECKS[0]!.key;
    expect(linkMatch({ seed: 1, agents: ["no-such-ai", "random"], decks: [d, d] }, STARTER_LINK_DECKS, AGENTS)).toMatch(/P1 の AI/);
    expect(linkMatch({ seed: 1, agents: ["random", "random"], decks: [d, "x*40"] }, STARTER_LINK_DECKS, AGENTS)).toMatch(/P2 のデッキ/);
  });

  it("総当たりの試合の URL から打ち直すと、同じ試合になる（後攻の席の参加者の試合も）", () => {
    const [d0, d1] = DEFAULT_DECKS;
    const entrants: Entrant[] = [
      { name: d0!.name, deck: d0!.cards, agent: "random" },
      { name: d1!.name, deck: d1!.cards, agent: "greedy" },
    ];
    for (const spec of planGames(2, { gamesPerPair: 2, seed: 7 })) {
      const original = runGame(spec, entrants, { record: true });
      const link = recordLink(original, entrants, STARTER_LINK_DECKS)!;
      const parsed = parseGameHash(gameHash(link))!;
      const m = linkMatch(parsed, STARTER_LINK_DECKS, AGENTS);
      if (typeof m === "string") throw new Error(m);
      const again = runGame(m.spec, m.entrants, { record: true });
      expect(again.actions).toEqual(original.actions);
      expect(again.seats).toEqual(original.seats);
      expect(m.entrants.map((e) => e.name)).toEqual(spec.aIsPlayer0 ? [`${d0!.name}（ランダム）`, `${d1!.name}（貪欲法）`] : [`${d1!.name}（貪欲法）`, `${d0!.name}（ランダム）`]);
    }
  });

  it("アズヴォルト環境のページの試合も、URL から打ち直すと同じ試合になる", () => {
    const [o0, o1] = AZVALDT_DECK_OPTIONS;
    const entrants: Entrant[] = [
      { name: o0!.label, deck: o0!.cards, agent: "greedy" },
      { name: o1!.label, deck: o1!.cards, agent: "greedy" },
    ];
    const spec = { a: 0, b: 1, seed: 12345, aIsPlayer0: false };
    const original = runGame(spec, entrants, { record: true });
    expect(original.error).toBeUndefined();
    const link = recordLink(original, entrants, AZVALDT_LINK_DECKS)!;
    expect(link.decks).toEqual([o1!.key, o0!.key]);
    const m = linkMatch(parseGameHash(gameHash(link))!, AZVALDT_LINK_DECKS, AGENTS);
    if (typeof m === "string") throw new Error(m);
    expect(runGame(m.spec, m.entrants, { record: true }).actions).toEqual(original.actions);
  });
});
