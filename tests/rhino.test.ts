import { describe, expect, it } from "vitest";
import { allowAction, mulliganSwap, rhinoAgent } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import { searchRhinoLethal } from "../src/ai/rhinoLethal";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, newBoardCard, newHandCard, rngFrom, type GameState } from "../src/engine";
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
