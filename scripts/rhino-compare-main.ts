// リノセウス用 AI の設定を変えたときの勝率（npm run rhino-compare）
//
// リノセウスエルフ（リノセウス用 AI）vs 他の 6 デッキ（探索 AI。ランプドラゴンは除く）を、両方の席で同じシードで打つ。
// 設定を変えても同じシードの試合になるので、変更前後を同じ試合数で比べられる。
// 例: npm run rhino-compare -- --games 50 --opts '{"nextLethal":10}'
//     （--opts はリノセウス用 AI の探索の設定 SearchOptions の一部。試合は CPU のコア数だけ並列に行う）

import { createRhinoAgent } from "../src/ai/rhino";
import { searchAgent, type SearchOptions } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { playMatch } from "../src/sim/match";
import { parallelMap } from "./parallel";

const ELF = "リノセウスエルフ";
const EXCLUDED_DECKS = [ELF, "ランプドラゴン"];

export async function main(argv: string[]): Promise<number> {
  let games = 50;
  let opts: Partial<SearchOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} の値がありません`);
    if (key === "--games") games = Number(v);
    else if (key === "--opts") opts = JSON.parse(v) as Partial<SearchOptions>;
    else throw new Error(`不明な引数: ${key}`);
  }
  const elf = DEFAULT_DECKS.find((d) => d.name === ELF);
  if (!elf) throw new Error(`${ELF} がありません`);
  const opponents = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const agent = createRhinoAgent(opts);
  const tasks = opponents.flatMap((o) => Array.from({ length: games }, (_, g) => ([0, 1] as const).map((elfSeat) => ({ o: o.name, g, elfSeat }))).flat());
  const t0 = Date.now();
  const results = await parallelMap(tasks, ({ o, g, elfSeat }) => {
    const opp = opponents.find((d) => d.name === o)!;
    const seed = 900000 + g * 13 + elfSeat;
    const r = playMatch(elfSeat === 0 ? [agent, searchAgent] : [searchAgent, agent], {
      decks: elfSeat === 0 ? [elf.cards, opp.cards] : [opp.cards, elf.cards],
      seed,
    });
    return { deck: o, won: r.winner === elfSeat };
  });
  const perDeck = new Map<string, [number, number]>();
  for (const { deck, won } of results) {
    const pd = perDeck.get(deck) ?? [0, 0];
    perDeck.set(deck, [pd[0] + (won ? 1 : 0), pd[1] + 1]);
  }
  const wins = results.filter((r) => r.won).length;
  const n = results.length;
  console.log(`opts ${JSON.stringify(opts)}: ${wins}/${n} = ${((wins / n) * 100).toFixed(1)}%  ${((Date.now() - t0) / Math.max(1, n) / 1000).toFixed(2)}s/試合`);
  console.log([...perDeck].map(([name, [w, t]]) => `${name} ${w}/${t}`).join(", "));
  return 0;
}
