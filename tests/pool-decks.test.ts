// 前期のローテーションのプロのデッキ（data/pools/azvaldt/decks/、npm run decks で変換）が読めて、構築の決まりを満たすこと。
// スターターのデッキの読み込み（src/cards/deck.ts）はスターターのカードの表を使うので、ここではプールのカードの表で読む。

import { describe, expect, it } from "vitest";
import rawRotCards from "../data/pools/azvaldt/cards.json";
import { AZVALDT, CLASS_IDS, CLASS_NAMES, deckProblems, type Card, type ClassId } from "../src/cards";
import { agentOf } from "../src/ai/registry";
import { invariantViolations } from "../src/engine";
import { playMatch } from "../src/sim/match";

const files = import.meta.glob<string>("../data/pools/azvaldt/decks/*/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});

const cards = rawRotCards as Card[];
const cardByName = new Map(cards.filter((c) => c.set !== "token").map((c) => [c.name, c]));
const classByName = new Map<string, ClassId>(CLASS_IDS.map((id) => [CLASS_NAMES[id], id]));

interface ParsedDeck {
  name: string | null;
  cls: ClassId | null;
  cards: Card[];
  errors: string[];
}

function parse(text: string): ParsedDeck {
  const deck: ParsedDeck = { name: null, cls: null, cards: [], errors: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const meta = /^(名前|クラス)\s*[:：]\s*(.*)$/.exec(line);
    if (meta) {
      if (meta[1] === "名前") deck.name = meta[2] ?? null;
      else deck.cls = classByName.get(meta[2] ?? "") ?? null;
      continue;
    }
    const m = /^(\d+)\s+(.+)$/.exec(line);
    const card = m ? cardByName.get(m[2] ?? "") : undefined;
    if (!m || !card) {
      deck.errors.push(`読めない行: ${line}`);
      continue;
    }
    for (let i = 0; i < Number(m[1]); i++) deck.cards.push(card);
  }
  return deck;
}

describe("前期のローテーションのプロのデッキ", () => {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));

  it("3 大会の 84 デッキがある", () => {
    const events = new Set(entries.map(([path]) => path.split("/").at(-2)));
    expect([...events].sort()).toEqual(["ps26-27-08b", "ps26-27-09a", "ps26-27-09b"]);
    expect(entries).toHaveLength(84);
  });

  it.each(entries.map(([path, text]) => [path.replace(/^.*decks\//, ""), text] as const))("%s", (_, text) => {
    const deck = parse(text);
    expect(deck.errors).toEqual([]);
    expect(deck.name).toBeTruthy();
    expect(deck.cls).not.toBeNull();
    expect(deckProblems(AZVALDT, deck.cls ?? "neutral", deck.cards)).toEqual([]);
  });
});

// エンジンの土台（docs/pools/azvaldt.md「段取り」3）: 前期のローテーションのカードがエンジンのカードの表にあり、試合が最後まで進むこと。
// 前期のローテーションの能力はまだ定義していないので、カードは能力値とテキストから読むキーワードだけで動く
describe("前期のローテーションのプロのデッキでランダム自己対戦", () => {
  const decks = Object.values(files)
    .sort()
    .map((text) => parse(text).cards.map((c) => c.id));
  const randomAgent = agentOf("random");

  it("100 試合が不変条件を破らずに終わる", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const pair: [string[], string[]] = [decks[seed % decks.length]!, decks[(seed * 37) % decks.length]!];
      const result = playMatch([randomAgent, randomAgent], { decks: pair, seed, checkInvariants: true });
      expect(invariantViolations(result.final)).toEqual([]);
      expect([0, 1]).toContain(result.winner);
    }
  }, 60_000);
});
