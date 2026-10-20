// AI のテスト（TypeScript 側）。AI の本体は Rust（rust/engine/src/ai）で、その単体テストは rust/engine/src/ai/tests にある。
// ここでは、WASM を通した AI どうしの対戦（不変条件の検査つき）と、TypeScript 側で持つ AI のデータ・学習用のモデルの形を確かめる。

import { describe, expect, it } from "vitest";
import { MODEL_FEATURES, MULLIGAN_MODEL, MULLIGAN_ROLES, MULLIGAN_WEIGHTS } from "../src/ai/data";
import { agentOf } from "../src/ai/registry";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { rngFrom } from "../src/engine";
import { randomDeck } from "../src/sim/decks";
import { playMatch } from "../src/sim/match";
import {
  BOARD_FEATURES,
  type BoardCard,
  boardCardInput,
  boardGrantKeys,
  compileValueNet,
  defaultVocab,
  forwardValueNet,
  inputSize,
  layerSizes,
  parseValueNetModel,
  VALUE_SCALARS,
  VALUE_ZONES,
  type ValueNetModel,
} from "../scripts/valueNet";

const CLASSES = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"] as const;

describe("AI どうしの対戦（WASM）", () => {
  it("貪欲法の AI はランダムの AI に大きく勝ち越す", () => {
    let wins = 0;
    const games = 20;
    for (let seed = 1; seed <= games; seed++) {
      const rng = rngFrom({ rng: seed });
      const decks: [string[], string[]] = [randomDeck(CLASSES[seed % 7]!, rng), randomDeck(CLASSES[(seed + 3) % 7]!, rng)];
      const result = playMatch([agentOf("greedy-base"), agentOf("random")], { decks, seed, checkInvariants: true });
      if (result.winner === 0) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(16);
  });

  it("探索 AI は不変条件を破らずに対戦を終え、貪欲法 AI に勝ち越す", () => {
    let wins = 0;
    for (let g = 0; g < 8; g++) {
      const decks: [string[], string[]] = [DEFAULT_DECKS[g % 7]!.cards, DEFAULT_DECKS[(g * 3 + 1) % 7]!.cards];
      const searchSeat = g % 2;
      const [search, greedy] = [agentOf("search"), agentOf("greedy-base")];
      const r = playMatch(searchSeat === 0 ? [search, greedy] : [greedy, search], { decks, seed: 100 + g, checkInvariants: true });
      if (r.winner === searchSeat) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it("リノセウス用 AI は不変条件を破らずに対戦を終える", () => {
    const elf = DEFAULT_DECKS.find((d) => d.class === "elf")!;
    const royal = DEFAULT_DECKS.find((d) => d.class === "royal")!;
    for (const [seed, seat] of [
      [1, 0],
      [2, 1],
    ] as const) {
      const decks: [string[], string[]] = seat === 0 ? [elf.cards, royal.cards] : [royal.cards, elf.cards];
      const [rhino, search] = [agentOf("rhino"), agentOf("search")];
      const r = playMatch(seat === 0 ? [rhino, search] : [search, rhino], { decks, seed, checkInvariants: true });
      expect(r.winner).not.toBeNull();
    }
  }, 120_000);
});

describe("AI のデータ", () => {
  it("マリガンの重み（data/mulligan-weights.json）: デッキはデフォルトデッキ、カードはそのデッキのカード", () => {
    expect(Object.keys(MULLIGAN_WEIGHTS).length).toBeGreaterThan(0);
    for (const [name, table] of Object.entries(MULLIGAN_WEIGHTS)) {
      const d = DEFAULT_DECKS.find((x) => x.name === name);
      expect(d, name).toBeDefined();
      for (const id of Object.keys(table)) expect(d!.cards, `${name} ${id}`).toContain(id);
    }
  });

  it("マリガンの役割の表は、デフォルトデッキのカードをすべて含む", () => {
    for (const [name, roles] of Object.entries(MULLIGAN_ROLES)) {
      const d = DEFAULT_DECKS.find((x) => x.name === name);
      expect(d, name).toBeDefined();
      expect(Object.keys(roles).sort(), name).toEqual([...new Set(d!.cards)].sort());
    }
  });

  it("マリガンのモデルの係数は役割のあるデッキをすべて含み、特徴名は既知のもの", () => {
    for (const name of Object.keys(MULLIGAN_ROLES)) {
      const deck = MULLIGAN_MODEL[name];
      expect(deck, name).toBeDefined();
      for (const f of Object.keys(deck!.features)) expect(MODEL_FEATURES).toContain(f);
    }
  });
});

describe("TD 学習の評価の補正のモデル（scripts/valueNet.ts）", () => {
  function model(hidden: number, fill: (i: number) => number, w2: number): ValueNetModel {
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

  it("JSON を通したモデルを読み直せ、大きさが合わなければ止める", () => {
    const m = model(2, (i) => (i % 7) / 10, 0.5);
    const back = parseValueNetModel(JSON.parse(JSON.stringify(m)) as unknown);
    expect(back).toEqual(m);
    expect(() => compileValueNet(back)).not.toThrow();
    expect(() => compileValueNet({ ...m, w1: m.w1.slice(1) })).toThrow();
    expect(() => compileValueNet({ ...m, zones: [...m.zones].reverse() })).toThrow();
    expect(() => parseValueNetModel({ ...m, w2: ["x"] })).toThrow();
  });

  it("隠れ層を重ねたモデル（layers）を読み、単位行列の層を挟んでも出力は同じ", () => {
    const m = model(3, (i) => ((i * 31) % 11) / 10 - 0.5, 0.7);
    const identity = { w: Array.from({ length: 9 }, (_, k) => (k % 4 === 0 ? 1 : 0)), b: [0, 0, 0] };
    const two = parseValueNetModel(JSON.parse(JSON.stringify({ ...m, layers: [identity] })) as unknown);
    expect(two.layers).toEqual([identity]);
    expect(layerSizes(two)).toEqual([3, 3]);
    const x = { idx: [5, 300, 3000], val: [1, 0.5, 2] };
    const z1 = forwardValueNet(compileValueNet(m), x);
    expect(z1).not.toBe(0);
    expect(forwardValueNet(compileValueNet(two), x)).toBe(z1);
    expect(() => compileValueNet({ ...m, layers: [{ w: [0, 0, 0, 0, 0, 0], b: [0, 0] }] })).toThrow();
    expect(() => parseValueNetModel({ ...m, layers: [{ w: ["x"], b: [] }] })).toThrow();
  });

  it("場のカードのネットワーク（board）: 出力を受ける重みが 0 なら無いモデルと同じで、付与された能力を見分ける", () => {
    // rust/engine/src/ai/tests/valuenet.rs の board_network と同じ能力の文字列
    const dollLastWords = '{"trigger":{"on":"lastWords"},"effects":[{"op":"damage","target":{"kind":"leader","side":"opponent"},"amount":2}]}';
    const grants = boardGrantKeys();
    expect(grants).toContain(dollLastWords);
    const m = model(3, (i) => ((i * 31) % 11) / 10 - 0.5, 0.7);
    const v = m.vocab.length;
    const nIn = v + grants.length + BOARD_FEATURES.length;
    const w0 = Array.from({ length: nIn * 3 }, (_, i) => ((i * 7) % 5) / 10 - 0.1);
    const g = grants.indexOf(dollLastWords);
    w0.splice((v + g) * 3, 3, 0.5, 0.4, 0.3);
    const board = {
      features: [...BOARD_FEATURES],
      grants,
      layers: [
        { w: w0, b: [0.05, 0.05, 0.05] },
        { w: [0.3, -0.2, 0.5, 0.1, 0.4, 0.2], b: [0, 0.1] },
      ],
    };
    const withRows = (row: (j: number) => number): ValueNetModel => ({ ...m, w1: [...m.w1, ...Array.from({ length: 2 * 2 * m.hidden }, (_, j) => row(j))], board });
    const zero = parseValueNetModel(JSON.parse(JSON.stringify(withRows(() => 0))) as unknown);
    const net = withRows((j) => Math.sin(j * 0.37));
    expect(inputSize(net)).toBe(inputSize(m) + 4);
    // 自分の場に進化したフォロワー（vocab の 0 番のカード）、相手の場に vocab の 1 番のカード
    const card: BoardCard = { c: m.vocab[0]!, a: 3, d: 2, md: 4, e: 1, k: ["ward"] };
    const boards: [BoardCard[], BoardCard[]] = [[card], [{ c: m.vocab[1]! }]];
    const x = { idx: [5, 300], val: [1, 0.5] };
    const plain = forwardValueNet(compileValueNet(m), x);
    expect(forwardValueNet(compileValueNet(zero), x, undefined, boards)).toBe(plain);
    const z = forwardValueNet(compileValueNet(net), x, undefined, boards);
    expect(z).not.toBe(plain);
    expect(() => forwardValueNet(compileValueNet(net), x)).toThrow();
    // 付与された能力の入力（カード・能力・数値の順）
    const compiled = compileValueNet(net).board!;
    const granted = { ...card, g: [JSON.parse(dollLastWords) as unknown] };
    const input = boardCardInput(compiled, granted);
    expect(input.idx.slice(0, 2)).toEqual([0, v + g]);
    expect(boardCardInput(compiled, card).idx).not.toContain(v + g);
    expect(forwardValueNet(compileValueNet(net), x, undefined, [[granted], boards[1]])).not.toBe(z);
    // 大きさ違い・features の並び違い
    expect(() => compileValueNet({ ...net, w1: net.w1.slice(1) })).toThrow();
    expect(() => compileValueNet({ ...net, board: { ...board, layers: [{ w: w0.slice(1), b: [0, 0, 0] }, board.layers[1]!] } })).toThrow();
    expect(() => compileValueNet({ ...net, board: { ...board, features: [...BOARD_FEATURES].reverse() } })).toThrow();
  });
});
