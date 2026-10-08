import { describe, expect, it } from "vitest";
import { MULLIGAN_WEIGHTS, costMulliganSwap, defaultDeckNameOf, weightedMulliganSwap, withMulligan, type MulliganWeights } from "../src/ai/mulligan";
import { greedyAgent } from "../src/ai/greedy";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions } from "../src/engine";

const deck = DEFAULT_DECKS.find((d) => d.name === "AFネメシス")!;
const other = DEFAULT_DECKS.find((d) => d.name === "アマリアロイヤル")!;

describe("マリガンの重み", () => {
  const state = createGame({ decks: [deck.cards, other.cards], seed: 12345 });
  const p = state.first;
  const hand = state.players[p].hand;

  it("デフォルトデッキを手札＋山札から特定する", () => {
    expect(defaultDeckNameOf(state, p)).toBe(state.first === 0 ? deck.name : other.name);
  });

  it("重みが正のカードは残し、負のカードは返す", () => {
    const name = defaultDeckNameOf(state, p)!;
    const [keep, ...rest] = hand;
    const table: Record<string, [number, number]> = {};
    for (const h of rest) table[h.cardId] = [-0.01, -0.01];
    table[keep!.cardId] = [0.01, -0.01];
    const swap = weightedMulliganSwap(state, p, { [name]: table })!;
    // 同じカードが 2 枚あれば、2 枚目は 2 枚目の重み（負）で返す
    const sameAsKeep = hand.filter((h) => h.cardId === keep!.cardId).slice(1).map((h) => h.iid);
    expect(swap.sort()).toEqual([...rest.filter((h) => h.cardId !== keep!.cardId).map((h) => h.iid), ...sameAsKeep].sort());
  });

  it("重みの無いデッキは null、重みの無いカードはコストで決める", () => {
    expect(weightedMulliganSwap(state, p, {})).toBeNull();
    const name = defaultDeckNameOf(state, p)!;
    expect(weightedMulliganSwap(state, p, { [name]: {} })!.sort()).toEqual(costMulliganSwap(state, p).sort());
  });

  it("withMulligan はマリガンだけ差し替える", () => {
    const weights: MulliganWeights = { [defaultDeckNameOf(state, p)!]: Object.fromEntries(hand.map((h) => [h.cardId, [-1, -1]])) };
    const agent = withMulligan(greedyAgent, "w", (s, q) => weightedMulliganSwap(s, q, weights));
    const action = agent.chooseAction(state, legalActions(state), { int: () => 0 });
    expect(action.type === "mulligan" && action.swap.length).toBe(hand.length);
    const next = applyAction(state, action);
    expect(next.players[p].mulliganDone).toBe(true);
  });
});

describe("data/mulligan-weights.json", () => {
  it("デッキはデフォルトデッキ、カードはそのデッキのカード", () => {
    expect(Object.keys(MULLIGAN_WEIGHTS).length).toBeGreaterThan(0);
    for (const [name, table] of Object.entries(MULLIGAN_WEIGHTS)) {
      const d = DEFAULT_DECKS.find((x) => x.name === name);
      expect(d, name).toBeDefined();
      for (const id of Object.keys(table)) expect(d!.cards, `${name} ${id}`).toContain(id);
    }
  });
});
