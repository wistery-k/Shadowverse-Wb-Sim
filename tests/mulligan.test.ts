import { describe, expect, it } from "vitest";
import { MULLIGAN_WEIGHTS, costMulliganSwap, defaultDeckNameOf, weightedMulliganSwap, withMulligan, type MulliganWeights } from "../src/ai/mulligan";
import { EVOLVE_ABILITY } from "../src/ai/evaluate";
import { greedyAgent } from "../src/ai/greedy";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, cardOf, createGame, legalActions } from "../src/engine";

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

  it("evoBonus: 進化時能力持ちを 1 枚も残さないときだけ、重みが最も大きい 1 枚に加点する", () => {
    // 進化時能力持ちが 2 種以上ある初手を探す
    let s = state;
    for (let seed = 1; ; seed++) {
      s = createGame({ decks: [deck.cards, deck.cards], seed });
      if (new Set(s.players[s.first].hand.filter((h) => EVOLVE_ABILITY.has(h.cardId)).map((h) => h.cardId)).size >= 2) break;
    }
    const q = s.first;
    const h = s.players[q].hand;
    const evo = h.filter((x) => EVOLVE_ABILITY.has(x.cardId));
    const [a, b] = evo.filter((x, i) => evo.findIndex((y) => y.cardId === x.cardId) === i);
    const table: Record<string, [number, number]> = Object.fromEntries(h.map((x) => [x.cardId, [-0.05, -0.05]]));
    table[a!.cardId] = [-0.01, -0.01];
    table[b!.cardId] = [-0.02, -0.02];
    const w = { [deck.name]: table };
    expect(weightedMulliganSwap(s, q, w)!.length).toBe(h.length);
    // a の 1 枚目だけ残す（2 枚目と b は返す）
    expect(weightedMulliganSwap(s, q, w, { evoBonus: 0.015 })!.sort()).toEqual(h.filter((x) => x !== a).map((x) => x.iid).sort());
    // 足しても 0 を超えなければ返す
    expect(weightedMulliganSwap(s, q, w, { evoBonus: 0.005 })!.length).toBe(h.length);
    // 他の進化時能力持ちを残すなら加点しない
    table[b!.cardId] = [0.01, -0.01];
    expect(weightedMulliganSwap(s, q, w, { evoBonus: 0.015 })!.sort()).toEqual(weightedMulliganSwap(s, q, w)!.sort());
  });

  it("oneCopy は同じカードの 2 枚目を返し、maxHighCost はコスト 4 以上を重みの大きい順に上限まで残す", () => {
    const find = (ok: (h: readonly { cardId: string }[]) => boolean) => {
      for (let seed = 1; ; seed++) {
        const s = createGame({ decks: [deck.cards, deck.cards], seed });
        if (ok(s.players[s.first].hand)) return s;
      }
    };
    const keepAll = (h: readonly { cardId: string }[]) => ({ [deck.name]: Object.fromEntries(h.map((x, i) => [x.cardId, [0.01 * (i + 1), 0.01] as [number, number]])) });

    const s1 = find((h) => new Set(h.map((x) => x.cardId)).size < h.length);
    const h1 = s1.players[s1.first].hand;
    const second = h1.filter((x, i) => h1.findIndex((y) => y.cardId === x.cardId) !== i).map((x) => x.iid);
    expect(weightedMulliganSwap(s1, s1.first, keepAll(h1))).toEqual([]);
    expect(weightedMulliganSwap(s1, s1.first, keepAll(h1), { oneCopy: true })!.sort()).toEqual(second.sort());

    const s2 = find((h) => new Set(h.filter((x) => cardOf(x.cardId).cost >= 4).map((x) => x.cardId)).size >= 2);
    const h2 = s2.players[s2.first].hand;
    const w2 = keepAll(h2);
    const high = h2.filter((x) => cardOf(x.cardId).cost >= 4).sort((a, b) => w2[deck.name]![b.cardId]![0] - w2[deck.name]![a.cardId]![0]);
    expect(weightedMulliganSwap(s2, s2.first, w2, { maxHighCost: 1 })!.sort()).toEqual(high.slice(1).map((x) => x.iid).sort());
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
