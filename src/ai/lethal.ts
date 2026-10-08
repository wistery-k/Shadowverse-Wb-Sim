// リーサル（このターンでの勝利）の探索。
// 盤面評価とは別に「相手リーダーにどれだけダメージを通せるか」だけを見てビームサーチし、
// 勝てる行動の並びが見つかればその最初の手を返す。コンボや疾走のバーストを取りこぼさないため。
//
// - 各段階は「相手リーダーの体力 − このターンにまだリーダーへ与えられる攻撃のダメージ」が小さい順に残す
//   （手札を溜めて最後に大ダメージを出す並びを途中で切らないよう、コンボと残り PP も少し評価する）
// - 守護でないフォロワーへの攻撃はふつうリーサルに寄与しないので候補から外す
// - 手の順番が違うだけの同じ局面はまとめ、資源（PP・コンボ・進化・手札の枚数）の残し方が違う局面を残す
// - それで見つからず、手札に疾走フォロワーがあれば、「準備」を重く見る探索（LethalScoring.setup）でも探す
//   （例: フェアリーを相手のフォロワーに当てて煌撃の戦士・ベイルを安くし、コンボを溜めてリノセウスを出し、
//    聖樹の杖で手札に戻して出し直す）
// - 見つけた並びは、局面が予想どおりに進む限り最後まで続ける（途中の局面から探し直すと見つからないことがある）
// - 見つけた並びは別の determinization でも勝てるかを再生して確かめる（運任せのリーサルは選ばない）

import {
  applyAction,
  attackOf,
  attackTargets,
  cardOf,
  handCost,
  legalActions,
  staticOf,
  type Action,
  type FollowerOnBoard,
  type GameState,
  type HandCard,
  type PlayerIndex,
  type Rng,
} from "../engine";
import { determinize } from "./determinize";

export interface LethalOptions {
  beamWidth: number;
  maxDepth: number;
  /** 見つけた並びを確かめる determinization の数（最初に探索した1つを含む） */
  samples: number;
  /** ビームの並べ方。順に試し、最初に見つかった並びを使う */
  scorings: readonly LethalScoring[];
}

/**
 * リーサル探索の局面の点数の重み。基本は「相手リーダーの体力 − このターンにまだ与えられる攻撃のダメージ」で、
 * それに加えて、後で大きく殴るための準備（コンボ・残りPP・手札のコスト減）をどれだけ見るか
 */
export interface LethalScoring {
  combo: number;
  pp: number;
  costReduction: number;
  /**
   * 準備を重く見る探索にする。
   * - 手札の疾走フォロワーを今出したら増える、このターンの顔へのダメージ（最大のもの）を数える
   * - 守護でないフォロワーへの攻撃も試す（自分のフォロワーが場を離れると安くなるカード等で必要）
   * 遅いので、手札に疾走フォロワーがあるときだけ使う
   */
  setup: boolean;
  /** ビームの幅（LethalOptions.beamWidth に掛ける倍率） */
  widthFactor: number;
}

/** 今すぐ殴れるダメージを重く見る */
export const DIRECT_SCORING: LethalScoring = { combo: 0.25, pp: 0.05, costReduction: 0, setup: false, widthFactor: 1 };
/** 準備を重く見る（コンボを溜め、PP を残し、安くしてから殴る並び。リノセウスの出し直し等） */
export const SETUP_SCORING: LethalScoring = { combo: 0.25, pp: 0.05, costReduction: 0.05, setup: true, widthFactor: 2 };

export const DEFAULT_LETHAL_OPTIONS: LethalOptions = {
  beamWidth: 16,
  maxDepth: 14,
  samples: 3,
  scorings: [DIRECT_SCORING, SETUP_SCORING],
};

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
export function lethalScore(state: GameState, p: PlayerIndex, w: LethalScoring = DIRECT_SCORING): number {
  if (state.phase === "ended") return state.winner === p ? WIN : -WIN;
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  const prep = w.combo * me.combo + w.pp * me.pp + (w.costReduction > 0 ? w.costReduction * handCostReduction(state, p) : 0);
  const ready = readyFaceDamage(state, p);
  const storm = w.setup ? stormFromHand(state, p, ready) : 0;
  return -(opp.leaderHp - ready - storm) + prep;
}

const hasStorm = (h: HandCard) => staticOf(h.cardId).keywords.includes("storm") || h.keywords.includes("storm");

/** 手札の疾走フォロワーを1枚今出したときに増える、このターンの顔へのダメージ（最大） */
function stormFromHand(state: GameState, p: PlayerIndex, ready: number): number {
  if (state.pending || state.active !== p) return 0;
  let best = 0;
  for (const h of state.players[p].hand) {
    if (!hasStorm(h)) continue;
    const next = tryApply(state, { type: "play", iid: h.iid });
    if (!next || next.pending) continue;
    best = Math.max(best, readyFaceDamage(next, p) - ready);
  }
  return best;
}

/** 手札のカードのコストが元より下がっている合計（場を離れると安くなるカード等を、リーサルの準備として評価する） */
function handCostReduction(state: GameState, p: PlayerIndex): number {
  let total = 0;
  for (const h of state.players[p].hand) total += Math.max(0, cardOf(h.cardId).cost - handCost(h));
  return total;
}

/** リーサルの探索で試す手（ターン終了を除く。setup でなければ守護でないフォロワーへの攻撃も除く） */
function candidates(state: GameState, setup: boolean): Action[] {
  if (setup) return legalActions(state).filter((a) => a.type !== "endTurn");
  const opp = state.players[state.active === 0 ? 1 : 0];
  const wards = new Set(
    opp.board.filter((c) => c.kind === "follower" && (c.keywords.includes("ward") || c.tempKeywords.includes("ward"))).map((c) => c.iid),
  );
  return legalActions(state).filter(
    (a) => a.type !== "endTurn" && !(a.type === "attack" && a.target !== "leader" && !wards.has(a.target)),
  );
}

/** 局面の同一判定用のキー（このターンのリーサルに関わる部分だけ。山札の中身と乱数の状態は見ない） */
function stateKey(state: GameState): string {
  return JSON.stringify([
    state.players.map((pl) => [pl.leaderHp, pl.pp, pl.combo, pl.ep, pl.sep, pl.extraPpAvailable, pl.hand, pl.board, pl.crests, pl.deck.length]),
    state.pending,
    state.stack,
  ]);
}

interface Node {
  state: GameState;
  seq: Action[];
  score: number;
}

/**
 * 次の段階に残す局面を選ぶ。
 * - 手の順番が違うだけの同じ局面は1つにまとめる（ビームの枠を同じ局面で埋めない）
 * - 「残りPP・コンボ・超進化・進化・手札の枚数」の組ごとに最善の局面を先に残す
 *   （PP や超進化を温存した並び等を、目先の点数で切らない）
 * - 残りの枠は点数順に埋める
 */
function selectBeam(children: Node[], p: PlayerIndex, width: number): Node[] {
  children.sort((x, y) => y.score - x.score);
  const seen = new Set<string>();
  const unique: Node[] = [];
  for (const c of children) {
    const key = stateKey(c.state);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  const picked = new Set<Node>();
  const buckets = new Set<string>();
  for (const c of unique) {
    if (picked.size >= width) break;
    const me = c.state.players[p];
    const bucket = `${me.pp}:${me.combo}:${me.sep}:${me.ep}:${me.hand.length}`;
    if (buckets.has(bucket)) continue;
    buckets.add(bucket);
    picked.add(c);
  }
  for (const c of unique) {
    if (picked.size >= width) break;
    picked.add(c);
  }
  return unique.filter((c) => picked.has(c));
}

/** 1つの局面で、勝てる行動の並びを探す（ビームの並べ方を順に試す） */
export function searchLethal(root: GameState, p: PlayerIndex, opts: LethalOptions = DEFAULT_LETHAL_OPTIONS): Action[] | null {
  for (const w of opts.scorings) {
    // 疾走の打点の見込みを使う並べ方は、手札に疾走フォロワーがあるときだけ試す
    if (w.setup && !root.players[p].hand.some((h) => hasStorm(h))) continue;
    const seq = beamLethal(root, p, opts, w);
    if (seq) return seq;
  }
  return null;
}

function beamLethal(root: GameState, p: PlayerIndex, opts: LethalOptions, w: LethalScoring): Action[] | null {
  let frontier: Node[] = [{ state: root, seq: [], score: lethalScore(root, p, w) }];
  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth++) {
    const children: Node[] = [];
    for (const node of frontier) {
      const actor = node.state.pending ? node.state.pending.player : node.state.active;
      if (node.state.phase === "ended" || actor !== p) continue;
      for (const a of candidates(node.state, w.setup)) {
        const next = tryApply(node.state, a);
        if (!next) continue;
        const seq = [...node.seq, a];
        if (next.phase === "ended") {
          if (next.winner === p) return seq;
          continue;
        }
        children.push({ state: next, seq, score: lethalScore(next, p, w) });
      }
    }
    frontier = selectBeam(children, p, opts.beamWidth * w.widthFactor);
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
export function findLethal(
  real: GameState,
  p: PlayerIndex,
  rng: Rng,
  opts: LethalOptions = DEFAULT_LETHAL_OPTIONS,
  search: (root: GameState, p: PlayerIndex) => Action[] | null = (root, q) => searchLethal(root, q, opts),
): Action | null {
  const legal = legalActions(real);
  const legalKeys = new Set(legal.map((a) => JSON.stringify(a)));
  // 前に見つけた手順の途中で、局面が予想どおりなら続ける（途中の局面から探し直すと見つからないことがある）
  const planned = current && current.player === p ? current.steps[current.index] : undefined;
  if (current && planned && visibleKey(real, p) === current.expected[current.index] && legalKeys.has(JSON.stringify(planned))) {
    current.index++;
    return planned;
  }
  current = null;

  const det = determinize(real, p, rng);
  const seq = search(det, p);
  if (!seq || seq.length === 0) return null;
  for (let i = 1; i < opts.samples; i++) {
    if (!replayWins(determinize(real, p, rng), seq, p)) return null;
  }
  // 手順の各手を打つ前に見えているはずの局面を記録する
  const expected: string[] = [];
  let s: GameState | null = det;
  for (const a of seq) {
    expected.push(s ? visibleKey(s, p) : "");
    s = s ? tryApply(s, a) : null;
  }
  current = { player: p, steps: seq, expected, index: 1 };
  return seq[0] ?? null;
}

/** 実行中のリーサルの手順（findLethal が次の呼び出しで続けるため） */
let current: { player: PlayerIndex; steps: Action[]; expected: string[]; index: number } | null = null;

/** p から見える局面の要約（相手の手札・山札の中身と乱数の状態を除く） */
function visibleKey(s: GameState, p: PlayerIndex): string {
  const me = s.players[p];
  const opp = s.players[p === 0 ? 1 : 0];
  return JSON.stringify([
    s.turn,
    s.active,
    s.pending,
    s.stack,
    [me.leaderHp, me.pp, me.combo, me.ep, me.sep, me.extraPpAvailable, me.hand, me.board, me.crests, me.deck.length],
    [opp.leaderHp, opp.board, opp.crests, opp.hand.length, opp.deck.length],
  ]);
}
