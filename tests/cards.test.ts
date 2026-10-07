import { describe, expect, it } from "vitest";
import rawCards from "../data/cards.json";
import rawCrests from "../data/crests.json";
import {
  CardValidationError,
  STARTER,
  deckProblems,
  validateCards,
  validateCrests,
  type Card,
} from "../src/cards";

// テスト用の架空カード（実在カードではない）
const follower = {
  id: "test-follower",
  name: "テストフォロワー",
  class: "elf",
  set: "legend_dawn",
  rarity: "bronze",
  type: "follower",
  cost: 2,
  attack: 2,
  defense: 2,
  tribes: [],
  text: "",
  related: ["test-spell"],
};

const spell = {
  id: "test-spell",
  name: "テストスペル",
  class: "neutral",
  set: "basic",
  rarity: "bronze",
  type: "spell",
  cost: 1,
  tribes: [],
  text: "",
  related: [],
};

describe("validateCards", () => {
  it("data/cards.json が検証を通る", () => {
    expect(() => validateCards(rawCards)).not.toThrow();
  });

  it("正しいカードを受け付ける", () => {
    expect(validateCards([follower, spell])).toHaveLength(2);
  });

  it("フォロワーのステータス欠落を検出する", () => {
    const { attack: _, ...broken } = follower;
    expect(() => validateCards([broken, spell])).toThrow(CardValidationError);
    expect(() => validateCards([broken, spell])).toThrow(/attack/);
  });

  it("スペルにフォロワー専用項目があれば検出する", () => {
    expect(() => validateCards([{ ...spell, attack: 1 }])).toThrow(/attack/);
  });

  it("id の重複を検出する", () => {
    expect(() => validateCards([follower, follower])).toThrow(/重複/);
  });

  it("存在しない related を検出する", () => {
    expect(() => validateCards([follower])).toThrow(/test-spell/);
  });

  it("countdown はアミュレットのみ持てる", () => {
    const amulet = { ...spell, type: "amulet", countdown: 2 };
    expect(() => validateCards([amulet])).not.toThrow();
    expect(() => validateCards([{ ...spell, countdown: 2 }])).toThrow(/countdown/);
    expect(() => validateCards([{ ...amulet, countdown: 0 }])).toThrow(/countdown/);
  });
});

describe("validateCrests", () => {
  it("data/crests.json が検証を通る", () => {
    expect(() => validateCrests(rawCrests, validateCards(rawCards))).not.toThrow();
  });

  it("カードの crest の参照先と、クレストの source の参照先を検査する", () => {
    const crest = { id: "test-crest", name: "クレスト：テストスペル", source: "test-spell", text: "テスト" };
    const cards = validateCards([{ ...spell, crest: "test-crest" }]);
    expect(() => validateCrests([crest], cards)).not.toThrow();
    expect(() => validateCrests([], cards)).toThrow(/test-crest/);
    expect(() => validateCrests([{ ...crest, source: "none" }], cards)).toThrow(/none/);
  });
});

describe("スターターのカードプール", () => {
  const cards = validateCards(rawCards);

  it("ベーシック56枚・伝説の幕開け142枚で、全カードのタイプが判明している", () => {
    expect(cards.filter((c) => c.set === "basic")).toHaveLength(56);
    expect(cards.filter((c) => c.set === "legend_dawn")).toHaveLength(142);
    expect(cards.filter((c) => c.tribes === null)).toEqual([]);
  });
});

describe("deckProblems", () => {
  const [f, s] = validateCards([follower, spell]) as [Card, Card];
  const legalDeck = [
    ...Array.from({ length: 3 }, () => f),
    ...Array.from({ length: 37 }, (_, i) => ({ ...s, id: `s${i}`, name: `スペル${i}` })),
  ];

  it("合法なデッキを受け付ける", () => {
    expect(deckProblems(STARTER, "elf", legalDeck)).toEqual([]);
  });

  it("枚数・同名上限・クラス・セットの違反を検出する", () => {
    expect(deckProblems(STARTER, "elf", legalDeck.slice(1))).toHaveLength(1);
    expect(deckProblems(STARTER, "elf", [f, ...legalDeck.slice(1)])).toEqual([]);
    expect(deckProblems(STARTER, "elf", [f, f, f, f, ...legalDeck.slice(4)])).toHaveLength(1);
    expect(deckProblems(STARTER, "royal", legalDeck)).toHaveLength(1);
    const token = { ...s, set: "token" as const };
    expect(deckProblems(STARTER, "elf", [token, ...legalDeck.slice(1)])).toHaveLength(1);
  });
});
