// Rust 版エンジン（rust/）が読むデータを書き出す（npm run rust-data）。
// カード・クレストの基本情報と、テキストから読み取る常在型キーワード等（registry.ts の staticOf と同じもの）、
// カード能力の DSL（src/cards/abilities。関数を含まない JSON）、アポカリプスデッキ、デフォルトデッキを 1 つの JSON にまとめる。
// 探索 AI が使うデータ（評価関数の重み、学習した評価の補正、マリガンの係数等）は ai-data.json に書き出す。
// 出力は rust/engine/data/ の 2 つ（生成物なのでコミットしない）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ALL_CARDS, ALL_CRESTS } from "../src/cards";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";
import { APOCALYPSE_DECK } from "../src/cards/abilities/special";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { enhanceCost, staticOf } from "../src/engine";
import { id } from "../src/cards/abilities/helpers";
import { CLASS_WEIGHTS, DEFAULT_WEIGHTS, MODEL_FEATURES, MULLIGAN_MODEL, MULLIGAN_ROLES, MULLIGAN_WEIGHTS, ROLES, SEARCH_WEIGHTS } from "../src/ai/data";
import valueNet from "../data/value-net.json";

export const RUST_DATA_PATH = "rust/engine/data/engine-data.json";
export const RUST_AI_DATA_PATH = "rust/engine/data/ai-data.json";

export function engineData() {
  return {
    cards: ALL_CARDS.map((c) => {
      const st = staticOf(c.id);
      return {
        id: c.id,
        name: c.name,
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
    decks: DEFAULT_DECKS.map((d) => ({ key: d.key, name: d.name, cards: d.cards })),
  };
}

/** 探索 AI のデータ（src/ai/data.ts と、学習した評価の補正 data/value-net.json） */
export function aiData() {
  return {
    defaultWeights: DEFAULT_WEIGHTS,
    searchWeights: SEARCH_WEIGHTS,
    // countdownDecay ** n（V8 の Math.pow は Rust の powf と最後の桁が違うことがあるので、表にして渡す）
    decayPow: Object.fromEntries(
      [DEFAULT_WEIGHTS.countdownDecay, SEARCH_WEIGHTS.countdownDecay].map((d) => [String(d), Array.from({ length: 64 }, (_, n) => d ** n)]),
    ),
    cards: {
      kuon: id("五行の果て・クオン"),
      kerberos: id("奔放なる獄炎・ケルベロス"),
      jeanne: id("純白の聖女・ジャンヌ"),
      fusionSet: ["デストロイアーティファクトα", "デストロイアーティファクトβ", "デストロイアーティファクトγ"].map(id),
      boostGrown: [id("成長したですぅ！")],
    },
    valueNet,
    mulliganWeights: MULLIGAN_WEIGHTS,
    mulliganModel: MULLIGAN_MODEL,
    mulliganRoles: MULLIGAN_ROLES,
    roles: ROLES,
    modelFeatures: MODEL_FEATURES,
    classWeights: CLASS_WEIGHTS,
  };
}

/** 中身が変わったときだけ書く（変わらなければ Rust を作り直さずに済む） */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

export async function main(argv: string[]): Promise<number> {
  const quiet = argv.includes("--quiet");
  const [out = RUST_DATA_PATH, aiOut = RUST_AI_DATA_PATH] = argv.filter((a) => a !== "--quiet");
  mkdirSync(dirname(out), { recursive: true });
  const changed = [writeIfChanged(out, JSON.stringify(engineData())), writeIfChanged(aiOut, JSON.stringify(aiData()))];
  if (!quiet) console.log(changed.some((c) => c) ? `${out}・${aiOut} に書き出しました` : `${out}・${aiOut} は変わっていません`);
  return 0;
}
