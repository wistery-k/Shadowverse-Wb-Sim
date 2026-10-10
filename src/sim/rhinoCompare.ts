// npm run rhino-compare の試合の決め方（スクリプトと web の「リノセウス比較」で共通に使う）
//
// リノセウスエルフ vs 他の 6 デッキ（ランプドラゴンは除く）を、試合番号 g と、リノセウスエルフの席（0/1）ごとに
// 決まったシードで打つ。同じ（相手デッキ・g・席）なら、AI でも人間でも同じ初期局面（先攻・山札の順番・初手）から始まる。

import { DEFAULT_DECKS, type DefaultDeck } from "../cards/defaultDecks";
import type { PlayerIndex } from "../engine";

export const RHINO_ELF = "リノセウスエルフ";
const EXCLUDED_DECKS = [RHINO_ELF, "ランプドラゴン"];
/** 相手の AI（src/ai/registry.ts のキー） */
export const RHINO_OPPONENT_AGENT = "search";

export function rhinoElfDeck(): DefaultDeck {
  const elf = DEFAULT_DECKS.find((d) => d.name === RHINO_ELF);
  if (!elf) throw new Error(`${RHINO_ELF} がありません`);
  return elf;
}

export function rhinoOpponents(): DefaultDeck[] {
  return DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
}

export const rhinoSeed = (g: number, elfSeat: PlayerIndex) => 900000 + g * 13 + elfSeat;

/** 1 試合の設定。opponent は相手デッキの名前 */
export function rhinoMatch(opponent: string, g: number, elfSeat: PlayerIndex): { decks: [string[], string[]]; seed: number } {
  const elf = rhinoElfDeck();
  const opp = rhinoOpponents().find((d) => d.name === opponent);
  if (!opp) throw new Error(`相手デッキがありません: ${opponent}`);
  return { decks: elfSeat === 0 ? [elf.cards, opp.cards] : [opp.cards, elf.cards], seed: rhinoSeed(g, elfSeat) };
}
