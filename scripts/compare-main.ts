// AI の設定同士の比較（npm run compare）

import { DEFAULT_WEIGHTS } from "../src/ai/evaluate";
import { createSearchAgent, type SearchOptions } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { playMatch } from "../src/sim/match";
/**
 * 探索 AI の設定 A と B を対戦させる（npm run compare -- <試合数> '<Aの設定JSON>' '<Bの設定JSON>'）。
 * 同じデッキの組で席とデッキを入れ替えて2試合ずつ行い、A の勝率とデッキごとの A の勝率を出す。
 * 例: npm run compare -- 105 '{}' '{"lethal":false}'
 * "weights": "default" で、クラスごとに調整した重みではなく基準の重みを使う。
 */
export async function main(argv: string[]): Promise<number> {
  const games = Number(argv[0] ?? 28);
  const a: Agent = createSearchAgent(parseOptions(argv[1]));
  const b: Agent = createSearchAgent(parseOptions(argv[2]));
  let wins = 0, n = 0;
  const perDeck = new Map<string, [number, number]>();
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
    for (const swap of [false, true]) {
      const [da, db] = swap ? [DEFAULT_DECKS[j]!, DEFAULT_DECKS[i]!] : [DEFAULT_DECKS[i]!, DEFAULT_DECKS[j]!];
      const aSeat = (g + (swap ? 1 : 0)) % 2;
      const r = playMatch(aSeat === 0 ? [a, b] : [b, a], { decks: aSeat === 0 ? [da.cards, db.cards] : [db.cards, da.cards], seed: g * 7 + (swap ? 1 : 2) });
      const won = r.winner === aSeat;
      if (won) wins++;
      n++;
      const pd = perDeck.get(da.name) ?? [0, 0];
      perDeck.set(da.name, [pd[0] + (won ? 1 : 0), pd[1] + 1]);
    }
  }
  console.log(`A${argv[1] ?? "{}"} vs B${argv[2] ?? "{}"}: ${wins}/${n} = ${((wins / n) * 100).toFixed(1)}%  ${((Date.now() - t0) / n / 1000).toFixed(2)}s/試合`);
  console.log([...perDeck].map(([k, [w, t]]) => `${k} ${w}/${t}`).join(", "));
  return 0;
}

function parseOptions(json: string | undefined): Partial<SearchOptions> {
  const raw = JSON.parse(json ?? "{}") as Record<string, unknown>;
  if (raw.weights === "default") raw.weights = DEFAULT_WEIGHTS;
  return raw as Partial<SearchOptions>;
}
