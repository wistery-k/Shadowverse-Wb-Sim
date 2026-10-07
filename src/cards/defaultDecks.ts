// リポジトリ同梱のデフォルトデッキ（data/decks/*.txt）。形式は src/cards/deck.ts を参照。

import { parseDeckText, type Deck } from "./deck";

const files = import.meta.glob<string>("../../data/decks/*.txt", { query: "?raw", import: "default", eager: true });

export interface DefaultDeck extends Deck {
  /** ファイル名（拡張子なし） */
  key: string;
}

export interface DefaultDeckError {
  file: string;
  errors: string[];
}

function load(): { decks: DefaultDeck[]; errors: DefaultDeckError[] } {
  const decks: DefaultDeck[] = [];
  const errors: DefaultDeckError[] = [];
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const key = path.replace(/^.*\//, "").replace(/\.txt$/, "");
    const result = parseDeckText(text, key);
    if (result.deck) decks.push({ ...result.deck, key });
    else errors.push({ file: path, errors: result.errors });
  }
  return { decks, errors };
}

const loaded = load();

/** 読み込めたデフォルトデッキ */
export const DEFAULT_DECKS: readonly DefaultDeck[] = loaded.decks;
/** 読み込めなかったファイル（テストで検出する） */
export const DEFAULT_DECK_ERRORS: readonly DefaultDeckError[] = loaded.errors;
