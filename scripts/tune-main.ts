// 評価関数の重みを自己対戦で調整する（npm run tune）。
//
// 山登り法: 現在の重みの一部をランダムに変えた候補を作り、
// 「調整するデッキ × 全デッキ（両方の席）」を、相手は基準の重みの AI として対戦させる。
// 候補と現在の重みは同じシードの試合で比べ（ばらつきを減らす）、勝率が上がれば採用する。
// 毎回新しいシードを使うので、特定の試合への過学習を避けられる。
//
// 使い方: npm run tune -- --deck リノセウスエルフ [--iters 30] [--games 4] [--seed 1] [--out 結果.json]
//   --deck  調整するデフォルトデッキの名前（all ですべてのデッキをまとめて調整）
//   --games 1組・1席あたりの試合数

import { writeFileSync } from "node:fs";
import { DEFAULT_WEIGHTS, type EvalWeights } from "../src/ai/evaluate";
import { createGreedyAgent } from "../src/ai/greedy";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { rngFrom, type Rng } from "../src/engine";
import { playMatch } from "../src/sim/match";

interface Args {
  deck: string;
  iters: number;
  games: number;
  seed: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { deck: "all", iters: 30, games: 4, seed: 1, out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} の値がありません`);
    if (key === "--deck") args.deck = v;
    else if (key === "--iters") args.iters = Number(v);
    else if (key === "--games") args.games = Number(v);
    else if (key === "--seed") args.seed = Number(v);
    else if (key === "--out") args.out = v;
    else throw new Error(`不明な引数: ${key}`);
  }
  return args;
}

/** 調整しない重み（閾値など、連続的に動かすと意味が変わるもの） */
const FIXED: readonly (keyof EvalWeights)[] = ["lethalRange"];

function mutate(w: EvalWeights, rng: Rng): EvalWeights {
  const keys = (Object.keys(w) as (keyof EvalWeights)[]).filter((k) => !FIXED.includes(k));
  const next = { ...w };
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    const k = keys[rng.int(keys.length)] as keyof EvalWeights;
    // 対数正規の倍率（ほぼ ±30%）。0 付近の重みは少し足して動けるようにする
    const gauss = (rng.int(1000) + rng.int(1000) + rng.int(1000) - 1498.5) / 500;
    next[k] = Math.max(0, (next[k] + 0.02) * Math.exp(gauss * 0.3) - 0.02);
  }
  return next;
}

/** 調整するデッキで、候補の重みの AI が基準の AI と戦ったときの勝率 */
function fitness(w: EvalWeights, deckIdx: readonly number[], games: number, seed: number): number {
  const tuned = createGreedyAgent({ weights: w });
  const base = createGreedyAgent();
  let wins = 0;
  let total = 0;
  for (const d of deckIdx) {
    for (let o = 0; o < DEFAULT_DECKS.length; o++) {
      for (let g = 0; g < games; g++) {
        for (const seat of [0, 1] as const) {
          const my = DEFAULT_DECKS[d]!.cards;
          const their = DEFAULT_DECKS[o]!.cards;
          const r = playMatch(seat === 0 ? [tuned, base] : [base, tuned], {
            decks: seat === 0 ? [my, their] : [their, my],
            seed: (seed * 100003 + d * 1009 + o * 101 + g * 7 + seat) >>> 0,
          });
          if (r.winner === seat) wins++;
          total++;
        }
      }
    }
  }
  return wins / total;
}

const fmt = (w: EvalWeights) =>
  Object.entries(w)
    .map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`)
    .join(" ");

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const deckIdx =
    args.deck === "all"
      ? DEFAULT_DECKS.map((_, i) => i)
      : [DEFAULT_DECKS.findIndex((d) => d.name === args.deck || d.key === args.deck)];
  if (deckIdx.some((i) => i < 0)) throw new Error(`デフォルトデッキがありません: ${args.deck}`);
  const rng = rngFrom({ rng: args.seed });
  const perEval = deckIdx.length * DEFAULT_DECKS.length * args.games * 2;
  console.log(`調整: ${args.deck}、${args.iters} 回、1回あたり ${perEval * 2} 試合`);

  let current = { ...DEFAULT_WEIGHTS };
  const started = Date.now();
  for (let it = 1; it <= args.iters; it++) {
    const seed = args.seed * 1000 + it;
    const candidate = mutate(current, rng);
    const fc = fitness(current, deckIdx, args.games, seed);
    const fn = fitness(candidate, deckIdx, args.games, seed);
    const accepted = fn > fc;
    const changed = (Object.keys(candidate) as (keyof EvalWeights)[]).filter((k) => candidate[k] !== current[k]);
    if (accepted) current = candidate;
    console.log(
      `#${it} 現在 ${(fc * 100).toFixed(1)}% 候補 ${(fn * 100).toFixed(1)}% ${accepted ? "採用" : "不採用"}（${((Date.now() - started) / 1000).toFixed(0)}秒）${accepted ? ` ${changed.join(",")}` : ""}`,
    );
  }

  // 最終確認: 調整後の重みと基準の重みを、調整に使っていないシードで比べる
  const check = fitness(current, deckIdx, args.games * 2, args.seed * 1000 + 999_999);
  console.log(`\n調整後の重み（新しいシードでの基準の AI への勝率 ${(check * 100).toFixed(1)}%）:\n${fmt(current)}`);
  if (args.out) writeFileSync(args.out, JSON.stringify({ deck: args.deck, check, weights: current }, null, 2) + "\n");
  return 0;
}
