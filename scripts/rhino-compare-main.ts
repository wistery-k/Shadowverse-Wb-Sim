// リノセウス用 AI のルールを変えたときの勝率（npm run rhino-compare）
//
// リノセウスエルフ（リノセウス用 AI）vs 他の 6 デッキ（探索 AI。ランプドラゴンは除く）を、両方の席で同じシードで打つ。
// ルールを変えても同じシードの試合になるので、変更前後を同じ試合数で比べられる。
// 例: npm run rhino-compare -- --games 50 --rules '{"bugs":"kill"}' --shard 0/4
//     （--shard i/n で全試合の i 番目の組だけを打つ。並列に回して結果を足す）

import { createRhinoAgent, DEFAULT_RHINO_RULES, type RhinoRules } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { playMatch } from "../src/sim/match";

const ELF = "リノセウスエルフ";
const EXCLUDED_DECKS = [ELF, "ランプドラゴン"];

export async function main(argv: string[]): Promise<number> {
  let games = 50;
  let rules: RhinoRules = DEFAULT_RHINO_RULES;
  let shard = { index: 0, count: 1 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} の値がありません`);
    if (key === "--games") games = Number(v);
    else if (key === "--rules") rules = { ...DEFAULT_RHINO_RULES, ...(JSON.parse(v) as Partial<RhinoRules>) };
    else if (key === "--shard") {
      const [a, b] = v.split("/").map(Number);
      shard = { index: a ?? 0, count: b ?? 1 };
    } else throw new Error(`不明な引数: ${key}`);
  }
  const elf = DEFAULT_DECKS.find((d) => d.name === ELF);
  if (!elf) throw new Error(`${ELF} がありません`);
  const opponents = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const agent = createRhinoAgent({}, rules);
  const perDeck = new Map<string, [number, number]>();
  let k = 0;
  const t0 = Date.now();
  for (const o of opponents) {
    for (let g = 0; g < games; g++) {
      for (const elfSeat of [0, 1] as const) {
        if (k++ % shard.count !== shard.index) continue;
        const seed = 900000 + g * 13 + elfSeat;
        const r = playMatch(elfSeat === 0 ? [agent, searchAgent] : [searchAgent, agent], {
          decks: elfSeat === 0 ? [elf.cards, o.cards] : [o.cards, elf.cards],
          seed,
        });
        const pd = perDeck.get(o.name) ?? [0, 0];
        perDeck.set(o.name, [pd[0] + (r.winner === elfSeat ? 1 : 0), pd[1] + 1]);
      }
    }
  }
  const [wins, total] = [...perDeck.values()].reduce(([w, t], [a, b]) => [w + a, t + b], [0, 0]);
  console.log(`rules ${JSON.stringify(rules)}: ${wins}/${total}  ${((Date.now() - t0) / Math.max(1, total) / 1000).toFixed(2)}s/試合`);
  console.log([...perDeck].map(([name, [w, t]]) => `${name} ${w}/${t}`).join(", "));
  return 0;
}
