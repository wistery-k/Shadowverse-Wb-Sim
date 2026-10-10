// 全探索のリーサル探索。ターン終了以外のすべての手を深さ優先で試し、同じ局面はまとめる（docs/ai-notes.md）。
//
// - 局面ごとに「ここから相手リーダーに与えられる最大のダメージ」をメモする。キーに相手リーダーの体力を含めないので、
//   体力だけが違う局面は 1 つにまとまる（相手の体力でできることが変わるカードには使えない）
// - 手札・場の並び順とインスタンス ID、相手の手札の中身はキーに含めない
// - 相手の体力に届いた時点で打ち切る。1 回に調べる局面の数が maxStates を超えたら諦める（null）
// - メモは同じターンの間、使い回す
// - 乱数を使う効果は、渡された局面の乱数の状態で決まった 1 通りだけを見る（他のリーサル探索と同じ）。
//   deterministicOnly なら、乱数で結果が変わる手は試さない

import { legalActions, rngFrom, shuffle, tryApplyAction, type Action, type GameState, type PlayerIndex } from "../engine";
import type { HandCard, OnBoard, PlayerState } from "../engine/types";

export interface ExactLethalOptions {
  /** 手を試す順番（省略時は legalActions の順）。手を減らしてもよい */
  order?: (s: GameState, p: PlayerIndex, actions: Action[]) => Action[];
  /** order が局面以外の条件で試す手を変えるとき、その条件を表す文字列（メモのキーに含める） */
  orderKey?: string;
  /** 1 回に調べる局面の数の上限 */
  maxStates: number;
  /** 1 ターンに調べる局面の数の上限（ターン中は手を打つたびに探し直すため） */
  maxStatesPerTurn: number;
  /** 必ず打つ手（あればその手だけを試す。森の神秘など、先に打って損の無い手） */
  forced?: (s: GameState, p: PlayerIndex, legal: Action[]) => Action | null;
  /**
   * 乱数で結果が変わる手を試さない。運頼みでない手順だけを探す（山札から引く手は試す。引いたカードに頼る手順は呼び出し側で確かめる）
   * （虫の知らせのランダムダメージで守護を倒す前提の手順は、別の決定化で通らない。docs/ai-notes.md）
   */
  deterministicOnly?: boolean;
  /**
   * 手順の中で必ず count 回打つ手（matches）。feasible が false の局面（残り remaining 回をもう打てない）は調べない。
   * 最初の局面でリノセウス 1 回の上限が相手の体力に届かなければ、リノセウスを 2 回以上出す手順だけを探す（docs/ai-notes.md）。
   * feasible は局面と remaining だけで決まるので、メモのキーに remaining を足せば相手の体力によらず使い回せる
   */
  mustPlay?: { count: number; matches: (s: GameState, a: Action) => boolean; feasible: (s: GameState, p: PlayerIndex, remaining: number) => boolean };
  /**
   * 手順の中で高々 count 回しか打たない手（matches）。リノセウスを出す回数ごとに分けて探すときに、回数の上限に使う（docs/ai-notes.md）。
   * mustPlay と一緒に使うときは、matches は同じ手を数えるものにする。打った回数をメモのキーに含める
   */
  maxPlay?: { count: number; matches: (s: GameState, a: Action) => boolean };
  /**
   * 攻撃し終えた自分のフォロワーの攻撃力・体力をメモのキーに含めない（ユーザー判断。docs/ai-notes.md）。
   * もう攻撃しないので、リーダーへのダメージに関係しない。もう一度攻撃できるようになる効果（超進化で 2 回攻撃等）や、
   * 攻撃力・体力を参照する効果を持つカードを使うデッキには使えない（リノセウスエルフには無い）。相手の効果で破壊されるかどうかの違いは捨てる
   */
  ignoreExhaustedStats?: boolean;
  /**
   * リーダーしか攻撃させないフォロワー（インスタンス ID）。ターンの最初の上限の式で、フォロワーへ攻撃すると上限が相手の体力に届かなくなるもの（docs/ai-notes.md）。
   * 試す手が変わるので、メモのキーに含める
   */
  leaderOnly?: readonly number[];
  /** 出さない手札のカード（インスタンス ID）。出すと上限が相手の体力に届かなくなるもの（docs/ai-notes.md）。メモのキーに含める */
  noPlay?: readonly number[];
  /** 調べた局面の数を書き込む（計測用） */
  stats?: { visited: number; memo: number };
}

export const DEFAULT_EXACT_LETHAL_OPTIONS: ExactLethalOptions = { maxStates: 100_000, maxStatesPerTurn: 200_000 };

const json = (x: unknown) => JSON.stringify(x);

function handKey(h: HandCard): string {
  let k = h.cardId;
  if (h.costMod || h.attackMod || h.defenseMod || h.boosts || h.x !== null) k += `:${h.costMod}:${h.attackMod}:${h.defenseMod}:${h.boosts}:${h.x}`;
  if (h.keywords.length || h.fusedKinds.length || h.fusedThisTurn) k += json([h.keywords, h.fusedKinds, h.fusedThisTurn]);
  return k;
}

function boardKey(c: OnBoard, ignoreExhaustedStats = false): string {
  let k = c.keywords.length || c.tempKeywords.length || c.granted.length ? json([c.keywords, c.tempKeywords, c.granted]) : "";
  if (c.kind === "amulet") return `A${c.cardId},${c.countdown},${c.sigils},${c.actedThisTurn ? 1 : 0}${k}`;
  if (Object.keys(c.usedOncePerTurn).length) k += json(c.usedOncePerTurn);
  if (ignoreExhaustedStats && c.attacksThisTurn >= c.maxAttacks) return `F${c.cardId},-,${c.maxAttacks},${c.attacksThisTurn},${c.evolve}${k}`;
  return `F${c.cardId},${c.attack},${c.defense},${c.maxDefense},${c.tempAttack},${c.maxAttacks},${c.attacksThisTurn},${c.enteredTurn},${c.evolve},${c.cannotAttackUntil},${c.x}${k}`;
}

/** 相手（opponent）は体力と手札の中身を含めない */
function playerKey(pl: PlayerState, opponent: boolean, ignoreExhaustedStats: boolean): string {
  let k = `${opponent ? "" : pl.leaderHp},${pl.pp},${pl.maxPp},${pl.combo},${pl.ep},${pl.sep},${pl.evolvedThisTurn ? 1 : 0},${pl.extraPpAvailable ? 1 : 0},`;
  k += `${pl.deck.length},${pl.graveyard},${pl.graveyardFollowers.length},${pl.destroyedThisTurn.length},${pl.destroyedAmulets.length}`;
  if (pl.crests.length || Object.keys(pl.leaderOncePerTurn).length) k += json([pl.crests.map((c) => [c.crestId, c.countdown, c.usedOncePerTurn]), pl.leaderOncePerTurn]);
  const hand = opponent ? String(pl.hand.length) : pl.hand.map(handKey).sort().join(";");
  return `${k}|${hand}|${pl.board.map((c) => boardKey(c, !opponent && ignoreExhaustedStats)).sort().join(";")}`;
}

/**
 * 局面のキー（相手 opp のリーダーの体力と手札の中身、手札・場の並び順、インスタンス ID を除く）。
 * ignoreExhaustedStats なら、攻撃し終えた opp でない側のフォロワーの攻撃力・体力も除く
 */
export function lethalKey(s: GameState, opp: PlayerIndex, ignoreExhaustedStats = false): string {
  let k = `${s.active}#${playerKey(s.players[0], opp === 0, ignoreExhaustedStats)}#${playerKey(s.players[1], opp === 1, ignoreExhaustedStats)}`;
  if (s.pending || s.stack.length || s.queue.length) k += json([s.pending, s.stack, s.queue]);
  return k;
}

class Abort extends Error {}

/** 局面のキー → ここから与えられる最大のダメージ。exact でなければ途中で打ち切った値（下限） */
type Memo = Map<string, { damage: number; exact: boolean }>;

/**
 * 同じターンの間はメモを使い回す（ターン中は手を打つたびに探し直すため）。
 * 相手の手札の中身はキーに含めないので、決定化（determinize）で相手の手札が変わっても使い回せる
 */
interface TurnCache {
  turn: number;
  player: PlayerIndex;
  memo: Memo;
  visited: number;
}
/** deterministicOnly かどうかで試す手が違うので、メモを分ける */
const caches: { all: TurnCache | null; deterministic: TurnCache | null } = { all: null, deterministic: null };
const MAX_CACHE = 500_000;

/** 全探索をした回数と、リーサルを見つけた回数（実験の集計用。resetExactLethalCache で 0 に戻る） */
export const exactLethalCounts = { searched: 0, found: 0 };

/** メモを捨てる（新しい試合を始めるとき） */
export function resetExactLethalCache(): void {
  caches.all = null;
  caches.deterministic = null;
  exactLethalCounts.searched = 0;
  exactLethalCounts.found = 0;
}

function cacheFor(root: GameState, p: PlayerIndex, deterministic: boolean): TurnCache {
  const kind = deterministic ? "deterministic" : "all";
  const c = caches[kind];
  if (c && c.turn === root.turn && c.player === p && c.memo.size <= MAX_CACHE) return c;
  return (caches[kind] = { turn: root.turn, player: p, memo: new Map(), visited: 0 });
}

const ALT_SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];

/** 乱数の状態と p の山札の順番だけを変えた局面 */
function withOtherRandom(s: GameState, p: PlayerIndex, seed: number): GameState {
  const rng = (s.rng ^ seed) >>> 0;
  const deck = [...s.players[p].deck];
  shuffle(deck, rngFrom({ rng }));
  const players = [...s.players] as GameState["players"];
  players[p] = { ...s.players[p], deck };
  return { ...s, players, rng };
}

/**
 * 手 a の結果が乱数で変わるか。乱数を使わなかった手（乱数の状態が進んでいない）は変わらない。
 * 使った手は、乱数の状態と山札の順番を変えた局面でも同じ局面・同じ相手の体力になるかで見る（候補が 1 つのランダム等は変わらない）
 */
export function variesWithRandom(s: GameState, a: Action, next: GameState, p: PlayerIndex): boolean {
  if (next.rng === s.rng) return false;
  const opp: PlayerIndex = p === 0 ? 1 : 0;
  const key = (x: GameState) => `${x.players[opp].leaderHp}|${x.phase}|${lethalKey(x, opp)}`;
  const expected = key(next);
  return ALT_SEEDS.some((seed) => {
    const alt = tryApplyAction(withOtherRandom(s, p, seed), a);
    return !alt || key(alt) !== expected;
  });
}

const isTransient = (s: GameState) => s.pending !== null || s.stack.length > 0 || s.queue.length > 0;
const actorOf = (s: GameState) => (s.pending ? s.pending.player : s.active);

/**
 * 相手リーダーを倒しきる手順を全探索で探す。見つかれば手順、無いか局面が多すぎれば null。
 * 手番（選択待ちを含む）が p でない局面は探さない
 */
export function searchExactLethal(root: GameState, p: PlayerIndex, opts: ExactLethalOptions = DEFAULT_EXACT_LETHAL_OPTIONS): Action[] | null {
  if (root.phase !== "main" || actorOf(root) !== p) return null;
  const opp: PlayerIndex = p === 0 ? 1 : 0;
  const turnCache = cacheFor(root, p, opts.deterministicOnly ?? false);
  const memo = turnCache.memo;
  const limit = Math.min(opts.maxStates, opts.maxStatesPerTurn - turnCache.visited);
  if (limit <= 0) return null;
  exactLethalCounts.searched++;
  let visited = 0;

  const leaderOnly = new Set(opts.leaderOnly ?? []);
  const noPlay = new Set(opts.noPlay ?? []);
  const ids = (xs: Set<number>) => [...xs].sort((a, b) => a - b).join(",");
  const must = opts.mustPlay;
  const max = opts.maxPlay;
  const keyPrefix = `${leaderOnly.size || noPlay.size ? `${ids(leaderOnly)}/${ids(noPlay)}/` : ""}${max ? `${must?.count ?? 0}<${max.count}/` : ""}${opts.orderKey ? `${opts.orderKey}/` : ""}`;
  /** played は mustPlay（なければ maxPlay）の手を打った回数 */
  const candidates = (s: GameState, played: number): Action[] => {
    const legal = legalActions(s).filter(
      (a) =>
        a.type !== "endTurn" &&
        !(a.type === "attack" && a.target !== "leader" && leaderOnly.has(a.attacker)) &&
        !(a.type === "play" && noPlay.has(a.iid)) &&
        !(max && played >= max.count && max.matches(s, a)),
    );
    const forced = s.pending ? null : (opts.forced?.(s, p, legal) ?? null);
    return forced ? [forced] : opts.order ? opts.order(s, p, legal) : legal;
  };

  const counted = must?.matches ?? max?.matches;
  // mustPlay だけなら、打った回数は count で頭打ちにしてキーをまとめる
  const playedAfter = (s: GameState, a: Action, played: number) =>
    counted && (max || played < (must?.count ?? 0)) && counted(s, a) ? played + 1 : played;
  const remainingOf = (played: number) => Math.max(0, (must?.count ?? 0) - played);

  /** s から与えられる最大のダメージ（need 以上が見つかればそこで打ち切った値）。played は mustPlay（なければ maxPlay）の手を打った回数 */
  const dfs = (s: GameState, need: number, played: number): number => {
    if (s.phase !== "main" || actorOf(s) !== p) return 0;
    const remaining = remainingOf(played);
    if (must && remaining > 0 && !isTransient(s) && !must.feasible(s, p, remaining)) return 0;
    // 選択待ち・解決中の局面はメモしない（キーが重く、すぐに次の局面に進むため）
    const key = isTransient(s) ? null : `${keyPrefix}${max ? played : remaining}|${lethalKey(s, opp, opts.ignoreExhaustedStats)}`;
    const hit = key === null ? undefined : memo.get(key);
    if (hit && (hit.exact || hit.damage >= need)) return hit.damage;
    if (++visited > limit) throw new Abort();
    let best = 0;
    if (key !== null) memo.set(key, { damage: 0, exact: false });
    for (const a of candidates(s, played)) {
      const next = tryApplyAction(s, a);
      if (!next || (next.phase === "ended" && next.winner !== p)) continue;
      if (opts.deterministicOnly && variesWithRandom(s, a, next, p)) continue;
      const dealt = s.players[opp].leaderHp - next.players[opp].leaderHp;
      const damage = dealt + dfs(next, need - dealt, playedAfter(s, a, played));
      if (damage > best) best = damage;
      if (best >= need) break;
    }
    // 打ち切ったなら best は最大値ではない（下限）
    const exact = best < need;
    if (key !== null) memo.set(key, { damage: best, exact });
    return best;
  };

  let need = root.players[opp].leaderHp;
  let played = 0;
  const seq: Action[] = [];
  try {
    if (dfs(root, need, played) < need) return null;
    // ダメージが足りる手を順にたどる（キーにインスタンス ID を含めないので、手そのものはメモしない）
    let s = root;
    while (s.phase !== "ended") {
      let found: { a: Action; next: GameState; dealt: number } | null = null;
      for (const a of candidates(s, played)) {
        const next = tryApplyAction(s, a);
        if (!next || (next.phase === "ended" && next.winner !== p)) continue;
        if (opts.deterministicOnly && variesWithRandom(s, a, next, p)) continue;
        const dealt = s.players[opp].leaderHp - next.players[opp].leaderHp;
        if (dealt + dfs(next, need - dealt, playedAfter(s, a, played)) >= need) {
          found = { a, next, dealt };
          break;
        }
      }
      if (!found) return null;
      seq.push(found.a);
      played = playedAfter(s, found.a, played);
      s = found.next;
      need -= found.dealt;
    }
    if (s.winner !== p) return null;
    exactLethalCounts.found++;
    return seq;
  } catch (e) {
    if (e instanceof Abort) return null;
    throw e;
  } finally {
    turnCache.visited += visited;
    if (opts.stats) Object.assign(opts.stats, { visited, memo: memo.size });
  }
}
