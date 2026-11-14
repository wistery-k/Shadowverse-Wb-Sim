// 前期のローテーションのカード能力のうち、プロのデッキのハイランダーNm で使うカードと、そのために足した仕組み
// （デッキに重複するカードがないなら・直接召喚・相手のフォロワーが攻撃するとき・受けるダメージの上限・働いていないランダム1つ・
// 場に出たカードの種類・進化した回数ほか。docs/pools/azvaldt.md「段取り」、docs/rules.md「12」）。局面の作り方は tests/poolScenario.ts。

import { describe, expect, it } from "vitest";
import { crestIdOf, id } from "../src/cards/abilities/azvaldt/helpers";
import { applyAction, createGame, type GameState, type PlayerIndex } from "../src/engine";
import { FILLER, board, follower, handNames, names, play, setup, toBoard, toHand } from "./poolScenario";

const endTurn = (s: GameState) => applyAction(s, { type: "endTurn" });
const mode = (s: GameState, index: number) => applyAction(s, { type: "mode", index });
/** 選ぶ（候補が 1 つだけなら、エンジンが選んで選択待ちにならないので、そのまま返す） */
const choose = (s: GameState, ...targets: number[]) => (s.pending ? applyAction(s, { type: "choose", targets }) : s);
const evolve = (s: GameState, iid: number) => applyAction(s, { type: "evolve", iid });
const superEvolve = (s: GameState, iid: number) => applyAction(s, { type: "superEvolve", iid });
const attack = (s: GameState, attacker: number, target: number | "leader") => applyAction(s, { type: "attack", attacker, target });
const act = (s: GameState, iid: number) => applyAction(s, { type: "act", iid });
/** キャラバンマンモス（コスト 7、10/10） */
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

/** 進化・超進化できる局面にする（自分のターンの数と EP） */
function canEvolve(s: GameState, p: PlayerIndex): void {
  s.players[p].turnCount = 8;
  s.players[p].ep = 2;
  s.players[p].sep = 2;
}

/** 自分の山札を names のカードだけにする（先頭から引く） */
function setDeck(s: GameState, p: PlayerIndex, ...cardNames: string[]): void {
  s.players[p].deck = cardNames.map((n) => ({ iid: s.nextIid++, cardId: id(n) }));
}

function addCrest(s: GameState, p: PlayerIndex, name: string, countdown: number | null = null): void {
  s.players[p].crests.push({ iid: s.nextIid++, crestId: crestIdOf(name), countdown, order: s.nextOrder++, usedOncePerTurn: {} });
}
const hasCrest = (s: GameState, p: PlayerIndex, name: string) => s.players[p].crests.some((c) => c.crestId === crestIdOf(name));

describe("足した仕組み", () => {
  it("自分のデッキに重複するカードがないなら（青錆の下っ端）: 山札に同じカードが 2 枚あれば働かない。山札が 0 枚なら働く", () => {
    let { s, me, opp } = setup();
    let foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "青錆の下っ端"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH);

    ({ s, me, opp } = setup());
    setDeck(s, me, "キャラバンマンモス", "ストリートラン");
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = play(s, toHand(s, me, "青錆の下っ端"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 5);

    ({ s, me, opp } = setup());
    setDeck(s, me);
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = play(s, toHand(s, me, "青錆の下っ端"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 5);
  });

  it("進化した回数: 数えるカードがデッキにあれば、進化・超進化・効果での進化を 1 回ずつ数える", () => {
    const { s, me } = setupWithDeck("天司長の後継・サンダルフォン");
    expect(s.players[me].evolvedCount).toBe(0);
    canEvolve(s, me);
    const a = toBoard(s, me, "キャラバンマンモス");
    const b = toBoard(s, me, "キャラバンマンモス");
    let t = evolve(s, a.iid);
    t = play(t, toHand(t, me, "愛すべき相棒・ビィ"));
    expect(t.players[me].evolvedCount).toBe(2);
    t = endTurn(endTurn(t));
    t = superEvolve(t, b.iid);
    expect(t.players[me].evolvedCount).toBe(3);

    // 数えるカードが無いデッキでは数えない（局面に出ない）
    const plain = setup();
    expect(plain.s.players[plain.me].evolvedCount).toBeUndefined();
  });

  it("直接召喚（天司長の後継・サンダルフォン）: 進化した回数が 6 以上なら、ターン開始時のドローの前に場に出て、クレストを持ち手札に戻る", () => {
    let { s, me } = setupWithDeck("天司長の後継・サンダルフォン");
    // 山札の上から引く。直接召喚は山札のどこからでも出る
    const deck = ["キャラバンマンモス", "天司長の後継・サンダルフォン", "キャラバンマンモス"];
    setDeck(s, me, ...deck);
    s.players[me].evolvedCount = 6;
    let t = endTurn(endTurn(s));
    expect(hasCrest(t, me, "天司長の後継・サンダルフォン")).toBe(true);
    expect(handNames(t, me)).toEqual(["天司長の後継・サンダルフォン", "キャラバンマンモス"]);
    expect(t.players[me].deck.some((c) => c.cardId === id("天司長の後継・サンダルフォン"))).toBe(false);
    expect(names(t, me)).toEqual([]);

    ({ s, me } = setupWithDeck("天司長の後継・サンダルフォン"));
    setDeck(s, me, ...deck);
    s.players[me].evolvedCount = 5;
    t = endTurn(endTurn(s));
    expect(hasCrest(t, me, "天司長の後継・サンダルフォン")).toBe(false);
    expect(handNames(t, me)).toEqual(["キャラバンマンモス"]);

    // 場が埋まっていれば山札に残る
    ({ s, me } = setupWithDeck("天司長の後継・サンダルフォン"));
    setDeck(s, me, ...deck);
    s.players[me].evolvedCount = 6;
    for (let i = 0; i < 5; i++) toBoard(s, me, "キャラバンマンモス");
    t = endTurn(endTurn(s));
    expect(hasCrest(t, me, "天司長の後継・サンダルフォン")).toBe(false);
    expect(t.players[me].deck.some((c) => c.cardId === id("天司長の後継・サンダルフォン"))).toBe(true);
  });

  it("相手のフォロワーが攻撃するとき（クレスト：光の理・ル・オー）: 【疾走】を持つフォロワーがリーダーを攻撃するときだけ、戦闘の前に -3/-0", () => {
    const { s, me, opp } = setup();
    addCrest(s, opp, "光の理・ル・オー", 2);
    const a = toBoard(s, me, "キャラバンマンモス", { keywords: ["storm"] });
    const b = toBoard(s, me, "キャラバンマンモス", { keywords: ["storm"] });
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = attack(s, a.iid, "leader");
    expect(t.players[opp].leaderHp).toBe(20 - (MAMMOTH - 3));
    expect(follower(t, a.iid)?.tempAttack).toBe(-3);
    t = attack(t, b.iid, foe.iid);
    // フォロワーへの攻撃では下がらない（10 ダメージで破壊）
    expect(follower(t, foe.iid)).toBeUndefined();
    t = endTurn(t);
    expect(follower(t, a.iid)?.tempAttack).toBe(0);
  });

  it("受けるダメージの上限（空駆ける庇護者・カタリナ）: 4 以上のダメージは 3 になる", () => {
    const { s, me, opp } = setup();
    const k = toBoard(s, opp, "空駆ける庇護者・カタリナ");
    const a = toBoard(s, me, "キャラバンマンモス");
    let t = attack(s, a.iid, k.iid);
    expect(follower(t, k.iid)?.defense).toBe(5 - 3);
    const g = toBoard(t, me, "青錆の下っ端");
    t = attack(t, g.iid, k.iid);
    expect(follower(t, k.iid)?.defense).toBe(5 - 3 - 1);
  });

  it("働いていないランダム1つ（廻る《運命の輪》・スロース）: ターン開始時に 3 つが 1 回ずつ働き、その後は何もしない", () => {
    const { s, me } = setup();
    toBoard(s, me, "廻る《運命の輪》・スロース");
    const m = toBoard(s, me, "キャラバンマンモス");
    toHand(s, me, "キャラバンマンモス");
    s.players[me].leaderHp = 10;
    let t = s;
    const seen: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      const before = { atk: follower(t, m.iid)!.attack, hp: t.players[me].leaderHp };
      t = endTurn(endTurn(t));
      const hand = t.players[me].hand;
      if (hand[0]!.costMod === -1) {
        seen.push("cost");
        // ターン開始時の手札だけ（その後に引いたカードは変わらない）
        expect(hand[hand.length - 1]!.costMod).toBe(0);
      }
      if (follower(t, m.iid)!.attack === before.atk + 2) seen.push("buff");
      if (t.players[me].leaderHp === before.hp + 3) seen.push("heal");
      // ターン終了まで: 次のターンには戻っている
      expect(endTurn(t).players[me].hand[0]!.costMod).toBe(0);
    }
    expect([...seen].sort()).toEqual(["buff", "cost", "heal"]);
  });

  it("廻る《運命の輪》・スロース: 進化後なら自分のターン終了時に相手がクレストを持ち、これは消滅する。クレストは持ち主に働く", () => {
    const { s, me, opp } = setup();
    canEvolve(s, me);
    toHand(s, opp, "キャラバンマンモス");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const sl = toBoard(s, me, "廻る《運命の輪》・スロース");
    let t = evolve(s, sl.iid);
    t = endTurn(t);
    expect(names(t, me)).toEqual([]);
    expect(t.players[me].graveyardFollowers).toEqual([]);
    expect(hasCrest(t, opp, "廻る《運命の輪》・スロース")).toBe(true);
    // 相手のターン開始時に 1 つ働いた（コスト +1・-2/-2・3 ダメージのどれか）
    const o = t.players[opp];
    const worked = [o.hand[0]!.costMod === 1, follower(t, foe.iid)?.attack === MAMMOTH - 2, o.leaderHp === 17];
    expect(worked.filter((x) => x)).toHaveLength(1);
  });

  it("場に出たカードの種類（ストリートラン）: アーティファクト・フォロワーが 3 種類出ていれば両方、2 種類なら選ぶ", () => {
    let { s, me } = setup();
    s.players[me].enteredKinds = [id("アナライズアーティファクト"), id("エンシェントアーティファクト"), id("ミスティックアーティファクト")];
    let t = play(s, toHand(s, me, "ストリートラン"));
    expect(handNames(t, me)).toEqual(["アナライズアーティファクト", "エンシェントアーティファクト"]);

    ({ s, me } = setup());
    s.players[me].enteredKinds = [id("アナライズアーティファクト"), id("エンシェントアーティファクト"), id("ワイルドキャスター")];
    t = mode(play(s, toHand(s, me, "ストリートラン")), 1);
    expect(handNames(t, me)).toEqual(["エンシェントアーティファクト"]);
  });

  it("場に出たカードの種類: 見るカードをデッキに入れたプレイヤーだけ、場に出たカードの種類を覚える（ワイルドキャスター）", () => {
    let { s, me, opp } = setupWithDeck("ストリートラン");
    expect(s.players[me].enteredKinds).toEqual([]);
    s.players[me].pp = 4;
    let t = play(s, toHand(s, me, "ワイルドキャスター"));
    expect([...t.players[me].enteredKinds!].sort()).toEqual([id("ワイルドキャスター"), id("アナライズアーティファクト")].sort());
    expect(t.players[opp].enteredKinds).toEqual([]);

    ({ s, me } = setup());
    t = play(s, toHand(s, me, "ワイルドキャスター"));
    expect(t.players[me].enteredKinds).toBeUndefined();
  });

  it("2 種類を引く（尽小花・イマリの【超進化時】）: 同じカードを除いてから次を引く", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    setDeck(s, me, "誠心なる尽小花", "誠心なる尽小花", "誠心なる尽小花", "ストリートラン", "穢れなき日々", "キャラバンマンモス");
    const im = toBoard(s, me, "尽小花・イマリ");
    const t = superEvolve(s, im.iid);
    expect([...handNames(t, me)].sort()).toEqual(["ストリートラン", "誠心なる尽小花"]);
  });

  it("【必殺】を持つネメシス・フォロワーを引く（屈辱なる放逐）: 選んだ手札を捨てて引く。重複が無ければさらに 2 枚", () => {
    let { s, me } = setup();
    setDeck(s, me, "キャラバンマンモス", "キャラバンマンモス", "束刃の咎人・カットスロート", "青錆の下っ端");
    toHand(s, me, "青錆の下っ端");
    let t = play(s, toHand(s, me, "屈辱なる放逐"));
    expect(handNames(t, me)).toEqual(["束刃の咎人・カットスロート"]);
    expect(t.players[me].deck).toHaveLength(3);

    ({ s, me } = setup());
    setDeck(s, me, "キャラバンマンモス", "束刃の咎人・カットスロート", "青錆の下っ端", "ストリートラン");
    toHand(s, me, "青錆の下っ端");
    t = play(s, toHand(s, me, "屈辱なる放逐"));
    expect(handNames(t, me)[0]).toBe("束刃の咎人・カットスロート");
    expect(handNames(t, me)).toHaveLength(3);
    expect(t.players[me].deck).toHaveLength(1);
  });

  it("非公開で手札に加える（忘失の無垢・アイカ、デバイスマニピュレーター・ジルク）: 破壊された自分のフォロワーと同名のカード", () => {
    let { s, me } = setup();
    s.players[me].graveyardFollowers = [id("報恩の技師・アイザック")];
    let t = play(s, toHand(s, me, "忘失の無垢・アイカ"));
    expect(handNames(t, me)).toEqual(["報恩の技師・アイザック"]);
    expect(t.players[me].hand[0]!.revealed).toBe(false);

    ({ s, me } = setup());
    s.players[me].graveyardFollowers = [id("キャラバンマンモス"), id("アナライズアーティファクト"), id("キャラバンマンモス")];
    t = play(s, toHand(s, me, "デバイスマニピュレーター・ジルク"));
    expect(handNames(t, me)).toEqual(["アナライズアーティファクト"]);

    ({ s, me } = setup());
    t = play(s, toHand(s, me, "デバイスマニピュレーター・ジルク"));
    expect(handNames(t, me)).toEqual([]);
  });

  it("天斧の深淵: 選んだ元のコスト5以上の自分のフォロワーと同名のカードを非公開で手札に加え、コスト -3", () => {
    const { s, me } = setup();
    toBoard(s, me, "キャラバンマンモス");
    toBoard(s, me, "青錆の下っ端");
    const t = play(s, toHand(s, me, "天斧の深淵"));
    expect(handNames(t, me)).toEqual(["キャラバンマンモス"]);
    expect(t.players[me].hand[0]).toMatchObject({ costMod: -3, revealed: false });
  });

  it("侵略されし世界: 【アクト】選んだ手札のカードは、相手のデッキのランダム 1 枚のコピーに変身する", () => {
    const { s, me, opp } = setup();
    setDeck(s, opp, "ストリートラン", "ストリートラン");
    const w = toBoard(s, me, "侵略されし世界");
    toHand(s, me, "キャラバンマンモス");
    const t = choose(act(s, w.iid));
    expect(handNames(t, me)).toEqual(["ストリートラン"]);
    expect(t.players[opp].deck).toHaveLength(2);
  });

  it("相手の手札（光の理・ル・オー）: 相手の手札のフォロワーすべては +1/+0。【奥義】クレスト", () => {
    let { s, me, opp } = setup();
    toHand(s, opp, "キャラバンマンモス");
    toHand(s, opp, "ストリートラン");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "光の理・ル・オー"));
    expect(t.players[opp].hand.map((h) => h.attackMod)).toEqual([1, 0]);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 6);
    expect(hasCrest(t, me, "光の理・ル・オー")).toBe(false);

    ({ s, me, opp } = setup());
    s.players[me].turnCount = 10;
    t = play(s, toHand(s, me, "光の理・ル・オー"));
    expect(hasCrest(t, me, "光の理・ル・オー")).toBe(true);
  });
});

describe("ハイランダーNm のカード", () => {
  it("誠心なる尽小花: 選んだ場のカードはイマリの小鬼に変身する", () => {
    const { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = choose(play(s, toHand(s, me, "誠心なる尽小花")), foe.iid);
    expect(names(t, opp)).toEqual(["イマリの小鬼"]);
  });

  it("束刃の咎人・カットスロート: 【進化時】【必殺】のネメシス・フォロワーを引き、重複が無ければクレスト。クレストはプレイしたフォロワーを 1 ターンに 1 回進化させる", () => {
    let { s, me } = setup();
    canEvolve(s, me);
    setDeck(s, me, "青錆の下っ端", "束刃の咎人・カットスロート");
    let c = toBoard(s, me, "束刃の咎人・カットスロート");
    let t = evolve(s, c.iid);
    expect(handNames(t, me)).toEqual(["束刃の咎人・カットスロート"]);
    expect(hasCrest(t, me, "束刃の咎人・カットスロート")).toBe(true);
    const a = toHand(t, me, "青錆の下っ端");
    const b = toHand(t, me, "青錆の下っ端");
    t = play(play(t, a), b);
    expect(follower(t, a)?.evolve).toBe("evolved");
    expect(follower(t, b)?.evolve).toBe("none");

    ({ s, me } = setup());
    canEvolve(s, me);
    setDeck(s, me, "束刃の咎人・カットスロート", "キャラバンマンモス", "キャラバンマンモス");
    c = toBoard(s, me, "束刃の咎人・カットスロート");
    t = evolve(s, c.iid);
    expect(hasCrest(t, me, "束刃の咎人・カットスロート")).toBe(false);
  });

  it("報恩の技師・アイザック: 【ラストワード】アタックアーティファクト", () => {
    const { s, me, opp } = setup();
    const i = toBoard(s, me, "報恩の技師・アイザック");
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = attack(s, i.iid, foe.iid);
    expect(handNames(t, me)).toEqual(["アタックアーティファクト"]);
  });

  it("尽小花・イマリ: 選んだ手札を捨ててスペルを引く。進化後ならスペルをプレイしたときイマリの小鬼", () => {
    let { s, me } = setup();
    setDeck(s, me, "キャラバンマンモス", "穢れなき日々");
    toHand(s, me, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "尽小花・イマリ"));
    expect(handNames(t, me)).toEqual(["穢れなき日々"]);

    ({ s, me } = setup());
    toBoard(s, me, "尽小花・イマリ", { evolve: "evolved" });
    t = play(s, toHand(s, me, "穢れなき日々"));
    expect(names(t, me)).toEqual(["尽小花・イマリ", "イマリの小鬼"]);
  });

  it("旧き天斧・ヨグゼンタ: 自分の場に元のコスト5以上のフォロワーがあれば天斧の深淵", () => {
    let { s, me } = setup();
    let t = play(s, toHand(s, me, "旧き天斧・ヨグゼンタ"));
    expect(handNames(t, me)).toEqual([]);
    ({ s, me } = setup());
    toBoard(s, me, "キャラバンマンモス");
    t = play(s, toHand(s, me, "旧き天斧・ヨグゼンタ"));
    expect(handNames(t, me)).toEqual(["天斧の深淵"]);
  });

  it("チルスケーター・ポータルコネクター・ラズリ・ネオジオグラファー: アーティファクトを手札に加える", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    let t = play(s, toHand(s, me, "チルスケーター"));
    t = evolve(t, board(t, me)[0]!.iid);
    expect(handNames(t, me)).toEqual(["エンシェントアーティファクト", "エンシェントアーティファクト"]);
    t.players[me].hand = [];
    t = play(t, toHand(t, me, "ポータルコネクター・ラズリ"));
    t = play(t, toHand(t, me, "ネオジオグラファー"));
    expect(handNames(t, me)).toEqual(["レディアントアーティファクト", "デストロイアーティファクトβ"]);
  });

  it("ネオジオグラファー: 【超進化時】選んだ手札のコスト5以下のアーティファクト・フォロワーのコピーを場に出す", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const n = toBoard(s, me, "ネオジオグラファー");
    toHand(s, me, "デストロイアーティファクトβ");
    toHand(s, me, "キャラバンマンモス");
    const t = choose(superEvolve(s, n.iid));
    expect(names(t, me)).toEqual(["ネオジオグラファー", "デストロイアーティファクトβ"]);
    expect(handNames(t, me)).toEqual(["デストロイアーティファクトβ", "キャラバンマンモス"]);
  });

  it("アナタの先輩・エース: アナライズアーティファクトを手札に。【進化時】他の進化前の自分のフォロワーを進化させる", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const m = toBoard(s, me, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "アナタの先輩・エース"));
    expect(handNames(t, me)).toEqual(["アナライズアーティファクト"]);
    const ace = board(t, me)[1]!;
    t = evolve(t, ace.iid);
    expect(follower(t, m.iid)?.evolve).toBe("evolved");
  });

  it("アナライズアーティファクト: 場に出たとき 1 枚引く", () => {
    const { s, me } = setup();
    const t = play(s, toHand(s, me, "アナライズアーティファクト"));
    expect(handNames(t, me)).toEqual(["キャラバンマンモス"]);
  });

  it("再起の夜王・ショウ・愛すべき相棒・ビィ: 超進化可能ターンなら【バリア】・進化する", () => {
    let { s, me } = setup();
    let t = play(s, toHand(s, me, "再起の夜王・ショウ"));
    t = play(t, toHand(t, me, "愛すべき相棒・ビィ"));
    expect(follower(t, board(t, me)[0]!.iid)?.keywords).not.toContain("barrier");
    expect(follower(t, board(t, me)[1]!.iid)?.evolve).toBe("none");

    ({ s, me } = setup());
    canEvolve(s, me);
    t = play(s, toHand(s, me, "再起の夜王・ショウ"));
    t = play(t, toHand(t, me, "愛すべき相棒・ビィ"));
    expect(follower(t, board(t, me)[0]!.iid)?.keywords).toContain("barrier");
    expect(follower(t, board(t, me)[1]!.iid)?.evolve).toBe("evolved");
  });

  it("ワイルドキャスター: アナライズアーティファクト。【エンハンス_5】ミスティックアーティファクト。出たアーティファクトは【突進】", () => {
    let { s, me } = setup();
    s.players[me].pp = 4;
    let t = play(s, toHand(s, me, "ワイルドキャスター"));
    expect(names(t, me)).toEqual(["ワイルドキャスター", "アナライズアーティファクト"]);
    expect(follower(t, board(t, me)[1]!.iid)?.keywords).toContain("rush");
    expect(handNames(t, me)).toEqual(["キャラバンマンモス"]);

    ({ s, me } = setup());
    t = play(s, toHand(s, me, "ワイルドキャスター"));
    expect(names(t, me)).toEqual(["ワイルドキャスター", "アナライズアーティファクト", "ミスティックアーティファクト"]);
    expect(follower(t, board(t, me)[2]!.iid)?.keywords).toContain("rush");
  });

  it("ハクガ燐斂: 選んだ相手のフォロワーを破壊。重複が無ければすべて", () => {
    let { s, me, opp } = setup();
    let a = toBoard(s, opp, "キャラバンマンモス");
    toBoard(s, opp, "青錆の下っ端");
    let t = choose(play(s, toHand(s, me, "ハクガ燐斂")), a.iid);
    expect(names(t, opp)).toEqual(["青錆の下っ端"]);

    ({ s, me, opp } = setup());
    setDeck(s, me);
    a = toBoard(s, opp, "キャラバンマンモス");
    toBoard(s, opp, "青錆の下っ端");
    t = choose(play(s, toHand(s, me, "ハクガ燐斂")), a.iid);
    expect(names(t, opp)).toEqual([]);
  });

  it("奮励の追走・ミュー: アーティファクトが出たら相手のフォロワーに 3 ダメージ。【進化時】エンシェント。【超進化時】3 種類以上なら【疾走】", () => {
    let { s, me, opp } = setup();
    canEvolve(s, me);
    let mu = toBoard(s, me, "奮励の追走・ミュー");
    let foe = toBoard(s, opp, "キャラバンマンモス");
    let t = evolve(s, mu.iid);
    expect(names(t, me)).toEqual(["奮励の追走・ミュー", "エンシェントアーティファクト"]);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
    expect(follower(t, mu.iid)?.keywords).not.toContain("storm");

    ({ s, me, opp } = setup());
    canEvolve(s, me);
    s.players[me].enteredKinds = [id("アナライズアーティファクト"), id("ミスティックアーティファクト")];
    mu = toBoard(s, me, "奮励の追走・ミュー");
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = superEvolve(s, mu.iid);
    expect(names(t, me)).toEqual(["奮励の追走・ミュー", "エンシェントアーティファクト"]);
    expect(follower(t, mu.iid)?.keywords).toContain("storm");
  });

  it("ツインドローンガール・エッジーマスター: アーティファクトを出す。エッジーマスターはアーティファクトが出たら 1 回復", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    s.players[me].leaderHp = 10;
    toBoard(s, me, "エッジーマスター");
    let t = play(s, toHand(s, me, "ツインドローンガール"));
    t = evolve(t, board(t, me)[1]!.iid);
    expect(names(t, me)).toEqual(["エッジーマスター", "ツインドローンガール", "アナライズアーティファクト", "アナライズアーティファクト"]);
    expect(t.players[me].leaderHp).toBe(12);
    // 次の自分のターンにエッジーマスターを進化
    t = endTurn(endTurn(t));
    t = evolve(t, board(t, me)[0]!.iid);
    expect(names(t, me)[4]).toBe("ミスティックアーティファクト");
    expect(t.players[me].leaderHp).toBe(13);
  });

  it("錬磨の用心棒・鋳鉄の腹心: 重複が無ければ 4 ダメージと 4 回復・【疾走】", () => {
    let { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    let foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "錬磨の用心棒"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH);
    t = play(t, toHand(t, me, "鋳鉄の腹心"));
    expect(names(t, opp)).toEqual([]);
    expect(follower(t, board(t, me)[1]!.iid)?.keywords).not.toContain("storm");

    ({ s, me, opp } = setup());
    setDeck(s, me);
    s.players[me].leaderHp = 10;
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = play(s, toHand(s, me, "錬磨の用心棒"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 4);
    expect(t.players[me].leaderHp).toBe(14);
    t = play(t, toHand(t, me, "鋳鉄の腹心"));
    expect(follower(t, board(t, me)[1]!.iid)?.keywords).toContain("storm");
  });

  it("決断の交差・アシュレイ＆リディア: 選んだ相手のフォロワーは【守護】。【エンハンス_9】進化して【疾走】、進化したので【守護】を持つ相手のフォロワーを破壊", () => {
    let { s, me, opp } = setup();
    s.players[me].pp = 5;
    let a = toBoard(s, opp, "キャラバンマンモス");
    let b = toBoard(s, opp, "キャラバンマンモス");
    let t = choose(play(s, toHand(s, me, "決断の交差・アシュレイ＆リディア")), a.iid);
    expect(follower(t, a.iid)?.keywords).toContain("ward");
    expect(names(t, opp)).toHaveLength(2);

    ({ s, me, opp } = setup());
    a = toBoard(s, opp, "キャラバンマンモス");
    b = toBoard(s, opp, "キャラバンマンモス");
    t = choose(play(s, toHand(s, me, "決断の交差・アシュレイ＆リディア")), a.iid);
    expect(board(t, opp).map((c) => c.iid)).toEqual([b.iid]);
    const ar = follower(t, board(t, me)[0]!.iid)!;
    expect(ar.evolve).toBe("evolved");
    expect(ar.keywords).toContain("storm");
  });

  it("ケイオス・レギオン: 相手のフォロワーすべてと相手のリーダーに 3 ダメージ。【解放奥義】6 ダメージ", () => {
    let { s, me, opp } = setup();
    let foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "ケイオス・レギオン"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 3);
    expect(t.players[opp].leaderHp).toBe(17);

    ({ s, me, opp } = setup());
    s.players[me].turnCount = 10;
    foe = toBoard(s, opp, "キャラバンマンモス");
    t = play(s, toHand(s, me, "ケイオス・レギオン", { ougi: 5 }));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 6);
    expect(t.players[opp].leaderHp).toBe(14);
  });

  it("劣悪の純心・カミシラ: 低劣の玩具と拙劣の人形を出し、どちらも進化する。【超進化時】元のコスト5以上の自分のフォロワーの数だけ相手に", () => {
    let { s, me, opp } = setup();
    let t = play(s, toHand(s, me, "劣悪の純心・カミシラ"));
    expect(names(t, me)).toEqual(["劣悪の純心・カミシラ", "低劣の玩具", "拙劣の人形"]);
    expect(board(t, me).map((c) => follower(t, c.iid)?.evolve)).toEqual(["none", "evolved", "evolved"]);
    expect(handNames(t, me)).toEqual([]);

    ({ s, me, opp } = setup());
    canEvolve(s, me);
    const k = toBoard(s, me, "劣悪の純心・カミシラ");
    toBoard(s, me, "キャラバンマンモス");
    toBoard(s, me, "青錆の下っ端");
    t = superEvolve(s, k.iid);
    expect(t.players[opp].leaderHp).toBe(18);
  });

  it("低劣の玩具・拙劣の人形: 3 枚引く。拙劣の人形を出して、それとこれは進化する", () => {
    const { s, me } = setup();
    let t = play(s, toHand(s, me, "低劣の玩具"));
    expect(handNames(t, me)).toHaveLength(3);
    t.players[me].pp = 10;
    t = play(t, toHand(t, me, "拙劣の人形"));
    expect(names(t, me)).toEqual(["低劣の玩具", "拙劣の人形", "拙劣の人形"]);
    expect(follower(t, board(t, me)[1]!.iid)?.evolve).toBe("evolved");
    expect(follower(t, board(t, me)[2]!.iid)?.evolve).toBe("evolved");
  });

  it("弾哭の変貌・アイズエデン: 撃針の看守を出し、アーティファクトが出たのでランダムな相手のフォロワーを破壊。看守の【ラストワード】は 2 回復", () => {
    const { s, me, opp } = setup();
    s.players[me].leaderHp = 10;
    toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "弾哭の変貌・アイズエデン"));
    expect(names(t, me)).toEqual(["弾哭の変貌・アイズエデン", "撃針の看守"]);
    expect(names(t, opp)).toEqual([]);
    const guard = board(t, me)[1]!;
    const foe = toBoard(t, opp, "キャラバンマンモス");
    t.players[me].board[1] = { ...follower(t, guard.iid)!, enteredTurn: 0 };
    t = attack(t, guard.iid, foe.iid);
    expect(t.players[me].leaderHp).toBe(12);
  });

  it("虚刻のアナテマ・スカーレット: 場に出たアーティファクト・フォロワーの種類だけ相手のフォロワーすべてにダメージ", () => {
    const { s, me, opp } = setup();
    s.players[me].enteredKinds = [id("アナライズアーティファクト"), id("撃針の看守"), id("キャラバンマンモス")];
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "虚刻のアナテマ・スカーレット"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 2);
  });

  it("ステージメーカー: 改良型・操り人形と操り人形。【エンハンス_7】どちらも【疾走】（暫定）", () => {
    let { s, me } = setup();
    s.players[me].pp = 6;
    let t = play(s, toHand(s, me, "ステージメーカー"));
    expect(names(t, me)).toEqual(["ステージメーカー", "改良型・操り人形", "操り人形"]);
    expect(follower(t, board(t, me)[1]!.iid)?.keywords).not.toContain("storm");

    ({ s, me } = setup());
    t = play(s, toHand(s, me, "ステージメーカー"));
    expect(follower(t, board(t, me)[1]!.iid)?.keywords).toContain("storm");
    expect(follower(t, board(t, me)[2]!.iid)?.keywords).toContain("storm");
  });

  it("光の理・ル・オー・ストーン・ブレイク: ランダムな相手のフォロワーに 1 ダメージを 6 回", () => {
    const { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "ストーン・ブレイク"));
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 6);
  });

  it("空駆ける庇護者・カタリナ: 【奥義】ランダムな相手のフォロワー 2 枚に 5 ダメージ", () => {
    const { s, me, opp } = setup();
    s.players[me].turnCount = 10;
    const a = toBoard(s, opp, "キャラバンマンモス");
    const b = toBoard(s, opp, "キャラバンマンモス");
    const t = play(s, toHand(s, me, "空駆ける庇護者・カタリナ"));
    expect([follower(t, a.iid)?.defense, follower(t, b.iid)?.defense]).toEqual([MAMMOTH - 5, MAMMOTH - 5]);
  });

  it("天司長の後継・サンダルフォン: 【解放奥義】ランダムな相手のフォロワーか相手のリーダーに 2 ダメージを 5 回。クレストはターン終了時に 1 回復", () => {
    const { s, me, opp } = setup();
    s.players[me].turnCount = 10;
    let t = play(s, toHand(s, me, "天司長の後継・サンダルフォン", { ougi: 5 }));
    expect(t.players[opp].leaderHp).toBe(10);

    addCrest(t, me, "天司長の後継・サンダルフォン", 2);
    t.players[me].leaderHp = 10;
    const m = toBoard(t, me, "キャラバンマンモス", { defense: 5 });
    t = endTurn(t);
    expect(t.players[me].leaderHp).toBe(11);
    expect(follower(t, m.iid)?.defense).toBe(6);
  });

  it("ブライトクリエイター: デストロイアーティファクトαを出し、それは【必殺】と【守護】", () => {
    const { s, me } = setup();
    const t = play(s, toHand(s, me, "ブライトクリエイター"));
    expect(names(t, me)).toEqual(["ブライトクリエイター", "デストロイアーティファクトα"]);
    expect(follower(t, board(t, me)[1]!.iid)?.keywords).toEqual(expect.arrayContaining(["bane", "ward"]));
  });

  it("エクセシブガーディアン・リオナ: 【超進化時】選んだ他の自分のフォロワーは【潜伏】", () => {
    const { s, me } = setup();
    canEvolve(s, me);
    const r = toBoard(s, me, "エクセシブガーディアン・リオナ");
    const m = toBoard(s, me, "キャラバンマンモス");
    const t = choose(superEvolve(s, r.iid), m.iid);
    expect(follower(t, m.iid)?.keywords).toContain("ambush");
  });

  it("穢れなき日々: 2 枚引く。超進化可能ターンなら 2 回復", () => {
    let { s, me } = setup();
    s.players[me].leaderHp = 10;
    let t = play(s, toHand(s, me, "穢れなき日々"));
    expect(handNames(t, me)).toHaveLength(2);
    expect(t.players[me].leaderHp).toBe(10);
    ({ s, me } = setup());
    canEvolve(s, me);
    s.players[me].leaderHp = 10;
    t = play(s, toHand(s, me, "穢れなき日々"));
    expect(t.players[me].leaderHp).toBe(12);
  });

  it("愚劣の兵器: 愚劣の兵器 2 枚を出す。ターン終了時・【進化時】に 3 ダメージを割りふる。アクセラレートでは 1 枚出す", () => {
    let { s, me, opp } = setup();
    const foe = toBoard(s, opp, "キャラバンマンモス");
    let t = play(s, toHand(s, me, "愚劣の兵器"));
    expect(names(t, me)).toEqual(["愚劣の兵器", "愚劣の兵器", "愚劣の兵器"]);
    t = endTurn(t);
    expect(follower(t, foe.iid)?.defense).toBe(MAMMOTH - 9);

    ({ s, me, opp } = setup());
    s.players[me].pp = 5;
    t = play(s, toHand(s, me, "愚劣の兵器"));
    expect(names(t, me)).toEqual(["愚劣の兵器"]);
    expect(t.players[me].pp).toBe(1);
  });
});
