// 打ち比べ: リプレイのある局面で、実戦の手と別の手（か、続けて打つ手の列）をそれぞれ打ち、残りを AI に最後まで打たせて勝率を比べる。
// 1 試合は Rust の branch_playout・branch_line_playout（rust/engine/src/sim.rs）。手番のプレイヤーから見えない情報（相手の手札・山札の中身、
// 山札の順番、乱数の状態）を試合ごとに並べ直す。同じ番号の試合はどの手でも同じ並べ直し方・同じ AI の乱数にして、手の違いだけを比べる。
// 手の列の 2 手目からは、並べ直した局面で同じ手（手の種類と、指すカードの持ち主・場所・カード）を探して打つ。無ければそこから AI が打つ。

import { nextRandom, type Action, type GameState, type PlayerIndex } from "../engine";
import { callEngine } from "../engine/wasm";

export interface PlayoutResult {
  winner: PlayerIndex | null;
  turns: number;
}

/** 打ち比べの 1 試合。action がこの試合の並べ直した局面で打てなければ null */
export function branchPlayout(state: GameState, action: Action, agents: readonly [string, string], seed: number): PlayoutResult | null {
  return callEngine({ f: "branchPlayout", state, action, agents, seed: seed >>> 0 }) as PlayoutResult | null;
}

export interface LineResult extends PlayoutResult {
  /** 手の列のうち、この試合で打てた手の数（最初の手は必ず打つ。手の列の長さと同じなら全部打てた） */
  followed: number;
  /** 始めのターンに打った手（手の列の手と、その後に AI が打った続き。ターン終了か決着まで）の説明。選ぶ手は直前の手にまとめる */
  turn: string[];
}

/** 打ち比べの、手の列 line を打ってから続きを AI に打たせる 1 試合。最初の手がこの試合の並べ直した局面で打てなければ null。
 *  手が 1 つなら branchPlayout と同じ試合になる */
export function branchLine(state: GameState, line: readonly Action[], agents: readonly [string, string], seed: number): LineResult | null {
  return callEngine({ f: "branchLine", state, line, agents, seed: seed >>> 0 }) as LineResult | null;
}

/** i 番目の試合のシード（base は打ち比べごとに変えてもよい） */
export function branchSeed(base: number, i: number): number {
  return nextRandom((base ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0)[1];
}

/** 1 試合の結果: 手番のプレイヤーが勝ったか（打てなかった・エラーなら null） */
export type Outcome = boolean | null;

/** 1 試合の結果と、手の列をどこまで打てたか・始めのターンに打った手（打てなかった・エラーなら followed は 0、turn は空） */
export interface Played {
  outcome: Outcome;
  followed: number;
  turn: string[];
  /** 早い決着（quickEnd）。打てなかった・エラーなら null */
  quick: QuickEnd;
}

/** 早い決着: "lost" は手番のプレイヤーの次のターンが来る前に負けた（すぐ負けた）、"won" は次のターンまでに勝った（このターンの勝ちも含む。次勝った） */
export type QuickEnd = "lost" | "won" | null;

/** 打ち比べの局面 start（手番のプレイヤー viewer）から打った試合が、ターン endTurn に winner の勝ちで終わったときの早い決着 */
export function quickEnd(start: Pick<GameState, "turn" | "active">, viewer: PlayerIndex, winner: PlayerIndex | null, endTurn: number): QuickEnd {
  if (winner === null) return null;
  // viewer の次のターンの番号（ふつうは viewer のターンの局面なので、相手のターンをはさんで 2 つ先）
  const next = start.turn + (start.active === viewer ? 2 : 1);
  if (winner === viewer) return endTurn <= next ? "won" : null;
  return endTurn < next ? "lost" : null;
}

/** 結果の出た試合のうち、すぐ負けた・次勝った試合の数 */
export function quickCounts(played: readonly (Played | undefined)[]): { lost: number; won: number; decided: number } {
  let lost = 0;
  let won = 0;
  let decided = 0;
  for (const p of played) {
    if (!p || p.outcome === null) continue;
    decided++;
    if (p.quick === "lost") lost++;
    if (p.quick === "won") won++;
  }
  return { lost, won, decided };
}

/** 始めのターンに打った手順ごとの回数（同じ手順の試合をまとめ、多い順。同じ回数なら手順の文言の順） */
export interface TurnTally {
  /** 手順（「 → 」でつないだもの。何も打たなかったら空） */
  text: string;
  games: number;
  /** 勝ち負けの出た試合のうち、手番のプレイヤーが勝った数 */
  wins: number;
  decided: number;
}

export function tallyTurns(played: readonly (Played | undefined)[]): TurnTally[] {
  const by = new Map<string, TurnTally>();
  for (const p of played) {
    if (!p || p.outcome === null) continue;
    const text = p.turn.join(" → ");
    const t = by.get(text) ?? { text, games: 0, wins: 0, decided: 0 };
    t.games++;
    t.decided++;
    if (p.outcome) t.wins++;
    by.set(text, t);
  }
  return [...by.values()].sort((a, b) => b.games - a.games || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

export interface BranchStats {
  /** 結果が出た試合数 */
  games: number;
  wins: number;
  /** 打てなかった・エラーになった試合数 */
  skipped: number;
  /** 勝率の 95% の幅（±。正規近似） */
  margin: number;
}

export interface DiffStats {
  /** 両方の結果が出た試合数 */
  games: number;
  /** 勝率の差（別の手 − 実戦の手） */
  diff: number;
  /** 差の 95% の幅（±。同じ並べ直しの試合どうしの差から） */
  margin: number;
}

export function branchStats(outcomes: readonly Outcome[]): BranchStats {
  const valid = outcomes.filter((o): o is boolean => o !== null);
  const wins = valid.filter((o) => o).length;
  const n = valid.length;
  const p = n > 0 ? wins / n : 0;
  return { games: n, wins, skipped: outcomes.length - n, margin: n > 1 ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 1 };
}

/** 同じ番号の試合どうしの勝ち負けの差（other − base）の平均と 95% の幅（まだ結果が無い試合は undefined） */
export function diffStats(base: readonly (Outcome | undefined)[], other: readonly (Outcome | undefined)[]): DiffStats {
  const d: number[] = [];
  for (let i = 0; i < Math.min(base.length, other.length); i++) {
    const a = base[i];
    const b = other[i];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    d.push(Number(b) - Number(a));
  }
  const n = d.length;
  if (n === 0) return { games: 0, diff: 0, margin: 1 };
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 1;
  return { games: n, diff: mean, margin: n > 1 ? 1.96 * Math.sqrt(variance / n) : 1 };
}
