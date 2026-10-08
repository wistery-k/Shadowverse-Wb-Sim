// マリガンの方針（カードごとの重み）。重みは scripts/mulligan-fit-main.ts で推定する（docs/ai-notes.md）

import { DEFAULT_DECKS } from "../cards/defaultDecks";
import { actingPlayer, cardOf, type Action, type GameState, type PlayerIndex } from "../engine";
import table from "../../data/mulligan-weights.json";
import type { Agent } from "./types";

/**
 * デッキ名 → カードID → [1 枚目を残す重み, 2 枚目も残す重み]。
 * 重みは「初手にあるとき、残すと返すより勝率がどれだけ上がるか」（0〜1 の差）。正なら残す
 */
export type MulliganWeights = Record<string, Record<string, [number, number]>>;

/** 推定した重み（npm run mulligan-fit -- <データ> --out data/mulligan-weights.json） */
export const MULLIGAN_WEIGHTS: MulliganWeights = parseMulliganWeights(table);

/** JSON の重みを検証して読む */
export function parseMulliganWeights(raw: unknown): MulliganWeights {
  const fail = (msg: string): never => {
    throw new Error(`マリガンの重みが不正です: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("オブジェクトではありません");
  const out: MulliganWeights = {};
  for (const [deck, cards] of Object.entries(raw)) {
    if (typeof cards !== "object" || cards === null) return fail(deck);
    const t: Record<string, [number, number]> = {};
    for (const [id, w] of Object.entries(cards as Record<string, unknown>)) {
      if (!Array.isArray(w) || w.length !== 2 || !w.every((v) => typeof v === "number" && Number.isFinite(v))) return fail(`${deck} ${id}`);
      t[id] = [w[0] as number, w[1] as number];
    }
    out[deck] = t;
  }
  return out;
}

/** 今のマリガン（コスト 4 以上を返す） */
export function costMulliganSwap(state: GameState, p: PlayerIndex): number[] {
  return state.players[p].hand.filter((h) => cardOf(h.cardId).cost >= 4).map((h) => h.iid);
}

const sortedKey = (ids: readonly string[]) => [...ids].sort().join(",");
const DECK_BY_CARDS = new Map(DEFAULT_DECKS.map((d) => [sortedKey(d.cards), d.name]));

/** マリガン時のプレイヤーのデッキ（手札＋山札）がデフォルトデッキのどれか。どれでもなければ null */
export function defaultDeckNameOf(state: GameState, p: PlayerIndex): string | null {
  const pl = state.players[p];
  return DECK_BY_CARDS.get(sortedKey([...pl.hand, ...pl.deck].map((c) => c.cardId))) ?? null;
}

/** 重みでマリガンする。デッキの重みが無ければ null */
export function weightedMulliganSwap(state: GameState, p: PlayerIndex, weights: MulliganWeights): number[] | null {
  const name = defaultDeckNameOf(state, p);
  const table = name === null ? undefined : weights[name];
  if (!table) return null;
  const seen = new Map<string, number>();
  const swap: number[] = [];
  for (const h of state.players[p].hand) {
    const copy = seen.get(h.cardId) ?? 0;
    seen.set(h.cardId, copy + 1);
    const w = table[h.cardId];
    if (!w) {
      if (cardOf(h.cardId).cost >= 4) swap.push(h.iid);
      continue;
    }
    // 2 枚目は「2 枚とも残す」と「1 枚だけ残す」の差。1 枚目を返すなら 2 枚目も返す
    const keep = copy === 0 ? w[0] > 0 : w[0] > 0 && w[1] > 0;
    if (!keep) swap.push(h.iid);
  }
  return swap;
}

/** マリガンだけ chooseSwap で決め、他は inner に任せる。chooseSwap が null なら inner に任せる */
export function withMulligan(inner: Agent, name: string, chooseSwap: (state: GameState, p: PlayerIndex) => number[] | null): Agent {
  return {
    name,
    chooseAction(state, legal, rng) {
      const first = legal[0];
      if (first?.type !== "mulligan") return inner.chooseAction(state, legal, rng);
      const swap = chooseSwap(state, actingPlayer(state));
      if (swap === null) return inner.chooseAction(state, legal, rng);
      const action: Action | undefined = legal.find(
        (a) => a.type === "mulligan" && a.swap.length === swap.length && a.swap.every((x) => swap.includes(x)),
      );
      return action ?? inner.chooseAction(state, legal, rng);
    },
  };
}
