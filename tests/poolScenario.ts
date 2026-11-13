// 前期のローテーションのカード能力のシナリオテストの補助（tests/pool-abilities*.test.ts）。
// 局面のカードは前期のローテーションのカードの表から作る（src/engine の newHandCard・newBoardCard はスターターのカードだけを知っている）。

import { CARD_ABILITIES } from "../src/cards/abilities";
import { AZVALDT_CARD_ABILITIES, id } from "../src/cards/abilities/azvaldt";
import { ENGINE_CARDS } from "../src/cards/pools";
import {
  applyAction,
  createGame,
  legalActions,
  staticInfoOf,
  type Action,
  type AmuletOnBoard,
  type FollowerOnBoard,
  type GameState,
  type HandCard,
  type OnBoard,
  type PlayerIndex,
} from "../src/engine";

export const CARD = new Map(ENGINE_CARDS.map((c) => [c.id, c]));
export const nameOf = (cardId: string) => CARD.get(cardId)?.name;
const initialX = (cardId: string) => (AZVALDT_CARD_ABILITIES[cardId] ?? CARD_ABILITIES[cardId])?.initialX ?? null;
export const FILLER = id("キャラバンマンモス");

/** マリガン後、先攻のターン中の状態。手札は空、PP は 10 */
export function setup(seed = 1): { s: GameState; me: PlayerIndex; opp: PlayerIndex } {
  let s = createGame({ decks: [Array(40).fill(FILLER), Array(40).fill(FILLER)], seed });
  s = applyAction(s, { type: "mulligan", player: s.first, swap: [] });
  s = applyAction(s, { type: "mulligan", player: (1 - s.first) as PlayerIndex, swap: [] });
  const me = s.active;
  const opp = (1 - me) as PlayerIndex;
  s.players[me].hand = [];
  s.players[opp].hand = [];
  s.players[me].pp = s.players[me].maxPp = 10;
  return { s, me, opp };
}

export function toHand(s: GameState, p: PlayerIndex, name: string, opts: Partial<HandCard> = {}): number {
  const cardId = id(name);
  const h: HandCard = {
    iid: s.nextIid++,
    cardId,
    costMod: 0,
    attackMod: 0,
    defenseMod: 0,
    boosts: 0,
    x: initialX(cardId),
    keywords: [],
    fusedKinds: [],
    fusedThisTurn: false,
    revealed: false,
    drawnBy: null,
    ...opts,
  };
  s.players[p].hand.push(h);
  return h.iid;
}

export function toBoard(s: GameState, p: PlayerIndex, name: string, opts: Partial<FollowerOnBoard> = {}): OnBoard {
  const cardId = id(name);
  const card = CARD.get(cardId)!;
  const st = staticInfoOf(card.text);
  const base = { iid: s.nextIid++, cardId, keywords: [...st.keywords], tempKeywords: [], granted: [], order: s.nextOrder++ };
  const c: OnBoard =
    card.type === "follower"
      ? {
          ...base,
          kind: "follower",
          attack: card.attack,
          defense: card.defense,
          maxDefense: card.defense,
          tempAttack: 0,
          maxAttacks: st.maxAttacks,
          attacksThisTurn: 0,
          enteredTurn: 0,
          evolve: "none",
          cannotAttackUntil: null,
          x: initialX(cardId),
          usedOncePerTurn: {},
          ...opts,
        }
      : {
          ...base,
          kind: "amulet",
          countdown: card.type === "amulet" ? (card.countdown ?? null) : null,
          sigils: null,
          actedThisTurn: false,
        };
  s.players[p].board.push(c);
  return c;
}

export const play = (s: GameState, iid: number) => applyAction(s, { type: "play", iid });
export const can = (s: GameState, a: Action) => legalActions(s).some((x) => JSON.stringify(x) === JSON.stringify(a));
export const board = (s: GameState, p: PlayerIndex) => s.players[p].board;
export const names = (s: GameState, p: PlayerIndex) => board(s, p).map((c) => nameOf(c.cardId));
export const handNames = (s: GameState, p: PlayerIndex) => s.players[p].hand.map((c) => nameOf(c.cardId));
export const follower = (s: GameState, iid: number) =>
  [...s.players[0].board, ...s.players[1].board].find((c) => c.iid === iid) as FollowerOnBoard | undefined;
export const amulet = (s: GameState, iid: number) =>
  [...s.players[0].board, ...s.players[1].board].find((c) => c.iid === iid) as AmuletOnBoard | undefined;

/** 自分のターンを n 回進める（相手は何もしない） */
export function passTurns(s: GameState, n: number): GameState {
  for (let i = 0; i < n; i++) s = applyAction(applyAction(s, { type: "endTurn" }), { type: "endTurn" });
  return s;
}
