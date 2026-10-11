// 状態の参照・変更の基本操作（能力の解釈と行動の両方から使う）

import {
  BOARD_LIMIT,
  EVOLVE_TURN,
  HAND_LIMIT,
  SUPER_EVOLVE_TURN,
} from "./constants";
import type { Ability } from "./dsl";
import { abilitiesOf, cardOf, crestAbilitiesOf, staticOf } from "./registry";
import type {
  AmuletOnBoard,
  CardRef,
  CrestInstance,
  EffectContext,
  FollowerOnBoard,
  GameState,
  HandCard,
  OnBoard,
  PlayerIndex,
  StaticKeyword,
} from "./types";

export const opponent = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

/** リーダーの実体ID */
export const leaderId = (p: PlayerIndex): number => -(p + 1);
export const isLeader = (id: number): boolean => id < 0;
export const leaderOwner = (id: number): PlayerIndex => (id === -1 ? 0 : 1);

/** 手番のプレイヤーから順に */
export const playersInTurnOrder = (state: GameState): [PlayerIndex, PlayerIndex] => [
  state.active,
  opponent(state.active),
];

export function lose(state: GameState, loser: PlayerIndex): void {
  if (state.phase === "ended") return;
  state.phase = "ended";
  state.winner = opponent(loser);
  state.stack = [];
  state.queue = [];
  state.pending = null;
}

/** 両リーダーの体力を確認し、0以下なら決着させる。同時なら手番のプレイヤーの敗北。 */
export function checkLeaders(state: GameState): void {
  const dead = ([0, 1] as const).filter((p) => state.players[p].leaderHp <= 0);
  if (dead.length === 2) lose(state, state.active);
  else if (dead[0] !== undefined) lose(state, dead[0]);
}

// ---- 検索 ----

export interface BoardHit {
  player: PlayerIndex;
  card: OnBoard;
}

export function findBoard(state: GameState, iid: number): BoardHit | null {
  for (const p of [0, 1] as const) {
    const card = state.players[p].board.find((c) => c.iid === iid);
    if (card) return { player: p, card };
  }
  return null;
}

export function findFollower(state: GameState, iid: number): (BoardHit & { card: FollowerOnBoard }) | null {
  const hit = findBoard(state, iid);
  return hit && hit.card.kind === "follower" ? { player: hit.player, card: hit.card } : null;
}

export function findHand(state: GameState, iid: number): { player: PlayerIndex; card: HandCard } | null {
  for (const p of [0, 1] as const) {
    const card = state.players[p].hand.find((c) => c.iid === iid);
    if (card) return { player: p, card };
  }
  return null;
}

export function findCrest(state: GameState, iid: number): { player: PlayerIndex; crest: CrestInstance } | null {
  for (const p of [0, 1] as const) {
    const crest = state.players[p].crests.find((c) => c.iid === iid);
    if (crest) return { player: p, crest };
  }
  return null;
}

// ---- カードの性質 ----

export function keywordsOf(c: OnBoard): StaticKeyword[] {
  return c.tempKeywords.length > 0 ? [...c.keywords, ...c.tempKeywords] : c.keywords;
}

export const hasKeyword = (c: OnBoard, kw: StaticKeyword): boolean =>
  c.keywords.includes(kw) || c.tempKeywords.includes(kw);

export const attackOf = (f: FollowerOnBoard): number => Math.max(0, f.attack + f.tempAttack);

/** 場のカードの能力（カード固有＋付与） */
export function boardAbilities(c: OnBoard): Ability[] {
  const own = abilitiesOf(c.cardId).abilities;
  return c.granted.length > 0 ? [...own, ...c.granted] : own;
}

export function handCost(h: HandCard): number {
  return Math.max(0, cardOf(h.cardId).cost + h.costMod);
}

export function evolveTurnReached(state: GameState, p: PlayerIndex): boolean {
  const order = p === state.first ? 0 : 1;
  return state.players[p].turnCount >= EVOLVE_TURN[order];
}

export function superEvolveTurnReached(state: GameState, p: PlayerIndex): boolean {
  const order = p === state.first ? 0 : 1;
  return state.players[p].turnCount >= SUPER_EVOLVE_TURN[order];
}

// ---- 生成 ----

export function newIid(state: GameState): number {
  return state.nextIid++;
}

export function newHandCard(state: GameState, cardId: string, iid = newIid(state)): HandCard {
  return {
    iid,
    cardId,
    costMod: 0,
    attackMod: 0,
    defenseMod: 0,
    boosts: 0,
    x: abilitiesOf(cardId).initialX ?? null,
    keywords: [],
    fusedKinds: [],
    fusedThisTurn: false,
  };
}

/** 場に出すカードの実体を作る（手札からなら手札での変化を引き継ぐ） */
export function newBoardCard(state: GameState, cardId: string, from?: HandCard): OnBoard {
  const card = cardOf(cardId);
  const st = staticOf(cardId);
  const keywords = [...st.keywords];
  for (const k of from?.keywords ?? []) if (!keywords.includes(k)) keywords.push(k);
  const base = {
    iid: from?.iid ?? newIid(state),
    cardId,
    keywords,
    tempKeywords: [],
    granted: [],
    order: state.nextOrder++,
  };
  if (card.type === "follower") {
    const defense = Math.max(0, card.defense + (from?.defenseMod ?? 0));
    return {
      ...base,
      kind: "follower",
      attack: Math.max(0, card.attack + (from?.attackMod ?? 0)),
      defense,
      maxDefense: defense,
      tempAttack: 0,
      maxAttacks: st.maxAttacks,
      attacksThisTurn: 0,
      enteredTurn: state.turn,
      evolve: "none",
      cannotAttackUntil: null,
      x: from?.x ?? abilitiesOf(cardId).initialX ?? null,
      usedOncePerTurn: {},
    };
  }
  const amulet: AmuletOnBoard = {
    ...base,
    kind: "amulet",
    countdown: card.type === "amulet" ? (card.countdown ?? null) : null,
    sigils: st.earthSigil ? 1 : null,
    actedThisTurn: false,
  };
  return amulet;
}

/** 手札に加える。上限なら墓場へ（リアニメイトの対象にはならない）。加えたら true */
export function addHandCard(state: GameState, p: PlayerIndex, card: HandCard): boolean {
  const pl = state.players[p];
  if (pl.hand.length >= HAND_LIMIT) {
    pl.graveyard++;
    return false;
  }
  pl.hand.push(card);
  return true;
}

/** 山札から引く。filter 付きは該当カードが無ければ何もしない。山札切れで敗北。引いた手札の iid を返す */
export function drawCards(
  state: GameState,
  p: PlayerIndex,
  n: number,
  filter?: (ref: CardRef) => boolean,
): number[] {
  const pl = state.players[p];
  const drawn: number[] = [];
  for (let i = 0; i < n && state.phase !== "ended"; i++) {
    let ref: CardRef | undefined;
    if (filter) {
      const idx = pl.deck.findIndex(filter);
      if (idx < 0) break;
      ref = pl.deck.splice(idx, 1)[0];
    } else {
      ref = pl.deck.shift();
      if (!ref) {
        lose(state, p);
        break;
      }
    }
    if (ref && addHandCard(state, p, newHandCard(state, ref.cardId, ref.iid))) drawn.push(ref.iid);
  }
  return drawn;
}

export function canAddToBoard(state: GameState, p: PlayerIndex): boolean {
  return state.players[p].board.length < BOARD_LIMIT;
}

/** 文脈の雛形 */
export function newContext(
  controller: PlayerIndex,
  source: number,
  sourceCardId: string,
  extra: Partial<EffectContext> = {},
): EffectContext {
  return {
    controller,
    source,
    sourceCardId,
    event: null,
    slots: {},
    vars: {},
    enhanced: false,
    sourceX: null,
    sourceAttack: 0,
    ...extra,
  };
}

/** 誘発条件に合う能力を持つ場のカード・クレストを、クレスト（古い順）→場（古い順）で列挙する */
export function crestsAndBoard(
  state: GameState,
  p: PlayerIndex,
): ({ kind: "crest"; crest: CrestInstance; abilities: Ability[] } | { kind: "board"; card: OnBoard; abilities: Ability[] })[] {
  const pl = state.players[p];
  const crests = [...pl.crests]
    .sort((a, b) => a.order - b.order)
    .map((crest) => ({ kind: "crest" as const, crest, abilities: crestAbilitiesOf(crest.crestId) }));
  const board = [...pl.board]
    .sort((a, b) => a.order - b.order)
    .map((card) => ({ kind: "board" as const, card, abilities: boardAbilities(card) }));
  return [...crests, ...board];
}
