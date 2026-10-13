// 情報集合の determinization: AI が見えない情報を使わないよう、視点のプレイヤーから見て
// 矛盾しない「ありうる局面」を作る。AI は実際の局面ではなく、これに手を適用して先読みする。
//
// - 相手の手札と山札の中身は、相手のデッキの未公開カードから並べ直す
//   （相手のデッキリストの構成は知っている前提。順番と手札の中身は知らない）
//   - 中身が公開されている手札（トークン、場から戻ったカード、名前の決まったカードを効果で加えたもの。HandCard.revealed）はそのまま残す
//   - 条件付きで引いたカード（HandCard.drawnBy）には、条件に合うカードを割り当てる（合うものが無ければ条件を無視する）
// - 自分の山札の順番も並べ直す
// - 乱数の状態を新しくする（ドローやランダム対象の結果を事前に知らないようにする）

import { cardOf, cloneState, newHandCard, shuffle, type DrawHint, type GameState, type HandCard, type PlayerIndex, type Rng } from "../engine";

export interface DeterminizeOptions {
  /** 実験用: 相手の手札を実際のまま残す（見えない情報を使う。手札読みの改善の上限を測るためだけに使い、対戦には使わない） */
  peekOppHand?: boolean;
}

export function determinize(state: GameState, viewer: PlayerIndex, rng: Rng, opts: DeterminizeOptions = {}): GameState {
  const s = cloneState(state);
  const me = s.players[viewer];
  const opp = s.players[viewer === 0 ? 1 : 0];

  shuffle(me.deck, rng);

  const hidden = opts.peekOppHand ? [] : opp.hand.filter((h) => !isPublic(h));
  const pool = [...hidden.map((h) => h.cardId), ...opp.deck.map((r) => r.cardId)];
  shuffle(pool, rng);
  // 条件付きで引いたカードから先に、条件に合うカードを取る
  const assigned = new Map<number, string>();
  for (const h of hidden) {
    if (!h.drawnBy) continue;
    const hint = h.drawnBy;
    const idx = pool.findIndex((id) => matchesHint(id, hint));
    if (idx >= 0) assigned.set(h.iid, pool.splice(idx, 1)[0] as string);
  }
  let k = 0;
  for (const h of hidden) if (!assigned.has(h.iid)) assigned.set(h.iid, pool[k++] as string);
  opp.hand = opp.hand.map((h) => {
    const id = assigned.get(h.iid);
    return id === undefined ? h : newHandCard(s, id, h.iid);
  });
  opp.deck = opp.deck.map((r) => ({ iid: r.iid, cardId: pool[k++] as string }));

  s.rng = Math.floor(rng.int(2 ** 30) * 4 + rng.int(4)) >>> 0;
  return s;
}

/** 相手から見て中身が分かっている手札のカード */
function isPublic(h: HandCard): boolean {
  return h.revealed || cardOf(h.cardId).set === "token";
}

function matchesHint(cardId: string, f: DrawHint): boolean {
  const card = cardOf(cardId);
  if (f.type && card.type !== f.type) return false;
  if (f.tribe && !(card.tribes ?? []).includes(f.tribe)) return false;
  if (f.class && card.class !== f.class) return false;
  if (f.ids && !f.ids.includes(cardId)) return false;
  if (f.costMax !== undefined && card.cost > f.costMax) return false;
  if (f.costEq !== undefined && card.cost !== f.costEq) return false;
  return true;
}
