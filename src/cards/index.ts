import rawCards from "../../data/cards.json";
import type { Card } from "./types";
import { validateCards } from "./validate";

export * from "./types";
export * from "./format";
export { validateCards, CardValidationError } from "./validate";

/** 検証済みの全カード（トークン含む） */
export const ALL_CARDS: readonly Card[] = validateCards(rawCards);

export const CARDS_BY_ID: ReadonlyMap<string, Card> = new Map(
  ALL_CARDS.map((c) => [c.id, c]),
);
