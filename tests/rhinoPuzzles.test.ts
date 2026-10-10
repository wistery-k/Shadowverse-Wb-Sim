import { beforeEach, describe, expect, it } from "vitest";
import { resetExactLethalCache } from "../src/ai/exactLethal";
import { rhinoDamageBound, rhinoLethalBound, rhinoThreeDamageBound, searchLethalForRhinoTurn } from "../src/ai/rhino";
import { searchRhinoLethal } from "../src/ai/rhinoLethal";
import { determinize } from "../src/ai/determinize";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, newBoardCard, newHandCard, rngFrom, type Action, type GameState } from "../src/engine";
import type { FollowerOnBoard } from "../src/engine/types";
import { PUZZLES, puzzleState } from "./rhinoPuzzles";

const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
const elf = DEFAULT_DECKS.find((d) => d.name === "リノセウスエルフ")!;
const royal = DEFAULT_DECKS.find((d) => d.name === "アマリアロイヤル")!;

function wins(s: GameState, seq: Action[] | null): boolean {
  if (!seq) return false;
  for (const a of seq) s = applyAction(s, a);
  return s.winner === 0;
}

/** 全探索（このエンジンのルールで、ターン終了以外のすべての手を試す）では 4 問とも expected 点ちょうどが最大だった */

describe("リノセウスのリーサル問題集", () => {
  // 問題はどれも同じターン番号なので、ターンごとのメモと局面数の上限を問題ごとに戻す
  beforeEach(() => resetExactLethalCache());

  for (const pz of PUZZLES) {
    it(pz.name, () => {
      const s = puzzleState(pz, pz.expected);
      expect(wins(s, searchLethalForRhinoTurn(s, 0))).toBe(true);
    });

    it(`${pz.name}: 相手の体力が 1 多ければ見つからない`, () => {
      expect(searchLethalForRhinoTurn(puzzleState(pz, pz.expected + 1), 0)).toBeNull();
    });
  }

  it("リノセウス2・3 は準備のビーム幅を広げれば見つかる（既定の 16 では切られる）", () => {
    for (const [name, beamWidth] of [["リノセウス2（鞄リノリノ）", 128], ["リノセウス3（あて先無し）", 64]] as const) {
      const pz = PUZZLES.find((p) => p.name === name)!;
      const s = puzzleState(pz, pz.expected);
      expect(wins(s, searchRhinoLethal(s, 0, { beamWidth, maxDepth: 10 }))).toBe(true);
    }
  });

  it("ダメージの上限の式（ユーザーの式）: 1〜3 問目は正解以上、4 問目はリノセウス 3 回なので式の外", () => {
    const bounds = PUZZLES.map((pz) => rhinoDamageBound(puzzleState(pz, pz.expected), 0));
    expect(bounds).toEqual([10, 17, 17, 17]);
  });

  it("リノセウス 3 回の上限の式（ユーザーの式）: 4 問目は正解以上で、足切りに使う上限もすべて正解以上", () => {
    expect(PUZZLES.map((pz) => rhinoThreeDamageBound(puzzleState(pz, pz.expected), 0))).toEqual([6, 13, 13, 18]);
    for (const q of PUZZLES) expect(rhinoLethalBound(puzzleState(q, q.expected), 0)).toBeGreaterThanOrEqual(q.expected);
  });
});

/**
 * rhino-compare の seed 900234（リノセウスエルフ後攻 vs アマリアロイヤル）、エルフ 7 ターン目。
 * 全探索が最初に見つけた手順は虫の知らせのランダムダメージで守護を倒す運頼みで、findLethal の確認で捨てられていた。
 * 虫の知らせを使わない確実なリーサル（招集・フェアリー・カーバンクル・杖でコンボを稼ぎ、守護を削ってベイル → リノセウス 9 点）がある
 */
describe("運頼みでないリーサル", () => {
  beforeEach(() => resetExactLethalCache());

  function position(): GameState {
    let s = createGame({ decks: [elf.cards, royal.cards], seed: 1 });
    while (s.phase === "mulligan") s = applyAction(s, legalActions(s)[0]!);
    s.turn = 14;
    s.first = 0;
    s.active = 0;
    const me = s.players[0];
    me.hand = ["虫の知らせ", "殺戮のリノセウス", "ベビーカーバンクル", "煌撃の戦士・ベイル", "妖精の招集", "ピュアクリスタリア・リリィ", "フェアリー", "聖樹の杖"].map((n) =>
      newHandCard(s, id(n)),
    );
    me.hand[3]!.costMod = -4;
    me.board = [newBoardCard(s, id("聖樹の杖"))];
    Object.assign(me, { leaderHp: 19, pp: 7, maxPp: 7, ep: 0, sep: 1, extraPpAvailable: true, turnCount: 7, combo: 0 });
    const follower = (name: string, attack: number, defense: number, extra: Partial<FollowerOnBoard> = {}) => {
      const c = newBoardCard(s, id(name)) as FollowerOnBoard;
      Object.assign(c, { attack, defense, maxDefense: Math.max(defense, c.maxDefense), enteredTurn: 13, ...extra });
      return c;
    };
    const knight = (attack: number, defense: number, extra: Partial<FollowerOnBoard> = {}) =>
      follower("スティールナイト", attack, defense, { keywords: ["rush", "ward"], maxDefense: 2, ...extra });
    s.players[1].board = [
      follower("勇猛のルミナスランサー", 1, 2),
      follower("卓越のルミナスメイジ", 1, 3),
      knight(5, 5, { maxDefense: 5, evolve: "superEvolved", attacksThisTurn: 1 }),
      knight(2, 1, { attacksThisTurn: 1 }),
      knight(2, 2),
    ];
    s.players[1].leaderHp = 10;
    return s;
  }

  it("乱数や相手の手札を決め直しても勝てる手順を返す", () => {
    const s = position();
    const seq = searchLethalForRhinoTurn(s, 0);
    expect(seq).not.toBeNull();
    expect(wins(s, seq)).toBe(true);
    for (let k = 0; k < 5; k++) expect(wins(determinize(s, 0, rngFrom({ rng: 100 + k })), seq)).toBe(true);
  });
});
