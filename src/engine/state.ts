// 状態を参照する基本操作と、カードの実体の作り方（画面とテストで局面を組むときに使う）。
// ルールの処理は Rust のエンジン（rust/engine）が行う。ここにあるものは Rust 版の同じ名前の関数と同じ結果になるようにする。

import { EVOLVE_TURN, SUPER_EVOLVE_TURN } from "./constants";
import { abilitiesOf, cardOf, staticOf } from "./registry";
import type { AmuletOnBoard, GameState, HandCard, OnBoard, PlayerIndex } from "./types";

export const opponent = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

/** リーダーの実体ID */
export const leaderId = (p: PlayerIndex): number => -(p + 1);

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

export function findHand(state: GameState, iid: number): { player: PlayerIndex; card: HandCard } | null {
  for (const p of [0, 1] as const) {
    const card = state.players[p].hand.find((c) => c.iid === iid);
    if (card) return { player: p, card };
  }
  return null;
}

// ---- カードの性質 ----

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
    revealed: false,
    drawnBy: null,
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

