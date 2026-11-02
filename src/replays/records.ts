// 記録した試合のファイルの読み方（JSON Lines か JSON。中身の形は src/replays/types.ts の ReplayRecord）。
// 1 行（JSON なら全体）がオブジェクトなら 1 試合、配列なら試合の並びとして読む。試合でない値（自己対戦の学習用の行など）は数えて飛ばす。

import { CARDS_BY_ID, CLASS_NAMES, type ClassId } from "../cards";
import { DEFAULT_DECKS } from "../cards/defaultDecks";
import type { Action, PlayerIndex } from "../engine";
import type { ReplayRecord } from "./types";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const pair = <T>(v: unknown, f: (x: unknown) => x is T): [T, T] | null => (Array.isArray(v) && v.length === 2 && f(v[0]) && f(v[1]) ? [v[0], v[1]] : null);

/** デッキのクラス（ニュートラル以外の最初のカードのクラス） */
export function deckClass(cards: readonly string[]): ClassId {
  for (const id of cards) {
    const cls = CARDS_BY_ID.get(id)?.class;
    if (cls && cls !== "neutral") return cls;
  }
  return "neutral";
}

/** デッキの名前: 並びまで同じデフォルトデッキの名前か、「（クラス名）デッキ」 */
export function deckName(cards: readonly string[]): string {
  const d = DEFAULT_DECKS.find((x) => x.cards.length === cards.length && x.cards.every((id, i) => id === cards[i]));
  return d ? d.name : `${CLASS_NAMES[deckClass(cards)]}デッキ`;
}

/**
 * 値が試合の記録ならそれを、そうでなければ null（試合でない値）を返す。
 * 試合の形（seed・decks・actions がある）なのに読めないときはエラーを投げる
 */
export function toReplayRecord(v: unknown): ReplayRecord | null {
  if (!isObject(v) || !("actions" in v) || !("seed" in v) || !("decks" in v)) return null;
  const { seed, actions, winner, agents, names, source, g } = v;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) throw new Error(`seed が 0 以上の整数ではありません: ${String(seed)}`);
  const decks = pair(v.decks, isStrings);
  if (!decks) throw new Error("decks がカードIDの列 2 つではありません");
  for (const id of [...decks[0], ...decks[1]]) if (!CARDS_BY_ID.has(id)) throw new Error(`未知のカードID: ${id}`);
  if (!Array.isArray(actions) || !actions.every((a) => isObject(a) && typeof a.type === "string")) throw new Error("actions が行動の列ではありません");
  const record: ReplayRecord = {
    seed,
    decks,
    // 行動の中身はエンジンが打ち直すときに確かめる
    actions: actions as Action[],
    agents: pair(agents, (x): x is string => typeof x === "string") ?? ["", ""],
    names: pair(names, (x): x is string => typeof x === "string") ?? [deckName(decks[0]), deckName(decks[1])],
    winner: winner === 0 || winner === 1 ? (winner as PlayerIndex) : null,
  };
  if (typeof source === "string") record.source = source;
  if (typeof g === "number") record.g = g;
  return record;
}

export interface ParsedTexts {
  /** 読めた試合と、その行番号・行の中の配列の添字 */
  records: { record: ReplayRecord; line: number; sub: number }[];
  /** 試合でない値の数 */
  skipped: number;
  /** 読めなかったもの（最初のいくつか） */
  errors: string[];
  failed: number;
}

/** JSON の文字列の並び（JSON Lines の各行、または JSON ファイル全体）から試合を読む。first は最初の文字列の行番号（エラーの表示用） */
export function parseReplayTexts(texts: readonly string[], first = 1, maxErrors = 5): ParsedTexts {
  const out: ParsedTexts = { records: [], skipped: 0, errors: [], failed: 0 };
  const fail = (line: number, e: unknown) => {
    out.failed++;
    if (out.errors.length < maxErrors) out.errors.push(`${line} 行目: ${e instanceof Error ? e.message : String(e)}`);
  };
  texts.forEach((text, k) => {
    if (text.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (e) {
      fail(first + k, e);
      return;
    }
    (Array.isArray(v) ? v : [v]).forEach((x: unknown, sub) => {
      try {
        const record = toReplayRecord(x);
        if (record) out.records.push({ record, line: first + k, sub });
        else out.skipped++;
      } catch (e) {
        fail(first + k, e);
      }
    });
  });
  return out;
}

/** ファイルの中身を、JSON の文字列の並びに分ける（.jsonl は行ごと、それ以外は全体で 1 つ） */
export function splitReplayText(name: string, text: string): string[] {
  return /\.jsonl(\.gz)?$/i.test(name) ? text.split("\n") : [text];
}
