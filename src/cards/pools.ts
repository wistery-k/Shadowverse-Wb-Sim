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

const AZVALDT_BY_ID = new Map(AZVALDT_CARDS.map((c) => [c.id, c]));
const sourceOf = (sp: SpecialEffect): Card => {
  const c = AZVALDT_BY_ID.get(sp.sources[0] ?? "");
  if (!c) throw new Error(`特殊効果 ${sp.id} の元のカードがありません`);
  return c;
};

/**
 * アクセラレート・結晶でプレイしたときの姿（エンジンでは別のカードとして持つ。docs/rules.md「12」）。
 * アクセラレートはスペル、結晶はアミュレット「結晶：<元の名前>」（元のカードと同名ではない）。デッキには入れられない（token）
 */
export const SPECIAL_CARDS: readonly Card[] = AZVALDT_SPECIALS.filter((sp) => sp.kind !== "faith").map((sp): Card => {
  const src = sourceOf(sp);
  const base = { id: sp.id, class: src.class, set: "token" as const, rarity: src.rarity, cost: sp.cost, tribes: [], text: sp.text, related: [] };
  return sp.kind === "accelerate"
    ? { ...base, name: `${src.name}（アクセラレート）`, type: "spell" }
    : { ...base, name: `結晶：${src.name}`, type: "amulet", ...(sp.countdown !== undefined ? { countdown: sp.countdown } : {}) };
});
/**
 * 信仰。ルールではクレストではない（docs/rules.md 12章）が、エンジンではリーダーエリアの表の一種として持ち、信仰値（`faith`）を数える。
 * クレストを消す効果（`banishCrests`。アルビオンバハムート）は、信仰値を持つものを消さない
 */
export const FAITH_CRESTS: readonly Crest[] = AZVALDT_SPECIALS.filter((sp) => sp.kind === "faith").map((sp) => ({
  id: sp.id,
  name: `信仰：${sourceOf(sp).name}`,
  source: sourceOf(sp).id,
  text: sp.text,
}));
const SPECIAL_IDS = new Set(AZVALDT_SPECIALS.map((sp) => sp.id));
/** 信仰の ID */
export const FAITH_CREST_IDS: ReadonlySet<string> = new Set(FAITH_CRESTS.map((c) => c.id));

/** エンジンのカードの表: スターターの全カード（今の順）→ 前期のローテーションにしか無いカード → アクセラレート・結晶の姿 */
export const ENGINE_CARDS: readonly Card[] = [
  ...ALL_CARDS,
  ...AZVALDT_CARDS.filter((c) => !CARDS_BY_ID.has(c.id)),
  ...SPECIAL_CARDS,
];
/** エンジンのクレストの表: スターターの全クレスト（今の順）→ 前期のローテーションにしか無いクレスト → 信仰 */
export const ENGINE_CRESTS: readonly Crest[] = [
  ...ALL_CRESTS,
  ...AZVALDT_CRESTS.filter((c) => !CRESTS_BY_ID.has(c.id)),
  ...FAITH_CRESTS,
];

/** アクセラレート・結晶の姿を持つカードの ID → その姿の ID（1 枚に 1 つまで） */
export const ALT_PLAY_OF: ReadonlyMap<string, string> = new Map(
  AZVALDT_SPECIALS.filter((sp) => sp.kind !== "faith").flatMap((sp) => sp.sources.map((src) => [src, sp.id] as const)),
);
/** 信仰を持つカードの ID → 信仰の ID */
export const FAITH_OF: ReadonlyMap<string, string> = new Map(
  AZVALDT_SPECIALS.filter((sp) => sp.kind === "faith").flatMap((sp) => sp.sources.map((src) => [src, sp.id] as const)),
);

/** カードが入っているプール（トークンも、そのプールのデータにあれば入る） */
export function poolsOfCard(cardId: string): PoolId[] {
  const pools: PoolId[] = [];
  if (CARDS_BY_ID.has(cardId)) pools.push("starter");
  if (AZVALDT_CARD_IDS.has(cardId) || SPECIAL_IDS.has(cardId)) pools.push("azvaldt");
  return pools;
}

/** クレストが入っているプール */
export function poolsOfCrest(crestId: string): PoolId[] {
  const pools: PoolId[] = [];
  if (CRESTS_BY_ID.has(crestId)) pools.push("starter");
  if (AZVALDT_CREST_IDS.has(crestId) || SPECIAL_IDS.has(crestId)) pools.push("azvaldt");
  return pools;
}
