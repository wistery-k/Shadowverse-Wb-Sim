// 手の短い説明（rust/engine/src/runner/human_plan.rs の step_text と同じ文字列）。
// 打ち比べ調査（docs/survey.md）の候補の並び（full）は、この形の文字列だけで手を持たないので、
// 問の局面で打てる手と文字列を突き合わせて手に戻すのに使う（scripts/misses-lines-main.ts）

import { actingPlayer, cardOf } from "../engine/game";
import type { Action, GameState, PlayerIndex } from "../engine/types";

/** カードの名前（リーダーは「自分のリーダー」「相手のリーダー」。手札・場に無ければ #iid） */
export function nameOf(s: GameState, iid: number, viewer: PlayerIndex): string {
  if (iid < 0) return -iid - 1 === viewer ? "自分のリーダー" : "相手のリーダー";
  for (const pl of s.players) {
    const h = pl.hand.find((x) => x.iid === iid);
    if (h) return cardOf(h.cardId).name;
    const b = pl.board.find((x) => x.iid === iid);
    if (b) return cardOf(b.cardId).name;
  }
  return `#${iid}`;
}

const names = (s: GameState, ids: readonly number[], viewer: PlayerIndex) => ids.map((i) => nameOf(s, i, viewer)).join("・");

/** 手の短い説明（局面 s で打つ前に作る） */
export function stepText(s: GameState, a: Action, viewer: PlayerIndex): string {
  const who = actingPlayer(s) === viewer ? "" : "相手: ";
  const body = (() => {
    switch (a.type) {
      case "mulligan": {
        const hand = s.players[a.player].hand;
        const pick = (keep: boolean) => {
          const v = hand.filter((h) => a.swap.includes(h.iid) !== keep).map((h) => cardOf(h.cardId).name);
          return v.length === 0 ? "なし" : v.join("、");
        };
        return `残す: ${pick(true)} / 返す: ${pick(false)}`;
      }
      case "play":
        return `${nameOf(s, a.iid, viewer)}をプレイ`;
      case "evolve":
        return `${nameOf(s, a.iid, viewer)}を進化`;
      case "superEvolve":
        return `${nameOf(s, a.iid, viewer)}を超進化`;
      case "act":
        return `${nameOf(s, a.iid, viewer)}の能力を使う`;
      case "attack":
        return `${nameOf(s, a.attacker, viewer)}で${a.target === "leader" ? "リーダー" : nameOf(s, a.target, viewer)}を攻撃`;
      case "fuse":
        return `${nameOf(s, a.host, viewer)}に${names(s, a.materials, viewer)}を融合`;
      case "choose":
        return `選ぶ: ${names(s, a.targets, viewer)}`;
      case "mode":
        return `${a.index + 1} 番目の効果を選ぶ`;
      case "extraPp":
        return "エクストラPP";
      case "endTurn":
        return "ターン終了";
    }
  })();
  return `${who}${body}`;
}
