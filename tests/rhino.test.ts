import { describe, expect, it } from "vitest";
import { allowAction, createRhinoAgent, mulliganSwap, rhinoAgent } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import { searchRhinoLethal } from "../src/ai/rhinoLethal";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, newBoardCard, newHandCard, rngFrom, type Action, type GameState } from "../src/engine";
import { playMatch } from "../src/sim/match";

const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
const elf = DEFAULT_DECKS.find((d) => d.class === "elf")!;
const royal = DEFAULT_DECKS.find((d) => d.class === "royal")!;

/** マリガン後、エルフ（プレイヤー0）の手番の局面 */
function mainPhase(): GameState {
  let s = createGame({ decks: [elf.cards, royal.cards], seed: 1 });
  while (s.phase === "mulligan") s = applyAction(s, legalActions(s)[0]!);
  s.active = 0;
  return s;
}

function withHand(names: string[]): { s: GameState; iids: number[] } {
  const s = createGame({ decks: [elf.cards, royal.cards], seed: 1 });
  s.players[0].hand = names.map((n) => newHandCard(s, id(n)));
  return { s, iids: s.players[0].hand.map((h) => h.iid) };
}

describe("リノセウス用ルール: マリガン", () => {
  it("バックウッドと序盤のカードがあれば、それと杖1枚・メイ・リリィを残す", () => {
    const { s, iids } = withHand(["薫交の天宮・バックウッド", "聖樹の杖", "純粋なるウォーターフェアリー", "聖樹の杖"]);
    expect(mulliganSwap(s, 0)).toEqual([iids[3]]);
  });

  it("片方だけならそれだけ残し、序盤のカードは優先順に1枚まで", () => {
    const { s, iids } = withHand(["妖精の招集", "フェアリーテイマー", "聖樹の杖", "アドベンチャーエルフ・メイ"]);
    expect(mulliganSwap(s, 0)).toEqual([iids[0], iids[2], iids[3]]);
  });

  it("どちらも無ければすべて入れ替える", () => {
    const { s, iids } = withHand(["聖樹の杖", "殺戮のリノセウス", "アドベンチャーエルフ・メイ", "虫の知らせ"]);
    expect(mulliganSwap(s, 0)).toEqual(iids);
  });

  it("後攻でも、先攻の相手がエルフ以外でも、エルフのマリガンはルールで行う", () => {
    for (const elfSeat of [0, 1] as const) {
      for (const first of [0, 1] as const) {
        const decks: [string[], string[]] = elfSeat === 0 ? [elf.cards, royal.cards] : [royal.cards, elf.cards];
        let s = createGame({ decks, seed: 1 });
        s.first = first;
        s.active = first;
        s.players[elfSeat].hand = ["勇壮の堕天使・オリヴィエ", "ベビーカーバンクル", "ベビーカーバンクル", "フェアリーテイマー"].map(
          (n) => newHandCard(s, id(n)),
        );
        const tamer = s.players[elfSeat].hand[3]!.iid;
        const rng = rngFrom({ rng: 1 });
        while (s.phase === "mulligan") {
          const legal = legalActions(s);
          const a = rhinoAgent.chooseAction(s, legal, rng);
          if (a.type === "mulligan" && a.player === elfSeat) {
            expect([...a.swap].sort()).toEqual(s.players[elfSeat].hand.map((h) => h.iid).filter((x) => x !== tamer).sort());
          }
          s = applyAction(s, a);
        }
      }
    }
  });
});

describe("リノセウス用ルール: 禁じる手", () => {
  it("場の最後の杖・燐光の岩はアクトしない", () => {
    const s = mainPhase();
    const rod = newBoardCard(s, id("聖樹の杖"));
    s.players[0].board = [rod];
    expect(allowAction(s, { type: "act", iid: rod.iid }, 0)).toBe(false);
    s.players[0].board.push(newBoardCard(s, id("聖樹の杖")));
    expect(allowAction(s, { type: "act", iid: rod.iid }, 0)).toBe(true);
    const rock = newBoardCard(s, id("燐光の岩"));
    s.players[0].board = [rock];
    expect(allowAction(s, { type: "act", iid: rock.iid }, 0)).toBe(false);
  });

  it("手札に戻す等の対象に最後の杖を選ばない。杖しか選べないなら、そのカードを打たない", () => {
    const s = mainPhase();
    const pl = s.players[0];
    pl.pp = pl.maxPp = 3;
    const rod = newBoardCard(s, id("聖樹の杖"));
    const bugs = newHandCard(s, id("虫の知らせ"));
    pl.board = [rod];
    pl.hand = [bugs];
    expect(allowAction(s, { type: "play", iid: bugs.iid }, 0)).toBe(false);
    const fairy = newBoardCard(s, id("フェアリー"));
    pl.board = [rod, fairy];
    expect(allowAction(s, { type: "play", iid: bugs.iid }, 0)).toBe(true);
    const after = applyAction(s, { type: "play", iid: bugs.iid });
    expect(allowAction(after, { type: "choose", targets: [rod.iid] }, 0)).toBe(false);
    expect(allowAction(after, { type: "choose", targets: [fairy.iid] }, 0)).toBe(true);
    expect(rhinoAgent.chooseAction(after, legalActions(after), rngFrom({ rng: 1 }))).toEqual({ type: "choose", targets: [fairy.iid] });
  });

  it("2枚目の杖と燐光の岩は、相手の場にフォロワーがいないときだけ置く。森の神秘は使わない", () => {
    const s = mainPhase();
    const rod = newHandCard(s, id("聖樹の杖"));
    const rock = newHandCard(s, id("燐光の岩"));
    const mystery = newHandCard(s, id("森の神秘"));
    s.players[0].hand = [rod, rock, mystery];
    expect(allowAction(s, { type: "play", iid: rod.iid }, 0)).toBe(true); // 1枚目
    s.players[0].board = [newBoardCard(s, id("聖樹の杖"))];
    s.players[1].board = [newBoardCard(s, id("ナイト"))];
    expect(allowAction(s, { type: "play", iid: rod.iid }, 0)).toBe(false);
    expect(allowAction(s, { type: "play", iid: rock.iid }, 0)).toBe(false);
    s.players[1].board = [];
    expect(allowAction(s, { type: "play", iid: rod.iid }, 0)).toBe(true);
    expect(allowAction(s, { type: "play", iid: rock.iid }, 0)).toBe(true);
    expect(allowAction(s, { type: "play", iid: mystery.iid }, 0)).toBe(false);
  });

  it("リノセウスはリーサル以外ではプレイしない（2枚以上でも）", () => {
    const s = mainPhase();
    s.players[0].pp = s.players[0].maxPp = 5;
    const rhino = newHandCard(s, id("殺戮のリノセウス"));
    s.players[0].hand = [rhino];
    expect(allowAction(s, { type: "play", iid: rhino.iid }, 0)).toBe(false);
    s.players[0].hand.push(newHandCard(s, id("殺戮のリノセウス")));
    expect(allowAction(s, { type: "play", iid: rhino.iid }, 0)).toBe(false);
  });

  it("エクストラPP: 2つ目は使わない。1つ目は杖を置けるようになるときに使う", () => {
    const s = mainPhase();
    const pl = s.players[0];
    pl.extraPpAvailable = true;
    pl.turnCount = 2;
    pl.maxPp = 2;
    pl.pp = 2;
    pl.hand = [newHandCard(s, id("聖樹の杖"))];
    expect(allowAction(s, { type: "extraPp" }, 0)).toBe(true);
    expect(rhinoAgent.chooseAction(s, legalActions(s), rngFrom({ rng: 1 }))).toEqual({ type: "extraPp" });
    pl.hand = [newHandCard(s, id("殺戮のリノセウス"))];
    expect(allowAction(s, { type: "extraPp" }, 0)).toBe(false);
    pl.turnCount = 6;
    pl.hand = [newHandCard(s, id("聖樹の杖"))];
    expect(allowAction(s, { type: "extraPp" }, 0)).toBe(false);
  });
});

describe("リノセウス専用のリーサル探索", () => {
  it("フェアリーを当ててベイルを安くし、杖でリノセウスを戻して出し直す手順を見つける", () => {
    let s = mainPhase();
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
    me.extraPpAvailable = false;
    s.players[1].board = [newBoardCard(s, id("マナリアの学徒・ウィリアム"))];
    s.players[1].leaderHp = 11;
    const seq = searchRhinoLethal(s, 0);
    expect(seq).not.toBeNull();
    let rhinoPlays = 0;
    for (const a of seq!) {
      if (a.type === "play" && s.players[0].hand.find((h) => h.iid === a.iid)?.cardId === id("殺戮のリノセウス")) rhinoPlays++;
      s = applyAction(s, a);
    }
    expect(s.winner).toBe(0);
    expect(rhinoPlays).toBe(2); // 1回では足りない
  });

  /**
   * ユーザーの指摘（スペルウィッチ vs リノセウスエルフ、seed 2564010370、エルフの 10 ターン目）を簡単にした局面。
   * 相手の守護（式神・天后）がいると仕上げの点数がどれも 0 になり、フェアリーとテイマーを当ててベイルを安くする準備がビームで切られていた
   */
  it("守護をフェアリー・テイマー・ベイルで処理してから、リノセウスを杖で出し直す手順を見つける", () => {
    let s = mainPhase();
    const me = s.players[0];
    const bail = newHandCard(s, id("煌撃の戦士・ベイル"));
    bail.costMod = -3;
    me.hand = [newHandCard(s, id("フェアリー")), newHandCard(s, id("フェアリー")), bail, newHandCard(s, id("殺戮のリノセウス"))];
    const tamer = newBoardCard(s, id("フェアリーテイマー"));
    if (tamer.kind === "follower") tamer.enteredTurn = s.turn - 2;
    me.board = [newBoardCard(s, id("聖樹の杖")), tamer];
    me.pp = me.maxPp = 10;
    me.turnCount = 10;
    me.ep = 0;
    me.sep = 0;
    me.combo = 0;
    me.extraPpAvailable = false;
    s.players[1].board = [newBoardCard(s, id("式神・天后"))];
    s.players[1].leaderHp = 9;
    const seq = searchRhinoLethal(s, 0);
    expect(seq).not.toBeNull();
    for (const a of seq!) s = applyAction(s, a);
    expect(s.winner).toBe(0);
  });

  it("森の神秘は手札にあれば先に打つ（打ってもリーサルを逃さない）", () => {
    let s = mainPhase();
    const me = s.players[0];
    me.hand = [newHandCard(s, id("森の神秘")), newHandCard(s, id("森の神秘")), newHandCard(s, id("殺戮のリノセウス"))];
    me.pp = me.maxPp = 3;
    me.combo = 0;
    s.players[1].board = [];
    s.players[1].leaderHp = 3;
    const seq = searchRhinoLethal(s, 0)!;
    expect(seq.slice(0, 2).every((a) => a.type === "play" && a.iid !== me.hand[2]!.iid)).toBe(true);
    for (const a of seq) s = applyAction(s, a);
    expect(s.winner).toBe(0);
  });

  it("手札にリノセウスが無ければ探さない", () => {
    const s = mainPhase();
    s.players[0].hand = [newHandCard(s, id("フェアリー"))];
    expect(searchRhinoLethal(s, 0)).toBeNull();
  });
});

describe("リノセウス用ルール: 手数の多いターン", () => {
  /**
   * ユーザーの指摘（リノセウスエルフ vs アミュレット疾走ビショップ、seed 2510273090、エルフ後攻の 4 ターン目）。
   * 相手の場は楽朗の天宮・フィルドア 3/1 と鉄拳の神父 5/4。推奨はテイマー → 進化 → フェアリー 2 枚で両方を処理（7 手）。
   * 探索の深さ 6 では届かず、神父だけ処理してフィルドアを残していた
   */
  it("7 手以上かかる手順で相手のフォロワーを両方処理する", () => {
    const bishop = DEFAULT_DECKS.find((d) => d.key === "アミュレット疾走ビショップ")!;
    const log: Action[] = [{"type":"mulligan","player":1,"swap":[69,73]},{"type":"mulligan","player":0,"swap":[37]},{"type":"play","iid":41},{"type":"endTurn"},{"type":"endTurn"},{"type":"play","iid":44},{"type":"endTurn"},{"type":"play","iid":18},{"type":"endTurn"},{"type":"play","iid":52},{"type":"act","iid":52},{"type":"attack","attacker":44,"target":18},{"type":"endTurn"},{"type":"play","iid":30},{"type":"endTurn"},{"type":"play","iid":61},{"type":"attack","attacker":44,"target":"leader"},{"type":"endTurn"}];
    let s = createGame({ decks: [elf.cards, bishop.cards], seed: 2510273090 });
    for (const a of log) s = applyAction(s, a);
    const rng = rngFrom({ rng: 1 });
    while (s.phase === "main" && s.active === 0) s = applyAction(s, rhinoAgent.chooseAction(s, legalActions(s), rng));
    expect(s.players[1].board.filter((c) => c.kind === "follower")).toEqual([]);
  }, 30_000);
});

describe("リノセウス用ルール: seed 1678126716（アミュレット疾走ビショップ vs リノセウスエルフ、エルフ後攻）", () => {
  // ユーザーが指摘した試合の、エルフの 7 ターン目の 2 手目までの行動（PR #21 時点の AI の手）
  const log: Action[] = [{"type":"mulligan","player":1,"swap":[43,77,67,66]},{"type":"mulligan","player":0,"swap":[34]},{"type":"endTurn"},{"type":"extraPp"},{"type":"play","iid":4},{"type":"endTurn"},{"type":"play","iid":58},{"type":"endTurn"},{"type":"play","iid":15},{"type":"attack","attacker":4,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":71},{"type":"attack","attacker":58,"target":4},{"type":"endTurn"},{"type":"play","iid":9},{"type":"endTurn"},{"type":"play","iid":54},{"type":"play","iid":49},{"type":"play","iid":46},{"type":"choose","targets":[54]},{"type":"endTurn"},{"type":"play","iid":21},{"type":"evolve","iid":21},{"type":"endTurn"},{"type":"play","iid":81},{"type":"play","iid":82},{"type":"play","iid":64},{"type":"choose","targets":[21]},{"type":"play","iid":83},{"type":"attack","attacker":81,"target":21},{"type":"evolve","iid":64},{"type":"attack","attacker":64,"target":86},{"type":"endTurn"},{"type":"play","iid":12},{"type":"play","iid":6},{"type":"act","iid":12},{"type":"evolve","iid":6},{"type":"choose","targets":[64]},{"type":"attack","attacker":6,"target":82},{"type":"endTurn"},{"type":"play","iid":80},{"type":"play","iid":68},{"type":"evolve","iid":68},{"type":"attack","attacker":83,"target":"leader"},{"type":"attack","attacker":68,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":31},{"type":"act","iid":31},{"type":"endTurn"},{"type":"play","iid":84}];
  const bishop = DEFAULT_DECKS.find((d) => d.key === "アミュレット疾走ビショップ")!;
  const stateAt = (n: number) => {
    let s = createGame({ decks: [bishop.cards, elf.cards], seed: 1678126716 });
    for (const a of log.slice(0, n)) s = applyAction(s, a);
    return s;
  };
  const names = (cards: readonly { cardId: string }[]) => cards.map((c) => ALL_CARDS.find((x) => x.id === c.cardId)!.name);

  it("6 ターン目: リーサルでなければ、手札に1枚のリノセウスは出さない", () => {
    let s = stateAt(40);
    expect(names(s.players[1].hand).filter((n) => n === "殺戮のリノセウス")).toHaveLength(1);
    const rng = rngFrom({ rng: 1 });
    while (s.phase === "main" && s.active === 1) s = applyAction(s, rhinoAgent.chooseAction(s, legalActions(s), rng));
    expect(names(s.players[1].hand)).toContain("殺戮のリノセウス");
  }, 30_000);

  /**
   * 7 ターン目（相手の場にフォロワーなし）。フェアリーの後に燐光の岩を出すとコンボ 2 で森の神秘が加わらない。
   * 以前はビームで、手の順番が違うだけの局面（加わったフェアリーの iid が違う）がまとまらず枠を埋め、岩を 2 手目に出していた
   */
  it("7 ターン目: フェアリーの次に燐光の岩を出さない", () => {
    const s = stateAt(50);
    expect(s.players[1].combo).toBe(1);
    const a = rhinoAgent.chooseAction(s, legalActions(s), rngFrom({ rng: 1 }));
    expect(a.type === "play" && names(s.players[1].hand.filter((h) => h.iid === a.iid))[0]).not.toBe("燐光の岩");
  }, 30_000);
});

describe("seed 954874822（リノセウスエルフ vs アミュレット疾走ビショップ、エルフ先攻）", () => {
  // ユーザーが指摘した試合の、エルフの 7 ターン目の開始までの行動（ビショップは探索 AI、エルフはリノセウス用 AI。選択をまとめる前の AI の手）
  const log: Action[] = [{"type":"mulligan","player":0,"swap":[3,27,6]},{"type":"mulligan","player":1,"swap":[]},{"type":"play","iid":2},{"type":"endTurn"},{"type":"endTurn"},{"type":"play","iid":14},{"type":"attack","attacker":2,"target":"leader"},{"type":"endTurn"},{"type":"extraPp"},{"type":"play","iid":56},{"type":"act","iid":56},{"type":"choose","targets":[2]},{"type":"endTurn"},{"type":"play","iid":32},{"type":"attack","attacker":14,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":49},{"type":"endTurn"},{"type":"play","iid":81},{"type":"play","iid":9},{"type":"play","iid":82},{"type":"play","iid":83},{"type":"attack","attacker":81,"target":49},{"type":"attack","attacker":14,"target":"leader"},{"type":"attack","attacker":82,"target":49},{"type":"endTurn"},{"type":"play","iid":62},{"type":"evolve","iid":62},{"type":"choose","targets":[14]},{"type":"attack","attacker":62,"target":83},{"type":"endTurn"},{"type":"play","iid":35},{"type":"evolve","iid":35},{"type":"endTurn"},{"type":"play","iid":51},{"type":"play","iid":55},{"type":"act","iid":55},{"type":"endTurn"},{"type":"play","iid":36},{"type":"attack","attacker":35,"target":"leader"},{"type":"endTurn"},{"type":"superEvolve","iid":86},{"type":"play","iid":64},{"type":"attack","attacker":86,"target":35},{"type":"act","iid":51},{"type":"choose","targets":[86]},{"type":"endTurn"}];
  const bishop = DEFAULT_DECKS.find((d) => d.key === "アミュレット疾走ビショップ")!;
  const stateAt = (n: number) => {
    let s = createGame({ decks: [elf.cards, bishop.cards], seed: 954874822 });
    for (const a of log.slice(0, n)) s = applyAction(s, a);
    return s;
  };
  const name = (s: GameState, iid: number) => ALL_CARDS.find((c) => c.id === s.players.flatMap((pl) => [...pl.hand, ...pl.board]).find((x) => x.iid === iid)!.cardId)!.name;
  /** p のターンを agent で最後まで進め、打った手（プレイしたカード名か手の種類）と最後の局面を返す */
  const playTurn = (s: GameState, p: 0 | 1, agent: typeof searchAgent) => {
    const rng = rngFrom({ rng: 2 });
    const moves: { move: string; combo: number }[] = [];
    while (s.phase === "main" && (s.pending ? s.pending.player : s.active) === p) {
      const a = agent.chooseAction(s, legalActions(s), rng);
      moves.push({ move: a.type === "play" ? name(s, a.iid) : a.type, combo: s.players[p].combo });
      s = applyAction(s, a);
    }
    return { moves, end: s };
  };
  const oppFollowers = (s: GameState, p: 0 | 1) => s.players[p === 0 ? 1 : 0].board.filter((c) => c.kind === "follower");

  /**
   * ビショップの 6 ターン目。推奨はエクストラPP → オリヴィエ → 超進化（タイガーも超進化）で、バックウッドとアリアを両方処理する。
   * 以前はエクストラPP が 1 手分の深さを使い、その時点の点数が低いためビームで切られていた
   */
  it("ビショップ 6 ターン目: エクストラPP でオリヴィエを出し、相手のフォロワーを両方処理する", () => {
    const { moves, end } = playTurn(stateAt(41), 1, searchAgent);
    expect(moves.map((m) => m.move)).toContain("extraPp");
    expect(moves.map((m) => m.move)).toContain("勇壮の堕天使・オリヴィエ");
    expect(oppFollowers(end, 1)).toEqual([]);
  }, 30_000);

  /**
   * エルフの 7 ターン目。推奨はフェアリー → ベビーカーバンクル（フェアリーを戻す）→ リリィ（コンボ 3 でタイガーを体力 1）→ リリィ進化でタイガー → 舞い踊る妖精 → リリィでサレファ。
   * 以前は選択も 1 手分の深さを使い（推奨は 10 手）、コンボを稼ぐ途中の点数が低いため幅 8 のビームで切られていた
   */
  it("エルフ 7 ターン目: コンボ 3 でリリィを出し、タイガーとサレファを処理する", () => {
    const { moves, end } = playTurn(stateAt(47), 0, rhinoAgent);
    // このターンに勝てばよい（合流する相打ちの扱い（settleTrades）を入れてから、このターンのリーサルを見つけるようになった）
    if (end.phase === "ended") {
      expect(end.winner).toBe(0);
      return;
    }
    expect(moves.find((m) => m.move === "ピュアクリスタリア・リリィ")!.combo).toBeGreaterThanOrEqual(2);
    expect(oppFollowers(end, 0)).toEqual([]);
  }, 60_000);
});

describe("seed 2275116772（リノセウスエルフ vs アミュレット疾走ビショップ、エルフ先攻）", () => {
  // ユーザーが指摘した試合の、エルフの 7 ターン目の開始までの行動（両方ともリノセウス用 AI）
  const log: Action[] = [{"type":"mulligan","player":0,"swap":[18,1,7]},{"type":"mulligan","player":1,"swap":[73,78,72]},{"type":"play","iid":3},{"type":"endTurn"},{"type":"play","iid":43},{"type":"endTurn"},{"type":"play","iid":14},{"type":"attack","attacker":3,"target":"leader"},{"type":"endTurn"},{"type":"extraPp"},{"type":"play","iid":56},{"type":"act","iid":56},{"type":"choose","targets":[3]},{"type":"endTurn"},{"type":"play","iid":12},{"type":"play","iid":81},{"type":"play","iid":82},{"type":"attack","attacker":14,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":55},{"type":"act","iid":55},{"type":"endTurn"},{"type":"play","iid":7},{"type":"play","iid":83},{"type":"attack","attacker":14,"target":"leader"},{"type":"attack","attacker":12,"target":"leader"},{"type":"attack","attacker":81,"target":"leader"},{"type":"attack","attacker":82,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":50},{"type":"act","iid":50},{"type":"evolve","iid":85},{"type":"play","iid":41},{"type":"attack","attacker":85,"target":14},{"type":"endTurn"},{"type":"play","iid":35},{"type":"attack","attacker":12,"target":"leader"},{"type":"evolve","iid":35},{"type":"attack","attacker":81,"target":"leader"},{"type":"attack","attacker":82,"target":"leader"},{"type":"attack","attacker":83,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":45},{"type":"evolve","iid":45},{"type":"choose","targets":[35]},{"type":"act","iid":50},{"type":"play","iid":51},{"type":"attack","attacker":45,"target":81},{"type":"endTurn"},{"type":"play","iid":38},{"type":"evolve","iid":12},{"type":"attack","attacker":12,"target":"leader"},{"type":"play","iid":25},{"type":"attack","attacker":82,"target":"leader"},{"type":"attack","attacker":83,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":70},{"type":"act","iid":70},{"type":"endTurn"}];
  const bishop = DEFAULT_DECKS.find((d) => d.key === "アミュレット疾走ビショップ")!;
  const start = () => {
    let s = createGame({ decks: [elf.cards, bishop.cards], seed: 2275116772 });
    for (const a of log) s = applyAction(s, a);
    return s;
  };
  const name = (s: GameState, iid: number) => ALL_CARDS.find((c) => c.id === s.players[0].hand.find((h) => h.iid === iid)!.cardId)!.name;
  /** エルフのターンを最後まで進め、プレイしたカード名とその時点のコンボを返す */
  const playTurn = (agent: typeof rhinoAgent, seed = 1) => {
    let s = start();
    const rng = rngFrom({ rng: seed });
    const plays: { card: string; combo: number }[] = [];
    while (s.phase === "main" && (s.pending ? s.pending.player : s.active) === 0) {
      const a = agent.chooseAction(s, legalActions(s), rng);
      if (a.type === "play") plays.push({ card: name(s, a.iid), combo: s.players[0].combo });
      s = applyAction(s, a);
    }
    return plays;
  };

  /**
   * 7 ターン目（PP 7・SEP 2、相手は体力 8 で場にフォロワーなし）。アリア → 超進化 → フェアリーで顔 4 点にすると、
   * クレストで疾走の付くフェアリーで次のターンに倒しきれる（相手のターン後に 4 割強。テイマーの手は 1 割強）
   */
  it("7 ターン目: 次のターンのリーサルを見て、アリアを出す（nextLethal）", () => {
    expect(start().players[0].combo).toBe(0);
    for (const seed of [1, 2, 3]) expect(playTurn(createRhinoAgent({ nextLethal: 10 }), seed).map((x) => x.card)).toContain("自然の妖精姫・アリア");
  }, 60_000);

  /** テイマーの並びがビームで切られず、燐光の岩はコンボ 2 以上で出す（森の神秘が加わる） */
  it("7 ターン目: 燐光の岩はコンボ 2 以上で出す（perFirst）", () => {
    for (const p of playTurn(rhinoAgent).filter((x) => x.card === "燐光の岩")) expect(p.combo).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe("リノセウス用ルール: 対戦", () => {
  it("不変条件を破らずに対戦を終える", () => {
    for (const [seed, seat] of [
      [1, 0],
      [2, 1],
    ] as const) {
      const decks: [string[], string[]] = seat === 0 ? [elf.cards, royal.cards] : [royal.cards, elf.cards];
      playMatch(seat === 0 ? [rhinoAgent, searchAgent] : [searchAgent, rhinoAgent], { decks, seed, checkInvariants: true });
    }
  }, 60_000);
});
