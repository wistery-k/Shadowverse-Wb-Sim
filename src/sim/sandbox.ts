// サンドボックス: 局面（盤面・手札・山札・リーダー）を手で編集する関数。画面は src/ui/Sandbox.tsx。
// どれも引数の局面を変えず、編集した新しい局面を返す。カードを場に置く・手札に加えるときに能力（ファンファーレ等）は発動しない。
// 編集できない操作（場・手札が上限など）は SandboxError を投げる。

import { CRESTS_BY_ID } from "../cards";
import {
  applyAction,
  cardOf,
  BOARD_LIMIT,
  createGame,
  EVOLVE_BONUS,
  HAND_LIMIT,
  invariantViolations,
  legalActions,
  MAX_PP,
  newBoardCard,
  newHandCard,
  opponent,
  rngFrom,
  shuffle,
  staticOf,
  SUPER_EVOLVE_BONUS,
  type AmuletOnBoard,
  type DeckCard,
  type EvolveState,
  type FollowerOnBoard,
  type GameState,
  type HandCard,
  type OnBoard,
  type PlayerIndex,
  type PlayerState,
} from "../engine";
import { callEngine } from "../engine/wasm";

/** サンドボックスでできない編集 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** 局面を複製して f で書き換えた局面（f は複製を書き換える） */
export function edit(state: GameState, f: (s: GameState) => void): GameState {
  const s = structuredClone(state);
  f(s);
  return s;
}

/**
 * 新しい局面: 両者のデッキで対戦を始め、どちらも入れ替えなしでマリガンを済ませた、先攻の 1 ターン目。
 * 先攻はシードで決まるので、first が先攻になるまでシードを進める
 */
export function newSandbox(decks: [readonly string[], readonly string[]], first: PlayerIndex, seed: number): GameState {
  let s = seed >>> 0;
  let state = createGame({ decks, seed: s });
  while (state.first !== first) {
    s = (s + 1) >>> 0;
    state = createGame({ decks, seed: s });
  }
  for (const p of [first, opponent(first)]) state = applyAction(state, { type: "mulligan", player: p, swap: [] });
  return state;
}

/** 編集できない局面なら、その理由 */
export function editBlocker(state: GameState): string | null {
  if (state.phase === "mulligan") return "マリガン中の局面は編集できません（マリガンを打つと編集できます）";
  if (state.phase === "ended") return "決着した局面は編集できません（「戻す」で前の局面に戻れます）";
  if (state.pending || state.stack.length > 0 || state.queue.length > 0) {
    return "能力の解決の途中（対象・モードの選択待ち）の局面は編集できません（選択を打つと編集できます）";
  }
  return null;
}

/** 局面の問題（不変条件を満たさない・エンジンが読めない）。空なら問題なし */
export function sandboxProblems(state: GameState): string[] {
  const v = invariantViolations(state);
  try {
    legalActions(state);
  } catch (e) {
    v.push(`エンジンが局面を読めません: ${String(e)}`);
  }
  return v;
}

// ---- 手番・ターン ----

/**
 * ターンの初めの局面にする: 手番を active にし、手番のプレイヤーの ownTurn ターン目（全体のターン・両者のターン数を先攻・後攻から合わせる）にする。
 * このターンに行ったこと（攻撃・進化・コンボ・アクト・ターン終了までの効果）は消す。
 * このターンに場に出たフォロワーは新しいターンでも「このターンに出た」ままにする。
 * resetPp なら両者の PP 最大値をターン数（上限 10）にし、手番のプレイヤーの PP を最大まで回復する
 */
export function setTurn(state: GameState, active: PlayerIndex, ownTurn: number, resetPp: boolean): GameState {
  if (!Number.isInteger(ownTurn) || ownTurn < 1) throw new SandboxError("ターン数は 1 以上");
  return edit(state, (s) => {
    const oldTurn = s.turn;
    const other = opponent(active);
    s.active = active;
    s.players[active].turnCount = ownTurn;
    s.players[other].turnCount = active === s.first ? ownTurn - 1 : ownTurn;
    s.turn = active === s.first ? ownTurn * 2 - 1 : ownTurn * 2;
    for (const p of [0, 1] as const) {
      const pl = s.players[p];
      if (resetPp) {
        pl.maxPp = Math.min(MAX_PP, pl.turnCount);
        pl.pp = pl.maxPp;
      }
      pl.combo = 0;
      pl.evolvedThisTurn = false;
      pl.epEvolvedThisTurn = null;
      pl.sepEvolvedThisTurn = null;
      pl.destroyedThisTurn = [];
      pl.leaderOncePerTurn = {};
      for (const c of pl.crests) c.usedOncePerTurn = {};
      for (const c of pl.board) {
        c.tempKeywords = [];
        if (c.kind === "follower") {
          c.tempAttack = 0;
          c.attacksThisTurn = 0;
          c.usedOncePerTurn = {};
          c.enteredTurn = c.enteredTurn === oldTurn ? s.turn : Math.min(c.enteredTurn, s.turn - 1);
          if (c.cannotAttackUntil !== null && c.cannotAttackUntil < s.turn) c.cannotAttackUntil = null;
        } else {
          c.actedThisTurn = false;
        }
      }
    }
  });
}

// ---- カード ----

/** 実体の場所 */
export type Place =
  | { zone: "hand"; player: PlayerIndex; index: number; card: HandCard }
  | { zone: "board"; player: PlayerIndex; index: number; card: OnBoard }
  | { zone: "deck"; player: PlayerIndex; index: number; card: DeckCard };

export function findCard(state: GameState, iid: number): Place | null {
  for (const player of [0, 1] as const) {
    const pl = state.players[player];
    let index = pl.hand.findIndex((c) => c.iid === iid);
    if (index >= 0) return { zone: "hand", player, index, card: pl.hand[index]! };
    index = pl.board.findIndex((c) => c.iid === iid);
    if (index >= 0) return { zone: "board", player, index, card: pl.board[index]! };
    index = pl.deck.findIndex((c) => c.iid === iid);
    if (index >= 0) return { zone: "deck", player, index, card: pl.deck[index]! };
  }
  return null;
}

/** 山札から cardId を 1 枚抜く（無ければ null）。上（先頭）から探す */
function takeFromDeck(pl: PlayerState, cardId: string): DeckCard | null {
  const i = pl.deck.findIndex((c) => c.cardId === cardId);
  return i < 0 ? null : pl.deck.splice(i, 1)[0]!;
}

/** 山札のカードを手札のカードにする（手札での状態を持っていればそのまま） */
function deckToHand(s: GameState, c: DeckCard): HandCard {
  return c.kept ? structuredClone(c.kept) : newHandCard(s, c.cardId, c.iid);
}

function checkBoardRoom(s: GameState, p: PlayerIndex, cardId: string): void {
  const card = cardOf(cardId);
  if (card.type === "spell") throw new SandboxError(`${card.name}はスペルなので場に出せません`);
  if (s.players[p].board.length >= BOARD_LIMIT) throw new SandboxError(`場が上限（${BOARD_LIMIT} 枚）です`);
  if (staticOf(cardId).earthSigil && s.players[p].board.some((c) => c.kind === "amulet" && c.sigils !== null)) {
    throw new SandboxError("【土の印】のアミュレットは場に 1 つまでです（印の数を編集してください）");
  }
}

/** 場に置くカード。フォロワーは攻撃できる状態（前のターンから場にいる）にする */
function placeOnBoard(s: GameState, p: PlayerIndex, cardId: string, from?: HandCard): OnBoard {
  const b = newBoardCard(s, cardId, from);
  if (b.kind === "follower") b.enteredTurn = s.turn - 1;
  s.players[p].board.push(b);
  return b;
}

/** cardId を手札に加える。fromDeck なら山札にあればそれを取る（無ければ新しく作る） */
export function addToHand(state: GameState, p: PlayerIndex, cardId: string, fromDeck: boolean): GameState {
  cardOf(cardId);
  if (state.players[p].hand.length >= HAND_LIMIT) throw new SandboxError(`手札が上限（${HAND_LIMIT} 枚）です`);
  return edit(state, (s) => {
    const taken = fromDeck ? takeFromDeck(s.players[p], cardId) : null;
    s.players[p].hand.push(taken ? deckToHand(s, taken) : newHandCard(s, cardId));
  });
}

/** cardId を場に置く（能力は発動しない）。fromDeck なら山札にあればそれを取る（無ければ新しく作る） */
export function addToBoard(state: GameState, p: PlayerIndex, cardId: string, fromDeck: boolean): GameState {
  checkBoardRoom(state, p, cardId);
  return edit(state, (s) => {
    const taken = fromDeck ? takeFromDeck(s.players[p], cardId) : null;
    placeOnBoard(s, p, cardId, taken ? deckToHand(s, taken) : undefined);
  });
}

/** cardId を山札の上（先頭）に加える */
export function addToDeck(state: GameState, p: PlayerIndex, cardId: string): GameState {
  cardOf(cardId);
  return edit(state, (s) => {
    s.players[p].deck.unshift({ iid: s.nextIid++, cardId });
  });
}

/** 山札の cardId を 1 枚取り除く */
export function removeFromDeck(state: GameState, p: PlayerIndex, cardId: string): GameState {
  return edit(state, (s) => {
    if (!takeFromDeck(s.players[p], cardId)) throw new SandboxError("山札にないカードです");
  });
}

export function shuffleDeck(state: GameState, p: PlayerIndex, seed: number): GameState {
  return edit(state, (s) => shuffle(s.players[p].deck, rngFrom({ rng: seed >>> 0 })));
}

/**
 * 手札・場のカードを移す。
 * hand: 場のカードを手札に戻す（相手にも分かるカードになる） / board: 手札のカードを場に置く（能力は発動しない） /
 * deck: 山札の上に戻す（手札での状態は消える） / graveyard: 墓場に置く（墓場のカウントを 1 増やす。場のフォロワーはリアニメイトの対象になる） /
 * none: 跡を残さず消す
 */
export function moveCard(state: GameState, iid: number, to: "hand" | "board" | "deck" | "graveyard" | "none"): GameState {
  const at = findCard(state, iid);
  if (!at || at.zone === "deck") throw new SandboxError("手札・場にないカードです");
  if (to === at.zone) return state;
  const p = at.player;
  if (to === "hand" && state.players[p].hand.length >= HAND_LIMIT) throw new SandboxError(`手札が上限（${HAND_LIMIT} 枚）です`);
  if (to === "board") checkBoardRoom(state, p, at.card.cardId);
  return edit(state, (s) => {
    const pl = s.players[p];
    const removed = at.zone === "hand" ? pl.hand.splice(at.index, 1)[0]! : pl.board.splice(at.index, 1)[0]!;
    const cardId = removed.cardId;
    switch (to) {
      case "hand": {
        const h = newHandCard(s, cardId, iid);
        h.revealed = true;
        pl.hand.push(h);
        break;
      }
      case "board":
        placeOnBoard(s, p, cardId, removed as HandCard);
        break;
      case "deck":
        pl.deck.unshift({ iid, cardId });
        break;
      case "graveyard":
        pl.graveyard++;
        if (at.zone === "board" && at.card.kind === "follower") pl.graveyardFollowers.push(cardId);
        if (at.zone === "board" && at.card.kind === "amulet") pl.destroyedAmulets.push(cardId);
        break;
      case "none":
        break;
    }
  });
}

/** 手札のカードを書き換える */
export function editHand(state: GameState, iid: number, f: (h: HandCard) => void): GameState {
  return edit(state, (s) => {
    const at = findCard(s, iid);
    if (at?.zone !== "hand") throw new SandboxError("手札にないカードです");
    f(at.card);
  });
}

/** 場のフォロワーを書き換える */
export function editFollower(state: GameState, iid: number, f: (c: FollowerOnBoard) => void): GameState {
  return edit(state, (s) => {
    const at = findCard(s, iid);
    if (at?.zone !== "board" || at.card.kind !== "follower") throw new SandboxError("場のフォロワーではありません");
    f(at.card);
  });
}

/** 場のアミュレットを書き換える */
export function editAmulet(state: GameState, iid: number, f: (c: AmuletOnBoard) => void): GameState {
  return edit(state, (s) => {
    const at = findCard(s, iid);
    if (at?.zone !== "board" || at.card.kind !== "amulet") throw new SandboxError("場のアミュレットではありません");
    f(at.card);
  });
}

const evolveBonus = (e: EvolveState) => (e === "none" ? 0 : e === "evolved" ? EVOLVE_BONUS : SUPER_EVOLVE_BONUS);

/** フォロワーの進化の状態を変え、攻撃力・体力を進化の分だけ増減する（進化時の能力は発動しない） */
export function setEvolve(state: GameState, iid: number, evolve: EvolveState): GameState {
  return editFollower(state, iid, (c) => {
    const d = evolveBonus(evolve) - evolveBonus(c.evolve);
    c.evolve = evolve;
    c.attack = Math.max(0, c.attack + d);
    c.maxDefense = Math.max(1, c.maxDefense + d);
    c.defense = Math.max(1, Math.min(c.maxDefense, c.defense + d));
  });
}

// ---- クレスト ----

export function addCrest(state: GameState, p: PlayerIndex, crestId: string): GameState {
  const crest = CRESTS_BY_ID.get(crestId);
  if (!crest) throw new SandboxError(`未知のクレスト: ${crestId}`);
  return edit(state, (s) => {
    s.players[p].crests.push({ iid: s.nextIid++, crestId, countdown: crest.countdown ?? null, order: s.nextOrder++, usedOncePerTurn: {} });
  });
}

// ---- 書き出し・読み込み ----

/** 書き出したテキストの印 */
const FORMAT = "svwb-sandbox";

export function exportSandbox(state: GameState): string {
  return JSON.stringify({ format: FORMAT, version: 1, state });
}

/**
 * 書き出したテキスト（または GameState の JSON）を読む。エンジンに読ませて形を確かめ、エンジンが書き出した形にそろえる。
 * 読めなければ SandboxError
 */
export function importSandbox(text: string): GameState {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new SandboxError(`JSON として読めません: ${String(e)}`);
  }
  const raw = typeof v === "object" && v !== null && (v as Record<string, unknown>).format === FORMAT ? (v as Record<string, unknown>).state : v;
  try {
    return callEngine({ f: "normalizeState", state: raw }) as GameState;
  } catch (e) {
    throw new SandboxError(`局面として読めません: ${String(e)}`);
  }
}
