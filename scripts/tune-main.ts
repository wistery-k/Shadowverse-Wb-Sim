// 評価関数の重みを自己対戦で調整する（npm run tune）。
//
// 山登り法: 現在の重みの一部をランダムに変えた候補を作り、
// 「調整するデッキ × 全デッキ（両方の席）」を、相手は基準の重みの AI として対戦させる。
// 候補と現在の重みは同じシードの試合で比べ（ばらつきを減らす）、勝率が上がれば採用する。
// 毎回新しいシードを使うので、特定の試合への過学習を避けられる。
//
// 調整対象は数値の重みと、調整するデッキのカードの「手札に持っておく価値」（hold）。
// 開始点は data/ai-weights.json にあるそのクラスの重み（無ければ基準の重み）。
//
// 使い方: npm run tune -- --deck リノセウスエルフ [--iters 30] [--games 8] [--seed 1] [--write]
//   --deck  調整するデフォルトデッキの名前
//   --games 1組・1席あたりの試合数
//   --write 最終確認で基準より勝率が高ければ、data/ai-weights.json のそのクラスの重みを更新する

import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_WEIGHTS, type EvalWeights, type NumericWeight } from "../src/ai/evaluate";
import { weightsForClass, type WeightTable } from "../src/ai/weights";
import { createGreedyAgent } from "../src/ai/greedy";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { rngFrom, type Rng } from "../src/engine";
import { playMatch } from "../src/sim/match";

interface Args {
  deck: string;
  iters: number;
  games: number;
  seed: number;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { deck: "", iters: 30, games: 8, seed: 1, write: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--write") {
      args.write = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} の値がありません`);
    if (key === "--deck") args.deck = v;
    else if (key === "--iters") args.iters = Number(v);
    else if (key === "--games") args.games = Number(v);
    else if (key === "--seed") args.seed = Number(v);
    else throw new Error(`不明な引数: ${key}`);
  }
  return args;
}

const WEIGHTS_FILE = "data/ai-weights.json";

/** 調整しない重み（閾値など、連続的に動かすと意味が変わるもの） */
const FIXED: readonly NumericWeight[] = ["lethalRange"];

function gauss(rng: Rng): number {
  return (rng.int(1000) + rng.int(1000) + rng.int(1000) - 1498.5) / 500;
}

/** 重みの一部をランダムに変える。holdCards は hold を調整するカード */
function mutate(w: EvalWeights, holdCards: readonly string[], rng: Rng): EvalWeights {
  const keys = (Object.keys(w) as (keyof EvalWeights)[]).filter(
    (k): k is NumericWeight => k !== "hold" && !FIXED.includes(k as NumericWeight),
  );
  const next: EvalWeights = { ...w, hold: { ...w.hold } };
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    if (holdCards.length > 0 && rng.int(2) === 0) {
      // 手札に持っておく価値: 0 から始め、±1 程度ずつ動かす
      const id = holdCards[rng.int(holdCards.length)] as string;
      const value = Math.max(0, (next.hold[id] ?? 0) + gauss(rng));
      next.hold = { ...next.hold, [id]: Math.round(value * 100) / 100 };
    } else {
      // 数値の重み: 対数正規の倍率（ほぼ ±30%）。0 付近の重みは少し足して動けるようにする
      const k = keys[rng.int(keys.length)] as NumericWeight;
      next[k] = Math.max(0, (next[k] + 0.02) * Math.exp(gauss(rng) * 0.3) - 0.02);
    }
  }
  return next;
}

/** 調整するデッキで、候補の重みの AI が基準の AI と戦ったときの勝率 */
function fitness(w: EvalWeights, deckIdx: number, games: number, seed: number): number {
  const tuned = createGreedyAgent({ weights: w });
  const base = createGreedyAgent();
  let wins = 0;
  let total = 0;
  for (const d of [deckIdx]) {
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

/** 基準の重みとの差分（data/ai-weights.json に書く内容） */
function diff(w: EvalWeights): Partial<EvalWeights> {
  const out: Partial<Record<keyof EvalWeights, unknown>> = {};
  for (const k of Object.keys(w) as (keyof EvalWeights)[]) {
    if (k === "hold") continue;
    if (Math.abs(w[k] - DEFAULT_WEIGHTS[k]) > 1e-9) out[k] = Math.round(w[k] * 1000) / 1000;
  }
  const hold = Object.fromEntries(Object.entries(w.hold).filter(([, v]) => v > 0));
  if (Object.keys(hold).length > 0) out.hold = hold;
  return out as Partial<EvalWeights>;
}

const fmt = (w: EvalWeights) => JSON.stringify(diff(w));

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const deckIdx = DEFAULT_DECKS.findIndex((d) => d.name === args.deck || d.key === args.deck);
  if (deckIdx < 0) throw new Error(`デフォルトデッキがありません: ${args.deck}（--deck で指定）`);
  const deck = DEFAULT_DECKS[deckIdx]!;
  const holdCards = [...new Set(deck.cards)];
  const table = JSON.parse(readFileSync(WEIGHTS_FILE, "utf8")) as WeightTable;
  const rng = rngFrom({ rng: args.seed });
  const perEval = DEFAULT_DECKS.length * args.games * 2;
  console.log(`調整: ${deck.name}（${deck.class}）、${args.iters} 回、1回あたり ${perEval * 2} 試合`);

  let current = weightsForClass(deck.class, table);
  const started = Date.now();
  for (let it = 1; it <= args.iters; it++) {
    const seed = args.seed * 1000 + it;
    const candidate = mutate(current, holdCards, rng);
    const fc = fitness(current, deckIdx, args.games, seed);
    const fn = fitness(candidate, deckIdx, args.games, seed);
    const accepted = fn > fc;
    if (accepted) current = candidate;
    console.log(
      `#${it} 現在 ${(fc * 100).toFixed(1)}% 候補 ${(fn * 100).toFixed(1)}% ${accepted ? "採用" : "不採用"}（${((Date.now() - started) / 1000).toFixed(0)}秒）`,
    );
  }

  // 最終確認: 調整後の重みと基準の重みを、調整に使っていないシードで比べる
  const checkSeed = args.seed * 1000 + 999_999;
  const tunedRate = fitness(current, deckIdx, args.games * 2, checkSeed);
  const baseRate = fitness(DEFAULT_WEIGHTS, deckIdx, args.games * 2, checkSeed);
  console.log(`\n最終確認（新しいシード）: 調整後 ${(tunedRate * 100).toFixed(1)}% / 基準 ${(baseRate * 100).toFixed(1)}%`);
  console.log(`調整後の重み（基準との差分）: ${fmt(current)}`);
  if (args.write) {
    if (tunedRate > baseRate) {
      table[deck.class] = diff(current);
      writeFileSync(WEIGHTS_FILE, JSON.stringify(table, null, 2) + "\n");
      console.log(`${WEIGHTS_FILE} の ${deck.class} を更新しました`);
    } else {
      console.log("基準より勝率が上がらなかったので、書き込みませんでした");
    }
  }
  return 0;
}
