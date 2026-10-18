// 打ち比べ: リプレイのある局面で、実戦の手と別の手をそれぞれ打ち、残りを AI に最後まで打たせて勝率を比べる。
// 1 試合は Rust の branch_playout（rust/engine/src/sim.rs）。手番のプレイヤーから見えない情報（相手の手札・山札の中身、
// 山札の順番、乱数の状態）を試合ごとに並べ直す。同じ番号の試合はどの手でも同じ並べ直し方・同じ AI の乱数にして、手の違いだけを比べる。

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

/** i 番目の試合のシード（base は打ち比べごとに変えてもよい） */
export function branchSeed(base: number, i: number): number {
  return nextRandom((base ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0)[1];
}

/** 1 試合の結果: 手番のプレイヤーが勝ったか（打てなかった・エラーなら null） */
export type Outcome = boolean | null;

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
