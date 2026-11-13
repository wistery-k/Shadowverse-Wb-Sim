// 元データ（公式サイトのカード一覧APIのレスポンス）をカードプールごとのカードデータに変換する。
// 使い方: npm run cards                  … スターター（data/raw/*.json → data/cards.json・data/crests.json）
//         npm run cards -- --pool azvaldt … 前期のローテーション（data/raw/azvaldt/*.json → data/pools/azvaldt/）
//
// プールの定義は下の POOLS。元データはコミットしない（data/raw/ は .gitignore 対象）。
//
// 対応する元データの形式（どちらもプールの元データの置き場所に置けばまとめて統合する）:
// - API形式: 公式サイトのカード一覧APIのレスポンス（{ data: { card_details, cards, tribe_names, ... } }）。
//   タイプ・関連カード・スターター版の能力（starter_card）を含む。
// - 簡易形式: { "<card_id>": { card_id, name, class, rarity, is_token, cost, skill_text, atk, life } }。
//   タイプ・関連カード・スターター版の能力を含まない。
// 同じカードが両方にあれば API 形式を優先する。
// API 形式の specific_effect_card_info（特殊効果）は、種類 1（クレスト）をクレストのファイルに、
// 種類 2〜4（結晶・アクセラレート・信仰）を特殊効果のファイルに書き出す（種類の名前は docs/rules.md「前期のローテーション」）。
// スターターは最後に data/starter-overrides.json（手で管理する当時の能力への上書き）を適用する。
//
// カードID（8桁）の構成: [0] 1=通常 9=トークン / [2] セット 0=ベーシック 1=第1弾 2=第2弾…
// / [3] クラス / [4] レアリティ / [5] 1=フォロワー 2=アミュレット 3=スペル

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Card, CardSet, CardType, ClassId, Crest, Rarity, SpecialEffect, SpecialKind } from "../src/cards/types";

interface PoolConfig {
  /** 報告に出す名前 */
  label: string;
  /** 元データの置き場所（直下の *.json だけを読む） */
  rawDir: string;
  cardsFile: string;
  crestsFile: string;
  /** 結晶・アクセラレート・信仰。無いプールでは特殊効果の種類 2〜4 を警告にする */
  specialsFile?: string;
  /** 当時の能力への上書き（手で管理する） */
  overridesFile?: string;
  /** プールに入れるセット（公式データの card_set_id）。トークンは参照されるものだけを入れる */
  sets: readonly number[];
  /** スターター版の能力（starter_card）があればそれを使う */
  useStarterAbility: boolean;
}

const POOLS: Record<string, PoolConfig> = {
  /** スターター: 第1弾とベーシック。能力調整されたカードは当時の能力 */
  starter: {
    label: "スターター",
    rawDir: "data/raw",
    cardsFile: "data/cards.json",
    crestsFile: "data/crests.json",
    overridesFile: "data/starter-overrides.json",
    sets: [10000, 10001],
    useStarterAbility: true,
  },
  /** 前期のローテーション（ベーシックと第4〜9弾。能力調整後の今の能力）。ユーザー決定 2026-11-13 */
  azvaldt: {
    label: "前期のローテーション",
    rawDir: "data/raw/azvaldt",
    cardsFile: "data/pools/azvaldt/cards.json",
    crestsFile: "data/pools/azvaldt/crests.json",
    specialsFile: "data/pools/azvaldt/specials.json",
    sets: [10000, 10004, 10005, 10006, 10007, 10008, 10009],
    useStarterAbility: false,
  },
};

/** specific_effect_card_info の specific_effect_type */
const SPECIFIC_EFFECT_CREST = 1;
const SPECIFIC_EFFECT_KINDS: Record<number, SpecialKind> = { 2: "crystallize", 3: "accelerate", 4: "faith" };

/** 公式データの card_set_id。トークンは 90000 */
const API_SETS: Record<number, CardSet> = {
  10000: "basic",
  10001: "legend_dawn",
  10004: "six_dragons",
  10005: "flower_revelry",
  10006: "apocalypse_pact",
  10007: "godslayer_anathema",
  10008: "chronicle_of_destiny",
  10009: "azvaldt_revenant",
  90000: "token",
};
const TOKEN_SET = 90000;
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

// ---- 引数 ----

function parsePool(args: string[]): [string, PoolConfig] {
  let name = "starter";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pool") name = args[++i] ?? "";
    else if (a?.startsWith("--pool=")) name = a.slice("--pool=".length);
    else throw new Error(`未知の引数です: ${a}（使えるのは --pool <名前>）`);
  }
  const pool = POOLS[name];
  if (!pool) throw new Error(`未知のプールです: ${name}（${Object.keys(POOLS).join("・")}）`);
  return [name, pool];
}

const [poolName, pool] = parsePool(process.argv.slice(2));

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

const countdownOf = (text: string): number | undefined => {
  const m = /【カウントダウン_(\d+)】/.exec(text);
  return m?.[1] ? Number(m[1]) : undefined;
};

// ---- 読み込み・統合 ----

const sources = new Map<string, Source>();
const tribeNames: Record<string, string> = {};
const specificEffects = new Map<string, { type: number; cost: number; text: string }>();

if (!existsSync(pool.rawDir)) throw new Error(`${pool.rawDir} がありません（元データの取り出し方は docs/commands.md の一覧の cards）`);
const files = readdirSync(pool.rawDir)
  .filter((f) => f.endsWith(".json") && statSync(join(pool.rawDir, f)).isFile())
  .sort();
if (files.length === 0) throw new Error(`${pool.rawDir} に JSON がありません`);
for (const file of files) {
  const json = JSON.parse(readFileSync(join(pool.rawDir, file), "utf8")) as unknown;
  if (typeof json === "object" && json !== null && "data" in json) {
    const { data } = json as ApiResponse;
    Object.assign(tribeNames, data.tribe_names);
    for (const [id, e] of Object.entries(data.specific_effect_card_info)) {
      specificEffects.set(id, { type: e.specific_effect_type, cost: e.cost, text: e.skill_text });
    }
    for (const [id, { common }] of Object.entries(data.card_details)) {
      // スターターでは当時の能力（starter_card）を使う。IDは通常版のものを使う。
      const fields = (pool.useStarterAbility ? common.starter_card : null) ?? common;
      const c = data.cards[id];
      sources.set(id, {
        fields,
        api: {
          fields,
          setId: common.card_set_id,
          changed: pool.useStarterAbility && common.is_starter_ability_changed,
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

// ---- カードプール（プールのセットと、そこから参照されるトークン） ----

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

/** セットは API 形式の card_set_id、無ければカードIDの3桁目から決める */
const setIdOf = (id: string): number => sources.get(id)?.api?.setId ?? (id.startsWith("9") ? TOKEN_SET : 10000 + Number(id[2]));
const isPoolCard = (id: string) => id.startsWith("1") && pool.sets.includes(setIdOf(id));
const inPool = new Set([...sources.keys()].filter(isPoolCard));
const queue = [...inPool];
while (queue.length > 0) {
  const id = queue.pop() as string;
  for (const ref of relatedOf.get(id) ?? []) {
    if (inPool.has(ref)) continue;
    if (!ref.startsWith("9")) problems.add(`${id}: プールの外のカード ${ref} を参照しています`);
    inPool.add(ref);
    queue.push(ref);
  }
}

// ---- 変換 ----

const overrides = pool.overridesFile
  ? (JSON.parse(readFileSync(pool.overridesFile, "utf8")) as Record<string, Override>)
  : {};

// 特殊効果: クレストは能力テキストに『クレスト：カード名』がある。結晶・アクセラレート・信仰はカードに紐づく
const crests: Crest[] = [];
const crestOf = new Map<string, string>();
const specials = new Map<string, SpecialEffect>();
const specialsOf = new Map<string, string[]>();
for (const [id, s] of sources) {
  if (!inPool.has(id)) continue;
  for (const ref of (s.api?.specificEffects ?? []).map(String)) {
    const e = specificEffects.get(ref);
    if (!e) {
      problems.add(`${id} ${s.fields.name}: 特殊効果 ${ref} のデータがありません`);
      continue;
    }
    if (e.type === SPECIFIC_EFFECT_CREST) {
      const name = `クレスト：${s.fields.name}`;
      const text = cleanText(e.text, `${ref} ${name}`);
      const countdown = countdownOf(text);
      crests.push({ id: ref, name, source: id, text, ...(countdown ? { countdown } : {}) });
      crestOf.set(id, ref);
      continue;
    }
    const kind = SPECIFIC_EFFECT_KINDS[e.type];
    if (!kind || !pool.specialsFile) {
      problems.add(`${id} ${s.fields.name}: 未対応の特殊効果の種類です: ${e.type}`);
      continue;
    }
    // 信仰は複数のカード（旧き天晶・カルギデンスラと天晶の深淵）が同じものを指す
    const prev = specials.get(ref);
    if (prev) {
      prev.sources = [...prev.sources, id].sort();
    } else {
      const text = cleanText(e.text, `${ref} ${s.fields.name}`);
      const countdown = countdownOf(text);
      specials.set(ref, { id: ref, kind, sources: [id], cost: e.cost, text, ...(countdown ? { countdown } : {}) });
    }
    specialsOf.set(id, [...(specialsOf.get(id) ?? []), ref].sort());
  }
}
const crestNames = new Set(crests.map((c) => c.name));

const cards: Card[] = [];
for (const id of inPool) {
  const s = sources.get(id);
  if (!s) {
    problems.add(`${id}: 元データがありません`);
    continue;
  }
  const f = s.fields;
  const where = `${id} ${f.name}`;
  const isToken = id.startsWith("9");
  if (isToken !== f.is_token) problems.add(`${where}: トークン判定が一致しません`);

  const set: CardSet = lookup(API_SETS, isToken ? TOKEN_SET : 10000 + Number(id[2]), "セット", where);
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
    ...(specialsOf.has(id) ? { specials: specialsOf.get(id) as string[] } : {}),
    ...(s.api?.changed || o ? { starterAbilityChanged: true as const } : {}),
  };

  if (type === "follower") {
    cards.push({ ...base, type, attack: o?.attack ?? f.atk, defense: o?.defense ?? f.life });
  } else if (type === "amulet") {
    const countdown = countdownOf(text);
    if (s.api?.fields.type === 3 && !countdown) problems.add(`${where}: カウントダウンの値が見つかりません`);
    cards.push({ ...base, type, ...(countdown ? { countdown } : {}) });
  } else {
    cards.push({ ...base, type });
  }
}

for (const id of Object.keys(overrides)) {
  if (!inPool.has(id)) problems.add(`${pool.overridesFile}: ${id} はカードプールにありません`);
}

// 参照先が見つからない『カード名』
const unresolved = new Set<string>();
for (const c of cards) {
  for (const name of referencedNames(c.text)) if (!idByName.has(name) && !crestNames.has(name)) unresolved.add(name);
}

// 同じ名前のカードが2枚あると、能力の定義（名前でカードIDを引く）が書けない
const names = new Map<string, string>();
for (const c of cards) {
  const prev = names.get(c.name);
  if (prev) problems.add(`${c.id} ${c.name}: 同じ名前のカード ${prev} があります`);
  names.set(c.name, c.id);
}

cards.sort((a, b) => a.id.localeCompare(b.id));
crests.sort((a, b) => a.id.localeCompare(b.id));
const write = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};
write(pool.cardsFile, cards);
write(pool.crestsFile, crests);
if (pool.specialsFile) write(pool.specialsFile, [...specials.values()].sort((a, b) => a.id.localeCompare(b.id)));

// ---- 報告 ----

const SET_LABELS: Record<CardSet, string> = {
  basic: "ベーシック",
  legend_dawn: "伝説の幕開け",
  six_dragons: "蒼空の六竜",
  flower_revelry: "花酔遊戯",
  apocalypse_pact: "アポカリプス・パクト",
  godslayer_anathema: "神殺し・アナテマ",
  chronicle_of_destiny: "クロニクル・オブ・デスティニー",
  azvaldt_revenant: "アズヴォルト・レヴナント",
  token: "トークン",
};
const count = (pred: (c: Card) => boolean) => cards.filter(pred).length;
const perSet = [...new Set(cards.map((c) => c.set))]
  .map((set) => `${SET_LABELS[set]} ${count((c) => c.set === set)}`)
  .join("、");
console.log(`${pool.label}（${poolName}）: ${files.length} ファイルから ${cards.length} 枚を ${pool.cardsFile} に書き出しました（${perSet}）`);
console.log(`クレスト ${crests.length} 件を ${pool.crestsFile} に書き出しました`);
if (pool.specialsFile) {
  const kinds = [...specials.values()].reduce<Record<string, number>>((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  console.log(`特殊効果 ${specials.size} 件（${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join("、")}）を ${pool.specialsFile} に書き出しました`);
}
if (pool.useStarterAbility) {
  const changed = cards.filter((c) => c.starterAbilityChanged).map((c) => c.name);
  console.log(`当時の能力に差し替えたカード: ${changed.length > 0 ? changed.join("、") : "なし"}`);
}
console.log(`タイプ不明（API形式のデータが無い）: ${count((c) => c.tribes === null)} 枚`);
if (unresolved.size > 0) console.log(`データに無い参照カード名: ${[...unresolved].join("、")}`);
if (problems.size > 0) {
  console.warn(`警告 ${problems.size} 件:\n${[...problems].join("\n")}`);
  process.exitCode = 1;
}
