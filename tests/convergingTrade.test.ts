import { describe, expect, it } from "vitest";
import { convergingAttacks, settleConvergingTrades } from "../src/ai/convergingTrade";
import { createSearchAgent } from "../src/ai/search";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { abilitiesOf, applyAction, createGame, legalActions, newBoardCard, rngFrom, type FollowerOnBoard, type GameState } from "../src/engine";

const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
const elf = DEFAULT_DECKS.find((d) => d.class === "elf")!;
const royal = DEFAULT_DECKS.find((d) => d.class === "royal")!;

/** プレイヤー0 の手番（PP 0）で、場が空の局面 */
function emptyBoards(): GameState {
  let s = createGame({ decks: [elf.cards, royal.cards], seed: 1 });
  while (s.phase === "mulligan") s = applyAction(s, legalActions(s)[0]!);
  s.active = 0;
  s.turn = 9;
  for (const pl of s.players) {
    pl.board = [];
    pl.pp = 0;
  }
  return s;
}

/** 前のターンから場にいるフォロワーを置く */
function put(s: GameState, p: 0 | 1, name: string, attack: number, defense: number): FollowerOnBoard {
  const f = newBoardCard(s, id(name)) as FollowerOnBoard;
  f.attack = attack;
  f.defense = defense;
  f.maxDefense = defense;
  f.enteredTurn = s.turn - 1;
  s.players[p].board.push(f);
  return f;
}

const attack = (a: FollowerOnBoard, b: FollowerOnBoard) => ({ type: "attack", attacker: a.iid, target: b.iid });

describe("合流する相打ち", () => {
  it("5/5 守護で 5/2 を攻撃して倒せるなら合流する（攻撃した側が倒れるかは問わない）", () => {
    const s = emptyBoards();
    const a = put(s, 0, "ガーディアンゴーレム", 5, 5);
    const b = put(s, 1, "ゴブリン", 5, 2);
    expect(convergingAttacks(s, 0)).toEqual([attack(a, b)]);
    const settled = settleConvergingTrades(s, 0);
    expect(settled.players[1].board).toEqual([]);
    expect(settled.players[0].board).toEqual([]);
    // 攻撃した側が残る場合も合流する
    a.defense = 6;
    expect(convergingAttacks(s, 0)).toEqual([attack(a, b)]);
  });

  it("攻撃先が倒れないなら合流しない", () => {
    const s = emptyBoards();
    put(s, 0, "ゴブリン", 2, 5);
    put(s, 1, "ゴブリン", 5, 3);
    expect(convergingAttacks(s, 0)).toEqual([]);
  });

  it("攻撃した側が守護でなく、自分の場に他の守護がいると、相手は攻撃し返せないので合流しない", () => {
    const s = emptyBoards();
    const a = put(s, 0, "ゴブリン", 5, 5);
    const b = put(s, 1, "ゴブリン", 5, 2);
    const ward = put(s, 0, "ガーディアンゴーレム", 0, 9);
    expect(convergingAttacks(s, 0)).toEqual([]);
    // 守護どうしなら他の守護がいても合流する
    a.keywords.push("ward");
    expect(convergingAttacks(s, 0)).toEqual([attack(a, b)]);
    void ward;
  });

  it("潜伏・威圧のフォロワーは攻撃し返されないので合流しない", () => {
    for (const kw of ["ambush", "intimidate"] as const) {
      const s = emptyBoards();
      const a = put(s, 0, "ゴブリン", 5, 5);
      put(s, 1, "ゴブリン", 5, 2);
      a.keywords.push(kw);
      expect(convergingAttacks(s, 0)).toEqual([]);
    }
  });

  it("攻撃先が場に関わるラストワードを持つときだけ合流しない（攻撃する側のラストワードは見ない）", () => {
    const lastWords = (board: boolean) =>
      ALL_CARDS.find((c) => {
        if (c.type !== "follower" || c.set === "token") return false;
        const abilities = abilitiesOf(c.id).abilities;
        if (abilities.some((x) => x.trigger.on !== "lastWords" && x.trigger.on !== "fanfare")) return false;
        const lw = abilities.filter((x) => x.trigger.on === "lastWords");
        if (lw.length === 0) return false;
        const s = JSON.stringify(lw);
        return board === (s.includes('"kind":"board"') || s.includes('"op":"summon'));
      })!.name;
    const s = emptyBoards();
    put(s, 0, "ゴブリン", 5, 5);
    put(s, 1, lastWords(true), 5, 2);
    expect(convergingAttacks(s, 0)).toEqual([]);

    const s2 = emptyBoards();
    const a2 = put(s2, 0, "ゴブリン", 5, 5);
    const b2 = put(s2, 1, lastWords(false), 5, 2);
    expect(convergingAttacks(s2, 0)).toEqual([attack(a2, b2)]);

    const s3 = emptyBoards();
    const a3 = put(s3, 0, lastWords(true), 5, 5);
    const b3 = put(s3, 1, "ゴブリン", 5, 2);
    expect(convergingAttacks(s3, 0)).toEqual([attack(a3, b3)]);
  });

  it("ターン終了までの攻撃力で倒せるだけなら合流しない", () => {
    const s = emptyBoards();
    const a = put(s, 0, "ゴブリン", 1, 5);
    put(s, 1, "ゴブリン", 5, 2);
    a.tempAttack = 4;
    expect(convergingAttacks(s, 0)).toEqual([]);
  });

  it("探索 AI（settleTrades）は合流する攻撃をせずにターンを終えない", () => {
    const s = emptyBoards();
    const a = put(s, 0, "ガーディアンゴーレム", 5, 5);
    const b = put(s, 1, "ゴブリン", 5, 2);
    b.keywords.push("ward"); // 攻撃先はこれだけ（リーダーは攻撃できない）
    const agent = createSearchAgent({ settleTrades: true, lethal: false });
    expect(agent.chooseAction(s, legalActions(s), rngFrom({ rng: 1 }))).toEqual(attack(a, b));
  });
});
