// 元データ（data/raw/*.json）を data/cards.json に変換する。
// 使い方: npm run cards
//
// 対応する元データの形式（どちらも data/raw/ に置けばまとめて統合する。元データはコミットしない）:
// - API形式: 公式サイトのカード一覧APIのレスポンス（{ data: { card_details, cards, tribe_names, ... } }）。
//   タイプ・関連カード・スターター版の能力（starter_card）を含む。
// - 簡易形式: { "<card_id>": { card_id, name, class, rarity, is_token, cost, skill_text, atk, life } }。
//   タイプ・関連カード・スターター版の能力を含まない。
// 同じカードが両方にあれば API 形式を優先する。
// クレスト（API形式の specific_effect_card_info）は data/crests.json に書き出す。
// 最後に data/starter-overrides.json（手で管理する当時の能力への上書き）を適用する。
//
// カードID（8桁）の構成: [0] 1=通常 9=トークン / [2] セット 0=ベーシック 1=第1弾 2=第2弾…
// / [3] クラス / [4] レアリティ / [5] 1=フォロワー 2=アミュレット 3=スペル

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, CardSet, CardType, ClassId, Crest, Rarity } from "../src/cards/types";

const RAW_DIR = "data/raw";
const OVERRIDES_FILE = "data/starter-overrides.json";
const OUT_FILE = "data/cards.json";
const CRESTS_FILE = "data/crests.json";
/** specific_effect_card_info の specific_effect_type。1 はクレスト */
const SPECIFIC_EFFECT_CREST = 1;

/** スターターで使えるセット（カードIDの3桁目） */
const POOL_SETS: Record<string, CardSet> = { "0": "basic", "1": "legend_dawn" };
const API_SETS: Record<number, CardSet> = { 10000: "basic", 10001: "legend_dawn", 90000: "token" };
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
/** API の type。3 はカウントダウンを持つアミュレット */
const API_TYPES: Record<number, CardType> = { 1: "follower", 2: "amulet", 3: "amulet", 4: "spell" };
/** カードIDの6桁目 */
const ID_TYPES: Record<string, CardType> = { "1": "follower", "2": "amulet", "3": "spell" };

interface RawCardFields {
  card_id: number;
  name: string;
  atk: number;
  life: number;
  skill_text: string;
  class: number;
  cost: number;
  rarity: number;
  is_token: boolean;
}
interface ApiCardFields extends RawCardFields {
  card_set_id: number;
  type: number;
  tribes: number[];
}
interface ApiCommon extends ApiCardFields {
  starter_card: ApiCardFields | null;
  is_starter_ability_changed: boolean;
}
interface ApiResponse {
  data: {
    cards: Record<string, { related_card_ids: number[]; specific_effect_card_ids: number[] }>;
    card_details: Record<string, { common: ApiCommon }>;
    tribe_names: Record<string, string>;
    /** 該当が無いときは空配列になる */
    specific_effect_card_info:
      | Record<string, { specific_effect_type: number; cost: number; skill_text: string }>
      | [];
  };
}
type SimpleResponse = Record<string, RawCardFields>;

/** 統合後の1枚分の元データ */
interface Source {
  fields: RawCardFields;
  /** setId は通常版のもの（スターター版は別のセットIDを持つ） */
  api?: {
    fields: ApiCardFields;
    setId: number;
    changed: boolean;
    related: number[];
    specificEffects: number[];
  };
}

interface Override {
  cost?: number;
  attack?: number;
  defense?: number;
  text?: string;
  tribes?: string[];
  /** 出典や変更内容のメモ（出力には含めない） */
  note?: string;
}

const problems = new Set<string>();

function lookup<T>(table: Record<string | number, T>, key: string | number, what: string, where: string): T {
  const v = table[key];
  if (v === undefined) throw new Error(`${where}: 未知の${what}です: ${key}`);
  return v;
}

/** 公式の装飾タグを除去する。<hr>（区切り線）は改行にする。 */
function cleanText(text: string, where: string): string {
  const out = text
    .replace(/<\/?color[^>]*>/g, "")
    .replace(/<\/?s?ev>/g, "")
    .replace(/<\/?ridx(=\d+)?>/g, "") // 【モード】の選択肢
    .replace(/<hr>/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (/[<>]/.test(out)) problems.add(`${where}: 未対応のタグがあります: ${out}`);
  return out;
}

/** 能力テキスト中の『カード名』 */
const referencedNames = (text: string): string[] =>
  [...text.matchAll(/『([^』]+)』/g)].map((m) => m[1] ?? "");

// ---- 読み込み・統合 ----

const sources = new Map<string, Source>();
const tribeNames: Record<string, string> = {};
const specificEffects = new Map<string, { type: number; text: string }>();

const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) throw new Error(`${RAW_DIR} に JSON がありません`);
for (const file of files) {
  const json = JSON.parse(readFileSync(join(RAW_DIR, file), "utf8")) as unknown;
  if (typeof json === "object" && json !== null && "data" in json) {
    const { data } = json as ApiResponse;
    Object.assign(tribeNames, data.tribe_names);
    for (const [id, e] of Object.entries(data.specific_effect_card_info)) {
      specificEffects.set(id, { type: e.specific_effect_type, text: e.skill_text });
    }
    for (const [id, { common }] of Object.entries(data.card_details)) {
      // スターターでは当時の能力（starter_card）を使う。IDは通常版のものを使う。
      const fields = common.starter_card ?? common;
      const c = data.cards[id];
      sources.set(id, {
        fields,
        api: {
          fields,
          setId: common.card_set_id,
          changed: common.is_starter_ability_changed,
          related: c?.related_card_ids ?? [],
          specificEffects: c?.specific_effect_card_ids ?? [],
        },
      });
    }
  } else {
    for (const [id, fields] of Object.entries(json as SimpleResponse)) {
      const prev = sources.get(id);
      if (prev?.api) continue; // API形式を優先
      sources.set(id, { fields });
    }
  }
}

// ---- スターターのカードプール（ベーシック・第1弾と、そこから参照されるトークン） ----

const idByName = new Map<string, string>();
for (const [id, s] of sources) idByName.set(s.fields.name, id);

const relatedOf = new Map<string, string[]>();
for (const [id, s] of sources) {
  const where = `${id} ${s.fields.name}`;
  const refs = new Set((s.api?.related ?? []).map(String));
  for (const name of referencedNames(cleanText(s.fields.skill_text, where))) {
    const ref = idByName.get(name);
    if (ref !== undefined) refs.add(ref);
  }
  refs.delete(id);
  relatedOf.set(id, [...refs].sort());
}

const isPoolCard = (id: string) => id.startsWith("1") && (id[2] ?? "") in POOL_SETS;
const pool = new Set([...sources.keys()].filter(isPoolCard));
const queue = [...pool];
while (queue.length > 0) {
  const id = queue.pop() as string;
  for (const ref of relatedOf.get(id) ?? []) {
    if (pool.has(ref)) continue;
    if (!ref.startsWith("9")) problems.add(`${id}: 第2弾以降のカード ${ref} を参照しています`);
    pool.add(ref);
    queue.push(ref);
  }
}

// ---- 変換 ----

const overrides = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8")) as Record<string, Override>;

// クレスト: 能力テキストに『クレスト：カード名』がある
const crests: Crest[] = [];
const crestOf = new Map<string, string>();
for (const [id, s] of sources) {
  if (!pool.has(id)) continue;
  for (const ref of (s.api?.specificEffects ?? []).map(String)) {
    const e = specificEffects.get(ref);
    if (!e) {
      problems.add(`${id} ${s.fields.name}: 特殊効果 ${ref} のデータがありません`);
      continue;
    }
    if (e.type !== SPECIFIC_EFFECT_CREST) {
      problems.add(`${id} ${s.fields.name}: 未対応の特殊効果の種類です: ${e.type}`);
      continue;
    }
    const name = `クレスト：${s.fields.name}`;
    const text = cleanText(e.text, `${ref} ${name}`);
    const m = /【カウントダウン_(\d+)】/.exec(text);
    crests.push({ id: ref, name, source: id, text, ...(m?.[1] ? { countdown: Number(m[1]) } : {}) });
    crestOf.set(id, ref);
  }
}
const crestNames = new Set(crests.map((c) => c.name));

const cards: Card[] = [];
for (const id of pool) {
  const s = sources.get(id);
  if (!s) {
    problems.add(`${id}: 元データがありません`);
    continue;
  }
  const f = s.fields;
  const where = `${id} ${f.name}`;
  const isToken = id.startsWith("9");
  if (isToken !== f.is_token) problems.add(`${where}: トークン判定が一致しません`);

  const set: CardSet = isToken ? "token" : lookup(POOL_SETS, id[2] ?? "", "セット", where);
  let type = lookup(ID_TYPES, id[5] ?? "", "カード種類", where);
  let tribes: string[] | null = null;
  if (s.api) {
    const apiSet = lookup(API_SETS, s.api.setId, "セット", where);
    if (apiSet !== set) problems.add(`${where}: セットがIDと一致しません (${apiSet})`);
    type = lookup(API_TYPES, s.api.fields.type, "カード種類", where);
    tribes = s.api.fields.tribes
      .filter((t) => t !== 0)
      .map((t) => lookup(tribeNames, t, "タイプ", where));
  }

  const o = overrides[id];
  if (o && type !== "follower" && (o.attack !== undefined || o.defense !== undefined)) {
    problems.add(`${where}: フォロワー以外に attack/defense の上書きがあります`);
  }
  const text = o?.text ?? cleanText(f.skill_text, where);
  const base = {
    id,
    name: f.name,
    class: lookup(CLASSES, f.class, "クラス", where),
    set,
    rarity: lookup(RARITIES, f.rarity, "レアリティ", where),
    cost: o?.cost ?? f.cost,
    tribes: o?.tribes ?? tribes,
    text,
    related: relatedOf.get(id) ?? [],
    ...(crestOf.has(id) ? { crest: crestOf.get(id) as string } : {}),
    ...(s.api?.changed || o ? { starterAbilityChanged: true as const } : {}),
  };

  if (type === "follower") {
    cards.push({ ...base, type, attack: o?.attack ?? f.atk, defense: o?.defense ?? f.life });
  } else if (type === "amulet") {
    const m = /【カウントダウン_(\d+)】/.exec(text);
    if (s.api?.fields.type === 3 && !m) problems.add(`${where}: カウントダウンの値が見つかりません`);
    cards.push({ ...base, type, ...(m?.[1] ? { countdown: Number(m[1]) } : {}) });
  } else {
    cards.push({ ...base, type });
  }
}

for (const id of Object.keys(overrides)) {
  if (!pool.has(id)) problems.add(`${OVERRIDES_FILE}: ${id} はカードプールにありません`);
}

// 参照先が見つからない『カード名』
const unresolved = new Set<string>();
for (const c of cards) {
  for (const name of referencedNames(c.text)) if (!idByName.has(name) && !crestNames.has(name)) unresolved.add(name);
}

cards.sort((a, b) => a.id.localeCompare(b.id));
crests.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT_FILE, JSON.stringify(cards, null, 2) + "\n");
writeFileSync(CRESTS_FILE, JSON.stringify(crests, null, 2) + "\n");

// ---- 報告 ----

const count = (pred: (c: Card) => boolean) => cards.filter(pred).length;
console.log(
  `${files.length} ファイルから ${cards.length} 枚を ${OUT_FILE} に書き出しました` +
    `（ベーシック ${count((c) => c.set === "basic")}、伝説の幕開け ${count((c) => c.set === "legend_dawn")}、` +
    `トークン ${count((c) => c.set === "token")}）`,
);
console.log(`クレスト ${crests.length} 件を ${CRESTS_FILE} に書き出しました`);
const changed = cards.filter((c) => c.starterAbilityChanged).map((c) => c.name);
console.log(`当時の能力に差し替えたカード: ${changed.length > 0 ? changed.join("、") : "なし"}`);
console.log(`タイプ不明（API形式のデータが無い）: ${count((c) => c.tribes === null)} 枚`);
if (unresolved.size > 0) console.log(`データに無い参照カード名: ${[...unresolved].join("、")}`);
if (problems.size > 0) {
  console.warn(`警告 ${problems.size} 件:\n${[...problems].join("\n")}`);
  process.exitCode = 1;
}
