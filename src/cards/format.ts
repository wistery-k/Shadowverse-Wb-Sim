// フォーマットとデッキ構築ルール。数値の出典・確認状況は docs/rules.md を参照。

import type { Card, CardSet, ClassId } from "./types";

export const DECK_SIZE = 40;
export const MAX_COPIES = 3;

export interface Format {
  id: string;
  name: string;
  /** デッキに入れられるセット */
  sets: readonly CardSet[];
}

/** スターター: 第1弾とベーシックのみ。能力調整されたカードは当時の能力で扱う（cards.json 側で表現）。 */
export const STARTER: Format = {
  id: "starter",
  name: "スターター",
  sets: ["basic", "legend_dawn"],
};

/** デッキ構築ルールに違反していれば理由の一覧を返す。空なら合法。 */
export function deckProblems(
  format: Format,
  deckClass: ClassId,
  cards: readonly Card[],
): string[] {
  const problems: string[] = [];
  if (deckClass === "neutral") problems.push("ニュートラルはデッキのクラスに指定できません");
  if (cards.length !== DECK_SIZE) {
    problems.push(`デッキは${DECK_SIZE}枚である必要があります（現在${cards.length}枚）`);
  }

  const copies = new Map<string, number>();
  for (const card of cards) {
    if (!format.sets.includes(card.set)) {
      problems.push(`${card.name} は${format.name}で使用できません`);
    }
    if (card.class !== "neutral" && card.class !== deckClass) {
      problems.push(`${card.name} はデッキのクラスと異なります`);
    }
    copies.set(card.name, (copies.get(card.name) ?? 0) + 1);
  }
  for (const [name, n] of copies) {
    if (n > MAX_COPIES) problems.push(`${name} は${MAX_COPIES}枚までです（${n}枚）`);
  }
  // 同じカードの重複指摘をまとめる
  return [...new Set(problems)];
}
