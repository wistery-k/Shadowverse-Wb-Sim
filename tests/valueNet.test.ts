import { describe, expect, it } from "vitest";
import { createSearchAgent } from "../src/ai/search";
import { SEARCH_WEIGHTS } from "../src/ai/evaluate";
import {
  compileValueNet,
  defaultVocab,
  encodeState,
  inputSize,
  parseValueNetModel,
  VALUE_SCALARS,
  VALUE_ZONES,
  valueNetExtraEval,
  type ValueNetModel,
} from "../src/ai/valueNet";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, cloneState, createGame, legalActions, rngFrom, type GameState } from "../src/engine";

function model(hidden: number, fill: (i: number) => number, w2 = 0): ValueNetModel {
  const vocab = defaultVocab();
  const n = inputSize({ vocab, zones: [...VALUE_ZONES], scalars: [...VALUE_SCALARS] });
  return {
    kind: "td-value-net",
    version: 1,
    vocab,
    zones: [...VALUE_ZONES],
    scalars: [...VALUE_SCALARS],
    hidden,
    w1: Array.from({ length: n * hidden }, (_, i) => fill(i)),
    b1: Array.from({ length: hidden }, () => 0.1),
    w2: Array.from({ length: hidden }, () => w2),
    b2: 0,
    a: 0.08,
    c: 0,
    baseWeights: {},
  };
}

/** 両者が何ターンか打った局面（貪欲に最初の合法手を打つ） */
function midGame(): GameState {
  let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 5 });
  for (let i = 0; i < 40 && s.phase !== "ended"; i++) {
    const legal = legalActions(s);
    s = applyAction(s, legal.find((a) => a.type !== "endTurn") ?? legal[0]!);
  }
  return s;
}

describe("TD 学習の評価の補正（valueNet）", () => {
  it("入力は相手の未公開の手札の中身と山札の順番を見ない", () => {
    const net = compileValueNet(model(4, (i) => Math.sin(i), 1));
    const s = midGame();
    const p = s.active;
    const q = p === 0 ? 1 : 0;
    const t = cloneState(s);
    // 相手の未公開の手札と山札の中身を入れ替え、山札を逆順にする
    const opp = t.players[q];
    const hiddenHand = opp.hand.filter((h) => !h.revealed);
    expect(hiddenHand.length).toBeGreaterThan(0);
    for (const [k, h] of hiddenHand.entries()) {
      const d = opp.deck[k]!;
      [h.cardId, d.cardId] = [d.cardId, h.cardId];
    }
    opp.deck.reverse();
    t.players[p].deck.reverse();
    expect(encodeState(net, t, p, "end")).toEqual(encodeState(net, s, p, "end"));
    expect(valueNetExtraEval(net)(t, p, "end")).toBeCloseTo(valueNetExtraEval(net)(s, p, "end"), 12);
    // 自分の手札は見る
    expect(encodeState(net, s, q, "end")).not.toEqual(encodeState(net, t, q, "end"));
  });

  it("出力の重みが 0 のモデルは補正 0 で、探索 AI の手を変えない", () => {
    const net = compileValueNet(model(4, (i) => Math.cos(i)));
    const s = midGame();
    const extra = valueNetExtraEval(net);
    expect(extra(s, 0, "end")).toBe(0);
    expect(extra(s, 1, "after")).toBe(0);
    const plain = createSearchAgent({ weights: SEARCH_WEIGHTS, extraEval: null });
    const withNet = createSearchAgent({ weights: SEARCH_WEIGHTS, extraEval: extra });
    const legal = legalActions(s);
    expect(withNet.chooseAction(s, legal, rngFrom({ rng: 9 }))).toEqual(plain.chooseAction(s, legal, rngFrom({ rng: 9 })));
  });

  it("JSON を通したモデルを読み直せ、大きさが合わなければ止める", () => {
    const m = model(2, (i) => (i % 7) / 10, 0.5);
    const back = parseValueNetModel(JSON.parse(JSON.stringify(m)) as unknown);
    expect(back).toEqual(m);
    const s = midGame();
    expect(valueNetExtraEval(compileValueNet(back))(s, 0, "end")).toBe(valueNetExtraEval(compileValueNet(m))(s, 0, "end"));
    expect(() => compileValueNet({ ...m, w1: m.w1.slice(1) })).toThrow();
    expect(() => compileValueNet({ ...m, zones: [...m.zones].reverse() })).toThrow();
    expect(() => parseValueNetModel({ ...m, w2: ["x"] })).toThrow();
  });
});
