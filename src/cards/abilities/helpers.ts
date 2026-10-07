// カード能力の定義を簡潔に書くための補助関数。生成されるのは src/engine/dsl.ts のデータ。

import rawCards from "../../../data/cards.json";
import type { Ability, CardFilter, Condition, Duration, Effect, Target, Trigger, Value } from "../../engine/dsl";
import type { StaticKeyword } from "../../engine/types";

const ID_BY_NAME = new Map((rawCards as { id: string; name: string }[]).map((c) => [c.name, c.id]));

/** カード名からカードIDを引く（定義の読みやすさのため名前で書く） */
export function id(name: string): string {
  const v = ID_BY_NAME.get(name);
  if (!v) throw new Error(`カードがありません: ${name}`);
  return v;
}

// ---- 対象 ----

export const THIS: Target = { kind: "this" };
export const EVENT: Target = { kind: "event" };
export const SELF_LEADER: Target = { kind: "leader", side: "self" };
export const OPP_LEADER: Target = { kind: "leader", side: "opponent" };
export const BOTH_LEADERS: Target = { kind: "leader", side: "both" };
export const slot = (name = "t"): Target => ({ kind: "slot", slot: name });
export const union = (...of: Target[]): Target => ({ kind: "union", of });

const followers = (side: "self" | "opponent" | "both", filter: CardFilter = {}): Target => ({
  kind: "board",
  side,
  filter: { type: "follower", ...filter },
});
export const oppFollowers = (filter?: CardFilter) => followers("opponent", filter);
export const allyFollowers = (filter?: CardFilter) => followers("self", filter);
/** 自分の場の他のフォロワー */
export const otherAllyFollowers = (filter?: CardFilter) => followers("self", { excludeSelf: true, ...filter });
export const allFollowers = (filter?: CardFilter) => followers("both", filter);
export const allyCards = (filter?: CardFilter): Target => ({ kind: "board", side: "self", ...(filter ? { filter } : {}) });
export const allyAmulets = (filter?: CardFilter): Target => ({ kind: "board", side: "self", filter: { type: "amulet", ...filter } });
export const handCards = (filter?: CardFilter): Target => ({ kind: "hand", ...(filter ? { filter } : {}) });

// ---- 能力 ----

const ability = (trigger: Trigger, effects: Effect[], extra: Partial<Ability> = {}): Ability => ({ trigger, effects, ...extra });

export const fanfare = (...effects: Effect[]) => ability({ on: "fanfare" }, effects);
export const spell = (...effects: Effect[]) => ability({ on: "spell" }, effects);
export const lastWords = (...effects: Effect[]) => ability({ on: "lastWords" }, effects);
export const onEvolve = (...effects: Effect[]) => ability({ on: "evolve" }, effects);
/** 【超進化時】（【進化時】に加えて働く） */
export const onSuperEvolve = (...effects: Effect[]) => ability({ on: "superEvolve" }, effects);
/** 【超進化時】「〜ではなく」（【進化時】を置き換える） */
export const onSuperEvolveInstead = (...effects: Effect[]) => ability({ on: "superEvolve" }, effects, { replacesEvolve: true });
export const onEvolved = (...effects: Effect[]) => ability({ on: "evolved" }, effects);
export const onAttack = (...effects: Effect[]) => ability({ on: "attack" }, effects);
export const onClash = (...effects: Effect[]) => ability({ on: "clash" }, effects);
export const onEnter = (...effects: Effect[]) => ability({ on: "enter" }, effects);
export const onTurnStart = (...effects: Effect[]) => ability({ on: "turnStart" }, effects);
export const onTurnEnd = (...effects: Effect[]) => ability({ on: "turnEnd", whose: "self" }, effects);
export const onOpponentTurnEnd = (...effects: Effect[]) => ability({ on: "turnEnd", whose: "opponent" }, effects);
export const onAllyEnter = (filter: CardFilter, ...effects: Effect[]) => ability({ on: "allyEnter", filter }, effects);
export const act = (cost: number, ...effects: Effect[]) => ability({ on: "act", cost }, effects);
export const onAllyAct = (...effects: Effect[]) => ability({ on: "allyAct" }, effects);
export const onFused = (...effects: Effect[]) => ability({ on: "fused" }, effects);
export const onAllyFuse = (...effects: Effect[]) => ability({ on: "allyFuse" }, effects);
export const onSpellboost = (...effects: Effect[]) => ability({ on: "spellboost" }, effects);
export const onAllyLeaveInHand = (...effects: Effect[]) => ability({ on: "allyLeaveInHand" }, effects);
export const onDiscarded = (...effects: Effect[]) => ability({ on: "discarded" }, effects);
export const onAllyDestroyed = (filter: CardFilter, ...effects: Effect[]) => ability({ on: "allyDestroyed", filter }, effects);
export const onLeaderHealed = (...effects: Effect[]) => ability({ on: "leaderHealed" }, effects, { oncePerOwnTurn: true });
export const oncePerOwnTurn = (a: Ability): Ability => ({ ...a, oncePerOwnTurn: true });

// ---- 効果 ----

export const choose = (from: Target, count = 1, name = "t"): Effect => ({ op: "choose", slot: name, from, count });
export const random = (from: Target, count = 1, name = "t"): Effect => ({ op: "random", slot: name, from, count });
export const mode = (...options: Effect[][]): Effect => ({ op: "mode", options });

export const damage = (target: Target, amount: Value): Effect => ({ op: "damage", target, amount });
export const distribute = (target: Target, amount: Value): Effect => ({ op: "distribute", target, amount });
export const destroy = (target: Target, countVar?: string): Effect =>
  countVar ? { op: "destroy", target, countVar } : { op: "destroy", target };
export const banish = (target: Target): Effect => ({ op: "banish", target });
export const bounce = (target: Target): Effect => ({ op: "bounce", target });
export const heal = (amount: Value, target: Target = SELF_LEADER): Effect => ({ op: "heal", target, amount });
export const setDefense = (target: Target, value: number): Effect => ({ op: "setDefense", target, value });

export const draw = (count: Value, filter?: CardFilter): Effect => (filter ? { op: "draw", count, filter } : { op: "draw", count });
export const addToHand = (name: string, count: Value = 1): Effect => ({ op: "addToHand", cardId: id(name), count });
export const summon = (name: string, count: Value = 1, name2?: string): Effect =>
  name2 ? { op: "summon", cardId: id(name), count, slot: name2 } : { op: "summon", cardId: id(name), count };
export const returnToDeck = (target: Target): Effect => ({ op: "returnToDeck", target });
export const discard = (target: Target): Effect => ({ op: "discard", target });
export const transform = (target: Target, name: string): Effect => ({ op: "transform", target, cardId: id(name) });

export const buff = (target: Target, attack: Value, defense: Value, duration?: Duration): Effect =>
  duration ? { op: "buff", target, attack, defense, duration } : { op: "buff", target, attack, defense };
export const grant = (target: Target, keywords: StaticKeyword[], duration?: Duration): Effect =>
  duration ? { op: "grant", target, keywords, duration } : { op: "grant", target, keywords };
export const grantAbilities = (target: Target, abilities: Ability[]): Effect => ({ op: "grant", target, abilities });
export const grantAttacks = (target: Target, maxAttacks: number): Effect => ({ op: "grant", target, maxAttacks });
export const evolveIt = (target: Target = THIS): Effect => ({ op: "evolve", target, kind: "evolve" });
export const superEvolveIt = (target: Target): Effect => ({ op: "evolve", target, kind: "superEvolve" });

export const spellboost = (target: Target, times: number): Effect => ({ op: "spellboost", target, times });
export const costChange = (target: Target, amount: number): Effect => ({ op: "costChange", target, amount });

export const gainPp = (amount: Value | "max"): Effect => ({ op: "gainPp", amount });
export const addSigils = (amount: Value): Effect => ({ op: "addSigils", amount });
export const earthRite = (amount: number, ...then: Effect[]): Effect => ({ op: "earthRite", amount, then });
export const necromancy = (amount: number, ...then: Effect[]): Effect => ({ op: "necromancy", amount, then });
export const crest = (name: string, side: "self" | "opponent" = "self"): Effect => ({ op: "crest", crestId: crestIdOf(name), side });

export const when = (cond: Condition, then: Effect[], otherwise?: Effect[]): Effect =>
  otherwise ? { op: "if", cond, then, else: otherwise } : { op: "if", cond, then };
export const repeat = (times: Value, ...effects: Effect[]): Effect => ({ op: "repeat", times, effects });

// ---- 条件・値 ----

export const AWAKENED: Condition = { kind: "awakened" };
export const ENHANCED: Condition = { kind: "enhanced" };
export const combo = (atLeast: number): Condition => ({ kind: "combo", atLeast });
export const COMBO: Value = { kind: "combo" };
export const SIGILS: Value = { kind: "sigils" };
export const THIS_X: Value = { kind: "thisX" };
export const THIS_ATTACK: Value = { kind: "thisAttack" };
export const count = (of: Target): Value => ({ kind: "count", of });
export const v = (name: string): Value => ({ kind: "var", name });

// ---- クレスト ----

import rawCrests from "../../../data/crests.json";
const CREST_ID_BY_NAME = new Map((rawCrests as { id: string; name: string }[]).map((c) => [c.name, c.id]));
export function crestIdOf(name: string): string {
  const v2 = CREST_ID_BY_NAME.get(`クレスト：${name}`);
  if (!v2) throw new Error(`クレストがありません: ${name}`);
  return v2;
}
