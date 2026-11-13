// 前期のローテーションのカード能力のうち、プロのデッキのミッドレンジNi・実験体W・クキシロB で使うカードと、そのために足した仕組み
// （カードを引いたとき・自分のフォロワーが攻撃するとき・死者・タイプ・【ラストワード】を失う・相手のフォロワーのコピー・場に出た枚数ほか。
// docs/pools/azvaldt.md「段取り」、docs/rules.md「12」）。局面の作り方は tests/poolScenario.ts。

import { describe, expect, it } from "vitest";
import { crestIdOf, id } from "../src/cards/abilities/azvaldt/helpers";
import { applyAction, createGame, type AmuletOnBoard, type GameState, type PlayerIndex } from "../src/engine";
import { FILLER, amulet, board, can, follower, handNames, names, play, setup, toBoard, toHand } from "./poolScenario";

const endTurn = (s: GameState) => applyAction(s, { type: "endTurn" });
const mode = (s: GameState, index: number) => applyAction(s, { type: "mode", index });
/** 選ぶ（候補が 1 つだけなら、エンジンが選んで選択待ちにならないので、そのまま返す） */
const choose = (s: GameState, ...targets: number[]) => (s.pending ? applyAction(s, { type: "choose", targets }) : s);
const evolve = (s: GameState, iid: number) => applyAction(s, { type: "evolve", iid });
const superEvolve = (s: GameState, iid: number) => applyAction(s, { type: "superEvolve", iid });
const attack = (s: GameState, attacker: number, target: number | "leader") => applyAction(s, { type: "attack", attacker, target });
const act = (s: GameState, iid: number) => applyAction(s, { type: "act", iid });
const fuse = (s: GameState, host: number, ...materials: number[]) => applyAction(s, { type: "fuse", host, materials });
/** キャラバンマンモス（10/10） */
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

/** 自分の山札の上に names のカードを置く（先頭から引く） */
function deckTop(s: GameState, p: PlayerIndex, ...cardNames: string[]): void {
  s.players[p].deck = [...cardNames.map((n) => ({ iid: s.nextIid++, cardId: id(n) })), ...s.players[p].deck];
}

function addCrest(s: GameState, p: PlayerIndex, name: string, countdown: number | null = null): void {
  s.players[p].crests.push({ iid: s.nextIid++, crestId: crestIdOf(name), countdown, order: s.nextOrder++, usedOncePerTurn: {} });
}

describe("足した仕組み", () => {
  it("【ラストワード】を失う（幽冥の中尉）: 出た中尉は +1/+0 と【突進】を持ち、破壊されても次は出ない", () => {
    const { s, me, opp } = setup();
    const lt = toBoard(s, me, "幽冥の中尉");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = attack(s, lt.iid, foe.iid);
    const next = board(t, me)[0]!;
    expect(names(t, me)).toEqual(["幽冥の中尉"]);
    expect(follower(t, next.iid)).toMatchObject({ attack: 2, keywords: ["rush"], lostLastWords: true });
    t.players[me].board[0] = { ...follower(t, next.iid)!, enteredTurn: 0 };
    t = attack(t, next.iid, foe.iid);
    expect(names(t, me)).toEqual([]);
  });

  it("腐臭のゾンビ: 出たゾンビは【ラストワード】を失う", () => {
    const { s, me, opp } = setup();
    const z = toBoard(s, me, "腐臭のゾンビ");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = attack(s, z.iid, foe.iid);
    const next = board(t, me)[0]!;
    expect(follower(t, next.iid)?.lostLastWords).toBe(true);
    t.players[me].board[0] = { ...follower(t, next.iid)!, enteredTurn: 0 };
    t = attack(t, next.iid, foe.iid);
    expect(names(t, me)).toEqual([]);
  });

  it("リアニメイトで場に出たフォロワーは死者・タイプを持つ（デッドプレゼンター・マクミラン）", () => {
    const { s, me, opp } = setup();
    toBoard(s, me, "デッドプレゼンター・マクミラン");
    s.players[me].graveyardFollowers = [id("幽冥の中尉")];
    const t = play(s, toHand(s, me, "紅札の魂魄使い"));
    const lt = board(t, me).find((c) => c.cardId === id("幽冥の中尉"))!;
    expect(follower(t, lt.iid)).toMatchObject({ undead: true, attack: 2 });
    expect(follower(t, lt.iid)?.keywords).toEqual(expect.arrayContaining(["rush", "ward"]));
    expect(t.players[opp].leaderHp).toBe(19);
  });

  it("自分がカードを引いたとき: 手札に入ったカード 1 枚ごとに働く（手札が上限で墓場に行ったカードでは働かない）", () => {
    const { s, me, opp } = setup();
    toBoard(s, me, "窮鼠の斎女");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    for (let i = 0; i < 8; i++) toHand(s, me, "キャラバンマンモス");
    // 天眼の深淵を出して手札 8 枚。2 枚引くと 1 枚目は手札に入り、2 枚目は上限で墓場へ
    const t = play(s, toHand(s, me, "天眼の深淵"));
    expect(t.players[me].hand).toHaveLength(9);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 1);
  });

  it("自分がカードを引いたとき: 自分のターン開始時に引いたときも働く。相手のターンには働かない（自分のターンなら）", () => {
    const { s, me, opp } = setup();
    toBoard(s, me, "窮鼠の斎女");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = endTurn(s);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH);
    t = endTurn(t);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 1);
  });

  it("『最強』の魅惑: 相手のフォロワーを消滅して、受けたダメージ・バフを引き継いだコピーを自分の場に出す（このターンは攻撃できない）", () => {
    const { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス", { attack: 12, defense: 4 });
    const t = play(s, toHand(s, me, "『最強』の魅惑"));
    expect(board(t, opp)).toEqual([]);
    const copy = board(t, me)[0]!;
    expect(copy.iid).not.toBe(foe.iid);
    expect(follower(t, copy.iid)).toMatchObject({ attack: 12, defense: 4, maxDefense: MAMMOTH });
    expect(can(t, { type: "attack", attacker: copy.iid, target: "leader" })).toBe(false);
  });

  it("場に出た枚数（没入の実験体）: これを含めて 6 枚目なら +3/+3。場に出るたびに数える", () => {
    let { s, me } = setup();
    s.players[me].enteredCounts = { [id("没入の実験体")]: 5 };
    let t = play(s, toHand(s, me, "没入の実験体"));
    expect(follower(t, board(t, me)[0]!.iid)).toMatchObject({ attack: 5, defense: 5 });

    ({ s, me } = setup());
    s.players[me].enteredCounts = { [id("没入の実験体")]: 4 };
    t = play(s, toHand(s, me, "没入の実験体"));
    expect(follower(t, board(t, me)[0]!.iid)).toMatchObject({ attack: 2, defense: 2 });

    ({ s, me } = setup());
    s.players[me].pp = 7;
    t = play(s, toHand(s, me, "心酔の研究者"));
    expect(t.players[me].enteredCounts).toEqual({ [id("没入の実験体")]: 2 });
  });

  it("自分のフォロワーが攻撃するとき（クレスト：魔恋の慕情・シイム）: 天晶の魔手は戦闘の前に +1/+0 する", () => {
    const { s, me, opp } = setup();
    addCrest(s, me, "魔恋の慕情・シイム");
    const hand = toBoard(s, me, "天晶の魔手");
    const t = attack(s, hand.iid, "leader");
    expect(t.players[opp].leaderHp).toBe(18);
    expect(follower(t, hand.iid)?.attack).toBe(2);
  });

  it("PP を消費して働く（万術の咎人・セフィーに融合したとき）: PP が 2 未満なら PP は減らず、実験体も出ない", () => {
    let { s, me } = setup();
    let host = toHand(s, me, "万術の咎人・セフィー");
    let t = fuse(s, host, toHand(s, me, "過剰反応"));
    expect(t.players[me].pp).toBe(8);
    expect(names(t, me)).toEqual(["没入の実験体"]);

    ({ s, me } = setup());
    s.players[me].pp = 1;
    host = toHand(s, me, "万術の咎人・セフィー");
    t = fuse(s, host, toHand(s, me, "過剰反応"));
    expect(t.players[me].pp).toBe(1);
    expect(names(t, me)).toEqual([]);
  });

  it("これに【融合】していたなら（恍惚の才媛）: 超進化で、選んだ没入の実験体は【ドレイン】を持つ", () => {
    let { s, me } = setup();
    canEvolve(s, me);
    let host = toHand(s, me, "恍惚の才媛");
    let t = fuse(s, host, toHand(s, me, "過剰反応"));
    t = play(t, host);
    expect(follower(t, host)?.fused).toBe(true);
    const sub = board(t, me).find((c) => c.cardId === id("没入の実験体"))!;
    t = choose(superEvolve(t, host), sub.iid);
    expect(follower(t, sub.iid)?.keywords).toContain("drain");

    ({ s, me } = setup());
    canEvolve(s, me);
    host = toHand(s, me, "恍惚の才媛");
    t = play(s, host);
    expect(follower(t, host)?.fused).toBeUndefined();
    t = superEvolve(t, host);
    expect(t.pending).toBeNull();
    expect(board(t, me).every((c) => !c.keywords.includes("drain"))).toBe(true);
  });
});

describe("ミッドレンジNi", () => {
  it("デーモンドラム・ラズ: 【進化時】選んだ相手のフォロワーに 3 ダメージ。【ラストワード】スケルトン", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const r = toBoard(s, me, "デーモンドラム・ラズ");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(evolve(s, r.iid), foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
    t = attack(t, r.iid, foe.iid);
    expect(names(t, me)).toEqual(["スケルトン"]);
  });

  it("トラブルネクロマンサー: ゴーストとスケルトン。【進化時】腐臭のゾンビ", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const n = toHand(s, me, "トラブルネクロマンサー");
    let t = play(s, n);
    expect(names(t, me)).toEqual(["トラブルネクロマンサー", "ゴースト", "スケルトン"]);
    t = evolve(t, n);
    expect(names(t, me)).toContain("腐臭のゾンビ");
  });

  it("タイトロープキャット: 選んだ相手のフォロワーに 3 ダメージとスケルトン。【進化時】も同じ", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const cat = toHand(s, me, "タイトロープキャット");
    let t = play(s, cat);
    t = evolve(t, cat);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 6);
    expect(names(t, me)).toEqual(["タイトロープキャット", "スケルトン", "スケルトン"]);
  });

  it("傍死のアナテマ・徒姫: デッキのコスト2以下のナイトメア・フォロワー 2 種類を出し、【突進】を持たせる。【超進化時】他のナイトメア・フォロワーは +2/+2", () => {
    const deck = [...Array<string>(5).fill("デーモンドラム・ラズ"), ...Array<string>(5).fill("幽冥の中尉")];
    const { s, me } = setupWithDeck(...deck);
    canEvolve(s, me);
    const hime = toHand(s, me, "傍死のアナテマ・徒姫");
    let t = play(s, hime);
    expect([...names(t, me)].sort()).toEqual(["デーモンドラム・ラズ", "傍死のアナテマ・徒姫", "幽冥の中尉"].sort());
    const others = board(t, me).filter((c) => c.iid !== hime);
    for (const c of others) expect(c.keywords).toContain("rush");
    const before = others.map((c) => follower(t, c.iid)!.attack);
    t = superEvolve(t, hime);
    expect(others.map((c) => follower(t, c.iid)!.attack)).toEqual(before.map((a) => a + 2));
  });

  it("淵底の大佐: 【ラストワード】ランダムな相手のフォロワーを破壊して 2 回復。結晶で出すとカウントダウンの後に大佐が出る", () => {
    let { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    const col = toBoard(s, me, "淵底の大佐");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = attack(s, col.iid, foe.iid);
    expect(board(t, opp)).toEqual([]);
    expect(t.players[me].leaderHp).toBe(12);

    ({ s, me } = setup());
    s.players[me].pp = 2;
    t = play(s, toHand(s, me, "淵底の大佐"));
    expect(names(t, me)).toEqual(["結晶：淵底の大佐"]);
    (board(t, me)[0] as AmuletOnBoard).countdown = 1;
    t = endTurn(endTurn(t));
    expect(names(t, me)).toEqual(["淵底の大佐"]);
  });

  it("イステンデッドVSマルチルゲート: リアニメイト_2 を 3 回と、相手のフォロワーすべてに 2 ダメージ", () => {
    const { s, me, opp } = setup();
    s.players[me].graveyardFollowers = [id("デーモンドラム・ラズ")];
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "イステンデッドVSマルチルゲート"));
    expect(names(t, me)).toEqual(["イステンデッドVSマルチルゲート", "デーモンドラム・ラズ", "デーモンドラム・ラズ", "デーモンドラム・ラズ"]);
    expect(board(t, me).slice(1).every((c) => c.undead)).toBe(true);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);
  });

  it("クレスト：イステンデッドVSマルチルゲート: ターン終了時、【ラストワード】を持つ自分のカードと相手のフォロワーをランダムに 1 枚ずつ破壊", () => {
    let { s, me, opp } = setup();
    addCrest(s, me, "イステンデッドVSマルチルゲート");
    toBoard(s, me, "天晶の魔手");
    toBoard(s, me, "デーモンドラム・ラズ");
    toBoard(s, opp, "キャラバンマンモス");
    let t = endTurn(s);
    expect(names(t, me)).toEqual(["天晶の魔手", "スケルトン"]);
    expect(board(t, opp)).toEqual([]);

    // 【ラストワード】を失った腐臭のゾンビは数えない
    ({ s, me, opp } = setup());
    addCrest(s, me, "イステンデッドVSマルチルゲート");
    toBoard(s, me, "腐臭のゾンビ", { lostLastWords: true });
    toBoard(s, opp, "キャラバンマンモス");
    t = endTurn(s);
    expect(names(t, me)).toEqual(["腐臭のゾンビ"]);
    expect(names(t, opp)).toEqual(["キャラバンマンモス"]);
  });

  it("デッドプレゼンター・マクミラン: 【ネクロマンス_10】腐臭のゾンビ 3 枚。自分の死者・フォロワーが出たとき、自分のターンなら +1/+0・【突進】【守護】と相手に 1 ダメージ", () => {
    const { s, me, opp } = setup();
    s.players[me].graveyard = 10;
    const t = play(s, toHand(s, me, "デッドプレゼンター・マクミラン"));
    const zombies = board(t, me).filter((c) => c.cardId === id("腐臭のゾンビ"));
    expect(zombies).toHaveLength(3);
    for (const z of zombies) {
      expect(follower(t, z.iid)?.attack).toBe(3);
      expect(z.keywords).toEqual(expect.arrayContaining(["rush", "ward"]));
    }
    expect(t.players[opp].leaderHp).toBe(17);
  });

  it("旧き天眼・ビバティー: 【ネクロマンス_4】これは進化する。進化したとき天眼の深淵を手札に加える", () => {
    let { s, me } = setup();
    s.players[me].graveyard = 4;
    const b = toHand(s, me, "旧き天眼・ビバティー");
    let t = play(s, b);
    expect(follower(t, b)?.evolve).toBe("evolved");
    expect(handNames(t, me)).toEqual(["天眼の深淵"]);

    ({ s, me } = setup());
    t = play(s, toHand(s, me, "旧き天眼・ビバティー"));
    expect(handNames(t, me)).toEqual([]);
  });

  it("出発の憧憬・イツルギ＆タケツミ: 【モード】(1) 相手に 4 ダメージと 4 回復 (2) 相手のフォロワーすべてに 5 ダメージと EP 1 回復", () => {
    let { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    let t = mode(play(s, toHand(s, me, "出発の憧憬・イツルギ＆タケツミ")), 0);
    expect([t.players[me].leaderHp, t.players[opp].leaderHp]).toEqual([14, 16]);

    ({ s, me, opp } = setup());
    s.players[me].ep = 0;
    const foe = toBoard(s, opp, "キャラバンマンモス");
    t = mode(play(s, toHand(s, me, "出発の憧憬・イツルギ＆タケツミ")), 1);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 5);
    expect(t.players[me].ep).toBe(1);
  });

  it("陽と月の薔薇・セレス: 【ネクロマンス_20】手札のナイトメア・カードのコスト -2。【交戦時】交戦相手に 4 ダメージ。ターン終了時 4 回復", () => {
    const { s, me, opp } = setup();
    s.players[me].graveyard = 20;
    s.players[me].leaderHp = 10;
    const ni = toHand(s, me, "タイトロープキャット");
    const wi = toHand(s, me, "烏ノ涅");
    let t = play(s, toHand(s, me, "陽と月の薔薇・セレス"));
    expect(t.players[me].hand.map((h) => h.costMod)).toEqual([-2, 0]);
    expect(t.players[me].hand.map((h) => h.iid)).toEqual([ni, wi]);
    t = endTurn(t);
    expect(t.players[me].leaderHp).toBe(14);

    const { s: s2, me: me2, opp: opp2 } = setup();
    const ceres = toBoard(s2, me2, "陽と月の薔薇・セレス");
    const foe = toBoard(s2, opp2, "キャラバンマンモス");
    t = attack(s2, ceres.iid, foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 5);
  });
});

describe("実験体W", () => {
  it("過剰反応: 真理の召喚 3 枚を手札に加える", () => {
    const { s, me } = setup();
    const t = play(s, toHand(s, me, "過剰反応"));
    expect(handNames(t, me)).toEqual(["真理の召喚", "真理の召喚", "真理の召喚"]);
  });

  it("アルケミック・フレア: 選んだ相手のフォロワーに 4 ダメージと土の印 +1。【奥義】相手に 2 ダメージ", () => {
    let { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "アルケミック・フレア"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 4);
    expect(names(t, me)).toEqual(["大地の魔片"]);
    expect(t.players[opp].leaderHp).toBe(20);

    ({ s, me, opp } = setup());
    s.players[me].turnCount = 10;
    toBoard(s, opp, "キャラバンマンモス");
    t = play(s, toHand(s, me, "アルケミック・フレア"));
    expect(t.players[opp].leaderHp).toBe(18);
  });

  it("人らしい愛: 没入の実験体を場と手札に 1 枚ずつ、どちらも +1/+0", () => {
    const { s, me } = setup();
    const t = play(s, toHand(s, me, "人らしい愛"));
    expect(follower(t, board(t, me)[0]!.iid)?.attack).toBe(3);
    expect(handNames(t, me)).toEqual(["没入の実験体"]);
    expect(t.players[me].hand[0]!.attackMod).toBe(1);
  });

  it("心酔の研究者: 没入の実験体 2 枚。【エンハンス_8】3 枚で【守護】。【進化時】選んだ実験体は【必殺】", () => {
    let { s, me } = setup();
    s.players[me].pp = 7;
    let t = play(s, toHand(s, me, "心酔の研究者"));
    expect(names(t, me)).toEqual(["心酔の研究者", "没入の実験体", "没入の実験体"]);

    ({ s, me } = setup());
    canEvolve(s, me);
    const r = toHand(s, me, "心酔の研究者");
    t = play(s, r);
    const subs = board(t, me).filter((c) => c.cardId === id("没入の実験体"));
    expect(subs).toHaveLength(3);
    for (const c of subs) expect(c.keywords).toContain("ward");
    t = choose(evolve(t, r), subs[0]!.iid);
    expect(follower(t, subs[0]!.iid)?.keywords).toContain("bane");
  });

  it("恍惚の才媛: 2 枚引いて没入の実験体を出す", () => {
    const { s, me } = setup();
    const t = play(s, toHand(s, me, "恍惚の才媛"));
    expect(t.players[me].hand).toHaveLength(2);
    expect(names(t, me)).toEqual(["恍惚の才媛", "没入の実験体"]);
  });

  it("烏ノ涅: 没入の実験体を出し、ランダムな相手のフォロワーに 7 ダメージを 2 回", () => {
    const { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "烏ノ涅"));
    expect(names(t, me)).toEqual(["没入の実験体"]);
    expect(follower(t, foe.iid)).toBeUndefined();
  });

  it("万術の咎人・セフィー: 没入の実験体 2 枚。クレスト：自分の没入の実験体が出たとき、ターンに 1 回【疾走】", () => {
    let { s, me } = setup();
    let t = play(s, toHand(s, me, "万術の咎人・セフィー"));
    expect(names(t, me)).toEqual(["万術の咎人・セフィー", "没入の実験体", "没入の実験体"]);

    ({ s, me } = setup());
    addCrest(s, me, "万術の咎人・セフィー");
    t = play(s, toHand(s, me, "没入の実験体"));
    t = play(t, toHand(t, me, "没入の実験体"));
    expect(board(t, me).map((c) => c.keywords.includes("storm"))).toEqual([true, false]);
  });

  it("魔恋の慕情・シイム: 天晶の魔手 2 枚。超進化でクレスト", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const c = toHand(s, me, "魔恋の慕情・シイム");
    let t = play(s, c);
    expect(names(t, me)).toEqual(["魔恋の慕情・シイム", "天晶の魔手", "天晶の魔手"]);
    t = superEvolve(t, c);
    expect(t.players[me].crests.map((x) => x.crestId)).toEqual([crestIdOf("魔恋の慕情・シイム")]);
  });

  it("ルーン・リチュオル: 相手のフォロワーすべてに 6 ダメージと 3 回復", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "ルーン・リチュオル"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 6);
    expect(t.players[me].leaderHp).toBe(13);
  });
});

describe("クキシロB", () => {
  it("結びの使徒: 【エンハンス_4】1 枚引いて【必殺】。自分のターンに引くと【突進】", () => {
    let { s, me } = setup();
    const m = toHand(s, me, "結びの使徒");
    let t = play(s, m);
    expect(t.players[me].hand).toHaveLength(1);
    expect(follower(t, m)?.keywords).toEqual(expect.arrayContaining(["bane", "rush"]));

    ({ s, me } = setup());
    s.players[me].pp = 3;
    const m2 = toHand(s, me, "結びの使徒");
    t = play(s, m2);
    expect(follower(t, m2)?.keywords).toEqual([]);
  });

  it("英雄幻視・トルー: 自分がアミュレットをアクトしたとき【ドレイン】。堅固なる霧巻花のアクトで手札 2 枚を戻して 2 枚引く", () => {
    const { s, me, opp } = setup();
    const tru = toBoard(s, me, "英雄幻視・トルー");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "堅固なる霧巻花"));
    t = choose(t, foe.iid);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 5);
    toHand(t, me, "過剰反応");
    toHand(t, me, "過剰反応");
    toHand(t, me, "過剰反応");
    const deck = t.players[me].deck.length;
    const amu = board(t, me).find((c) => c.cardId === id("堅固なる霧巻花"))!;
    t = act(t, amu.iid);
    expect(amulet(t, amu.iid)).toBeUndefined();
    expect(follower(t, tru.iid)?.keywords).toContain("drain");
    expect(t.players[me].hand).toHaveLength(3);
    expect(t.players[me].deck).toHaveLength(deck);
  });

  it("霧巻花の激憤: 手札のランダム 1 枚をデッキに戻して 3 枚引く", () => {
    const { s, me } = setup();
    toHand(s, me, "過剰反応");
    toHand(s, me, "過剰反応");
    const deck = s.players[me].deck.length;
    const t = play(s, toHand(s, me, "霧巻花の激憤"));
    expect(t.players[me].hand).toHaveLength(4);
    expect(t.players[me].deck).toHaveLength(deck - 2);
  });

  it("享楽の上位市民: 選んだ手札 1 枚を捨てて、相手のフォロワーすべてに 2 ダメージ（手札が無くても）", () => {
    let { s, me, opp } = setup();
    let foe = toBoard(s, opp, "キャラバンマンモス");
    const a = toHand(s, me, "過剰反応");
    toHand(s, me, "烏ノ涅");
    let t = choose(play(s, toHand(s, me, "享楽の上位市民")), a);
    expect(handNames(t, me)).toEqual(["烏ノ涅"]);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);

    ({ s, me, opp } = setup());
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = play(s, toHand(s, me, "享楽の上位市民"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);
  });

  it("窮鼠の斎女: 1 枚引く（自分の能力で引いたときも働く）。【進化時】も同じ", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const k = toHand(s, me, "窮鼠の斎女");
    let t = play(s, k);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 1);
    t = evolve(t, k);
    expect(t.players[me].hand).toHaveLength(2);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);
  });

  it("希望の光彩・リテュエル: 【モード】の後これに 3 ダメージ。【進化時】クレスト：次の自分のターンに進化したリテュエルを出す", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    const r = toHand(s, me, "希望の光彩・リテュエル");
    let t = mode(play(s, r), 1);
    expect(t.players[opp].leaderHp).toBe(17);
    expect(follower(t, r)?.defense).toBe(1);
    t = evolve(t, r);
    expect(t.players[me].crests.map((c) => c.crestId)).toEqual([crestIdOf("希望の光彩・リテュエル")]);
    t = endTurn(endTurn(t));
    const ritu = board(t, me).filter((c) => c.cardId === id("希望の光彩・リテュエル"));
    expect(ritu).toHaveLength(2);
    expect(follower(t, ritu[1]!.iid)?.evolve).toBe("evolved");
    // 効果で進化したので【進化時】は働かず、クレストは増えない
    expect(t.players[me].crests).toEqual([]);
  });

  it("霧巻花・クキシロ: クレストを得て、手札のランダム 2 枚を戻して 2 枚引く。クレスト：コスト1・3・5 を引くと自分の場に、2・4・6 を引くと相手の場に白狐かファルコン", () => {
    const { s, me } = setup();
    toHand(s, me, "過剰反応");
    let t = play(s, toHand(s, me, "霧巻花・クキシロ"));
    expect(t.players[me].crests.map((c) => c.crestId)).toEqual([crestIdOf("霧巻花・クキシロ")]);
    // 手札の 1 枚を戻して（山札はシャッフルされる）2 枚引く
    expect(t.players[me].hand).toHaveLength(2);

    // 山札の並びを決めて、クレストだけで確かめる
    const { s: s2, me: me2, opp: opp2 } = setup();
    addCrest(s2, me2, "霧巻花・クキシロ");
    deckTop(s2, me2, "結びの使徒", "デーモンドラム・ラズ", "キャラバンマンモス");
    t = play(s2, toHand(s2, me2, "天眼の深淵"));
    const isToken = (n: string | undefined) => n === "清純なる白狐" || n === "ホーリーファルコン";
    expect(names(t, me2).filter(isToken)).toHaveLength(1);
    expect(names(t, opp2).filter(isToken)).toHaveLength(1);
    // コスト 7 は出ない
    t = endTurn(endTurn(t));
    expect(names(t, me2).filter(isToken)).toHaveLength(1);
    expect(names(t, opp2).filter(isToken)).toHaveLength(1);
  });

  it("結晶：ミラクルアルミラージ: コスト1【アクト】でカウント -1、カウントダウンの後にミラクルアルミラージ", () => {
    const { s, me } = setup();
    s.players[me].pp = 2;
    let t = play(s, toHand(s, me, "ミラクルアルミラージ"));
    expect(names(t, me)).toEqual(["結晶：ミラクルアルミラージ"]);
    const amu = board(t, me)[0]!;
    expect(amulet(t, amu.iid)?.countdown).toBe(3);
    t = act(t, amu.iid);
    expect(amulet(t, amu.iid)?.countdown).toBe(2);
    expect(t.players[me].pp).toBe(0);
  });
});
