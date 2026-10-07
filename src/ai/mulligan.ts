// マリガン（ユーザーの経験則に基づくルール）
//
// 1. 6コスト以上は必ず返す
// 2. 「2コストのフォロワー」と「【進化時】能力を持つ5コスト以下のフォロワー」を1枚ずつ残す
// 3. どちらも無ければすべて返す（片方だけなら、それだけを残す）
// 4. どちらもあるなら、さらに「3コスト」「2枚目の【進化時】能力持ち（5コスト以下）」「1コスト」
//    「ドローソース（ファンファーレ・スペルで自分のデッキから引く、5コスト以下）」を残す

import type { Effect } from "../engine/dsl";
import { abilitiesOf, cardOf, type GameState, type HandCard, type PlayerIndex } from "../engine";

function containsDraw(effects: readonly Effect[]): boolean {
  return effects.some((e) => {
    if (e.op === "draw" || e.op === "drawAll") return true;
    if (e.op === "if") return containsDraw(e.then) || containsDraw(e.else ?? []);
    if (e.op === "repeat") return containsDraw(e.effects);
    if (e.op === "mode") return e.options.some(containsDraw);
    if (e.op === "earthRite" || e.op === "necromancy") return containsDraw(e.then);
    return false;
  });
}

const cache = new Map<string, { evolveFollower: boolean; drawSource: boolean }>();

function traits(cardId: string) {
  let t = cache.get(cardId);
  if (!t) {
    const card = cardOf(cardId);
    const abilities = abilitiesOf(cardId).abilities;
    t = {
      evolveFollower: card.type === "follower" && abilities.some((a) => a.trigger.on === "evolve"),
      drawSource: abilities.some((a) => (a.trigger.on === "fanfare" || a.trigger.on === "spell") && containsDraw(a.effects)),
    };
    cache.set(cardId, t);
  }
  return t;
}

/** 残すカードを決め、返すカードの iid を返す */
export function chooseMulligan(state: GameState, p: PlayerIndex): number[] {
  const hand = state.players[p].hand;
  const cost = (h: HandCard) => cardOf(h.cardId).cost;
  const keep = new Set<number>();
  const candidates = hand.filter((h) => cost(h) < 6);

  const twoDrop = candidates.find((h) => cost(h) === 2 && cardOf(h.cardId).type === "follower");
  // 【進化時】能力持ちは、進化できるターンに近い（コストの高い）ものを優先する
  const evolvers = candidates
    .filter((h) => cost(h) <= 5 && traits(h.cardId).evolveFollower && h.iid !== twoDrop?.iid)
    .sort((a, b) => cost(b) - cost(a));
  const evolver = evolvers[0];

  if (twoDrop) keep.add(twoDrop.iid);
  if (evolver) keep.add(evolver.iid);

  if (twoDrop && evolver) {
    const secondEvolver = evolvers[1];
    if (secondEvolver) keep.add(secondEvolver.iid);
    for (const h of candidates) {
      const c = cost(h);
      if (c === 3 || c === 1 || (c <= 5 && traits(h.cardId).drawSource)) keep.add(h.iid);
    }
  }
  return hand.filter((h) => !keep.has(h.iid)).map((h) => h.iid);
}

/** 旧来のマリガン（コスト4以上を返す）。比較用 */
export function chooseMulliganHighCost(state: GameState, p: PlayerIndex): number[] {
  return state.players[p].hand.filter((h) => cardOf(h.cardId).cost >= 4).map((h) => h.iid);
}
