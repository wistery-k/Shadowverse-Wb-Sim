// 前期のローテーションのカード能力のうち、プロのデッキのコンボE・海賊R で使うカードと、そのために足した仕組み
// （奥義・連携・信仰に付く能力・デッキのカードのバフほか。docs/pools/azvaldt.md「段取り」、docs/rules.md「12」）。局面の作り方は tests/poolScenario.ts。

import { describe, expect, it } from "vitest";
import { id, specialId } from "../src/cards/abilities/azvaldt/helpers";
import { applyAction, createGame, type AmuletOnBoard, type FollowerOnBoard, type GameState, type PlayerIndex } from "../src/engine";
import { FILLER, amulet, board, follower, handNames, names, nameOf, play, setup, toBoard, toHand } from "./poolScenario";

const endTurn = (s: GameState) => applyAction(s, { type: "endTurn" });
const mode = (s: GameState, index: number) => applyAction(s, { type: "mode", index });
/** 選ぶ（候補が 1 つだけなら、エンジンが選んで選択待ちにならないので、そのまま返す） */
const choose = (s: GameState, ...targets: number[]) => (s.pending ? applyAction(s, { type: "choose", targets }) : s);
const evolve = (s: GameState, iid: number) => applyAction(s, { type: "evolve", iid });
const superEvolve = (s: GameState, iid: number) => applyAction(s, { type: "superEvolve", iid });
const hp = (s: GameState, p: PlayerIndex) => s.players[p].leaderHp;
/** キャラバンマンモス（10/10）の体力 */
const MAMMOTH = 10;

/** デッキに names のカードを入れた試合の、マリガン後の先攻のターン（手札は空、PP は 10） */
function setupWithDeck(...deckNames: string[]): { s: GameState; me: PlayerIndex; opp: PlayerIndex } {
  const deck = [...deckNames.map((n) => id(n)), ...Array<string>(40 - deckNames.length).fill(FILLER)];
  let s = createGame({ decks: [deck, deck], seed: 1 });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
  const me = s.active;
  const opp = (1 - me) as PlayerIndex;
  s.players[me].hand = [];
  s.players[opp].hand = [];
  s.players[me].pp = s.players[me].maxPp = 10;
  return { s, me, opp };
}

/** 進化できる局面にする（自分のターンの数と EP） */
function canEvolve(s: GameState, p: PlayerIndex): void {
  s.players[p].turnCount = 8;
  s.players[p].ep = 2;
  s.players[p].sep = 2;
}

const faithOf = (s: GameState, p: PlayerIndex, name: string) =>
  s.players[p].crests.find((c) => c.crestId === specialId(name, "faith"));

describe("奥義", () => {
  it("風の理・イーウィヤ: 奥義ゲージ（自分のターンの数＋手札にある間に進化した回数）が 10 以上なら EP を 1 回復", () => {
    let { s, me } = setup();
    s.players[me].turnCount = 9;
    s.players[me].ep = 0;
    let t = play(s, toHand(s, me, "風の理・イーウィヤ"));
    expect(t.players[me].ep).toBe(0);

    ({ s, me } = setup());
    s.players[me].turnCount = 9;
    s.players[me].ep = 0;
    t = play(s, toHand(s, me, "風の理・イーウィヤ", { ougi: 1 }));
    expect(t.players[me].ep).toBe(1);
  });

  it("EP は試合の始めの数（2）より多くは回復しない", () => {
    const { s, me } = setup();
    s.players[me].turnCount = 10;
    const t = play(s, toHand(s, me, "風の理・イーウィヤ"));
    expect(t.players[me].ep).toBe(2);
  });

  it("手札の【奥義】のカードは、自分のフォロワーが進化する（効果による進化を含む）たびにゲージが 1 増える。ほかのカードは数えない", () => {
    let { s, me } = setup();
    canEvolve(s, me);
    const a = toBoard(s, me, "キャラバンマンモス");
    const b = toBoard(s, me, "キャラバンマンモス");
    toHand(s, me, "風の理・イーウィヤ");
    toHand(s, me, "発芽の組員");
    s = evolve(s, a.iid);
    s = choose(play(s, toHand(s, me, "天槍の深淵")), b.iid);
    expect(follower(s, b.iid)?.evolve).toBe("evolved");
    expect(s.players[me].hand.map((h) => [nameOf(h.cardId), h.ougi ?? 0])).toEqual([
      ["風の理・イーウィヤ", 2],
      ["発芽の組員", 0],
    ]);
  });
});

describe("連携", () => {
  it("【連携】のカードをデッキに入れたときだけ、場に出た自分のフォロワーの枚数を数える（召喚したものも数える）", () => {
    let { s, me } = setup();
    expect(s.players[me].followersEntered).toBeUndefined();
    ({ s, me } = setupWithDeck("無音の包囲"));
    expect(s.players[me].followersEntered).toBe(0);
    const t = play(s, toHand(s, me, "焦がれし炎将・マーズ"));
    expect(t.players[me].followersEntered).toBe(4);
  });

  it("無音の包囲: スティールナイトを【突進】付きで加える。【連携_10】なら 2 枚", () => {
    let { s, me } = setupWithDeck("無音の包囲");
    s.players[me].followersEntered = 9;
    let t = play(s, toHand(s, me, "無音の包囲"));
    expect(t.players[me].hand.map((h) => [nameOf(h.cardId), h.keywords])).toEqual([["スティールナイト", ["rush"]]]);

    ({ s, me } = setupWithDeck("無音の包囲"));
    s.players[me].followersEntered = 10;
    t = play(s, toHand(s, me, "無音の包囲"));
    expect(handNames(t, me)).toEqual(["スティールナイト", "スティールナイト"]);
    const kn = t.players[me].hand[1]!;
    t = play(t, kn.iid);
    expect(board(t, me)[0]!.keywords).toContain("rush");
  });
});

describe("信仰に付く能力", () => {
  it("旧き天槍・ササニド: 信仰値を-10して天槍の深淵を加え、信仰は「自分のフォロワーが進化したとき、相手のリーダーに1ダメージ」を持つ", () => {
    let { s, me, opp } = setupWithDeck("旧き天槍・ササニド");
    faithOf(s, me, "旧き天槍・ササニド")!.faith = 9;
    let t = play(s, toHand(s, me, "旧き天槍・ササニド"));
    expect(handNames(t, me)).toEqual([]);
    expect(faithOf(t, me, "旧き天槍・ササニド")).toMatchObject({ faith: 9 });

    ({ s, me, opp } = setupWithDeck("旧き天槍・ササニド"));
    faithOf(s, me, "旧き天槍・ササニド")!.faith = 10;
    t = play(s, toHand(s, me, "旧き天槍・ササニド"));
    expect(handNames(t, me)).toEqual(["天槍の深淵"]);
    expect(faithOf(t, me, "旧き天槍・ササニド")).toMatchObject({ faith: 0, stacks: 1 });
    // 天槍の深淵で旧き天槍・ササニドを進化させる: 信仰値 +1、相手のリーダーに 1
    const sasanid = board(t, me)[0]!;
    t = choose(play(t, t.players[me].hand[0]!.iid), sasanid.iid);
    expect(follower(t, sasanid.iid)?.evolve).toBe("evolved");
    expect(faithOf(t, me, "旧き天槍・ササニド")).toMatchObject({ faith: 1, stacks: 1 });
    expect(hp(t, opp)).toBe(19);
  });

  it("信仰に 2 回付けると、能力が 2 回働く", () => {
    let { s, me, opp } = setupWithDeck("旧き天槍・ササニド");
    canEvolve(s, me);
    const f = faithOf(s, me, "旧き天槍・ササニド")!;
    f.stacks = 2;
    const m = toBoard(s, me, "キャラバンマンモス");
    const t = evolve(s, m.iid);
    expect(hp(t, opp)).toBe(18);
    expect(faithOf(t, me, "旧き天槍・ササニド")).toMatchObject({ faith: 1, stacks: 2 });
  });

  it("旧き天剣・イドメタ: 【進化時】信仰値を-5して、信仰は「自分がカードを【エンハンス】でプレイしたとき、自分の場のフォロワーすべては+1/+1」を持つ", () => {
    const { s, me } = setupWithDeck("旧き天剣・イドメタ");
    canEvolve(s, me);
    faithOf(s, me, "旧き天剣・イドメタ")!.faith = 5;
    const idometa = toBoard(s, me, "旧き天剣・イドメタ");
    let t = evolve(s, idometa.iid);
    expect(faithOf(t, me, "旧き天剣・イドメタ")).toMatchObject({ faith: 0, stacks: 1 });
    // エンハンスでプレイしたので、信仰値 +1 と場のフォロワーすべて +1/+1（いまプレイしたフォロワーも）
    const randle = toHand(t, me, "信念の蹴撃・ランドル");
    t = play(t, randle);
    expect(faithOf(t, me, "旧き天剣・イドメタ")).toMatchObject({ faith: 1, stacks: 1 });
    expect([follower(t, idometa.iid)?.attack, follower(t, idometa.iid)?.defense]).toEqual([4, 5]);
    expect([follower(t, randle)?.attack, follower(t, randle)?.defense]).toEqual([4, 3]);
    expect(follower(t, randle)?.keywords).toContain("storm");
    // エンハンスでないプレイでは働かない
    t.players[me].pp = 2;
    const randle2 = toHand(t, me, "信念の蹴撃・ランドル");
    t = play(t, randle2);
    expect(faithOf(t, me, "旧き天剣・イドメタ")).toMatchObject({ faith: 1 });
    expect(follower(t, randle2)?.attack).toBe(3);
  });
});

describe("コンボE", () => {
  it("操嵩のアナテマ・ダストデイズ: 選んだフォロワーは-0/-X（X はこれの攻撃力）、コンボ +1。進化時にクレストを持つ", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(play(s, toHand(s, me, "操嵩のアナテマ・ダストデイズ")), foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
    expect(t.players[me].combo).toBe(2);
    t = evolve(t, board(t, me)[0]!.iid);
    expect(t.players[me].crests.map((c) => c.crestId)).toEqual(["10714112"]);
  });

  it("クレスト：操嵩のアナテマ・ダストデイズ: ターン終了時に【コンボ_3】なら、デッキのフォロワーすべては+1/+1（引くとその能力値）", () => {
    let { s, me } = setup();
    s.players[me].crests.push({ iid: s.nextIid++, crestId: "10714112", countdown: 3, order: s.nextOrder++, usedOncePerTurn: {} });
    s.players[me].combo = 3;
    s = endTurn(s);
    expect(s.players[me].deck.every((d) => d.kept?.attackMod === 1 && d.kept.defenseMod === 1)).toBe(true);
    s = endTurn(s);
    // 自分のターンの始めに引いたキャラバンマンモスは 11/11
    const drawn = s.players[me].hand[0]!;
    expect([nameOf(drawn.cardId), drawn.attackMod, drawn.defenseMod]).toEqual(["キャラバンマンモス", 1, 1]);
    s.players[me].pp = 10;
    const t = play(s, drawn.iid);
    expect([follower(t, drawn.iid)?.attack, follower(t, drawn.iid)?.defense]).toEqual([11, 11]);
  });

  it("【コンボ_3】でないときは、デッキのフォロワーは変わらない", () => {
    let { s, me } = setup();
    s.players[me].crests.push({ iid: s.nextIid++, crestId: "10714112", countdown: 3, order: s.nextOrder++, usedOncePerTurn: {} });
    s.players[me].combo = 2;
    s = endTurn(s);
    expect(s.players[me].deck.every((d) => d.kept === undefined)).toBe(true);
  });

  it("煙管の咎人・マガチヨ: 選んだフォロワーに 4。【コンボ_3】なら選ばずにすべてに 4", () => {
    let { s, me, opp } = setup();
    let a = toBoard(s, opp, "キャラバンマンモス");
    let b = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(play(s, toHand(s, me, "煙管の咎人・マガチヨ")), a.iid);
    expect([follower(t, a.iid)?.defense, follower(t, b.iid)?.defense]).toEqual([MAMMOTH - 4, MAMMOTH]);

    ({ s, me, opp } = setup());
    a = toBoard(s, opp, "キャラバンマンモス");
    b = toBoard(s, opp, "キャラバンマンモス");
    s.players[me].combo = 2;
    t = play(s, toHand(s, me, "煙管の咎人・マガチヨ"));
    expect(t.pending).toBeNull();
    expect([follower(t, a.iid)?.defense, follower(t, b.iid)?.defense]).toEqual([MAMMOTH - 4, MAMMOTH - 4]);
  });

  it("根差の刺客: フェアリーを加える。【コンボ_3】ならそれは【必殺】を持つ", () => {
    let { s, me } = setup();
    let t = play(s, toHand(s, me, "根差の刺客"));
    expect(t.players[me].hand.map((h) => [nameOf(h.cardId), h.keywords])).toEqual([["フェアリー", []]]);

    ({ s, me } = setup());
    s.players[me].combo = 2;
    t = play(s, toHand(s, me, "根差の刺客"));
    expect(t.players[me].hand.map((h) => [nameOf(h.cardId), h.keywords])).toEqual([["フェアリー", ["bane"]]]);
  });

  it("緋岸橙酔: 手札にある自分のターン終了時、【コンボ_3】ならコスト-1", () => {
    let { s, me } = setup();
    const h = toHand(s, me, "緋岸橙酔");
    s.players[me].combo = 3;
    s = endTurn(s);
    expect(s.players[me].hand.find((c) => c.iid === h)?.costMod).toBe(-1);
  });

  it("氷界の鹿王: 森の神秘 2 枚。自分のターン終了時、相手のフォロワーに攻撃力の分を割りふる。超進化でクレスト", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "氷界の鹿王"));
    expect(handNames(t, me)).toEqual(["森の神秘", "森の神秘"]);
    const deer = board(t, me)[0]!;
    t = superEvolve(t, deer.iid);
    expect(t.players[me].crests.map((c) => c.crestId)).toEqual(["10714122"]);
    // 超進化で 8/8。ターン終了時に 8 を割りふる（相手のフォロワーは 1 枚なので全部）
    t = endTurn(t);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 8);
  });

  it("調和の舞手・ユエル＆ソシエのクレスト: 自分がフォロワーをプレイしたとき、自分のターンごとに1回、それは進化する", () => {
    const { s, me } = setup();
    s.players[me].crests.push({ iid: s.nextIid++, crestId: "10414122", countdown: 4, order: s.nextOrder++, usedOncePerTurn: {} });
    const a = toHand(s, me, "発芽の組員");
    const b = toHand(s, me, "発芽の組員");
    let t = play(s, a);
    expect(follower(t, a)?.evolve).toBe("evolved");
    t = play(t, b);
    expect(follower(t, b)?.evolve).toBe("none");
  });

  it("優雅なる虫風花: 自分の【コンボ】の枚数を引く（これを含む）", () => {
    const { s, me } = setup();
    s.players[me].combo = 2;
    const t = play(s, toHand(s, me, "優雅なる虫風花"));
    expect(t.players[me].hand).toHaveLength(3);
  });

  it("グルーミーガール・モエル: 選んだ手札をデッキに戻し、1 枚引く", () => {
    const { s, me } = setup();
    const back = toHand(s, me, "優雅なる虫風花");
    const deck = s.players[me].deck.length;
    const t = choose(play(s, toHand(s, me, "グルーミーガール・モエル")), back);
    expect(t.players[me].deck).toHaveLength(deck);
    expect(t.players[me].hand).toHaveLength(1);
  });

  it("ゴッズレポーター: 超進化でゴッズレポーター 2 枚を出す。ラストワードで 1 枚引く", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const g = toBoard(s, me, "ゴッズレポーター");
    const t = superEvolve(s, g.iid);
    expect(names(t, me)).toEqual(["ゴッズレポーター", "ゴッズレポーター", "ゴッズレポーター"]);
  });

  it("天槍の深淵: 進化前の自分のフォロワーを進化させる（【進化時】は働かない）", () => {
    const { s, me } = setup();
    const b = toBoard(s, me, "枝葉の舎弟頭");
    const other = toBoard(s, me, "キャラバンマンモス");
    const t = choose(play(s, toHand(s, me, "天槍の深淵")), b.iid);
    expect(follower(t, b.iid)?.evolve).toBe("evolved");
    expect(follower(t, other.iid)?.attack).toBe(10);
  });
});

describe("海賊R", () => {
  it("戦慄の海賊旗: 自分がスペルをプレイするとカウント-1。0 になると相手のリーダーに 2", () => {
    const { s, me, opp } = setup();
    const flag = toBoard(s, me, "戦慄の海賊旗");
    (flag as AmuletOnBoard).countdown = 2;
    let t = play(s, toHand(s, me, "黄金の杯"));
    expect(amulet(t, flag.iid)?.countdown).toBe(1);
    t = play(t, toHand(t, me, "黄金の杯"));
    expect(amulet(t, flag.iid)).toBeUndefined();
    expect(hp(t, opp)).toBe(18);
  });

  it("逆行の咎人・バルバロス: 海賊旗を出し、自分の海賊旗すべてのカウント-5", () => {
    const { s, me, opp } = setup();
    const old = toBoard(s, me, "戦慄の海賊旗");
    (old as AmuletOnBoard).countdown = 4;
    const t = play(s, toHand(s, me, "逆行の咎人・バルバロス"));
    expect(amulet(t, old.iid)).toBeUndefined();
    expect(hp(t, opp)).toBe(18);
    const flags = board(t, me).filter((c) => nameOf(c.cardId) === "戦慄の海賊旗") as AmuletOnBoard[];
    expect(flags.map((c) => c.countdown)).toEqual([2]);
  });

  it("燃え落ちる縁: コスト 3 でプレイしたら、コスト 1 の燃え落ちる縁を加える（コスト 1 のものからは加えない）", () => {
    const { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(play(s, toHand(s, me, "燃え落ちる縁")), foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 5);
    const copy = t.players[me].hand[0]!;
    expect([nameOf(copy.cardId), copy.costMod]).toEqual(["燃え落ちる縁", -2]);
    const pp = t.players[me].pp;
    t = choose(play(t, copy.iid), foe.iid);
    expect(t.players[me].pp).toBe(pp - 1);
    expect(follower(t, foe.iid)).toBeUndefined();
    expect(t.players[me].hand).toHaveLength(0);
  });

  it("真紅と群青・ゼタ＆ベアトリクス: もう 1 枚を出す。【エンハンス_6】ならそれは【必殺】、これは【疾走】", () => {
    let { s, me } = setup();
    s.players[me].pp = 5;
    let t = play(s, toHand(s, me, "真紅と群青・ゼタ＆ベアトリクス"));
    expect(board(t, me).map((c) => c.keywords)).toEqual([["rush"], ["rush"]]);

    ({ s, me } = setup());
    t = play(s, toHand(s, me, "真紅と群青・ゼタ＆ベアトリクス"));
    expect(board(t, me).map((c) => [...c.keywords].sort())).toEqual([
      ["rush", "storm"],
      ["bane", "rush"],
    ]);
  });

  it("真王の刃・黄金の騎士: 【エンハンス_8】なら、超進化・相手のフォロワーすべてに 4・リーダーを 4 回復をすべて", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const h = toHand(s, me, "真王の刃・黄金の騎士");
    const t = play(s, h);
    expect(follower(t, h)?.evolve).toBe("superEvolved");
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 4);
    expect(hp(t, me)).toBe(14);
  });

  it("二等分の日常: 自分の場のカードが 2 枚以上なら両方。そうでなければ選ぶ", () => {
    let { s, me } = setup();
    s.players[me].leaderHp = 10;
    toBoard(s, me, "戦慄の海賊旗");
    toBoard(s, me, "戦慄の海賊旗");
    let t = play(s, toHand(s, me, "二等分の日常"));
    expect(hp(t, me)).toBe(12);

    ({ s, me } = setup());
    s.players[me].leaderHp = 10;
    t = mode(play(s, toHand(s, me, "二等分の日常")), 1);
    expect(hp(t, me)).toBe(12);
  });

  it("焦がれし炎将・マーズ: ナイト 3 枚を出し、それぞれ +2/+0 と【突進】、これは +1/+0 ずつ", () => {
    const { s, me } = setup();
    const h = toHand(s, me, "焦がれし炎将・マーズ");
    const t = play(s, h);
    const knights = board(t, me).filter((c) => nameOf(c.cardId) === "ナイト") as FollowerOnBoard[];
    expect(knights.map((k) => [k.attack, k.keywords.includes("rush")])).toEqual([
      [3, true],
      [3, true],
      [3, true],
    ]);
    expect(follower(t, h)?.attack).toBe(4);
  });

  it("波濤の副船長: 超進化で【進化時】も働き、コスト 0 の黄金の小剣・黄金の首飾りを加える", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const v = toBoard(s, me, "波濤の副船長");
    const t = choose(superEvolve(s, v.iid), foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
    expect(names(t, me)).toEqual(["波濤の副船長", "戦慄の海賊旗"]);
    expect(t.players[me].hand.map((h) => [nameOf(h.cardId), h.costMod])).toEqual([
      ["黄金の小剣", -1],
      ["黄金の首飾り", -1],
    ]);
  });

  it("天剣の深淵: 1 ダメージ。【エンハンス_1】なら 3 ダメージ", () => {
    let { s, me, opp } = setup();
    s.players[me].pp = 0;
    let foe = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(play(s, toHand(s, me, "天剣の深淵")), foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 1);

    ({ s, me, opp } = setup());
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = choose(play(s, toHand(s, me, "天剣の深淵")), foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
    expect(t.players[me].pp).toBe(9);
  });

  it("栄耀なる麗金花: 輝く金貨 2 枚。【エンハンス_5】なら 4 枚", () => {
    let { s, me } = setup();
    s.players[me].pp = 4;
    let t = play(s, toHand(s, me, "栄耀なる麗金花"));
    expect(handNames(t, me)).toEqual(["輝く金貨", "輝く金貨"]);
    ({ s, me } = setup());
    t = play(s, toHand(s, me, "栄耀なる麗金花"));
    expect(handNames(t, me)).toEqual(["輝く金貨", "輝く金貨", "輝く金貨", "輝く金貨"]);
  });

  it("迷夢の獅子・モルドレッド: 進化すると決意の輝竜・アーサーを出し、アーサーの進化でモルドレッドを出す", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const m = toBoard(s, me, "迷夢の獅子・モルドレッド");
    let t = evolve(s, m.iid);
    expect(names(t, me)).toEqual(["迷夢の獅子・モルドレッド", "決意の輝竜・アーサー"]);
    t = endTurn(endTurn(t));
    canEvolve(t, me);
    const arthur = board(t, me)[1]!;
    t = evolve(t, arthur.iid);
    expect(names(t, me)).toEqual(["迷夢の獅子・モルドレッド", "決意の輝竜・アーサー", "迷夢の獅子・モルドレッド"]);
  });
});
