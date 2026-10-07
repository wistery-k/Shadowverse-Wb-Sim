// 盤面の評価関数。重み（EvalWeights）はデータとして持ち、自己対戦で調整できるようにする（scripts/tune.ts）。

import type { FollowerOnBoard, GameState, OnBoard, PlayerIndex } from "../engine";

export interface EvalWeights {
  /** 自分・相手のリーダー体力 1 点 */
  myHp: number;
  oppHp: number;
  /** フォロワー: 攻撃力・体力・1体あたりの基礎点・ターン終了までの攻撃力 */
  attack: number;
  defense: number;
  followerBase: number;
  tempAttack: number;
  /** キーワード能力の価値の倍率（守護1・必殺2 等の基準値にかける） */
  keywords: number;
  /** アミュレット1枚・土の印1つ */
  amulet: number;
  sigil: number;
  /** 相手の盤面の価値の倍率（自分の盤面に対して） */
  oppBoard: number;
  /** 手札 1 枚 */
  myHand: number;
  oppHand: number;
  /** 残っている EP / SEP / エクストラPP の使用権 */
  ep: number;
  sep: number;
  extraPp: number;
  /** クレスト 1 つ */
  crest: number;
  /** 墓場 1（10 まで） */
  graveyard: number;
  /** 相手リーダーの体力がこれ以下のとき、自分のフォロワーの攻撃力を追加で評価する */
  lethalRange: number;
  lethalAttack: number;
  /**
   * カードごとの「手札に持っておく価値」（カードID → 点数）。切り札を温存させるために使う。
   * 手札1枚の価値（myHand）に加算する
   */
  hold: Readonly<Record<string, number>>;
}

/** 数値の重みの名前（hold を除く） */
export type NumericWeight = Exclude<keyof EvalWeights, "hold">;

/** 手で決めた基準の重み */
export const DEFAULT_WEIGHTS: EvalWeights = {
  myHp: 0.7,
  oppHp: 1.0,
  attack: 1,
  defense: 0.8,
  followerBase: 1,
  tempAttack: 0.3,
  keywords: 1,
  amulet: 1.5,
  sigil: 0.5,
  oppBoard: 1.1,
  myHand: 0.6,
  oppHand: 0.3,
  ep: 1.5,
  sep: 2.5,
  extraPp: 1,
  crest: 1.5,
  graveyard: 0.05,
  lethalRange: 10,
  lethalAttack: 0.3,
  hold: {},
};

export const KEYWORD_VALUE: Partial<Record<string, number>> = {
  ward: 1,
  bane: 2,
  barrier: 1,
  drain: 1,
  ambush: 1,
  intimidate: 1,
  aura: 0.5,
};

function followerValue(f: FollowerOnBoard, w: EvalWeights): number {
  let v = f.attack * w.attack + f.tempAttack * w.tempAttack + f.defense * w.defense + w.followerBase;
  for (const k of f.keywords) v += (KEYWORD_VALUE[k] ?? 0) * w.keywords;
  for (const k of f.tempKeywords) v += (KEYWORD_VALUE[k] ?? 0) * w.keywords;
  return v;
}

function boardValue(c: OnBoard, w: EvalWeights): number {
  if (c.kind === "follower") return followerValue(c, w);
  return w.amulet + (c.sigils ?? 0) * w.sigil;
}

/** プレイヤー p から見た盤面の評価値（大きいほど p に有利） */
export function evaluateWith(state: GameState, p: PlayerIndex, w: EvalWeights): number {
  if (state.phase === "ended") return state.winner === p ? 1e6 : -1e6;
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  let v = 0;
  v += me.leaderHp * w.myHp - opp.leaderHp * w.oppHp;
  for (const c of me.board) v += boardValue(c, w);
  let oppBoard = 0;
  for (const c of opp.board) oppBoard += boardValue(c, w);
  v -= oppBoard * w.oppBoard;
  v += me.hand.length * w.myHand - opp.hand.length * w.oppHand;
  for (const h of me.hand) v += w.hold[h.cardId] ?? 0;
  v += me.ep * w.ep + me.sep * w.sep;
  if (me.extraPpAvailable) v += w.extraPp;
  v += (me.crests.length - opp.crests.length) * w.crest;
  v += Math.min(me.graveyard, 10) * w.graveyard;
  if (opp.leaderHp <= w.lethalRange) {
    for (const c of me.board) if (c.kind === "follower") v += c.attack * w.lethalAttack;
  }
  return v;
}

export function evaluate(state: GameState, p: PlayerIndex): number {
  return evaluateWith(state, p, DEFAULT_WEIGHTS);
}
