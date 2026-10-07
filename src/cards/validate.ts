// data/cards.json（unknown）を検証して Card[] に絞り込む。
// 外部ライブラリを使わず手書きで検証する。エラーはまとめて報告する。

import {
  CARD_SETS,
  CARD_TYPES,
  CLASS_IDS,
  RARITIES,
  type Card,
  type Crest,
} from "./types";

export class CardValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`カードデータの検証に失敗しました (${problems.length}件):\n${problems.join("\n")}`);
    this.name = "CardValidationError";
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function checkCard(raw: unknown, where: string, problems: string[]): void {
  const p = (msg: string) => problems.push(`${where}: ${msg}`);
  if (!isObj(raw)) {
    p("オブジェクトではありません");
    return;
  }
  for (const key of ["id", "name", "text"]) {
    if (typeof raw[key] !== "string") p(`${key} は文字列が必要です`);
  }
  if (raw.id === "") p("id が空です");
  if (raw.name === "") p("name が空です");
  if (!isOneOf(CLASS_IDS, raw.class)) p(`class が不正です: ${String(raw.class)}`);
  if (!isOneOf(CARD_SETS, raw.set)) p(`set が不正です: ${String(raw.set)}`);
  if (!isOneOf(CARD_TYPES, raw.type)) p(`type が不正です: ${String(raw.type)}`);
  if (!isOneOf(RARITIES, raw.rarity)) p(`rarity が不正です: ${String(raw.rarity)}`);
  if (!isNonNegInt(raw.cost)) p("cost は0以上の整数が必要です");
  if (raw.tribes !== null && !isStringArray(raw.tribes)) p("tribes は文字列の配列か null が必要です");
  if (!isStringArray(raw.related)) p("related は文字列の配列が必要です");
  if (raw.starterAbilityChanged !== undefined && raw.starterAbilityChanged !== true) {
    p("starterAbilityChanged は true か省略が必要です");
  }

  if (raw.crest !== undefined && (typeof raw.crest !== "string" || raw.crest === "")) {
    p("crest は空でない文字列か省略が必要です");
  }

  const isFollower = raw.type === "follower";
  for (const key of ["attack", "defense"]) {
    if (isFollower && !isNonNegInt(raw[key])) p(`フォロワーは ${key} に0以上の整数が必要です`);
    if (!isFollower && key in raw) p(`フォロワー以外に ${key} は持てません`);
  }
  if ("countdown" in raw) {
    if (raw.type !== "amulet") p("アミュレット以外に countdown は持てません");
    else if (!isNonNegInt(raw.countdown) || raw.countdown === 0) {
      p("countdown は1以上の整数が必要です");
    }
  }
}

export function validateCards(data: unknown): Card[] {
  const problems: string[] = [];
  if (!Array.isArray(data)) throw new CardValidationError(["ルートは配列が必要です"]);

  const ids = new Set<string>();
  data.forEach((raw, i) => {
    const label = isObj(raw) && typeof raw.id === "string" ? `[${i}] ${raw.id}` : `[${i}]`;
    checkCard(raw, label, problems);
    if (isObj(raw) && typeof raw.id === "string") {
      if (ids.has(raw.id)) problems.push(`${label}: id が重複しています`);
      ids.add(raw.id);
    }
  });

  // 参照先のカードが存在すること
  for (const raw of data) {
    if (!isObj(raw) || !isStringArray(raw.related)) continue;
    for (const ref of raw.related) {
      if (!ids.has(ref)) problems.push(`${String(raw.id)}: related の ${ref} が存在しません`);
    }
  }

  if (problems.length > 0) throw new CardValidationError(problems);
  // 上で全フィールドを検証済み
  return data as Card[];
}

/** data/crests.json を検証する。cards は検証済みのカード。 */
export function validateCrests(data: unknown, cards: readonly Card[]): Crest[] {
  const problems: string[] = [];
  if (!Array.isArray(data)) throw new CardValidationError(["クレスト: ルートは配列が必要です"]);

  const cardIds = new Set(cards.map((c) => c.id));
  const crestIds = new Set<string>();
  data.forEach((raw, i) => {
    const where = isObj(raw) && typeof raw.id === "string" ? `クレスト[${i}] ${raw.id}` : `クレスト[${i}]`;
    const p = (msg: string) => problems.push(`${where}: ${msg}`);
    if (!isObj(raw)) {
      p("オブジェクトではありません");
      return;
    }
    for (const key of ["id", "name", "source", "text"]) {
      if (typeof raw[key] !== "string" || raw[key] === "") p(`${key} は空でない文字列が必要です`);
    }
    if (typeof raw.source === "string" && !cardIds.has(raw.source)) {
      p(`source のカード ${raw.source} が存在しません`);
    }
    if (raw.countdown !== undefined && (!isNonNegInt(raw.countdown) || raw.countdown === 0)) {
      p("countdown は1以上の整数が必要です");
    }
    if (typeof raw.id === "string") {
      if (crestIds.has(raw.id)) p("id が重複しています");
      crestIds.add(raw.id);
    }
  });
  for (const card of cards) {
    if (card.crest !== undefined && !crestIds.has(card.crest)) {
      problems.push(`${card.id}: crest の ${card.crest} が存在しません`);
    }
  }

  if (problems.length > 0) throw new CardValidationError(problems);
  return data as Crest[];
}
