// リーサル（このターンでの勝利）の探索。
// 盤面評価とは別に「相手リーダーにどれだけダメージを通せるか」だけを見てビームサーチし、
// 勝てる行動の並びが見つかればその最初の手を返す。コンボや疾走のバーストを取りこぼさないため。
//
// - 各段階は「相手リーダーの体力 − このターンにまだリーダーへ与えられる攻撃のダメージ」が小さい順に残す
//   （手札を溜めて最後に大ダメージを出す並びを途中で切らないよう、コンボと残り PP も少し評価する）
// - 守護でないフォロワーへの攻撃はリーサルに寄与しないので候補から外す
// - 見つけた並びは別の determinization でも勝てるかを再生して確かめる（運任せのリーサルは選ばない）

import {
  applyAction,
  attackOf,
  attackTargets,
  legalActions,
  type Action,
  type FollowerOnBoard,
  type GameState,
  type PlayerIndex,
  type Rng,
} from "../engine";
import { determinize } from "./determinize";

export interface LethalOptions {
  beamWidth: number;
  maxDepth: number;
  /** 見つけた並びを確かめる determinization の数（最初に探索した1つを含む） */
  samples: number;
}

export const DEFAULT_LETHAL_OPTIONS: LethalOptions = { beamWidth: 16, maxDepth: 14, samples: 3 };

const WIN = 1e9;

function tryApply(state: GameState, action: Action): GameState | null {
  try {
    return applyAction(state, action);
  } catch {
    return null;
  }
}

/** このターンにまだ相手リーダーへ与えられる攻撃のダメージ */
function readyFaceDamage(state: GameState, p: PlayerIndex): number {
  if (state.active !== p) return 0;
  let total = 0;
  for (const c of state.players[p].board) {
    if (c.kind !== "follower") continue;
    const f = c as FollowerOnBoard;
    if (attackTargets(state, f).includes("leader")) total += attackOf(f) * (f.maxAttacks - f.attacksThisTurn);
  }
  return total;
}

/** リーサル探索の評価（大きいほど良い） */
export function lethalScore(state: GameState, p: PlayerIndex): number {
  if (state.phase === "ended") return state.winner === p ? WIN : -WIN;
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  return -(opp.leaderHp - readyFaceDamage(state, p)) + 0.25 * me.combo + 0.05 * me.pp;
}

/** リーサルの探索で試す手（守護でないフォロワーへの攻撃とターン終了を除く） */
function candidates(state: GameState): Action[] {
  const opp = state.players[state.active === 0 ? 1 : 0];
  const wards = new Set(
    opp.board.filter((c) => c.kind === "follower" && (c.keywords.includes("ward") || c.tempKeywords.includes("ward"))).map((c) => c.iid),
  );
  return legalActions(state).filter(
    (a) => a.type !== "endTurn" && !(a.type === "attack" && a.target !== "leader" && !wards.has(a.target)),
  );
}

interface Node {
  state: GameState;
  seq: Action[];
  score: number;
}

/** 1つの局面で、勝てる行動の並びを探す */
export function searchLethal(root: GameState, p: PlayerIndex, opts: LethalOptions = DEFAULT_LETHAL_OPTIONS): Action[] | null {
  let frontier: Node[] = [{ state: root, seq: [], score: lethalScore(root, p) }];
  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth++) {
    const children: Node[] = [];
    for (const node of frontier) {
      const actor = node.state.pending ? node.state.pending.player : node.state.active;
      if (node.state.phase === "ended" || actor !== p) continue;
      for (const a of candidates(node.state)) {
        const next = tryApply(node.state, a);
        if (!next) continue;
        const seq = [...node.seq, a];
        if (next.phase === "ended") {
          if (next.winner === p) return seq;
          continue;
        }
        children.push({ state: next, seq, score: lethalScore(next, p) });
      }
    }
    children.sort((x, y) => y.score - x.score);
    frontier = children.slice(0, opts.beamWidth);
  }
  return null;
}

/** 行動の並びを再生して勝てるか */
function replayWins(state: GameState, seq: readonly Action[], p: PlayerIndex): boolean {
  let s: GameState | null = state;
  for (const a of seq) {
    if (!s || s.phase === "ended") break;
    s = tryApply(s, a);
  }
  return s !== null && s.phase === "ended" && s.winner === p;
}

/**
 * 実際の局面から、確実に勝てる行動の並びを探して最初の手を返す。見つからなければ null。
 * 見えない情報は determinization で扱い、別のサンプルでも勝てる並びだけを採用する。
 */
export function findLethal(real: GameState, p: PlayerIndex, rng: Rng, opts: LethalOptions = DEFAULT_LETHAL_OPTIONS): Action | null {
  const seq = searchLethal(determinize(real, p, rng), p, opts);
  if (!seq || seq.length === 0) return null;
  for (let i = 1; i < opts.samples; i++) {
    if (!replayWins(determinize(real, p, rng), seq, p)) return null;
  }
  return seq[0] ?? null;
}
