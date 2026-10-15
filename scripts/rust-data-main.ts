// Rust 版エンジン（rust/）が読むデータを書き出す（npm run rust-data）。
// カード・クレストの基本情報と、テキストから読み取る常在型キーワード等（registry.ts の staticOf と同じもの）、
// カード能力の DSL（src/cards/abilities。関数を含まない JSON）、アポカリプスデッキ、デフォルトデッキを 1 つの JSON にまとめる。
// 出力は rust/engine/data/engine-data.json（生成物なのでコミットしない）。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";
import { APOCALYPSE_DECK } from "../src/cards/abilities/special";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { enhanceCost, staticOf } from "../src/engine";

export const RUST_DATA_PATH = "rust/engine/data/engine-data.json";

export function engineData() {
  return {
    cards: ALL_CARDS.map((c) => {
      const st = staticOf(c.id);
      return {
        id: c.id,
        type: c.type,
        class: c.class,
        cost: c.cost,
        attack: c.type === "follower" ? c.attack : 0,
        defense: c.type === "follower" ? c.defense : 0,
        countdown: c.type === "amulet" ? (c.countdown ?? null) : null,
        tribes: c.tribes ?? [],
        keywords: st.keywords,
        maxAttacks: st.maxAttacks,
        earthSigil: st.earthSigil,
        enhance: enhanceCost(c.text),
        token: c.set === "token",
      };
    }),
    crests: ALL_CRESTS.map((c) => ({ id: c.id, countdown: c.countdown ?? null })),
    cardAbilities: CARD_ABILITIES,
    crestAbilities: CREST_ABILITIES,
    apocalypseDeck: APOCALYPSE_DECK,
    decks: DEFAULT_DECKS.map((d) => ({ key: d.key, cards: d.cards })),
  };
}

export async function main(argv: string[]): Promise<number> {
  const out = argv[0] ?? RUST_DATA_PATH;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(engineData()));
  console.log(`${out} に書き出しました`);
  return 0;
}
