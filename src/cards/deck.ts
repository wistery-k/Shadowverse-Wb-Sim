// デッキとそのテキスト形式（エクスポート・インポート・data/decks/*.txt で共通）
//
// 形式の例:
//   # コメント（# で始まる行は無視）
//   名前: エルフテスト
//   クラス: エルフ
//   3 フェアリーテイマー
//   2 ベビーカーバンクル
//
// カードの行は「枚数 カード名」。カード名の代わりにカードIDも使える。「3x 名前」「3 × 名前」も可。
// クラスの行は省略でき、その場合はニュートラル以外のカードから決める。

import { ALL_CARDS, CARDS_BY_ID } from "./index";
import { CLASS_NAMES, type Card, type ClassId } from "./types";

export type DeckClass = Exclude<ClassId, "neutral">;
export const DECK_CLASSES: readonly DeckClass[] = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"];

export interface Deck {
  name: string;
  class: DeckClass;
  /** カードIDの配列（枚数分くり返す） */
  cards: string[];
}

const CARD_BY_NAME = new Map(ALL_CARDS.map((c) => [c.name, c]));

/** 表示・エクスポート用の並び順（コスト → カードID） */
export function compareCards(a: Card, b: Card): number {
  return a.cost - b.cost || a.id.localeCompare(b.id);
}

/** カードIDごとの枚数 */
export function countCards(cards: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export function deckToText(deck: Deck): string {
  const lines = [`名前: ${deck.name}`, `クラス: ${CLASS_NAMES[deck.class]}`];
  const counts = countCards(deck.cards);
  const cards = [...counts.keys()]
    .map((id) => CARDS_BY_ID.get(id))
    .filter((c): c is Card => c !== undefined)
    .sort(compareCards);
  for (const c of cards) lines.push(`${counts.get(c.id)} ${c.name}`);
  return lines.join("\n") + "\n";
}

function parseClass(value: string): DeckClass | null {
  const v = value.trim();
  for (const c of DECK_CLASSES) if (c === v || CLASS_NAMES[c] === v) return c;
  return null;
}

export interface ParseResult {
  deck: Deck | null;
  errors: string[];
}

/** テキストからデッキを読む。カードの合法性（枚数・同名上限等）は検査しない（deckProblems で行う） */
export function parseDeckText(text: string, defaultName = "インポートしたデッキ"): ParseResult {
  const errors: string[] = [];
  let name = defaultName;
  let deckClass: DeckClass | null = null;
  const cards: string[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `${i + 1}行目`;
    const meta = /^(名前|クラス|name|class)\s*[:：]\s*(.*)$/i.exec(line);
    if (meta) {
      const key = meta[1] ?? "";
      const value = (meta[2] ?? "").trim();
      if (key === "名前" || key.toLowerCase() === "name") name = value || name;
      else {
        deckClass = parseClass(value);
        if (!deckClass) errors.push(`${where}: 不明なクラス「${value}」`);
      }
      return;
    }
    const m = /^(\d+)\s*[x×]?\s+(.+)$/i.exec(line);
    if (!m) {
      errors.push(`${where}: 「枚数 カード名」の形式ではありません: ${line}`);
      return;
    }
    const count = Number(m[1]);
    const key = (m[2] ?? "").trim();
    const card = CARD_BY_NAME.get(key) ?? CARDS_BY_ID.get(key);
    if (!card) {
      errors.push(`${where}: 不明なカード「${key}」`);
      return;
    }
    for (let n = 0; n < count; n++) cards.push(card.id);
  });

  if (deckClass === null && errors.length === 0) {
    const classes = [...new Set(cards.map((id) => CARDS_BY_ID.get(id)?.class).filter((c) => c && c !== "neutral"))];
    if (classes.length === 1) deckClass = classes[0] as DeckClass;
    else if (classes.length === 0) errors.push("クラスが決められません（「クラス: エルフ」のように指定してください）");
    else errors.push(`複数のクラスのカードが含まれています: ${classes.map((c) => CLASS_NAMES[c as ClassId]).join("・")}`);
  }

  if (errors.length > 0 || deckClass === null) return { deck: null, errors };
  return { deck: { name, class: deckClass, cards }, errors: [] };
}
