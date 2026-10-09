import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import {
  applyAction,
  createGame,
  legalActions,
  newBoardCard,
  newHandCard,
  resolveTurnEnd,
  type Action,
  type AmuletOnBoard,
  type FollowerOnBoard,
  type GameState,
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

const can = (s: GameState, a: Action) => legalActions(s).some((x) => JSON.stringify(x) === JSON.stringify(a));
const board = (s: GameState, p: PlayerIndex) => s.players[p].board;
const names = (s: GameState, p: PlayerIndex) => board(s, p).map((c) => ALL_CARDS.find((x) => x.id === c.cardId)?.name);
const follower = (s: GameState, iid: number) =>
  [...s.players[0].board, ...s.players[1].board].find((c) => c.iid === iid) as FollowerOnBoard | undefined;

/** 自分のターンを n 回進める（相手は何もしない） */
function passTurns(s: GameState, n: number): GameState {
  for (let i = 0; i < n; i++) s = applyAction(applyAction(s, { type: "endTurn" }), { type: "endTurn" });
  return s;
}

describe("選択", () => {
  it("ファンファーレの「選ぶ」は候補が複数なら選択待ちになり、選んだ対象に効果が働く", () => {
    const { s, me, opp } = setup();
    const a = toBoard(s, opp, "キャラバンマンモス");
    const b = toBoard(s, opp, "刹那のクイックブレイダー");
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "烈火のファイアリザード") });
    expect(t.pending).toMatchObject({ kind: "choose", candidates: [a.iid, b.iid], count: 1 });
    expect(legalActions(t)).toEqual([
      { type: "choose", targets: [a.iid] },
      { type: "choose", targets: [b.iid] },
    ]);
    t = applyAction(t, { type: "choose", targets: [b.iid] });
    expect(t.pending).toBeNull();
    expect(board(t, opp).map((c) => c.iid)).toEqual([a.iid]);
  });

  it("候補が1つなら自動で選ぶ。0なら不発", () => {
    const { s, me, opp } = setup();
    const a = toBoard(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "烈火のファイアリザード") });
    expect(t.pending).toBeNull();
    expect(follower(t, a.iid)?.defense).toBe(9);

    const u = setup();
    const v = applyAction(u.s, { type: "play", iid: toHand(u.s, u.me, "烈火のファイアリザード") });
    expect(v.pending).toBeNull();
    expect(board(v, u.me)).toHaveLength(1);
  });

  it("スペルは「選ぶ」対象がいなければ使えない", () => {
    const { s, me, opp } = setup();
    const crush = toHand(s, me, "ドラゴニュートクラッシュ");
    expect(can(s, { type: "play", iid: crush })).toBe(false);
    toBoard(s, opp, "キャラバンマンモス");
    expect(can(s, { type: "play", iid: crush })).toBe(true);
  });

  it("潜伏・オーラは相手の能力で選ばれない。ロイドがいるとロイドしか選べない", () => {
    const { s, me, opp } = setup();
    toBoard(s, opp, "忍びのムササビ");
    toBoard(s, opp, "潜みしマイニュ");
    const plain = toBoard(s, opp, "キャラバンマンモス");
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "烈火のファイアリザード") });
    expect(follower(t, plain.iid)?.defense).toBe(9); // 唯一の候補として自動選択

    const u = setup();
    toBoard(u.s, u.opp, "キャラバンマンモス");
    const lloyd = toBoard(u.s, u.opp, "ロイド");
    t = applyAction(u.s, { type: "play", iid: toHand(u.s, u.me, "薔薇の閃撃") });
    expect(follower(t, lloyd.iid)?.defense).toBe(3); // リーダーも選べない
  });

  it("モードは選択待ちになり、選んだ能力が働く", () => {
    const { s, me } = setup();
    toBoard(s, me, "キャラバンマンモス");
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "王断の威光") });
    expect(t.pending).toMatchObject({ kind: "mode", options: 2 });
    t = applyAction(t, { type: "mode", index: 1 });
    expect(board(t, me)[0]).toMatchObject({ attack: 11, defense: 11 });
  });
});

describe("誘発", () => {
  it("ラストワードは破壊されたときに働き、消滅では働かない", () => {
    const { s, me, opp } = setup();
    const coachman = toBoard(s, opp, "王家の御者");
    toHand(s, me, "駆け出しのドラゴンスレイヤー");
    const t = applyAction(s, { type: "play", iid: s.players[me].hand[0]!.iid });
    expect(names(t, opp)).toEqual(["ナイト"]);
    expect(t.players[opp].graveyardFollowers).toEqual([coachman.cardId]);
  });

  it("自分のフォロワーが場に出たときの能力（正統なる王冠）", () => {
    const { s, me } = setup();
    s.players[me].board.push(newBoardCard(s, id("正統なる王冠")));
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "刹那のクイックブレイダー") });
    expect(board(t, me)[1]).toMatchObject({ attack: 2, defense: 2 });
  });

  it("ファンファーレで出したナイトにも、場に出たときの能力が働く（ルミナスランサー）", () => {
    const { s, me } = setup();
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "勇猛のルミナスランサー") });
    const knight = board(t, me)[1] as FollowerOnBoard;
    expect(knight.keywords).toContain("rush");
  });

  it("ゴーストはターン終了時に消滅し、墓場に入らない", () => {
    const { s, me } = setup();
    toBoard(s, me, "ゴースト");
    const t = applyAction(s, { type: "endTurn" });
    expect(board(t, me)).toEqual([]);
    expect(t.players[me].graveyard).toBe(0);
  });

  it("操り人形は相手のターン終了時に破壊される", () => {
    const { s, me } = setup();
    toBoard(s, me, "操り人形");
    let t = applyAction(s, { type: "endTurn" });
    expect(board(t, me)).toHaveLength(1);
    t = applyAction(t, { type: "endTurn" });
    expect(board(t, me)).toEqual([]);
  });

  it("メドゥーサの【攻撃時】は交戦前に攻撃先を破壊する", () => {
    const { s, me, opp } = setup();
    const medusa = toBoard(s, me, "猛毒姫・メドゥーサ");
    const target = toBoard(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "attack", attacker: medusa.iid, target: target.iid });
    expect(board(t, opp)).toEqual([]);
    expect(follower(t, medusa.iid)?.defense).toBe(7); // 反撃を受けない
  });
});

describe("進化", () => {
  it("【進化時】は EP で進化させたときに働く", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 4);
    const f = toBoard(s, me, "楽朗の天宮・フィルドア");
    toBoard(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "evolve", iid: f.iid });
    expect(board(t, opp)).toEqual([]);
  });

  it("「〜ではなく」の【超進化時】は【進化時】を置き換える（アンリエット）", () => {
    let { s, me } = setup();
    s = passTurns(s, 6);
    s.players[me].leaderHp = 10;
    const f = toBoard(s, me, "煌響の使者・アンリエット");
    const t = applyAction(s, { type: "superEvolve", iid: f.iid });
    expect(t.players[me].leaderHp).toBe(14);
  });

  it("効果で超進化させても【超進化時】は働かない（オリヴィエ）", () => {
    let { s, me, opp } = setup();
    s = passTurns(s, 6);
    const archer = toBoard(s, me, "ソニックアーチャー・セルウィン");
    const olivier = toBoard(s, me, "勇壮の堕天使・オリヴィエ");
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    const t = applyAction(s, { type: "superEvolve", iid: olivier.iid });
    expect(follower(t, archer.iid)).toMatchObject({ evolve: "superEvolved", attack: 7, defense: 9 });
    expect(board(t, opp).map((c) => c.iid)).toEqual([enemy.iid]); // 手札に戻されていない
  });

  it("「これが進化したとき」は効果による進化でも働く（エーデルワイス）", () => {
    const { s, me, opp } = setup();
    toBoard(s, opp, "キャラバンマンモス");
    s.players[me].board.push(newBoardCard(s, id("大地の魔片")));
    (s.players[me].board[0] as AmuletOnBoard).sigils = 2;
    s.players[me].pp = 4;
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "理光の天宮・エーデルワイス") });
    const edel = board(t, me).find((c) => c.kind === "follower") as FollowerOnBoard;
    expect(edel.evolve).toBe("evolved");
    expect(t.players[me].pp).toBe(2); // 4 - 4 + 2
    expect(t.players[opp].board[0]).toMatchObject({ defense: 6 });
    expect(t.players[me].ep).toBe(2); // EP は使わない
  });
});

describe("リソース・キーワード能力", () => {
  it("土の印は1枚にまとまり、土の秘術でスタックを消費する", () => {
    const { s, me } = setup();
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "魔女の錬金釜") });
    t = applyAction(t, { type: "play", iid: toHand(t, me, "オウルサモナー") }); // 土の印+1
    const sigils = () => board(t, me).filter((c) => c.kind === "amulet") as AmuletOnBoard[];
    expect(sigils()).toHaveLength(1);
    expect(sigils()[0]!.sigils).toBe(2);
    t = applyAction(t, { type: "play", iid: toHand(t, me, "相貌の魔女・レミラミ") });
    expect(names(t, me)).toContain("ガーディアンゴーレム");
    expect(sigils()[0]!.sigils).toBe(1);
  });

  it("土の秘術でスタックが0になった【土の印】アミュレットは破壊される", () => {
    const { s, me } = setup();
    const amulet = newBoardCard(s, id("大地の魔片"));
    s.players[me].board.push(amulet);
    (amulet as AmuletOnBoard).sigils = 1;
    const graveyard = s.players[me].graveyard;
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "相貌の魔女・レミラミ") });
    expect(names(t, me)).toContain("ガーディアンゴーレム"); // 土の秘術の能力は働く
    expect(board(t, me).some((c) => c.iid === amulet.iid)).toBe(false);
    expect(t.players[me].destroyedAmulets).toContain(id("大地の魔片"));
    expect(t.players[me].graveyard).toBe(graveyard + 1);
  });

  it("土の印が無い状態で+Nすると大地の魔片をスタックNで出す", () => {
    const { s, me } = setup();
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "魔法の薬剤師・ペネロピー") });
    expect(board(t, me).find((c) => c.kind === "amulet")).toMatchObject({ cardId: id("大地の魔片"), sigils: 2 });
  });

  it("スペルブーストで X が増える（ストームブラスト）", () => {
    const { s, me, opp } = setup();
    const target = toBoard(s, opp, "キャラバンマンモス");
    const blast = toHand(s, me, "ストームブラスト");
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "知恵の輝き") });
    expect(t.players[me].hand.find((h) => h.iid === blast)).toMatchObject({ boosts: 1, x: 3 });
    t = applyAction(t, { type: "play", iid: blast });
    expect(follower(t, target.iid)?.defense).toBe(7);
  });

  it("スペルブーストでコストが下がる（ブレイズデストロイヤー）", () => {
    const { s, me } = setup();
    const blaze = toHand(s, me, "ブレイズデストロイヤー");
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "知恵の輝き") });
    expect(t.players[me].hand.find((h) => h.iid === blaze)?.costMod).toBe(-1);
  });

  it("コンボはプレイしたカード自身も数える（アドベンチャーエルフ・メイ）", () => {
    const { s, me, opp } = setup();
    const enemy = toBoard(s, opp, "キャラバンマンモス");
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "知恵の輝き") });
    t = applyAction(t, { type: "play", iid: toHand(t, me, "知恵の輝き") });
    t = applyAction(t, { type: "play", iid: toHand(t, me, "アドベンチャーエルフ・メイ") });
    expect(follower(t, enemy.iid)?.defense).toBe(7);
  });

  it("ネクロマンスは墓場を消費し、足りなければ働かない", () => {
    const { s, me } = setup();
    s.players[me].graveyard = 3;
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "悪辣のレッサーマミー") });
    expect((board(t, me)[0] as FollowerOnBoard).keywords).not.toContain("storm");
    expect(t.players[me].graveyard).toBe(3);
    t.players[me].graveyard = 4;
    t = applyAction(t, { type: "play", iid: toHand(t, me, "悪辣のレッサーマミー") });
    expect((board(t, me)[1] as FollowerOnBoard).keywords).toContain("storm");
    expect(t.players[me].graveyard).toBe(0);
  });

  it("割りふりは古いフォロワーから体力分ずつ割り当てる", () => {
    const { s, me, opp } = setup();
    const a = toBoard(s, opp, "刹那のクイックブレイダー"); // 1/1
    const b = toBoard(s, opp, "激震のゴリアテ"); // 4/5
    const c = toBoard(s, opp, "キャラバンマンモス"); // 10/10
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "エンドレスハンター・アラガヴィ") });
    expect(follower(t, a.iid)).toBeUndefined();
    expect(follower(t, b.iid)).toBeUndefined();
    expect(follower(t, c.iid)?.defense).toBe(9);
  });

  it("アクトはPPを払い1ターン1回。アクトしたときの能力が働く（セイクリッドグリフォン）", () => {
    const { s, me } = setup();
    const land = newBoardCard(s, id("禁密の聖地"));
    s.players[me].board.push(land);
    const griffon = toBoard(s, me, "セイクリッドグリフォン", { enteredTurn: s.turn });
    let t = applyAction(s, { type: "act", iid: land.iid });
    expect(t.players[me].pp).toBe(9);
    expect(follower(t, griffon.iid)?.keywords).toContain("storm");
    expect(follower(t, griffon.iid)).toMatchObject({ attack: 7, defense: 9 }); // 唯一の候補として+1/+1
    expect(can(t, { type: "act", iid: land.iid })).toBe(false);
  });

  it("融合: コアにコアを融合するとアタックアーティファクトに変身し、素材はなくなる", () => {
    const { s, me } = setup();
    const future = toHand(s, me, "フューチャー・コア");
    const past = toHand(s, me, "パスト・コア");
    expect(can(s, { type: "play", iid: future })).toBe(false); // プレイできない
    const t = applyAction(s, { type: "fuse", host: future, materials: [past] });
    expect(t.players[me].hand).toEqual([expect.objectContaining({ iid: future, cardId: id("アタックアーティファクト") })]);
  });

  it("融合: 素材のコストの合計で変身先が決まる", () => {
    const { s, me } = setup();
    const attack = toHand(s, me, "アタックアーティファクト");
    const cores = [toHand(s, me, "フューチャー・コア"), toHand(s, me, "パスト・コア")];
    const t = applyAction(s, { type: "fuse", host: attack, materials: cores });
    expect(t.players[me].hand[0]?.cardId).toBe(id("デストロイアーティファクトβ"));
  });

  it("融合の合法手は、同じカードの融合先・素材を区別しない", () => {
    const { s, me } = setup();
    const hosts = [toHand(s, me, "フューチャー・コア"), toHand(s, me, "フューチャー・コア")];
    toHand(s, me, "パスト・コア");
    toHand(s, me, "パスト・コア");
    const fuses = legalActions(s).filter((a) => a.type === "fuse");
    // 融合先はフューチャー1枚分のみ（同じカード）＋パスト1枚分。素材は種類ごとの枚数の組み合わせ
    expect(new Set(fuses.map((a) => (a.type === "fuse" ? a.host : 0))).size).toBe(2);
    expect(fuses.filter((a) => a.type === "fuse" && a.host === hosts[0])).toHaveLength(2 * 3 - 1);
    // 1枚目が融合済みでも、同じカードの2枚目は融合できる
    const t = applyAction(s, fuses.find((a) => a.type === "fuse" && a.host === hosts[0])!);
    expect(legalActions(t).some((a) => a.type === "fuse" && a.host === hosts[1])).toBe(true);
  });

  it("デストロイアーティファクトαは融合した種類が累計2でΩに変身する", () => {
    let { s, me } = setup();
    const alpha = toHand(s, me, "デストロイアーティファクトα");
    toHand(s, me, "デストロイアーティファクトβ");
    toHand(s, me, "デストロイアーティファクトγ");
    const [, beta, gamma] = s.players[me].hand.map((h) => h.iid);
    s = applyAction(s, { type: "fuse", host: alpha, materials: [beta!] });
    expect(s.players[me].hand.find((h) => h.iid === alpha)?.cardId).toBe(id("デストロイアーティファクトα"));
    expect(can(s, { type: "fuse", host: alpha, materials: [gamma!] })).toBe(false); // 1ターン1回
    s = passTurns(s, 1);
    s = applyAction(s, { type: "fuse", host: alpha, materials: [gamma!] });
    expect(s.players[me].hand.find((h) => h.iid === alpha)?.cardId).toBe(id("イクシードアーティファクトΩ"));
  });

  it("クレストはリーダーに付き、カウントダウンでなくなる（バルト）", () => {
    const { s, me, opp } = setup();
    let t = applyAction(s, { type: "play", iid: toHand(s, me, "闇の賞金稼ぎ・バルト") });
    expect(t.players[me].crests).toHaveLength(1);
    expect(board(t, me)).toHaveLength(1); // 場の枠を使わない
    t = applyAction(t, { type: "endTurn" });
    expect(t.players[me].leaderHp).toBe(19);
    expect(t.players[opp].leaderHp).toBe(19);
    t = passTurns(applyAction(t, { type: "endTurn" }), 3);
    expect(t.players[me].crests).toEqual([]);
  });

  it("アポカリプスデッキ", () => {
    const { s, me } = setup();
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "最果ての罪・サタン") });
    expect(t.players[me].deck).toHaveLength(10);
  });
});

describe("ターン終了時の処理だけを進める（resolveTurnEnd）", () => {
  it("ターン終了時の能力と一時的な効果の終了だけを行い、相手のターンは始めない", () => {
    const { s, me, opp } = setup();
    toBoard(s, me, "デストロイアーティファクトγ", { tempAttack: 2 });
    const knight = toBoard(s, opp, "キャラバンマンモス");
    const before = JSON.stringify(s);
    const t = resolveTurnEnd(s);
    expect(follower(t, knight.iid)?.defense).toBe((knight as FollowerOnBoard).defense - 3);
    expect((board(t, me)[0] as FollowerOnBoard).tempAttack).toBe(0);
    expect(t.active).toBe(me);
    expect(t.turn).toBe(s.turn);
    expect(t.players[opp].hand).toHaveLength(0);
    expect(t.players[opp].pp).toBe(s.players[opp].pp);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("ターン終了時の能力が無ければ、一時的な効果だけを終わらせる（終わらせるものも無ければそのまま返す）", () => {
    const { s, me, opp } = setup();
    toBoard(s, opp, "キャラバンマンモス");
    expect(resolveTurnEnd(s)).toBe(s);
    const buffed = toBoard(s, me, "キャラバンマンモス", { tempAttack: 2, tempKeywords: ["ward"] });
    const before = JSON.stringify(s);
    const t = resolveTurnEnd(s);
    expect(follower(t, buffed.iid)?.tempAttack).toBe(0);
    expect(follower(t, buffed.iid)?.tempKeywords).toEqual([]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("選択待ちの局面はそのまま返す", () => {
    const { s, me, opp } = setup();
    toBoard(s, opp, "キャラバンマンモス");
    toBoard(s, opp, "刹那のクイックブレイダー");
    const t = applyAction(s, { type: "play", iid: toHand(s, me, "烈火のファイアリザード") });
    expect(t.pending).not.toBeNull();
    expect(resolveTurnEnd(t)).toBe(t);
  });
});
