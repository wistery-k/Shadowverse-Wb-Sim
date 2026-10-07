// data/cards.json（unknown）を検証して Card[] に絞り込む。
// 外部ライブラリを使わず手書きで検証する。エラーはまとめて報告する。

import {
  CARD_SETS,
  CARD_TYPES,
  CLASS_IDS,
  RARITIES,
  type Card,
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

const FOLLOWER_ONLY_KEYS = ["attack", "defense", "evolvedAttack", "evolvedDefense", "evolvedText"];

function checkCard(raw: unknown, where: string, problems: string[]): void {
  const p = (msg: string) => problems.push(`${where}: ${msg}`);
  if (!isObj(raw)) {
    p("オブジェクトではありません");
    return;
  }
  for (const key of ["id", "name", "text", "source"]) {
    if (typeof raw[key] !== "string") p(`${key} は文字列が必要です`);
  }
  if (typeof raw.id === "string" && raw.id === "") p("id が空です");
  if (typeof raw.name === "string" && raw.name === "") p("name が空です");
  if (!isOneOf(CLASS_IDS, raw.class)) p(`class が不正です: ${String(raw.class)}`);
  if (!isOneOf(CARD_SETS, raw.set)) p(`set が不正です: ${String(raw.set)}`);
  if (!isOneOf(CARD_TYPES, raw.type)) p(`type が不正です: ${String(raw.type)}`);
  if (raw.rarity !== undefined && !isOneOf(RARITIES, raw.rarity)) {
    p(`rarity が不正です: ${String(raw.rarity)}`);
  }
  if (raw.rarity === undefined && raw.set !== "token") p("トークン以外は rarity が必要です");
  if (!isNonNegInt(raw.cost)) p("cost は0以上の整数が必要です");
  if (!Array.isArray(raw.tribes) || !raw.tribes.every((t) => typeof t === "string")) {
    p("tribes は文字列の配列が必要です");
  }
  if (typeof raw.verified !== "boolean") p("verified は真偽値が必要です");
  if (raw.needsOriginalText !== undefined && typeof raw.needsOriginalText !== "boolean") {
    p("needsOriginalText は真偽値が必要です");
  }

  if (raw.type === "follower") {
    for (const key of ["attack", "defense", "evolvedAttack", "evolvedDefense"]) {
      if (!isNonNegInt(raw[key])) p(`フォロワーは ${key} に0以上の整数が必要です`);
    }
    if (typeof raw.evolvedText !== "string") p("フォロワーは evolvedText に文字列が必要です");
  } else {
    for (const key of FOLLOWER_ONLY_KEYS) {
      if (key in raw) p(`フォロワー以外に ${key} は持てません`);
    }
  }
}

export function validateCards(data: unknown): Card[] {
  const problems: string[] = [];
  if (!Array.isArray(data)) throw new CardValidationError(["ルートは配列が必要です"]);

  const seen = new Set<string>();
  data.forEach((raw, i) => {
    const label = isObj(raw) && typeof raw.id === "string" ? `[${i}] ${raw.id}` : `[${i}]`;
    checkCard(raw, label, problems);
    if (isObj(raw) && typeof raw.id === "string") {
      if (seen.has(raw.id)) problems.push(`${label}: id が重複しています`);
      seen.add(raw.id);
    }
  });

  if (problems.length > 0) throw new CardValidationError(problems);
  // 上で全フィールドを検証済み
  return data as Card[];
}
