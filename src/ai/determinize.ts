// 情報集合の determinization: AI が見えない情報を使わないよう、視点のプレイヤーから見て
// 矛盾しない「ありうる局面」を作る。AI は実際の局面ではなく、これに手を適用して先読みする。
//
// - 相手の手札（トークンを除く）と山札の中身は、相手のデッキの未公開カードから並べ直す
//   （相手のデッキリストの構成は知っている前提。順番と手札の中身は知らない）
// - 自分の山札の順番も並べ直す
// - 乱数の状態を新しくする（ドローやランダム対象の結果を事前に知らないようにする）

import { cardOf, cloneState, newHandCard, shuffle, type GameState, type PlayerIndex, type Rng } from "../engine";

export function determinize(state: GameState, viewer: PlayerIndex, rng: Rng): GameState {
  const s = cloneState(state);
  const me = s.players[viewer];
  const opp = s.players[viewer === 0 ? 1 : 0];

  shuffle(me.deck, rng);

  // 相手の手札のうちトークン（効果で加わったカード）は公開情報として残す
  const hidden = opp.hand.filter((h) => cardOf(h.cardId).set !== "token");
  const pool = [...hidden.map((h) => h.cardId), ...opp.deck.map((r) => r.cardId)];
  shuffle(pool, rng);
  const hiddenIids = new Set(hidden.map((h) => h.iid));
  let k = 0;
  opp.hand = opp.hand.map((h) => (hiddenIids.has(h.iid) ? newHandCard(s, pool[k++] as string, h.iid) : h));
  opp.deck = opp.deck.map((r) => ({ iid: r.iid, cardId: pool[k++] as string }));

  s.rng = Math.floor(rng.int(2 ** 30) * 4 + rng.int(4)) >>> 0;
  return s;
}
