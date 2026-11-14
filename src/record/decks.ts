// 試合の記録で選べるデッキ: 取り込んだプロのデッキ（data/pools/azvaldt/decks/<大会>/<チーム>_<クラス>.txt。npm run decks で変換）だけ。
// 貼り付け・自作のデッキ・デッキの編集は付けない（CLAUDE.md「決定済みの前提」の試合の記録の条件）。

import { CLASS_IDS, CLASS_NAMES, type ClassId } from "../cards/types";
import { POOL_CARD_BY_NAME } from "./pool";

const files = import.meta.glob<string>("../../data/pools/azvaldt/decks/*/*.txt", { query: "?raw", import: "default", eager: true });

/** プロのデッキ 1 つ */
export interface ProDeck {
  /** `<大会>/<チーム>_<クラス>`（記録に書く ID） */
  id: string;
  event: string;
  team: string;
  cls: ClassId;
  /** デッキの名前（サイトの呼び名。例: スペルW（CR）） */
  name: string;
  /** カード ID（40 枚。ファイルの行の順） */
  cards: string[];
}

/** 大会 */
export interface ProEvent {
  /** フォルダの名前（例: ps26-27-08b） */
  id: string;
  /** 大会の名前（例: Premier Series 26-27 第8節 後半戦） */
  name: string;
  /** 日付（YYYY-MM-DD） */
  date: string;
  /** チーム（ファイルの名前の順） */
  teams: string[];
}

const CLASS_BY_NAME = new Map<string, ClassId>(CLASS_IDS.map((id) => [CLASS_NAMES[id], id]));

function parseDeck(path: string, text: string): { deck: ProDeck; eventName: string; date: string } {
  const m = /decks\/([^/]+)\/([^/_]+)_([^/]+)\.txt$/.exec(path);
  if (!m) throw new Error(`プロのデッキのファイルの名前が読めません: ${path}`);
  const [, event = "", team = "", className = ""] = m;
  const cls = CLASS_BY_NAME.get(className);
  if (!cls) throw new Error(`${path}: クラスが読めません`);
  let name = `${team}_${className}`;
  let eventName = event;
  let date = "";
  const cards: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const head = /^#\s*(.+?)（(\d{4}-\d{2}-\d{2})）/.exec(line);
    if (head) {
      eventName = head[1] ?? event;
      date = head[2] ?? "";
      continue;
    }
    if (line.startsWith("#") || line.startsWith("クラス")) continue;
    const named = /^名前\s*[:：]\s*(.*)$/.exec(line);
    if (named) {
      name = named[1] ?? name;
      continue;
    }
    const row = /^(\d+)\s+(.+)$/.exec(line);
    const card = row ? POOL_CARD_BY_NAME.get(row[2] ?? "") : undefined;
    if (!row || !card) throw new Error(`${path}: 読めない行: ${line}`);
    for (let i = 0; i < Number(row[1]); i++) cards.push(card.id);
  }
  return { deck: { id: `${event}/${team}_${className}`, event, team, cls, name, cards }, eventName, date };
}

function load(): { decks: ProDeck[]; events: ProEvent[] } {
  const decks: ProDeck[] = [];
  const events = new Map<string, ProEvent>();
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const { deck, eventName, date } = parseDeck(path, text);
    decks.push(deck);
    const ev = events.get(deck.event) ?? { id: deck.event, name: eventName, date, teams: [] };
    if (!ev.teams.includes(deck.team)) ev.teams.push(deck.team);
    events.set(deck.event, ev);
  }
  return { decks, events: [...events.values()] };
}

const loaded = load();

export const PRO_DECKS: readonly ProDeck[] = loaded.decks;
export const PRO_EVENTS: readonly ProEvent[] = loaded.events;
const BY_ID = new Map(PRO_DECKS.map((d) => [d.id, d]));

export const proDeck = (id: string): ProDeck | undefined => BY_ID.get(id);

/** 大会・チーム・クラスのデッキ */
export const findProDeck = (event: string, team: string, cls: ClassId): ProDeck | undefined =>
  PRO_DECKS.find((d) => d.event === event && d.team === team && d.cls === cls);
