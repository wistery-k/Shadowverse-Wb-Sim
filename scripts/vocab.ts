// 補正（data/value-net.json）・見込み（data/potential-net.json）のモデルの語彙（入力のカード・クレストの ID の並び）を広げる範囲。
// npm run td -- extend --vocab <範囲> と npm run td -- vocab が使う（docs/pools/azvaldt.md「段取り」の段階 4 の下ごしらえ）。
//
// 範囲の書き方:
// - keep: モデルの語彙のまま（既定）
// - starter: スターターのカードとクレスト（npm run td -- init の語彙。今のモデルの語彙）
// - pool: エンジンのカードの表の全部（スターター・前期のローテーションのカード・トークン・アクセラレート・結晶の姿と、クレスト・信仰）
// - @<デッキの組>: その組（data/pools/azvaldt/sets/ のファイル。1 行に 1 つのデッキのファイル）のデッキのカードと、そこから出うるもの
//   （能力の定義が ID で名指すカード・クレスト、公式データの関連カード（related）、アクセラレート・結晶の姿、信仰、そのカードが出すクレスト、
//   エンジンが出すトークン（土の印を足す能力の大地の魔片））を、名指しをたどって閉じたもの
//
// 広げるときは、モデルの今の語彙の後ろに、範囲のうち語彙に無いものをエンジンの表の順（カード → クレスト）で足す（今の行は動かさない）。
// 推論（rust/engine/src/ai/valuenet.rs・potential.rs）は語彙を ID でカードの表に結ぶので、並びの順は問わない。

import { readFileSync } from "node:fs";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";
import { AZVALDT_CARD_ABILITIES, AZVALDT_CREST_ABILITIES } from "../src/cards/abilities/azvaldt";
import { ALT_PLAY_OF, AZVALDT_CARDS, ENGINE_CARDS, ENGINE_CRESTS, FAITH_OF } from "../src/cards/pools";
import { defaultVocab } from "./valueNet";

const CREST_PREFIX = "crest:";
/** 【土の印】を足す能力（op addSigils）で、場に土の印が無ければエンジンが出すトークン（rust/engine/src/effects.rs の AddSigils） */
const EARTH_SIGIL_TOKEN = "90031210";

/** 能力の定義が名指すカード・クレストの ID（JSON の中の数字の文字列のうち、表にあるもの） */
function namedIds(def: unknown): string[] {
  if (def === undefined) return [];
  const json = JSON.stringify(def);
  const ids = [...json.matchAll(/"(\d{6,12})"/g)].map((m) => m[1]!);
  if (json.includes('"op":"addSigils"')) ids.push(EARTH_SIGIL_TOKEN);
  return ids;
}

/** デッキのファイル（data/pools/azvaldt/decks/ の形。「枚数 カード名」の行）のカードの ID */
export function deckFileCards(text: string, path = "デッキ"): string[] {
  const byName = new Map(AZVALDT_CARDS.filter((c) => c.set !== "token").map((c) => [c.name, c.id]));
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const id = byName.get(m[2]!.trim());
    if (!id) throw new Error(`${path}: カードがありません: ${m[2]}`);
    out.push(id);
  }
  return out;
}

/** デッキの組のファイル（1 行に 1 つのデッキのファイルのパス。空の行と # の行は飛ばす）のデッキのカードの ID（重なりなし） */
export function deckSetCards(path: string): string[] {
  const out = new Set<string>();
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    for (const id of deckFileCards(readFileSync(line, "utf8"), line)) out.add(id);
  }
  return [...out];
}

/** カード cards から出うるカード・クレストを、名指しをたどって閉じたもの（vocab の形。クレストは "crest:" を付ける）。エンジンの表の順 */
export function reachableVocab(cards: Iterable<string>): string[] {
  const cardById = new Map(ENGINE_CARDS.map((c) => [c.id, c]));
  const cardIds = new Set(cardById.keys());
  const crestIds = new Set(ENGINE_CRESTS.map((c) => c.id));
  const seenCards = new Set<string>();
  const seenCrests = new Set<string>();
  const todo: [kind: "card" | "crest", id: string][] = [...cards].map((id) => ["card", id]);
  const visit = (id: string): void => {
    // 同じ文字列がカードとクレストの両方の ID のことがあるので、両方を見る
    if (cardIds.has(id) && !seenCards.has(id)) todo.push(["card", id]);
    if (crestIds.has(id) && !seenCrests.has(id)) todo.push(["crest", id]);
  };
  while (todo.length > 0) {
    const [kind, id] = todo.pop()!;
    if (kind === "card") {
      if (seenCards.has(id)) continue;
      if (!cardIds.has(id)) throw new Error(`カードの表にありません: ${id}`);
      seenCards.add(id);
      for (const x of namedIds(AZVALDT_CARD_ABILITIES[id] ?? CARD_ABILITIES[id])) visit(x);
      for (const x of cardById.get(id)!.related) visit(x);
      const alt = ALT_PLAY_OF.get(id);
      if (alt !== undefined) visit(alt);
      const faith = FAITH_OF.get(id);
      if (faith !== undefined && !seenCrests.has(faith)) todo.push(["crest", faith]);
    } else {
      if (seenCrests.has(id)) continue;
      seenCrests.add(id);
      for (const x of namedIds(AZVALDT_CREST_ABILITIES[id] ?? CREST_ABILITIES[id])) visit(x);
    }
    // 出たカードが元になるクレスト（クレストの source）
    if (kind === "card") for (const c of ENGINE_CRESTS) if (c.source === id && !seenCrests.has(c.id)) todo.push(["crest", c.id]);
  }
  return [
    ...ENGINE_CARDS.filter((c) => seenCards.has(c.id)).map((c) => c.id),
    ...ENGINE_CRESTS.filter((c) => seenCrests.has(c.id)).map((c) => `${CREST_PREFIX}${c.id}`),
  ];
}

/** 範囲 spec の語彙（keep なら null） */
export function vocabRange(spec: string): string[] | null {
  if (spec === "keep") return null;
  if (spec === "starter") return defaultVocab();
  if (spec === "pool") return [...ENGINE_CARDS.map((c) => c.id), ...ENGINE_CRESTS.map((c) => `${CREST_PREFIX}${c.id}`)];
  if (spec.startsWith("@")) return reachableVocab(deckSetCards(spec.slice(1)));
  throw new Error(`--vocab は keep・starter・pool・@<デッキの組> のどれか: ${spec}`);
}

/** 語彙 base の後ろに、range のうち base に無いものを足したもの */
export function widenVocab(base: readonly string[], range: readonly string[] | null): string[] {
  if (!range) return [...base];
  const have = new Set(base);
  return [...base, ...range.filter((id) => !have.has(id))];
}
