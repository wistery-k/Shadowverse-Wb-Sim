// 処理順の決まり（docs/rules.md 11章「ラストワードと「破壊されたとき」の並び」「ターン開始時の処理順」）の最小の場面。
// 2026-11-14 のルールの直し（有志のページとの食い違いと、プロの試合の動画で見つかった順。共有フォルダの notes/rules-fix-spec-2026-11-14.md）。
// 局面は前期のローテーションのカードで作る（tests/poolScenario.ts）。ふっとばしの順は tests/qa.test.ts（番犬の右腕・ミミ、番犬の左腕・ココ）

import { describe, expect, it } from "vitest";
import { crestIdOf, id } from "../src/cards/abilities/azvaldt/helpers";
import { applyAction, createGame, type AmuletOnBoard, type GameState, type PlayerIndex } from "../src/engine";
import { FILLER, can, handNames, names, play, setup, toBoard, toHand } from "./poolScenario";

const endTurn = (s: GameState) => applyAction(s, { type: "endTurn" });
const evolve = (s: GameState, iid: number) => applyAction(s, { type: "evolve", iid });

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

/** 自分の山札を names のカードだけにする（先頭から引く） */
function setDeck(s: GameState, p: PlayerIndex, ...cardNames: string[]): void {
  s.players[p].deck = cardNames.map((n) => ({ iid: s.nextIid++, cardId: id(n) }));
}

function addCrest(s: GameState, p: PlayerIndex, name: string, countdown: number | null = null): void {
  s.players[p].crests.push({ iid: s.nextIid++, crestId: crestIdOf(name), countdown, order: s.nextOrder++, usedOncePerTurn: {} });
}

/** 場のアミュレットのカウントを n にする */
function setCount(c: { kind: string }, n: number): void {
  (c as AmuletOnBoard).countdown = n;
}

/** 進化・超進化できる局面にする（自分のターンの数と EP） */
function canEvolve(s: GameState, p: PlayerIndex): void {
  s.players[p].turnCount = 8;
  s.players[p].ep = 2;
  s.players[p].sep = 2;
}

describe("同時に処理待ちに入ったラストワードと「破壊されたとき」は、場の古い順", () => {
  // プロの試合の動画（Premier Series 26-27 第8節 後半戦 BATTLE 3）の場面。records/pro/ の 3 試合目の印
  it("翼天の変貌・オルメリオの【進化時】で、オルメリオより古い崇高の天書を破壊すると、天書のラストワード（汚濁の聖水）が先で、オルメリオのホーリーファルコンが後", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    s.players[me].destroyedAmulets = [id("汚濁の聖水")];
    toBoard(s, me, "崇高の天書");
    // 「下記の能力から順に1つ」の 3 回目（ホーリーファルコンを出す）にする
    const o = toBoard(s, me, "翼天の変貌・オルメリオ", { x: 2 });
    const t = evolve(s, o.iid);
    expect(names(t, me)).toEqual(["翼天の変貌・オルメリオ", "汚濁の聖水", "ホーリーファルコン"]);
  });

  it("オルメリオのほうが崇高の天書より古ければ、オルメリオのホーリーファルコンが先で、天書のラストワードが後", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    s.players[me].destroyedAmulets = [id("汚濁の聖水")];
    const o = toBoard(s, me, "翼天の変貌・オルメリオ", { x: 2 });
    toBoard(s, me, "崇高の天書");
    const t = evolve(s, o.iid);
    expect(names(t, me)).toEqual(["翼天の変貌・オルメリオ", "ホーリーファルコン", "汚濁の聖水"]);
  });

  it("選んで一度に破壊したカード（旧き天書・リアントース）のラストワードは、選んだ順ではなく場の古い順", () => {
    const { s, me, opp } = setup();
    const raz = toBoard(s, opp, "デーモンドラム・ラズ"); // ラストワード: スケルトン
    const spy = toBoard(s, opp, "聴略の諜報兵"); // ラストワード: ナイト
    const m = toBoard(s, opp, "キャラバンマンモス");
    toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "旧き天書・リアントース"));
    expect(t.pending?.kind).toBe("choose");
    // 新しいほうから選ぶ
    t = applyAction(t, { type: "choose", targets: [spy.iid, m.iid, raz.iid] });
    expect(names(t, opp)).toEqual(["キャラバンマンモス", "スケルトン", "ナイト"]);
  });

  it("手番のプレイヤーのラストワードが先で、相手のラストワードが後（同じ効果で両方の場のフォロワーを破壊）", () => {
    const { s, me, opp } = setup();
    toBoard(s, opp, "デーモンドラム・ラズ");
    toBoard(s, me, "聴略の諜報兵");
    s.players[me].leaderHp = s.players[opp].leaderHp = 10;
    // 神紋ユラティオ: 【ファンファーレ】場のフォロワーすべてを破壊
    const t = play(s, toHand(s, me, "神紋ユラティオ"));
    expect(names(t, me)).toEqual(["神紋ユラティオ", "ナイト"]);
    expect(names(t, opp)).toEqual(["スケルトン"]);
    // 手番のプレイヤーのラストワードのナイトが先に場に出る（場に出た順の番号が小さい）
    expect(t.players[me].board[1]?.order ?? 0).toBeLessThan(t.players[opp].board[0]?.order ?? 0);
  });
});

describe("ターン開始時: 「ターン開始時」の能力と直接召喚は、カウントダウンで破壊されたカードのラストワードより先（公式 Q&A の天司長の後継・サンダルフォン）", () => {
  it("Q&A の獣姫の誓約と同じ: カウント 1 の有翼の石像とホーリーファルコン 4 枚なら、サンダルフォンが直接召喚されて、石像のラストワードのファルコンは場が埋まって出ず、その後サンダルフォンが手札に戻る", () => {
    const { s, me } = setupWithDeck("天司長の後継・サンダルフォン");
    setDeck(s, me, "キャラバンマンモス", "天司長の後継・サンダルフォン", "キャラバンマンモス");
    s.players[me].evolvedCount = 6;
    // カウントは持ち主のターンの始めに減るので、自分の次のターンの始めに 0 になる
    setCount(toBoard(s, me, "有翼の石像"), 1);
    for (let i = 0; i < 4; i++) toBoard(s, me, "ホーリーファルコン");
    const t = endTurn(endTurn(s));
    expect(names(t, me)).toEqual(["ホーリーファルコン", "ホーリーファルコン", "ホーリーファルコン", "ホーリーファルコン"]);
    expect(handNames(t, me)).toEqual(["天司長の後継・サンダルフォン", "キャラバンマンモス"]);
    expect(t.players[me].crests.map((c) => c.crestId)).toEqual([crestIdOf("天司長の後継・サンダルフォン")]);
  });

  it("Q&A の穏やかなる教会と同じ: カウント 1 の大遊戯世界（ラストワードで 2 枚引く）なら、直接召喚、ラストワードで 2 枚、サンダルフォンが手札に戻る、ターンのドローの順", () => {
    const { s, me } = setupWithDeck("天司長の後継・サンダルフォン");
    setDeck(s, me, "知恵の輝き", "天司長の後継・サンダルフォン", "刹那のクイックブレイダー", "キャラバンマンモス");
    s.players[me].evolvedCount = 6;
    setCount(toBoard(s, me, "大遊戯世界"), 1);
    const t = endTurn(endTurn(s));
    expect(names(t, me)).toEqual([]);
    expect(handNames(t, me)).toEqual(["知恵の輝き", "刹那のクイックブレイダー", "天司長の後継・サンダルフォン", "キャラバンマンモス"]);
  });

  it("「これが【直接召喚】されたとき」は場の「フォロワーが場に出たとき」より先（ユーザーが実機で確かめた 2026-11-14）: 場に劣悪の純心・カミシラがいても、サンダルフォンは進化せずに手札に戻り、進化した回数は 6 のまま", () => {
    const { s, me } = setupWithDeck("天司長の後継・サンダルフォン");
    setDeck(s, me, "キャラバンマンモス", "天司長の後継・サンダルフォン", "キャラバンマンモス");
    s.players[me].evolvedCount = 6;
    toBoard(s, me, "劣悪の純心・カミシラ");
    const t = endTurn(endTurn(s));
    expect(names(t, me)).toEqual(["劣悪の純心・カミシラ"]);
    expect(handNames(t, me)).toEqual(["天司長の後継・サンダルフォン", "キャラバンマンモス"]);
    expect(t.players[me].evolvedCount).toBe(6);
  });

  it("クレストの「ターン開始時」の能力は、カウントダウンで破壊されたアミュレットのラストワードより先（焦灰のバーンドナイトのクレストの 2 ダメージで、救済の聖典の回復より前に負ける）", () => {
    const { s, me, opp } = setup();
    addCrest(s, me, "焦灰のアナテマ・バーンドナイト");
    setCount(toBoard(s, me, "救済の聖典"), 1);
    s.players[me].leaderHp = 2;
    const t = endTurn(endTurn(s));
    expect(t.phase).toBe("ended");
    expect(t.winner).toBe(opp);
  });

  it("体力が残れば、クレストの 2 ダメージの後に救済の聖典のラストワードで 2 枚引いて 2 回復し、その回復でクレストの 1 ダメージ", () => {
    const { s, me } = setup();
    addCrest(s, me, "焦灰のアナテマ・バーンドナイト");
    setCount(toBoard(s, me, "救済の聖典"), 1);
    s.players[me].leaderHp = 10;
    const t = endTurn(endTurn(s));
    expect(t.phase).toBe("main");
    expect(t.players[me].leaderHp).toBe(10 - 2 + 2 - 1);
    expect(t.players[me].hand).toHaveLength(3);
  });

  it("クレストのカウントダウンがアミュレットより先（ユーザーが実機で確かめた 2026-11-14）: カウント 1 のクレスト：希望の光彩・リテュエルと結晶：ミラクルアルミラージで場の空きが 1 つになると、リテュエルが出てミラクルアルミラージがあふれる", () => {
    const { s, me } = setup();
    s.players[me].pp = 2;
    const t0 = play(s, toHand(s, me, "ミラクルアルミラージ"));
    expect(names(t0, me)).toEqual(["結晶：ミラクルアルミラージ"]);
    setCount(t0.players[me].board[0]!, 1);
    for (let i = 0; i < 4; i++) toBoard(t0, me, "キャラバンマンモス");
    addCrest(t0, me, "希望の光彩・リテュエル", 1);
    const t = endTurn(endTurn(t0));
    expect(names(t, me)).toEqual(["キャラバンマンモス", "キャラバンマンモス", "キャラバンマンモス", "キャラバンマンモス", "希望の光彩・リテュエル"]);
    expect(t.players[me].crests).toHaveLength(0);
  });
});

describe("処理待ちの能力は、解決を始めるときに元が場を離れていれば働かない（ユーザーが実機で確かめた 2026-11-14。docs/rules.md 11章「能力の元が離れたとき」）", () => {
  it("暗黒次元（先に出したもの）の「ターン終了時」の 2 ダメージで、体力 2 の律する《正義》・イランツァ（進化前）が破壊されると、イランツァの「ターン終了時」は働かない", () => {
    const { s, me, opp } = setup();
    toBoard(s, me, "暗黒次元");
    toBoard(s, me, "律する《正義》・イランツァ", { attack: 14, defense: 2 });
    const e = toBoard(s, opp, "キャラバンマンモス");
    s.players[me].leaderHp = 10;
    const t = endTurn(s);
    expect(names(t, me)).toEqual(["暗黒次元"]);
    expect(t.players[me].leaderHp).toBe(10);
    // 相手のフォロワーには暗黒次元の 2 ダメージだけ
    expect(t.players[opp].board.find((c) => c.iid === e.iid)).toMatchObject({ defense: (e as { defense: number }).defense - 2 });
  });

  it("イランツァが残れば（体力 3）、イランツァの「ターン終了時」で自分のリーダーを 8 回復", () => {
    const { s, me } = setup();
    toBoard(s, me, "暗黒次元");
    toBoard(s, me, "律する《正義》・イランツァ", { attack: 14, defense: 3 });
    s.players[me].leaderHp = 10;
    const t = endTurn(s);
    expect(names(t, me)).toEqual(["暗黒次元", "律する《正義》・イランツァ"]);
    expect(t.players[me].leaderHp).toBe(18);
  });
});

describe("エンハンスはコストを増やす効果の影響を受けない（ユーザーの答え 2026-11-14。docs/rules.md 8章）", () => {
  it("コスト 2・【エンハンス_4】の喧伝の龍人は、コストが 5 に増えていても、PP 4 で 4 を払ってエンハンスでプレイする", () => {
    const { s, me } = setup();
    s.players[me].pp = 4;
    const h = toHand(s, me, "喧伝の龍人", { costMod: 3 });
    expect(can(s, { type: "play", iid: h })).toBe(true);
    const t = play(s, h);
    expect(t.players[me].pp).toBe(0);
    expect(names(t, me)).toEqual(["喧伝の龍人", "喧伝の龍人", "喧伝の龍人"]);
  });

  it("PP がエンハンスの値に足りなければ、増えたコストで普通にプレイする（PP 3 ならコスト 5 は出せず、コスト 3 なら普通にプレイ）", () => {
    let { s, me } = setup();
    s.players[me].pp = 3;
    let h = toHand(s, me, "喧伝の龍人", { costMod: 3 });
    expect(can(s, { type: "play", iid: h })).toBe(false);
    ({ s, me } = setup());
    s.players[me].pp = 3;
    h = toHand(s, me, "喧伝の龍人", { costMod: 1 });
    const t = play(s, h);
    expect(t.players[me].pp).toBe(0);
    expect(names(t, me)).toEqual(["喧伝の龍人"]);
  });
});
