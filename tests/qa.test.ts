// 公式 Q&A（公式データの各カードの `questions`。docs/rules.md の冒頭「公式Q&A」）を、今のエンジンで局面を作って確かめる。
// 1 件ごとに、どのカードの Q&A かをテストの名前に書く
import { describe, expect, it } from "vitest";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import {
  applyAction,
  createGame,
  legalActions,
  newBoardCard,
  newHandCard,
  type Action,
  type AmuletOnBoard,
  type FollowerOnBoard,
  type GameState,
  type HandCard,
  type PlayerIndex,
} from "../src/engine";

const id = (name: string): string => {
  const card = ALL_CARDS.find((c) => c.name === name);
  if (!card) throw new Error(`カードがありません: ${name}`);
  return card.id;
};

const FILLER = id("キャラバンマンモス");

/** マリガン後、先攻のターン中の状態。PP は 10 にする */
function setup(seed = 1): { s: GameState; me: PlayerIndex; opp: PlayerIndex } {
  let s = createGame({ decks: [Array(40).fill(FILLER), Array(40).fill(FILLER)], seed });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
  const me = s.active;
  const opp = (1 - me) as PlayerIndex;
  s.players[me].hand = [];
  s.players[opp].hand = [];
  s.players[me].pp = s.players[me].maxPp = 10;
  return { s, me, opp };
}

function toHand(s: GameState, p: PlayerIndex, name: string): number {
  const h = newHandCard(s, id(name));
  s.players[p].hand.push(h);
  return h.iid;
}

function toBoard(s: GameState, p: PlayerIndex, name: string, opts: Partial<FollowerOnBoard> = {}) {
  const c = newBoardCard(s, id(name));
  if (c.kind === "follower") Object.assign(c, { enteredTurn: 0, ...opts });
  s.players[p].board.push(c);
  return c;
}

/** 自分のターンを n 回進める（相手は何もしない） */
function passTurns(s: GameState, n: number): GameState {
  for (let i = 0; i < n; i++) s = applyAction(applyAction(s, { type: "endTurn" }), { type: "endTurn" });
  return s;
}

/** 自分のターン中に、PP を 10 に戻す */
function refill(s: GameState, p: PlayerIndex): GameState {
  s.players[p].pp = 10;
  return s;
}

const can = (s: GameState, a: Action) => legalActions(s).some((x) => JSON.stringify(x) === JSON.stringify(a));
const follower = (s: GameState, iid: number) =>
  [...s.players[0].board, ...s.players[1].board].find((c) => c.iid === iid) as FollowerOnBoard | undefined;
const onBoard = (s: GameState, p: PlayerIndex, name: string) => s.players[p].board.filter((c) => c.cardId === id(name));
const handCard = (s: GameState, p: PlayerIndex, iid: number) => s.players[p].hand.find((h) => h.iid === iid);
const handOf = (s: GameState, p: PlayerIndex, name: string): HandCard[] =>
  s.players[p].hand.filter((h) => h.cardId === id(name));
/** 選択待ちなら選ぶ（候補が 1 つでも明示する場合用） */
function choose(s: GameState, targets: number[]): GameState {
  expect(s.pending?.kind).toBe("choose");
  return applyAction(s, { type: "choose", targets });
}

const crestIds = (s: GameState, p: PlayerIndex) => s.players[p].crests.map((c) => c.crestId);
const crestOf = (name: string): string => {
  const crest = ALL_CRESTS.find((c) => c.name === `クレスト：${name}`);
  if (!crest) throw new Error(`クレストがありません: ${name}`);
  return crest.id;
};

/** 自分の場のフォロワーを『魂の捕食』で破壊する（ラストワードを働かせる） */
function destroyOwn(s: GameState, me: PlayerIndex, iid: number): GameState {
  s = refill(s, me);
  s = applyAction(s, { type: "play", iid: toHand(s, me, "魂の捕食") });
  if (s.pending) s = applyAction(s, { type: "choose", targets: [iid] });
  return s;
}

describe("公式Q&A: 同じクレストの2つ目は持たない（docs/rules.md「9. クレスト」）", () => {
  it("自然の妖精姫・アリア: すでに持っているとき、【ファンファーレ】で2つ目を持たない", () => {
    let { s, me } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "自然の妖精姫・アリア") });
    expect(crestIds(s, me)).toEqual([crestOf("自然の妖精姫・アリア")]);
    s = applyAction(refill(s, me), { type: "play", iid: toHand(s, me, "自然の妖精姫・アリア") });
    expect(s.players[me].board).toHaveLength(2); // フォロワーは出る
    expect(crestIds(s, me)).toEqual([crestOf("自然の妖精姫・アリア")]);
  });

  it("常在戦場・カゲミツ: すでに持っているとき、【ラストワード】で2つ目を持たない", () => {
    let { s, me } = setup();
    const a = toBoard(s, me, "常在戦場・カゲミツ");
    const b = toBoard(s, me, "常在戦場・カゲミツ");
    s = destroyOwn(s, me, a.iid);
    expect(crestIds(s, me)).toEqual([crestOf("常在戦場・カゲミツ")]);
    s = destroyOwn(s, me, b.iid);
    expect(s.players[me].board).toEqual([]);
    expect(crestIds(s, me)).toEqual([crestOf("常在戦場・カゲミツ")]);
  });

  it("黎明の錬金術師・ノノ: すでに持っているとき、【進化時】で2つ目を持たない", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 4);
    const a = toBoard(s, me, "黎明の錬金術師・ノノ");
    const b = toBoard(s, me, "黎明の錬金術師・ノノ");
    s = applyAction(s, { type: "evolve", iid: a.iid });
    expect(crestIds(s, me)).toEqual([crestOf("黎明の錬金術師・ノノ")]);
    expect(crestIds(s, opp)).toEqual([]);
    s = passTurns(s, 1);
    s = applyAction(s, { type: "evolve", iid: b.iid });
    expect(crestIds(s, me)).toEqual([crestOf("黎明の錬金術師・ノノ")]);
  });

  it("灼熱のアナテマ・バーンドナイト: 相手がすでに持っているとき、【超進化時】で相手は2つ目を持たない", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const a = toBoard(s, me, "灼熱のアナテマ・バーンドナイト");
    const b = toBoard(s, me, "灼熱のアナテマ・バーンドナイト");
    s = applyAction(s, { type: "superEvolve", iid: a.iid });
    expect(crestIds(s, opp)).toEqual([crestOf("灼熱のアナテマ・バーンドナイト")]);
    expect(crestIds(s, me)).toEqual([]);
    s = passTurns(s, 1);
    s = applyAction(s, { type: "superEvolve", iid: b.iid });
    expect(crestIds(s, opp)).toEqual([crestOf("灼熱のアナテマ・バーンドナイト")]);
    // 相手のターン開始時のダメージも 1 つ分
    const hp = s.players[opp].leaderHp;
    s = applyAction(s, { type: "endTurn" });
    expect(s.players[opp].leaderHp).toBe(hp - 1);
  });

  it("大いなる熾天使・ラピス: すでに持っているとき、【ラストワード】で2つ目を持たない", () => {
    let { s, me } = setup();
    const a = toBoard(s, me, "大いなる熾天使・ラピス");
    const b = toBoard(s, me, "大いなる熾天使・ラピス");
    s = destroyOwn(s, me, a.iid);
    expect(crestIds(s, me)).toEqual([crestOf("大いなる熾天使・ラピス")]);
    s = destroyOwn(s, me, b.iid);
    expect(crestIds(s, me)).toEqual([crestOf("大いなる熾天使・ラピス")]);
  });

  it("新たなる少女・エース: すでに持っているとき、【進化時】で2つ目を持たない", () => {
    let { s, me } = setup();
    s = passTurns(s, 4);
    const a = toBoard(s, me, "新たなる少女・エース");
    const b = toBoard(s, me, "新たなる少女・エース");
    s = applyAction(s, { type: "evolve", iid: a.iid });
    expect(crestIds(s, me)).toEqual([crestOf("新たなる少女・エース")]);
    s = passTurns(s, 1);
    s = applyAction(s, { type: "evolve", iid: b.iid });
    expect(crestIds(s, me)).toEqual([crestOf("新たなる少女・エース")]);
  });

  it("闇の賞金稼ぎ・バルト（Q&A なし。ほかの 6 枚と同じ扱いと推定 ⚠️）: すでに持っているとき、2つ目を持たない", () => {
    let { s, me } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "闇の賞金稼ぎ・バルト") });
    s = applyAction(refill(s, me), { type: "play", iid: toHand(s, me, "闇の賞金稼ぎ・バルト") });
    expect(crestIds(s, me)).toEqual([crestOf("闇の賞金稼ぎ・バルト")]);
  });

  it("2つ目を持とうとしても、今のクレストのカウントダウンは戻らない（未確認 ⚠️。エンジンの暫定の扱い）", () => {
    let { s, me } = setup();
    const a = toBoard(s, me, "常在戦場・カゲミツ");
    const b = toBoard(s, me, "常在戦場・カゲミツ");
    s = destroyOwn(s, me, a.iid);
    expect(s.players[me].crests[0]?.countdown).toBe(2);
    s = passTurns(s, 1);
    expect(s.players[me].crests[0]?.countdown).toBe(1);
    s = destroyOwn(s, me, b.iid);
    expect(s.players[me].crests).toHaveLength(1);
    expect(s.players[me].crests[0]?.countdown).toBe(1);
  });

  it("カウントダウンで消えた後なら、また持てる（カゲミツ）", () => {
    let { s, me } = setup();
    const a = toBoard(s, me, "常在戦場・カゲミツ");
    s = destroyOwn(s, me, a.iid);
    s = passTurns(s, 2); // カウントダウンが 0 になって消え、ラストワードでカゲミツが出る
    expect(s.players[me].crests).toEqual([]);
    const back = s.players[me].board.find((c) => c.cardId === id("常在戦場・カゲミツ"));
    expect(back).toBeDefined();
    s = destroyOwn(s, me, back!.iid);
    expect(crestIds(s, me)).toEqual([crestOf("常在戦場・カゲミツ")]);
  });
});

describe("公式Q&A: プレイ・アクトできるか（選ぶ対象がいない・足りない）", () => {
  it("乙姫の扇: 手札がなくても【アクト】でき、乙姫お守り隊が出る（捨てない）", () => {
    const { s, me } = setup();
    const fan = newBoardCard(s, id("乙姫の扇"));
    s.players[me].board.push(fan);
    expect(can(s, { type: "act", iid: fan.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: fan.iid });
    expect(onBoard(t, me, "乙姫お守り隊")).toHaveLength(1);
    expect(t.players[me].pp).toBe(7);
  });

  it("探偵のルーペ: 相手の場に守護のフォロワーがいなくても【アクト】でき、破壊される", () => {
    const { s, me } = setup();
    const a = newBoardCard(s, id("探偵のルーペ"));
    s.players[me].board.push(a);
    expect(can(s, { type: "act", iid: a.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: a.iid });
    expect(t.players[me].board).toEqual([]);
  });

  it("燐光の岩: 自分の場にフォロワーがいなくても【アクト】でき、破壊される", () => {
    const { s, me } = setup();
    const a = newBoardCard(s, id("燐光の岩"));
    s.players[me].board.push(a);
    expect(can(s, { type: "act", iid: a.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: a.iid });
    expect(t.players[me].board).toEqual([]);
  });

  it("禁密の聖地: 自分の場にフォロワーがいなくても【アクト】でき、リーダーを1回復", () => {
    const { s, me } = setup();
    s.players[me].leaderHp = 10;
    const a = newBoardCard(s, id("禁密の聖地"));
    s.players[me].board.push(a);
    expect(can(s, { type: "act", iid: a.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: a.iid });
    expect(t.players[me].leaderHp).toBe(11);
  });

  it("冒険者のギルド: 自分の場にフォロワーがいなくても【アクト】でき、破壊される", () => {
    const { s, me } = setup();
    const a = newBoardCard(s, id("冒険者のギルド"));
    s.players[me].board.push(a);
    expect(can(s, { type: "act", iid: a.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: a.iid });
    expect(t.players[me].board).toEqual([]);
  });

  it("聖樹の杖: 自分の場にフォロワーがいなくても【アクト】でき、破壊される", () => {
    const { s, me } = setup();
    const a = newBoardCard(s, id("聖樹の杖"));
    s.players[me].board.push(a);
    expect(can(s, { type: "act", iid: a.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: a.iid });
    expect(t.players[me].board).toEqual([]);
  });

  it("セイクリッドインジェクション: 相手の場にフォロワーがいなくても【アクト】でき、破壊されてリーダーを1回復", () => {
    const { s, me } = setup();
    s.players[me].leaderHp = 10;
    const a = newBoardCard(s, id("セイクリッドインジェクション"));
    s.players[me].board.push(a);
    expect(can(s, { type: "act", iid: a.iid })).toBe(true);
    const t = applyAction(s, { type: "act", iid: a.iid });
    expect(t.players[me].board).toEqual([]);
    expect(t.players[me].leaderHp).toBe(11);
  });

  it("虹の奇跡: 手札に【スペルブースト時】を持つカードがなければプレイできない", () => {
    const { s, me } = setup();
    const r = toHand(s, me, "虹の奇跡");
    toHand(s, me, "キャラバンマンモス");
    expect(can(s, { type: "play", iid: r })).toBe(false);
  });

  it("命の奔流: 相手の場にフォロワーがいなければプレイできない", () => {
    const { s, me } = setup();
    expect(can(s, { type: "play", iid: toHand(s, me, "命の奔流") })).toBe(false);
  });

  it("剣士の斬撃: 相手の場にフォロワーがいなければプレイできない", () => {
    const { s, me } = setup();
    expect(can(s, { type: "play", iid: toHand(s, me, "剣士の斬撃") })).toBe(false);
  });

  it("異次元からの銃撃: 相手の場にフォロワーがいなければプレイできない", () => {
    const { s, me } = setup();
    expect(can(s, { type: "play", iid: toHand(s, me, "異次元からの銃撃") })).toBe(false);
  });

  // 公式Q&Aと食い違う（F）: 今のエンジンは、候補が 1 枚以上あればスペルをプレイできる
  it.fails("改境の再動: 手札のコスト5以下のアーティファクト・フォロワーが1枚以下ならプレイできない", () => {
    const { s, me } = setup();
    const r = toHand(s, me, "改境の再動");
    toHand(s, me, "アタックアーティファクト");
    expect(can(s, { type: "play", iid: r })).toBe(false);
  });
});

describe("公式Q&A: 能力の一部だけ働く", () => {
  it("グリードケルブ・ルビィ: 手札がこれ1枚でも【ファンファーレ】は働き、1枚を引く", () => {
    let { s, me } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "グリードケルブ・ルビィ") });
    expect(s.pending).toBeNull();
    expect(s.players[me].hand).toHaveLength(1);
  });

  it("見習い占星術師: 手札がこれ1枚でも【ファンファーレ】は働き、1枚を引いて土の印を+1", () => {
    let { s, me } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "見習い占星術師") });
    expect(s.pending).toBeNull();
    expect(s.players[me].hand).toHaveLength(1);
    const sig = s.players[me].board.find((c) => c.kind === "amulet") as AmuletOnBoard | undefined;
    expect(sig?.sigils).toBe(1);
  });

  it("見習い占星術師: 土の印があり場の空きが1つでも、土の印を+1できる", () => {
    let { s, me } = setup();
    const sig = newBoardCard(s, id("大地の魔片")) as AmuletOnBoard;
    sig.sigils = 1;
    s.players[me].board.push(sig);
    for (let i = 0; i < 3; i++) toBoard(s, me, "キャラバンマンモス");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "見習い占星術師") });
    expect(s.players[me].board).toHaveLength(5);
    expect((s.players[me].board.find((c) => c.iid === sig.iid) as AmuletOnBoard).sigils).toBe(2);
  });

  it("燃え盛る魔剣・オルトロス: 墓場が4以上で相手の場にフォロワーがいなくても【進化時】は働き、墓場を4消費する", () => {
    let { s, me } = setup();
    s = passTurns(s, 4);
    s.players[me].graveyard = 5;
    const o = toBoard(s, me, "燃え盛る魔剣・オルトロス");
    s = applyAction(s, { type: "evolve", iid: o.iid });
    expect(s.players[me].graveyard).toBe(1);
  });

  it("カオティックカース: 元のコスト2以下のフォロワーが破壊されていなくても【モード】（2）を選べる（何も起きない）", () => {
    let { s, me } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "カオティックカース") });
    expect(s.pending).toMatchObject({ kind: "mode", options: 2 });
    expect(can(s, { type: "mode", index: 1 })).toBe(true);
    s = applyAction(s, { type: "mode", index: 1 });
    expect(s.players[me].board).toEqual([]);
  });

  it("閃光の魔法剣士: 土の印がなくても【モード】（2）を選べる（+2/+2・守護は働かない）", () => {
    let { s, me } = setup();
    const k = toHand(s, me, "閃光の魔法剣士");
    s = applyAction(s, { type: "play", iid: k });
    expect(s.pending).toMatchObject({ kind: "mode", options: 2 });
    expect(can(s, { type: "mode", index: 1 })).toBe(true);
    s = applyAction(s, { type: "mode", index: 1 });
    const f = follower(s, k)!;
    expect(f).toMatchObject({ attack: 2, defense: 2 });
    expect(f.keywords).not.toContain("ward");
  });

  it("理光の証明: 土の印が2以下でも【モード】（3）を選べる（ダメージは働かない）", () => {
    let { s, me, opp } = setup();
    const sig = newBoardCard(s, id("大地の魔片")) as AmuletOnBoard;
    sig.sigils = 2;
    s.players[me].board.push(sig);
    const e = toBoard(s, opp, "キャラバンマンモス");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "理光の証明") });
    expect(s.pending).toMatchObject({ kind: "mode", options: 3 });
    expect(can(s, { type: "mode", index: 2 })).toBe(true);
    s = applyAction(s, { type: "mode", index: 2 });
    expect(follower(s, e.iid)?.defense).toBe((e as FollowerOnBoard).defense);
  });

  it("灼熱のアナテマ・バーンドナイト: 手札がこれ1枚でも【ファンファーレ】は働く（0ダメージ）", () => {
    let { s, me, opp } = setup();
    const e = toBoard(s, opp, "キャラバンマンモス");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "灼熱のアナテマ・バーンドナイト") });
    expect(s.pending).toBeNull();
    expect(follower(s, e.iid)?.defense).toBe((e as FollowerOnBoard).defense);
  });

  it("裁決のアナテマ・ロデオ: 手札がこれ1枚でも【ファンファーレ】は働き、デッキのアミュレット3種類が出る", () => {
    let { s, me } = setup();
    s.players[me].deck = ["禁密の聖地", "セイクリッドインジェクション", "冒険者のギルド", "探偵のルーペ"].map((n) => ({
      iid: s.nextIid++,
      cardId: id(n),
    }));
    s = applyAction(s, { type: "play", iid: toHand(s, me, "裁決のアナテマ・ロデオ") });
    expect(s.pending).toBeNull();
    expect(s.players[me].board.filter((c) => c.kind === "amulet")).toHaveLength(3);
  });

  it("串刺し公・ヴラド: 相手の場にフォロワーがいなくても【ファンファーレ】は働き、リーダーを5回復", () => {
    let { s, me } = setup();
    s.players[me].leaderHp = 10;
    s = applyAction(s, { type: "play", iid: toHand(s, me, "串刺し公・ヴラド") });
    expect(s.players[me].leaderHp).toBe(15);
  });

  it("辺獄の悪鬼: 相手の場にフォロワーがいなくても【ファンファーレ】は働き、相手のリーダーに6ダメージ", () => {
    let { s, me, opp } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "辺獄の悪鬼") });
    expect(s.players[opp].leaderHp).toBe(14);
  });

  it("ブーストエクステンド・ララミア: 手札のアーティファクトが2枚以下でも【ファンファーレ】は働き、選べるだけ選んでコピーが出る", () => {
    let { s, me } = setup();
    toHand(s, me, "アタックアーティファクト");
    toHand(s, me, "キャッスルアーティファクト");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "ブーストエクステンド・ララミア") });
    expect(s.pending).toBeNull();
    expect(onBoard(s, me, "アタックアーティファクト")).toHaveLength(1);
    expect(onBoard(s, me, "キャッスルアーティファクト")).toHaveLength(1);
  });
});

describe("公式Q&A: 手札から山札に戻したカードの状態", () => {
  it("グリードケルブ・ルビィ: スペルブーストでコスト5になったブレイズデストロイヤーを戻して引き直すとコスト5", () => {
    let { s, me } = setup();
    s.players[me].deck = [];
    const b = toHand(s, me, "ブレイズデストロイヤー");
    Object.assign(handCard(s, me, b)!, { boosts: 5, costMod: -5 });
    s = applyAction(s, { type: "play", iid: toHand(s, me, "グリードケルブ・ルビィ") });
    expect(handOf(s, me, "ブレイズデストロイヤー")[0]).toMatchObject({ costMod: -5, boosts: 5 });
  });

  it("グリードケルブ・ルビィ: 疾走を持った魔煌のトリックスター・ラスティを戻して引き直すと疾走を持っている", () => {
    let { s, me } = setup();
    s.players[me].deck = [];
    const r = toHand(s, me, "魔煌のトリックスター・ラスティ");
    handCard(s, me, r)!.keywords = ["storm"];
    s = applyAction(s, { type: "play", iid: toHand(s, me, "グリードケルブ・ルビィ") });
    expect(handOf(s, me, "魔煌のトリックスター・ラスティ")[0]?.keywords).toContain("storm");
  });

  it("メイドの作法: 疾走を持った魔煌のトリックスター・ラスティを戻して引き直すと疾走を持っている", () => {
    let { s, me } = setup();
    s.players[me].deck = [];
    const r = toHand(s, me, "魔煌のトリックスター・ラスティ");
    handCard(s, me, r)!.keywords = ["storm"];
    s = applyAction(s, { type: "play", iid: toHand(s, me, "メイドの作法") });
    expect(handOf(s, me, "魔煌のトリックスター・ラスティ")[0]?.keywords).toContain("storm");
  });

  it("見習い占星術師: スペルブーストでコスト5になったブレイズデストロイヤーを戻して引き直すとコスト5", () => {
    let { s, me } = setup();
    s.players[me].deck = [];
    const b = toHand(s, me, "ブレイズデストロイヤー");
    Object.assign(handCard(s, me, b)!, { boosts: 5, costMod: -5 });
    s = applyAction(s, { type: "play", iid: toHand(s, me, "見習い占星術師") });
    expect(handOf(s, me, "ブレイズデストロイヤー")[0]).toMatchObject({ costMod: -5, boosts: 5 });
  });
});

describe("公式Q&A: オーバーディメンション", () => {
  /** 山札を 4 枚にして、手札は prep で置くカード 1 枚とオーバーディメンションだけにする（戻した 5 枚をすべて引き直す） */
  function od(prep: (s: GameState, me: PlayerIndex) => void) {
    const { s, me } = setup();
    s.players[me].deck = s.players[me].deck.slice(0, 4);
    prep(s, me);
    const o = toHand(s, me, "オーバーディメンション");
    handCard(s, me, o)!.costMod = -18;
    return { s, me, o };
  }

  it("コスト6のブレイズデストロイヤーを戻して引き直すと、その後のスペルブースト（プレイの1回と5回）でコスト0", () => {
    const { s, me, o } = od((s, me) => {
      const b = toHand(s, me, "ブレイズデストロイヤー");
      Object.assign(handCard(s, me, b)!, { boosts: 4, costMod: -4 });
    });
    const t = applyAction(s, { type: "play", iid: o });
    expect(handOf(t, me, "ブレイズデストロイヤー")[0]).toMatchObject({ boosts: 10, costMod: -10 });
  });

  // 公式Q&Aと食い違う（D）: 今のエンジンはプレイしたスペルのスペルブーストを効果より前に行う（docs/rules.md 11 章の ⚠️ の仮の決まり）
  it.fails("引き直したときはコスト6のまま: プレイしたときの1回のスペルブーストは、戻して引き直した後に働く（山札から引いたカードも6回ブーストされる）", () => {
    // 公式: 戻したコスト6（4 回ブースト済み）のカードは、引き直したときコスト6。その後の 1 回と 5 回でコスト0。
    // プレイの 1 回が効果より前なら、戻す前にコスト5になり、引き直したときコスト5になる。
    // 途中の値は 1 回の applyAction の中で見えないので、山札から引いた（戻していない）カードのブースト回数で見る:
    // プレイの 1 回が引いた後なら 6 回、前なら 5 回
    const { s, me, o } = od((s, me) => {
      s.players[me].deck[0] = { iid: s.nextIid++, cardId: id("ブレイズデストロイヤー") };
    });
    const t = applyAction(s, { type: "play", iid: o });
    expect(handOf(t, me, "ブレイズデストロイヤー")[0]).toMatchObject({ boosts: 6, costMod: -6 });
  });

  it("Xが4のストームブラストを戻して引き直すと、その後のスペルブーストでXは10", () => {
    const { s, me, o } = od((s, me) => {
      const b = toHand(s, me, "ストームブラスト");
      Object.assign(handCard(s, me, b)!, { boosts: 2, x: 4 });
    });
    const t = applyAction(s, { type: "play", iid: o });
    expect(handOf(t, me, "ストームブラスト")[0]!.x).toBe(10);
  });

  it("PP最大値9・エクストラPPで10にして、クオンを【エンハンス_10】でプレイして0にした後、コスト0のオーバーディメンションでPPは9回復", () => {
    let { s, me } = setup();
    s.players[me].maxPp = 9;
    s.players[me].pp = 10;
    s = applyAction(s, { type: "play", iid: toHand(s, me, "五行の果て・クオン") });
    expect(s.players[me].pp).toBe(0);
    const o = toHand(s, me, "オーバーディメンション");
    handCard(s, me, o)!.costMod = -18;
    s = applyAction(s, { type: "play", iid: o });
    expect(s.players[me].pp).toBe(9);
  });
});

describe("公式Q&A: PP の回復", () => {
  // 公式Q&Aと食い違う（C）: 今のエンジンは PP の回復を PP 最大値（9）までにする
  it.fails("ベビーカーバンクル: PP最大値9でエクストラPPを使って10、コスト3をプレイして7のとき、【超進化時】でPPを3回復する", () => {
    let { s, me } = setup();
    s = passTurns(s, 6);
    const c = toBoard(s, me, "ベビーカーバンクル");
    s.players[me].maxPp = 9;
    s.players[me].pp = 10;
    s = applyAction(s, { type: "play", iid: toHand(s, me, "熾天使の福音") });
    expect(s.players[me].pp).toBe(7);
    s = applyAction(s, { type: "superEvolve", iid: c.iid });
    expect(s.players[me].pp).toBe(10);
  });
});

describe("公式Q&A: コンボ・場に出たとき・ターンごとに1回", () => {
  it("アドベンチャーエルフ・メイ: このターンにプレイしたカードが2枚なら、これ自身を数えて【コンボ_3】が働く", () => {
    let { s, me, opp } = setup();
    const e = toBoard(s, opp, "激震のゴリアテ");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "森の神秘") });
    s = applyAction(s, { type: "play", iid: toHand(s, me, "森の神秘") });
    s = applyAction(s, { type: "play", iid: toHand(s, me, "アドベンチャーエルフ・メイ") });
    expect(follower(s, e.iid)?.defense).toBe(2);
  });

  it("統率のルミナスナイト: 相手のターン中に王家の御者のラストワードでナイトが出たら+1/+0し、相手のターン終了まで続く", () => {
    let { s, me, opp } = setup();
    const lk = toBoard(s, me, "統率のルミナスナイト");
    const coach = toBoard(s, me, "王家の御者");
    s = applyAction(s, { type: "endTurn" });
    s.players[opp].pp = 10;
    s = applyAction(s, { type: "play", iid: toHand(s, opp, "剣士の斬撃") });
    s = choose(s, [coach.iid]);
    expect(onBoard(s, me, "ナイト")).toHaveLength(1);
    const f = follower(s, lk.iid)!;
    expect(f.attack + f.tempAttack).toBe(2);
    s = applyAction(s, { type: "endTurn" });
    const g = follower(s, lk.iid)!;
    expect(g.attack + g.tempAttack).toBe(1);
  });

  it("救援のルミナスヒーラー・リララ: 王断の威光の【モード】（1）でリーダーを2回復", () => {
    let { s, me } = setup();
    s.players[me].leaderHp = 10;
    toBoard(s, me, "救援のルミナスヒーラー・リララ");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "王断の威光") });
    s = applyAction(s, { type: "mode", index: 0 });
    expect(s.players[me].leaderHp).toBe(12);
  });

  it("オートマタアサシン: 人形の身代わりで操り人形が2枚出たら、1枚目だけ必殺を持つ", () => {
    let { s, me } = setup();
    toBoard(s, me, "オートマタアサシン");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "人形の身代わり") });
    const dolls = onBoard(s, me, "改良型・操り人形") as FollowerOnBoard[];
    expect(dolls).toHaveLength(2);
    expect(dolls[0]!.keywords).toContain("bane");
    expect(dolls[1]!.keywords).not.toContain("bane");
  });

  // 公式Q&Aと食い違う（G）: 公式データではムカンのタイプは「-」（死者ではない）。今のエンジンはデータどおり必殺を持たせない
  it.fails("瞑地の天宮・ムカン: ジャグリングゴーストでリアニメイトしたムカンは必殺を持つ", () => {
    let { s, me } = setup();
    s.players[me].graveyard = 1;
    s.players[me].graveyardFollowers = [id("瞑地の天宮・ムカン")];
    s = applyAction(s, { type: "play", iid: toHand(s, me, "ジャグリングゴースト") });
    const m = onBoard(s, me, "瞑地の天宮・ムカン")[0] as FollowerOnBoard | undefined;
    expect(m).toBeDefined();
    expect(m!.keywords).toContain("bane");
  });

  it("煌撃の戦士・ベイル: 相手のターン中に自分のフェアリーが破壊されたら、手札のベイルのコストは-1", () => {
    let { s, me, opp } = setup();
    const fairy = toBoard(s, me, "フェアリー");
    const b = toHand(s, me, "煌撃の戦士・ベイル");
    s = applyAction(s, { type: "endTurn" });
    s.players[opp].pp = 10;
    s = applyAction(s, { type: "play", iid: toHand(s, opp, "剣士の斬撃") });
    if (s.pending) s = choose(s, [fairy.iid]);
    expect(follower(s, fairy.iid)).toBeUndefined();
    expect(handCard(s, me, b)?.costMod).toBe(-1);
  });

  it("豊麗なるローズクイーン: コスト0の煌撃の戦士・ベイルは薔薇の閃撃に変身する", () => {
    let { s, me } = setup();
    const b = toHand(s, me, "煌撃の戦士・ベイル");
    handCard(s, me, b)!.costMod = -8;
    s = applyAction(s, { type: "play", iid: toHand(s, me, "豊麗なるローズクイーン") });
    expect(handCard(s, me, b)?.cardId).toBe(id("薔薇の閃撃"));
  });

  it("深奥のフェアリービースト: 手札が9枚のときプレイすると、リーダーを9回復", () => {
    let { s, me } = setup();
    s.players[me].leaderHp = 5;
    for (let i = 0; i < 8; i++) toHand(s, me, "キャラバンマンモス");
    s = applyAction(s, { type: "play", iid: toHand(s, me, "深奥のフェアリービースト") });
    expect(s.players[me].hand).toHaveLength(9);
    expect(s.players[me].leaderHp).toBe(14);
  });

  it("魔女の錬金釜: 1枚目を【アクト】した後に2枚目をプレイしたら、PPが1以上なら2枚目を【アクト】できる", () => {
    let { s, me } = setup();
    const a = newBoardCard(s, id("魔女の錬金釜"));
    s.players[me].board.push(a);
    s = applyAction(s, { type: "act", iid: a.iid });
    const b = toHand(s, me, "魔女の錬金釜");
    s = applyAction(s, { type: "play", iid: b });
    expect(s.players[me].pp).toBeGreaterThanOrEqual(1);
    expect(can(s, { type: "act", iid: b })).toBe(true);
  });

  it("デストロイアーティファクトα: βを融合し、次のターンにγを融合するとイクシードアーティファクトΩに変身する", () => {
    let { s, me } = setup();
    const alpha = toHand(s, me, "デストロイアーティファクトα");
    const beta = toHand(s, me, "デストロイアーティファクトβ");
    const gamma = toHand(s, me, "デストロイアーティファクトγ");
    s = applyAction(s, { type: "fuse", host: alpha, materials: [beta] });
    s = passTurns(s, 1);
    s = applyAction(s, { type: "fuse", host: alpha, materials: [gamma] });
    expect(handCard(s, me, alpha)?.cardId).toBe(id("イクシードアーティファクトΩ"));
  });
});

describe("公式Q&A: 進化・超進化", () => {
  it("異端の侍: 先攻の9ターン目にSEPがなくても、超進化可能ターンなので必殺を持つ", () => {
    let { s, me } = setup();
    s = passTurns(s, 8);
    expect(s.players[me].turnCount).toBe(9);
    s.players[me].sep = 0;
    const k = toHand(s, me, "異端の侍");
    s = applyAction(s, { type: "play", iid: k });
    expect(follower(s, k)?.keywords).toContain("bane");
  });

  it("ピュアクリスタリア・リリィ: 【ファンファーレ】で4/1になった激震のゴリアテは、進化で6/3、超進化で7/4", () => {
    for (const kind of ["evolve", "superEvolve"] as const) {
      let { s, me, opp } = setup();
      s = passTurns(s, 6);
      const g = toBoard(s, opp, "激震のゴリアテ");
      s = applyAction(s, { type: "play", iid: toHand(s, me, "森の神秘") });
      s = applyAction(s, { type: "play", iid: toHand(s, me, "森の神秘") });
      s = applyAction(s, { type: "play", iid: toHand(s, me, "ピュアクリスタリア・リリィ") });
      expect(follower(s, g.iid)).toMatchObject({ attack: 4, defense: 1 });
      s = applyAction(s, { type: "endTurn" });
      s = applyAction(s, { type: kind, iid: g.iid });
      expect(follower(s, g.iid)).toMatchObject(kind === "evolve" ? { attack: 6, defense: 3 } : { attack: 7, defense: 4 });
    }
  });

  it("スノーアウェイク: 4/1になった激震のゴリアテは、進化で6/3、超進化で7/4", () => {
    for (const kind of ["evolve", "superEvolve"] as const) {
      let { s, me, opp } = setup();
      s = passTurns(s, 6);
      const g = toBoard(s, opp, "激震のゴリアテ");
      s = applyAction(s, { type: "play", iid: toHand(s, me, "スノーアウェイク") });
      expect(follower(s, g.iid)).toMatchObject({ attack: 4, defense: 1 });
      s = applyAction(s, { type: "endTurn" });
      s = applyAction(s, { type: kind, iid: g.iid });
      expect(follower(s, g.iid)).toMatchObject(kind === "evolve" ? { attack: 6, defense: 3 } : { attack: 7, defense: 4 });
    }
  });

  it("勇壮の堕天使・オリヴィエ: 【超進化時】で超進化させた激震のゴリアテは超進化のルールによる能力を持つ", () => {
    for (const enemy of ["キャラバンマンモス", "ナイト"]) {
      let { s, me, opp } = setup();
      s = passTurns(s, 6);
      const g = toBoard(s, me, "激震のゴリアテ");
      const o = toBoard(s, me, "勇壮の堕天使・オリヴィエ");
      const e = toBoard(s, opp, enemy);
      s = applyAction(s, { type: "superEvolve", iid: o.iid });
      expect(follower(s, g.iid)?.evolve).toBe("superEvolved");
      const hp = s.players[opp].leaderHp;
      s = applyAction(s, { type: "attack", attacker: g.iid, target: e.iid });
      if (enemy === "キャラバンマンモス") {
        expect(follower(s, g.iid)?.defense).toBe(8); // 自分のターン中は受けるダメージが 0
      } else {
        expect(follower(s, e.iid)).toBeUndefined();
        expect(s.players[opp].leaderHp).toBe(hp - 1); // 攻撃で破壊したら相手のリーダーに 1 ダメージ
      }
    }
  });

  it("勇壮の堕天使・オリヴィエ: 【超進化時】で超進化させた煌響の使者・アンリエットの【進化時】【超進化時】は働かない", () => {
    let { s, me } = setup();
    s = passTurns(s, 6);
    s.players[me].leaderHp = 10;
    const h = toBoard(s, me, "煌響の使者・アンリエット");
    const o = toBoard(s, me, "勇壮の堕天使・オリヴィエ");
    s = applyAction(s, { type: "superEvolve", iid: o.iid });
    expect(follower(s, h.iid)?.evolve).toBe("superEvolved");
    expect(s.players[me].leaderHp).toBe(10);
  });

  it("魂の捕食: 自分の場の超進化フォロワーを選べる。破壊されず、2枚を引く", () => {
    let { s, me } = setup();
    s = passTurns(s, 6);
    s.players[me].hand = [];
    const f = toBoard(s, me, "激震のゴリアテ");
    s = applyAction(s, { type: "superEvolve", iid: f.iid });
    s = applyAction(s, { type: "play", iid: toHand(s, me, "魂の捕食") });
    expect(follower(s, f.iid)).toBeDefined();
    expect(s.players[me].hand).toHaveLength(2);
  });
});

describe("公式Q&A: 超進化したフォロワーとバリア", () => {
  /** 超進化させたフォロワーが相手のフォロワーを攻撃したあと、バリアを失っているか */
  function attackAfterSuper(name: string, give: (s: GameState, me: PlayerIndex, iid: number) => GameState) {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const f = toBoard(s, me, name);
    s = give(s, me, f.iid);
    expect(follower(s, f.iid)?.evolve).toBe("superEvolved");
    expect(follower(s, f.iid)?.keywords).toContain("barrier");
    const e = toBoard(s, opp, "キャラバンマンモス");
    s = applyAction(s, { type: "attack", attacker: f.iid, target: e.iid });
    return follower(s, f.iid);
  }
  const superEvolve = (s: GameState, _me: PlayerIndex, iid: number) => applyAction(s, { type: "superEvolve", iid });

  it("煌槍のアルミラージ・サリッサ: 超進化させて相手のフォロワーを攻撃したらバリアを失う", () => {
    expect(attackAfterSuper("煌槍のアルミラージ・サリッサ", superEvolve)?.keywords).not.toContain("barrier");
  });

  it("セイントシールダー: 超進化させて相手のフォロワーを攻撃したらバリアを失う", () => {
    expect(attackAfterSuper("セイントシールダー", superEvolve)?.keywords).not.toContain("barrier");
  });

  it("白銀の騎士団長・エミリア: 【超進化時】でバリアを持ったナイトを超進化させて攻撃したらバリアを失う", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const knight = toBoard(s, me, "ナイト");
    const em = toBoard(s, me, "白銀の騎士団長・エミリア");
    s = applyAction(s, { type: "superEvolve", iid: em.iid });
    expect(follower(s, knight.iid)?.keywords).toContain("barrier");
    s = passTurns(s, 1);
    s = applyAction(s, { type: "superEvolve", iid: knight.iid });
    const e = toBoard(s, opp, "キャラバンマンモス");
    s = applyAction(s, { type: "attack", attacker: knight.iid, target: e.iid });
    expect(follower(s, knight.iid)?.keywords).not.toContain("barrier");
  });

  it("レヴィオンアックス・ジェノ: 超進化させて相手のフォロワーを攻撃したらバリアを失う", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const g = toBoard(s, me, "レヴィオンアックス・ジェノ");
    s = applyAction(s, { type: "superEvolve", iid: g.iid });
    const e = toBoard(s, opp, "キャラバンマンモス");
    s = applyAction(s, { type: "attack", attacker: g.iid, target: e.iid });
    expect(follower(s, g.iid)?.keywords).not.toContain("barrier");
  });
});

describe("公式Q&A: 超進化のルールによる能力と決着", () => {
  it("猛毒姫・メドゥーサ: 超進化して【攻撃時】で交戦相手を破壊したら、超進化のルールによる相手のリーダーへの1ダメージが働く", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const m = toBoard(s, me, "猛毒姫・メドゥーサ");
    s = applyAction(s, { type: "superEvolve", iid: m.iid });
    const e = toBoard(s, opp, "キャラバンマンモス");
    const hp = s.players[opp].leaderHp;
    s = applyAction(s, { type: "attack", attacker: m.iid, target: e.iid });
    expect(follower(s, e.iid)).toBeUndefined();
    expect(s.players[opp].leaderHp).toBe(hp - 1);
  });

  it("番犬の右腕・ミミ: 両リーダーの体力が1のとき、超進化フォロワーで相手のミミを攻撃して破壊したら自分が勝つ", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const f = toBoard(s, me, "激震のゴリアテ");
    s = applyAction(s, { type: "superEvolve", iid: f.iid });
    const mimi = toBoard(s, opp, "番犬の右腕・ミミ");
    s.players[me].leaderHp = 1;
    s.players[opp].leaderHp = 1;
    s = applyAction(s, { type: "attack", attacker: f.iid, target: mimi.iid });
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(me);
  });

  it("番犬の左腕・ココ: 相手のリーダーの体力が1のとき、超進化フォロワーで相手のココを攻撃して破壊したら自分が勝つ", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const f = toBoard(s, me, "激震のゴリアテ");
    s = applyAction(s, { type: "superEvolve", iid: f.iid });
    const coco = toBoard(s, opp, "番犬の左腕・ココ");
    s.players[opp].leaderHp = 1;
    s = applyAction(s, { type: "attack", attacker: f.iid, target: coco.iid });
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(me);
  });

  it("蛇神の怒り: 両リーダーの体力が2のとき、相手のリーダーを選んだら自分が勝つ", () => {
    let { s, me, opp } = setup();
    s.players[me].leaderHp = 2;
    s.players[opp].leaderHp = 2;
    s = applyAction(s, { type: "play", iid: toHand(s, me, "蛇神の怒り") });
    if (s.pending) s = choose(s, [-(opp + 1)]);
    expect(s.winner).toBe(me);
  });

  it("闇の賞金稼ぎ・バルト: クレストを持ち、両リーダーの体力が1のとき、ターン終了したら相手が勝つ", () => {
    let { s, me, opp } = setup();
    s = applyAction(s, { type: "play", iid: toHand(s, me, "闇の賞金稼ぎ・バルト") });
    s.players[me].leaderHp = 1;
    s.players[opp].leaderHp = 1;
    s = applyAction(s, { type: "endTurn" });
    expect(s.winner).toBe(opp);
  });

  it("エンドレスハンター・アラガヴィ: 両リーダーの体力が3のとき、自分が【進化時】を働かせたら相手が勝つ", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 4);
    const a = toBoard(s, me, "エンドレスハンター・アラガヴィ");
    s.players[me].leaderHp = 3;
    s.players[opp].leaderHp = 3;
    s = applyAction(s, { type: "evolve", iid: a.iid });
    expect(s.winner).toBe(opp);
  });
});

describe("公式Q&A: ダメージの割りふり", () => {
  /** 相手の場に体力 3・3・2 のフォロワー（古い順）を置く */
  function three(s: GameState, opp: PlayerIndex) {
    return [3, 3, 2].map((d) => toBoard(s, opp, "キャラバンマンモス", { defense: d, maxDefense: d }));
  }

  it("薫交の天宮・バックウッド: 【進化時】X=7 を、体力 3・3・2 に古い順で 3・3・1 と割りふる", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 4);
    s.players[me].hand = [];
    for (let i = 0; i < 7; i++) toHand(s, me, "キャラバンマンモス");
    const b = toBoard(s, me, "薫交の天宮・バックウッド");
    const [x, y, z] = three(s, opp);
    s = applyAction(s, { type: "evolve", iid: b.iid });
    expect(follower(s, x!.iid)).toBeUndefined();
    expect(follower(s, y!.iid)).toBeUndefined();
    expect(follower(s, z!.iid)?.defense).toBe(1);
  });

  it("エンドレスハンター・アラガヴィ: 【ファンファーレ】の7ダメージを、体力 3・3・2 に古い順で 3・3・1 と割りふる", () => {
    let { s, me, opp } = setup();
    const [x, y, z] = three(s, opp);
    s = applyAction(s, { type: "play", iid: toHand(s, me, "エンドレスハンター・アラガヴィ") });
    expect(follower(s, x!.iid)).toBeUndefined();
    expect(follower(s, y!.iid)).toBeUndefined();
    expect(follower(s, z!.iid)?.defense).toBe(1);
  });
});

describe("公式Q&A: 選ぶ対象の制限", () => {
  // 公式Q&Aと食い違う（E）: 今のエンジンは、選べる候補がロイドだけになり、ロイドだけを破壊する
  it.fails("ロイド: 相手の場にプロシードハート・オーキスとロイドがいるとき、箱庭の断罪者・シルヴィアの【超進化時】は1枚目でロイド、2枚目でオーキスを選んで破壊する", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const sv = toBoard(s, me, "箱庭の断罪者・シルヴィア");
    const orchis = toBoard(s, opp, "プロシードハート・オーキス");
    const lloyd = toBoard(s, opp, "ロイド");
    s = applyAction(s, { type: "superEvolve", iid: sv.iid });
    for (let i = 0; i < 3 && s.pending; i++) {
      const p = s.pending;
      if (p.kind !== "choose") break;
      s = applyAction(s, { type: "choose", targets: p.candidates.slice(0, p.count) });
    }
    expect(follower(s, lloyd.iid)).toBeUndefined();
    expect(follower(s, orchis.iid)).toBeUndefined();
  });
});

describe("公式Q&A: 回復したとき", () => {
  // 公式Q&Aと食い違う（B）: 今のエンジンは実際に回復した量が 1 以上のときだけ「回復したとき」を働かせる（docs/rules.md 11 章の ⚠️ の仮の決まり）
  it.fails("灼熱のアナテマ・バーンドナイト: クレストを持つ相手のリーダーが0回復しても、「自分のリーダーが回復したとき」の1ダメージは働く", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const bk = toBoard(s, me, "灼熱のアナテマ・バーンドナイト");
    s = applyAction(s, { type: "superEvolve", iid: bk.iid });
    expect(s.players[opp].crests).toHaveLength(1);
    s = applyAction(s, { type: "endTurn" }); // 相手のターン開始時に 1 ダメージ
    s.players[opp].leaderHp = s.players[opp].leaderMaxHp;
    const hp = s.players[opp].leaderHp;
    s.players[opp].pp = 10;
    s = applyAction(s, { type: "play", iid: toHand(s, opp, "森の神秘") }); // 0 回復
    expect(s.players[opp].leaderHp).toBe(hp - 1);
  });
});
