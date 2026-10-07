// 状態の不変条件。テストと自己対戦で呼び、ルール実装の破綻を早期に検出する。

import { BOARD_LIMIT, HAND_LIMIT, MAX_PP } from "./constants";
import type { GameState } from "./types";

/** 不変条件の違反を列挙する。空なら正常。 */
export function invariantViolations(state: GameState): string[] {
  const v: string[] = [];
  const iids = new Set<number>();
  for (const p of [0, 1] as const) {
    const pl = state.players[p];
    const where = `プレイヤー${p}`;
    if (pl.hand.length > HAND_LIMIT) v.push(`${where}: 手札が${pl.hand.length}枚`);
    if (pl.board.length > BOARD_LIMIT) v.push(`${where}: 場が${pl.board.length}枚`);
    if (pl.maxPp < 0 || pl.maxPp > MAX_PP) v.push(`${where}: 最大PPが${pl.maxPp}`);
    if (pl.pp < 0 || pl.pp > pl.maxPp) v.push(`${where}: PPが${pl.pp}/${pl.maxPp}`);
    if (pl.ep < 0 || pl.sep < 0) v.push(`${where}: EP/SEPが負`);
    if (pl.leaderHp > pl.leaderMaxHp) v.push(`${where}: リーダー体力が最大値を超過`);
    if (state.phase !== "ended" && pl.leaderHp <= 0) v.push(`${where}: 体力0以下で対戦が継続`);
    if (pl.graveyardFollowers.length > pl.graveyard) v.push(`${where}: 墓場のカウントが不足`);
    for (const c of [...pl.deck, ...pl.hand, ...pl.board]) {
      if (iids.has(c.iid)) v.push(`${where}: iid ${c.iid} が重複`);
      iids.add(c.iid);
    }
    for (const c of pl.board) {
      if (c.kind !== "follower") continue;
      if (state.phase !== "ended" && c.defense <= 0) v.push(`${where}: 体力0以下のフォロワー ${c.iid} が場に残存`);
      if (c.defense > c.maxDefense) v.push(`${where}: フォロワー ${c.iid} の体力が最大値を超過`);
      if (c.attacksThisTurn > c.maxAttacks) v.push(`${where}: フォロワー ${c.iid} の攻撃回数が超過`);
    }
  }
  if (state.phase === "ended" && state.winner === null) v.push("終了しているが勝者がいない");
  if (state.phase !== "ended" && state.winner !== null) v.push("勝者がいるが終了していない");
  return v;
}
