import { describe, expect, it } from "vitest";
import { think } from "../src/ai/think";
import { ALL_CRESTS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { createGame, legalActions, type GameState } from "../src/engine";
import { branchPlayout } from "../src/sim/branch";
import {
  addCrest,
  addToBoard,
  addToDeck,
  addToHand,
  edit,
  editBlocker,
  editFollower,
  exportSandbox,
  findCard,
  importSandbox,
  moveCard,
  newSandbox,
  removeFromDeck,
  SandboxError,
  sandboxProblems,
  setEvolve,
  setTurn,
} from "../src/sim/sandbox";

const decks: [string[], string[]] = [[...DEFAULT_DECKS[0]!.cards], [...DEFAULT_DECKS[1]!.cards]];
/** 能力のないフォロワー（7 コスト 10/10） */
const VANILLA = "10002120";
const SPELL = "10012310";

const total = (s: GameState, p: 0 | 1) => s.players[p].deck.length + s.players[p].hand.length + s.players[p].board.length;
const last = <T>(xs: readonly T[]): T => xs[xs.length - 1]!;

describe("サンドボックス", () => {
  it("新しい局面は指定した先攻の 1 ターン目のメインフェイズで、編集できる", () => {
    for (const first of [0, 1] as const) {
      const s = newSandbox(decks, first, 123);
      expect(s.phase).toBe("main");
      expect(s.first).toBe(first);
      expect(s.active).toBe(first);
      expect(s.turn).toBe(1);
      expect(editBlocker(s)).toBeNull();
      expect(sandboxProblems(s)).toEqual([]);
    }
    expect(editBlocker(createGame({ decks, seed: 1 }))).not.toBeNull();
  });

  it("ターンの初めにする: 全体のターン・両者のターン数・PP を先攻・後攻から合わせる", () => {
    const s0 = newSandbox(decks, 0, 1);
    const s = setTurn(s0, 1, 5, true);
    expect(s.active).toBe(1);
    expect(s.turn).toBe(10);
    expect(s.players.map((p) => p.turnCount)).toEqual([5, 5]);
    expect(s.players.map((p) => p.maxPp)).toEqual([5, 5]);
    expect(s.players[1].pp).toBe(5);
    expect(sandboxProblems(s)).toEqual([]);
    const t = setTurn(s0, 0, 12, true);
    expect(t.turn).toBe(23);
    expect(t.players.map((p) => p.turnCount)).toEqual([12, 11]);
    expect(t.players.map((p) => p.maxPp)).toEqual([10, 10]);
    // 元の局面は変えない
    expect(s0.turn).toBe(1);
    expect(() => setTurn(s0, 0, 0, true)).toThrow(SandboxError);
  });

  it("場に置いたフォロワーは攻撃でき、進化できるターンなら進化が打てる手に入る", () => {
    let s = setTurn(newSandbox(decks, 0, 2), 1, 4, true);
    s = addToBoard(s, 1, VANILLA, false);
    const iid = last(s.players[1].board).iid;
    const legal = legalActions(s);
    expect(legal).toContainEqual({ type: "attack", attacker: iid, target: "leader" });
    expect(legal).toContainEqual({ type: "evolve", iid });
    // 「このターンに出た」にするとリーダーには攻撃できない
    const sick = editFollower(s, iid, (c) => (c.enteredTurn = s.turn));
    expect(legalActions(sick)).not.toContainEqual({ type: "attack", attacker: iid, target: "leader" });
    expect(sandboxProblems(s)).toEqual([]);
  });

  it("山札から取る・新しく作る・山札に足す・山札から抜く", () => {
    const s = newSandbox(decks, 0, 3);
    const cardId = s.players[0].deck[5]!.cardId;
    const taken = addToHand(s, 0, cardId, true);
    expect(taken.players[0].deck.length).toBe(s.players[0].deck.length - 1);
    expect(total(taken, 0)).toBe(total(s, 0));
    expect(last(taken.players[0].hand).cardId).toBe(cardId);
    const made = addToHand(s, 0, VANILLA, true);
    // 山札にないカードは新しく作る
    expect(made.players[0].deck.length).toBe(s.players[0].deck.length);
    expect(total(made, 0)).toBe(total(s, 0) + 1);
    const added = addToDeck(s, 1, VANILLA);
    expect(added.players[1].deck[0]!.cardId).toBe(VANILLA);
    expect(removeFromDeck(added, 1, VANILLA).players[1].deck.length).toBe(s.players[1].deck.length);
    expect(() => removeFromDeck(s, 1, VANILLA)).toThrow(SandboxError);
    for (const x of [taken, made, added]) expect(sandboxProblems(x)).toEqual([]);
  });

  it("手札・場のカードを移す", () => {
    let s = newSandbox(decks, 0, 4);
    s = addToHand(s, 0, VANILLA, false);
    const iid = last(s.players[0].hand).iid;
    const onBoard = moveCard(s, iid, "board");
    expect(findCard(onBoard, iid)?.zone).toBe("board");
    const back = moveCard(onBoard, iid, "hand");
    expect(findCard(back, iid)?.zone).toBe("hand");
    // 場から戻ったカードは相手にも分かる
    expect(back.players[0].hand.find((h) => h.iid === iid)?.revealed).toBe(true);
    const dead = moveCard(onBoard, iid, "graveyard");
    expect(findCard(dead, iid)).toBeNull();
    expect(dead.players[0].graveyard).toBe(s.players[0].graveyard + 1);
    expect(dead.players[0].graveyardFollowers).toContain(VANILLA);
    const toDeck = moveCard(s, iid, "deck");
    expect(findCard(toDeck, iid)?.zone).toBe("deck");
    for (const x of [onBoard, back, dead, toDeck]) expect(sandboxProblems(x)).toEqual([]);
  });

  it("上限やスペルは場・手札に置けない", () => {
    let s = newSandbox(decks, 0, 5);
    expect(() => addToBoard(s, 0, SPELL, false)).toThrow(SandboxError);
    for (let i = 0; i < 5; i++) s = addToBoard(s, 0, VANILLA, false);
    expect(() => addToBoard(s, 0, VANILLA, false)).toThrow(SandboxError);
    while (s.players[1].hand.length < 9) s = addToHand(s, 1, VANILLA, false);
    expect(() => addToHand(s, 1, VANILLA, false)).toThrow(SandboxError);
    expect(sandboxProblems(s)).toEqual([]);
  });

  it("進化の状態を変えると攻撃力・体力を進化の分だけ増減する", () => {
    let s = addToBoard(newSandbox(decks, 0, 6), 0, VANILLA, false);
    const iid = last(s.players[0].board).iid;
    const stats = (x: GameState) => {
      const c = findCard(x, iid)!.card;
      return c && "attack" in c ? [c.attack, c.defense, c.maxDefense, c.evolve] : null;
    };
    s = setEvolve(s, iid, "evolved");
    expect(stats(s)).toEqual([12, 12, 12, "evolved"]);
    s = setEvolve(s, iid, "superEvolved");
    expect(stats(s)).toEqual([13, 13, 13, "superEvolved"]);
    s = setEvolve(s, iid, "none");
    expect(stats(s)).toEqual([10, 10, 10, "none"]);
  });

  it("クレストを足した局面もエンジンが読める", () => {
    const s = addCrest(newSandbox(decks, 0, 7), 1, ALL_CRESTS[1]!.id);
    expect(s.players[1].crests).toHaveLength(1);
    expect(sandboxProblems(s)).toEqual([]);
  });

  it("書き出したテキストを読み込むと同じ局面になり、読めないものはエラー", () => {
    const s = addToBoard(setTurn(newSandbox(decks, 1, 8), 0, 6, true), 0, VANILLA, false);
    const t = importSandbox(exportSandbox(s));
    expect(legalActions(t)).toEqual(legalActions(s));
    expect(importSandbox(exportSandbox(t))).toEqual(t);
    // GameState の JSON そのままでも読める
    expect(importSandbox(JSON.stringify(s))).toEqual(t);
    expect(() => importSandbox("{")).toThrow(SandboxError);
    expect(() => importSandbox('{"phase":"main"}')).toThrow(SandboxError);
  });

  it("編集した局面で AI が考え、打ち比べられる。公開した相手の手札は並べ直さない", () => {
    let s = setTurn(newSandbox(decks, 0, 9), 0, 6, true);
    s = addToBoard(s, 0, VANILLA, false);
    s = addToHand(s, 1, VANILLA, false);
    const revealed = last(s.players[1].hand).iid;
    s = edit(s, (x) => {
      for (const h of x.players[1].hand) h.revealed = h.iid === revealed;
    });
    const t = think("search", s, 3);
    expect(t).not.toBeNull();
    for (const root of t!.roots) expect(root.players[1].hand.find((h) => h.iid === revealed)?.cardId).toBe(VANILLA);
    const legal = legalActions(s);
    const r = branchPlayout(s, legal[0]!, ["random", "random"], 1);
    expect(r?.winner === 0 || r?.winner === 1).toBe(true);
  });
});
