// AI の設定同士の比較（npm run compare）

import { DEFAULT_WEIGHTS, SEARCH_WEIGHTS } from "../src/ai/evaluate";
import { createSearchAgent, type SearchOptions } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { playMatch } from "../src/sim/match";
import { parallelMap } from "./parallel";
import { applyValueNetOption } from "./valueNetOption";

/** 比較に使わないデフォルトデッキ（クラスごとに 1 つにするため） */
const EXCLUDED_DECKS = ["ランプドラゴン"];

/** 比較に使うデッキ（各クラス 1 つずつの 7 つ） */
export const COMPARE_DECKS = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
type Deck = (typeof COMPARE_DECKS)[number];

/** 試合番号 g（swap で席とデッキを入れ替えた方）の A と B のデッキ */
export function comparePair(g: number, swap: boolean): [Deck, Deck] {
  const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
  return swap ? [COMPARE_DECKS[j]!, COMPARE_DECKS[i]!] : [COMPARE_DECKS[i]!, COMPARE_DECKS[j]!];
}

/** 試合番号 g を A と B で打つ（席・シードは g と swap で決まる）。A のデッキ名と、A が勝ったか */
export function playCompareGame(a: Agent, b: Agent, g: number, swap: boolean): { deck: string; won: boolean } {
  const [da, db] = comparePair(g, swap);
  const aSeat = (g + (swap ? 1 : 0)) % 2;
  const r = playMatch(aSeat === 0 ? [a, b] : [b, a], { decks: aSeat === 0 ? [da.cards, db.cards] : [db.cards, da.cards], seed: g * 7 + (swap ? 1 : 2) });
  return { deck: da.name, won: r.winner === aSeat };
}

/**
 * 探索 AI の設定 A と B を対戦させる（npm run compare -- <試合数> '<Aの設定JSON>' '<Bの設定JSON>'）。
 * 同じデッキの組で席とデッキを入れ替えて2試合ずつ行い、A の勝率とデッキごとの A の勝率を出す。
 * 例: npm run compare -- 105 '{}' '{"lethal":false}'（4 つ目に最初の試合番号を渡せる。既定 0。5 つ目に B のデッキ名を渡すと、B がそのデッキの試合だけを打つ）
 * "weights": "byClass" でクラスごとに調整した重み、"default" で基準の重みを使う。
 * 試合は CPU のコア数だけ並列に行う（環境変数 THREADS で変えられる。scripts/parallel.ts）。
 * デッキは各クラス1つずつ（ドラゴンは疾走ドラゴン）の 7 つを使う。
 * "weights" にオブジェクトを渡すと、探索 AI の既定の重み（SEARCH_WEIGHTS）のその項目だけを変える（例: '{"weights":{"myHand":0.8}}'）。
 * "weights" の "holdScale" は、融合で作るカードの手札の価値（hold）を何倍にするか（例: '{"weights":{"myHand":1.2,"holdScale":2}}'）。
 * "valueNet" にファイル名を渡すと、TD 学習で作った評価の補正（npm run td）を使う（例: '{"valueNet":"m3.json"}'。scripts/valueNetOption.ts）。
 */
export async function main(argv: string[]): Promise<number> {
  const games = Number(argv[0] ?? 28);
  const decks = COMPARE_DECKS;
  if (decks.length !== 7) throw new Error(`比較用のデッキは 7 つの想定です（${decks.map((d) => d.name).join(", ")}）`);
  const a: Agent = createSearchAgent(parseOptions(argv[1]));
  const b: Agent = createSearchAgent(parseOptions(argv[2]));
  const t0 = Date.now();
  // 4 つ目の引数で最初の試合番号を変えられる（例: 600 なら g600〜。前に回した試合と重ならない別の試合で確かめるため）
  const start = Number(argv[3] ?? 0);
  // 5 つ目の引数で、B のデッキがその名前の試合だけを打つ（例: AFネメシス。相手のデッキでしか変わらない設定を、その対戦だけで比べるため）
  const vs = argv[4];
  if (vs && !decks.some((d) => d.name === vs)) throw new Error(`不明なデッキ: ${vs}`);
  const tasks = Array.from({ length: games }, (_, k) => [false, true].map((swap) => ({ g: start + k, swap })))
    .flat()
    .filter(({ g, swap }) => !vs || comparePair(g, swap)[1].name === vs);
  // 1 試合ずつ並列に行う（各試合はシードで決まるので、結果は並列数によらない）
  const results = await parallelMap(tasks, ({ g, swap }) => playCompareGame(a, b, g, swap));
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
  const raw = applyValueNetOption(JSON.parse(json ?? "{}") as Record<string, unknown>);
  if (raw.weights === "default") raw.weights = DEFAULT_WEIGHTS;
  else if (typeof raw.weights === "object" && raw.weights !== null) {
    // "holdScale" は融合で作るカードの手札の価値（hold）を何倍にするか（myHand を変えるとき、素材の枚数 × 手札 1 枚の価値に合わせる用）
    const { holdScale, ...rest } = raw.weights as Record<string, unknown>;
    const scale = typeof holdScale === "number" ? holdScale : 1;
    const hold = Object.fromEntries(Object.entries(SEARCH_WEIGHTS.hold).map(([k, v]) => [k, v * scale]));
    raw.weights = { ...SEARCH_WEIGHTS, hold, ...rest };
  }
  return raw as Partial<SearchOptions>;
}
