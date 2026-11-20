// カード・クレストの能力定義の参照

import { CARD_ABILITIES } from "../cards/abilities";
import { ALL_CARDS, CARDS_BY_ID, CRESTS_BY_ID, type Card, type Crest } from "../cards";
import type { CardAbilities } from "./dsl";
import { parseStaticAbilities } from "./keywords";
import type { StaticKeyword } from "./types";

const EMPTY: CardAbilities = { abilities: [] };

// 画面のカードの表は、ふだんはスターターのカードだけ（src/cards/index.ts）。
// 開発サーバーだけの「試合の記録」の画面（src/ui/MatchRecord.tsx）が、前期のローテーションのカードを registerPoolCards で足す。
// 公開サイトでは足さない（その画面のモジュールは vite build で空のものに置き換わるので、前期のローテーションのデータも束に入らない）。
// スターターと同じ ID のカード（ベーシック・トークン）は、エンジンと同じくスターターのものを使う。
const poolCards = new Map<string, Card>();
const poolCrests = new Map<string, Crest>();
const poolAbilities = new Map<string, CardAbilities>();
let tableVersion = 0;

/** 画面のカードの表に、プールのカード・クレスト・能力の定義を足す（スターターにある ID は足さない） */
export function registerPoolCards(cards: readonly Card[], crests: readonly Crest[], abilities: Readonly<Record<string, CardAbilities>>): void {
  for (const c of cards) if (!CARDS_BY_ID.has(c.id)) poolCards.set(c.id, c);
  for (const c of crests) if (!CRESTS_BY_ID.has(c.id)) poolCrests.set(c.id, c);
  for (const [id, a] of Object.entries(abilities)) if (!ABILITIES_BY_ID.has(id)) poolAbilities.set(id, a);
  tableVersion++;
}

/** 画面のカードの表の版（registerPoolCards で足すたびに変わる。表全体から作った値を作り直すのに使う） */
export const cardTableVersion = (): number => tableVersion;

/** 画面のカードの表の全カード（スターター → 足したプールのカード） */
export function knownCards(): readonly Card[] {
  return poolCards.size === 0 ? ALL_CARDS : [...ALL_CARDS, ...poolCards.values()];
}

export function cardOf(cardId: string): Card {
  const card = CARDS_BY_ID.get(cardId) ?? poolCards.get(cardId);
  if (!card) throw new Error(`未知のカードID: ${cardId}`);
  return card;
}

export function crestOf(crestId: string): Crest {
  const crest = CRESTS_BY_ID.get(crestId) ?? poolCrests.get(crestId);
  if (!crest) throw new Error(`未知のクレストID: ${crestId}`);
  return crest;
}

// カードIDは数字だけの文字列で、オブジェクトのキーにすると配列の添字として扱われて引くのが遅いので Map にする
const ABILITIES_BY_ID = new Map(Object.entries(CARD_ABILITIES));

export function abilitiesOf(cardId: string): CardAbilities {
  return ABILITIES_BY_ID.get(cardId) ?? poolAbilities.get(cardId) ?? EMPTY;
}

export interface StaticInfo {
  keywords: StaticKeyword[];
  maxAttacks: number;
  earthSigil: boolean;
}

const staticCache = new Map<string, StaticInfo>();

/** 能力テキストから読む常在型キーワード等 */
export function staticInfoOf(text: string): StaticInfo {
  return { ...parseStaticAbilities(text), earthSigil: text.split("\n").includes("【土の印】") };
}

/** カードの常在型キーワード等（キャッシュ付き） */
export function staticOf(cardId: string): StaticInfo {
  let info = staticCache.get(cardId);
  if (!info) {
    info = staticInfoOf(cardOf(cardId).text);
    staticCache.set(cardId, info);
  }
  return info;
}
