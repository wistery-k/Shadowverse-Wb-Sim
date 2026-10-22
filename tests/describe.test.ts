import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { applyAction, createGame, newHandCard, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { describeAction } from "../src/ui/describe";

const id = (name: string): string => {
  const card = ALL_CARDS.find((c) => c.name === name);
  if (!card) throw new Error(`カードがありません: ${name}`);
  return card.id;
};

/** 先攻がグリードケルブ・ルビィをプレイし、手札のどれを山札に戻すか選んでいる局面 */
function choosingFromHand(): { s: GameState; me: PlayerIndex; picked: number } {
  const filler = id("キャラバンマンモス");
  let s = createGame({ decks: [Array(40).fill(filler), Array(40).fill(filler)], seed: 1 });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
  const me = s.active;
  s.players[me].pp = s.players[me].maxPp = 10;
  const ruby = newHandCard(s, id("グリードケルブ・ルビィ"));
  s.players[me].hand.push(ruby);
  s = applyAction(s, { type: "play", iid: ruby.iid });
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
