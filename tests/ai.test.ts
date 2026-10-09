import { describe, expect, it } from "vitest";
import { greedyAgent } from "../src/ai/greedy";
import { randomAgent } from "../src/ai/random";
import { rngFrom } from "../src/engine";
import { randomDeck } from "../src/sim/decks";
import { playMatch } from "../src/sim/match";

const CLASSES = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"] as const;

describe("AI", () => {
  it("貪欲法の AI はランダムの AI に大きく勝ち越す", () => {
    let wins = 0;
    const games = 20;
    for (let seed = 1; seed <= games; seed++) {
      const rng = rngFrom({ rng: seed });
      const decks: [string[], string[]] = [randomDeck(CLASSES[seed % 7]!, rng), randomDeck(CLASSES[(seed + 3) % 7]!, rng)];
      const result = playMatch([greedyAgent, randomAgent], { decks, seed, checkInvariants: true });
      if (result.winner === 0) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(16);
  });
});

import { determinize } from "../src/ai/determinize";
import { searchAgent, simulateOpponentTurn } from "../src/ai/search";
import { rhinoAgent } from "../src/ai/rhino";
import { applyAction, createGame, legalActions, newBoardCard, newHandCard, type GameState } from "../src/engine";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";

describe("determinization", () => {
  it("自分の手札と場はそのまま、相手の手札と山札は未公開カードの並べ直し、トークンは残す", () => {
    let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 3 });
    s = applyAction(s, legalActions(s)[0]!);
    s = applyAction(s, legalActions(s)[0]!);
    const viewer = s.active;
    const opp = viewer === 0 ? 1 : 0;
    const fairy = ALL_CARDS.find((c) => c.name === "フェアリー")!.id;
    s.players[opp].hand.push(newHandCard(s, fairy));
    const hidden = (st: typeof s) =>
      [...st.players[opp].hand.filter((h) => h.cardId !== fairy), ...st.players[opp].deck].map((c) => c.cardId).sort();

    const rng = rngFrom({ rng: 1 });
    const d = determinize(s, viewer, rng);
    expect(d.players[viewer].hand).toEqual(s.players[viewer].hand);
    expect(d.players[viewer].board).toEqual(s.players[viewer].board);
    expect(d.players[viewer].deck.map((c) => c.cardId).sort()).toEqual(s.players[viewer].deck.map((c) => c.cardId).sort());
    expect(d.players[opp].hand.map((h) => h.iid)).toEqual(s.players[opp].hand.map((h) => h.iid));
    expect(d.players[opp].hand.at(-1)?.cardId).toBe(fairy);
    expect(hidden(d)).toEqual(hidden(s));
    expect(d.rng).not.toBe(s.rng);
    // 元の局面は変更しない
    expect(determinize(s, viewer, rngFrom({ rng: 1 }))).toEqual(d);
  });
});

describe("探索 AI", () => {
  it("不変条件を破らずに対戦を終え、貪欲法 AI に勝ち越す", () => {
    let wins = 0;
    for (let g = 0; g < 8; g++) {
      const i = g % 7;
      const j = (g * 3 + 1) % 7;
      const searchSeat = g % 2;
      const decks: [string[], string[]] = [DEFAULT_DECKS[i]!.cards, DEFAULT_DECKS[j]!.cards];
      const r = playMatch(searchSeat === 0 ? [searchAgent, greedyAgent] : [greedyAgent, searchAgent], {
        decks,
        seed: 100 + g,
        checkInvariants: true,
      });
      if (r.winner === searchSeat) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("能力の選択待ちの途中の局面からも、選択を済ませて相手のターンまで読む", () => {
    // 自分の選択待ちが残った局面を対戦の中から探す
    let found = false;
    for (let seed = 1; seed <= 20 && !found; seed++) {
      let state = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed });
      const rng = rngFrom({ rng: seed });
      while (state.phase !== "ended") {
        const p = state.active;
        if (state.phase === "main" && state.pending?.player === p) {
          const after = simulateOpponentTurn(state, p, rngFrom({ rng: seed }));
          if (after.phase !== "ended") {
            expect(after.pending).toBeNull();
            expect(after.active).toBe(p);
            expect(after.turn).toBe(state.turn + 2);
          }
          found = true;
          break;
        }
        state = applyAction(state, greedyAgent.chooseAction(state, legalActions(state), rng));
      }
    }
    expect(found).toBe(true);
  });

  /** ロイヤルの 8 ターン目（PP 8・SEP 2）。相手は体力 20 で場に opp を置く */
  function genoTurn(opts: { genoInHand: boolean; opp: string[] }) {
    const royal = DEFAULT_DECKS.find((d) => d.name === "アマリアロイヤル")!;
    const dragon = DEFAULT_DECKS.find((d) => d.name === "ランプドラゴン")!;
    let s = createGame({ decks: [royal.cards, dragon.cards], seed: 1 });
    s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
    s = applyAction(s, { type: "mulligan", player: s.first === 0 ? 1 : 0, swap: [] });
    while (!(s.active === 0 && s.players[0].turnCount >= 8)) s = applyAction(s, { type: "endTurn" });
    const [me, opp] = s.players;
    me.board = [];
    opp.board = [];
    me.hand = [];
    // 前のターンから場にいるフォロワー
    const follower = (cardId: string) => {
      const c = newBoardCard(s, cardId);
      if (c.kind !== "follower") throw new Error(`フォロワーではありません: ${cardId}`);
      return { ...c, enteredTurn: 0 };
    };
    const geno = id("レヴィオンアックス・ジェノ");
    if (opts.genoInHand) me.hand.push(newHandCard(s, geno));
    else me.board.push(follower(geno));
    for (const name of opts.opp) opp.board.push(follower(id(name)));
    return s;
  }

  /** 探索 AI でターンの終わりまで打ち、打った手を返す */
  function playTurn(state: GameState) {
    let s = state;
    const rng = rngFrom({ rng: 7 });
    const actions = [];
    for (let i = 0; i < 20 && s.phase !== "ended" && (s.pending ? s.pending.player : s.active) === 0; i++) {
      const a = searchAgent.chooseAction(s, legalActions(s), rng);
      actions.push(a);
      if (a.type === "endTurn") break;
      s = applyAction(s, a);
    }
    return actions;
  }

  it("超進化しなくても倒せる相手には、ジェノを超進化しない", () => {
    // ジェノ（7/6、2 回攻撃）で激震のゴリアテ（4/5）と異端の侍を倒せる
    const actions = playTurn(genoTurn({ genoInHand: true, opp: ["激震のゴリアテ", "異端の侍"] }));
    expect(actions.filter((a) => a.type === "attack")).toHaveLength(2);
    expect(actions.some((a) => a.type === "superEvolve")).toBe(false);
  });

  it("超進化すれば倒せる大型がいれば、ジェノを超進化する", () => {
    // 守護の激震のゴリアテを倒した後、キャラバンマンモス（10/10）は超進化した 10 点でないと倒せない
    const actions = playTurn(genoTurn({ genoInHand: false, opp: ["激震のゴリアテ", "キャラバンマンモス"] }));
    expect(actions.some((a) => a.type === "superEvolve")).toBe(true);
  });
});

import { findLethal, searchLethal } from "../src/ai/lethal";

describe("リーサルの探索", () => {
  function rhinoceusPosition() {
    let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    s = applyAction(s, legalActions(s)[0]!);
    s = applyAction(s, legalActions(s)[0]!);
    const me = s.active;
    const opp = me === 0 ? 1 : 0;
    const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
    s.players[me].hand = [newHandCard(s, id("殺戮のリノセウス")), newHandCard(s, id("森の神秘")), newHandCard(s, id("森の神秘"))];
    s.players[me].pp = s.players[me].maxPp = 3;
    s.players[opp].leaderHp = 3;
    return { s, me, rhinoceus: s.players[me].hand[0]!.iid };
  }

  it("コンボを稼いでからリノセウスで倒す並びを見つける", () => {
    const { s, me, rhinoceus } = rhinoceusPosition();
    const seq = searchLethal(s, me);
    expect(seq).not.toBeNull();
    // リノセウスを先に出すと1点しか出ないので、最初の手は森の神秘
    expect(seq![0]).not.toEqual({ type: "play", iid: rhinoceus });
    let t = s;
    for (const a of seq!) t = applyAction(t, a);
    expect(t.winner).toBe(me);
  });

  it("勝てなければ null を返す", () => {
    const { s, me } = rhinoceusPosition();
    s.players[me === 0 ? 1 : 0].leaderHp = 4;
    expect(searchLethal(s, me)).toBeNull();
    expect(findLethal(s, me, rngFrom({ rng: 1 }))).toBeNull();
  });

  /**
   * ユーザーの指摘（リノセウスエルフ vs スペルウィッチ、seed 2120563865 の 8 ターン目）を元にした局面。
   * フェアリー2体をウィリアム（守護なし）に当てて煌撃の戦士・ベイルを 0 コストにし、コンボを溜めてリノセウスで殴り、
   * 聖樹の杖のアクトでリノセウスを手札に戻して出し直し、超進化して殴ると 4 + 8 = 12 点
   */
  function bailPosition() {
    const elf = DEFAULT_DECKS.find((d) => d.class === "elf")!;
    const witch = DEFAULT_DECKS.find((d) => d.class === "witch")!;
    let s = createGame({ decks: [elf.cards, witch.cards], seed: 1 });
    while (s.phase === "mulligan") s = applyAction(s, legalActions(s)[0]!);
    const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
    s.active = 0;
    const me = s.players[0];
    const bail = newHandCard(s, id("煌撃の戦士・ベイル"));
    bail.costMod = -6;
    me.hand = [newHandCard(s, id("フェアリー")), newHandCard(s, id("フェアリー")), bail, newHandCard(s, id("殺戮のリノセウス"))];
    me.board = [newBoardCard(s, id("聖樹の杖"))];
    me.pp = me.maxPp = 8;
    me.turnCount = 8;
    me.ep = 0;
    me.sep = 1;
    me.combo = 0;
    s.players[1].board = [newBoardCard(s, id("マナリアの学徒・ウィリアム"))];
    s.players[1].leaderHp = 11;
    return s;
  }

  it("守護でないフォロワーに当てて安くし、リノセウスを出し直す並びを見つける", () => {
    const s = bailPosition();
    const seq = searchLethal(s, 0);
    expect(seq).not.toBeNull();
    let t = s;
    for (const a of seq!) t = applyAction(t, a);
    expect(t.winner).toBe(0);
  });

  it("見つけたリーサルの手順を途中で探し直さずに最後まで打つ", () => {
    const rng = rngFrom({ rng: 2 });
    for (const agent of [searchAgent, rhinoAgent]) {
      let s = bailPosition();
      while (s.phase !== "ended" && s.active === 0) s = applyAction(s, agent.chooseAction(s, legalActions(s), rng));
      expect(s.winner).toBe(0);
    }
  });

  it("探索 AI はリーサルを取りこぼさない", () => {
    let { s, me } = rhinoceusPosition();
    while (s.phase !== "ended" && s.active === me) s = applyAction(s, searchAgent.chooseAction(s, legalActions(s), rngFrom({ rng: 2 })));
    expect(s.winner).toBe(me);
  });
});

import { DEFAULT_WEIGHTS, SEARCH_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { id } from "../src/cards/abilities/helpers";
import { deckClassOf, weightsForClass } from "../src/ai/weights";

describe("評価関数の重み", () => {
  it("クラスの重みは基準の重みに差分を重ねる", () => {
    const table = { elf: { myHp: 2, hold: { x: 1 } } };
    const w = weightsForClass("elf", table);
    expect(w.myHp).toBe(2);
    expect(w.oppHp).toBe(DEFAULT_WEIGHTS.oppHp);
    expect(w.hold).toEqual({ x: 1 });
    expect(weightsForClass("royal", table)).toBe(DEFAULT_WEIGHTS);
  });

  it("デッキのクラスを判定し、手札に持っておく価値を評価に加える", () => {
    let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    expect(deckClassOf(s, 0)).toBe(DEFAULT_DECKS[0]!.class);
    expect(deckClassOf(s, 1)).toBe(DEFAULT_DECKS[1]!.class);
    const card = s.players[0].hand[0]!.cardId;
    const base = evaluateWith(s, 0, DEFAULT_WEIGHTS);
    expect(evaluateWith(s, 0, { ...DEFAULT_WEIGHTS, hold: { [card]: 3 } })).toBeGreaterThanOrEqual(base + 3);
  });

  it("探索 AI の重みでは、竜の啓示で PP 最大値を増やすと評価が上がる", () => {
    const dragon = DEFAULT_DECKS.find((d) => d.class === "dragon")!;
    const s = createGame({ decks: [dragon.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    s.phase = "main";
    s.active = 0;
    const me = s.players[0];
    me.maxPp = 3;
    me.pp = 3;
    const card = newHandCard(s, id("竜の啓示"));
    me.hand = [card];
    const t = applyAction(s, { type: "play", iid: card.iid });
    expect(t.players[0].maxPp).toBe(4);
    expect(evaluateWith(t, 0, SEARCH_WEIGHTS)).toBeGreaterThan(evaluateWith(s, 0, SEARCH_WEIGHTS));
    expect(evaluateWith(t, 0, DEFAULT_WEIGHTS)).toBeLessThan(evaluateWith(s, 0, DEFAULT_WEIGHTS));
  });

  it("探索 AI の重みでは、融合で手札の枚数が減っても評価が下がらない", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    s.phase = "main";
    s.active = 0;
    const hand = s.players[0].hand;
    hand.length = 0;
    const attack = newHandCard(s, id("アタックアーティファクト"));
    const castle = newHandCard(s, id("キャッスルアーティファクト"));
    hand.push(attack, castle);
    const before = evaluateWith(s, 0, SEARCH_WEIGHTS);
    // アタック（素材のコスト 3）→ デストロイアーティファクトγ
    const t = applyAction(s, { type: "fuse", host: attack.iid, materials: [castle.iid] });
    expect(t.players[0].hand.map((h) => h.cardId)).toEqual([id("デストロイアーティファクトγ")]);
    expect(evaluateWith(t, 0, SEARCH_WEIGHTS)).toBeGreaterThanOrEqual(before);
    expect(evaluateWith(t, 0, DEFAULT_WEIGHTS)).toBeLessThan(evaluateWith(s, 0, DEFAULT_WEIGHTS));
  });
});
