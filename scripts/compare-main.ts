// AI の設定同士の比較（npm run compare）

import { DEFAULT_WEIGHTS, SEARCH_WEIGHTS } from "../src/ai/evaluate";
import { createSearchAgent, type SearchOptions } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { playMatch } from "../src/sim/match";
import { parallelMap } from "./parallel";

/** 比較に使わないデフォルトデッキ（クラスごとに 1 つにするため） */
const EXCLUDED_DECKS = ["ランプドラゴン"];

/**
 * 探索 AI の設定 A と B を対戦させる（npm run compare -- <試合数> '<Aの設定JSON>' '<Bの設定JSON>'）。
 * 同じデッキの組で席とデッキを入れ替えて2試合ずつ行い、A の勝率とデッキごとの A の勝率を出す。
 * 例: npm run compare -- 105 '{}' '{"lethal":false}'
 * "weights": "byClass" でクラスごとに調整した重み、"default" で基準の重みを使う。
 * 試合は CPU のコア数だけ並列に行う（環境変数 THREADS で変えられる。scripts/parallel.ts）。
 * デッキは各クラス1つずつ（ドラゴンは疾走ドラゴン）の 7 つを使う。
 * "weights" にオブジェクトを渡すと、探索 AI の既定の重み（SEARCH_WEIGHTS）のその項目だけを変える（例: '{"weights":{"myHand":0.8}}'）。
 */
export async function main(argv: string[]): Promise<number> {
  const games = Number(argv[0] ?? 28);
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  if (decks.length !== 7) throw new Error(`比較用のデッキは 7 つの想定です（${decks.map((d) => d.name).join(", ")}）`);
  const a: Agent = createSearchAgent(parseOptions(argv[1]));
  const b: Agent = createSearchAgent(parseOptions(argv[2]));
  const t0 = Date.now();
  const tasks = Array.from({ length: games }, (_, g) => [false, true].map((swap) => ({ g, swap }))).flat();
  // 1 試合ずつ並列に行う（各試合はシードで決まるので、結果は並列数によらない）
  const results = await parallelMap(tasks, ({ g, swap }) => {
    const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
    const [da, db] = swap ? [decks[j]!, decks[i]!] : [decks[i]!, decks[j]!];
    const aSeat = (g + (swap ? 1 : 0)) % 2;
    const r = playMatch(aSeat === 0 ? [a, b] : [b, a], { decks: aSeat === 0 ? [da.cards, db.cards] : [db.cards, da.cards], seed: g * 7 + (swap ? 1 : 2) });
    return { deck: da.name, won: r.winner === aSeat };
  });
  let wins = 0;
  const n = results.length;
  const perDeck = new Map<string, [number, number]>();
  for (const { deck, won } of results) {
    if (won) wins++;
    const pd = perDeck.get(deck) ?? [0, 0];
    perDeck.set(deck, [pd[0] + (won ? 1 : 0), pd[1] + 1]);
  }
  console.log(`A${argv[1] ?? "{}"} vs B${argv[2] ?? "{}"}: ${wins}/${n} = ${((wins / n) * 100).toFixed(1)}%  ${((Date.now() - t0) / n / 1000).toFixed(2)}s/試合`);
  console.log([...perDeck].map(([k, [w, t]]) => `${k} ${w}/${t}`).join(", "));
  return 0;
}

function parseOptions(json: string | undefined): Partial<SearchOptions> {
  const raw = JSON.parse(json ?? "{}") as Record<string, unknown>;
  if (raw.weights === "default") raw.weights = DEFAULT_WEIGHTS;
  else if (typeof raw.weights === "object" && raw.weights !== null) raw.weights = { ...SEARCH_WEIGHTS, ...raw.weights };
  return raw as Partial<SearchOptions>;
}
