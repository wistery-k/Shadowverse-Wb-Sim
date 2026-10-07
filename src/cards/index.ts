import rawCards from "../../data/cards.json";
import rawCrests from "../../data/crests.json";
import type { Card, Crest } from "./types";
import { validateCards, validateCrests } from "./validate";

export * from "./types";
export * from "./format";
export { validateCards, validateCrests, CardValidationError } from "./validate";

/** 検証済みの全カード（トークン含む） */
export const ALL_CARDS: readonly Card[] = validateCards(rawCards);

export const CARDS_BY_ID: ReadonlyMap<string, Card> = new Map(
  ALL_CARDS.map((c) => [c.id, c]),
);

/** 検証済みの全クレスト */
export const ALL_CRESTS: readonly Crest[] = validateCrests(rawCrests, ALL_CARDS);

export const CRESTS_BY_ID: ReadonlyMap<string, Crest> = new Map(
  ALL_CRESTS.map((c) => [c.id, c]),
);
