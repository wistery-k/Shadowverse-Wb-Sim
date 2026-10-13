// ターン単位の探索 AI。
//
// 1. 見えない情報は determinization（determinize.ts）で複数の「ありうる局面」を作って平均する
// 2. 各局面で、自分のターン終了までの行動の並びをビームサーチで探索する
// 3. 有望な並び（最初の手ごとの最善）について、相手のターンを貪欲法 AI（opponentSearch なら軽いビームサーチ）で進めた後の局面を評価する
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
import { DEFAULT_WEIGHTS, SEARCH_WEIGHTS, evaluateWith, type EvalWeights } from "./evaluate";
import { createGreedyAgent, greedyAgent } from "./greedy";
import { EqSet, turnOrderEqual, turnOrderHash, withoutIds } from "./keySet";
import { findLethal, searchLethal, visibleKey } from "./lethal";
import { MULLIGAN_WEIGHTS, weightedMulliganSwap } from "./mulligan";
import { MULLIGAN_MODEL, modelMulliganSwap, overrideMulliganCards } from "./mulliganModel";
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
   * "cost" はコスト 4 以上を返す（貪欲法と同じ）。重みは今のマリガンに +3.1%（4200 組、docs/ai-notes.md）。
   * "model" は手札の形のマリガン（data/mulligan-model.json と data/mulligan-roles.json。役割の無いデッキは "weights" と同じ）。
   * 既定は "model"（"weights" に +1.0%、12,600 組）
   */
  mulligan: "model" | "weights" | "cost";
  /** マリガンの重みで進化時能力持ちを 1 枚も残さないとき、最も重みの大きい 1 枚に足す値（weightedMulliganSwap の evoBonus。実験中、既定 0） */
  mulliganEvoBonus: number;
  /**
   * マリガンの "model" で、カード名ごとの「残した」の係数を置き換える（例: {"邪教の器":-0.03}。実験用、既定 null）。
   * 係数は自己対戦から推定したもので、人間の判断と逆向きのカードがある（ビショップの邪教の器。docs/ai-notes.md）
   */
  mulliganCards: Record<string, number> | null;
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
  /** 評価関数に足す項（デッキ専用の AI 用。ターン末の採点と、相手のターンを読んだ後の評価の両方に足す） */
  extraEval?: (state: GameState, p: PlayerIndex) => number;
  /**
   * ビームに、最初の手ごとに少なくともこの数の局面を残す（幅を超えてもよい。0 なら幅だけで切る）。
   * 点数の高い最初の手の局面でビームが埋まると、他の最初の手の並びが途中で切れ、短い並びのまま相手のターンまで読まれる。
   * reusePlan ではその短い並びをそのまま打つ（seed 2275116772 のエルフ 7 ターン目、燐光の岩をコンボ 1 で出した。docs/ai-notes.md）
   */
  perFirst: number;
  /**
   * ビームで残す局面を選ぶときだけ、残り PP 1 につきこの点を足す（0 なら足さない）。ターンを終える局面の点数には足さない。
   * ターン末の採点は使い残した PP を数えないため、コンボを稼ぐだけの手（すぐ戻すリノセウス等）と、PP を残して後で使う手順の途中の局面との比べ方が偏る
   */
  beamPp: number;
  /**
   * 自分のターン数が untilTurn 以下のとき、ビームサーチの代わりに、そのターンの手の並びを同じ局面をまとめて全て調べる（メモ化付きの全探索）。
   * 調べた局面が maxStates を超えたらやめて、ビームサーチで探す。null なら使わない（実験用）
   */
  exhaustive: { untilTurn: number; maxStates: number } | null;
  /**
   * 上位の手を相手のターンまで読むとき、相手のターンを貪欲法ではなく、局面をそのまま見たビームサーチ（幅 beamWidth・深さ maxDepth、
   * 相手のターン末の採点で最善の並び。相手の次のターンは読まない）で打つ。null なら貪欲法（既定。幅 4 で 52.3%・思考時間 約 3.7 倍のため保留）。
   * 貪欲法の読みは、消える人形を倒しに行く・タダで消える 1/1 を出さない等、相手の手を読み違える（docs/ai-notes.md）
   */
  opponentSearch: { beamWidth: number; maxDepth: number } | null;
  /**
   * 候補を相手のターンまで読むとき、相手の手札・山札を引き直した局面をこの数だけ作って相手のターンを打ち、評価を平均する
   * （1 なら引き直さず、その determinization のまま 1 回だけ読む）。
   * 相手の手札にある 1 枚で大きく動くカード（全体除去・疾走など）を、持っている確率に見合った重さで読みに入れるため
   */
  oppHandSamples: number;
  /** 実験用: 相手の手札を実際のまま読む（見えない情報を使う。手札読みの改善の上限を測るためだけに使い、対戦には使わない） */
  peekOppHand: boolean;
}

/** 全探索（SearchOptions.exhaustive）の集計（実験用。比較スクリプトが試合ごとに 0 に戻して読む） */
export const exhaustiveCounts = {
  /** 全探索した回数（サンプルごと） */
  searches: 0,
  /** 上限を超えてビームサーチに戻した回数 */
  overflow: 0,
  /** 読み切れたときに調べた局面の数の合計と最大 */
  states: 0,
  maxStates: 0,
  /** 同じ局面でビームサーチも行い、ターン末の点数の最善を比べた結果（全探索の方が高かった回数と、その差の合計） */
  better: 0,
  gain: 0,
  /** 全探索の方が高かったもののうち、最善の終局面の最初の手がビームサーチと違った回数 */
  firstDiffers: 0,
  /** 自分のターン数ごとの [全探索した回数, 上限超え, ビームより良い, 読み切れたときの局面数の合計] */
  byTurn: {} as Record<number, [number, number, number, number]>,
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { samples: 3, beamWidth: 32, maxDepth: 8, rescoreTop: 4, lethal: true, weights: SEARCH_WEIGHTS, dedup: true, sameHandOnce: true, chain: true, chainFuse: false, scoreTurnEnd: "all", mulligan: "model", mulliganEvoBonus: 0, mulliganCards: null, settleTrades: true, reusePlan: true, planCandidates: 3, perFirst: 0, nextLethal: 0, beamPp: 0, exhaustive: null, opponentSearch: null, oppHandSamples: 1, peekOppHand: false };

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

const OPPONENT_POLICY = createGreedyAgent({ omniscient: true });

/**
 * 自分のターンを終え、相手のターン（と、その途中の選択）を貪欲法で進め、自分の手番に戻った局面を返す。
 * 自分の選択待ちが残っている局面（能力の途中）は、先に貪欲法で選択してからターンを終える
 */
export function simulateOpponentTurn(state: GameState, p: PlayerIndex, rng: Rng, doomed = 1): GameState {
  // determinization 済みの局面の中なので、局面をそのまま見てよい
  const policy = doomed === 1 ? OPPONENT_POLICY : createGreedyAgent({ omniscient: true, weights: { ...DEFAULT_WEIGHTS, doomed } });
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

/**
 * simulateOpponentTurn の、相手のターンをビームサーチで打つ版（SearchOptions.opponentSearch）。
 * 自分のターンを終え、相手のターンは相手から見て最善の並び（ターン末の採点）を打ってから終える。
 * 相手のターン中の選択待ちなど、並びの外の手は貪欲法で進める
 */
function simulateOpponentTurnBySearch(state: GameState, p: PlayerIndex, rng: Rng, opts: SearchOptions, w: EvalWeights): GameState {
  const q: PlayerIndex = p === 0 ? 1 : 0;
  const policy = createGreedyAgent({ omniscient: true, weights: { ...DEFAULT_WEIGHTS, doomed: w.doomed } });
  const { allow: _allow, extraEval: _extra, ...rest } = opts;
  const oppOpts: SearchOptions = {
    ...rest,
    beamWidth: opts.opponentSearch?.beamWidth ?? opts.beamWidth,
    maxDepth: opts.opponentSearch?.maxDepth ?? opts.maxDepth,
    exhaustive: null,
    nextLethal: 0,
    opponentSearch: null,
  };
  let s: GameState | null = state;
  let ended = false;
  let searched = false;
  for (let guard = 0; s && s.phase !== "ended" && guard < 80; guard++) {
    if (!s.pending && s.active === p) {
      if (ended) break;
      s = tryApply(s, { type: "endTurn" });
      ended = true;
      continue;
    }
    if (ended && !searched && !s.pending && s.active === q) {
      searched = true;
      let best: Plan | null = null;
      for (const plan of planTurn(s, q, oppOpts, w, rng, false).values()) if (!best || plan.value > best.value) best = plan;
      const last = best?.steps[best.steps.length - 1];
      if (last && last.action.type !== "endTurn") {
        s = opts.settleTrades ? settleConvergingTrades(last.state, q) : last.state;
        if (s.phase === "ended") break;
      }
      if (!s.pending && s.active === q) {
        s = tryApply(s, { type: "endTurn" });
        continue;
      }
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
  const seen = new EqSet(turnOrderEqual);
  const out: Node[] = [];
  const count = new Map<string, number>();
  for (const c of children) {
    const k = keyOf(c.first);
    const n = count.get(k) ?? 0;
    if (out.length >= width) {
      if (perFirst === 0) break;
      if (n >= perFirst) continue;
    }
    if (!seen.add(c.state, turnOrderHash(c.state))) continue;
    out.push(c);
    count.set(k, n + 1);
  }
  return out;
}

/**
 * 1つの局面で、最初の手ごとの評価値を求める。
 * rescore が false なら相手のターンを読まず、最初の手ごとのターン末の最善の並びとその点数を返す（相手のターンを打つとき用）
 */
function planTurn(root: GameState, p: PlayerIndex, opts: SearchOptions, w: EvalWeights, rng: Rng, rescore = true): Map<string, Plan> {

  /** ターンを終える局面（合流する相打ちを打った後） */
  const settle = (state: GameState) => (opts.settleTrades ? settleConvergingTrades(state, p) : state);
  const extra = opts.extraEval;
  const evalState = extra ? (state: GameState) => evaluateWith(state, p, w) + extra(state, p) : (state: GameState) => evaluateWith(state, p, w);
  const endScore = (state: GameState) => evalState(resolveTurnEnd(settle(state)));
  const score = opts.scoreTurnEnd === "all" ? endScore : (state: GameState) => evalState(settle(state));
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

  const rootConverges = opts.settleTrades && convergingAttacks(root, p).length > 0;

  /** メモ化付きの全探索で、ターンを終えられる局面すべて（上限を超えたら null） */
  const exhaustiveTerminals = (maxStates: number): Node[] | null => {
    const out: Node[] = [];
    const stack: Node[] = [];
    for (const a of expand(root)) {
      if (!allowed(root, a)) continue;
      if (a.type === "endTurn") {
        if (!rootConverges) out.push({ state: root, first: a, value: score(root), path: { action: a, state: root, prev: null } });
        continue;
      }
      for (const next of advance(root, a, null)) stack.push({ ...next, first: a, value: 0 });
    }
    const seen = new EqSet(turnOrderEqual);
    let count = 0;
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!seen.add(node.state, turnOrderHash(node.state))) continue;
      if (++count > maxStates) return null;
      node.value = score(node.state);
      out.push(node);
      const actor = node.state.pending ? node.state.pending.player : node.state.active;
      if (node.state.phase === "ended" || actor !== p) continue;
      for (const a of expand(node.state)) {
        if (a.type === "endTurn" || !allowed(node.state, a)) continue;
        for (const next of advance(node.state, a, node.path)) stack.push({ ...next, first: node.first, value: 0 });
      }
    }
    exhaustiveCounts.states += count;
    exhaustiveCounts.maxStates = Math.max(exhaustiveCounts.maxStates, count);
    return out;
  };

  const beamTerminals = (): Node[] => {
  const terminals: Node[] = [];
  let frontier: Node[] = [];
  // 深さ1: すべての手を展開する（最初の手の候補を落とさない）
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
    if (opts.beamPp !== 0) {
      const key = (n: Node) => n.value + opts.beamPp * n.state.players[p].pp;
      children.sort((x, y) => key(y) - key(x));
    } else children.sort((x, y) => y.value - x.value);
    frontier = opts.dedup ? uniqueStates(children, opts.beamWidth, opts.perFirst) : children.slice(0, opts.beamWidth);
  }
  terminals.push(...frontier);
  return terminals;
  };

  let terminals: Node[] | null = null;
  if (opts.exhaustive && root.players[p].turnCount <= opts.exhaustive.untilTurn) {
    exhaustiveCounts.searches++;
    const turn = (exhaustiveCounts.byTurn[root.players[p].turnCount] ??= [0, 0, 0, 0]);
    turn[0]++;
    const before = exhaustiveCounts.states;
    terminals = exhaustiveTerminals(opts.exhaustive.maxStates);
    turn[3] += exhaustiveCounts.states - before;
    if (!terminals) {
      exhaustiveCounts.overflow++;
      turn[1]++;
    }
    else {
      // 比較用: 同じ局面のビームサーチの、ターン末の点数で最善の終局面
      const top = (ts: Node[]) => ts.reduce((a, b) => (b.value > a.value ? b : a));
      const ex = top(terminals);
      const beam = top(beamTerminals());
      if (ex.value > beam.value + 1e-9) {
        exhaustiveCounts.better++;
        turn[2]++;
        exhaustiveCounts.gain += ex.value - beam.value;
        if (keyOf(ex.first) !== keyOf(beam.first)) exhaustiveCounts.firstDiffers++;
      }
    }
  }
  if (!terminals) terminals = beamTerminals();
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
  if (!rescore) return new Map([...bestByFirst].map(([k, t]) => [k, { action: t.first, value: t.value, steps: stepsOf(t.path) }]));
  const ranked = [...bestByFirst.values()].sort((x, y) => y.value - x.value).slice(0, opts.rescoreTop);
  /** 最初の手 first の、評価の高い順に異なる終局面（最善の終局面 best を含めて planCandidates 個まで） */
  const candidatesOf = (best: Node): Node[] => {
    if (!opts.reusePlan || opts.planCandidates <= 1) return [best];
    const k = keyOf(best.first);
    const seen = new EqSet(turnOrderEqual);
    seen.add(best.state, turnOrderHash(best.state));
    const out = [best];
    for (const t of [...terminals].filter((x) => x !== best && keyOf(x.first) === k).sort((x, y) => y.value - x.value)) {
      if (out.length >= opts.planCandidates) break;
      if (seen.add(t.state, turnOrderHash(t.state))) out.push(t);
    }
    return out;
  };
  const hasNextLethal = opts.nextLethalSearch ?? ((state: GameState, q: PlayerIndex) => searchLethal(state, q) !== null);
  const result = new Map<string, Plan>();
  for (const best of ranked) {
    for (const node of candidatesOf(best)) {
      const readOnce = (start: GameState): number => {
        const after = opts.opponentSearch ? simulateOpponentTurnBySearch(start, p, rng, opts, w) : simulateOpponentTurn(start, p, rng, w.doomed);
        let v = evalState(after);
        if (opts.nextLethal !== 0 && after.phase !== "ended" && after.players[p === 0 ? 1 : 0].leaderHp <= w.lethalRange && hasNextLethal(after, p)) v += opts.nextLethal;
        return v;
      };
      let value: number;
      if (node.state.phase === "ended") value = evalState(node.state);
      else if (opts.oppHandSamples <= 1) value = readOnce(settle(node.state));
      else {
        const settled = settle(node.state);
        let sum = 0;
        for (let i = 0; i < opts.oppHandSamples; i++) sum += readOnce(determinize(settled, p, rng, { peekOppHand: opts.peekOppHand }));
        value = sum / opts.oppHandSamples;
      }
      const k = keyOf(node.first);
      const cur = result.get(k);
      if (!cur || value > cur.value) result.set(k, { action: node.first, value, steps: stepsOf(node.path) });
    }
  }
  return result;
}

export function createSearchAgent(options: Partial<SearchOptions> = {}): Agent {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  const mulliganModel = opts.mulliganCards ? overrideMulliganCards(MULLIGAN_MODEL, opts.mulliganCards) : MULLIGAN_MODEL;
  /** プレイヤーごとの、打っている途中の計画（reusePlan）。expected[i] は steps[i] を打つ前に見えているはずの局面 */
  const plans: [{ steps: Step[]; expected: string[]; index: number } | null, { steps: Step[]; expected: string[]; index: number } | null] = [null, null];
  return {
    name: "search",
    chooseAction(real, legal, rng) {
      const first = legal[0];
      if (!first) throw new Error("合法手がありません");
      if (legal.length === 1) return first;
      if (first.type === "mulligan") {
        const p0 = actingPlayer(real);
        const modelSwap = opts.mulligan === "model" ? modelMulliganSwap(real, p0, mulliganModel) : null;
        const swap = modelSwap ?? (opts.mulligan !== "cost" ? weightedMulliganSwap(real, p0, MULLIGAN_WEIGHTS, { evoBonus: opts.mulliganEvoBonus }) : null);
        const action = swap && legal.find((a) => a.type === "mulligan" && a.swap.length === swap.length && a.swap.every((x) => swap.includes(x)));
        // 重みの無いデッキは貪欲法と同じ（コスト 4 以上を返す）
        return action || greedyAgent.chooseAction(real, legal, rng);
      }
      const p = real.pending ? real.pending.player : real.active;
      const legalKeys = new Set(legal.map(keyOf));

      if (opts.lethal) {
        const lethal = findLethal(real, p, rng);
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
        const det = determinize(real, p, rng, { peekOppHand: opts.peekOppHand });
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
