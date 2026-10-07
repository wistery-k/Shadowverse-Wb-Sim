import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import {
  applyAction,
  createGame,
  IllegalActionError,
  invariantViolations,
  legalActions,
  newBoardCard,
  newHandCard,
  parseStaticAbilities,
  playCost,
  rngFrom,
  type Action,
  type FollowerOnBoard,
  type GameState,
  type PlayerIndex,
} from "../src/engine";
import { randomAgent } from "../src/ai/random";
import { randomDeck } from "../src/sim/decks";
import { playMatch } from "../src/sim/match";

const id = (name: string): string => {
  const card = ALL_CARDS.find((c) => c.name === name);
  if (!card) throw new Error(`カードがありません: ${name}`);
  return card.id;
};

const VANILLA = id("キャラバンマンモス"); // 7コスト 10/10 能力なし
const SPELL = id("知恵の輝き"); // 1コスト 対象なし
const deckOf = (cardId: string) => Array.from({ length: 40 }, () => cardId);

/** マリガン（入れ替えなし）を済ませ、先攻1ターン目の状態にする */
function started(seed = 1, decks: [string[], string[]] = [deckOf(VANILLA), deckOf(VANILLA)]): GameState {
  let s = createGame({ decks, seed });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
  return s;
}

/** 場にフォロワーを直接置く（テスト用）。前のターンから場にいる扱い */
function putFollower(
  s: GameState,
  p: PlayerIndex,
  name: string,
  opts: Partial<FollowerOnBoard> = {},
): FollowerOnBoard {
  const card = newBoardCard(s, id(name));
  if (card.kind !== "follower") throw new Error(`フォロワーではありません: ${name}`);
  const f: FollowerOnBoard = { ...card, enteredTurn: 0, ...opts };
  s.players[p].board.push(f);
  return f;
}

const has = (s: GameState, a: Action) =>
  legalActions(s).some((x) => JSON.stringify(x) === JSON.stringify(a));

const endTurn = (s: GameState) => applyAction(s, { type: "endTurn" });

describe("対戦の開始", () => {
  it("お互い4枚引いてマリガンから始まる", () => {
    const s = createGame({ decks: [deckOf(VANILLA), deckOf(VANILLA)], seed: 1 });
    expect(s.phase).toBe("mulligan");
    for (const pl of s.players) {
      expect(pl.hand).toHaveLength(4);
      expect(pl.deck).toHaveLength(36);
    }
    expect(legalActions(s)).toHaveLength(16); // 4枚の部分集合
  });

  it("同じシードなら同じ結果になる", () => {
    const decks: [string[], string[]] = [deckOf(VANILLA), deckOf(SPELL)];
    expect(createGame({ decks, seed: 42 })).toEqual(createGame({ decks, seed: 42 }));
  });

  it("マリガンで選んだ枚数を引き直し、引き直したカードは山札に戻る", () => {
    let s = createGame({ decks: [deckOf(VANILLA), deckOf(VANILLA)], seed: 3 });
    const p = s.first;
    const swap = s.players[p].hand.slice(0, 2).map((c) => c.iid);
    s = applyAction(s, { type: "mulligan", player: p, swap });
    const pl = s.players[p];
    expect(pl.hand).toHaveLength(4);
    expect(pl.deck).toHaveLength(36);
    expect(pl.hand.some((c) => swap.includes(c.iid))).toBe(false);
    expect(pl.deck.filter((c) => swap.includes(c.iid))).toHaveLength(2);
  });

  it("後攻はマリガンを先攻の後に行い、両者のマリガン後に先攻1ターン目が始まる", () => {
    let s = createGame({ decks: [deckOf(VANILLA), deckOf(VANILLA)], seed: 5 });
    const second = (1 - s.first) as PlayerIndex;
    expect(() => applyAction(s, { type: "mulligan", player: second, swap: [] })).toThrow(IllegalActionError);
    s = started(5);
    expect(s.phase).toBe("main");
    expect(s.turn).toBe(1);
    expect(s.active).toBe(s.first);
    const pl = s.players[s.first];
    expect(pl.maxPp).toBe(1);
    expect(pl.pp).toBe(1);
    expect(pl.hand).toHaveLength(5); // 先攻1ターン目も引く
    expect(s.players[second].hand).toHaveLength(4); // 後攻の追加ドローは無い
  });
});

describe("ターン進行", () => {
  it("最大PPは毎ターン1増えて10で止まる", () => {
    let s = started();
    const p = s.first;
    for (let i = 0; i < 12; i++) s = endTurn(endTurn(s));
    expect(s.players[p].maxPp).toBe(10);
    expect(s.players[p].pp).toBe(10);
  });

  it("手札上限9枚を超えて引いたカードは墓場へ行き、リアニメイトの対象にならない", () => {
    let s = started();
    const second = (1 - s.first) as PlayerIndex;
    const pl = s.players[second];
    while (pl.hand.length < 9) pl.hand.push(newHandCard(s, pl.deck.shift()!.cardId));
    s = endTurn(s);
    expect(s.players[second].hand).toHaveLength(9);
    expect(s.players[second].graveyard).toBe(1);
    expect(s.players[second].graveyardFollowers).toEqual([]);
  });

  it("山札が無いときに引くと敗北する", () => {
    let s = started();
    const second = (1 - s.first) as PlayerIndex;
    s.players[second].deck = [];
    s = endTurn(s);
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(s.first);
    expect(legalActions(s)).toEqual([]);
  });

  it("カウントダウンは自分のターン開始時に1減り、0で破壊される", () => {
    let s = started();
    const p = s.first;
    s.players[p].board.push(newBoardCard(s, id("繚乱の庭"))); // カウントダウン2
    s = endTurn(endTurn(s));
    expect(s.players[p].board[0]).toMatchObject({ countdown: 1 });
    s = endTurn(endTurn(s));
    expect(s.players[p].board).toEqual([]);
    expect(s.players[p].graveyard).toBe(1);
  });
});

describe("プレイ", () => {
  it("PPを支払ってフォロワーを場に出す", () => {
    let s = started();
    const pl = s.players[s.active];
    pl.pp = pl.maxPp = 7;
    const card = pl.hand[0]!;
    s = applyAction(s, { type: "play", iid: card.iid });
    expect(s.players[s.active].pp).toBe(0);
    expect(s.players[s.active].board).toMatchObject([{ iid: card.iid, attack: 10, defense: 10 }]);
    expect(s.players[s.active].combo).toBe(1);
  });

  it("PPが足りなければプレイできない", () => {
    const s = started();
    expect(legalActions(s).filter((a) => a.type === "play")).toEqual([]);
  });

  it("場が5枚のときはフォロワーをプレイできないが、スペルはプレイできる", () => {
    const s = started(1, [deckOf(SPELL), deckOf(SPELL)]);
    const pl = s.players[s.active];
    pl.hand.push(newHandCard(s, VANILLA, 5000));
    pl.pp = pl.maxPp = 10;
    for (let i = 0; i < 5; i++) putFollower(s, s.active, "キャラバンマンモス");
    expect(has(s, { type: "play", iid: 5000 })).toBe(false);
    expect(has(s, { type: "play", iid: pl.hand[0]!.iid })).toBe(true);
  });

  it("スペルは墓場に行く", () => {
    let s = started(1, [deckOf(SPELL), deckOf(SPELL)]);
    s = applyAction(s, { type: "play", iid: s.players[s.active].hand[0]!.iid });
    expect(s.players[s.active].graveyard).toBe(1);
    expect(s.players[s.active].graveyardFollowers).toEqual([]);
  });

  it("エンハンス: PPがN以上ならNを支払う", () => {
    const fighter = ALL_CARDS.find((c) => c.name === "不屈のファイター")!; // 2コスト【エンハンス_4】
    expect(playCost(fighter, 3)).toBe(2);
    expect(playCost(fighter, 4)).toBe(4);
    expect(playCost(fighter, 10)).toBe(4);
  });
});

describe("攻撃", () => {
  function battle() {
    const s = started();
    const me = s.active;
    const opp = (1 - me) as PlayerIndex;
    return { s, me, opp };
  }

  it("場に出たターンは攻撃できない。疾走はリーダーにも、突進はフォロワーにだけ攻撃できる", () => {
    const { s, me, opp } = battle();
    const plain = putFollower(s, me, "キャラバンマンモス", { enteredTurn: s.turn });
    const storm = putFollower(s, me, "刹那のクイックブレイダー", { enteredTurn: s.turn });
    const rush = putFollower(s, me, "バトルマーチャント", { enteredTurn: s.turn });
    const enemy = putFollower(s, opp, "キャラバンマンモス");
    expect(legalActions(s).filter((a) => a.type === "attack" && a.attacker === plain.iid)).toEqual([]);
    expect(has(s, { type: "attack", attacker: storm.iid, target: "leader" })).toBe(true);
    expect(has(s, { type: "attack", attacker: storm.iid, target: enemy.iid })).toBe(true);
    expect(has(s, { type: "attack", attacker: rush.iid, target: enemy.iid })).toBe(true);
    expect(has(s, { type: "attack", attacker: rush.iid, target: "leader" })).toBe(false);
  });

  it("リーダーを攻撃すると攻撃力分ダメージを与え、反撃は無い", () => {
    const { s, me, opp } = battle();
    const a = putFollower(s, me, "キャラバンマンモス");
    const t = applyAction(s, { type: "attack", attacker: a.iid, target: "leader" });
    expect(t.players[opp].leaderHp).toBe(10);
    expect(t.players[me].board[0]).toMatchObject({ defense: 10, attacksThisTurn: 1 });
    expect(legalActions(t).some((x) => x.type === "attack")).toBe(false); // 1ターン1回
  });

  it("交戦では互いにダメージを与え、体力0以下は破壊されて墓場へ", () => {
    const { s, me, opp } = battle();
    const a = putFollower(s, me, "キャラバンマンモス");
    const d = putFollower(s, opp, "刹那のクイックブレイダー");
    const t = applyAction(s, { type: "attack", attacker: a.iid, target: d.iid });
    expect(t.players[me].board[0]).toMatchObject({ defense: 9 });
    expect(t.players[opp].board).toEqual([]);
    expect(t.players[opp].graveyard).toBe(1);
    expect(t.players[opp].graveyardFollowers).toEqual([d.cardId]);
  });

  it("守護がいると守護以外とリーダーを攻撃できない", () => {
    const { s, me, opp } = battle();
    const a = putFollower(s, me, "キャラバンマンモス");
    const ward = putFollower(s, opp, "激震のゴリアテ");
    const other = putFollower(s, opp, "刹那のクイックブレイダー");
    const targets = legalActions(s).flatMap((x) => (x.type === "attack" && x.attacker === a.iid ? [x.target] : []));
    expect(targets).toEqual([ward.iid]);
    expect(targets).not.toContain(other.iid);
  });

  it("潜伏と威圧のフォロワーは攻撃されない。潜伏は攻撃すると失われる", () => {
    const { s, me, opp } = battle();
    const a = putFollower(s, me, "忍びのムササビ");
    const ambush = putFollower(s, opp, "忍びのムササビ");
    const intimidate = putFollower(s, opp, "覇道の竜翼・フォルテ");
    const targets = legalActions(s).flatMap((x) => (x.type === "attack" && x.attacker === a.iid ? [x.target] : []));
    expect(targets).toEqual(["leader"]);
    expect(targets).not.toContain(ambush.iid);
    expect(targets).not.toContain(intimidate.iid);
    const t = applyAction(s, { type: "attack", attacker: a.iid, target: "leader" });
    expect((t.players[me].board[0] as FollowerOnBoard).keywords).not.toContain("ambush");
  });

  it("必殺は戦闘ダメージを0以上与えたフォロワーを破壊する", () => {
    const { s, me, opp } = battle();
    const a = putFollower(s, me, "ウルフマスター", { attack: 0 });
    const d = putFollower(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "attack", attacker: a.iid, target: d.iid });
    expect(t.players[opp].board).toEqual([]);
  });

  it("ドレインは攻撃時に与えたダメージ分リーダーを回復し、バリアで防がれると回復しない", () => {
    const { s, me, opp } = battle();
    s.players[me].leaderHp = 10;
    const bat = putFollower(s, me, "バット");
    const plain = putFollower(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "attack", attacker: bat.iid, target: plain.iid });
    expect(t.players[me].leaderHp).toBe(11);

    const u = battle();
    u.s.players[u.me].leaderHp = 10;
    const bat2 = putFollower(u.s, u.me, "バット");
    const shield = putFollower(u.s, u.opp, "セイントシールダー");
    const v = applyAction(u.s, { type: "attack", attacker: bat2.iid, target: shield.iid });
    expect(v.players[u.me].leaderHp).toBe(10);
    expect(v.players[u.opp].board[0]).toMatchObject({ defense: 1 });
    expect((v.players[u.opp].board[0] as FollowerOnBoard).keywords).not.toContain("barrier");
  });

  it("リーダーの体力が0になると敗北する", () => {
    const { s, me, opp } = battle();
    s.players[opp].leaderHp = 3;
    const a = putFollower(s, me, "キャラバンマンモス");
    const t = applyAction(s, { type: "attack", attacker: a.iid, target: "leader" });
    expect(t.phase).toBe("ended");
    expect(t.winner).toBe(me);
  });

  it("「1ターンに2回攻撃できる。」は2回攻撃できる", () => {
    expect(parseStaticAbilities("【突進】\n1ターンに2回攻撃できる。").maxAttacks).toBe(2);
  });
});

describe("進化・超進化", () => {
  /** 指定プレイヤーの指定ターン目の開始状態にする */
  function atOwnTurn(order: "first" | "second", n: number) {
    let s = started();
    if (order === "second") s = endTurn(s);
    while (s.players[s.active].turnCount < n) s = endTurn(endTurn(s));
    return s;
  }

  it("先攻は5ターン目、後攻は4ターン目から進化できる", () => {
    for (const [order, turn] of [["first", 5], ["second", 4]] as const) {
      const before = atOwnTurn(order, turn - 1);
      const f1 = putFollower(before, before.active, "キャラバンマンモス");
      expect(has(before, { type: "evolve", iid: f1.iid })).toBe(false);
      const after = atOwnTurn(order, turn);
      const f2 = putFollower(after, after.active, "キャラバンマンモス");
      expect(has(after, { type: "evolve", iid: f2.iid })).toBe(true);
      expect(has(after, { type: "superEvolve", iid: f2.iid })).toBe(false);
    }
  });

  it("先攻は7ターン目、後攻は6ターン目から超進化できる", () => {
    for (const [order, turn] of [["first", 7], ["second", 6]] as const) {
      const before = atOwnTurn(order, turn - 1);
      const f1 = putFollower(before, before.active, "キャラバンマンモス");
      expect(has(before, { type: "superEvolve", iid: f1.iid })).toBe(false);
      const after = atOwnTurn(order, turn);
      const f2 = putFollower(after, after.active, "キャラバンマンモス");
      expect(has(after, { type: "superEvolve", iid: f2.iid })).toBe(true);
    }
  });

  it("進化は+2/+2でEPを1消費。進化と超進化は合わせて1ターン1回、進化済みは再度進化できない", () => {
    const s = atOwnTurn("first", 7);
    const a = putFollower(s, s.active, "キャラバンマンモス");
    const b = putFollower(s, s.active, "キャラバンマンモス");
    const t = applyAction(s, { type: "evolve", iid: a.iid });
    expect(t.players[t.active].board[0]).toMatchObject({ attack: 12, defense: 12, maxDefense: 12, evolve: "evolved" });
    expect(t.players[t.active].ep).toBe(1);
    expect(legalActions(t).some((x) => x.type === "evolve" || x.type === "superEvolve")).toBe(false);
    const u = endTurn(endTurn(t));
    expect(has(u, { type: "evolve", iid: a.iid })).toBe(false);
    expect(has(u, { type: "superEvolve", iid: a.iid })).toBe(false);
    expect(has(u, { type: "superEvolve", iid: b.iid })).toBe(true);
  });

  it("場に出たターンに進化・超進化したフォロワーはフォロワーにだけ攻撃できる", () => {
    for (const kind of ["evolve", "superEvolve"] as const) {
      const s = atOwnTurn("first", 7);
      const f = putFollower(s, s.active, "キャラバンマンモス", { enteredTurn: s.turn });
      const enemy = putFollower(s, (1 - s.active) as PlayerIndex, "キャラバンマンモス");
      const t = applyAction(s, { type: kind, iid: f.iid });
      expect(has(t, { type: "attack", attacker: f.iid, target: enemy.iid })).toBe(true);
      expect(has(t, { type: "attack", attacker: f.iid, target: "leader" })).toBe(false);
    }
  });

  it("超進化は+3/+3で、自分のターン中はダメージを受けない", () => {
    const s = atOwnTurn("first", 7);
    const me = s.active;
    const opp = (1 - me) as PlayerIndex;
    const f = putFollower(s, me, "キャラバンマンモス");
    const enemy = putFollower(s, opp, "キャラバンマンモス");
    let t = applyAction(s, { type: "superEvolve", iid: f.iid });
    expect(t.players[me].sep).toBe(1);
    t = applyAction(t, { type: "attack", attacker: f.iid, target: enemy.iid });
    expect(t.players[me].board[0]).toMatchObject({ attack: 13, defense: 13 });
    expect(t.players[opp].board).toEqual([]);

    // 相手のターン中はダメージを受ける（ここまでの検証の続き）
    t = endTurn(t);
    const attacker = putFollower(t, opp, "キャラバンマンモス");
    t = applyAction(t, { type: "attack", attacker: attacker.iid, target: f.iid });
    expect(t.players[me].board[0]).toMatchObject({ defense: 3 });
  });
});

describe("超進化と他のキーワード", () => {
  function superEvolvedAtOwnTurn() {
    let s = started();
    while (s.players[s.active].turnCount < 7) s = endTurn(endTurn(s));
    const me = s.active;
    const opp = (1 - me) as PlayerIndex;
    return { s, me, opp };
  }

  it("自分のターン中の超進化フォロワーもバリアを消費する", () => {
    const { s, me, opp } = superEvolvedAtOwnTurn();
    const f = putFollower(s, me, "セイントシールダー", { evolve: "superEvolved" });
    const enemy = putFollower(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "attack", attacker: f.iid, target: enemy.iid });
    const after = t.players[me].board[0] as FollowerOnBoard;
    expect(after.defense).toBe(f.defense);
    expect(after.keywords).not.toContain("barrier");
  });

  it("自分のターン中の超進化フォロワーは必殺で破壊されないが、相手のターン中は破壊される", () => {
    const { s, me, opp } = superEvolvedAtOwnTurn();
    const f = putFollower(s, me, "キャラバンマンモス", { evolve: "superEvolved" });
    const bane = putFollower(s, opp, "獣性の鉄人");
    let t = applyAction(s, { type: "attack", attacker: f.iid, target: bane.iid });
    expect(t.players[me].board.map((c) => c.iid)).toEqual([f.iid]);

    t = endTurn(t);
    const attacker = putFollower(t, opp, "獣性の鉄人");
    t = applyAction(t, { type: "attack", attacker: attacker.iid, target: f.iid });
    expect(t.players[me].board).toEqual([]);
  });
});

describe("ランダム自己対戦", () => {
  const classes = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"] as const;

  it("300試合が不変条件を破らずに終わる", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = rngFrom({ rng: seed });
      const decks: [string[], string[]] = [
        randomDeck(classes[seed % 7]!, rng),
        randomDeck(classes[(seed * 3) % 7]!, rng),
      ];
      const result = playMatch([randomAgent, randomAgent], { decks, seed, checkInvariants: true });
      expect(invariantViolations(result.final)).toEqual([]);
    }
  });

  it("同じシードなら同じ結果になる", () => {
    const rng = () => rngFrom({ rng: 7 });
    const decks: [string[], string[]] = [randomDeck("elf", rng()), randomDeck("royal", rng())];
    const a = playMatch([randomAgent, randomAgent], { decks, seed: 7 });
    const b = playMatch([randomAgent, randomAgent], { decks, seed: 7 });
    expect(a.final).toEqual(b.final);
  });
});
