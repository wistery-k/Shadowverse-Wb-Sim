import { describe, expect, it } from "vitest";
import { STARTER, deckProblems } from "../src/cards";
import { CARDS_BY_ID } from "../src/cards";
import { deckToText, parseDeckText } from "../src/cards/deck";
import { DEFAULT_DECKS, DEFAULT_DECK_ERRORS } from "../src/cards/defaultDecks";
import { rngFrom } from "../src/engine";
import { randomDeck } from "../src/sim/decks";

const sorted = (ids: readonly string[]) => [...ids].sort();

describe("デッキのテキスト形式", () => {
  it("エクスポートしたテキストを読み込むと同じデッキになる", () => {
    const cards = randomDeck("witch", rngFrom({ rng: 3 }));
    const text = deckToText({ name: "テスト", class: "witch", cards });
    expect(text).toContain("名前: テスト");
    expect(text).toContain("クラス: ウィッチ");
    const { deck, errors } = parseDeckText(text);
    expect(errors).toEqual([]);
    expect(deck).toMatchObject({ name: "テスト", class: "witch" });
    expect(sorted(deck!.cards)).toEqual(sorted(cards));
  });

  it("コメント・カードID・「3x」表記を読み、クラスを省略するとカードから決める", () => {
    const { deck, errors } = parseDeckText("# コメント\n3x フェアリーテイマー\n2 × 10001130\n");
    expect(errors).toEqual([]);
    expect(deck?.class).toBe("elf");
    expect(deck?.cards).toHaveLength(5);
    expect(CARDS_BY_ID.get(deck!.cards[4]!)?.name).toBe("激震のゴリアテ");
  });

  it("不明なカード・複数クラス・クラス不明をエラーにする", () => {
    expect(parseDeckText("1 存在しないカード").errors[0]).toMatch(/不明なカード/);
    expect(parseDeckText("1 フェアリーテイマー\n1 刹那のクイックブレイダー").errors[0]).toMatch(/複数のクラス/);
    expect(parseDeckText("3 激震のゴリアテ").errors[0]).toMatch(/クラスが決められません/);
    expect(parseDeckText("クラス: エルフ\n3 激震のゴリアテ").deck?.class).toBe("elf");
    expect(parseDeckText("これは不正な行").errors[0]).toMatch(/形式ではありません/);
  });
});

describe("デフォルトデッキ（data/decks）", () => {
  it("すべて読み込め、スターターの構築ルールを満たす", () => {
    expect(DEFAULT_DECK_ERRORS).toEqual([]);
    for (const deck of DEFAULT_DECKS) {
      const cards = deck.cards.map((id) => CARDS_BY_ID.get(id)!);
      expect({ deck: deck.key, problems: deckProblems(STARTER, deck.class, cards) }).toEqual({ deck: deck.key, problems: [] });
    }
  });
});
