import { describe, expect, it } from "vitest";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";

/** 能力定義が不要な行（常在型キーワード、カウントダウン等はエンジンがテキストから読む） */
const STATIC_LINE = /^(【(守護|疾走|突進|必殺|ドレイン|潜伏|威圧|バリア|オーラ|土の印|カウントダウン_\d+)】|1ターンに\d回攻撃できる。)$/;

describe("カード能力の定義", () => {
  it("能力テキストを持つ全カードに定義がある", () => {
    const missing = ALL_CARDS.filter(
      (c) => c.text.split("\n").some((line) => line !== "" && !STATIC_LINE.test(line)) && !CARD_ABILITIES[c.id],
    ).map((c) => `${c.id} ${c.name}`);
    expect(missing).toEqual([]);
  });

  it("全クレストに定義がある", () => {
    expect(ALL_CRESTS.filter((c) => !CREST_ABILITIES[c.id]).map((c) => c.name)).toEqual([]);
  });

  it("定義のキーは実在するカード", () => {
    const ids = new Set(ALL_CARDS.map((c) => c.id));
    expect(Object.keys(CARD_ABILITIES).filter((k) => !ids.has(k))).toEqual([]);
  });
});
