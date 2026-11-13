// エンジンのカードの表（src/cards/pools.ts）: スターターの番号を動かさずに、前期のローテーションのカードを後ろに足していること。

import { describe, expect, it } from "vitest";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";
import { AZVALDT_CARD_ABILITIES, AZVALDT_CREST_ABILITIES } from "../src/cards/abilities/azvaldt";
import {
  AZVALDT_CARDS,
  AZVALDT_CRESTS,
  ENGINE_CARDS,
  ENGINE_CRESTS,
  poolsOfCard,
  poolsOfCrest,
} from "../src/cards/pools";

describe("エンジンのカードの表", () => {
  it("スターターのカードとクレストが、今の順のまま先頭にある", () => {
    expect(ENGINE_CARDS.slice(0, ALL_CARDS.length)).toEqual(ALL_CARDS);
    expect(ENGINE_CRESTS.slice(0, ALL_CRESTS.length)).toEqual(ALL_CRESTS);
  });

  it("前期のローテーションのカードとクレストがすべてあり、ID は重ならない", () => {
    const ids = new Set(ENGINE_CARDS.map((c) => c.id));
    expect(ids.size).toBe(ENGINE_CARDS.length);
    expect(AZVALDT_CARDS.filter((c) => !ids.has(c.id))).toEqual([]);
    expect(ENGINE_CARDS).toHaveLength(241 + 490);
    const crestIds = new Set(ENGINE_CRESTS.map((c) => c.id));
    expect(crestIds.size).toBe(ENGINE_CRESTS.length);
    expect(AZVALDT_CRESTS.filter((c) => !crestIds.has(c.id))).toEqual([]);
    expect(ENGINE_CRESTS).toHaveLength(7 + 38);
  });

  it("プール: ベーシックとトークンの一部は両方、ストームブラストは ID ごとに別", () => {
    expect(poolsOfCard("10001110")).toEqual(["starter", "azvaldt"]);
    expect(poolsOfCard("10131320")).toEqual(["starter"]);
    expect(poolsOfCard("10831310")).toEqual(["azvaldt"]);
    expect(poolsOfCard("90031210")).toEqual(["starter", "azvaldt"]); // 大地の魔片
    expect(ENGINE_CARDS.every((c) => poolsOfCard(c.id).length > 0)).toBe(true);
    expect(ENGINE_CRESTS.every((c) => poolsOfCrest(c.id).length > 0)).toBe(true);
  });

  it("前期のローテーションの能力の定義は、スターターと同じ ID に書かない", () => {
    const starter = new Set([...Object.keys(CARD_ABILITIES), ...Object.keys(CREST_ABILITIES)]);
    const pool = [...Object.keys(AZVALDT_CARD_ABILITIES), ...Object.keys(AZVALDT_CREST_ABILITIES)];
    expect(pool.filter((id) => starter.has(id))).toEqual([]);
  });
});
