// 試合の URL（AI対戦のリプレイ画面の固有の URL。ユーザーの依頼 2026-11-20）。
//
// URL が持つのは seed と、両方の席の AI とデッキだけ（`#game?seed=…&p0=<AI>&d0=<デッキ>&p1=<AI>&d1=<デッキ>`）。
// ページを開くと、その試合をそのページの今の版のエンジンと AI で打ち直してリプレイを開く。
// 版（コミット）が違えば手も変わりうる（ユーザー了承 2026-11-20。同じ版なら同じ試合になる）。
// 局面は持たない（実際の対戦の局面を入れて AI の手を聞けないように。CLAUDE.md「ソフト打ち」）。
// デッキの書き方はページごと（アズヴォルト環境のページは取り込んだプロのデッキの ID だけ。src/azvaldt/decks.ts）。

import { CARDS_BY_ID, CLASS_NAMES, STARTER, deckProblems, type Card } from "../cards";
import { DEFAULT_DECKS } from "../cards/defaultDecks";
import { deckArg, parseDeckArg } from "./reproduce";
import type { Entrant, GameRecord } from "./tournament";

export interface GameLink {
  seed: number;
  /** 席 0・1 の AI（src/ai/registry.ts のキー） */
  agents: [string, string];
  /** 席 0・1 のデッキ（ページの LinkDecks で書いた文字列） */
  decks: [string, string];
}

/** 試合の URL のデッキの書き方（ページごと） */
export interface LinkDecks {
  /** デッキ（カードの並び。並びも山札の混ぜ方に効く）を URL の文字列にする。このページで書けないデッキなら null */
  encode(cards: readonly string[]): string | null;
  /** URL の文字列をデッキにする。このページで使えないデッキなら理由の文 */
  decode(param: string): { cards: string[]; label: string } | string;
}

const PREFIX = "#game?";

/** URL の # 以降が試合の URL か */
export const isGameHash = (hash: string = typeof location === "undefined" ? "" : location.hash): boolean => hash.startsWith(PREFIX);

/** 試合の URL の # 以降 */
export function gameHash(link: GameLink): string {
  const q = new URLSearchParams({
    seed: String(link.seed),
    p0: link.agents[0],
    d0: link.decks[0],
    p1: link.agents[1],
    d1: link.decks[1],
  });
  return PREFIX + q.toString();
}

/** 試合の URL の # 以降を読む。読めなければ null */
export function parseGameHash(hash: string): GameLink | null {
  if (!isGameHash(hash)) return null;
  const q = new URLSearchParams(hash.slice(PREFIX.length));
  const get = (key: string) => q.get(key) ?? "";
  const seed = get("seed");
  const [p0, d0, p1, d1] = [get("p0"), get("d0"), get("p1"), get("d1")];
  if (!/^\d{1,10}$/.test(seed) || Number(seed) >= 2 ** 32) return null;
  if (!p0 || !d0 || !p1 || !d1) return null;
  return { seed: Number(seed), agents: [p0, p1], decks: [d0, d1] };
}

/** 総当たりの試合の URL（デッキがこのページで書けなければ null） */
export function recordLink(record: Pick<GameRecord, "a" | "b" | "aIsPlayer0" | "seed">, entrants: readonly Entrant[], decks: LinkDecks): GameLink | null {
  const [e0, e1] = record.aIsPlayer0 ? [entrants[record.a], entrants[record.b]] : [entrants[record.b], entrants[record.a]];
  if (!e0 || !e1) return null;
  const d0 = decks.encode(e0.deck);
  const d1 = decks.encode(e1.deck);
  if (d0 === null || d1 === null) return null;
  return { seed: record.seed, agents: [e0.agent, e1.agent], decks: [d0, d1] };
}

/**
 * 試合の URL から、打ち直す試合（参加者 2 人。席 0 が参加者 0）を作る。使えない AI・デッキなら理由の文。
 * agents はページで選べる AI（キーと表示名）
 */
export function linkMatch(
  link: GameLink,
  decks: LinkDecks,
  agents: Readonly<Record<string, string>>,
): { entrants: [Entrant, Entrant]; spec: { a: 0; b: 1; seed: number; aIsPlayer0: true } } | string {
  const seats = [0, 1].map((p) => {
    const agent = link.agents[p]!;
    if (!(agent in agents)) return `P${p + 1} の AI「${agent}」は、このページでは選べません`;
    const deck = decks.decode(link.decks[p]!);
    if (typeof deck === "string") return `P${p + 1} のデッキ: ${deck}`;
    return { agent, deck };
  });
  const [s0, s1] = seats;
  if (typeof s0 === "string") return s0;
  if (typeof s1 === "string") return s1;
  if (!s0 || !s1) return "席が足りません";
  const sameAgent = s0.agent === s1.agent;
  const entrant = (s: { agent: string; deck: { cards: string[]; label: string } }): Entrant => ({
    name: sameAgent ? s.deck.label : `${s.deck.label}（${agents[s.agent] ?? s.agent}）`,
    deck: s.deck.cards,
    agent: s.agent,
  });
  return { entrants: [entrant(s0), entrant(s1)], spec: { a: 0, b: 1, seed: link.seed, aIsPlayer0: true } };
}

/** 今のページの URL の # を書き換える（履歴は増やさない。null で消す） */
export function replaceHash(hash: string | null): void {
  try {
    history.replaceState(null, "", location.pathname + location.search + (hash ?? ""));
  } catch {
    // 書き換えられなくても画面は動く
  }
}

/** 同じカードが同じ並びか */
export const sameCards = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * スターターのページのデッキの書き方: デフォルトデッキと並びまで同じならそのキー、そうでなければカード ID の列（reproduce.ts の deckArg。
 * スターターのページはデッキの編集・貼り付けができるので、カードの列を URL に入れてよい）。読むときはスターターで組めるデッキか確かめる
 */
export const STARTER_LINK_DECKS: LinkDecks = {
  encode: (cards) => deckArg(cards),
  decode(param) {
    let ids: string[];
    try {
      ids = parseDeckArg(param);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    const cards: Card[] = [];
    for (const id of ids) {
      const card = CARDS_BY_ID.get(id);
      if (!card) return `スターターに無いカード ID: ${id}`;
      cards.push(card);
    }
    const cls = cards.find((c) => c.class !== "neutral")?.class ?? "neutral";
    const problem = deckProblems(STARTER, cls, cards)[0];
    if (problem) return problem;
    const named = DEFAULT_DECKS.find((d) => sameCards(d.cards, ids));
    return { cards: ids, label: named ? named.name : `URL のデッキ（${CLASS_NAMES[cls]}）` };
  },
};
