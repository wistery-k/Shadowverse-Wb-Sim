// ターン単位の探索 AI。
//
// 1. 見えない情報は determinization（determinize.ts）で複数の「ありうる局面」を作って平均する
// 2. 各局面で、自分のターン終了までの行動の並びをビームサーチで探索する
// 3. 有望な並び（最初の手ごとの最善）について、相手のターンを貪欲法 AI で進めた後の局面を評価する
// 4. 平均の評価が最も良い「最初の手」を選ぶ（行動するたびに探索し直す）
// ただし、このターンで勝てる並び（リーサル、lethal.ts）が見つかれば、それを最優先する

import {
  applyAction,
  legalActions,
  type Action,
  type GameState,
  type PlayerIndex,
  type Rng,
} from "../engine";
import { determinize } from "./determinize";
import { DEFAULT_WEIGHTS, evaluateWith, type EvalWeights } from "./evaluate";
import { createGreedyAgent, greedyAgent, mulliganAction, type MulliganPolicy } from "./greedy";
import { findLethal } from "./lethal";
import { weightsFor } from "./weights";
import type { Agent } from "./types";

export interface SearchOptions {
  /** determinization の数 */
  samples: number;
  /** ビームの幅 */
  beamWidth: number;
  /** 1ターンに探索する行動数の上限 */
  maxDepth: number;
  /** 相手のターンまで読んで評価し直す候補（最初の手）の数 */
  rescoreTop: number;
  /** リーサルの探索を行う */
  lethal: boolean;
  /** マリガンの方法 */
  mulligan: MulliganPolicy;
  /**
   * 評価関数の重み。"byClass" は自分のデッキのクラスに合わせて data/ai-weights.json の重みを使う。
   * 貪欲法で調整した重みは探索 AI では強くならなかった（210試合で 46.7%）ため、既定は基準の重み
   */
  weights: EvalWeights | "byClass";
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { samples: 3, beamWidth: 8, maxDepth: 6, rescoreTop: 4, lethal: true, weights: DEFAULT_WEIGHTS, mulligan: "rule" };

interface Node {
  state: GameState;
  /** この並びの最初の手 */
  first: Action;
  value: number;
}

const keyOf = (a: Action) => JSON.stringify(a);

function tryApply(state: GameState, action: Action): GameState | null {
  try {
    return applyAction(state, action);
  } catch {
    return null;
  }
}

/** 相手のターン（と、その途中の選択）を貪欲法で進め、自分の手番に戻った局面を返す */
function simulateOpponentTurn(state: GameState, p: PlayerIndex, rng: Rng): GameState {
  // determinization 済みの局面の中なので、相手は局面をそのまま見てよい
  const opponentPolicy = createGreedyAgent({ omniscient: true });
  let s = tryApply(state, { type: "endTurn" });
  for (let guard = 0; s && s.phase !== "ended" && guard < 60; guard++) {
    const actor = s.pending ? s.pending.player : s.active;
    if (actor === p && !s.pending) break;
    s = tryApply(s, opponentPolicy.chooseAction(s, legalActions(s), rng));
  }
  return s ?? state;
}

/** 1つの局面で、最初の手ごとの評価値を求める */
function planTurn(root: GameState, p: PlayerIndex, opts: SearchOptions, w: EvalWeights, rng: Rng): Map<string, { action: Action; value: number }> {
  const terminals: Node[] = [];
  let frontier: Node[] = [];

  // 深さ1: すべての手を展開する（最初の手の候補を落とさない）
  for (const a of legalActions(root)) {
    if (a.type === "endTurn") {
      terminals.push({ state: root, first: a, value: evaluateWith(root, p, w) });
      continue;
    }
    const next = tryApply(root, a);
    if (next) frontier.push({ state: next, first: a, value: evaluateWith(next, p, w) });
  }

  for (let depth = 1; depth < opts.maxDepth && frontier.length > 0; depth++) {
    const children: Node[] = [];
    for (const node of frontier) {
      const actor = node.state.pending ? node.state.pending.player : node.state.active;
      if (node.state.phase === "ended" || actor !== p) {
        terminals.push(node);
        continue;
      }
      // ターン終了も候補（その時点の局面で終える）
      terminals.push(node);
      for (const a of legalActions(node.state)) {
        if (a.type === "endTurn") continue;
        const next = tryApply(node.state, a);
        if (next) children.push({ state: next, first: node.first, value: evaluateWith(next, p, w) });
      }
    }
    children.sort((x, y) => y.value - x.value);
    frontier = children.slice(0, opts.beamWidth);
  }
  terminals.push(...frontier);

  // 最初の手ごとに最善の終局面を残し、上位を相手のターンまで読んで評価し直す
  const bestByFirst = new Map<string, Node>();
  for (const t of terminals) {
    const k = keyOf(t.first);
    const cur = bestByFirst.get(k);
    if (!cur || t.value > cur.value) bestByFirst.set(k, t);
  }
  const ranked = [...bestByFirst.values()].sort((x, y) => y.value - x.value);
  const result = new Map<string, { action: Action; value: number }>();
  for (const node of ranked.slice(0, opts.rescoreTop)) {
    const after = node.state.phase === "ended" ? node.state : simulateOpponentTurn(node.state, p, rng);
    result.set(keyOf(node.first), { action: node.first, value: evaluateWith(after, p, w) });
  }
  return result;
}

export function createSearchAgent(options: Partial<SearchOptions> = {}): Agent {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  return {
    name: "search",
    chooseAction(real, legal, rng) {
      const first = legal[0];
      if (!first) throw new Error("合法手がありません");
      if (legal.length === 1) return first;
      if (first.type === "mulligan") return mulliganAction(real, legal, first.player, opts.mulligan);
      const p = real.pending ? real.pending.player : real.active;
      const legalKeys = new Set(legal.map(keyOf));

      if (opts.lethal) {
        const lethal = findLethal(real, p, rng);
        if (lethal && legalKeys.has(keyOf(lethal))) return lethal;
      }

      const w = opts.weights === "byClass" ? weightsFor(real, p) : opts.weights;
      const totals = new Map<string, { action: Action; sum: number; count: number }>();
      for (let i = 0; i < opts.samples; i++) {
        const det = determinize(real, p, rng);
        for (const [k, { action, value }] of planTurn(det, p, opts, w, rng)) {
          const t = totals.get(k) ?? { action, sum: 0, count: 0 };
          t.sum += value;
          t.count++;
          totals.set(k, t);
        }
      }
      // 実際の局面で合法な手に限る。どのサンプルでも評価されなかった手は選ばない
      let best: Action | null = null;
      let bestValue = -Infinity;
      for (const [k, t] of totals) {
        if (!legalKeys.has(k)) continue;
        // 評価されたサンプルが少ない手は割り引く（たまたま良いサンプルだけで選ばない）
        const value = t.sum / t.count - (opts.samples - t.count) * 0.5;
        if (value > bestValue) {
          bestValue = value;
          best = t.action;
        }
      }
      return best ?? greedyAgent.chooseAction(real, legal, rng);
    },
  };
}

export const searchAgent: Agent = createSearchAgent();
