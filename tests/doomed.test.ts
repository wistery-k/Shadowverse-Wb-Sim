import { describe, expect, it } from "vitest";
import { searchAgent } from "../src/ai/search";
import { SEARCH_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { id } from "../src/cards/abilities/helpers";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, newBoardCard, newHandCard, rngFrom, type Action, type GameState } from "../src/engine";

/** 自分（0）の turn ターン目。場も手札も空、相手は体力 20 で場も空 */
function position(turn: number): GameState {
  const nemesis = DEFAULT_DECKS.find((d) => d.class === "nemesis")!;
  let s = createGame({ decks: [nemesis.cards, DEFAULT_DECKS[1]!.cards], seed: 1 });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: s.first === 0 ? 1 : 0, swap: [] });
  while (!(s.active === 0 && s.players[0].turnCount >= turn)) s = applyAction(s, { type: "endTurn" });
  const [me, opp] = s.players;
  me.board = [];
  me.hand = [];
  opp.board = [];
  opp.leaderHp = 20;
  return s;
}

function playTurn(state: GameState): Action[] {
  let s = state;
  const rng = rngFrom({ rng: 7 });
  const actions: Action[] = [];
  for (let i = 0; i < 20 && s.phase !== "ended" && (s.pending ? s.pending.player : s.active) === 0; i++) {
    const a = searchAgent.chooseAction(s, legalActions(s), rng);
    actions.push(a);
    if (a.type === "endTurn") break;
    s = applyAction(s, a);
  }
  return actions;
}

describe("相手のターン終了時に自壊するフォロワー", () => {
  it("探索 AI の重みでは、普通のフォロワーより安く数える", () => {
    const s = position(3);
    const empty = evaluateWith(s, 0, SEARCH_WEIGHTS);
    s.players[0].board = [newBoardCard(s, id("改良型・操り人形"))];
    const puppet = evaluateWith(s, 0, SEARCH_WEIGHTS) - empty;
    expect(puppet).toBeCloseTo((evaluateWith(s, 0, { ...SEARCH_WEIGHTS, doomed: 1 }) - empty) * SEARCH_WEIGHTS.doomed);
  });

  it("改良型・操り人形を出したら、倒せない相手のフォロワーにも攻撃する（相手のターンの終わりに消えるので）", () => {
    const s = position(3);
    const me = s.players[0];
    me.pp = 1;
    me.hand = [newHandCard(s, id("改良型・操り人形"))];
    const target = newBoardCard(s, id("激震のゴリアテ"));
    if (target.kind !== "follower") throw new Error("フォロワーではありません");
    s.players[1].board = [{ ...target, enteredTurn: 0 }];
    const actions = playTurn(s);
    expect(actions.some((a) => a.type === "attack")).toBe(true);
  });

  it("アン＆グレアと一緒に出たアンの大英霊ではなく、場に残るアン＆グレアを超進化する", () => {
    const s = position(6);
    const me = s.players[0];
    me.pp = 5;
    me.hand = [newHandCard(s, id("マナリアフレンズ・アン＆グレア"))];
    // シャークソルジャー（6/6）は、どちらかを超進化すれば倒せる。残るアン＆グレアを超進化する
    const shark = newBoardCard(s, id("シャークソルジャー"));
    if (shark.kind !== "follower") throw new Error("フォロワーではありません");
    s.players[1].board = [{ ...shark, enteredTurn: 0 }];
    const actions = playTurn(s);
    let t = s;
    for (const a of actions) if (a.type !== "endTurn") t = applyAction(t, a);
    const spirit = t.players[0].board.find((c) => c.cardId === id("アンの大英霊"));
    expect(spirit).toBeDefined();
    expect(actions.some((a) => (a.type === "evolve" || a.type === "superEvolve") && a.iid === spirit!.iid)).toBe(false);
  });
});
