import { describe, expect, it } from "vitest";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { deckArg, parseDeckArg, reproduceCommand } from "../src/sim/reproduce";
import { agentOf } from "../src/ai/registry";
import { playMatch } from "../src/sim/match";
import { runGame, type Entrant } from "../src/sim/tournament";

describe("試合の再現情報", () => {
  it("デフォルトデッキはキーで、それ以外は並び順を保ったカードIDの列で表す", () => {
    const d = DEFAULT_DECKS[0]!;
    expect(deckArg(d.cards)).toBe(d.key);
    expect(parseDeckArg(d.key)).toEqual(d.cards);
    const shuffled = [...d.cards].reverse();
    const arg = deckArg(shuffled);
    expect(arg).not.toBe(d.key);
    expect(parseDeckArg(arg)).toEqual(shuffled);
    expect(deckArg(["a", "a", "b", "a"])).toBe("a*2,b,a");
    expect(parseDeckArg("a*2,b,a")).toEqual(["a", "a", "b", "a"]);
    expect(() => parseDeckArg("a b")).toThrow();
  });

  it("席の順にコマンドを作る", () => {
    const [d0, d1] = DEFAULT_DECKS;
    const entrants: Entrant[] = [
      { name: "A", deck: d0!.cards, agent: "search" },
      { name: "B", deck: d1!.cards, agent: "greedy" },
    ];
    const cmd = reproduceCommand({ a: 0, b: 1, aIsPlayer0: false, seed: 42 }, entrants);
    expect(cmd).toBe(`npm run game -- --seed 42 --p0 greedy --p0-deck '${d1!.key}' --p1 search --p1-deck '${d0!.key}'`);
  });

  it("コマンドの引数から同じ試合を再現できる", () => {
    const [d0, d1] = DEFAULT_DECKS;
    const entrants: Entrant[] = [
      { name: "A", deck: [...d0!.cards].reverse(), agent: "greedy" },
      { name: "B", deck: d1!.cards, agent: "greedy" },
    ];
    const record = runGame({ a: 0, b: 1, seed: 7, aIsPlayer0: false }, entrants, { record: true });
    const r = playMatch([agentOf("greedy"), agentOf("greedy")], {
      decks: [parseDeckArg(deckArg(entrants[1]!.deck)), parseDeckArg(deckArg(entrants[0]!.deck))],
      seed: 7,
      record: true,
    });
    expect(r.log).toEqual(record.actions);
  });
});
