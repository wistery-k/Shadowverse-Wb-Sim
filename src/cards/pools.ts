// カードプールと、エンジンのカードの表（スターターと前期のローテーションの両方）。
// エンジン（Rust）のカードの表は、スターターのカード・クレストを今の順のまま先頭に置き、前期のローテーションにしか無いものを後ろに足す。
// こうすると、スターターのカードの表の番号（ゴールデン・物差し・今のモデルの語彙が依る）は変わらない（docs/pools/azvaldt.md「段取り」3）。
// 同じ ID のカード（ベーシックとトークン 81 件）は能力・コスト・能力値が同じ（tests/cards.test.ts）なので、スターターのものを共有する。
//
// アプリの画面は今はスターターだけを使うので、src/cards/index.ts からは出さない（前期のローテーションのデータを画面の束に入れないため）。

import rawRotCards from "../../data/pools/azvaldt/cards.json";
import rawRotCrests from "../../data/pools/azvaldt/crests.json";
import rawRotSpecials from "../../data/pools/azvaldt/specials.json";
import { ALL_CARDS, ALL_CRESTS, CARDS_BY_ID, CRESTS_BY_ID } from "./index";
import type { Card, Crest, SpecialEffect } from "./types";
import { validateCards, validateCrests, validateSpecials } from "./validate";

export const POOL_IDS = ["starter", "azvaldt"] as const;
export type PoolId = (typeof POOL_IDS)[number];

/** 前期のローテーション（data/pools/azvaldt/）の全カード（トークン含む） */
export const AZVALDT_CARDS: readonly Card[] = validateCards(rawRotCards);
export const AZVALDT_CRESTS: readonly Crest[] = validateCrests(rawRotCrests, AZVALDT_CARDS);
export const AZVALDT_SPECIALS: readonly SpecialEffect[] = validateSpecials(rawRotSpecials, AZVALDT_CARDS);

const AZVALDT_CARD_IDS = new Set(AZVALDT_CARDS.map((c) => c.id));
const AZVALDT_CREST_IDS = new Set(AZVALDT_CRESTS.map((c) => c.id));

/** エンジンのカードの表: スターターの全カード（今の順）→ 前期のローテーションにしか無いカード */
export const ENGINE_CARDS: readonly Card[] = [...ALL_CARDS, ...AZVALDT_CARDS.filter((c) => !CARDS_BY_ID.has(c.id))];
/** エンジンのクレストの表: スターターの全クレスト（今の順）→ 前期のローテーションにしか無いクレスト */
export const ENGINE_CRESTS: readonly Crest[] = [
  ...ALL_CRESTS,
  ...AZVALDT_CRESTS.filter((c) => !CRESTS_BY_ID.has(c.id)),
];

/** カードが入っているプール（トークンも、そのプールのデータにあれば入る） */
export function poolsOfCard(cardId: string): PoolId[] {
  const pools: PoolId[] = [];
  if (CARDS_BY_ID.has(cardId)) pools.push("starter");
  if (AZVALDT_CARD_IDS.has(cardId)) pools.push("azvaldt");
  return pools;
}

/** クレストが入っているプール */
export function poolsOfCrest(crestId: string): PoolId[] {
  const pools: PoolId[] = [];
  if (CRESTS_BY_ID.has(crestId)) pools.push("starter");
  if (AZVALDT_CREST_IDS.has(crestId)) pools.push("azvaldt");
  return pools;
}
