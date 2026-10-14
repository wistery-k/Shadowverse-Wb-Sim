// 探索 AI の評価の重みを、探索 AI どうしの対戦の勝率で調整する（npm run spsa）。
//
// SPSA（同時摂動確率近似）: 毎回、調整する重みすべてを同時に ±c（対数で。±20% なら c 0.2）ずらした 2 つの重み（+ と −）を作り、
// compare と同じ組み合わせ（7 デッキ、席とデッキを入れ替えた 2 試合ずつ）で + と − を直接対戦させる。
// + の勝ち越し（+ の勝率 − − の勝率）から重みごとの勾配を推定し、重みを動かす。毎回新しい試合番号を使う（特定の試合に合わせすぎないため）。
// 1 回ごとに出力ファイルに 1 行（その回の結果と、動かした後の重み）を追記し、同じ引数で再開できる。
// 最後に、後半の回の重みの平均（ぶれを減らすため）を、SEARCH_WEIGHTS との差として出す。compare の "weights" にそのまま渡せる。
// 調整に使った試合では確かめない。採用は、別の試合番号での compare の勝率で決める（docs/ai-notes.md）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SEARCH_WEIGHTS, type EvalWeights } from "../src/ai/evaluate";
import { createSearchAgent } from "../src/ai/search";
import { rngFrom } from "../src/engine";
import { playCompareGame } from "./compare-main";
import { createPool } from "./parallel";

/**
 * 調整する重み（SEARCH_WEIGHTS で正の値のもの）。oppHp は評価の尺度の基準として固定する。
 * 閾値（lethalRange・boostCap）、0 の重み（対数で動かせない）、カードごとの hold は動かさない
 */
const TUNED = [
  "myHp", "attack", "defense", "followerBase", "tempAttack", "keywords", "amulet", "sigil", "sigilAmulet", "oppBoard",
  "myHand", "oppHand", "ep", "sep", "extraPp", "maxPp", "crest", "graveyard", "lethalAttack", "fusionSet",
  "kuonReserve", "evoReserve", "sevoReserve", "lastWords", "lastWordsSummon", "boostCard", "boost", "countdownDecay", "doomed",
] as const satisfies readonly (keyof EvalWeights)[];
type Tuned = (typeof TUNED)[number];
type Values = Record<Tuned, number>;

/** x（重みごとの、SEARCH_WEIGHTS からの倍率の対数）から重みの値を作る */
const valuesOf = (x: readonly number[]): Values => Object.fromEntries(TUNED.map((k, i) => [k, SEARCH_WEIGHTS[k] * Math.exp(x[i]!)])) as Values;

interface Task {
  g: number;
  swap: boolean;
  plus: Values;
  minus: Values;
}

/** 1 試合: + を compare の A、− を B として打ち、+ が勝ったら 1 */
function runTask(t: Task): number {
  const plus = createSearchAgent({ weights: { ...SEARCH_WEIGHTS, ...t.plus } });
  const minus = createSearchAgent({ weights: { ...SEARCH_WEIGHTS, ...t.minus } });
  return playCompareGame(plus, minus, t.g, t.swap).won ? 1 : 0;
}

interface Row {
  it: number;
  /** + の勝率 */
  plusRate: number;
  /** 動かした後の x（重みごとの倍率の対数） */
  x: number[];
}

interface Args {
  iters: number;
  games: number;
  start: number;
  seed: number;
  a: number;
  c: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { iters: 300, games: 28, start: 100000, seed: 1, a: 0.4, c: 0.2, out: "spsa.jsonl" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[++i];
    if (v === undefined) throw new Error(`${k} の値がありません`);
    if (k === "--iters") args.iters = Number(v);
    else if (k === "--games") args.games = Number(v);
    else if (k === "--start") args.start = Number(v);
    else if (k === "--seed") args.seed = Number(v);
    else if (k === "--a") args.a = Number(v);
    else if (k === "--c") args.c = Number(v);
    else if (k === "--out") args.out = v;
    else throw new Error(`不明な引数: ${k}`);
  }
  return args;
}

/** SEARCH_WEIGHTS との差（compare の "weights" に渡す形。小数 3 桁） */
function diffOf(x: readonly number[]): Partial<Values> {
  const v = valuesOf(x);
  return Object.fromEntries(TUNED.filter((_, i) => Math.abs(x[i]!) > 1e-9).map((k) => [k, Math.round(v[k] * 1000) / 1000]));
}

/**
 * npm run spsa -- [--iters 300] [--games 28] [--out spsa.jsonl] [--start 100000] [--seed 1] [--a 0.4] [--c 0.2]
 * --games は 1 回あたりの試合番号の数（席とデッキを入れ替えて 2 試合ずつ打つので、1 回 2 × games 試合）。
 * --start は最初の試合番号（compare で確かめる試合番号と重ならないように大きくする）。並列数は環境変数 THREADS
 */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // Worker はここで止まり、親から渡された試合を打つ
  const pool = await createPool(runTask);

  const rows: Row[] = existsSync(args.out)
    ? readFileSync(args.out, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Row)
    : [];
  let x: number[] = rows.at(-1)?.x ?? TUNED.map(() => 0);
  const A = Math.max(1, Math.round(args.iters / 10));
  const t0 = Date.now();
  console.log(`SPSA: 重み ${TUNED.length} 個、${args.iters} 回（済み ${rows.length}）、1 回 ${args.games * 2} 試合、a ${args.a}、c ${args.c}`);
  try {
    for (let it = rows.length; it < args.iters; it++) {
      const ak = args.a / (it + 1 + A) ** 0.602;
      const ck = args.c / (it + 1) ** 0.101;
      const rng = rngFrom({ rng: (args.seed * 1000003 + it) >>> 0 });
      const delta = TUNED.map(() => (rng.int(2) === 0 ? 1 : -1));
      const plus = valuesOf(x.map((xi, i) => xi + ck * delta[i]!));
      const minus = valuesOf(x.map((xi, i) => xi - ck * delta[i]!));
      const tasks: Task[] = [];
      for (let k = 0; k < args.games; k++) for (const swap of [false, true]) tasks.push({ g: args.start + it * args.games + k, swap, plus, minus });
      const wins = (await pool.map(tasks)).reduce((s, w) => s + w, 0);
      const plusRate = wins / tasks.length;
      const y = 2 * plusRate - 1;
      // 対数で ±2（約 0.14〜7.4 倍）の範囲に収める
      x = x.map((xi, i) => Math.max(-2, Math.min(2, xi + (ak * y) / (2 * ck * delta[i]!))));
      const row: Row = { it, plusRate, x: x.map((v) => Math.round(v * 1e4) / 1e4) };
      rows.push(row);
      appendFileSync(args.out, JSON.stringify(row) + "\n");
      if ((it + 1) % 10 === 0 || it + 1 === args.iters) {
        const recent = rows.slice(-10).reduce((s, r) => s + r.plusRate, 0) / Math.min(10, rows.length);
        console.log(`#${it + 1} 直近 10 回の + の勝率 ${(recent * 100).toFixed(1)}%（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
      }
    }
  } finally {
    await pool.close();
  }
  // 後半の回の重みの平均
  const half = rows.slice(Math.floor(rows.length / 2));
  const avg = TUNED.map((_, i) => half.reduce((s, r) => s + r.x[i]!, 0) / Math.max(1, half.length));
  console.log(`最後の重み（SEARCH_WEIGHTS との差）: ${JSON.stringify(diffOf(x))}`);
  console.log(`後半 ${half.length} 回の平均: ${JSON.stringify({ weights: diffOf(avg) })}`);
  console.log(TUNED.map((k, i) => `${k} ${SEARCH_WEIGHTS[k]} → ${valuesOf(avg)[k].toFixed(3)}（×${Math.exp(avg[i]!).toFixed(2)}）`).join("\n"));
  return 0;
}
