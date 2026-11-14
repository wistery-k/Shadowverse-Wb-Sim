// 前期のローテーションのカード能力（src/cards/abilities/azvaldt/）のカード単位の最小シナリオ。
// 今はプロのデッキのスペルW・アグロNi で使うカードと、そのために足した仕組み（docs/pools/azvaldt.md「段取り」）。
// 局面の作り方は tests/poolScenario.ts。

import { describe, expect, it } from "vitest";
import { CARD_ABILITIES } from "../src/cards/abilities";
import { AZVALDT_CARD_ABILITIES, id } from "../src/cards/abilities/azvaldt";
import { ENGINE_CARDS } from "../src/cards/pools";
import { applyAction, resolveTurnEnd, type AmuletOnBoard, type FollowerOnBoard } from "../src/engine";
import { CARD, amulet, board, can, follower, handNames, nameOf, names, passTurns, play, setup, toBoard, toHand } from "./poolScenario";

describe("前期のローテーション: 足した仕組み", () => {
  it("自分が他のカードをプレイしたとき（大遊戯世界）: 両方の場の、プレイしたカード以外の同じ元のコストのカードで数える", () => {
    const { s, me, opp } = setup();
    const world = toBoard(s, me, "大遊戯世界");
    // 元のコスト 2 のカードが場に無い
    let t = play(s, toHand(s, me, "強襲の特攻隊長"));
    expect(amulet(t, world.iid)?.countdown).toBe(5);
    // 相手の場の元のコスト 2 のカード（強襲の特攻隊長は自分の場にいて、プレイしたカード以外）
    toBoard(t, opp, "渇仰の悪魔");
    t = play(t, toHand(t, me, "睦まやかな団欒"));
    expect(amulet(t, world.iid)?.countdown).toBe(4);
    // 大遊戯世界自身（元のコスト 1）も数える
    t = play(t, toHand(t, me, "達筆の怪異"));
    expect(amulet(t, world.iid)?.countdown).toBe(3);
  });

  it("大遊戯世界: カウントダウンが 0 になって破壊されると 2 枚引く", () => {
    const { s, me } = setup();
    const world = toBoard(s, me, "大遊戯世界");
    (world as AmuletOnBoard).countdown = 1;
    const t = play(s, toHand(s, me, "達筆の怪異"));
    expect(names(t, me)).toEqual(["達筆の怪異"]);
    expect(t.players[me].hand).toHaveLength(2);
  });

  it("相手は自身のデッキから引く（ハッピーフラワー・サミー＆マリー）", () => {
    const { s, me, opp } = setup();
    const t = play(s, toHand(s, me, "ハッピーフラワー・サミー＆マリー"));
    expect(t.players[me].hand).toHaveLength(2);
    expect(t.players[opp].hand).toHaveLength(1);
  });

  it("【守護】を無視して攻撃できる（透き通る信念・アンサージュ）", () => {
    const { s, me, opp } = setup();
    const ward = toBoard(s, opp, "ガーディアンゴーレム");
    const other = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "透き通る信念・アンサージュ"));
    const ansage = board(t, me)[0]!;
    expect(can(t, { type: "attack", attacker: ansage.iid, target: "leader" })).toBe(true);
    expect(can(t, { type: "attack", attacker: ansage.iid, target: other.iid })).toBe(true);
    expect(can(t, { type: "attack", attacker: ansage.iid, target: ward.iid })).toBe(true);
    // ほかのフォロワーは守護に止められる
    const plain = toBoard(t, me, "キャラバンマンモス");
    expect(can(t, { type: "attack", attacker: plain.iid, target: "leader" })).toBe(false);
  });

  it("体力最小のリーダーすべて（残虐の炸裂）: 同じならお互いに", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    s.players[opp].leaderHp = 12;
    let t = play(s, toHand(s, me, "残虐の炸裂"));
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([7, 12]);
    t.players[opp].leaderHp = 7;
    t = play(t, toHand(t, me, "残虐の炸裂"));
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([4, 4]);
  });

  it("自分のリーダーの体力が相手より大きいなら（バニーな悪魔・リミル）。【進化時】も同じ", () => {
    let { s, me, opp } = setup();
    s.players[me].leaderHp = 15;
    s.players[opp].leaderHp = 15;
    let t = play(s, toHand(s, me, "バニーな悪魔・リミル"));
    expect(names(t, me)).toEqual(["バニーな悪魔・リミル"]);
    t.players[opp].leaderHp = 14;
    t = play(t, toHand(t, me, "バニーな悪魔・リミル"));
    expect(names(t, me)).toEqual(["バニーな悪魔・リミル", "バニーな悪魔・リミル", "バット", "バット"]);

    ({ s, me, opp } = setup());
    s = passTurns(s, 4);
    s.players[opp].leaderHp = 10;
    const rimil = toBoard(s, me, "バニーな悪魔・リミル");
    t = applyAction(s, { type: "evolve", iid: rimil.iid });
    expect(names(t, me)).toEqual(["バニーな悪魔・リミル", "バット", "バット"]);
  });

  it("場に他の元のコスト1のカードがあるなら（達筆の怪異）: 相手の場も数え、これ自身は数えない", () => {
    const { s, me, opp } = setup();
    let t = play(s, toHand(s, me, "達筆の怪異"));
    expect(board(t, me)[0]).toMatchObject({ attack: 1, defense: 1 });
    toBoard(t, opp, "キュートな悪魔・リリム");
    t = play(t, toHand(t, me, "達筆の怪異"));
    expect(board(t, me)[1]).toMatchObject({ attack: 2, defense: 2 });
  });

  it("手札で働く自分のターン終了時（ガロダートVSゼット）: 自分のリーダーの体力が12以下ならコスト-1", () => {
    const { s, me } = setup();
    const g = toHand(s, me, "ガロダートVSゼット");
    s.players[me].leaderHp = 13;
    let t = applyAction(s, { type: "endTurn" });
    expect(t.players[me].hand.find((h) => h.iid === g)?.costMod).toBe(0);
    t = applyAction(t, { type: "endTurn" });
    t.players[me].leaderHp = 12;
    // AI 用のターン終了時の処理だけを進めたものとも合う
    expect(resolveTurnEnd(t).players[me].hand.find((h) => h.iid === g)?.costMod).toBe(-1);
    t = applyAction(t, { type: "endTurn" });
    expect(t.players[me].hand.find((h) => h.iid === g)?.costMod).toBe(-1);
  });

  it("デッキに加える・相手のリーダーの体力の最大値を-2（歩む《愚者》・リンクル）", () => {
    let { s, me, opp } = setup();
    let t = play(s, toHand(s, me, "歩む《愚者》・リンクル"));
    expect(t.players[me].crests.map((c) => c.crestId)).toHaveLength(1);
    expect(t.players[opp].leaderMaxHp).toBe(20); // クレストは出た後に得るので、このリンクルでは働かない
    t.players[opp].leaderHp = 20;
    t = play(t, toHand(t, me, "歩む《愚者》・リンクル"));
    expect(t.players[opp]).toMatchObject({ leaderMaxHp: 18, leaderHp: 18 });

    ({ s, me, opp } = setup());
    s = passTurns(s, 6);
    const deck = s.players[me].deck.length;
    const linkle = toBoard(s, me, "歩む《愚者》・リンクル");
    t = applyAction(s, { type: "superEvolve", iid: linkle.iid });
    const cards = t.players[me].deck.map((c) => nameOf(c.cardId));
    expect(cards).toHaveLength(deck + 10);
    expect(cards.filter((n) => n === "歩む《愚者》・リンクル")).toHaveLength(10);
  });

  it("最古の獄卒: 選んだフォロワーに6、選んでいないフォロワーからランダム1枚に2", () => {
    const { s, me, opp } = setup();
    const a = toBoard(s, opp, "キャラバンマンモス");
    const b = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "最古の獄卒"));
    t = applyAction(t, { type: "choose", targets: [a.iid] });
    expect(follower(t, a.iid)?.defense).toBe(4);
    expect(follower(t, b.iid)?.defense).toBe(8);
  });
});

describe("前期のローテーション: スペルウィッチ", () => {
  it("ストームブラスト（再録）: X は 2 から始まり、スペルブーストで +1", () => {
    const { s, me, opp } = setup();
    const target = toBoard(s, opp, "キャラバンマンモス");
    const blast = toHand(s, me, "ストームブラスト");
    expect(s.players[me].hand[0]?.cardId).toBe("10831310");
    // スペルをプレイして 1 回、睦まやかな団欒の能力で 1 回スペルブーストされて X は 4
    let t = play(s, toHand(s, me, "睦まやかな団欒"));
    t = play(t, blast);
    expect(follower(t, target.iid)?.defense).toBe(6);
  });

  it("マナリアスクリプター・ティコ: マナリアの魔弾 2 枚、進化でマナリア・スペルのコスト-1、超進化でクレスト", () => {
    let { s, me, opp } = setup();
    let t = play(s, toHand(s, me, "マナリアスクリプター・ティコ"));
    expect(handNames(t, me)).toEqual(["マナリアの魔弾", "マナリアの魔弾"]);

    ({ s, me, opp } = setup());
    s = passTurns(s, 6);
    s.players[me].hand = [];
    toHand(s, me, "マナリアの魔弾");
    toHand(s, me, "睦まやかな団欒");
    const tiko = toBoard(s, me, "マナリアスクリプター・ティコ");
    t = applyAction(s, { type: "superEvolve", iid: tiko.iid });
    expect(t.players[me].hand.map((h) => h.costMod)).toEqual([-1, 0]);
    expect(t.players[me].crests).toHaveLength(1);
    const hp = t.players[opp].leaderHp;
    t = play(t, t.players[me].hand[0]!.iid); // マナリアの魔弾
    expect(t.players[opp].leaderHp).toBe(hp - 1);
    t = play(t, t.players[me].hand[0]!.iid); // 睦まやかな団欒（マナリアではない）
    expect(t.players[opp].leaderHp).toBe(hp - 1);
  });

  it("鋼鉄の微睡み: X が 5 以上なら 2 回復して PP を 2 回復", () => {
    const { s, me } = setup();
    s.players[me].leaderHp = 10;
    s.players[me].pp = 5;
    let t = play(s, toHand(s, me, "鋼鉄の微睡み"));
    expect(t.players[me]).toMatchObject({ leaderHp: 10, pp: 2 });
    expect(t.players[me].hand).toHaveLength(2);
    t.players[me].hand = [];
    t.players[me].pp = 5;
    t = play(t, toHand(t, me, "鋼鉄の微睡み", { x: 5 }));
    expect(t.players[me]).toMatchObject({ leaderHp: 12, pp: 4 });
  });

  it("恩愛の大地・テトラ＆ラティカ: X が 10 以上でソニック・フォー、20 以上で大いなる回帰も", () => {
    const { s, me } = setup();
    let t = play(s, toHand(s, me, "恩愛の大地・テトラ＆ラティカ", { x: 9 }));
    expect(handNames(t, me)).toEqual([]);
    t.players[me].pp = 10;
    t = play(t, toHand(t, me, "恩愛の大地・テトラ＆ラティカ", { x: 20 }));
    expect(handNames(t, me)).toEqual(["ソニック・フォー", "大いなる回帰"]);
    expect(board(t, me)[0]?.keywords).toContain("storm");
  });

  it("ソニック・フォーと大いなる回帰", () => {
    const { s, me, opp } = setup();
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    const mine = toBoard(s, me, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "ソニック・フォー"));
    expect(follower(t, enemy.iid)?.defense).toBe(5);
    t = play(t, toHand(t, me, "大いなる回帰"));
    expect(follower(t, mine.iid)?.maxAttacks).toBe(2);
  });

  it("災いの言霊・ジンジャー: 出したガーディアンゴーレムに突進、出るたびに手札をスペルブースト", () => {
    const { s, me } = setup();
    const haiku = toHand(s, me, "余情の俳人");
    const t = play(s, toHand(s, me, "災いの言霊・ジンジャー"));
    expect(names(t, me)).toEqual(["災いの言霊・ジンジャー", "ガーディアンゴーレム", "ガーディアンゴーレム"]);
    for (const g of board(t, me).slice(1)) expect(g.keywords).toEqual(["ward", "rush"]);
    expect(t.players[me].hand.find((h) => h.iid === haiku)).toMatchObject({ boosts: 2, costMod: -2 });
  });

  it("明越花・アラ: ファンファーレで10ダメージ、進化で他のフォロワーを壮麗なる隼に変身", () => {
    let { s, me, opp } = setup();
    const a = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "明越花・アラ"));
    expect(board(t, opp)).toEqual([]);
    expect(a.iid).toBeGreaterThan(0);

    ({ s, me, opp } = setup());
    s = passTurns(s, 4);
    const ara = toBoard(s, me, "明越花・アラ");
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    t = applyAction(s, { type: "evolve", iid: ara.iid });
    expect(names(t, opp)).toEqual(["壮麗なる隼"]);
    expect(follower(t, enemy.iid)).toMatchObject({ attack: 4, defense: 4 });
  });

  it("明越花の転変: 手札 1 枚を捨てて 2 枚引く。手札がほかに無ければプレイできない", () => {
    const { s, me } = setup();
    const card = toHand(s, me, "明越花の転変");
    expect(can(s, { type: "play", iid: card })).toBe(false);
    toHand(s, me, "強襲の特攻隊長");
    const t = play(s, card);
    expect(t.players[me].hand).toHaveLength(2);
    expect(handNames(t, me)).not.toContain("強襲の特攻隊長");
  });

  it("相承の意思: 3 つのモード", () => {
    const { s, me, opp } = setup();
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    const mine = toBoard(s, me, "キャラバンマンモス");
    s.players[me].graveyardFollowers = [id("渇仰の悪魔")];
    const run = (index: number) => applyAction(play(s, toHand(s, me, "相承の意思")), { type: "mode", index });
    expect(follower(run(0), enemy.iid)?.defense).toBe(7);
    expect(names(run(1), me)).toEqual(["キャラバンマンモス", "渇仰の悪魔"]);
    expect(follower(run(2), mine.iid)?.attack).toBe(11);
  });

  it("スペルブースト時にコストが下がる（余情の俳人・破式の変貌・フィーリン）", () => {
    const { s, me } = setup();
    const haiku = toHand(s, me, "余情の俳人");
    const filin = toHand(s, me, "破式の変貌・フィーリン");
    // スペルをプレイして 1 回、睦まやかな団欒の能力で 1 回
    const t = play(s, toHand(s, me, "睦まやかな団欒"));
    expect(t.players[me].hand.map((h) => [h.iid, h.costMod])).toEqual([
      [haiku, -2],
      [filin, -2],
    ]);
  });

  it("余情の俳人: ファンファーレで 1 枚引き、ラストワードで手札すべてを 1 回スペルブースト", () => {
    const { s, me, opp } = setup();
    let t = play(s, toHand(s, me, "余情の俳人"));
    expect(t.players[me].hand).toHaveLength(1);
    t.players[me].hand = [];
    const filin = toHand(t, me, "破式の変貌・フィーリン");
    const poet = board(t, me)[0]!;
    (poet as FollowerOnBoard).enteredTurn = 0;
    const enemy = toBoard(t, opp, "キャラバンマンモス");
    t = applyAction(t, { type: "attack", attacker: poet.iid, target: enemy.iid });
    expect(board(t, me)).toEqual([]);
    expect(t.players[me].hand.find((h) => h.iid === filin)).toMatchObject({ boosts: 1, costMod: -1 });
  });
});

describe("前期のローテーション: アグロネクロマンサー", () => {
  it("キュートな悪魔・リリム: 攻撃時にリーダーすべてに1ダメージ、ラストワードでバット", () => {
    const { s, me, opp } = setup();
    const lilim = toBoard(s, me, "キュートな悪魔・リリム");
    const t = applyAction(s, { type: "attack", attacker: lilim.iid, target: "leader" });
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([19, 18]);
  });

  it("元素の共鳴・バアル: 他のフォロワー 1 枚とこれを +1/+1、または相手のフォロワーに 3 ダメージ", () => {
    const { s, me, opp } = setup();
    const ally = toBoard(s, me, "渇仰の悪魔");
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    let t = applyAction(play(s, toHand(s, me, "元素の共鳴・バアル")), { type: "mode", index: 0 });
    expect(follower(t, ally.iid)).toMatchObject({ attack: 3, defense: 3 });
    expect(board(t, me)[1]).toMatchObject({ attack: 3, defense: 3 });
    t = applyAction(play(s, toHand(s, me, "元素の共鳴・バアル")), { type: "mode", index: 1 });
    expect(follower(t, enemy.iid)?.defense).toBe(7);
  });

  it("夜の唱のライブ: 6 ダメージを割りふり、ネクロマンス 6 で相手のリーダーに 2", () => {
    const { s, me, opp } = setup();
    const a = toBoard(s, opp, "渇仰の悪魔");
    const b = toBoard(s, opp, "キャラバンマンモス");
    s.players[me].graveyard = 6;
    const t = play(s, toHand(s, me, "夜の唱のライブ"));
    expect(board(t, opp).map((c) => c.iid)).toEqual([b.iid]);
    expect(follower(t, b.iid)?.defense).toBe(6);
    expect(t.players[opp].leaderHp).toBe(17); // 2 と、破壊された渇仰の悪魔のラストワードの 1
    expect(t.players[me].graveyard).toBe(1); // 6 消費して、使ったスペル 1
  });

  it("誠実なる呪い屋・スージー: 相手のフォロワーを -0/-3、進化で手札のフォロワーを +3/+0", () => {
    let { s, me, opp } = setup();
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "誠実なる呪い屋・スージー"));
    expect(follower(t, enemy.iid)).toMatchObject({ attack: 10, defense: 7, maxDefense: 7 });

    ({ s, me, opp } = setup());
    s = passTurns(s, 4);
    s.players[me].hand = [];
    const f = toHand(s, me, "渇仰の悪魔");
    toHand(s, me, "残虐の炸裂");
    const suzy = toBoard(s, me, "誠実なる呪い屋・スージー");
    t = applyAction(s, { type: "evolve", iid: suzy.iid });
    expect(t.players[me].hand.find((h) => h.iid === f)?.attackMod).toBe(3);
    t = play(t, f);
    expect(board(t, me)[1]).toMatchObject({ attack: 5, defense: 2 });
  });

  it("激烈の副総長と強襲の特攻隊長: リーダーすべてにダメージ", () => {
    const { s, me, opp } = setup();
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "激烈の副総長"));
    expect(follower(t, enemy.iid)?.defense).toBe(7);
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([17, 17]);
    t = play(t, toHand(t, me, "強襲の特攻隊長"));
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([15, 15]);
  });

  it("ガロダートVSゼット: 疾走して自分に 2、または守護を持って相手のフォロワーすべてに 8", () => {
    const { s, me, opp } = setup();
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    let t = applyAction(play(s, toHand(s, me, "ガロダートVSゼット")), { type: "mode", index: 0 });
    expect(board(t, me)[0]?.keywords).toContain("storm");
    expect(t.players[me].leaderHp).toBe(18);
    t = applyAction(play(s, toHand(s, me, "ガロダートVSゼット")), { type: "mode", index: 1 });
    expect(board(t, me)[0]?.keywords).toContain("ward");
    expect(follower(t, enemy.iid)?.defense).toBe(2);
  });

  it("鉄鎖の繋がり: 1 回、エンハンス 4 なら 2 回", () => {
    const { s, me, opp } = setup();
    s.players[me].pp = 3;
    let t = play(s, toHand(s, me, "鉄鎖の繋がり"));
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([19, 19]);
    t.players[me].pp = 4;
    t = play(t, toHand(t, me, "鉄鎖の繋がり"));
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([17, 17]);
  });

  it("渇仰の悪魔とゴーストエスケーパーのラストワード", () => {
    const { s, me, opp } = setup();
    const a = toBoard(s, me, "渇仰の悪魔");
    const b = toBoard(s, me, "ゴーストエスケーパー");
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    let t = applyAction(s, { type: "attack", attacker: a.iid, target: enemy.iid });
    expect(t.players[me].leaderHp).toBe(19);
    expect(t.players[me].hand).toHaveLength(1);
    t = applyAction(t, { type: "attack", attacker: b.iid, target: enemy.iid });
    expect(handNames(t, me)).toEqual(["キャラバンマンモス", "ゴースト"]);
  });
});

// プロのデッキ（data/pools/azvaldt/decks/）のうち、能力を書いた型
const deckFiles = import.meta.glob<string>("../data/pools/azvaldt/decks/*/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});
const DONE_ARCHETYPES = /^名前: (スペルW|アグロNi|ランプD|アミュレットB|コンボE|海賊R|ミッドレンジNi|実験体W|クキシロB|ハイランダーNm)（/m;
/** 能力定義が不要な行（tests/abilities-coverage.test.ts と同じ） */
const STATIC_LINE = /^(【(守護|疾走|突進|必殺|ドレイン|潜伏|威圧|バリア|オーラ|土の印|カウントダウン_\d+)】|1ターンに\d回攻撃できる。)$/;

describe("前期のローテーション: 能力の定義", () => {
  it("能力を書いた型のデッキのカードと、それが手札・場に出すトークン・アクセラレートと結晶の姿には定義がある", () => {
    const byName = new Map(ENGINE_CARDS.filter((c) => c.set !== "token").map((c) => [c.name, c]));
    const names = new Set<string>();
    for (const text of Object.values(deckFiles).filter((t) => DONE_ARCHETYPES.test(t))) {
      for (const line of text.split("\n")) {
        const m = /^\d+\s+(.+)$/.exec(line.trim());
        if (m?.[1]) names.add(m[1]);
      }
    }
    expect(names.size).toBeGreaterThan(25);
    const tokens = ["マナリアの魔弾", "ソニック・フォー", "大いなる回帰", "ガーディアンゴーレム", "壮麗なる隼", "バット", "ゴースト"];
    tokens.push("天刀の深淵", "赤色流し", "大海のオルカ", "天書の深淵", "ホーリーファルコン");
    tokens.push("天槍の深淵", "フェアリー", "森の神秘", "天剣の深淵", "戦慄の海賊旗", "黄金の靴", "黄金の杯", "輝く金貨");
    tokens.push("黄金の小剣", "黄金の首飾り", "スティールナイト", "ナイト", "決意の輝竜・アーサー");
    tokens.push("スケルトン", "腐臭のゾンビ", "天眼の深淵", "真理の召喚", "クレイゴーレム", "大地の魔片", "天晶の魔手", "清純なる白狐");
    tokens.push("アナライズアーティファクト", "天斧の深淵", "低劣の玩具", "拙劣の人形", "撃針の看守", "イマリの小鬼");
    const deckCards = [...names].map((n) => byName.get(n)!);
    const alts = deckCards.flatMap((c) => (c.specials ?? []).map((sp) => CARD.get(sp)).filter((c2) => c2 !== undefined));
    expect(alts.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "金銀絢爛・リュミオール＆アルジャンテ（アクセラレート）",
        "結晶：崇奉の怯者",
        "最古の獄卒（アクセラレート）",
        "結晶：淵底の大佐",
        "愚劣の兵器（アクセラレート）",
      ]),
    );
    const cards = [...deckCards, ...alts, ...tokens.map((n) => CARD.get(id(n))!)];
    const missing = cards
      .filter((c) => c.text.split("\n").some((line) => line !== "" && !STATIC_LINE.test(line)))
      .filter((c) => !AZVALDT_CARD_ABILITIES[c.id] && !CARD_ABILITIES[c.id])
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });
});
