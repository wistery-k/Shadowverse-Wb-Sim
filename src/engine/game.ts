// ルールエンジンの入口: 対戦の生成、合法手の列挙、アクションの適用。
// applyAction は状態を複製してから変更し、新しい状態を返す（引数の状態は変更しない）。

import type { Card } from "../cards";
import { EP, EVOLVE_TURN, EXTRA_PP_REFRESH_TURN, INITIAL_HAND, LEADER_HP, MAX_PP, SEP, SUPER_EVOLVE_TURN } from "./constants";
import type { Ability, Effect } from "./dsl";
import {
  answerChoose,
  answerMode,
  chooseCandidates,
  damageFollower,
  enterBoard,
  evolveFollower,
  fire,
  healLeader,
  immuneToEffectDestroy,
  leaveBoard,
  ownAbilities,
  pushAbilities,
  pushInternal,
  run,
  setInternalHandler,
} from "./effects";
import { enhanceCost } from "./keywords";
import { abilitiesOf, cardOf, crestAbilitiesOf } from "./registry";
import { rngFrom, shuffle } from "./rng";
import {
  attackOf,
  canAddToBoard,
  checkLeaders,
  drawCards,
  findBoard,
  findFollower,
  handCost,
  hasKeyword,
  leaderId,
  newBoardCard,
  newContext,
  opponent,
} from "./state";
import type {
  Action,
  AttackTarget,
  CardRef,
  EffectContext,
  FollowerOnBoard,
  Frame,
  GameState,
  HandCard,
  InternalEffect,
  PlayerIndex,
  PlayerState,
} from "./types";

export { opponent } from "./state";
export { cardOf } from "./registry";

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

// ---- 生成 ----

function newPlayer(deck: CardRef[]): PlayerState {
  return {
    leaderHp: LEADER_HP,
    leaderMaxHp: LEADER_HP,
    maxPp: 0,
    pp: 0,
    ep: EP,
    sep: SEP,
    extraPpAvailable: false,
    turnCount: 0,
    deck,
    hand: [],
    board: [],
    crests: [],
    graveyard: 0,
    graveyardFollowers: [],
    destroyedAmulets: [],
    destroyedThisTurn: [],
    combo: 0,
    evolvedThisTurn: false,
    leaderOncePerTurn: {},
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
    nextOrder: 1,
    stack: [],
    queue: [],
    pending: null,
  };
  const rng = rngFrom(state);
  state.first = rng.int(2) as PlayerIndex;
  state.active = state.first;
  state.players[opponent(state.first)].extraPpAvailable = true;
  for (const p of [0, 1] as const) {
    shuffle(state.players[p].deck, rng);
    drawCards(state, p, INITIAL_HAND);
  }
  return state;
}

// ---- ターン進行（内部処理） ----

const systemCtx = (p: PlayerIndex): EffectContext => newContext(p, 0, "");

/** ターン開始: PP 等 → カウントダウン・ターン開始時の能力 → ドロー（処理順は未確認） */
function pushStartTurn(state: GameState, p: PlayerIndex): void {
  pushInternal(state, [{ op: "_startTurnDraw" }], systemCtx(p));
  pushInternal(state, [{ op: "_startTurn" }], systemCtx(p));
}

/** ターン終了: ターン終了時の能力 → 一時効果の終了・次のターンの開始 */
function pushEndTurn(state: GameState): void {
  pushInternal(state, [{ op: "_cleanup" }], systemCtx(state.active));
  pushInternal(state, [{ op: "_endTurn" }], systemCtx(state.active));
}

function startTurn(state: GameState, p: PlayerIndex): void {
  state.turn++;
  state.active = p;
  const pl = state.players[p];
  pl.turnCount++;
  pl.maxPp = Math.min(MAX_PP, pl.maxPp + 1);
  pl.pp = pl.maxPp;
  pl.combo = 0;
  pl.evolvedThisTurn = false;
  if (p !== state.first && pl.turnCount === EXTRA_PP_REFRESH_TURN) pl.extraPpAvailable = true;
  for (const q of [0, 1] as const) state.players[q].destroyedThisTurn = [];
  for (const c of pl.board) {
    if (c.kind === "follower") c.attacksThisTurn = 0;
    else c.actedThisTurn = false;
  }
  for (const h of pl.hand) h.fusedThisTurn = false;

  // カウントダウン（アミュレット・クレスト）
  for (const c of [...pl.board].sort((a, b) => a.order - b.order)) {
    if (c.kind === "amulet" && c.countdown !== null) {
      c.countdown--;
      if (c.countdown <= 0) leaveBoard(state, c.iid, "destroy");
    }
  }
  for (const crest of [...pl.crests].sort((a, b) => a.order - b.order)) {
    if (crest.countdown === null) continue;
    crest.countdown--;
    if (crest.countdown > 0) continue;
    pl.crests = pl.crests.filter((c) => c.iid !== crest.iid);
    for (const ability of crestAbilitiesOf(crest.crestId).filter((a) => a.trigger.on === "lastWords")) {
      state.queue.push({ ability, ctx: newContext(p, crest.iid, crest.crestId) });
    }
  }
  fire.turnStart(state);
}

function endTurnCleanup(state: GameState): void {
  for (const p of [0, 1] as const) {
    for (const c of state.players[p].board) {
      c.tempKeywords = [];
      if (c.kind === "follower") {
        c.tempAttack = 0;
        if (c.cannotAttackUntil !== null && c.cannotAttackUntil <= state.turn) c.cannotAttackUntil = null;
      }
    }
  }
  pushStartTurn(state, opponent(state.active));
}

function handleInternal(state: GameState, frame: Frame, eff: InternalEffect): void {
  switch (eff.op) {
    case "_startTurn":
      startTurn(state, frame.ctx.controller);
      break;
    case "_startTurnDraw":
      drawCards(state, state.active, 1);
      break;
    case "_endTurn":
      fire.turnEnd(state);
      break;
    case "_cleanup":
      endTurnCleanup(state);
      break;
    case "_finishMulligan":
      state.phase = "main";
      pushStartTurn(state, state.first);
      break;
    case "_combat":
      combat(state, eff.attacker, eff.target);
      break;
  }
}
setInternalHandler(handleInternal);

// ---- 判定 ----

/** プレイに必要なPP。エンハンスはPPが足りれば必ず適用される。 */
export function playCost(card: Card, pp: number, hand?: HandCard): number {
  const cost = hand ? handCost(hand) : card.cost;
  const enhance = enhanceCost(card.text);
  return enhance !== null && pp >= enhance && enhance > cost ? enhance : cost;
}

type ChooseEffect = Extract<Effect, { op: "choose" }>;

/** スペルの「選ぶ」に対象がいるか（スペルは対象がいなければ使えない） */
function spellHasTargets(state: GameState, p: PlayerIndex, ref: HandCard): boolean {
  const chooses = ownAbilities(ref.cardId, "spell").flatMap((a) =>
    a.effects.filter((e): e is ChooseEffect => e.op === "choose"),
  );
  if (chooses.length === 0) return true;
  // 使用するスペル自身は手札から除いて判定する
  const pl = state.players[p];
  const saved = pl.hand;
  pl.hand = pl.hand.filter((c) => c.iid !== ref.iid);
  try {
    const ctx = newContext(p, ref.iid, ref.cardId);
    return chooses.every((e) => chooseCandidates(state, ctx, e.from).length > 0);
  } finally {
    pl.hand = saved;
  }
}

function canPlay(state: GameState, p: PlayerIndex, ref: HandCard): boolean {
  const pl = state.players[p];
  const card = cardOf(ref.cardId);
  if (abilitiesOf(ref.cardId).unplayable) return false;
  if (playCost(card, pl.pp, ref) > pl.pp) return false;
  if (card.type !== "spell" && !canAddToBoard(state, p)) return false;
  if (card.type === "spell" && !spellHasTargets(state, p, ref)) return false;
  return true;
}

const summonedThisTurn = (state: GameState, f: FollowerOnBoard) => f.enteredTurn === state.turn;

function canAttackAtAll(state: GameState, f: FollowerOnBoard): boolean {
  if (f.attacksThisTurn >= f.maxAttacks) return false;
  return f.cannotAttackUntil === null || f.cannotAttackUntil < state.turn;
}

function canAttackFollowers(state: GameState, f: FollowerOnBoard): boolean {
  if (!canAttackAtAll(state, f)) return false;
  if (!summonedThisTurn(state, f)) return true;
  return hasKeyword(f, "storm") || hasKeyword(f, "rush") || f.evolve !== "none";
}

function canAttackLeader(state: GameState, f: FollowerOnBoard): boolean {
  if (!canAttackAtAll(state, f)) return false;
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

function actAbility(cardId: string): { ability: Ability; cost: number } | null {
  for (const a of abilitiesOf(cardId).abilities) {
    if (a.trigger.on === "act") return { ability: a, cost: a.trigger.cost };
  }
  return null;
}

/** 融合の素材の候補 */
function fusionMaterials(state: GameState, p: PlayerIndex, host: HandCard): HandCard[] {
  const filter = abilitiesOf(host.cardId).fusion;
  if (!filter || host.fusedThisTurn) return [];
  return state.players[p].hand.filter((c) => {
    if (c.iid === host.iid) return false;
    const card = cardOf(c.cardId);
    if (filter.type && card.type !== filter.type) return false;
    if (filter.tribe && !(card.tribes ?? []).includes(filter.tribe)) return false;
    if (filter.ids && !filter.ids.includes(c.cardId)) return false;
    return true;
  });
}

/** マリガンを行うべきプレイヤー（先攻から） */
function mulliganPlayer(state: GameState): PlayerIndex | null {
  for (const p of [state.first, opponent(state.first)]) {
    if (!state.players[p].mulliganDone) return p;
  }
  return null;
}

/** 次に行動するプレイヤー */
export function actingPlayer(state: GameState): PlayerIndex {
  if (state.pending) return state.pending.player;
  if (state.phase === "mulligan") return mulliganPlayer(state) ?? state.first;
  return state.active;
}

function subsets<T>(items: readonly T[], size?: number): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) {
    const s = items.filter((_, i) => mask & (1 << i));
    if (size === undefined || s.length === size) out.push(s);
  }
  return out;
}

// ---- 合法手 ----

export function legalActions(state: GameState): Action[] {
  if (state.phase === "ended") return [];

  if (state.pending) {
    const pd = state.pending;
    if (pd.kind === "mode") return Array.from({ length: pd.options }, (_, index) => ({ type: "mode", index }));
    return subsets(pd.candidates, pd.count).map((targets) => ({ type: "choose", targets }));
  }

  if (state.phase === "mulligan") {
    const p = mulliganPlayer(state);
    if (p === null) return [];
    return subsets(state.players[p].hand.map((c) => c.iid)).map((swap) => ({ type: "mulligan", player: p, swap }));
  }

  const p = state.active;
  const pl = state.players[p];
  const actions: Action[] = [];
  for (const ref of pl.hand) {
    if (canPlay(state, p, ref)) actions.push({ type: "play", iid: ref.iid });
  }
  for (const c of pl.board) {
    if (c.kind === "follower") {
      for (const target of attackTargets(state, c)) actions.push({ type: "attack", attacker: c.iid, target });
      if (canEvolve(state, c, "evolve")) actions.push({ type: "evolve", iid: c.iid });
      if (canEvolve(state, c, "superEvolve")) actions.push({ type: "superEvolve", iid: c.iid });
    } else {
      const act = actAbility(c.cardId);
      if (act && !c.actedThisTurn && pl.pp >= act.cost) actions.push({ type: "act", iid: c.iid });
    }
  }
  for (const host of pl.hand) {
    const materials = fusionMaterials(state, p, host).map((c) => c.iid);
    for (const m of subsets(materials)) {
      if (m.length > 0) actions.push({ type: "fuse", host: host.iid, materials: m });
    }
  }
  if (pl.extraPpAvailable) actions.push({ type: "extraPp" });
  actions.push({ type: "endTurn" });
  return actions;
}

// ---- アクションの適用 ----

export function applyAction(prev: GameState, action: Action): GameState {
  const state = structuredClone(prev);
  if (state.phase === "ended") throw new IllegalActionError("対戦は終了しています");

  if (state.pending) {
    applyAnswer(state, action);
  } else if (action.type === "mulligan") {
    applyMulligan(state, action.player, action.swap);
  } else {
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
      case "act":
        applyAct(state, action.iid);
        break;
      case "fuse":
        applyFuse(state, action.host, action.materials);
        break;
      case "extraPp": {
        const pl = state.players[state.active];
        if (!pl.extraPpAvailable) throw new IllegalActionError("エクストラPPは使えません");
        pl.extraPpAvailable = false;
        pl.pp++; // PP最大値を超えてよい。PP最大値は増えない
        break;
      }
      case "endTurn":
        pushEndTurn(state);
        break;
      default:
        throw new IllegalActionError(`選択待ちではありません: ${action.type}`);
    }
  }
  run(state);
  return state;
}

function applyAnswer(state: GameState, action: Action): void {
  const pd = state.pending;
  if (!pd) return;
  if (pd.kind === "choose" && action.type === "choose") {
    const ok =
      action.targets.length === pd.count &&
      new Set(action.targets).size === action.targets.length &&
      action.targets.every((t) => pd.candidates.includes(t));
    if (!ok) throw new IllegalActionError("選択が不正です");
    answerChoose(state, action.targets);
    return;
  }
  if (pd.kind === "mode" && action.type === "mode") {
    if (action.index < 0 || action.index >= pd.options) throw new IllegalActionError("モードの選択が不正です");
    answerMode(state, action.index);
    return;
  }
  throw new IllegalActionError("選択待ちです");
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
  drawCards(state, p, aside.length);
  pl.deck.push(...aside.map((c) => ({ iid: c.iid, cardId: c.cardId })));
  shuffle(pl.deck, rngFrom(state));
  pl.mulliganDone = true;

  if (mulliganPlayer(state) === null) pushInternal(state, [{ op: "_finishMulligan" }], systemCtx(state.first));
}

function applyPlay(state: GameState, iid: number): void {
  const p = state.active;
  const pl = state.players[p];
  const ref = pl.hand.find((c) => c.iid === iid);
  if (!ref || !canPlay(state, p, ref)) throw new IllegalActionError(`カード${iid}はプレイできません`);
  const card = cardOf(ref.cardId);

  const cost = playCost(card, pl.pp, ref);
  const enhanced = enhanceCost(card.text) === cost && cost > handCost(ref);
  pl.pp -= cost;
  pl.hand = pl.hand.filter((c) => c.iid !== iid);
  pl.combo++;

  const ctx = newContext(p, iid, card.id, {
    enhanced,
    sourceX: ref.x,
    sourceAttack: card.type === "follower" ? Math.max(0, card.attack + ref.attackMod) : 0,
  });

  if (card.type === "spell") {
    pl.graveyard++;
    // 手札の他のカードはスペルブーストされる
    for (const h of [...pl.hand]) fire.spellboost(state, p, h, 1);
    pushAbilities(state, ownAbilities(card.id, "spell"), ctx);
    return;
  }
  const onBoard = newBoardCard(state, card.id, ref);
  enterBoard(state, p, onBoard);
  pushAbilities(state, ownAbilities(onBoard, "fanfare"), ctx);
}

function applyAttack(state: GameState, attackerIid: number, target: AttackTarget): void {
  const p = state.active;
  const pl = state.players[p];
  const attacker = pl.board.find((c): c is FollowerOnBoard => c.kind === "follower" && c.iid === attackerIid);
  if (!attacker || !attackTargets(state, attacker).includes(target)) {
    throw new IllegalActionError(`フォロワー${attackerIid}は${String(target)}を攻撃できません`);
  }

  attacker.attacksThisTurn++;
  attacker.keywords = attacker.keywords.filter((k) => k !== "ambush"); // 攻撃すると潜伏を失う

  // 戦闘は【攻撃時】【交戦時】の能力の後（処理順は未確認）
  pushInternal(state, [{ op: "_combat", attacker: attackerIid, target }], newContext(p, attackerIid, attacker.cardId));
  const eventId = target === "leader" ? leaderId(opponent(p)) : target;
  const triggered: [Ability, EffectContext][] = [];
  const attackerCtx = (event: number) =>
    newContext(p, attackerIid, attacker.cardId, { event, sourceAttack: attackOf(attacker), sourceX: attacker.x });
  for (const a of ownAbilities(attacker, "attack")) triggered.push([a, attackerCtx(eventId)]);
  if (target !== "leader") {
    for (const a of ownAbilities(attacker, "clash")) triggered.push([a, attackerCtx(target)]);
    const defender = findFollower(state, target);
    if (defender) {
      for (const a of ownAbilities(defender.card, "clash")) {
        triggered.push([a, newContext(defender.player, target, defender.card.cardId, { event: attackerIid })]);
      }
    }
  }
  for (const [a, ctx] of triggered.reverse()) pushAbilities(state, [a], ctx);
}

function combat(state: GameState, attackerIid: number, target: AttackTarget): void {
  const p = state.active;
  const attacker = findFollower(state, attackerIid)?.card;
  if (!attacker) return;

  if (target === "leader") {
    const amount = attackOf(attacker);
    state.players[opponent(p)].leaderHp -= amount;
    if (hasKeyword(attacker, "drain")) healLeader(state, p, amount);
    checkLeaders(state);
    return;
  }

  const defender = findFollower(state, target)?.card;
  if (!defender) return; // 攻撃先がいなくなった

  // 交戦: 互いの攻撃力分のダメージを同時に与える
  const dealt = damageFollower(state, defender, attackOf(attacker));
  damageFollower(state, attacker, attackOf(defender));
  if (hasKeyword(attacker, "drain")) healLeader(state, p, dealt);

  // 必殺: 戦闘ダメージを0以上与えたフォロワーを破壊（0ダメージでも破壊）。必殺は効果による破壊。
  const destroyDefender = hasKeyword(attacker, "bane") && !immuneToEffectDestroy(state, defender);
  const destroyAttacker = hasKeyword(defender, "bane") && !immuneToEffectDestroy(state, attacker);
  // 体力0以下のものと一緒に、手番のプレイヤーのフォロワーから破壊する
  if (destroyAttacker && attacker.defense > 0 && findBoard(state, attacker.iid)) leaveBoard(state, attacker.iid, "destroy");
  if (destroyDefender && defender.defense > 0 && findBoard(state, defender.iid)) leaveBoard(state, defender.iid, "destroy");
}

function applyEvolve(state: GameState, iid: number, kind: "evolve" | "superEvolve"): void {
  const p = state.active;
  const pl = state.players[p];
  const f = pl.board.find((c): c is FollowerOnBoard => c.kind === "follower" && c.iid === iid);
  if (!f || !canEvolve(state, f, kind)) throw new IllegalActionError(`フォロワー${iid}は${kind}できません`);

  if (kind === "evolve") pl.ep--;
  else pl.sep--;
  pl.evolvedThisTurn = true;

  // 【進化時】【超進化時】（超進化でも【進化時】は働く。「〜ではなく」の【超進化時】は置き換える）
  const evolveAbilities = ownAbilities(f, "evolve");
  const superAbilities = kind === "superEvolve" ? ownAbilities(f, "superEvolve") : [];
  const replaces = superAbilities.some((a) => a.replacesEvolve);
  const abilities = replaces ? superAbilities : [...evolveAbilities, ...superAbilities];

  evolveFollower(state, p, f, kind);
  pushAbilities(state, abilities, newContext(p, iid, f.cardId, { sourceX: f.x, sourceAttack: attackOf(f) }));
}

function applyAct(state: GameState, iid: number): void {
  const p = state.active;
  const pl = state.players[p];
  const amulet = pl.board.find((c) => c.iid === iid);
  const act = amulet ? actAbility(amulet.cardId) : null;
  if (!amulet || amulet.kind !== "amulet" || !act || amulet.actedThisTurn || pl.pp < act.cost) {
    throw new IllegalActionError(`アミュレット${iid}はアクトできません`);
  }
  pl.pp -= act.cost;
  amulet.actedThisTurn = true;
  fire.allyAct(state, p);
  pushAbilities(state, [act.ability], newContext(p, iid, amulet.cardId));
}

function applyFuse(state: GameState, hostIid: number, materials: readonly number[]): void {
  const p = state.active;
  const pl = state.players[p];
  const host = pl.hand.find((c) => c.iid === hostIid);
  const candidates = host ? fusionMaterials(state, p, host).map((c) => c.iid) : [];
  if (
    !host ||
    materials.length === 0 ||
    new Set(materials).size !== materials.length ||
    !materials.every((m) => candidates.includes(m))
  ) {
    throw new IllegalActionError("融合できません");
  }
  const used = pl.hand.filter((c) => materials.includes(c.iid));
  pl.hand = pl.hand.filter((c) => !materials.includes(c.iid));
  host.fusedThisTurn = true;
  for (const m of used) if (!host.fusedKinds.includes(m.cardId)) host.fusedKinds.push(m.cardId);

  const ctx = newContext(p, host.iid, host.cardId, {
    vars: {
      fusedCost: used.reduce((sum, m) => sum + cardOf(m.cardId).cost, 0),
      fusedKinds: host.fusedKinds.length,
    },
  });
  fire.allyFuse(state, p);
  pushAbilities(state, ownAbilities(host.cardId, "fused"), ctx);
}
