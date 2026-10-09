// 全探索のリーサル探索。ターン終了以外のすべての手を深さ優先で試し、同じ局面はまとめる（docs/ai-notes.md）。
//
// - 局面ごとに「ここから相手リーダーに与えられる最大のダメージ」をメモする。キーに相手リーダーの体力を含めないので、
//   体力だけが違う局面は 1 つにまとまる（相手の体力でできることが変わるカードには使えない）
// - 手札・場の並び順とインスタンス ID、相手の手札の中身はキーに含めない
// - 相手の体力に届いた時点で打ち切る。1 回に調べる局面の数が maxStates を超えたら諦める（null）
// - メモは同じターンの間、使い回す
// - 乱数を使う効果は、渡された局面の乱数の状態で決まった 1 通りだけを見る（他のリーサル探索と同じ）

import { legalActions, tryApplyAction, type Action, type GameState, type PlayerIndex } from "../engine";
import type { HandCard, OnBoard, PlayerState } from "../engine/types";

export interface ExactLethalOptions {
  /** 手を試す順番（省略時は legalActions の順） */
  order?: (s: GameState, p: PlayerIndex, actions: Action[]) => Action[];
  /** 1 回に調べる局面の数の上限 */
  maxStates: number;
  /** 1 ターンに調べる局面の数の上限（ターン中は手を打つたびに探し直すため） */
  maxStatesPerTurn: number;
  /** 必ず打つ手（あればその手だけを試す。森の神秘など、先に打って損の無い手） */
  forced?: (s: GameState, p: PlayerIndex, legal: Action[]) => Action | null;
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

function boardKey(c: OnBoard): string {
  let k = c.keywords.length || c.tempKeywords.length || c.granted.length ? json([c.keywords, c.tempKeywords, c.granted]) : "";
  if (c.kind === "amulet") return `A${c.cardId},${c.countdown},${c.sigils},${c.actedThisTurn ? 1 : 0}${k}`;
  if (Object.keys(c.usedOncePerTurn).length) k += json(c.usedOncePerTurn);
  return `F${c.cardId},${c.attack},${c.defense},${c.maxDefense},${c.tempAttack},${c.maxAttacks},${c.attacksThisTurn},${c.enteredTurn},${c.evolve},${c.cannotAttackUntil},${c.x}${k}`;
}

/** 相手（opponent）は体力と手札の中身を含めない */
function playerKey(pl: PlayerState, opponent: boolean): string {
  let k = `${opponent ? "" : pl.leaderHp},${pl.pp},${pl.maxPp},${pl.combo},${pl.ep},${pl.sep},${pl.evolvedThisTurn ? 1 : 0},${pl.extraPpAvailable ? 1 : 0},`;
  k += `${pl.deck.length},${pl.graveyard},${pl.graveyardFollowers.length},${pl.destroyedThisTurn.length},${pl.destroyedAmulets.length}`;
  if (pl.crests.length || Object.keys(pl.leaderOncePerTurn).length) k += json([pl.crests.map((c) => [c.crestId, c.countdown, c.usedOncePerTurn]), pl.leaderOncePerTurn]);
  const hand = opponent ? String(pl.hand.length) : pl.hand.map(handKey).sort().join(";");
  return `${k}|${hand}|${pl.board.map(boardKey).sort().join(";")}`;
}

/** 局面のキー（相手 opp のリーダーの体力と手札の中身、手札・場の並び順、インスタンス ID を除く） */
export function lethalKey(s: GameState, opp: PlayerIndex): string {
  let k = `${s.active}#${playerKey(s.players[0], opp === 0)}#${playerKey(s.players[1], opp === 1)}`;
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
let cache: { turn: number; player: PlayerIndex; memo: Memo; visited: number } | null = null;
const MAX_CACHE = 500_000;

/** メモを捨てる（テスト用） */
export function resetExactLethalCache(): void {
  cache = null;
}

function cacheFor(root: GameState, p: PlayerIndex): NonNullable<typeof cache> {
  if (!cache || cache.turn !== root.turn || cache.player !== p || cache.memo.size > MAX_CACHE) cache = { turn: root.turn, player: p, memo: new Map(), visited: 0 };
  return cache;
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
  const turnCache = cacheFor(root, p);
  const memo = turnCache.memo;
  const limit = Math.min(opts.maxStates, opts.maxStatesPerTurn - turnCache.visited);
  if (limit <= 0) return null;
  let visited = 0;

  const candidates = (s: GameState): Action[] => {
    const legal = legalActions(s).filter((a) => a.type !== "endTurn");
    const forced = s.pending ? null : (opts.forced?.(s, p, legal) ?? null);
    return forced ? [forced] : opts.order ? opts.order(s, p, legal) : legal;
  };

  /** s から与えられる最大のダメージ（need 以上が見つかればそこで打ち切った値） */
  const dfs = (s: GameState, need: number): number => {
    if (s.phase !== "main" || actorOf(s) !== p) return 0;
    // 選択待ち・解決中の局面はメモしない（キーが重く、すぐに次の局面に進むため）
    const key = isTransient(s) ? null : lethalKey(s, opp);
    const hit = key === null ? undefined : memo.get(key);
    if (hit && (hit.exact || hit.damage >= need)) return hit.damage;
    if (++visited > limit) throw new Abort();
    let best = 0;
    if (key !== null) memo.set(key, { damage: 0, exact: false });
    for (const a of candidates(s)) {
      const next = tryApplyAction(s, a);
      if (!next || (next.phase === "ended" && next.winner !== p)) continue;
      const dealt = s.players[opp].leaderHp - next.players[opp].leaderHp;
      const damage = dealt + dfs(next, need - dealt);
      if (damage > best) best = damage;
      if (best >= need) break;
    }
    // 打ち切ったなら best は最大値ではない（下限）
    const exact = best < need;
    if (key !== null) memo.set(key, { damage: best, exact });
    return best;
  };

  let need = root.players[opp].leaderHp;
  const seq: Action[] = [];
  try {
    if (dfs(root, need) < need) return null;
    // ダメージが足りる手を順にたどる（キーにインスタンス ID を含めないので、手そのものはメモしない）
    let s = root;
    while (s.phase !== "ended") {
      let found: { a: Action; next: GameState; dealt: number } | null = null;
      for (const a of candidates(s)) {
        const next = tryApplyAction(s, a);
        if (!next || (next.phase === "ended" && next.winner !== p)) continue;
        const dealt = s.players[opp].leaderHp - next.players[opp].leaderHp;
        if (dealt + dfs(next, need - dealt) >= need) {
          found = { a, next, dealt };
          break;
        }
      }
      if (!found) return null;
      seq.push(found.a);
      s = found.next;
      need -= found.dealt;
    }
    return s.winner === p ? seq : null;
  } catch (e) {
    if (e instanceof Abort) return null;
    throw e;
  } finally {
    turnCache.visited += visited;
    if (opts.stats) Object.assign(opts.stats, { visited, memo: memo.size });
  }
}
