// 作ったデッキのブラウザ内保存（localStorage）。
// 読み書きに失敗しても（プライベートブラウズ等）アプリは動くようにする。

import { CARDS_BY_ID } from "../cards";
import { DECK_CLASSES, type Deck, type DeckClass } from "../cards/deck";

const KEY = "svwb-sim:decks:v1";

export interface SavedDeck extends Deck {
  /** 保存用の一意なキー */
  id: string;
  updatedAt: number;
}

function isSavedDeck(v: unknown): v is SavedDeck {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    DECK_CLASSES.includes(d.class as DeckClass) &&
    Array.isArray(d.cards) &&
    d.cards.every((c) => typeof c === "string") &&
    typeof d.updatedAt === "number"
  );
}

export function loadDecks(): SavedDeck[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    // カードデータの更新で存在しなくなったカードは除く
    return data.filter(isSavedDeck).map((d) => ({ ...d, cards: d.cards.filter((id) => CARDS_BY_ID.has(id)) }));
  } catch {
    return [];
  }
}

/** 保存する。失敗したら false */
export function saveDecks(decks: readonly SavedDeck[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(decks));
    return true;
  } catch {
    return false;
  }
}

export function newDeckId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
