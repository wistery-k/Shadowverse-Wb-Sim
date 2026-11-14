// デッキの組のファイル（data/pools/azvaldt/sets/、npm run deck-sets で書く）が、今のデッキのファイルと合うこと

import { describe, expect, it } from "vitest";
import { deckSets } from "../scripts/deck-sets.ts";
import rep10 from "../data/pools/azvaldt/sets/rep10.txt?raw";
import all84 from "../data/pools/azvaldt/sets/all84.txt?raw";

const files = import.meta.glob<string>("../data/pools/azvaldt/decks/*/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});

const sets = deckSets(Object.entries(files).map(([path, text]) => ({ path: path.replace(/^\.\.\//, ""), text })));

describe("デッキの組", () => {
  it("書いたファイルが、デッキのファイルから作ったものと同じ（違えば npm run deck-sets で書き直す）", () => {
    expect(rep10).toBe(sets.rep10);
    expect(all84).toBe(sets.all84);
  });

  it("代表は型ごとに 1 個で 10 型。全部は 84 個", () => {
    expect(sets.representatives).toHaveLength(10);
    expect(new Set(sets.representatives.map((r) => r.archetype)).size).toBe(10);
    expect(sets.all).toHaveLength(84);
  });
});
