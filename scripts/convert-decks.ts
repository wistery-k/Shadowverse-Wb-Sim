// 大会のデッキリスト（シャドラボ svlabo.jp の記事が読み込むデータファイル）を、カードプールのデッキのテキストに変換する。
// 使い方: npm run decks
//   data/raw/decks/svlabo/ の cardlist_*.js（カードの表）と下の EVENTS のファイル（大会のデッキ）を読み、
//   data/pools/azvaldt/decks/<大会>/<チーム>_<クラス>.txt に書く（形式は data/decks/README.md と同じ）。
//
// 元データはコミットしない（data/raw/ は .gitignore 対象）。取り出し方と、使ってよい大会の決まりは docs/pools/azvaldt.md「プロのデッキ」。
// データファイルは JavaScript なので実行せず、配列の文字列と JSON だけを読む。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, ClassId } from "../src/cards/types";

interface EventConfig {
  /** 出力のディレクトリ名 */
  key: string;
  label: string;
  /** 開催日（データファイルの名前の日付） */
  date: string;
  /** 記事（デッキリスト比較） */
  url: string;
  /** data/raw/decks/svlabo/ のデータファイル */
  file: string;
}

/**
 * 前期のローテーションの能力調整（2026-09-29）より後で、第10弾より前の大会（ユーザー確認 2026-11-13）。
 * プレミアシリーズは第8節後半・第9節前半・第9節後半。どれもチーム戦で、出場した 4 チームの 7 クラスずつのデッキ。
 */
const EVENTS: readonly EventConfig[] = [
  {
    key: "ps26-27-08b",
    label: "Premier Series 26-27 第8節 後半戦",
    date: "2026-10-06",
    url: "https://svlabo.jp/blog-entry-1959.html",
    file: "elmfin_261006_2.js",
  },
  {
    key: "ps26-27-09a",
    label: "Premier Series 26-27 第9節 前半戦",
    date: "2026-10-13",
    url: "https://svlabo.jp/blog-entry-1968.html",
    file: "elmfin_261013_1.js",
  },
  {
    key: "ps26-27-09b",
    label: "Premier Series 26-27 第9節 後半戦",
    date: "2026-10-20",
    url: "https://svlabo.jp/blog-entry-1979.html",
    file: "elmfin_261020_1.js",
  },
];

const RAW_DIR = "data/raw/decks/svlabo";
const CARDS_FILE = "data/pools/azvaldt/cards.json";
const OUT_DIR = "data/pools/azvaldt/decks";

/** サイトのクラス番号 → クラスと、デッキのテキストに書くクラスの名前（src/cards/types.ts の CLASS_NAMES と同じ） */
const CLASS_BY_NO: Record<number, { id: ClassId; name: string }> = {
  1: { id: "elf", name: "エルフ" },
  2: { id: "royal", name: "ロイヤル" },
  3: { id: "witch", name: "ウィッチ" },
  4: { id: "dragon", name: "ドラゴン" },
  5: { id: "nightmare", name: "ナイトメア" },
  6: { id: "bishop", name: "ビショップ" },
  7: { id: "nemesis", name: "ネメシス" },
};

/**
 * カードの表に無い符号。ストームブラストは第1弾の ID（10131320）の符号がカードの表で再録の ID（10831310）に当ててあり、
 * 再録の ID の符号はカードの表に無い。同じ大会のデッキリストの記事用のファイル（elmfin_261006_2.js）では、
 * 分布の記事用のファイル（elmfin_261006_1.js）の fKNE が cfTu に直っている。
 */
const EXTRA_CODES: Record<string, string> = { fKNE: "10831310" };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** `const <name> = ['a', 'b', ...];` の文字列の配列を読む（コードは実行しない） */
function readStringArray(source: string, name: string): string[] {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(source);
  if (!m) fail(`カードの表に ${name} がありません`);
  return [...(m[1] ?? "").matchAll(/'([^']*)'/g)].map((x) => x[1] ?? "");
}

interface RawDeck {
  class_no: number;
  deck_code: string;
  deck_name: string;
}
interface RawTeam {
  team: string;
  deck: RawDeck[];
}

function isRawTeams(value: unknown): value is RawTeam[] {
  return (
    Array.isArray(value) &&
    value.every(
      (t: unknown) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { team?: unknown }).team === "string" &&
        Array.isArray((t as { deck?: unknown }).deck) &&
        ((t as { deck: unknown[] }).deck).every(
          (d: unknown) =>
            typeof d === "object" &&
            d !== null &&
            typeof (d as { class_no?: unknown }).class_no === "number" &&
            typeof (d as { deck_code?: unknown }).deck_code === "string" &&
            typeof (d as { deck_name?: unknown }).deck_name === "string",
        ),
    )
  );
}

function readTeams(path: string): RawTeam[] {
  const source = readFileSync(path, "utf8").replace(/^﻿/, "");
  const m = /const\s+tour_info\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(source);
  if (!m) fail(`${path}: tour_info がありません`);
  const value: unknown = JSON.parse(m[1] ?? "");
  if (!isRawTeams(value)) fail(`${path}: tour_info の形が違います`);
  return value;
}

function main(): void {
  if (!existsSync(RAW_DIR)) fail(`${RAW_DIR} がありません（docs/pools/azvaldt.md「プロのデッキ」）`);
  const cardlistFiles = readdirSync(RAW_DIR)
    .filter((f) => /^cardlist_\d+\.js$/.test(f))
    .sort();
  const cardlistFile = cardlistFiles.at(-1);
  if (!cardlistFile) fail(`${RAW_DIR} にカードの表（cardlist_*.js）がありません`);
  const cardlist = readFileSync(join(RAW_DIR, cardlistFile), "utf8");
  const codes = readStringArray(cardlist, "cardids");
  const ids = readStringArray(cardlist, "cardnos");
  if (codes.length !== ids.length || codes.length === 0) fail("カードの表の cardids と cardnos の長さが違います");
  const idByCode = new Map<string, string>(codes.map((c, i) => [c, ids[i] ?? ""]));
  for (const [code, id] of Object.entries(EXTRA_CODES)) {
    if (idByCode.has(code)) fail(`符号 ${code} はカードの表にあるので、EXTRA_CODES から消してください`);
    idByCode.set(code, id);
  }

  const cards = JSON.parse(readFileSync(CARDS_FILE, "utf8")) as Card[];
  const cardById = new Map(cards.map((c) => [c.id, c]));

  const errors: string[] = [];
  let written = 0;
  for (const event of EVENTS) {
    const teams = readTeams(join(RAW_DIR, event.file));
    const dir = join(OUT_DIR, event.key);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const team of teams) {
      for (const deck of team.deck) {
        const where = `${event.key} ${team.team} ${deck.deck_name}`;
        const cls = CLASS_BY_NO[deck.class_no];
        if (!cls) {
          errors.push(`${where}: 不明なクラス番号 ${deck.class_no}`);
          continue;
        }
        const counts = new Map<string, number>();
        for (const code of deck.deck_code.split(".").filter((c) => c !== "")) {
          const id = idByCode.get(code);
          const card = id === undefined ? undefined : cardById.get(id);
          if (!card) {
            errors.push(`${where}: 符号 ${code}（ID ${id ?? "不明"}）がプールのカードにありません`);
            continue;
          }
          if (card.set === "token") errors.push(`${where}: トークン ${card.name}`);
          if (card.class !== "neutral" && card.class !== cls.id) errors.push(`${where}: 別のクラスのカード ${card.name}`);
          counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
        }
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        if (total !== 40) errors.push(`${where}: ${total} 枚`);
        for (const [id, n] of counts) if (n > 3) errors.push(`${where}: ${cardById.get(id)?.name} が ${n} 枚`);

        const rows = [...counts]
          .map(([id, n]) => ({ card: cardById.get(id) as Card, n }))
          .sort((a, b) => a.card.cost - b.card.cost || a.card.id.localeCompare(b.card.id));
        const text = [
          `# ${event.label}（${event.date}）チーム ${team.team}`,
          `# 出典: ${event.url}（npm run decks で変換）`,
          `名前: ${deck.deck_name}（${team.team}）`,
          `クラス: ${cls.name}`,
          ...rows.map(({ card, n }) => `${n} ${card.name}`),
          "",
        ].join("\n");
        const path = join(dir, `${team.team}_${cls.name}.txt`);
        if (existsSync(path)) errors.push(`${where}: 同じチーム・クラスのデッキが 2 つあります`);
        writeFileSync(path, text);
        written++;
      }
    }
  }
  if (errors.length > 0) fail(`デッキの変換に失敗しました:\n${errors.join("\n")}`);
  console.log(`${written} 個のデッキを ${OUT_DIR}/ に書きました（${EVENTS.length} 大会）`);
}

main();
