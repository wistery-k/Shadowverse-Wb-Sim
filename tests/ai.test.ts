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
import { createSearchAgent, searchAgent, simulateOpponentTurn } from "../src/ai/search";
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

  it("中身が公開された手札は残し、条件付きで引いたカードには条件に合うカードを割り当てる", () => {
    let s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 3 });
    s = applyAction(s, legalActions(s)[0]!);
    s = applyAction(s, legalActions(s)[0]!);
    const viewer = s.active;
    const opp = viewer === 0 ? 1 : 0;
    const oppHand = s.players[opp].hand;
    oppHand[0]!.revealed = true;
    oppHand[1]!.drawnBy = { type: "spell" };
    oppHand[2]!.drawnBy = { costEq: 1 };
    const hasSpell = [...oppHand.slice(1), ...s.players[opp].deck].some((c) => ALL_CARDS.find((x) => x.id === c.cardId)!.type === "spell");
    const hasCost1 = [...oppHand.slice(1), ...s.players[opp].deck].some((c) => ALL_CARDS.find((x) => x.id === c.cardId)!.cost === 1);
    const rng = rngFrom({ rng: 5 });
    for (let i = 0; i < 20; i++) {
      const d = determinize(s, viewer, rng);
      const h = d.players[opp].hand;
      expect(h[0]!.cardId).toBe(oppHand[0]!.cardId);
      if (hasSpell) expect(ALL_CARDS.find((x) => x.id === h[1]!.cardId)!.type).toBe("spell");
      if (hasCost1) expect(ALL_CARDS.find((x) => x.id === h[2]!.cardId)!.cost).toBe(1);
      // 実験用の設定では相手の手札を実際のまま残す
      expect(determinize(s, viewer, rng, { peekOppHand: true }).players[opp].hand.map((c) => c.cardId)).toEqual(oppHand.map((c) => c.cardId));
    }
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

  it("相手のターンをビームサーチで読む設定（opponentSearch）でも最後まで打てる", () => {
    const agent = createSearchAgent({ opponentSearch: { beamWidth: 4, maxDepth: 8 } });
    const r = playMatch([agent, greedyAgent], { decks: [DEFAULT_DECKS[2]!.cards, DEFAULT_DECKS[4]!.cards], seed: 5, checkInvariants: true });
    expect(r.winner).not.toBeNull();
  }, 120_000);

  it("相手の手札を引き直して読む設定（oppHandSamples）と、実験用の相手の手札を見る設定（peekOppHand）でも最後まで打てる", () => {
    const agent = createSearchAgent({ oppHandSamples: 2, peekOppHand: true });
    const r = playMatch([agent, greedyAgent], { decks: [DEFAULT_DECKS[3]!.cards, DEFAULT_DECKS[1]!.cards], seed: 6, checkInvariants: true });
    expect(r.winner).not.toBeNull();
  }, 120_000);

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
  it("countdownDecay ではカウントダウンのアミュレットを割れたときに得るもので数え、アクトでカウントを進めると評価が上がる", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    s.phase = "main";
    s.active = 0;
    const me = s.players[0];
    me.board = [];
    me.hand = [];
    s.players[1].board = [];
    me.pp = 5;
    const w = { ...DEFAULT_WEIGHTS, countdownDecay: 0.8 };
    const empty = evaluateWith(s, 0, w);
    const vow = newBoardCard(s, id("獣姫の誓約"));
    me.board = [vow];
    // ホーリーフレイムタイガー 4/4: 4 + 3.2 + 1 = 8.2、カウント 2
    expect(evaluateWith(s, 0, w) - empty).toBeCloseTo(8.2 * 0.64);
    const t = applyAction(s, { type: "act", iid: vow.iid });
    expect(evaluateWith(t, 0, w)).toBeGreaterThan(evaluateWith(s, 0, w));
    // 穏やかなる教会（2 ドロー）は割ると評価が下がらない
    const church = newBoardCard(s, id("穏やかなる教会"));
    (church as { countdown: number | null }).countdown = 1;
    me.board = [church];
    const before = evaluateWith(s, 0, w);
    const u = applyAction(s, { type: "act", iid: church.iid });
    expect(u.players[0].board).toHaveLength(0);
    expect(evaluateWith(u, 0, w)).toBeGreaterThan(before);
  });
  it("jeanneSync では手札にジャンヌがあり、ジャンヌを出せるターンに割れるアミュレットのフォロワーを +2/+4 して数える", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    const p = s.first;
    const me = s.players[p];
    s.players[p === 0 ? 1 : 0].board = [];
    me.hand = [];
    me.turnCount = 6;
    const vow = newBoardCard(s, id("獣姫の誓約"));
    me.board = [vow];
    const w = { ...DEFAULT_WEIGHTS, countdownDecay: 0.8, jeanneSync: 1 };
    const without = evaluateWith(s, p, w);
    me.hand = [newHandCard(s, id("純白の聖女・ジャンヌ"))];
    const handOnly = evaluateWith(s, p, { ...w, jeanneSync: 0 }) - without;
    // 6 ターン目＋カウント 2 ＝ 8: タイガー 6/8 = 6 + 6.4 + 1 = 13.4（4/4 なら 8.2）
    expect(evaluateWith(s, p, w) - without - handOnly).toBeCloseTo((13.4 - 8.2) * 0.64);
    // 5 ターン目（先攻なのでエクストラPP なし）なら加点しない
    me.turnCount = 5;
    expect(evaluateWith(s, p, w)).toBeCloseTo(evaluateWith(s, p, { ...w, jeanneSync: 0 }));
  });
  it("evoReserve は EP の数まで手札の進化時能力持ちを数え、このターンに EP で進化させた進化時能力持ちも数える", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    const me = s.players[0];
    me.ep = 2;
    me.hand = [newHandCard(s, id("楽朗の天宮・フィルドア")), newHandCard(s, id("楽朗の天宮・フィルドア")), newHandCard(s, id("栄弦の天宮・リュウフウ"))];
    const w = { ...DEFAULT_WEIGHTS, evoReserve: 3 };
    // 3 枚あっても EP 2 回分まで
    expect(evaluateWith(s, 0, w) - evaluateWith(s, 0, DEFAULT_WEIGHTS)).toBeCloseTo(6);
    // 進化時能力を持たないフォロワーは数えない
    me.hand = [newHandCard(s, id("スティールナイト"))];
    expect(evaluateWith(s, 0, w)).toBeCloseTo(evaluateWith(s, 0, DEFAULT_WEIGHTS));
    // このターンに EP で進化させたのが進化時能力持ちなら 1 枚分数える（EP が残っていなくても）
    me.hand = [];
    me.ep = 0;
    me.epEvolvedThisTurn = id("楽朗の天宮・フィルドア");
    expect(evaluateWith(s, 0, w) - evaluateWith(s, 0, DEFAULT_WEIGHTS)).toBeCloseTo(3);
    me.epEvolvedThisTurn = id("スティールナイト");
    expect(evaluateWith(s, 0, w)).toBeCloseTo(evaluateWith(s, 0, DEFAULT_WEIGHTS));
  });
  it("sevoReserve は SEP の数まで手札の進化時・超進化時能力持ちを数え、このターンに超進化させた能力持ちも数える", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    const me = s.players[0];
    me.sep = 1;
    me.hand = [newHandCard(s, id("勇壮の堕天使・オリヴィエ")), newHandCard(s, id("水の守護神・サレファ"))];
    const w = { ...DEFAULT_WEIGHTS, sevoReserve: 4 };
    // 2 枚あっても SEP 1 回分まで
    expect(evaluateWith(s, 0, w) - evaluateWith(s, 0, DEFAULT_WEIGHTS)).toBeCloseTo(4);
    // 能力のないフォロワーは数えない
    me.hand = [newHandCard(s, id("壮麗なる隼"))];
    expect(evaluateWith(s, 0, w)).toBeCloseTo(evaluateWith(s, 0, DEFAULT_WEIGHTS));
    // このターンに超進化させたのが能力持ちなら 1 枚分数える（SEP が残っていなくても）
    me.hand = [];
    me.sep = 0;
    me.sepEvolvedThisTurn = id("勇壮の堕天使・オリヴィエ");
    expect(evaluateWith(s, 0, w) - evaluateWith(s, 0, DEFAULT_WEIGHTS)).toBeCloseTo(4);
    me.sepEvolvedThisTurn = id("壮麗なる隼");
    expect(evaluateWith(s, 0, w)).toBeCloseTo(evaluateWith(s, 0, DEFAULT_WEIGHTS));
  });
  it("handStorm は相手の体力が lethalRange 以下で、アクトできるアミュレットが場にあれば、次のターンに出せるグリフォンの攻撃力を数える", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 4 });
    const me = s.players[0];
    s.players[1].leaderHp = 8;
    me.maxPp = 7;
    me.hand = [newHandCard(s, id("セイクリッドグリフォン"))];
    me.board = [newBoardCard(s, id("禁密の聖地"))];
    const w = { ...DEFAULT_WEIGHTS, handStorm: 0.5 };
    expect(evaluateWith(s, 0, w) - evaluateWith(s, 0, DEFAULT_WEIGHTS)).toBeCloseTo(3);
    // 次のターンに 8 PP に届かなければ数えない
    me.maxPp = 6;
    expect(evaluateWith(s, 0, w)).toBeCloseTo(evaluateWith(s, 0, DEFAULT_WEIGHTS));
    // アクトできるアミュレットが無ければ数えない
    me.maxPp = 7;
    me.board = [];
    expect(evaluateWith(s, 0, w)).toBeCloseTo(evaluateWith(s, 0, DEFAULT_WEIGHTS));
  });
});

import { reanimateWorthwhile } from "../src/ai/search";

describe("reanimateGuard", () => {
  it("ケルベロスの超進化は、墓場にコスト 1 のフォロワーがあるときだけ打ってよい", () => {
    const s = createGame({ decks: [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards], seed: 3 });
    const p = s.active;
    const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
    const kerberos = newBoardCard(s, id("奔放なる獄炎・ケルベロス"));
    const olivier = newBoardCard(s, id("勇壮の堕天使・オリヴィエ"));
    s.players[p].board.push(kerberos, olivier);
    s.players[p].graveyardFollowers = [id("スケルトン")];
    const sevo = (iid: number) => ({ type: "superEvolve", iid }) as const;
    expect(reanimateWorthwhile(s, sevo(kerberos.iid), p)).toBe(false);
    expect(reanimateWorthwhile(s, sevo(olivier.iid), p)).toBe(true);
    s.players[p].graveyardFollowers = [id("スケルトン"), id("番犬の右腕・ミミ")];
    expect(reanimateWorthwhile(s, sevo(kerberos.iid), p)).toBe(true);
  });
});
