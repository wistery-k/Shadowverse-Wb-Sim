// Rust 版エンジン（rust/）が読むデータを書き出す（npm run rust-data）。
// カード・クレストの基本情報と、テキストから読み取る常在型キーワード等（registry.ts の staticOf と同じもの）、
// カード能力の DSL（src/cards/abilities。関数を含まない JSON）、アポカリプスデッキ、デフォルトデッキを 1 つの JSON にまとめる。
// 探索 AI が使うデータ（評価関数の重み、学習した評価の補正、マリガンの係数等）は ai-data.json に書き出す。
// 出力は rust/engine/data/ の 2 つ（生成物なのでコミットしない）。
// あわせて、元になったファイルの中身の指紋を sources.txt に書く。rust/engine/build.rs がビルドのときに確かめ、
// 元のファイルが変わったのに書き出し直していなければ、ビルドを止める（古い補正などを埋め込まないように）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** 書き出すデータの元になるファイル（ディレクトリと、その下で数えるファイル名）。元データの data/raw/ は除く */
const SOURCES: [string, RegExp][] = [
  ["data", /./],
  ["src/cards", /\.ts$/],
  ["src/engine", /\.ts$/],
  ["src/ai", /^data\.ts$/],
];

function listFiles(dir: string, keep: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return path === "data/raw" ? [] : listFiles(path, keep);
    return keep.test(e.name) ? [path] : [];
  });
}

/** FNV-1a（32 ビット）。build.rs と同じ */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** 元になったファイルの指紋の一覧（1 行に「指紋 パス」。パスはリポジトリの最上位から） */
export function sourcesText(): string {
  const paths = SOURCES.flatMap(([dir, keep]) => listFiles(dir, keep)).sort();
  const lines = paths.map((path) => `${fnv1a(readFileSync(path))} ${path}`);
  return `# npm run rust-data が書き出す。元のファイルの中身の指紋（FNV-1a 32 ビット）。rust/engine/build.rs が確かめる\n${lines.join("\n")}\n`;
}

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
  writeIfChanged(join(dirname(aiOut), "sources.txt"), sourcesText());
  if (!quiet) console.log(changed.some((c) => c) ? `${out}・${aiOut} に書き出しました` : `${out}・${aiOut} は変わっていません`);
  return 0;
}
