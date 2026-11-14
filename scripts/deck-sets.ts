// 前期のローテーションのプロのデッキ（data/pools/azvaldt/decks/）から、比べと調査に使うデッキの組のファイルを書く。
//
//   npm run deck-sets
//
// 書くもの（data/pools/azvaldt/sets/。compare・td selfplay・survey・profile の --decks @<ファイル> で使う）:
// - rep10.txt: 10 型の代表（型ごとに 1 個）。型はデッキの名前（サイトの呼び名）の「（」より前。
//   代表は、いちばん新しい大会のその型のデッキのうち、その型の中心のカード（その型の半分以上のデッキに入るカード）を
//   いちばん多く含むもの（種類で数える。同じならファイル名の順で先のもの）。その大会にその型が無ければ、1 つ前の大会から選ぶ
// - all84.txt: 84 個全部（大会・ファイル名の順）
//
// デッキのファイルを変えたら回し直す。tests/deck-sets.test.ts が、書いたファイルがデッキのファイルと合うかを確かめる。

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DECK_DIR = "data/pools/azvaldt/decks";
const SET_DIR = "data/pools/azvaldt/sets";

export interface DeckFile {
  /** リポジトリの根からのパス（data/pools/azvaldt/decks/<大会>/<ファイル>） */
  path: string;
  text: string;
}

interface Parsed {
  path: string;
  /** 大会のフォルダの名前（ps26-27-09b 等。名前の順が日付の順） */
  event: string;
  name: string;
  archetype: string;
  cards: Set<string>;
}

function parse(f: DeckFile): Parsed {
  const parts = f.path.split("/");
  const event = parts.at(-2) ?? "";
  let name = "";
  const cards = new Set<string>();
  for (const raw of f.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const meta = /^名前\s*[:：]\s*(.*)$/.exec(line);
    if (meta) {
      name = meta[1] ?? "";
      continue;
    }
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (m) cards.add(m[2] ?? "");
  }
  if (name === "") throw new Error(`${f.path}: 名前がありません`);
  const archetype = name.split("（")[0] ?? name;
  return { path: f.path, event, name, archetype, cards };
}

export interface DeckSets {
  /** 型ごとの代表（型の名前の順ではなく、代表のファイルの順） */
  representatives: { archetype: string; path: string; name: string; core: number; coreOf: number; decks: number }[];
  all: string[];
  rep10: string;
  all84: string;
}

/** デッキのファイルから、デッキの組のファイルの中身を作る */
export function deckSets(files: DeckFile[]): DeckSets {
  const decks = files.map(parse).sort((a, b) => a.path.localeCompare(b.path));
  const byType = new Map<string, Parsed[]>();
  for (const d of decks) byType.set(d.archetype, [...(byType.get(d.archetype) ?? []), d]);
  const representatives: DeckSets["representatives"] = [];
  for (const [archetype, list] of byType) {
    // 中心のカード: その型の半分以上のデッキに入るカード
    const count = new Map<string, number>();
    for (const d of list) for (const c of d.cards) count.set(c, (count.get(c) ?? 0) + 1);
    const core = [...count].filter(([, n]) => n * 2 >= list.length).map(([c]) => c);
    const newest = list.map((d) => d.event).sort().at(-1) ?? "";
    let best: Parsed | undefined;
    let bestCore = -1;
    for (const d of list.filter((x) => x.event === newest)) {
      const n = core.filter((c) => d.cards.has(c)).length;
      if (n > bestCore) {
        best = d;
        bestCore = n;
      }
    }
    if (!best) throw new Error(`${archetype}: デッキがありません`);
    representatives.push({ archetype, path: best.path, name: best.name, core: bestCore, coreOf: core.length, decks: list.length });
  }
  representatives.sort((a, b) => a.path.localeCompare(b.path));
  const all = decks.map((d) => d.path);
  const header = (lines: string[]) => lines.map((l) => `# ${l}`).join("\n");
  const rep10 = [
    header([
      `10 型の代表（npm run deck-sets で書く。scripts/deck-sets.ts）`,
      `型ごとに、いちばん新しい大会のその型のデッキのうち、その型の中心のカード（その型の半分以上のデッキに入るカード）を`,
      `いちばん多く含むもの（種類で数える。同じならファイル名の順で先のもの）。行の後ろの注は、型・中心のカードを何種含むか・その型のデッキの数`,
    ]),
    ...representatives.map((r) => `${r.path}\n# ↑ ${r.archetype}: 中心のカード ${r.core}/${r.coreOf}、${r.decks} 個から`),
    "",
  ].join("\n");
  const all84 = [header([`プロのデッキ ${all.length} 個全部（npm run deck-sets で書く。大会・ファイル名の順）`]), ...all, ""].join("\n");
  return { representatives, all, rep10, all84 };
}

function main(): void {
  const files: DeckFile[] = [];
  for (const event of readdirSync(DECK_DIR).sort()) {
    for (const f of readdirSync(join(DECK_DIR, event)).sort()) {
      if (!f.endsWith(".txt")) continue;
      const path = `${DECK_DIR}/${event}/${f}`;
      files.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  const sets = deckSets(files);
  mkdirSync(SET_DIR, { recursive: true });
  writeFileSync(join(SET_DIR, "rep10.txt"), sets.rep10);
  writeFileSync(join(SET_DIR, "all84.txt"), sets.all84);
  for (const r of sets.representatives) console.log(`${r.archetype}: ${r.name}（${r.path}、中心のカード ${r.core}/${r.coreOf}）`);
  console.log(`${SET_DIR}/rep10.txt（${sets.representatives.length} 個）と all84.txt（${sets.all.length} 個）を書きました`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
