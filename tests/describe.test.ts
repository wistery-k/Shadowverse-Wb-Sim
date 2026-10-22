import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { abilitiesOf, applyAction, createGame, newHandCard, type GameState, type PlayerIndex } from "../src/engine";
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
