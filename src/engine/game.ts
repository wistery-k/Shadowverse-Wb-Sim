// ルールエンジンの中核: 対戦の生成、合法手の列挙、アクションの適用。
// applyAction は状態を複製してから変更し、新しい状態を返す（引数の状態は変更しない）。
// カードの能力（ファンファーレ等）は未実装。常在型のキーワードとエンハンスのコストのみ扱う。

import { CARDS_BY_ID, type Card } from "../cards";
import {
  BOARD_LIMIT,
  EP,
  EVOLVE_BONUS,
  EVOLVE_TURN,
  HAND_LIMIT,
  INITIAL_HAND,
  LEADER_HP,
  MAX_PP,
  SEP,
  SUPER_EVOLVE_BONUS,
  SUPER_EVOLVE_TURN,
} from "./constants";
import { enhanceCost, parseStaticAbilities } from "./keywords";
import { rngFrom, shuffle } from "./rng";
import type {
  Action,
  AttackTarget,
  CardRef,
  FollowerOnBoard,
  GameState,
  OnBoard,
  PlayerIndex,
  PlayerState,
  StaticKeyword,
} from "./types";

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

export interface GameConfig {
  /** 各プレイヤーのデッキ（カードIDの配列） */
  decks: [readonly string[], readonly string[]];
  seed: number;
}

export const opponent = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

export function cardOf(cardId: string): Card {
  const card = CARDS_BY_ID.get(cardId);
  if (!card) throw new Error(`未知のカードID: ${cardId}`);
  return card;
}

const hasKeyword = (c: OnBoard, kw: StaticKeyword) => c.keywords.includes(kw);

// ---- 生成 ----

function newPlayer(deck: CardRef[]): PlayerState {
  return {
    leaderHp: LEADER_HP,
    leaderMaxHp: LEADER_HP,
    maxPp: 0,
    pp: 0,
    ep: EP,
    sep: SEP,
    turnCount: 0,
    deck,
    hand: [],
    board: [],
    graveyard: 0,
    graveyardFollowers: [],
    playedThisTurn: 0,
    evolvedThisTurn: false,
    mulliganDone: false,
  };
}

export function createGame(config: GameConfig): GameState {
  let nextIid = 1;
  const toRefs = (ids: readonly string[]): CardRef[] =>
    ids.map((cardId) => {
      cardOf(cardId); // 存在確認
      return { iid: nextIid++, cardId };
    });

  const state: GameState = {
    phase: "mulligan",
    players: [newPlayer(toRefs(config.decks[0])), newPlayer(toRefs(config.decks[1]))],
    first: 0,
    active: 0,
    turn: 0,
    winner: null,
    rng: config.seed >>> 0,
    nextIid,
  };
  const rng = rngFrom(state);
  state.first = rng.int(2) as PlayerIndex;
  state.active = state.first;
  for (const p of [0, 1] as const) {
    shuffle(state.players[p].deck, rng);
    draw(state, p, INITIAL_HAND);
  }
  return state;
}

// ---- 基本操作（state を直接変更する） ----

function lose(state: GameState, loser: PlayerIndex): void {
  if (state.phase === "ended") return;
  state.phase = "ended";
  state.winner = opponent(loser);
}

function draw(state: GameState, p: PlayerIndex, n: number): void {
  const pl = state.players[p];
  for (let i = 0; i < n && state.phase !== "ended"; i++) {
    const card = pl.deck.shift();
    if (!card) {
      lose(state, p);
      return;
    }
    if (pl.hand.length >= HAND_LIMIT) {
      pl.graveyard++; // 溢れたカードはリアニメイトの対象にならない
    } else {
      pl.hand.push(card);
    }
  }
}

function healLeader(pl: PlayerState, amount: number): void {
  pl.leaderHp = Math.min(pl.leaderMaxHp, pl.leaderHp + amount);
}

/** 両リーダーの体力を確認し、0以下なら決着させる。同時なら手番のプレイヤーの敗北。 */
function checkLeaders(state: GameState): void {
  const dead = ([0, 1] as const).filter((p) => state.players[p].leaderHp <= 0);
  if (dead.length === 2) lose(state, state.active);
  else if (dead[0] !== undefined) lose(state, dead[0]);
}

function ownerOf(state: GameState, iid: number): PlayerIndex | null {
  for (const p of [0, 1] as const) {
    if (state.players[p].board.some((c) => c.iid === iid)) return p;
  }
  return null;
}

/**
 * フォロワーにダメージを与え、実際に与えたダメージを返す。
 * バリアは次のダメージを1回0にする（超進化で0になる場合も消費する）。
 * 超進化したフォロワーは持ち主のターン中、受けるダメージが0になる。
 */
function damageFollower(state: GameState, f: FollowerOnBoard, amount: number): number {
  if (amount <= 0) return 0;
  if (hasKeyword(f, "barrier")) {
    f.keywords = f.keywords.filter((k) => k !== "barrier");
    return 0;
  }
  if (f.evolve === "superEvolved" && ownerOf(state, f.iid) === state.active) return 0;
  f.defense -= amount;
  return amount;
}

/** 超進化したフォロワーは持ち主のターン中、効果で破壊されない */
function immuneToEffectDestroy(state: GameState, f: FollowerOnBoard): boolean {
  return f.evolve === "superEvolved" && ownerOf(state, f.iid) === state.active;
}

/** 体力0以下のフォロワーと、指定されたフォロワーを破壊する */
function destroyDead(state: GameState, alsoDestroy: ReadonlySet<number> = new Set()): void {
  // 手番のプレイヤーの場から、古い順（場に出た順）に処理する（docs/rules.md 11章）
  for (const p of [state.active, opponent(state.active)]) {
    const pl = state.players[p];
    const survivors: OnBoard[] = [];
    for (const c of pl.board) {
      if (c.kind === "follower" && (c.defense <= 0 || alsoDestroy.has(c.iid))) {
        pl.graveyard++;
        pl.graveyardFollowers.push(c.cardId);
      } else {
        survivors.push(c);
      }
    }
    pl.board = survivors;
  }
}

function startTurn(state: GameState, p: PlayerIndex): void {
  state.turn++;
  state.active = p;
  const pl = state.players[p];
  pl.turnCount++;
  pl.maxPp = Math.min(MAX_PP, pl.maxPp + 1);
  pl.pp = pl.maxPp;
  pl.playedThisTurn = 0;
  pl.evolvedThisTurn = false;
  for (const c of pl.board) if (c.kind === "follower") c.attacksThisTurn = 0;

  // カウントダウン（ターン開始時の処理順は未確認: PP回復 → カウントダウン → ドロー とする）
  const survivors: OnBoard[] = [];
  for (const c of pl.board) {
    if (c.kind === "amulet" && c.countdown !== null) {
      c.countdown--;
      if (c.countdown <= 0) {
        pl.graveyard++;
        continue;
      }
    }
    survivors.push(c);
  }
  pl.board = survivors;

  draw(state, p, 1);
}

// ---- 判定 ----

/** プレイに必要なPP。エンハンスはPPが足りれば必ず適用される。 */
export function playCost(card: Card, pp: number): number {
  const enhance = enhanceCost(card.text);
  return enhance !== null && pp >= enhance ? enhance : card.cost;
}

function canPlay(state: GameState, p: PlayerIndex, ref: CardRef): boolean {
  const pl = state.players[p];
  const card = cardOf(ref.cardId);
  if (playCost(card, pl.pp) > pl.pp) return false;
  if (card.type !== "spell" && pl.board.length >= BOARD_LIMIT) return false;
  return true;
}

function summonedThisTurn(state: GameState, f: FollowerOnBoard): boolean {
  return f.enteredTurn === state.turn;
}

function canAttackFollowers(state: GameState, f: FollowerOnBoard): boolean {
  if (f.attacksThisTurn >= f.maxAttacks) return false;
  if (!summonedThisTurn(state, f)) return true;
  return hasKeyword(f, "storm") || hasKeyword(f, "rush") || f.evolve !== "none";
}

function canAttackLeader(state: GameState, f: FollowerOnBoard): boolean {
  if (f.attacksThisTurn >= f.maxAttacks) return false;
  return !summonedThisTurn(state, f) || hasKeyword(f, "storm");
}

/** 攻撃先の候補（守護を考慮済み） */
export function attackTargets(state: GameState, attacker: FollowerOnBoard): AttackTarget[] {
  const opp = state.players[opponent(state.active)];
  const attackable = opp.board.filter(
    (c): c is FollowerOnBoard =>
      c.kind === "follower" && !hasKeyword(c, "ambush") && !hasKeyword(c, "intimidate"),
  );
  const wards = attackable.filter((c) => hasKeyword(c, "ward"));
  const followers = wards.length > 0 ? wards : attackable;

  const targets: AttackTarget[] = [];
  if (canAttackFollowers(state, attacker)) targets.push(...followers.map((c) => c.iid));
  if (wards.length === 0 && canAttackLeader(state, attacker)) targets.push("leader");
  return targets;
}

function canEvolve(state: GameState, f: FollowerOnBoard, kind: "evolve" | "superEvolve"): boolean {
  const p = state.active;
  const pl = state.players[p];
  const order = p === state.first ? 0 : 1;
  if (f.evolve !== "none" || pl.evolvedThisTurn) return false;
  if (kind === "evolve") return pl.ep > 0 && pl.turnCount >= EVOLVE_TURN[order];
  return pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
}

/** マリガンを行うべきプレイヤー（先攻から） */
function mulliganPlayer(state: GameState): PlayerIndex | null {
  for (const p of [state.first, opponent(state.first)]) {
    if (!state.players[p].mulliganDone) return p;
  }
  return null;
}

// ---- 合法手 ----

export function legalActions(state: GameState): Action[] {
  if (state.phase === "ended") return [];

  if (state.phase === "mulligan") {
    const p = mulliganPlayer(state);
    if (p === null) return [];
    const hand = state.players[p].hand.map((c) => c.iid);
    const actions: Action[] = [];
    for (let mask = 0; mask < 1 << hand.length; mask++) {
      actions.push({ type: "mulligan", player: p, swap: hand.filter((_, i) => mask & (1 << i)) });
    }
    return actions;
  }

  const p = state.active;
  const pl = state.players[p];
  const actions: Action[] = [];
  for (const ref of pl.hand) {
    if (canPlay(state, p, ref)) actions.push({ type: "play", iid: ref.iid });
  }
  for (const c of pl.board) {
    if (c.kind !== "follower") continue;
    for (const target of attackTargets(state, c)) {
      actions.push({ type: "attack", attacker: c.iid, target });
    }
    if (canEvolve(state, c, "evolve")) actions.push({ type: "evolve", iid: c.iid });
    if (canEvolve(state, c, "superEvolve")) actions.push({ type: "superEvolve", iid: c.iid });
  }
  actions.push({ type: "endTurn" });
  return actions;
}

// ---- アクションの適用 ----

export function applyAction(prev: GameState, action: Action): GameState {
  const state = structuredClone(prev);
  if (state.phase === "ended") throw new IllegalActionError("対戦は終了しています");

  if (action.type === "mulligan") {
    applyMulligan(state, action.player, action.swap);
    return state;
  }
  if (state.phase !== "main") throw new IllegalActionError("マリガン中です");

  switch (action.type) {
    case "play":
      applyPlay(state, action.iid);
      break;
    case "attack":
      applyAttack(state, action.attacker, action.target);
      break;
    case "evolve":
    case "superEvolve":
      applyEvolve(state, action.iid, action.type);
      break;
    case "endTurn":
      startTurn(state, opponent(state.active));
      break;
  }
  return state;
}

function applyMulligan(state: GameState, p: PlayerIndex, swap: readonly number[]): void {
  if (state.phase !== "mulligan" || mulliganPlayer(state) !== p) {
    throw new IllegalActionError(`プレイヤー${p}はマリガンできません`);
  }
  const pl = state.players[p];
  const set = new Set(swap);
  if (set.size !== swap.length || swap.some((iid) => !pl.hand.some((c) => c.iid === iid))) {
    throw new IllegalActionError("入れ替えるカードが手札にありません");
  }
  // 選んだカードを脇に置き、同じ枚数を引いてから、脇のカードを山札に戻してシャッフル
  const aside = pl.hand.filter((c) => set.has(c.iid));
  pl.hand = pl.hand.filter((c) => !set.has(c.iid));
  draw(state, p, aside.length);
  pl.deck.push(...aside);
  shuffle(pl.deck, rngFrom(state));
  pl.mulliganDone = true;

  if (mulliganPlayer(state) === null) {
    state.phase = "main";
    startTurn(state, state.first);
  }
}

function applyPlay(state: GameState, iid: number): void {
  const p = state.active;
  const pl = state.players[p];
  const ref = pl.hand.find((c) => c.iid === iid);
  if (!ref || !canPlay(state, p, ref)) throw new IllegalActionError(`カード${iid}はプレイできません`);
  const card = cardOf(ref.cardId);

  pl.pp -= playCost(card, pl.pp);
  pl.hand = pl.hand.filter((c) => c.iid !== iid);
  pl.playedThisTurn++;

  const { keywords, maxAttacks } = parseStaticAbilities(card.text);
  if (card.type === "follower") {
    pl.board.push({
      kind: "follower",
      iid,
      cardId: card.id,
      attack: card.attack,
      defense: card.defense,
      maxDefense: card.defense,
      keywords,
      maxAttacks,
      attacksThisTurn: 0,
      enteredTurn: state.turn,
      evolve: "none",
    });
  } else if (card.type === "amulet") {
    pl.board.push({ kind: "amulet", iid, cardId: card.id, countdown: card.countdown ?? null, keywords });
  } else {
    pl.graveyard++;
  }
}

function applyAttack(state: GameState, attackerIid: number, target: AttackTarget): void {
  const pl = state.players[state.active];
  const opp = state.players[opponent(state.active)];
  const attacker = pl.board.find((c): c is FollowerOnBoard => c.kind === "follower" && c.iid === attackerIid);
  if (!attacker || !attackTargets(state, attacker).includes(target)) {
    throw new IllegalActionError(`フォロワー${attackerIid}は${String(target)}を攻撃できません`);
  }

  attacker.attacksThisTurn++;
  attacker.keywords = attacker.keywords.filter((k) => k !== "ambush"); // 攻撃すると潜伏を失う

  if (target === "leader") {
    opp.leaderHp -= attacker.attack;
    if (hasKeyword(attacker, "drain")) healLeader(pl, attacker.attack);
    checkLeaders(state);
    return;
  }

  const defender = opp.board.find((c): c is FollowerOnBoard => c.kind === "follower" && c.iid === target);
  if (!defender) throw new IllegalActionError(`攻撃先${target}がありません`);

  // 交戦: 互いの攻撃力分のダメージを同時に与える
  const dealt = damageFollower(state, defender, attacker.attack);
  damageFollower(state, attacker, defender.attack);
  if (hasKeyword(attacker, "drain")) healLeader(pl, dealt);

  // 必殺: 戦闘ダメージを0以上与えたフォロワーを破壊（0ダメージでも破壊）。必殺は効果による破壊。
  const baneTargets = new Set<number>();
  if (hasKeyword(attacker, "bane") && !immuneToEffectDestroy(state, defender)) baneTargets.add(defender.iid);
  if (hasKeyword(defender, "bane") && !immuneToEffectDestroy(state, attacker)) baneTargets.add(attacker.iid);
  destroyDead(state, baneTargets);
  checkLeaders(state);
}

function applyEvolve(state: GameState, iid: number, kind: "evolve" | "superEvolve"): void {
  const pl = state.players[state.active];
  const f = pl.board.find((c): c is FollowerOnBoard => c.kind === "follower" && c.iid === iid);
  if (!f || !canEvolve(state, f, kind)) throw new IllegalActionError(`フォロワー${iid}は${kind}できません`);

  const bonus = kind === "evolve" ? EVOLVE_BONUS : SUPER_EVOLVE_BONUS;
  if (kind === "evolve") pl.ep--;
  else pl.sep--;
  f.evolve = kind === "evolve" ? "evolved" : "superEvolved";
  f.attack += bonus;
  f.defense += bonus;
  f.maxDefense += bonus;
  pl.evolvedThisTurn = true;
}
