// 前期のローテーションのカード能力のうち、プロのデッキのランプD・アミュレットB で使うカードと、そのために足した仕組み
// （アクセラレート・結晶・信仰ほか。docs/pools/azvaldt.md「段取り」、docs/rules.md「12」）。局面の作り方は tests/poolScenario.ts。

import { describe, expect, it } from "vitest";
import { id, specialId } from "../src/cards/abilities/azvaldt/helpers";
import { applyAction, createGame, type AmuletOnBoard, type FollowerOnBoard, type GameState, type PlayerIndex } from "../src/engine";
import { FILLER, amulet, board, can, follower, handNames, names, passTurns, play, setup, toBoard, toHand } from "./poolScenario";

const endTurn = (s: GameState) => applyAction(s, { type: "endTurn" });
const mode = (s: GameState, index: number) => applyAction(s, { type: "mode", index });
const choose = (s: GameState, ...targets: number[]) => applyAction(s, { type: "choose", targets });
const act = (s: GameState, iid: number) => applyAction(s, { type: "act", iid });
const hp = (s: GameState, p: PlayerIndex) => s.players[p].leaderHp;
/** キャラバンマンモス（10/10）の体力 */
const MAMMOTH = 10;

describe("アクセラレート", () => {
  it("PP が今のコストに足りず、アクセラレートのコスト以上なら、アクセラレートのスペルとしてプレイする（金銀絢爛・リュミオール＆アルジャンテ）", () => {
    const { s, me } = setup();
    s.players[me].pp = 2;
    s.players[me].maxPp = 5;
    const h = toHand(s, me, "金銀絢爛・リュミオール＆アルジャンテ");
    expect(can(s, { type: "play", iid: h })).toBe(false);
    s.players[me].pp = 3;
    expect(can(s, { type: "play", iid: h })).toBe(true);
    const grave = s.players[me].graveyard;
    const t = play(s, h);
    // スペルとしてプレイした: 場に出ず墓場が増え、PP最大値が+1
    expect(names(t, me)).toEqual([]);
    expect(t.players[me].graveyard).toBe(grave + 1);
    expect([t.players[me].pp, t.players[me].maxPp]).toEqual([0, 6]);
  });

  it("PP が足りれば普通にプレイする（金銀絢爛の【ファンファーレ】: 手札2枚を捨て、相手のフォロワーとリーダーに4）", () => {
    const { s, me, opp } = setup();
    s.players[me].pp = 8;
    toHand(s, me, "黒炎の奔流");
    toHand(s, me, "黒炎の奔流");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "金銀絢爛・リュミオール＆アルジャンテ"));
    expect(names(t, me)).toEqual(["金銀絢爛・リュミオール＆アルジャンテ"]);
    expect(t.players[me].hand).toHaveLength(0);
    expect(hp(t, opp)).toBe(16);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 4);
  });

  it("アクセラレートでプレイした最古の獄卒は、元のコスト 1 のスペルをプレイしたことになる（大遊戯世界のカウントが減る）", () => {
    const { s, me, opp } = setup();
    s.players[me].pp = 1;
    const world = toBoard(s, me, "大遊戯世界");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "最古の獄卒"));
    expect(names(t, me)).toEqual(["大遊戯世界"]);
    // 元のコスト 1 の大遊戯世界自身を数えて -1（元のコスト 6 として数えたら減らない）
    expect(amulet(t, world.iid)?.countdown).toBe(4);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);
  });
});

describe("結晶", () => {
  it("PP が足りなければ『結晶：崇奉の怯者』（アミュレット）としてプレイし、カウントダウンが 0 になると崇奉の怯者が出て回復する", () => {
    const { s, me } = setup();
    s.players[me].pp = 4;
    s.players[me].leaderHp = 10;
    let t = play(s, toHand(s, me, "崇奉の怯者"));
    expect(names(t, me)).toEqual(["結晶：崇奉の怯者"]);
    expect((board(t, me)[0] as AmuletOnBoard).countdown).toBe(3);
    expect(t.players[me].pp).toBe(2);
    t = passTurns(t, 3);
    expect(names(t, me)).toEqual(["崇奉の怯者"]);
    // 場に出たとき 2 回復
    expect(hp(t, me)).toBe(12);
  });

  it("PP が足りれば崇奉の怯者（フォロワー）をプレイする", () => {
    const { s, me } = setup();
    s.players[me].pp = 5;
    s.players[me].leaderHp = 10;
    const t = play(s, toHand(s, me, "崇奉の怯者"));
    expect(names(t, me)).toEqual(["崇奉の怯者"]);
    expect(hp(t, me)).toBe(12);
  });
});

describe("信仰", () => {
  /** デッキに旧き天書・リアントースを入れた対戦（マリガン後） */
  function faithGame(): { s: GameState; me: PlayerIndex; opp: PlayerIndex } {
    const deck = [...Array(39).fill(FILLER), id("旧き天書・リアントース")];
    let s = createGame({ decks: [deck, Array(40).fill(FILLER)], seed: 3 });
    s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
    s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
    const me = 0 as PlayerIndex;
    return { s, me, opp: 1 as PlayerIndex };
  }
  const faith = (s: GameState, p: PlayerIndex) => s.players[p].crests.find((c) => c.crestId === specialId("旧き天書・リアントース", "faith"));

  it("デッキに信仰を持つカードを入れていると、マリガンの後にリーダーエリアに置かれる（信仰値は 0）", () => {
    const { s, me, opp } = faithGame();
    expect(faith(s, me)?.faith).toBe(0);
    expect(s.players[opp].crests).toEqual([]);
  });

  it("自分のアミュレットが破壊されると信仰値+1。ターン終了時に 10 以上なら -10 して『天書の深淵』を手札に加える", () => {
    let { s, me } = faithGame();
    if (s.active !== me) s = endTurn(s);
    s.players[me].hand = [];
    s.players[me].pp = s.players[me].maxPp = 10;
    const a = toBoard(s, me, "陽光の耳飾り");
    let t = act(s, a.iid);
    expect(faith(t, me)?.faith).toBe(1);
    toBoard(t, me, "旧き天書・リアントース");
    t.players[me].crests.find((c) => c.faith !== undefined)!.faith = 9;
    t.players[me].hand = [];
    let u = endTurn(t);
    expect(handNames(u, me)).not.toContain("天書の深淵");
    t.players[me].crests.find((c) => c.faith !== undefined)!.faith = 12;
    u = endTurn(t);
    expect(faith(u, me)?.faith).toBe(2);
    expect(handNames(u, me)).toContain("天書の深淵");
  });

  it("アルビオンバハムートの「クレストすべてを消滅」で、両方のクレストが消え、信仰は消えない", () => {
    const { s, me, opp } = setup();
    const faithId = specialId("旧き天書・リアントース", "faith");
    const crest = (crestId: string, faithValue?: number) => ({
      iid: s.nextIid++,
      crestId,
      countdown: null,
      order: s.nextOrder++,
      usedOncePerTurn: {},
      ...(faithValue === undefined ? {} : { faith: faithValue }),
    });
    s.players[me].crests.push(crest(faithId, 3), crest("10744112"));
    s.players[opp].crests.push(crest("10744112"));
    const t = mode(play(s, toHand(s, me, "アルビオンバハムート")), 2);
    expect(t.players[me].crests.map((c) => [c.crestId, c.faith])).toEqual([[faithId, 3]]);
    expect(t.players[opp].crests).toEqual([]);
  });
});

describe("ランプD", () => {
  it("世界の味方・ゾーイ: 【エンハンス_10】で疾走・最大体力 1、相手のターン終了までリーダーはダメージを受けない", () => {
    let { s, me, opp } = setup();
    s.players[me].maxPp = 9;
    s.players[me].pp = 5;
    let t = play(s, toHand(s, me, "世界の味方・ゾーイ"));
    expect(t.players[me].maxPp).toBe(10);
    expect(t.players[me].leaderMaxHp).toBe(20);

    ({ s, me, opp } = setup());
    t = play(s, toHand(s, me, "世界の味方・ゾーイ"));
    const zoe = board(t, me)[0]!;
    expect(zoe.keywords).toContain("storm");
    expect([t.players[me].leaderHp, t.players[me].leaderMaxHp]).toEqual([1, 1]);
    // 相手のターン: 攻撃を受けても 0
    t = endTurn(t);
    const foe = toBoard(t, opp, "キャラバンマンモス", { enteredTurn: 0 });
    t = applyAction(t, { type: "attack", attacker: foe.iid, target: "leader" });
    expect(t.players[me].leaderHp).toBe(1);
    expect(t.phase).toBe("main");
    // 次の自分のターンからは受ける
    t = endTurn(endTurn(t));
    t = applyAction(t, { type: "attack", attacker: foe.iid, target: "leader" });
    expect(t.phase).toBe("ended");
  });

  it("律する《正義》・イランツァ: 進化前はランダム2枚に8・8回復、進化後は相手のリーダーに8", () => {
    let { s, me, opp } = setup();
    s.players[me].leaderHp = 5;
    toBoard(s, me, "律する《正義》・イランツァ");
    toBoard(s, opp, "キャラバンマンモス");
    toBoard(s, opp, "キャラバンマンモス");
    let t = endTurn(s);
    expect(board(t, opp).map((c) => (c as FollowerOnBoard).defense)).toEqual([MAMMOTH - 8, MAMMOTH - 8]);
    expect(hp(t, me)).toBe(13);

    ({ s, me, opp } = setup());
    toBoard(s, me, "律する《正義》・イランツァ", { evolve: "evolved" });
    t = endTurn(s);
    expect(hp(t, opp)).toBe(12);
  });

  it("律する《正義》・イランツァ: 進化すると守護を失い威圧を持つ", () => {
    let { s, me } = setup();
    s = passTurns(s, 4);
    const ira = toBoard(s, me, "律する《正義》・イランツァ");
    const t = applyAction(s, { type: "evolve", iid: ira.iid });
    expect(board(t, me)[0]!.keywords).toEqual(["intimidate"]);
  });

  it("空の命運を握る少女・ルリア: 【エンハンス_8】でコスト7以上のフォロワーを引き、PPを7回復", () => {
    const { s, me } = setup();
    s.players[me].deck = [
      { iid: s.nextIid++, cardId: id("笑顔の調理・キミカ") },
      { iid: s.nextIid++, cardId: id("炎の理・ウィルナス") },
    ];
    const t = play(s, toHand(s, me, "空の命運を握る少女・ルリア"));
    expect(handNames(t, me)).toEqual(["炎の理・ウィルナス"]);
    expect(t.players[me].pp).toBe(9);
    expect(board(t, me)[0]!.keywords).toContain("barrier");
  });

  it("旧き天刀・ヴォーラライ: 捨てられると自分の場に出る（笑顔の調理・キミカで捨てる）", () => {
    const { s, me } = setup();
    s.players[me].leaderHp = 10;
    const v = toHand(s, me, "旧き天刀・ヴォーラライ");
    toHand(s, me, "黒炎の奔流");
    const t = choose(play(s, toHand(s, me, "笑顔の調理・キミカ")), v);
    expect(names(t, me)).toEqual(["笑顔の調理・キミカ", "旧き天刀・ヴォーラライ"]);
    expect(hp(t, me)).toBe(11);
  });

  it("天刀の深淵: 捨てられたときも、プレイしたときも、相手のリーダーに1・自分を1回復", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    let t = play(s, toHand(s, me, "天刀の深淵"));
    expect([hp(t, me), hp(t, opp)]).toEqual([11, 19]);
    t = play(t, toHand(t, me, "断頭の斬姫・サガツマツ"));
    // 手札が 0 枚なので捨てずに『赤色流し』2枚
    expect(handNames(t, me)).toEqual(["赤色流し", "赤色流し"]);
    const abyss = toHand(t, me, "天刀の深淵");
    t.players[me].pp = 10;
    t = choose(play(t, toHand(t, me, "断頭の斬姫・サガツマツ")), abyss);
    expect([hp(t, me), hp(t, opp)]).toEqual([12, 18]);
  });

  it("赤色流し: 手札と相手のフォロワーの両方を選べるときだけプレイでき、選んだフォロワーを破壊する", () => {
    const { s, me, opp } = setup();
    const red = toHand(s, me, "赤色流し");
    const junk = toHand(s, me, "黒炎の奔流");
    expect(can(s, { type: "play", iid: red })).toBe(false);
    const foe = toBoard(s, opp, "キャラバンマンモス");
    expect(can(s, { type: "play", iid: red })).toBe(true);
    const t = play(s, red);
    expect(t.players[me].hand.map((h) => h.iid)).not.toContain(junk);
    expect(follower(t, foe.iid)).toBeUndefined();
  });

  it("焦灰のアナテマ・バーンドナイト: 超進化で相手がクレストを持ち、相手のターン開始時に2ダメージ", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const b = toBoard(s, me, "焦灰のアナテマ・バーンドナイト");
    let t = applyAction(s, { type: "superEvolve", iid: b.iid });
    expect(t.players[opp].crests.map((c) => c.crestId)).toEqual(["10744112"]);
    t = endTurn(t);
    expect(hp(t, opp)).toBe(18);
  });

  it("狐火陽炎: 1ダメージ、『狐火陽炎』をデッキに加え、【覚醒】なら1枚引く", () => {
    let { s, me, opp } = setup();
    const deck = s.players[me].deck.length;
    let t = play(s, toHand(s, me, "狐火陽炎"));
    expect(hp(t, opp)).toBe(19);
    // 1 枚加えて 1 枚引いた
    expect(t.players[me].deck).toHaveLength(deck);
    expect(t.players[me].hand).toHaveLength(1);

    ({ s, me, opp } = setup());
    s.players[me].maxPp = 6;
    t = play(s, toHand(s, me, "狐火陽炎"));
    expect(t.players[me].deck).toHaveLength(deck + 1);
    expect(t.players[me].deck.filter((c) => c.cardId === id("狐火陽炎"))).toHaveLength(1);
    expect(t.players[me].hand).toHaveLength(0);
  });

  it("暗黒次元: 自分のターン終了時、アサイラントでないフォロワーに2ダメージ", () => {
    const { s, me, opp } = setup();
    toBoard(s, me, "暗黒次元");
    const asy = toBoard(s, me, "旧き天刀・ヴォーラライ");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = endTurn(s);
    expect(follower(t, asy.iid)?.defense).toBe(2);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);
  });

  it("クラゲの舞姫: 海洋のフォロワーが場に出ると突進と必殺を持つ", () => {
    const { s, me } = setup();
    let t = play(s, toHand(s, me, "クラゲの舞姫"));
    expect(handNames(t, me)).toEqual(["大海のオルカ"]);
    t = play(t, t.players[me].hand[0]!.iid);
    expect(board(t, me)[0]!.keywords).toEqual(expect.arrayContaining(["rush", "bane"]));
  });
});

describe("アミュレットB", () => {
  it("翼天の変貌・オルメリオ: 自分のアミュレットが破壊されるたびに (1)(2)(3) の順に働き、(3) の次は (1)", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 4);
    s.players[me].leaderHp = 10;
    const o = toBoard(s, me, "翼天の変貌・オルメリオ");
    for (let i = 0; i < 4; i++) toBoard(s, me, "無欠の時計");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    // 進化して自分のアミュレット 4 枚を破壊する
    const t = applyAction(s, { type: "evolve", iid: o.iid });
    expect(names(t, me)).toEqual(["翼天の変貌・オルメリオ", "ホーリーファルコン"]);
    // (1) 3ダメージ、(2) 2回復、(3) ホーリーファルコン、(1) 3ダメージ
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 6);
    expect(hp(t, me)).toBe(12);
  });

  it("刻みし約束: 自分の場に元のコスト6以上のカードがあれば、両方が働く", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "刻みし約束"));
    expect(t.pending).toMatchObject({ kind: "mode" });
    t = mode(t, 1);
    expect(hp(t, me)).toBe(12);
    toBoard(t, me, "神紋ユラティオ");
    t = play(t, toHand(t, me, "刻みし約束"));
    expect(t.pending).toBeNull();
    expect(hp(t, me)).toBe(14);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
  });

  it("崇高の天書: 自分のアミュレットを選んで破壊するとPPを2回復。ラストワードで破壊された元のコスト2以下のラストワードを持つアミュレットが出る", () => {
    const { s, me, opp } = setup();
    s.players[me].pp = 4;
    const holy = toBoard(s, me, "救済の聖典");
    toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "崇高の天書"));
    t = choose(t, holy.iid);
    expect(t.players[me].pp).toBe(2);
    expect(names(t, me)).toEqual(["崇高の天書"]);
    // 崇高の天書が破壊されると、救済の聖典が出る（崇高の天書は元のコスト4なので出ない）
    const tome = board(t, me)[0]!;
    (tome as AmuletOnBoard).countdown = 1;
    t = passTurns(t, 1);
    expect(names(t, me)).toEqual(["救済の聖典"]);
  });

  it("崇高の憎悪・カンディマ: 破壊された元のコスト2以下のラストワードを持つアミュレットから 2 種類が出る", () => {
    const { s, me } = setup();
    s.players[me].destroyedAmulets = [id("救済の聖典"), id("救済の聖典"), id("汚濁の聖水"), id("陽光の耳飾り"), id("崇高の天書")];
    const t = play(s, toHand(s, me, "崇高の憎悪・カンディマ"));
    expect(names(t, me).sort()).toEqual(["崇高の憎悪・カンディマ", "救済の聖典", "汚濁の聖水"].sort());
  });

  it("破壊されたアミュレットからは、破壊された回数に比例した確率で選ぶ（2 種類は、1 つ目と同じカードを除いてから選ぶ）", () => {
    // 救済の聖典 6 回・汚濁の聖水 1 回・有翼の石像 1 回。カンディマの 2 種類に救済の聖典が入る確率は
    // 6/8 + 2 × (1/8 × 6/7) ≈ 0.96（種類ごとに等しい確率なら 2/3）
    const games = 200;
    let withScripture = 0;
    for (let seed = 1; seed <= games; seed++) {
      const { s, me } = setup(seed);
      s.players[me].destroyedAmulets = [...Array.from({ length: 6 }, () => id("救済の聖典")), id("汚濁の聖水"), id("有翼の石像")];
      const t = play(s, toHand(s, me, "崇高の憎悪・カンディマ"));
      const out = names(t, me).filter((n) => n !== "崇高の憎悪・カンディマ");
      expect(new Set(out).size).toBe(2);
      if (out.includes("救済の聖典")) withScripture++;
    }
    expect(withScripture / games).toBeGreaterThan(0.88);
  });

  it("天書の深淵: 自分のアミュレットを選んだなら相手のリーダーに2ダメージ。『天書の深淵』を手札に加える", () => {
    const { s, me, opp } = setup();
    const own = toBoard(s, me, "無欠の時計");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(play(s, toHand(s, me, "天書の深淵")), foe.iid);
    expect(follower(t, foe.iid)).toBeUndefined();
    expect(hp(t, opp)).toBe(20);
    expect(handNames(t, me)).toEqual(["天書の深淵"]);
    t = play(t, t.players[me].hand[0]!.iid);
    expect(amulet(t, own.iid)).toBeUndefined();
    expect(hp(t, opp)).toBe(18);
  });

  it("朋友の学級: ターン終了時に1枚引き、進化後のフォロワーがいれば1、超進化後なら2回復", () => {
    let { s, me } = setup();
    s.players[me].leaderHp = 10;
    toBoard(s, me, "朋友の学級");
    let t = endTurn(s);
    expect(hp(t, me)).toBe(10);
    expect(t.players[me].hand).toHaveLength(1);
    ({ s, me } = setup());
    s.players[me].leaderHp = 10;
    toBoard(s, me, "朋友の学級");
    toBoard(s, me, "キャラバンマンモス", { evolve: "evolved" });
    t = endTurn(s);
    expect(hp(t, me)).toBe(11);
    ({ s, me } = setup());
    s.players[me].leaderHp = 10;
    toBoard(s, me, "朋友の学級");
    toBoard(s, me, "キャラバンマンモス", { evolve: "superEvolved" });
    t = endTurn(s);
    expect(hp(t, me)).toBe(12);
  });

  it("アドアマネージャー・イニシア: 選んだフォロワーを消滅、自分のアミュレットが3枚以上なら3回復", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    const foe = toBoard(s, opp, "キャラバンマンモス");
    for (let i = 0; i < 3; i++) toBoard(s, me, "無欠の時計");
    const t = play(s, toHand(s, me, "アドアマネージャー・イニシア"));
    expect(follower(t, foe.iid)).toBeUndefined();
    expect(t.players[opp].graveyard).toBe(s.players[opp].graveyard);
    expect(hp(t, me)).toBe(13);
  });

  it("リーリエ・ライツ: コスト2【アクト】で自分のフォロワーを『リーリエ・ライツ』に変身させ、1枚引く", () => {
    const { s, me } = setup();
    const l = toBoard(s, me, "リーリエ・ライツ");
    toBoard(s, me, "キャラバンマンモス");
    const t = act(s, l.iid);
    expect(names(t, me)).toEqual(["リーリエ・ライツ"]);
    expect(board(t, me)[0]!.kind).toBe("amulet");
    expect(t.players[me].hand).toHaveLength(1);
    expect(t.players[me].pp).toBe(8);
  });

  it("魔杖の外科医・ティコ: 自分がアミュレットをアクトすると1回復", () => {
    const { s, me } = setup();
    s.players[me].leaderHp = 10;
    toBoard(s, me, "魔杖の外科医・ティコ");
    const w = toBoard(s, me, "汚濁の聖水");
    const t = act(s, w.iid);
    expect(hp(t, me)).toBe(11);
    expect(amulet(t, w.iid)?.countdown).toBe(2);
  });
});
