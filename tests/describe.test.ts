import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { abilitiesOf, applyAction, createGame, newHandCard, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { describeAction, modeLabels, modeSourceCard } from "../src/ui/describe";

const id = (name: string): string => {
  const card = ALL_CARDS.find((c) => c.name === name);
  if (!card) throw new Error(`カードがありません: ${name}`);
  return card.id;
};

/** マリガン後、先攻のターン中の状態。PP は 10、手札は空 */
function setup(): { s: GameState; me: PlayerIndex } {
  const filler = id("キャラバンマンモス");
  let s = createGame({ decks: [Array(40).fill(filler), Array(40).fill(filler)], seed: 1 });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
  const me = s.active;
  s.players[me].hand = [];
  s.players[me].pp = s.players[me].maxPp = 10;
  return { s, me };
}

/** 先攻がグリードケルブ・ルビィをプレイし、手札のどれを山札に戻すか選んでいる局面 */
function choosingFromHand(): { s: GameState; me: PlayerIndex; picked: number } {
  const { s: start, me } = setup();
  // 候補が 1 枚だけだと選ばずに決まるので 2 枚置く
  for (let i = 0; i < 2; i++) start.players[me].hand.push(newHandCard(start, id("キャラバンマンモス")));
  const ruby = newHandCard(start, id("グリードケルブ・ルビィ"));
  start.players[me].hand.push(ruby);
  const s = applyAction(start, { type: "play", iid: ruby.iid });
  if (s.pending?.kind !== "choose") throw new Error("選択待ちになっていない");
  return { s, me, picked: s.pending.candidates[0]! };
}

describe("行動の説明（describeAction）", () => {
  it("相手が手札から選んだカード（捨てる・山札に戻す）は、人間の視点では名前を書かない", () => {
    const { s, me, picked } = choosingFromHand();
    const action: Action = { type: "choose", targets: [picked] };
    expect(describeAction(s, action, (1 - me) as PlayerIndex)).toBe("相手: 手札1枚を選択");
    expect(describeAction(s, action, me)).toBe("あなた: キャラバンマンモスを選択");
    // 両者の名前で書く（観戦・リプレイ）ときは書く
    const names = me === 0 ? (["先攻", "後攻"] as const) : (["後攻", "先攻"] as const);
    expect(describeAction(s, action, names)).toBe(`${names[me]}: キャラバンマンモスを選択`);
  });
});

/** 能力に【モード】を持つカード */
const MODE_CARDS = ALL_CARDS.filter((c) => JSON.stringify(abilitiesOf(c.id)).includes('"op":"mode"'));

describe("モードの選択肢の文言", () => {
  it("【モード】を持つカードがある", () => {
    expect(MODE_CARDS.map((c) => c.name)).toEqual(expect.arrayContaining(["王断の威光", "閃光の魔法剣士"]));
  });

  it.each(MODE_CARDS.map((c) => [c.name, c] as const))("%s: プレイするとモードの選択肢に能力テキストの行が出る", (_, card) => {
    const { s, me } = setup();
    const h = newHandCard(s, card.id);
    s.players[me].hand.push(h);
    const t = applyAction(s, { type: "play", iid: h.iid });
    expect(t.pending?.kind).toBe("mode");
    expect(modeSourceCard(t)).toBe(card.id);
    const lines = card.text.split("\n").filter((l) => /^（\d）/.test(l));
    expect(modeLabels(t)).toEqual(lines);
  });

  it("行動の説明にカード名と選んだモードが出る", () => {
    const { s, me } = setup();
    const h = newHandCard(s, id("王断の威光"));
    s.players[me].hand.push(h);
    const t = applyAction(s, { type: "play", iid: h.iid });
    expect(describeAction(t, { type: "mode", index: 1 }, me)).toBe(
      "あなた: 王断の威光のモード「（2）自分の場のフォロワーすべては+1/+1する。」を選択",
    );
  });
});
