// 問題集のページの「デッキと残りの山札」（src/ui/Misses.tsx。ユーザーの依頼 2026-11-19。docs/misses.md「問題集のページ」）。
// 残りのカードは盤面の局面の山札から数える。デッキ（元の 40 枚）は手順の候補のファイルの decks（scripts/misses-lines-main.ts の --decks）

import { cardOf, type GameState, type PlayerIndex } from "../engine";
import type { MissDeck } from "./problems";

/** 山札の残りの 1 行（カードごと） */
export interface DeckRow {
  cardId: string;
  /** 盤面の局面の山札に残る枚数 */
  left: number;
  /** デッキの元の枚数（デッキが分からなければ null、デッキに無いカードは 0） */
  total: number | null;
}

/**
 * 席 q の山札に残るカードを、デッキの元のカードと並べる（コストの順、同じコストは名前の順。山札の並び＝引く順番は見せない）。
 * デッキの外から山札に入ったカード（能力で足されたもの）も出す
 */
export function deckRows(state: GameState, q: PlayerIndex, deck: MissDeck | null): DeckRow[] {
  const left = new Map<string, number>();
  for (const c of state.players[q].deck) left.set(c.cardId, (left.get(c.cardId) ?? 0) + 1);
  const total = new Map<string, number>();
  for (const id of deck?.cards ?? []) total.set(id, (total.get(id) ?? 0) + 1);
  const ids = new Set([...total.keys(), ...left.keys()]);
  return [...ids]
    .map((cardId) => ({ cardId, left: left.get(cardId) ?? 0, total: deck ? (total.get(cardId) ?? 0) : null }))
    .sort((a, b) => {
      const x = cardOf(a.cardId);
      const y = cardOf(b.cardId);
      return x.cost - y.cost || x.name.localeCompare(y.name, "ja");
    });
}
