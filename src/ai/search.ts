// ターン単位の探索 AI。
//
// 1. 見えない情報は determinization（determinize.ts）で複数の「ありうる局面」を作って平均する
// 2. 各局面で、自分のターン終了までの行動の並びをビームサーチで探索する
// 3. 有望な並び（最初の手ごとの最善）について、相手のターンを貪欲法 AI で進めた後の局面を評価する
// 4. 平均の評価が最も良い「最初の手」を選ぶ（行動するたびに探索し直す）
// ただし、このターンで勝てる並び（リーサル、lethal.ts）が見つかれば、それを最優先する

import {
  actingPlayer,
  tryApplyAction,
  legalActions,
  resolveTurnEnd,
  type Action,
  type GameState,
  type PlayerIndex,
  type Rng,
} from "../engine";
import { convergingAttacks, settleConvergingTrades } from "./convergingTrade";
import { determinize } from "./determinize";
import { SEARCH_WEIGHTS, evaluateWith, type EvalWeights } from "./evaluate";
import { createGreedyAgent, greedyAgent } from "./greedy";
import { KeySet, turnOrderHash, turnOrderKey, withoutIds } from "./keySet";
import { DEFAULT_LETHAL_OPTIONS, findLethal, searchLethal, visibleKey, type LethalOptions } from "./lethal";
import { MULLIGAN_WEIGHTS, weightedMulliganSwap } from "./mulligan";
import { weightsFor } from "./weights";
import type { Agent } from "./types";

export interface SearchOptions {
  /** determinization の数 */
  samples: number;
  /** ビームの幅（既定 32。8→16→32→64 で勝率が上がり、時間との兼ね合いで 32。docs/ai-notes.md） */
  beamWidth: number;
  /** 1ターンに探索する行動数の上限（既定 8。chain のおかげで 6 でもほぼ足りるが、上限に当たる局面を減らす） */
  maxDepth: number;
  /** 相手のターンまで読んで評価し直す候補（最初の手）の数 */
  rescoreTop: number;
  /** リーサルの探索を行う */
  lethal: boolean;
  /** リーサルを探し直す条件（LethalOptions.recheck。既定は見えない情報が変わったときだけ） */
  lethalRecheck: LethalOptions["recheck"];
  /**
   * 評価関数の重み。"byClass" は自分のデッキのクラスに合わせて data/ai-weights.json の重みを使う。
   * 貪欲法で調整した重みは探索 AI では強くならなかった（210試合で 46.7%）ため、既定は基準の重みに融合で作るカードの価値を足したもの（SEARCH_WEIGHTS）
   */
  weights: EvalWeights | "byClass";
  /**
   * 自分（p）が打ってよい手か（ルールで禁じる手を探索から外す。ターン終了は外さない）。
   * リーサルの探索には使わない（リーサルはルールより優先する）
   */
  allow?: (state: GameState, action: Action, p: PlayerIndex) => boolean;
  /**
   * ビームに残す局面のうち、手の順番が違うだけの同じ局面を1つにまとめる
   * （ビームの枠を同じ局面で埋めて、少し後で得をする並びを切らないため）。
   * 効果で加わったカードの iid や場に出た順だけが違う局面もまとめる（turnOrderKey）
   */
  dedup: boolean;
  /**
   * 手札の同じカード（iid と表示用のスペルブーストの回数以外がすべて同じ。フェアリー2枚等）は、どちらをプレイしても同じなので1つだけ展開する
   * （iid が違うため dedup ではまとまらず、ビームの枠を同じ局面で埋めるため）
   */
  sameHandOnce: boolean;
  /**
   * 選択（対象の選択・モード）とエクストラPP を、続く手とまとめて 1 手として展開する。
   * 選択待ちの途中の局面を評価せず、深さも使わない（seed 954874822 のビショップ 6 ターン目・エルフ 7 ターン目。docs/ai-notes.md）
   */
  chain: boolean;
  /**
   * 融合を、続く自分の手とまとめて 1 手として展開する（融合だけで終える局面も残す。手札が 9 枚のとき融合して減らしておく手のため）。
   * 融合は評価値を変えないので、融合を挟む手順がビームで切られていた（seed 472546500 の AFネメシス 5 ターン目。docs/ai-notes.md）。
   * 融合に融合は続けない（続けると、コアの多い局面で 1 手 20 秒かかった）。
   * この形では勝率が変わらなかった（AFネメシス 44.0% → 44.0%）ため既定は無効
   */
  chainFuse: boolean;
  /**
   * ターン終了の局面の採点に、ターン終了時の処理（ターン終了時の能力等）を含める。
   * "all" はビームの中の局面も、"terminal" は最初の手ごとの最善を選ぶときだけ。"none" は含めない。
   * 既定は "all"（ターン終了時の能力は確定で起こるので、進めてから採点する。docs/ai-notes.md）
   */
  scoreTurnEnd: "none" | "terminal" | "all";
  /**
   * マリガン。"weights" はカードごとの重み（data/mulligan-weights.json。デフォルトデッキのみ、他はコストで決める）、
   * "cost" はコスト 4 以上を返す（貪欲法と同じ）。重みは今のマリガンに +3.1%（4200 組、docs/ai-notes.md）
   */
  mulligan: "weights" | "cost";
  /**
   * 合流する相打ち（convergingTrade.ts）を、ターンを終える前に打つものとして扱う。
   * ターン終了の局面はその攻撃を打ってから採点し、相手のターンもその局面から読む。
   * 合流する攻撃が残っている局面でのターン終了は、攻撃してから終える手に劣らないので候補から外す
   * （seed 2362697708 のビショップ 5 ターン目、進化したサレファでエースと相打ちしない。docs/ai-notes.md）。
   * 勝率は変わらず（200 試合で 49.5%）、1 手あたりの時間は約 1.07 倍
   */
  settleTrades: boolean;
  /**
   * ターン内で計画を使い回す。探索で選んだ手の後も、そのサンプルで最善だった並びのとおりに局面が進んでいれば
   * （見えている部分が予想と同じなら）、探索し直さずに並びの次の手を打つ。並びを打ち終えたら探索し直す
   */
  reusePlan: boolean;
  /** reusePlan のとき、最初の手ごとに相手のターンまで読む終局面の数 */
  planCandidates: number;
  /**
   * 相手のターンを読んだ後の局面で、自分の次のターンにリーサルがあるときに足す点（0 なら調べない）。
   * 調べ方は nextLethalSearch（既定は汎用のリーサル探索）。時間がかかるので、相手の体力が lethalRange 以下のときだけ調べる。
   * 評価関数は、次のターンに倒しきれる局面（クレストで疾走が付くフェアリー等）を見ていない（seed 2275116772 のエルフ 7 ターン目。docs/ai-notes.md）
   */
  nextLethal: number;
  nextLethalSearch?: (state: GameState, p: PlayerIndex) => boolean;
  /**
   * ビームに、最初の手ごとに少なくともこの数の局面を残す（幅を超えてもよい。0 なら幅だけで切る）。
   * 点数の高い最初の手の局面でビームが埋まると、他の最初の手の並びが途中で切れ、短い並びのまま相手のターンまで読まれる。
   * reusePlan ではその短い並びをそのまま打つ（seed 2275116772 のエルフ 7 ターン目、燐光の岩をコンボ 1 で出した。docs/ai-notes.md）
   */
  perFirst: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { samples: 3, beamWidth: 32, maxDepth: 8, rescoreTop: 4, lethal: true, lethalRecheck: "onNewInfo", weights: SEARCH_WEIGHTS, dedup: true, sameHandOnce: true, chain: true, chainFuse: false, scoreTurnEnd: "all", mulligan: "weights", settleTrades: true, reusePlan: true, planCandidates: 3, perFirst: 0, nextLethal: 0 };

/** 打った手の並び（後ろから前へのリスト）。各手を打った後の局面も持つ */
interface Step {
  action: Action;
  /** action を打った後の局面 */
  state: GameState;
  prev: Step | null;
}

interface Node {
  state: GameState;
  /** この並びの最初の手 */
  first: Action;
  value: number;
  /** この局面までの手の並び（最初の手を含む） */
  path: Step;
}

/** 並びを前から順の配列にする */
function stepsOf(path: Step): Step[] {
  const out: Step[] = [];
  for (let s: Step | null = path; s; s = s.prev) out.push(s);
  return out.reverse();
}

/** 1つのサンプルで、最初の手の評価値と、その手から始まる最善の並び */
interface Plan {
  action: Action;
  value: number;
  steps: Step[];
}

const keyOf = (a: Action) => JSON.stringify(a);

function tryApply(state: GameState, action: Action): GameState | null {
  try {
    return tryApplyAction(state, action);
  } catch {
    return null;
  }
}

/**
 * 自分のターンを終え、相手のターン（と、その途中の選択）を貪欲法で進め、自分の手番に戻った局面を返す。
 * 自分の選択待ちが残っている局面（能力の途中）は、先に貪欲法で選択してからターンを終える
 */
export function simulateOpponentTurn(state: GameState, p: PlayerIndex, rng: Rng): GameState {
  // determinization 済みの局面の中なので、局面をそのまま見てよい
  const policy = createGreedyAgent({ omniscient: true });
  let s: GameState | null = state;
  let ended = false;
  for (let guard = 0; s && s.phase !== "ended" && guard < 80; guard++) {
    if (!s.pending && s.active === p) {
      if (ended) break;
      s = tryApply(s, { type: "endTurn" });
      ended = true;
      continue;
    }
    s = tryApply(s, policy.chooseAction(s, legalActions(s), rng));
  }
  return s ?? state;
}

/** 手札の同じカードのプレイを1つに絞った手の一覧 */
function distinctPlays(state: GameState, actions: readonly Action[]): Action[] {
  const p = state.active;
  const seen = new Set<string>();
  return actions.filter((a) => {
    if (a.type !== "play") return true;
    const card = state.players[p].hand.find((h) => h.iid === a.iid);
    if (!card) return true;
    const k = JSON.stringify(withoutIds(card));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 評価の高い順に、同じ局面を除いて width 個まで選ぶ（children は評価の降順）。
 * perFirst が正なら、最初の手ごとに perFirst 個までは width を超えても残す
 */
function uniqueStates(children: Node[], width: number, perFirst = 0): Node[] {
  const seen = new KeySet();
  const out: Node[] = [];
  const count = new Map<string, number>();
  for (const c of children) {
    const k = keyOf(c.first);
    const n = count.get(k) ?? 0;
    if (out.length >= width) {
      if (perFirst === 0) break;
      if (n >= perFirst) continue;
    }
    if (!seen.addLazy(() => turnOrderKey(c.state), turnOrderHash(c.state))) continue;
    out.push(c);
    count.set(k, n + 1);
  }
  return out;
}

/** 1つの局面で、最初の手ごとの評価値を求める */
function planTurn(root: GameState, p: PlayerIndex, opts: SearchOptions, w: EvalWeights, rng: Rng): Map<string, Plan> {
  const terminals: Node[] = [];
  let frontier: Node[] = [];

  /** ターンを終える局面（合流する相打ちを打った後） */
  const settle = (state: GameState) => (opts.settleTrades ? settleConvergingTrades(state, p) : state);
  const endScore = (state: GameState) => evaluateWith(resolveTurnEnd(settle(state)), p, w);
  const score = opts.scoreTurnEnd === "all" ? endScore : (state: GameState) => evaluateWith(settle(state), p, w);
  const allowed = (state: GameState, a: Action) => !opts.allow || a.type === "endTurn" || opts.allow(state, a, p);
  const expand = (state: GameState) => (opts.sameHandOnce ? distinctPlays(state, legalActions(state)) : legalActions(state));
  /** 手 a を打った局面（と、そこまでの並び）。chain なら、続く自分の選択とエクストラPP の後の手まで進めた局面すべて */
  const advance = (state: GameState, a: Action, prev: Step | null, depth = 0): { state: GameState; path: Step }[] => {
    const next = tryApply(state, a);
    if (!next) return [];
    const path: Step = { action: a, state: next, prev };
    const self = [{ state: next, path }];
    if (!opts.chain || depth >= 8 || next.phase === "ended") return self;
    if (next.pending && next.pending.player === p) {
      const out = legalActions(next).flatMap((c) => (allowed(next, c) ? advance(next, c, path, depth + 1) : []));
      return out.length > 0 ? out : self;
    }
    if (opts.chainFuse && a.type === "fuse" && !next.pending && next.active === p) {
      // 融合に融合は続けない（融合の素材の選び方の組み合わせで、展開する手が膨らむ）
      const out = expand(next).flatMap((c) => (c.type === "endTurn" || c.type === "fuse" || !allowed(next, c) ? [] : advance(next, c, path, depth + 1)));
      return [...self, ...out];
    }
    if (a.type === "extraPp" && !next.pending && next.active === p) {
      const out = expand(next).flatMap((c) => (c.type === "endTurn" || c.type === "extraPp" || !allowed(next, c) ? [] : advance(next, c, path, depth + 1)));
      return out.length > 0 ? out : self;
    }
    return self;
  };

  // 深さ1: すべての手を展開する（最初の手の候補を落とさない）
  const rootConverges = opts.settleTrades && convergingAttacks(root, p).length > 0;
  for (const a of expand(root)) {
    if (!allowed(root, a)) continue;
    if (a.type === "endTurn") {
      if (rootConverges) continue; // 合流する攻撃をしてから終える手に劣らない
      terminals.push({ state: root, first: a, value: score(root), path: { action: a, state: root, prev: null } });
      continue;
    }
    for (const next of advance(root, a, null)) frontier.push({ ...next, first: a, value: score(next.state) });
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
      for (const a of expand(node.state)) {
        if (a.type === "endTurn" || !allowed(node.state, a)) continue;
        for (const next of advance(node.state, a, node.path)) children.push({ ...next, first: node.first, value: score(next.state) });
      }
    }
    children.sort((x, y) => y.value - x.value);
    frontier = opts.dedup ? uniqueStates(children, opts.beamWidth, opts.perFirst) : children.slice(0, opts.beamWidth);
  }
  terminals.push(...frontier);
  if (opts.scoreTurnEnd === "terminal") for (const t of terminals) t.value = endScore(t.state);

  // 最初の手ごとに最善の終局面を残し、上位を相手のターンまで読んで評価し直す
  // （計画を使い回すときは、最初の手ごとに異なる終局面を planCandidates 個まで読み、最も良いものをその手の評価と並びにする。
  //  使い回さないときは、2 手目以降は打つたびに読み直して選ぶが、使い回すと最初に選んだ並びをそのまま打つため）
  const bestByFirst = new Map<string, Node>();
  for (const t of terminals) {
    const k = keyOf(t.first);
    const cur = bestByFirst.get(k);
    if (!cur || t.value > cur.value) bestByFirst.set(k, t);
  }
  const ranked = [...bestByFirst.values()].sort((x, y) => y.value - x.value).slice(0, opts.rescoreTop);
  /** 最初の手 first の、評価の高い順に異なる終局面（最善の終局面 best を含めて planCandidates 個まで） */
  const candidatesOf = (best: Node): Node[] => {
    if (!opts.reusePlan || opts.planCandidates <= 1) return [best];
    const k = keyOf(best.first);
    const seen = new KeySet();
    seen.add(turnOrderKey(best.state), turnOrderHash(best.state));
    const out = [best];
    for (const t of [...terminals].filter((x) => x !== best && keyOf(x.first) === k).sort((x, y) => y.value - x.value)) {
      if (out.length >= opts.planCandidates) break;
      if (seen.addLazy(() => turnOrderKey(t.state), turnOrderHash(t.state))) out.push(t);
    }
    return out;
  };
  const hasNextLethal = opts.nextLethalSearch ?? ((state: GameState, q: PlayerIndex) => searchLethal(state, q) !== null);
  const result = new Map<string, Plan>();
  for (const best of ranked) {
    for (const node of candidatesOf(best)) {
      const after = node.state.phase === "ended" ? node.state : simulateOpponentTurn(settle(node.state), p, rng);
      let value = evaluateWith(after, p, w);
      if (opts.nextLethal !== 0 && after.phase !== "ended" && after.players[p === 0 ? 1 : 0].leaderHp <= w.lethalRange && hasNextLethal(after, p)) value += opts.nextLethal;
      const k = keyOf(node.first);
      const cur = result.get(k);
      if (!cur || value > cur.value) result.set(k, { action: node.first, value, steps: stepsOf(node.path) });
    }
  }
  return result;
}

export function createSearchAgent(options: Partial<SearchOptions> = {}): Agent {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  /** プレイヤーごとの、打っている途中の計画（reusePlan）。expected[i] は steps[i] を打つ前に見えているはずの局面 */
  const plans: [{ steps: Step[]; expected: string[]; index: number } | null, { steps: Step[]; expected: string[]; index: number } | null] = [null, null];
  return {
    name: "search",
    chooseAction(real, legal, rng) {
      const first = legal[0];
      if (!first) throw new Error("合法手がありません");
      if (legal.length === 1) return first;
      if (first.type === "mulligan") {
        const swap = opts.mulligan === "weights" ? weightedMulliganSwap(real, actingPlayer(real), MULLIGAN_WEIGHTS) : null;
        const action = swap && legal.find((a) => a.type === "mulligan" && a.swap.length === swap.length && a.swap.every((x) => swap.includes(x)));
        // 重みの無いデッキは貪欲法と同じ（コスト 4 以上を返す）
        return action || greedyAgent.chooseAction(real, legal, rng);
      }
      const p = real.pending ? real.pending.player : real.active;
      const legalKeys = new Set(legal.map(keyOf));

      if (opts.lethal) {
        const lethal = findLethal(real, p, rng, { ...DEFAULT_LETHAL_OPTIONS, recheck: opts.lethalRecheck });
        if (lethal && legalKeys.has(keyOf(lethal))) {
          plans[p] = null;
          return lethal;
        }
      }

      // 前に選んだ並びの途中で、局面が予想どおりなら続ける
      const plan = plans[p];
      plans[p] = null;
      if (plan && plan.index < plan.steps.length) {
        const next = plan.steps[plan.index]!.action;
        if (visibleKey(real, p) === plan.expected[plan.index] && legalKeys.has(keyOf(next))) {
          plan.index++;
          plans[p] = plan;
          return next;
        }
      }

      const w = opts.weights === "byClass" ? weightsFor(real, p) : opts.weights;
      const totals = new Map<string, { action: Action; sum: number; count: number; plan: Plan }>();
      for (let i = 0; i < opts.samples; i++) {
        const det = determinize(real, p, rng);
        for (const [k, sample] of planTurn(det, p, opts, w, rng)) {
          const t = totals.get(k) ?? { action: sample.action, sum: 0, count: 0, plan: sample };
          t.sum += sample.value;
          t.count++;
          // 並びは、その手の評価が最も高かったサンプルのものを使う
          if (sample.value > t.plan.value) t.plan = sample;
          totals.set(k, t);
        }
      }
      // 実際の局面で合法な手に限る。どのサンプルでも評価されなかった手は選ばない
      let best: { action: Action; plan: Plan } | null = null;
      let bestValue = -Infinity;
      for (const [k, t] of totals) {
        if (!legalKeys.has(k)) continue;
        // 評価されたサンプルが少ない手は割り引く（たまたま良いサンプルだけで選ばない）
        const value = t.sum / t.count - (opts.samples - t.count) * 0.5;
        if (value > bestValue) {
          bestValue = value;
          best = t;
        }
      }
      if (best) {
        if (opts.reusePlan && best.plan.steps.length > 1) {
          const steps = best.plan.steps;
          plans[p] = { steps, expected: steps.map((_, i) => (i === 0 ? "" : visibleKey(steps[i - 1]!.state, p))), index: 1 };
        }
        return best.action;
      }
      const allow = opts.allow;
      const permitted = allow ? legal.filter((a) => a.type === "endTurn" || allow(real, a, p)) : legal;
      return greedyAgent.chooseAction(real, permitted.length > 0 ? permitted : legal, rng);
    },
  };
}

export const searchAgent: Agent = createSearchAgent();
