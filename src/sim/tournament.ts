// AI 同士の総当たり対戦（計画・実行・集計）。Node のコマンドとブラウザの Worker で共通に使う。

import { agentOf } from "../ai/registry";
import { nextRandom } from "../engine";
import { playMatch } from "./match";

/** 参加者（デッキと AI の組） */
export interface Entrant {
  name: string;
  deck: readonly string[];
  /** src/ai/registry.ts のキー */
  agent: string;
}

/** 1試合の指定。a・b は参加者の添字 */
export interface GameSpec {
  a: number;
  b: number;
  seed: number;
  /** a をプレイヤー0（seat 0）にするか。偶数・奇数の試合で入れ替えて偏りを減らす */
  aIsPlayer0: boolean;
}

export interface GameRecord {
  a: number;
  b: number;
  seed: number;
  /** 勝った参加者の添字。エラーなら null */
  winner: number | null;
  /** 先攻だった参加者の添字 */
  first: number | null;
  turns: number;
  error?: string;
}

export interface PlanOptions {
  gamesPerPair: number;
  seed: number;
  /** 同じ参加者同士（ミラー）も対戦させる */
  mirror?: boolean;
}

function mix(seed: number, ...xs: number[]): number {
  let s = seed >>> 0;
  for (const x of xs) s = nextRandom((s ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
  return s;
}

export function planGames(entrantCount: number, opts: PlanOptions): GameSpec[] {
  const specs: GameSpec[] = [];
  for (let a = 0; a < entrantCount; a++) {
    for (let b = opts.mirror ? a : a + 1; b < entrantCount; b++) {
      for (let g = 0; g < opts.gamesPerPair; g++) {
        specs.push({ a, b, seed: mix(opts.seed, a, b, g), aIsPlayer0: g % 2 === 0 });
      }
    }
  }
  return specs;
}

export function runGame(spec: GameSpec, entrants: readonly Entrant[]): GameRecord {
  const ea = entrants[spec.a];
  const eb = entrants[spec.b];
  if (!ea || !eb) throw new Error("参加者がいません");
  const [p0, p1] = spec.aIsPlayer0 ? [ea, eb] : [eb, ea];
  const toEntrant = (player: number) => (player === 0) === spec.aIsPlayer0 ? spec.a : spec.b;
  try {
    const r = playMatch([agentOf(p0.agent), agentOf(p1.agent)], { decks: [p0.deck, p1.deck], seed: spec.seed });
    return { a: spec.a, b: spec.b, seed: spec.seed, winner: toEntrant(r.winner), first: toEntrant(r.final.first), turns: r.turns };
  } catch (e) {
    return { a: spec.a, b: spec.b, seed: spec.seed, winner: null, first: null, turns: 0, error: String(e) };
  }
}

export interface EntrantSummary {
  games: number;
  wins: number;
}

export interface TournamentSummary {
  entrants: EntrantSummary[];
  /** wins[i][j]: i が j に勝った回数 */
  wins: number[][];
  /** games[i][j]: i と j の試合数（エラーを除く） */
  games: number[][];
  totalGames: number;
  firstPlayerWins: number;
  averageTurns: number;
  errors: GameRecord[];
}

export function summarize(entrantCount: number, records: readonly GameRecord[]): TournamentSummary {
  const n = entrantCount;
  const wins = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const games = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const entrants = Array.from({ length: n }, () => ({ games: 0, wins: 0 }));
  let firstPlayerWins = 0;
  let turns = 0;
  let total = 0;
  const errors: GameRecord[] = [];
  for (const r of records) {
    if (r.winner === null) {
      errors.push(r);
      continue;
    }
    total++;
    turns += r.turns;
    if (r.winner === r.first) firstPlayerWins++;
    const loser = r.winner === r.a ? r.b : r.a;
    if (r.a === r.b) {
      // ミラーは対戦表の対角に試合数だけ数え、参加者の通算勝率には含めない
      games[r.a]![r.a]!++;
      continue;
    }
    games[r.a]![r.b]!++;
    games[r.b]![r.a]!++;
    wins[r.winner]![loser]!++;
    entrants[r.a]!.games++;
    entrants[r.b]!.games++;
    entrants[r.winner]!.wins++;
  }
  return {
    entrants,
    wins,
    games,
    totalGames: total,
    firstPlayerWins,
    averageTurns: total > 0 ? turns / total : 0,
    errors,
  };
}
