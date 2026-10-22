// 「AI の考え」: ある局面で AI が比べた手と、その点数の内訳（rust/engine/src/ai/think.rs。リプレイの表示に使う）。
// AI は WASM の中でその場で作り、前の局面で決めた並びを使わずに考え直す。同じ rng なら、その AI が選ぶ手（chosen）は agentChoose と同じ。

import type { Action, GameState, PlayerIndex } from "../engine";
import { callEngine } from "../engine/wasm";

/** 点数の内訳。total は探索が使った点数、eval は手で作った評価関数、extra は評価に足す項（学習した補正など） */
export interface ScoreParts {
  total: number;
  eval: number;
  extra: number;
}

export interface ThoughtCandidate {
  /** 最初の手 */
  action: Action;
  /** 並びを打った決定化の局面（Thought.roots の添字）と、その局面からの並び（このターンの終わりまで） */
  sample: number;
  steps: Action[];
  /** ターン末の点数（ビームサーチが並びを選んだ点数） */
  turnEnd: ScoreParts;
  /** 相手のターンを読み直した後の点数（読み直した決定化の平均。読み直していなければ null） */
  read: ScoreParts | null;
  readCount: number;
  /** 手を選ぶときの値（read にターン末の点数を混ぜた値など。読み直していなければ null） */
  value: number | null;
  /** 実際の局面で打てる手か */
  legal: boolean;
}

export interface Thought {
  player: PlayerIndex;
  /** 見つけたリーサルの最初の手（見つければ並びを比べずにこれを打つ） */
  lethal: Action | null;
  /** 決定化した局面（相手の手札・山札の中身と山札の順番を並べ直したもの） */
  roots: GameState[];
  /** 読み直した手（選ぶときの値の高い順）、続いて読み直さなかった手（ターン末の点数の高い順） */
  candidates: ThoughtCandidate[];
  /** 選ぶ手 */
  chosen: Action;
}

/** 局面 state で、AI agent（src/ai/registry.ts のキー）の考え。考えを示せない AI・局面（マリガン、打てる手が 1 つ）なら null */
export function think(agent: string, state: GameState, rng: number): Thought | null {
  return callEngine({ f: "agentThink", agent, state, rng: rng >>> 0 }) as Thought | null;
}

/** 考えを示せる AI（探索 AI をもとにしたもの） */
export const THINKING_AGENTS: ReadonlySet<string> = new Set(["search", "search-classic", "yardstick", "rhino", "rhino-lethal"]);
