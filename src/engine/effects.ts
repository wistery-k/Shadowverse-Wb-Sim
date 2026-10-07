// 能力（DSL）の解釈と、解決スタックの実行。
// 解決は state.stack（末尾が実行中）と state.queue（誘発待ち）で行い、選択が必要になると
// state.pending を設定して中断する。選択の回答（choose / mode アクション）で再開する。

import { CREST_ABILITIES } from "../cards/abilities";
import { APOCALYPSE_DECK } from "../cards/abilities/special";
import { EVOLVE_BONUS, MAX_PP, SUPER_EVOLVE_BONUS } from "./constants";
import type { Ability, CardFilter, Condition, Effect, Target, Trigger, Value } from "./dsl";
import { rngFrom, shuffle } from "./rng";
import { abilitiesOf, cardOf, crestOf, staticOf } from "./registry";
import {
  addHandCard,
  attackOf,
  boardAbilities,
  canAddToBoard,
  checkLeaders,
  crestsAndBoard,
  drawCards,
  findBoard,
  findCrest,
  findFollower,
  findHand,
  handCost,
  hasKeyword,
  isLeader,
  leaderId,
  leaderOwner,
  lose,
  newBoardCard,
  newContext,
  newHandCard,
  opponent,
  playersInTurnOrder,
  superEvolveTurnReached,
} from "./state";
import type {
  EffectContext,
  FollowerOnBoard,
  Frame,
  GameState,
  HandCard,
  InternalEffect,
  OnBoard,
  PlayerIndex,
} from "./types";

// ---- 対象 ----

function cardMatches(state: GameState, ctx: EffectContext, iid: number, filter: CardFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.excludeSelf && iid === ctx.source) return false;
  const board = findBoard(state, iid);
  const hand = board ? null : findHand(state, iid);
  const cardId = board?.card.cardId ?? hand?.card.cardId;
  if (cardId === undefined) return false;
  const card = cardOf(cardId);
  if (filter.type && card.type !== filter.type) return false;
  if (filter.tribe && !(card.tribes ?? []).includes(filter.tribe)) return false;
  if (filter.class && card.class !== filter.class) return false;
  if (filter.ids && !filter.ids.includes(cardId)) return false;
  const cost = hand ? handCost(hand.card) : card.cost;
  if (filter.costMax !== undefined && cost > filter.costMax) return false;
  if (filter.costEq !== undefined && cost !== evalValue(state, ctx, filter.costEq)) return false;
  if (filter.spellboost && !abilitiesOf(cardId).abilities.some((a) => a.trigger.on === "spellboost")) return false;
  if (filter.earthSigil && !staticOf(cardId).earthSigil) return false;
  if (board) {
    const c = board.card;
    if (filter.keyword && !hasKeyword(c, filter.keyword)) return false;
    if (filter.defenseMax !== undefined && (c.kind !== "follower" || c.defense > filter.defenseMax)) return false;
    if (filter.notEvolved && (c.kind !== "follower" || c.evolve !== "none")) return false;
  } else if (filter.keyword || filter.defenseMax !== undefined || filter.notEvolved) {
    return false;
  }
  return true;
}

function sidePlayers(state: GameState, ctx: EffectContext, side: "self" | "opponent" | "both"): PlayerIndex[] {
  if (side === "self") return [ctx.controller];
  if (side === "opponent") return [opponent(ctx.controller)];
  return playersInTurnOrder(state);
}

function existsEntity(state: GameState, id: number): boolean {
  return isLeader(id) || findBoard(state, id) !== null || findHand(state, id) !== null;
}

export function resolveTarget(state: GameState, ctx: EffectContext, t: Target): number[] {
  switch (t.kind) {
    case "this":
      return existsEntity(state, ctx.source) ? [ctx.source] : [];
    case "leader":
      return sidePlayers(state, ctx, t.side).map(leaderId);
    case "board":
      return sidePlayers(state, ctx, t.side).flatMap((p) =>
        [...state.players[p].board]
          .sort((a, b) => a.order - b.order)
          .filter((c) => cardMatches(state, ctx, c.iid, t.filter))
          .map((c) => c.iid),
      );
    case "hand":
      return state.players[ctx.controller].hand
        .filter((c) => cardMatches(state, ctx, c.iid, t.filter))
        .map((c) => c.iid);
    case "slot":
      return (ctx.slots[t.slot] ?? []).filter((id) => existsEntity(state, id));
    case "event":
      return ctx.event !== null && existsEntity(state, ctx.event) ? [ctx.event] : [];
    case "union":
      return t.of.flatMap((x) => resolveTarget(state, ctx, x));
    case "maxAttack": {
      const fs = resolveTarget(state, ctx, t.of)
        .map((id) => findFollower(state, id))
        .filter((x) => x !== null);
      const max = Math.max(...fs.map((x) => attackOf(x.card)));
      return fs.filter((x) => attackOf(x.card) === max).map((x) => x.card.iid);
    }
  }
}

/** 相手のカードを能力で選ぶ場合の制限（潜伏・オーラ、「相手は能力でこれしか選べない」） */
function selectable(state: GameState, chooser: PlayerIndex, ids: number[]): number[] {
  const opp = opponent(chooser);
  const oppIds = ids.filter((id) => (isLeader(id) ? leaderOwner(id) === opp : findBoard(state, id)?.player === opp));
  const blocked = new Set(
    oppIds.filter((id) => {
      const c = findBoard(state, id)?.card;
      return c !== undefined && (hasKeyword(c, "ambush") || hasKeyword(c, "aura"));
    }),
  );
  const only = oppIds.filter((id) => {
    const c = findBoard(state, id)?.card;
    return c !== undefined && !blocked.has(id) && abilitiesOf(c.cardId).onlySelectable === true;
  });
  return ids.filter((id) => {
    if (!oppIds.includes(id)) return true;
    if (blocked.has(id)) return false;
    return only.length === 0 || only.includes(id);
  });
}

/** 「選ぶ」の候補 */
export function chooseCandidates(state: GameState, ctx: EffectContext, from: Target): number[] {
  return selectable(state, ctx.controller, resolveTarget(state, ctx, from));
}

// ---- 値と条件 ----

function sourceX(state: GameState, ctx: EffectContext): number {
  const b = findBoard(state, ctx.source)?.card;
  if (b?.kind === "follower" && b.x !== null) return b.x;
  const h = findHand(state, ctx.source)?.card;
  if (h && h.x !== null) return h.x;
  return ctx.sourceX ?? 0;
}

export function evalValue(state: GameState, ctx: EffectContext, v: Value): number {
  if (typeof v === "number") return v;
  const pl = state.players[ctx.controller];
  switch (v.kind) {
    case "var":
      return ctx.vars[v.name] ?? 0;
    case "count":
      return resolveTarget(state, ctx, v.of).length;
    case "combo":
      return pl.combo;
    case "sigils":
      return pl.board.find((c) => c.kind === "amulet" && c.sigils !== null)?.kind === "amulet"
        ? ((pl.board.find((c) => c.kind === "amulet" && c.sigils !== null) as { sigils: number }).sigils)
        : 0;
    case "thisAttack": {
      const f = findFollower(state, ctx.source)?.card;
      return f ? attackOf(f) : ctx.sourceAttack;
    }
    case "costOf":
      return (ctx.vars[`cost:${v.slot}`] ?? 0);
    case "thisX":
      return sourceX(state, ctx);
    case "destroyedThisTurn":
      return pl.destroyedThisTurn
        .filter((r) => {
          if (!v.filter) return true;
          const card = cardOf(r.cardId);
          return (!v.filter.tribe || (card.tribes ?? []).includes(v.filter.tribe)) && (!v.filter.type || card.type === v.filter.type);
        })
        .reduce((sum, r) => sum + (v.stat === "attack" ? r.attack : r.defense), 0);
  }
}

export function evalCond(state: GameState, ctx: EffectContext, c: Condition): boolean {
  const pl = state.players[ctx.controller];
  switch (c.kind) {
    case "awakened":
      return pl.maxPp >= 7;
    case "combo":
      return pl.combo >= c.atLeast;
    case "enhanced":
      return ctx.enhanced;
    case "superEvolveTurn":
      return superEvolveTurnReached(state, ctx.controller);
    case "thisSuperEvolved":
      return findFollower(state, ctx.source)?.card.evolve === "superEvolved";
    case "handCount":
      return pl.hand.length <= c.atMost;
    case "attackingFollower":
      return ctx.event !== null && !isLeader(ctx.event);
    case "varAtLeast":
      return (ctx.vars[c.name] ?? 0) >= c.value;
    case "thisXAtLeast":
      return sourceX(state, ctx) >= c.value;
    case "maxPp":
      return pl.maxPp >= c.atLeast;
    case "not":
      return !evalCond(state, ctx, c.cond);
  }
}

// ---- 誘発 ----

function pushFrame(state: GameState, effects: (Effect | InternalEffect)[], ctx: EffectContext): void {
  if (effects.length > 0) state.stack.push({ effects, pc: 0, ctx });
}

function queue(state: GameState, ability: Ability, ctx: EffectContext): void {
  state.queue.push({ ability, ctx });
}

/** 「自分のターンごとに1回」の確認と記録 */
function useOncePerTurn(state: GameState, owner: PlayerIndex, used: Record<string, number>, key: string): boolean {
  const turnId = state.players[owner].turnCount;
  if (used[key] === turnId) return false;
  used[key] = turnId;
  return true;
}

/**
 * プレイヤー p のクレスト・場のカードのうち、trigger の条件を満たす能力を誘発させる。
 * match は能力ごとに文脈を返す（誘発しないなら null）。
 */
function fireSide(
  state: GameState,
  p: PlayerIndex,
  match: (trigger: Trigger, sourceIid: number) => Partial<EffectContext> | null,
): void {
  for (const entry of crestsAndBoard(state, p)) {
    const sourceIid = entry.kind === "crest" ? entry.crest.iid : entry.card.iid;
    const sourceCardId = entry.kind === "crest" ? entry.crest.crestId : entry.card.cardId;
    entry.abilities.forEach((ability, i) => {
      const extra = match(ability.trigger, sourceIid);
      if (!extra) return;
      if (ability.oncePerOwnTurn) {
        const used = entry.kind === "crest" ? entry.crest.usedOncePerTurn : entry.card.kind === "follower" ? entry.card.usedOncePerTurn : null;
        if (used && !useOncePerTurn(state, p, used, String(i))) return;
      }
      const card = entry.kind === "board" && entry.card.kind === "follower" ? entry.card : null;
      queue(state, ability, newContext(p, sourceIid, sourceCardId, { sourceX: card?.x ?? null, sourceAttack: card ? attackOf(card) : 0, ...extra }));
    });
  }
}

/** 手札のカードの能力を誘発させる */
function fireHand(state: GameState, p: PlayerIndex, card: HandCard, on: Trigger["on"]): void {
  for (const ability of abilitiesOf(card.cardId).abilities) {
    if (ability.trigger.on === on) queue(state, ability, newContext(p, card.iid, card.cardId, { sourceX: card.x }));
  }
}

/** カード自身の能力のうち、指定の誘発のものを返す */
export function ownAbilities(cardIdOrBoard: string | OnBoard, on: Trigger["on"]): Ability[] {
  const list = typeof cardIdOrBoard === "string" ? abilitiesOf(cardIdOrBoard).abilities : boardAbilities(cardIdOrBoard);
  return list.filter((a) => a.trigger.on === on);
}

// ---- 場への出入り ----

/** カードを場に出す（場が満杯なら出さない）。出したら true */
export function enterBoard(state: GameState, p: PlayerIndex, card: OnBoard): boolean {
  const pl = state.players[p];
  if (!canAddToBoard(state, p)) return false;
  // 【土の印】アミュレットは1枚にまとまる
  if (card.kind === "amulet" && card.sigils !== null) {
    const old = pl.board.find((c) => c.kind === "amulet" && c.sigils !== null);
    if (old && old.kind === "amulet") {
      card.sigils += old.sigils ?? 0;
      pl.board = pl.board.filter((c) => c.iid !== old.iid); // 消滅
    }
  }
  pl.board.push(card);

  for (const ability of ownAbilities(card, "enter")) queue(state, ability, newContext(p, card.iid, card.cardId));
  fireSide(state, p, (trigger, src) =>
    trigger.on === "allyEnter" && src !== card.iid && cardMatches(state, newContext(p, src, ""), card.iid, trigger.filter)
      ? { event: card.iid }
      : null,
  );
  return true;
}

export type LeaveReason = "destroy" | "banish" | "bounce";

/** 場から離れる処理。ラストワード等を誘発させる */
export function leaveBoard(state: GameState, iid: number, reason: LeaveReason): void {
  const hit = findBoard(state, iid);
  if (!hit) return;
  const { player: p, card } = hit;
  const pl = state.players[p];
  // 攻撃中の攻撃先が破壊された（場を離れる場合に消滅するカードを含む）
  if (reason === "destroy" && state.attack?.defender === iid) state.attack.defenderDestroyed = true;
  if (abilitiesOf(card.cardId).banishOnLeave) reason = "banish";

  // 破壊されたときの誘発は、離れる前の状態で条件を判定する
  if (reason === "destroy" && card.kind === "follower") {
    const destroyedIid = card.iid;
    fireSide(state, p, (trigger, src) =>
      trigger.on === "allyDestroyed" && src !== destroyedIid && cardMatches(state, newContext(p, src, ""), destroyedIid, trigger.filter)
        ? { event: destroyedIid }
        : null,
    );
  }

  pl.board = pl.board.filter((c) => c.iid !== iid);

  if (reason === "destroy") {
    pl.graveyard++;
    const base = cardOf(card.cardId);
    if (card.kind === "follower") {
      pl.graveyardFollowers.push(card.cardId);
      pl.destroyedThisTurn.push({
        cardId: card.cardId,
        attack: base.type === "follower" ? base.attack : 0,
        defense: base.type === "follower" ? base.defense : 0,
      });
    } else {
      pl.destroyedAmulets.push(card.cardId);
    }
    for (const ability of ownAbilities(card, "lastWords")) {
      queue(state, ability, newContext(p, card.iid, card.cardId, {
        sourceAttack: card.kind === "follower" ? attackOf(card) : 0,
      }));
    }
  } else if (reason === "bounce") {
    addHandCard(state, p, newHandCard(state, card.cardId));
  }

  if (card.kind === "follower") {
    for (const h of pl.hand) fireHand(state, p, h, "allyLeaveInHand");
  }
}

/** 超進化したフォロワーは持ち主のターン中、効果で破壊されない */
export function immuneToEffectDestroy(state: GameState, f: FollowerOnBoard): boolean {
  return f.evolve === "superEvolved" && findBoard(state, f.iid)?.player === state.active;
}

/** 体力0以下のフォロワーを破壊する（手番のプレイヤーの場から、古い順） */
export function destroyDead(state: GameState): void {
  for (const p of playersInTurnOrder(state)) {
    const dead = state.players[p].board
      .filter((c) => c.kind === "follower" && c.defense <= 0)
      .sort((a, b) => a.order - b.order);
    for (const c of dead) leaveBoard(state, c.iid, "destroy");
  }
}

// ---- ダメージ・回復 ----

/**
 * フォロワーにダメージを与え、実際に与えたダメージを返す。
 * バリアは次のダメージを1回0にする（超進化で0になる場合も消費する）。
 * 超進化したフォロワーは持ち主のターン中、受けるダメージが0になる。
 */
export function damageFollower(state: GameState, f: FollowerOnBoard, amount: number): number {
  if (amount <= 0) return 0;
  if (hasKeyword(f, "barrier")) {
    f.keywords = f.keywords.filter((k) => k !== "barrier");
    f.tempKeywords = f.tempKeywords.filter((k) => k !== "barrier");
    return 0;
  }
  if (f.evolve === "superEvolved" && findBoard(state, f.iid)?.player === state.active) return 0;
  f.defense -= amount;
  return amount;
}

export function damageEntity(state: GameState, id: number, amount: number): void {
  if (amount <= 0) return;
  if (isLeader(id)) {
    state.players[leaderOwner(id)].leaderHp -= amount;
    return;
  }
  const f = findFollower(state, id);
  if (f) damageFollower(state, f.card, amount);
}

export function healLeader(state: GameState, p: PlayerIndex, amount: number): void {
  const pl = state.players[p];
  const healed = Math.min(pl.leaderMaxHp, pl.leaderHp + amount) - pl.leaderHp;
  if (healed <= 0) return;
  pl.leaderHp += healed;
  fireSide(state, p, (trigger) => (trigger.on === "leaderHealed" ? {} : null));
}

// ---- 進化 ----

/** 進化・超進化させる（能力値と状態のみ。誘発は呼び出し側） */
export function evolveFollower(state: GameState, p: PlayerIndex, f: FollowerOnBoard, kind: "evolve" | "superEvolve"): void {
  const bonus = kind === "evolve" ? EVOLVE_BONUS : SUPER_EVOLVE_BONUS;
  f.evolve = kind === "evolve" ? "evolved" : "superEvolved";
  f.attack += bonus;
  f.defense += bonus;
  f.maxDefense += bonus;
  // これが進化したとき（効果による進化を含む）
  for (const ability of ownAbilities(f, "evolved")) queue(state, ability, newContext(p, f.iid, f.cardId));
}

// ---- 公開: 誘発のきっかけ ----

export const fire = {
  turnStart(state: GameState): void {
    fireSide(state, state.active, (t) => (t.on === "turnStart" ? {} : null));
  },
  turnEnd(state: GameState): void {
    const [me, opp] = playersInTurnOrder(state);
    fireSide(state, me, (t) => (t.on === "turnEnd" && t.whose === "self" ? {} : null));
    fireSide(state, opp, (t) => (t.on === "turnEnd" && t.whose === "opponent" ? {} : null));
  },
  allyAct(state: GameState, p: PlayerIndex): void {
    fireSide(state, p, (t) => (t.on === "allyAct" ? {} : null));
  },
  allyFuse(state: GameState, p: PlayerIndex): void {
    fireSide(state, p, (t) => (t.on === "allyFuse" ? {} : null));
  },
  spellboost(state: GameState, p: PlayerIndex, card: HandCard, times: number): void {
    for (let i = 0; i < times; i++) {
      card.boosts++;
      fireHand(state, p, card, "spellboost");
    }
  },
};

/** 能力を直ちに解決スタックに積む（行動による発動） */
export function pushAbilities(state: GameState, abilities: Ability[], ctx: EffectContext): void {
  // 先に書かれた能力から解決するよう、逆順に積む
  for (const a of [...abilities].reverse()) pushFrame(state, a.effects, { ...ctx, slots: {}, vars: { ...ctx.vars } });
}

export function pushInternal(state: GameState, effects: InternalEffect[], ctx: EffectContext): void {
  pushFrame(state, effects, ctx);
}

// ---- 効果の実行 ----

/** 選択された対象を記録して再開する */
export function answerChoose(state: GameState, targets: number[]): void {
  const pending = state.pending;
  const frame = state.stack[state.stack.length - 1];
  if (pending?.kind !== "choose" || !frame) throw new Error("選択待ちではありません");
  frame.ctx.slots[pending.slot] = targets;
  frame.pc++;
  state.pending = null;
}

export function answerMode(state: GameState, index: number): void {
  const pending = state.pending;
  const frame = state.stack[state.stack.length - 1];
  if (pending?.kind !== "mode" || !frame) throw new Error("モード選択待ちではありません");
  const eff = frame.effects[frame.pc];
  if (!eff || eff.op !== "mode") throw new Error("モード選択の効果がありません");
  splice(frame, eff.options[index] ?? []);
  state.pending = null;
}

/** 現在の効果を effects で置き換える（if・repeat 等の展開） */
function splice(frame: Frame, effects: (Effect | InternalEffect)[]): void {
  frame.effects = [...frame.effects.slice(0, frame.pc), ...effects, ...frame.effects.slice(frame.pc + 1)];
}

function pickRandom(state: GameState, ids: number[], count: number): number[] {
  const pool = [...ids];
  shuffle(pool, rngFrom(state));
  return pool.slice(0, count);
}

type InternalHandler = (state: GameState, frame: Frame, eff: InternalEffect) => void;
let internalHandler: InternalHandler | null = null;
/** 内部処理（ターン進行・戦闘）のハンドラを登録する（game.ts から） */
export function setInternalHandler(h: InternalHandler): void {
  internalHandler = h;
}

function sigilAmulet(state: GameState, p: PlayerIndex) {
  const c = state.players[p].board.find((x) => x.kind === "amulet" && x.sigils !== null);
  return c?.kind === "amulet" ? c : null;
}

const EARTH_SIGIL_TOKEN = "90031210"; // 大地の魔片

/** 効果を1つ実行する。選択待ちで中断したら false */
function exec(state: GameState, frame: Frame, eff: Effect | InternalEffect): boolean {
  const ctx = frame.ctx;
  const p = ctx.controller;
  const pl = state.players[p];
  const targets = (t: Target) => resolveTarget(state, ctx, t);
  const val = (v: Value) => evalValue(state, ctx, v);
  const next = () => {
    frame.pc++;
    return true;
  };

  switch (eff.op) {
    case "choose": {
      const candidates = chooseCandidates(state, ctx, eff.from);
      if (candidates.length <= eff.count) {
        ctx.slots[eff.slot] = candidates;
        return next();
      }
      state.pending = { kind: "choose", player: p, slot: eff.slot, candidates, count: eff.count };
      return false;
    }
    case "random":
      ctx.slots[eff.slot] = pickRandom(state, targets(eff.from), eff.count);
      return next();
    case "mode":
      state.pending = { kind: "mode", player: p, options: eff.options.length };
      return false;

    case "damage": {
      const amount = val(eff.amount);
      for (const id of targets(eff.target)) damageEntity(state, id, amount);
      return next();
    }
    case "distribute": {
      // 古いフォロワーから順に、その体力と同じ値を割り当てる。ダメージは同時に与える
      let rest = val(eff.amount);
      const plan: [FollowerOnBoard, number][] = [];
      const fs = targets(eff.target)
        .map((id) => findFollower(state, id)?.card)
        .filter((f): f is FollowerOnBoard => f !== undefined)
        .sort((a, b) => a.order - b.order);
      for (const f of fs) {
        if (rest <= 0) break;
        const n = Math.min(rest, Math.max(0, f.defense));
        plan.push([f, n]);
        rest -= n;
      }
      for (const [f, n] of plan) damageFollower(state, f, n);
      return next();
    }
    case "destroy": {
      let count = 0;
      for (const id of targets(eff.target)) {
        const hit = findBoard(state, id);
        if (!hit) continue;
        if (hit.card.kind === "follower" && immuneToEffectDestroy(state, hit.card)) continue;
        leaveBoard(state, id, "destroy");
        count++;
      }
      if (eff.countVar) ctx.vars[eff.countVar] = count;
      return next();
    }
    case "banish":
      for (const id of targets(eff.target)) leaveBoard(state, id, "banish");
      return next();
    case "bounce":
      for (const id of targets(eff.target)) leaveBoard(state, id, "bounce");
      return next();
    case "heal": {
      const amount = val(eff.amount);
      for (const id of targets(eff.target)) if (isLeader(id)) healLeader(state, leaderOwner(id), amount);
      return next();
    }
    case "setDefense":
      for (const id of targets(eff.target)) {
        const f = findFollower(state, id)?.card;
        if (f) {
          f.defense = eff.value;
          f.maxDefense = eff.value;
        }
      }
      return next();

    case "draw":
      if (eff.filter) {
        const filter = eff.filter;
        drawCards(state, p, val(eff.count), (ref) => deckCardMatches(state, ctx, ref.cardId, filter));
      } else {
        drawCards(state, p, val(eff.count));
      }
      return next();
    case "drawAll": {
      const filter = eff.filter;
      const n = pl.deck.filter((r) => deckCardMatches(state, ctx, r.cardId, filter)).length;
      const drawn = drawCards(state, p, n, (ref) => deckCardMatches(state, ctx, ref.cardId, filter));
      if (eff.slot) ctx.slots[eff.slot] = drawn;
      return next();
    }
    case "addToHand":
      for (let i = 0; i < val(eff.count); i++) addHandCard(state, p, newHandCard(state, eff.cardId));
      return next();
    case "summon": {
      const ids: number[] = [];
      for (let i = 0; i < val(eff.count); i++) {
        const card = newBoardCard(state, eff.cardId);
        if (!enterBoard(state, p, card)) break;
        ids.push(card.iid);
      }
      if (eff.slot) ctx.slots[eff.slot] = ids;
      return next();
    }
    case "summonCopy": {
      const ids: number[] = [];
      for (const id of ctx.slots[eff.from] ?? []) {
        const src = findHand(state, id)?.card ?? findBoard(state, id)?.card;
        if (!src) continue;
        const card = newBoardCard(state, src.cardId);
        if (enterBoard(state, p, card)) ids.push(card.iid);
      }
      if (eff.slot) ctx.slots[eff.slot] = ids;
      return next();
    }
    case "reanimate": {
      const costs = pl.graveyardFollowers.map((id) => ({ id, cost: cardOf(id).cost })).filter((x) => x.cost <= eff.cost);
      if (costs.length > 0) {
        const max = Math.max(...costs.map((x) => x.cost));
        const best = [...new Set(costs.filter((x) => x.cost === max).map((x) => x.id))];
        const chosen = best[rngFrom(state).int(best.length)];
        if (chosen) enterBoard(state, p, newBoardCard(state, chosen));
      }
      return next();
    }
    case "summonFromDeck": {
      const kinds = [...new Set(pl.deck.map((r) => r.cardId).filter((id) => deckCardMatches(state, ctx, id, eff.filter)))];
      shuffle(kinds, rngFrom(state));
      for (const cardId of kinds.slice(0, eff.kinds)) {
        if (!canAddToBoard(state, p)) break;
        const idx = pl.deck.findIndex((r) => r.cardId === cardId);
        const ref = pl.deck.splice(idx, 1)[0];
        if (ref) enterBoard(state, p, newBoardCard(state, ref.cardId, newHandCard(state, ref.cardId, ref.iid)));
      }
      return next();
    }
    case "summonDestroyedAmulet": {
      if (pl.destroyedAmulets.length > 0) {
        const max = Math.max(...pl.destroyedAmulets.map((id) => cardOf(id).cost));
        const best = [...new Set(pl.destroyedAmulets.filter((id) => cardOf(id).cost === max))];
        const chosen = best[rngFrom(state).int(best.length)];
        if (chosen) enterBoard(state, p, newBoardCard(state, chosen));
      }
      return next();
    }
    case "returnToDeck": {
      const ids = targets(eff.target);
      for (const id of ids) {
        const h = findHand(state, id);
        if (!h) continue;
        const hp = state.players[h.player];
        hp.hand = hp.hand.filter((c) => c.iid !== id);
        hp.deck.push({ iid: h.card.iid, cardId: h.card.cardId });
      }
      if (ids.length > 0) shuffle(pl.deck, rngFrom(state));
      return next();
    }
    case "discard":
      for (const id of targets(eff.target)) {
        const h = findHand(state, id);
        if (!h) continue;
        ctx.vars[`cost:${slotOf(eff.target)}`] = handCost(h.card);
        const hp = state.players[h.player];
        hp.hand = hp.hand.filter((c) => c.iid !== id);
        hp.graveyard++;
        for (const ability of ownAbilities(h.card.cardId, "discarded")) {
          queue(state, ability, newContext(h.player, h.card.iid, h.card.cardId));
        }
      }
      return next();
    case "transform":
      for (const id of targets(eff.target)) transform(state, id, eff.cardId);
      return next();

    case "buff": {
      const a = val(eff.attack);
      const d = val(eff.defense);
      for (const id of targets(eff.target)) {
        const f = findFollower(state, id)?.card;
        if (f) {
          if (eff.duration === "endOfTurn") f.tempAttack += a;
          else f.attack = Math.max(0, f.attack + a);
          f.defense += d;
          f.maxDefense += d;
          continue;
        }
        const h = findHand(state, id)?.card;
        if (h) {
          h.attackMod += a;
          h.defenseMod += d;
        }
      }
      return next();
    }
    case "grant":
      for (const id of targets(eff.target)) {
        const b = findBoard(state, id)?.card;
        if (b) {
          const list = eff.duration === "endOfTurn" ? b.tempKeywords : b.keywords;
          for (const k of eff.keywords ?? []) if (!list.includes(k)) list.push(k);
          if (b.kind === "follower" && eff.maxAttacks !== undefined) b.maxAttacks = Math.max(b.maxAttacks, eff.maxAttacks);
          if (eff.abilities) b.granted.push(...eff.abilities);
          continue;
        }
        const h = findHand(state, id)?.card;
        if (h) for (const k of eff.keywords ?? []) if (!h.keywords.includes(k)) h.keywords.push(k);
      }
      return next();
    case "loseKeyword":
      for (const id of targets(eff.target)) {
        const b = findBoard(state, id)?.card;
        if (b) {
          b.keywords = b.keywords.filter((k) => k !== eff.keyword);
          b.tempKeywords = b.tempKeywords.filter((k) => k !== eff.keyword);
        }
      }
      return next();
    case "cannotAttack":
      for (const id of targets(eff.target)) {
        const f = findFollower(state, id)?.card;
        if (f) f.cannotAttackUntil = state.turn + 1;
      }
      return next();
    case "evolve":
      for (const id of targets(eff.target)) {
        const hit = findFollower(state, id);
        if (hit && hit.card.evolve === "none") evolveFollower(state, hit.player, hit.card, eff.kind);
      }
      return next();

    case "spellboost":
      for (const id of targets(eff.target)) {
        const h = findHand(state, id);
        if (h) fire.spellboost(state, h.player, h.card, eff.times);
      }
      return next();
    case "costChange":
      for (const id of targets(eff.target)) {
        const h = findHand(state, id)?.card;
        if (h) h.costMod += eff.amount;
      }
      return next();
    case "addX":
      for (const id of targets(eff.target)) {
        const c = findHand(state, id)?.card ?? findFollower(state, id)?.card;
        if (c) c.x = (c.x ?? 0) + eff.amount;
      }
      return next();
    case "countdown":
      for (const id of targets(eff.target)) {
        const a = findBoard(state, id)?.card;
        if (a?.kind === "amulet" && a.countdown !== null) {
          a.countdown += eff.amount;
          if (a.countdown <= 0) leaveBoard(state, id, "destroy");
        }
      }
      return next();

    case "gainPp":
      // 回復は PP最大値まで。エクストラPPで最大値を超えている場合は減らさない
      pl.pp = Math.max(pl.pp, eff.amount === "max" ? pl.maxPp : Math.min(pl.maxPp, pl.pp + val(eff.amount)));
      return next();
    case "addMaxPp":
      pl.maxPp = Math.min(MAX_PP, pl.maxPp + eff.amount);
      return next();
    case "addCombo":
      pl.combo += eff.amount;
      return next();
    case "addGraveyard":
      pl.graveyard += eff.amount;
      return next();
    case "addSigils": {
      const n = val(eff.amount);
      const s = sigilAmulet(state, p);
      if (s) s.sigils = (s.sigils ?? 0) + n;
      else if (canAddToBoard(state, p)) {
        const card = newBoardCard(state, EARTH_SIGIL_TOKEN);
        if (card.kind === "amulet") card.sigils = n;
        enterBoard(state, p, card);
      }
      return next();
    }
    case "earthRite": {
      const s = sigilAmulet(state, p);
      if (s && (s.sigils ?? 0) >= eff.amount) {
        s.sigils = (s.sigils ?? 0) - eff.amount;
        splice(frame, eff.then);
        return true;
      }
      return next();
    }
    case "necromancy":
      if (pl.graveyard >= eff.amount) {
        pl.graveyard -= eff.amount;
        splice(frame, eff.then);
        return true;
      }
      return next();
    case "crest": {
      const holder = eff.side === "self" ? p : opponent(p);
      const crest = crestOf(eff.crestId);
      if (!CREST_ABILITIES[eff.crestId]) throw new Error(`クレストの能力が未定義: ${eff.crestId}`);
      state.players[holder].crests.push({
        iid: state.nextIid++,
        crestId: eff.crestId,
        countdown: crest.countdown ?? null,
        order: state.nextOrder++,
        usedOncePerTurn: {},
      });
      return next();
    }
    case "apocalypseDeck":
      pl.deck = APOCALYPSE_DECK.flatMap(([cardId, n]) =>
        Array.from({ length: n }, () => ({ iid: state.nextIid++, cardId })),
      );
      shuffle(pl.deck, rngFrom(state));
      return next();
    case "setLeaderMaxHp": {
      const target = state.players[eff.side === "self" ? p : opponent(p)];
      target.leaderMaxHp = eff.value;
      target.leaderHp = Math.min(target.leaderHp, eff.value);
      return next();
    }

    case "if":
      splice(frame, evalCond(state, ctx, eff.cond) ? eff.then : (eff.else ?? []));
      return true;
    case "repeat": {
      const n = val(eff.times);
      splice(frame, Array.from({ length: n }, () => eff.effects).flat());
      return true;
    }
    case "setVar":
      ctx.vars[eff.name] = val(eff.value);
      return next();

    default:
      if (!internalHandler) throw new Error("内部処理のハンドラが未登録です");
      frame.pc++;
      internalHandler(state, frame, eff);
      return true;
  }
}

function slotOf(t: Target): string {
  return t.kind === "slot" ? t.slot : "_";
}

function deckCardMatches(state: GameState, ctx: EffectContext, cardId: string, f: CardFilter): boolean {
  const card = cardOf(cardId);
  if (f.type && card.type !== f.type) return false;
  if (f.tribe && !(card.tribes ?? []).includes(f.tribe)) return false;
  if (f.class && card.class !== f.class) return false;
  if (f.ids && !f.ids.includes(cardId)) return false;
  if (f.costMax !== undefined && card.cost > f.costMax) return false;
  if (f.costEq !== undefined && card.cost !== evalValue(state, ctx, f.costEq)) return false;
  return true;
}

function transform(state: GameState, id: number, cardId: string): void {
  const b = findBoard(state, id);
  if (b) {
    const pl = state.players[b.player];
    const fresh = newBoardCard(state, cardId);
    fresh.iid = b.card.iid;
    fresh.order = b.card.order;
    if (fresh.kind === "follower" && b.card.kind === "follower") fresh.enteredTurn = b.card.enteredTurn;
    pl.board = pl.board.map((c) => (c.iid === id ? fresh : c));
    return;
  }
  const h = findHand(state, id);
  if (h) {
    const pl = state.players[h.player];
    pl.hand = pl.hand.map((c) => (c.iid === id ? newHandCard(state, cardId, id) : c));
  }
}

/** 解決スタックと誘発待ちを、選択待ちか空になるまで実行する */
export function run(state: GameState): void {
  while (state.phase !== "ended" && state.pending === null) {
    const frame = state.stack[state.stack.length - 1];
    if (!frame) {
      const q = state.queue.shift();
      if (!q) break;
      pushFrame(state, q.ability.effects, q.ctx);
      continue;
    }
    if (frame.pc >= frame.effects.length) {
      state.stack.pop();
      // 能力の解決が1つ終わったら、誘発待ち（FIFO）から1つ取り出して解決する。
      // 誘発待ちが空になってから外側の処理（戦闘、ターン進行など）の続きに戻る
      const q = state.queue.shift();
      if (q) pushFrame(state, q.ability.effects, q.ctx);
      continue;
    }
    const eff = frame.effects[frame.pc];
    if (!eff) break;
    if (!exec(state, frame, eff)) break;
    destroyDead(state);
    checkLeaders(state);
  }
  if (state.phase === "ended") {
    state.stack = [];
    state.queue = [];
    state.pending = null;
  }
}

export { lose };
