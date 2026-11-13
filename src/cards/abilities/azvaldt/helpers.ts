// 前期のローテーションの能力定義のための補助関数。
// スターターの ../helpers.ts のうち、カード名・クレスト名から ID を引くものを、前期のローテーションのカードから引くものに置き換える
// （同じ名前のストームブラストが、スターターは 10131320、前期のローテーションは 10831310）。ほかはそのまま使う。

import rawRotCards from "../../../../data/pools/azvaldt/cards.json";
import rawRotCrests from "../../../../data/pools/azvaldt/crests.json";
import type { Ability, CardFilter, Condition, Effect, Target, Value } from "../../../engine/dsl";

export {
  BOTH_LEADERS,
  ENHANCED,
  EVENT,
  OPP_LEADER,
  SELF_LEADER,
  THIS,
  THIS_ATTACK,
  THIS_X,
  allFollowers,
  allyCards,
  allyFollowers,
  buff,
  choose,
  costChange,
  count,
  damage,
  discard,
  distribute,
  draw,
  fanfare,
  gainPp,
  grant,
  grantAttacks,
  handCards,
  heal,
  lastWords,
  mode,
  necromancy,
  onAllyEnter,
  onAttack,
  onEvolve,
  onSpellboost,
  onSuperEvolve,
  oppFollowers,
  otherAllyFollowers,
  random,
  slot,
  spell,
  spellboost,
  union,
  v,
  when,
} from "../helpers";

const ID_BY_NAME = new Map((rawRotCards as { id: string; name: string }[]).map((c) => [c.name, c.id]));
const CREST_ID_BY_NAME = new Map((rawRotCrests as { id: string; name: string }[]).map((c) => [c.name, c.id]));

/** カード名から前期のローテーションのカードIDを引く */
export function id(name: string): string {
  const v = ID_BY_NAME.get(name);
  if (!v) throw new Error(`前期のローテーションにカードがありません: ${name}`);
  return v;
}

/** 『クレスト：<name>』の ID を前期のローテーションのクレストから引く */
export function crestIdOf(name: string): string {
  const v = CREST_ID_BY_NAME.get(`クレスト：${name}`);
  if (!v) throw new Error(`前期のローテーションにクレストがありません: ${name}`);
  return v;
}

// ---- 名前で書く効果（前期のローテーションのカードから引く） ----

export const addToHand = (name: string, count: Value = 1): Effect => ({ op: "addToHand", cardId: id(name), count });
export const summon = (name: string, count: Value = 1): Effect => ({ op: "summon", cardId: id(name), count });
export const transform = (target: Target, name: string): Effect => ({ op: "transform", target, cardId: id(name) });
export const crest = (name: string, side: "self" | "opponent" = "self"): Effect => ({ op: "crest", crestId: crestIdOf(name), side });
/** 『name』count 枚を自分のデッキ（のランダムな位置）に加える */
export const addToDeck = (name: string, count: Value = 1): Effect => ({ op: "addToDeck", cardId: id(name), count });

// ---- 前期のローテーションで足した仕組み ----

/** 相手は自身のデッキから count 枚を引く */
export const opponentDraws = (count: Value): Effect => ({ op: "draw", count, side: "opponent" });
/** リーダーの体力の最大値を amount だけ増減する */
export const addLeaderMaxHp = (side: "self" | "opponent", amount: number): Effect => ({ op: "addLeaderMaxHp", side, amount });
/** これのカウントを amount だけ増減する */
export const countdown = (amount: number): Effect => ({ op: "countdown", target: { kind: "this" }, amount });

/** 体力最小のリーダーすべて */
export const LOWEST_HP_LEADERS: Target = { kind: "lowestHpLeaders" };
/** 場のカード（両方の場） */
export const boardCards = (filter?: CardFilter): Target => ({
  kind: "board",
  side: "both",
  ...(filter ? { filter } : {}),
});

/** 【自分がカードをプレイしたとき】のプレイしたカードの元のコスト */
export const PLAYED_COST: Value = { kind: "playedCost" };

/** 自分が他のカードをプレイしたとき（filter はプレイしたカードの条件） */
export const onAllyPlay = (filter: CardFilter, ...effects: Effect[]): Ability => ({
  trigger: Object.keys(filter).length > 0 ? { on: "allyPlay", filter } : { on: "allyPlay" },
  effects,
});
/** 手札で働く。自分のターン終了時 */
export const onTurnEndInHand = (...effects: Effect[]): Ability => ({ trigger: { on: "turnEndInHand" }, effects });

export const exists = (of: Target): Condition => ({ kind: "exists", of });
export const leaderHpAtMost = (value: number): Condition => ({ kind: "leaderHpAtMost", value });
export const LEADER_HP_ABOVE_OPPONENT: Condition = { kind: "leaderHpAboveOpponent" };
