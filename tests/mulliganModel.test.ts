import { describe, expect, it } from "vitest";
import { MODEL_FEATURES, MULLIGAN_ROLES, handFeatures, modelMulliganSwap, type MulliganModel } from "../src/ai/mulliganModel";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { createGame } from "../src/engine";

describe("手札の形のマリガン", () => {
  it("役割の表は、デフォルトデッキのカードをすべて含む", () => {
    for (const [name, roles] of Object.entries(MULLIGAN_ROLES)) {
      const d = DEFAULT_DECKS.find((x) => x.name === name);
      expect(d, name).toBeDefined();
      expect(Object.keys(roles).sort(), name).toEqual([...new Set(d!.cards)].sort());
    }
  });

  it("特徴は役割の枚数（1 枚以上・2 枚以上）、重複、残した枚数", () => {
    const roles = { a: ["2PP", "resource"], b: ["heavy"] } as const;
    const f = handFeatures(["a", "a", "b"], roles, true);
    const get = (n: string) => f[MODEL_FEATURES.indexOf(n)];
    expect(f.length).toBe(MODEL_FEATURES.length);
    expect([get("2PP>=1"), get("2PP>=2"), get("resource>=2"), get("heavy>=1"), get("heavy>=2")]).toEqual([1, 1, 1, 1, 0]);
    expect([get("dup"), get("kept"), get("2PPxSecond"), get("1PPxRes")]).toEqual([1, 3, 1, 0]);
  });

  it("予測が最も高い残し方を選ぶ（例: 重複を嫌えば 2 枚目を返す）", () => {
    const deck = DEFAULT_DECKS.find((d) => d.name === "アマリアロイヤル")!;
    let s = createGame({ decks: [deck.cards, deck.cards], seed: 1 });
    for (let seed = 2; new Set(s.players[s.first].hand.map((h) => h.cardId)).size === s.players[s.first].hand.length; seed++) {
      s = createGame({ decks: [deck.cards, deck.cards], seed });
    }
    const hand = s.players[s.first].hand;
    // どのカードも残すと +1、重複は −5
    const model: MulliganModel = { [deck.name]: { features: { dup: -5 }, cards: Object.fromEntries(hand.map((h) => [h.cardId, 1])) } };
    const swap = modelMulliganSwap(s, s.first, model)!;
    const second = hand.filter((h, i) => hand.findIndex((x) => x.cardId === h.cardId) !== i);
    expect(swap.sort()).toEqual(second.map((h) => h.iid).sort());
    expect(modelMulliganSwap(s, s.first, {})).toBeNull();
  });
});
