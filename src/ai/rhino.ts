// リノセウスエルフ用のルールベース AI（ルールはユーザー作。docs/ai-notes.md 参照）。
//
// ルールで決まる手（リーサル、1枚目の聖樹の杖、エクストラPP 等）は最優先で打ち、
// ルールで禁じる手（最後の杖のアクト、森の神秘 等）は探索から外し、残りは探索 AI に任せる。
// エルフ以外のデッキでは探索 AI と同じ。
//
// カード名で判断するのはこの AI の中だけ（エンジンのカード効果はデータ駆動のまま）。

import {
  abilitiesOf,
  actingPlayer,
  applyAction,
  attackOf,
  cardOf,
  EVOLVE_TURN,
  EXTRA_PP_REFRESH_TURN,
  hasKeyword,
  legalActions,
  rngFrom,
  SUPER_EVOLVE_TURN,
  tryApplyAction,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../engine";
import type { FollowerOnBoard } from "../engine/types";
import { determinize } from "./determinize";
import { DEFAULT_EXACT_LETHAL_OPTIONS, resetExactLethalCache, searchExactLethal, type ExactLethalOptions } from "./exactLethal";
import { DEFAULT_LETHAL_OPTIONS, DIRECT_SCORING, findLethal, searchLethal } from "./lethal";
import { searchRhinoLethal } from "./rhinoLethal";
import { createSearchAgent, type SearchOptions } from "./search";
import type { Agent } from "./types";
import { deckClassOf } from "./weights";

const ROD = "聖樹の杖";
const ROCK = "燐光の岩";
const MYSTERY = "森の神秘";
const BACKWOOD = "薫交の天宮・バックウッド";
const RHINO = "殺戮のリノセウス";
const CARBUNCLE = "ベビーカーバンクル";
const BAIL = "煌撃の戦士・ベイル";
const BUGS = "虫の知らせ";
const LILY = "ピュアクリスタリア・リリィ";
const OLIVIER = "勇壮の堕天使・オリヴィエ";
const TAMER = "フェアリーテイマー";
/** マリガンで1枚だけ残す序盤のカード（優先順） */
const EARLY = ["フェアリーテイマー", "純粋なるウォーターフェアリー", "妖精の招集"];
/** 上の2種（バックウッドと序盤のカード）がどちらもあるときに残すカード（優先順。杖は1枚まで） */
const EXTRA_KEEP = [ROD, "アドベンチャーエルフ・メイ", "ピュアクリスタリア・リリィ"];
/** 1枚目のエクストラPP を使ってよい最後のターン（自分のターン数）。このターンに残っていれば使う */
const FIRST_EXTRA_PP_DEADLINE = 5;

const nameOf = (cardId: string) => cardOf(cardId).name;
const keyOf = (a: Action) => JSON.stringify(a);

function boardCount(state: GameState, p: PlayerIndex, name: string): number {
  return state.players[p].board.filter((c) => nameOf(c.cardId) === name).length;
}

function handCount(state: GameState, p: PlayerIndex, name: string): number {
  return state.players[p].hand.filter((h) => nameOf(h.cardId) === name).length;
}

function oppHasFollowers(state: GameState, p: PlayerIndex): boolean {
  return state.players[p === 0 ? 1 : 0].board.some((c) => c.kind === "follower");
}

/** ファンファーレに【コンボ】の条件があるカード */
function hasComboFanfare(cardId: string): boolean {
  return abilitiesOf(cardId).abilities.some((a) => a.trigger.on === "fanfare" && JSON.stringify(a).includes('"kind":"combo"'));
}

function playedName(state: GameState, a: Action, p: PlayerIndex): string | null {
  if (a.type !== "play") return null;
  const h = state.players[p].hand.find((c) => c.iid === a.iid);
  return h ? nameOf(h.cardId) : null;
}

/** 1枚目のエクストラPP で、今は出せないが使えば出せるようになる「使う理由のある」カードがあるか */
function extraPpEnablesKeyPlay(state: GameState, p: PlayerIndex): boolean {
  let after: GameState;
  try {
    after = applyAction(state, { type: "extraPp" });
  } catch {
    return false;
  }
  const now = new Set(legalActions(state).map(keyOf));
  const combo = state.players[p].combo;
  return legalActions(after).some((a) => {
    if (a.type !== "play" || now.has(keyOf(a))) return false;
    const name = playedName(after, a, p);
    const cardId = after.players[p].hand.find((c) => c.iid === a.iid)?.cardId;
    if (name === ROD) return allowAction(after, a, p);
    if (name === BACKWOOD) return true;
    // プレイすると【コンボ_3】を満たす（プレイしたカード自身も数える）
    return cardId !== undefined && hasComboFanfare(cardId) && combo + 1 >= 3;
  });
}

/** 場に1個しかない杖・燐光の岩（手札に戻す等の対象に選ばない） */
function lastKeepers(state: GameState, p: PlayerIndex): Set<number> {
  const out = new Set<number>();
  for (const name of [ROD, ROCK]) {
    const cards = state.players[p].board.filter((c) => nameOf(c.cardId) === name);
    if (cards.length === 1) out.add(cards[0]!.iid);
  }
  return out;
}

/**
 * 手を打つと、最後の杖・燐光の岩が場から離れるか、それを選ぶしかない選択待ちになるか
 * （対象が1つなら自動で選ばれて場から離れる）
 */
function forcesKeeperChoice(state: GameState, a: Action, p: PlayerIndex): boolean {
  const keepers = lastKeepers(state, p);
  if (keepers.size === 0) return false;
  let after: GameState;
  try {
    after = applyAction(state, a);
  } catch {
    return false;
  }
  const onBoard = new Set(after.players[p].board.map((c) => c.iid));
  if ([...keepers].some((iid) => !onBoard.has(iid))) return true;
  if (after.pending?.kind !== "choose" || after.pending.player !== p) return false;
  return legalActions(after).every((c) => c.type === "choose" && c.targets.some((t) => keepers.has(t)));
}

/** ルールで打ってよい手か（リーサル以外の場面に使う） */
export function allowAction(state: GameState, a: Action, p: PlayerIndex): boolean {
  const pl = state.players[p];
  switch (a.type) {
    case "choose": {
      // 最後の杖・燐光の岩は選ばない（他に選べるものがあれば。無ければ打つ前の手で避ける）
      if (state.pending?.player !== p) return true;
      const keepers = lastKeepers(state, p);
      return !a.targets.some((t) => keepers.has(t));
    }
    case "play": {
      const name = playedName(state, a, p);
      if (name === MYSTERY) return false; // リーサルまで温存
      // 手札に1枚しかないリノセウスはリーサルまで温存（2枚以上なら1枚は残る）
      if (name === RHINO && handCount(state, p, RHINO) < 2) return false;
      if (forcesKeeperChoice(state, a, p)) return false;
      // 杖の2枚目以降と燐光の岩は、相手の盤面を全処理できた（フォロワーがいない）ときだけ
      if (name === ROD) return boardCount(state, p, ROD) === 0 || !oppHasFollowers(state, p);
      if (name === ROCK) return !oppHasFollowers(state, p);
      return true;
    }
    case "act": {
      const b = pl.board.find((c) => c.iid === a.iid);
      const name = b ? nameOf(b.cardId) : null;
      // 杖と燐光の岩は、場に1個は残す
      if (name === ROD || name === ROCK) return boardCount(state, p, name) >= 2;
      return !forcesKeeperChoice(state, a, p);
    }
    case "extraPp":
      // 2つ目はリーサルまで温存。1つ目は使う理由があるときだけ
      if (pl.turnCount >= EXTRA_PP_REFRESH_TURN) return false;
      return extraPpEnablesKeyPlay(state, p);
    default:
      return true;
  }
}

/** マリガンで入れ替えるカードの iid */
export function mulliganSwap(state: GameState, p: PlayerIndex): number[] {
  const hand = state.players[p].hand;
  const keep = new Set<number>();
  const backwood = hand.find((h) => nameOf(h.cardId) === BACKWOOD);
  const early = EARLY.map((n) => hand.find((h) => nameOf(h.cardId) === n)).find((h) => h !== undefined);
  if (backwood) keep.add(backwood.iid);
  if (early) keep.add(early.iid);
  if (backwood && early) {
    for (const name of EXTRA_KEEP) {
      for (const h of hand) {
        if (keep.has(h.iid) || nameOf(h.cardId) !== name) continue;
        keep.add(h.iid);
        if (name === ROD) break; // 杖は1枚まで
      }
    }
  }
  return hand.filter((h) => !keep.has(h.iid)).map((h) => h.iid);
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * リーサル探索: 汎用の探索（今すぐ殴れるダメージ重視）で見つからなければ、リノセウス専用の探索
 * （汎用の「準備」重視の探索より、リノセウスの出し方を決め打ちする方がよく見つかる）
 */
const DIRECT_ONLY = { ...DEFAULT_LETHAL_OPTIONS, scorings: [DIRECT_SCORING] };
export function searchLethalForRhino(root: GameState, p: PlayerIndex): Action[] | null {
  return searchLethal(root, p, DIRECT_ONLY) ?? searchRhinoLethal(root, p);
}

/**
 * 全探索で手を試す順番: リーダーへの攻撃 → カードのプレイ（コストの低い順）→ アクト → 進化 → フォロワーへの攻撃。
 * リーサルがあるときに早く見つかる（問題集の 2 問目で 35641 → 4556 局面）
 */
function exactOrderRank(s: GameState, p: PlayerIndex, a: Action): number {
  if (a.type === "attack") return a.target === "leader" ? 0 : 5;
  if (a.type === "play") {
    const h = s.players[p].hand.find((c) => c.iid === a.iid);
    return 1 + (h ? cardOf(h.cardId).cost : 0) / 100;
  }
  if (a.type === "act") return 2;
  if (a.type === "evolve" || a.type === "superEvolve") return 3;
  return 4;
}

const spendActions = (s: GameState) => new Set(legalActions(s).filter((a) => a.type === "play" || a.type === "act").map((a) => JSON.stringify(a)));

/** 相手の場に、攻撃先になる守護のフォロワーがいるか（attackTargets と同じ見方） */
function opponentHasWard(s: GameState, p: PlayerIndex): boolean {
  return s.players[p === 0 ? 1 : 0].board.some(
    (c) => c.kind === "follower" && hasKeyword(c, "ward") && !hasKeyword(c, "ambush") && !hasKeyword(c, "intimidate"),
  );
}

/**
 * エクストラPPを使うと、今は PP が足りずに出せない・アクトできないカードが出せるようになるか。
 * PP の値を見るのは支払い・PP 回復（PP 最大値で頭打ち）・エンハンスだけで、エルフのカードにエンハンスは無いので、
 * 使うのを後回しにしてもできることは減らない（全探索で試す順番を減らすため）
 */
function extraPpEnablesSpend(s: GameState): boolean {
  const next = tryApplyAction(s, { type: "extraPp" });
  if (!next) return false;
  const before = spendActions(s);
  return [...spendActions(next)].some((k) => !before.has(k));
}

/**
 * 全探索のリーサル探索の設定。手札の森の神秘を先に打つ（0 コストでコンボが増えるだけなので、先に打って損は無い）。
 * リーサルが無い局面では上限まで調べるので、局面の数は少なめにする（docs/ai-notes.md）
 */
export const RHINO_EXACT: ExactLethalOptions = {
  ...DEFAULT_EXACT_LETHAL_OPTIONS,
  maxStates: 30_000,
  maxStatesPerTurn: 60_000,
  // リノセウスでリーダー以外を攻撃する手は試さない（ユーザーの案。seed 900091 の 8 ターン目。docs/ai-notes.md）
  // エクストラPPは、使うと新しく出せる・アクトできるカードが増えるときだけ試す（ユーザーの案。docs/ai-notes.md）
  // 相手の場に守護がいる間はリノセウスを出さない（ユーザーの案。取りこぼしうるが稀。seed 900027 の 9 ターン目。docs/ai-notes.md）
  order: (s, p, actions) =>
    actions
      .filter((a) => !isRhinoFollowerAttack(s, p, a) && (a.type !== "extraPp" || extraPpEnablesSpend(s)) && !(isRhinoPlay(s, a) && opponentHasWard(s, p)))
      .sort((x, y) => exactOrderRank(s, p, x) - exactOrderRank(s, p, y)),
  forced: (s, p, legal) => {
    const mystery = s.players[p].hand.find((h) => nameOf(h.cardId) === MYSTERY);
    return (mystery && legal.find((a) => a.type === "play" && a.iid === mystery.iid)) ?? null;
  },
};

/**
 * 自分のターンに実際に打つ手を決めるときのリーサル探索。上の 2 つで見つからなければ全探索する（ユーザーのリーサル問題集。docs/ai-notes.md）。
 * 全探索は時間がかかるので、探索 AI の葉の局面（次のターンのリーサル）では使わない
 */
export function searchLethalForRhinoTurn(root: GameState, p: PlayerIndex): Action[] | null {
  // 運頼みの手順（虫の知らせのランダムダメージで守護を倒す等）は findLethal の確認で捨てられるので、ここで確かめて次を探す
  const found = searchLethalForRhino(root, p);
  if (found && winsElsewhere(root, p, found)) return found;
  if (!root.players[p].hand.some((h) => nameOf(h.cardId) === RHINO)) return found;
  const hp = root.players[p === 0 ? 1 : 0].leaderHp;
  const bound = rhinoLethalBound(root, p);
  if (hp > bound) return found;
  // リノセウスを出す回数ごとに分けて探す（rhinoExactSearches）
  let lucky: Action[] | null = null;
  for (const { opts } of rhinoExactSearches(root, p, hp)) {
    const exact = searchExactLethal(root, p, opts);
    if (!exact) continue;
    if (winsElsewhere(root, p, exact)) return exact;
    // 乱数で結果が変わる手を除いて探し直す（seed 900234 のエルフ 7 ターン目。docs/ai-notes.md）
    const sure = searchExactLethal(root, p, { ...opts, deterministicOnly: true });
    if (sure) return sure;
    lucky ??= exact;
  }
  return lucky ?? found;
}

/**
 * 進化・超進化の対象を絞ってよい余裕の境目（このターンに進化か超進化ができれば 2、どちらもできなければ 0）。
 * 適当なフォロワーに使っても 1 点は出るので、余裕（上限 − 相手の体力）が 2 より小さければ、
 * 進化・超進化をリーダーへのダメージ以外に使う余地は無い（ユーザーの案。seed 900052 の 7 ターン目。docs/ai-notes.md）
 */
function evolveSlackLimit(s: GameState, p: PlayerIndex): number {
  const pl = s.players[p];
  const order = p === s.first ? 0 : 1;
  if (pl.evolvedThisTurn) return 0;
  const canSuper = pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
  const canEvolve = pl.ep > 0 && pl.turnCount >= EVOLVE_TURN[order];
  return canSuper || canEvolve ? 2 : 0;
}

/**
 * 上限の式で数えた分を出せない進化・超進化。対象がこのあとリーダーを攻撃できるフォロワー（リノセウス等）でなく、
 * 超進化ならベビーカーバンクル（PP 3 回復）・オリヴィエ（他のフォロワーを超進化）でもないもの
 */
function wastedEvolve(s: GameState, p: PlayerIndex, a: Action): boolean {
  if (a.type !== "evolve" && a.type !== "superEvolve") return false;
  const c = s.players[p].board.find((x) => x.iid === a.iid);
  if (!c || c.kind !== "follower") return false;
  if (leaderAttackers(s, p).some((x) => x.iid === c.iid)) return false;
  return !(a.type === "superEvolve" && [CARBUNCLE, OLIVIER].includes(nameOf(c.cardId)));
}

/**
 * 全探索をリノセウスを出す回数ごと（1 回以下・2 回・3 回以上）に分けたときの、それぞれの設定。上限が相手の体力に届かない回数は含めない。
 * 出さないカード・リーダーしか攻撃しないフォロワー・進化の対象は、回数ごとの上限で決める（ユーザーの案。docs/ai-notes.md）
 */
export function rhinoExactSearches(root: GameState, p: PlayerIndex, hp: number): { rhinos: number; bound: number; last: boolean; opts: ExactLethalOptions }[] {
  const bounds = rhinoBounds(root, p);
  const out: { rhinos: number; bound: number; last: boolean; opts: ExactLethalOptions }[] = [];
  for (const [i, [rhinos, bound]] of bounds.entries()) {
    if (bound < hp) continue;
    const last = i === bounds.length - 1;
    const opts: ExactLethalOptions = { ...RHINO_EXACT, leaderOnly: leaderOnlyAttackers(root, p, bound - hp), noPlay: uselessPlays(root, p, hp, [[rhinos, bound]]) };
    if (rhinos >= 2) opts.mustPlay = { count: rhinos, matches: isRhinoPlay, feasible: canStillPlayRhinos };
    if (!last) opts.maxPlay = { count: rhinos, matches: isRhinoPlay };
    if (bound - hp < evolveSlackLimit(root, p)) {
      opts.order = (s, q, actions) => RHINO_EXACT.order!(s, q, actions).filter((a) => !wastedEvolve(s, q, a));
      opts.orderKey = "evolve";
    }
    out.push({ rhinos, bound, last, opts });
  }
  return out;
}

/** リノセウスを出す回数と、その回数での上限（1 回・2 回、3 回出せるかもしれなければ 3 回も） */
export function rhinoBounds(s: GameState, p: PlayerIndex): [number, number][] {
  const bounds: [number, number][] = [[1, rhinoOneDamageBound(s, p)], [2, rhinoDamageBound(s, p)]];
  if (mayPlayThreeRhinos(s, p)) bounds.push([3, rhinoThreeDamageBound(s, p)]);
  return bounds;
}

function isRhinoFollowerAttack(s: GameState, p: PlayerIndex, a: Action): boolean {
  if (a.type !== "attack" || a.target === "leader") return false;
  const c = s.players[p].board.find((x) => x.iid === a.attacker);
  return c !== undefined && nameOf(c.cardId) === RHINO;
}

export function isRhinoPlay(s: GameState, a: Action): boolean {
  if (a.type !== "play") return false;
  const h = s.players[s.active].hand.find((c) => c.iid === a.iid);
  return h !== undefined && nameOf(h.cardId) === RHINO;
}

/**
 * あと remaining 回リノセウスを出せるかもしれないか。PP（エクストラPP と、超進化できるならベビーカーバンクルの PP 3 回復を含む）が
 * 3 × remaining 以上あり、出すリノセウス（手札と、戻す手段があれば場のもの）がある
 */
export function canStillPlayRhinos(s: GameState, p: PlayerIndex, remaining: number): boolean {
  const pl = s.players[p];
  const inHand = (name: string) => pl.hand.some((h) => nameOf(h.cardId) === name);
  const order = p === s.first ? 0 : 1;
  const canSuper = !pl.evolvedThisTurn && pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
  const refund = canSuper && (inHand(CARBUNCLE) || boardCount(s, p, CARBUNCLE) > 0) ? 3 : 0;
  if (pl.pp + (pl.extraPpAvailable ? 1 : 0) + refund < 3 * remaining) return false;
  const rhinos = pl.hand.filter((h) => nameOf(h.cardId) === RHINO).length;
  if (rhinos >= remaining) return true;
  const bounce = boardCount(s, p, ROD) > 0 || inHand(BUGS) || inHand(CARBUNCLE);
  return bounce && rhinos + boardCount(s, p, RHINO) > 0;
}

/** 乱数・山札・相手の手札を決め直した局面（findLethal の確認と同じ考え方）でも勝てるか */
const ELSEWHERE_SEEDS = [1, 2];
function winsElsewhere(root: GameState, p: PlayerIndex, seq: readonly Action[]): boolean {
  return ELSEWHERE_SEEDS.every((seed) => {
    let s: GameState | null = determinize(root, p, rngFrom({ rng: (root.rng ^ (seed * 0x9e3779b9)) >>> 0 }));
    for (const a of seq) {
      if (!s || s.phase === "ended") break;
      s = tryApplyAction(s, a);
    }
    return s !== null && s.phase === "ended" && s.winner === p;
  });
}

/**
 * リノセウスを 2 回出して与えられるダメージの上限（ユーザーの式。docs/ai-notes.md）。相手の体力がこれより大きければリーサルは無い。
 * - 基本は 2 ×（PP − 7）+ 8（超進化できる場合）。エクストラPP が使えれば PP に 1 を足す
 * - 超進化できればベビーカーバンクル（手札か場、1 枚まで）で +2。できなければ、進化できれば −1、どちらもできなければ −3
 * - 手札の森の神秘と、0 コストまで下がりうる煌撃の戦士・ベイル（zeroCostBails）1 枚につき +2、手札と場の燐光の岩 1 枚につき +1、溜まっているコンボ 1 につき +2
 * - 場に残っていてリーダーを攻撃できるフォロワーの攻撃力（残りの攻撃回数分）を足す
 */
export function rhinoDamageBound(s: GameState, p: PlayerIndex): number {
  const pl = s.players[p];
  const inHand = (name: string) => pl.hand.filter((h) => nameOf(h.cardId) === name).length;
  const order = p === s.first ? 0 : 1;
  const canSuper = !pl.evolvedThisTurn && pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
  const canEvolve = !pl.evolvedThisTurn && pl.ep > 0 && pl.turnCount >= EVOLVE_TURN[order];
  const pp = pl.pp + (pl.extraPpAvailable ? 1 : 0);
  let bound = 2 * (pp - 7) + 8 + 2 * pl.combo;
  if (canSuper) bound += inHand(CARBUNCLE) + boardCount(s, p, CARBUNCLE) > 0 ? 2 : 0;
  else bound -= canEvolve ? 1 : 3;
  bound += 2 * (inHand(MYSTERY) + zeroCostBails(s, p, 2)) + inHand(ROCK) + boardCount(s, p, ROCK);
  return bound + boardAttack(s, p);
}

/**
 * リノセウスで与えられるダメージの上限。リノセウス 1 回と 2 回の式の大きい方（PP が少ないと 1 回の方が大きい）。
 * 3 回出せるかもしれなければ 3 回の式も見る
 */
export function rhinoLethalBound(s: GameState, p: PlayerIndex): number {
  const bound = Math.max(rhinoOneDamageBound(s, p), rhinoDamageBound(s, p));
  return mayPlayThreeRhinos(s, p) ? Math.max(bound, rhinoThreeDamageBound(s, p)) : bound;
}

/**
 * リノセウスを 1 回出して与えられるダメージの上限（seed 900001 のエルフ 6 ターン目でユーザーが示した数え方。docs/ai-notes.md）。
 * - 残りの PP を 1 コストのカードに使い、最後にリノセウス（3 コスト）を出す: PP − 3 + 1（リノセウス自身のコンボ）。エクストラPP が使えれば PP に 1 を足す
 * - 進化できれば +2、超進化できれば +3（ベビーカーバンクルを超進化して PP 3 回復しても、コンボ 2 と超進化の 1 点でリノセウスの超進化と変わらないので足さない。ユーザーの指摘）
 * - 溜まっているコンボ、手札の森の神秘・ベイル、手札と場の燐光の岩 1 につき +1。場に残っていてリーダーを攻撃できるフォロワーの攻撃力を足す
 */
export function rhinoOneDamageBound(s: GameState, p: PlayerIndex): number {
  const pl = s.players[p];
  const inHand = (name: string) => pl.hand.filter((h) => nameOf(h.cardId) === name).length;
  const order = p === s.first ? 0 : 1;
  const canSuper = !pl.evolvedThisTurn && pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
  const canEvolve = !pl.evolvedThisTurn && pl.ep > 0 && pl.turnCount >= EVOLVE_TURN[order];
  const pp = pl.pp + (pl.extraPpAvailable ? 1 : 0);
  let bound = pp - 2 + pl.combo + inHand(MYSTERY) + zeroCostBails(s, p, 1) + inHand(ROCK) + boardCount(s, p, ROCK);
  bound += canSuper ? 3 : canEvolve ? 2 : 0;
  return bound + boardAttack(s, p);
}

/**
 * リノセウスを 3 回出して与えられるダメージの上限（ユーザーの式。docs/ai-notes.md）。
 * - 基本は 3 ×（PP − 9）+ 6。エクストラPP が使えれば PP に 1 を足す
 * - 超進化できれば +3、できなければ進化できれば +2
 * - 手札と場の燐光の岩 1 枚につき +1、場に残っていてリーダーを攻撃できるフォロワーの攻撃力を足す
 * - 溜まっているコンボと手札の森の神秘（0 コストでコンボ +1）は、リノセウス 3 体の攻撃力に効くので 1 につき +3
 */
export function rhinoThreeDamageBound(s: GameState, p: PlayerIndex): number {
  const pl = s.players[p];
  const order = p === s.first ? 0 : 1;
  const canSuper = !pl.evolvedThisTurn && pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
  const canEvolve = !pl.evolvedThisTurn && pl.ep > 0 && pl.turnCount >= EVOLVE_TURN[order];
  const pp = pl.pp + (pl.extraPpAvailable ? 1 : 0);
  const mystery = pl.hand.filter((h) => nameOf(h.cardId) === MYSTERY).length;
  let bound = 3 * (pp - 9) + 6 + 3 * (pl.combo + mystery) + (canSuper ? 3 : canEvolve ? 2 : 0);
  bound += pl.hand.filter((h) => nameOf(h.cardId) === ROCK).length + boardCount(s, p, ROCK) + boardAttack(s, p);
  return bound;
}

/** 場に残っていてリーダーを攻撃できるフォロワー */
function leaderAttackers(s: GameState, p: PlayerIndex): FollowerOnBoard[] {
  return s.players[p].board.filter((c): c is FollowerOnBoard => {
    if (c.kind !== "follower" || c.attacksThisTurn >= c.maxAttacks) return false;
    if (c.cannotAttackUntil !== null && c.cannotAttackUntil >= s.turn) return false;
    return c.enteredTurn !== s.turn || hasKeyword(c, "storm");
  });
}

/** 場に残っていてリーダーを攻撃できるフォロワーの攻撃力（残りの攻撃回数分） */
function boardAttack(s: GameState, p: PlayerIndex): number {
  return leaderAttackers(s, p).reduce((total, c) => total + attackOf(c) * (c.maxAttacks - c.attacksThisTurn), 0);
}

/**
 * 出すと上限が相手の体力に届かなくなる手札のカード（ユーザーの案）。相手の体力に届く式のどれでも、出した後に届かなければ出さない。
 * - バックウッド・リリィ・手札の聖樹の杖・フェアリーテイマー: 引いたカード（テイマーのフェアリーも 1 コストなので同じ）で上限を取り戻せない（山札に 0 コストのカードは無い）ので、出すと PP の分だけ上限が下がる。
 *   1 PP の価値はリノセウス 1 回・2 回・3 回の式で 1・2・3 点、出した分のコンボで同じだけ戻るので、下がる分は 回数 ×（コスト − 1）。
 *   杖のアクトで戻して出し直すのは 1 コストのカードを出すのと同じ（2 回の式はアクトを 0 コストとして数えている）なので、杖も同じに扱う
 * - 勇壮の堕天使・オリヴィエ: PP 2 回復で実質 コスト − 2。超進化すると他のフォロワー（リノセウス）も超進化し、リノセウスを直接超進化するより最大 1 点多い（ユーザーの見積もり）ので、
 *   下がる分は 回数 ×（コスト − 2 − 1）から、超進化できれば 1 を引いたもの
 * - 燐光の岩: コンボ 2 以上で出せば森の神秘が付いて 1 コスト換算になる。そう出せる回数を超える分は、リリィと同じく 回数 ×（コスト − 1）下がる。
 *   自由に使える PP = PP − リノセウスの回数 × 3（超進化できるベビーカーバンクルがあれば +1）、
 *   コンボ 2 にするのに要る PP = max(0, 2 − 手札の森の神秘とベイル)、1 コスト換算で出せる回数 =（自由に使える PP − コンボ 2 にするのに要る PP）÷ 2（切り捨て）
 */
function uselessPlays(s: GameState, p: PlayerIndex, hp: number, bounds: readonly (readonly [number, number])[] = rhinoBounds(s, p)): number[] {
  const pl = s.players[p];
  const reachable = bounds.filter(([, bound]) => bound >= hp);
  const useless = (rhinos: number, bound: number, cost: number) => bound - rhinos * (cost - 1) < hp;
  const out = pl.hand
    .filter((h) => [BACKWOOD, LILY, ROD, TAMER].includes(nameOf(h.cardId)))
    .filter((h) => reachable.every(([rhinos, bound]) => useless(rhinos, bound, Math.max(0, cardOf(h.cardId).cost + h.costMod))))
    .map((h) => h.iid);
  const order = p === s.first ? 0 : 1;
  const superBonus = !pl.evolvedThisTurn && pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order] ? 1 : 0;
  for (const h of pl.hand.filter((x) => nameOf(x.cardId) === OLIVIER)) {
    const cost = Math.max(0, cardOf(h.cardId).cost + h.costMod - 2);
    if (reachable.every(([rhinos, bound]) => useless(rhinos, bound + superBonus, cost))) out.push(h.iid);
  }
  const rocks = pl.hand.filter((h) => nameOf(h.cardId) === ROCK);
  if (rocks.length === 0 || reachable.length === 0) return out;
  const mysteries = pl.hand.filter((h) => nameOf(h.cardId) === MYSTERY).length;
  // 出さない岩の数: 届く式のどれでも、1 コスト換算で出せる回数を超え、超えた分を出すと届かなくなる数
  const excess = Math.min(
    ...reachable.map(([rhinos, bound]) => {
      const toCombo2 = Math.max(0, 2 - mysteries - zeroCostBails(s, p, rhinos));
      const playable = Math.max(0, Math.floor((freePp(s, p, rhinos) - toCombo2) / 2));
      return useless(rhinos, bound, Math.max(0, cardOf(rocks[0]!.cardId).cost + rocks[0]!.costMod)) ? Math.max(0, rocks.length - playable) : 0;
    }),
  );
  return [...out, ...rocks.slice(0, excess).map((h) => h.iid)];
}

/** リノセウスを rhinos 回出した残りで自由に使える PP（エクストラPP を含む。超進化できるベビーカーバンクルがあれば PP 3 回復からカーバンクルの 2 を引いた +1） */
function freePp(s: GameState, p: PlayerIndex, rhinos: number): number {
  const pl = s.players[p];
  const order = p === s.first ? 0 : 1;
  const canSuper = !pl.evolvedThisTurn && pl.sep > 0 && pl.turnCount >= SUPER_EVOLVE_TURN[order];
  const carbuncle = canSuper && (pl.hand.some((h) => nameOf(h.cardId) === CARBUNCLE) || boardCount(s, p, CARBUNCLE) > 0) ? 1 : 0;
  return pl.pp + (pl.extraPpAvailable ? 1 : 0) + carbuncle - rhinos * 3;
}

/**
 * 手札の煌撃の戦士・ベイルのうち、リノセウスを rhinos 回出すターンに 0 コストまで下がりうるもの（ユーザーの見積もり）。
 * 自分のフォロワーが場を離れるたびに 1 下がる。離れうるのは、場に残っているフォロワーと、自由に使える PP で出すフォロワー（1 PP につき 1 体）なので、
 * max(0, 今のコスト − 場に残っているフォロワーの数 − 自由に使える PP) が 0 なら 0 コストとみなす
 */
function zeroCostBails(s: GameState, p: PlayerIndex, rhinos: number): number {
  const pl = s.players[p];
  const followers = pl.board.filter((c) => c.kind === "follower").length;
  const free = Math.max(0, freePp(s, p, rhinos));
  return pl.hand.filter((h) => nameOf(h.cardId) === BAIL && cardOf(h.cardId).cost + h.costMod - followers - free <= 0).length;
}

/**
 * 上限の式でリーダーへの攻撃として数えた場のフォロワーのうち、攻撃力が余裕（上限 − 相手の体力）より大きいもの。
 * これがフォロワーを攻撃すると、残りで出せるのは上限 − 攻撃力 < 相手の体力なので、リーダーしか攻撃させない（ユーザーの案）
 */
function leaderOnlyAttackers(s: GameState, p: PlayerIndex, slack: number): number[] {
  return leaderAttackers(s, p).filter((c) => attackOf(c) > slack).map((c) => c.iid);
}

/**
 * リノセウスを 3 回出せるかもしれない（このときは rhinoThreeDamageBound も見る）。
 * 手札に 2 枚以上あり、戻す手段（場の聖樹の杖・手札の虫の知らせかベビーカーバンクル）があって、PP が 9 以上（問題集の 4 問目）
 */
function mayPlayThreeRhinos(s: GameState, p: PlayerIndex): boolean {
  const pl = s.players[p];
  const inHand = (name: string) => pl.hand.some((h) => nameOf(h.cardId) === name);
  const rhinos = pl.hand.filter((h) => nameOf(h.cardId) === RHINO).length;
  const bounce = boardCount(s, p, ROD) > 0 || inHand(BUGS) || inHand(CARBUNCLE);
  return rhinos >= 2 && bounce && pl.pp + (pl.extraPpAvailable ? 1 : 0) >= 9;
}

/**
 * ビームに最初の手ごとに残す局面の数（SearchOptions.perFirst）。テイマーの並びがアリア等の並びに押し出されて途中で切れ、
 * 燐光の岩をコンボ 1 で出していた（seed 2275116772 の 7 ターン目）。勝率は 242 → 248/600、1 試合 0.38 → 0.40 秒（docs/ai-notes.md）
 */
const RHINO_PER_FIRST = 4;

/**
 * リノセウス用 AI を作る。search は探索の設定（比較実験用。既定は汎用の探索 AI と同じ深さ 8・幅 32）。
 * 深さ 8・幅 32 はリノセウスエルフで先に採用し、後に汎用の探索 AI の既定にした
 * （seed 2510273090 の 4 ターン目・seed 954874822 の 7 ターン目。docs/ai-notes.md）
 */
export function createRhinoAgent(searchOptions: Partial<SearchOptions> = {}): Agent {
  const search = createSearchAgent({ allow: allowAction, lethal: false, perFirst: RHINO_PER_FIRST, nextLethalSearch: (s, q) => searchLethalForRhino(s, q) !== null, ...searchOptions });
  const plainSearch = createSearchAgent();
  return {
    name: "rhino",
    chooseAction(real, legal, rng) {
      const first = legal[0];
      if (!first) throw new Error("合法手がありません");
      // 新しい試合では、全探索のリーサル探索のメモを捨てる（ターン番号で区別しているので、別の試合の同じターンと混ざらないように）
      if (first.type === "mulligan") resetExactLethalCache();
      // マリガン中の active は先攻なので、マリガンするプレイヤーは actingPlayer で求める
      const p = actingPlayer(real);
      if (deckClassOf(real, p) !== "elf") return plainSearch.chooseAction(real, legal, rng);
      if (first.type === "mulligan") {
        const swap = mulliganSwap(real, p);
        return legal.find((a) => a.type === "mulligan" && sameSet(a.swap, swap)) ?? first;
      }
      if (legal.length === 1) return first;
      // 相手のターン中の選択は探索 AI に任せる
      if (real.active !== p) return search.chooseAction(real, legal, rng);
      // リーサル（ルールより優先。手順の途中の選択も含む）
      const legalKeys = new Set(legal.map(keyOf));
      const lethal = findLethal(real, p, rng, DEFAULT_LETHAL_OPTIONS, searchLethalForRhinoTurn);
      if (lethal && legalKeys.has(keyOf(lethal))) return lethal;
      // 自分の選択待ちは探索 AI に任せる（allowAction で最後の杖等を避ける）
      if (real.pending) return search.chooseAction(real, legal, rng);

      const pl = real.players[p];
      const extraPp = legal.find((a) => a.type === "extraPp");
      // 1つ目のエクストラPP が期限のターンに残っていれば、ターン開始時に使う
      if (extraPp && pl.turnCount === FIRST_EXTRA_PP_DEADLINE) return extraPp;
      // 1枚目の杖は最優先で置く（エクストラPP で置けるなら使う）
      if (boardCount(real, p, ROD) === 0) {
        const rod = legal.find((a) => playedName(real, a, p) === ROD);
        if (rod) return rod;
        if (extraPp && pl.hand.some((h) => nameOf(h.cardId) === ROD) && allowAction(real, extraPp, p)) {
          const after = applyAction(real, extraPp);
          if (legalActions(after).some((a) => playedName(after, a, p) === ROD)) return extraPp;
        }
      }
      return search.chooseAction(real, legal, rng);
    },
  };
}

export const rhinoAgent: Agent = createRhinoAgent();
