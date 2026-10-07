// 公式サイトのカード一覧APIのレスポンス（data/raw/*.json）を data/cards.json に変換する。
// 使い方: node scripts/convert-cards.ts
// 複数ページのレスポンスを data/raw/ に置けばまとめて変換する。元データはコミットしない。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, CardSet, CardType, ClassId, Rarity } from "../src/cards/types";

const RAW_DIR = "data/raw";
const OUT_FILE = "data/cards.json";

const SETS: Record<number, CardSet> = { 10000: "basic", 10001: "legend_dawn", 90000: "token" };
const CLASSES: Record<number, ClassId> = {
  0: "neutral",
  1: "elf",
  2: "royal",
  3: "witch",
  4: "dragon",
  5: "nightmare",
  6: "bishop",
  7: "nemesis",
};
const RARITIES: Record<number, Rarity> = { 1: "bronze", 2: "silver", 3: "gold", 4: "legend" };
// 3 はカウントダウンを持つアミュレット
const TYPES: Record<number, CardType> = { 1: "follower", 2: "amulet", 3: "amulet", 4: "spell" };

interface RawCardFields {
  card_id: number;
  name: string;
  atk: number;
  life: number;
  skill_text: string;
  card_set_id: number;
  type: number;
  class: number;
  tribes: number[];
  cost: number;
  rarity: number;
  is_token: boolean;
}
interface RawCommon extends RawCardFields {
  starter_card: RawCardFields | null;
  is_starter_ability_changed: boolean;
}
interface RawResponse {
  data: {
    cards: Record<string, { related_card_ids: number[]; specific_effect_card_ids: number[] }>;
    card_details: Record<string, { common: RawCommon }>;
    tribe_names: Record<string, string>;
    count: number;
  };
}

const problems: string[] = [];

function lookup<T>(table: Record<number, T>, key: number, what: string, where: string): T {
  const v = table[key];
  if (v === undefined) throw new Error(`${where}: 未知の${what}です: ${key}`);
  return v;
}

/** 公式の装飾タグを除去する。<hr>（区切り線）は改行にする。 */
function cleanText(text: string, where: string): string {
  const out = text
    .replace(/<\/?color[^>]*>/g, "")
    .replace(/<\/?s?ev>/g, "")
    .replace(/<hr>/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (/[<>]/.test(out)) problems.push(`${where}: 未対応のタグがあります: ${out}`);
  return out;
}

// 読み込み・マージ
const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) throw new Error(`${RAW_DIR} に JSON がありません`);

const details = new Map<string, RawCommon>();
const related = new Map<string, number[]>();
const tribeNames: Record<string, string> = {};
let expectedCount = 0;
for (const file of files) {
  const res = JSON.parse(readFileSync(join(RAW_DIR, file), "utf8")) as RawResponse;
  for (const [id, d] of Object.entries(res.data.card_details)) details.set(id, d.common);
  for (const [id, c] of Object.entries(res.data.cards)) {
    related.set(id, [...c.related_card_ids, ...c.specific_effect_card_ids]);
  }
  Object.assign(tribeNames, res.data.tribe_names);
  expectedCount = Math.max(expectedCount, res.data.count);
}

// 変換
const cards: Card[] = [];
for (const [id, common] of details) {
  // スターターでは当時の能力（starter_card）を使う。IDは通常版のものを使う。
  const src = common.starter_card ?? common;
  const where = `${id} ${common.name}`;
  const set = lookup(SETS, common.card_set_id, "セット", where);
  if ((set === "token") !== common.is_token) problems.push(`${where}: トークン判定が一致しません`);

  const text = cleanText(src.skill_text, where);
  const base = {
    id,
    name: common.name,
    class: lookup(CLASSES, src.class, "クラス", where),
    set,
    rarity: lookup(RARITIES, src.rarity, "レアリティ", where),
    cost: src.cost,
    tribes: src.tribes
      .filter((t) => t !== 0)
      .map((t) => lookup(tribeNames, t, "タイプ", where)),
    text,
    related: [...new Set(related.get(id) ?? [])].map(String).sort(),
    ...(common.is_starter_ability_changed ? { starterAbilityChanged: true as const } : {}),
  };

  const type = lookup(TYPES, src.type, "カード種類", where);
  if (type === "follower") {
    cards.push({ ...base, type, attack: src.atk, defense: src.life });
  } else if (type === "amulet") {
    const m = /【カウントダウン_(\d+)】/.exec(text);
    if (src.type === 3 && !m) problems.push(`${where}: カウントダウンの値が見つかりません`);
    cards.push({ ...base, type, ...(m?.[1] ? { countdown: Number(m[1]) } : {}) });
  } else {
    cards.push({ ...base, type });
  }
}

cards.sort((a, b) => a.id.localeCompare(b.id));

const ids = new Set(cards.map((c) => c.id));
for (const c of cards) {
  for (const ref of c.related) {
    if (!ids.has(ref)) problems.push(`${c.id} ${c.name}: 関連カード ${ref} の詳細がありません`);
  }
}

const deckCards = cards.filter((c) => c.set !== "token").length;
if (deckCards < expectedCount) {
  problems.push(`デッキ用カードが ${deckCards}/${expectedCount} 枚しかありません（未取得のページがあります）`);
}

writeFileSync(OUT_FILE, JSON.stringify(cards, null, 2) + "\n");
console.log(`${files.length} ファイルから ${cards.length} 枚（デッキ用 ${deckCards}、トークン ${cards.length - deckCards}）を ${OUT_FILE} に書き出しました`);
const changed = cards.filter((c) => c.starterAbilityChanged);
console.log(`当時の能力に差し替えたカード: ${changed.length > 0 ? changed.map((c) => c.name).join("、") : "なし"}`);
if (problems.length > 0) {
  console.warn(`警告 ${problems.length} 件:\n${problems.join("\n")}`);
  process.exitCode = 1;
}
