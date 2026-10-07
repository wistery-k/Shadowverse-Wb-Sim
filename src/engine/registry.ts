// カード・クレストの能力定義の参照

import { CREST_ABILITIES, CARD_ABILITIES } from "../cards/abilities";
import { CARDS_BY_ID, CRESTS_BY_ID, type Card, type Crest } from "../cards";
import type { Ability, CardAbilities } from "./dsl";
import { parseStaticAbilities } from "./keywords";
import type { StaticKeyword } from "./types";

const EMPTY: CardAbilities = { abilities: [] };

export function cardOf(cardId: string): Card {
  const card = CARDS_BY_ID.get(cardId);
  if (!card) throw new Error(`未知のカードID: ${cardId}`);
  return card;
}

export function crestOf(crestId: string): Crest {
  const crest = CRESTS_BY_ID.get(crestId);
  if (!crest) throw new Error(`未知のクレストID: ${crestId}`);
  return crest;
}

export function abilitiesOf(cardId: string): CardAbilities {
  return CARD_ABILITIES[cardId] ?? EMPTY;
}

export function crestAbilitiesOf(crestId: string): Ability[] {
  return CREST_ABILITIES[crestId]?.abilities ?? [];
}

export interface StaticInfo {
  keywords: StaticKeyword[];
  maxAttacks: number;
  earthSigil: boolean;
}

const staticCache = new Map<string, StaticInfo>();

/** カードの常在型キーワード等（キャッシュ付き） */
export function staticOf(cardId: string): StaticInfo {
  let info = staticCache.get(cardId);
  if (!info) {
    const text = cardOf(cardId).text;
    info = { ...parseStaticAbilities(text), earthSigil: text.split("\n").includes("【土の印】") };
    staticCache.set(cardId, info);
  }
  return info;
}
