import { describe, expect, it } from "vitest";
import rawCards from "../data/cards.json";
import {
  CardValidationError,
  STARTER,
  deckProblems,
  validateCards,
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
  evolvedAttack: 4,
  evolvedDefense: 4,
  tribes: [],
  text: "",
  evolvedText: "",
  source: "test",
  verified: true,
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
  source: "test",
  verified: true,
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
    expect(() => validateCards([broken])).toThrow(CardValidationError);
  });

  it("スペルにフォロワー専用項目があれば検出する", () => {
    expect(() => validateCards([{ ...spell, attack: 1 }])).toThrow(/attack/);
  });

  it("id の重複を検出する", () => {
    expect(() => validateCards([follower, follower])).toThrow(/重複/);
  });

  it("トークン以外の rarity 欠落を検出する", () => {
    const { rarity: _, ...noRarity } = spell;
    expect(() => validateCards([noRarity])).toThrow(/rarity/);
    expect(() => validateCards([{ ...noRarity, set: "token" }])).not.toThrow();
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
