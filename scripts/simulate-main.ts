// npm run sim の本体（scripts/vite-run.mjs から Vite のモジュールランナーで実行される）

import { writeFileSync } from "node:fs";
import { AGENTS } from "../src/ai/registry";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { planGames, runGame, summarize, type Entrant, type GameRecord } from "../src/sim/tournament";

interface Args {
  games: number;
  seed: number;
  agents: string[];
  decks: string[] | "all";
  mirror: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { games: 20, seed: 1, agents: ["greedy"], decks: "all", mirror: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${key} の値がありません`);
      return v;
    };
    if (key === "--games") args.games = Number(value());
    else if (key === "--seed") args.seed = Number(value());
    else if (key === "--agents") args.agents = value().split(",");
    else if (key === "--decks") {
      const v = value();
      args.decks = v === "all" ? "all" : v.split(",");
    } else if (key === "--mirror") args.mirror = true;
    else if (key === "--json") args.json = value();
    else throw new Error(`不明な引数: ${key}`);
  }
  for (const a of args.agents) if (!AGENTS[a]) throw new Error(`不明な AI: ${a}（${Object.keys(AGENTS).join(", ")}）`);
  return args;
}

const pct = (n: number, d: number) => (d === 0 ? "   -" : `${Math.round((n / d) * 100)}%`.padStart(4));
const width = (s: string) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const decks = args.decks === "all" ? DEFAULT_DECKS : args.decks.map((name) => {
    const d = DEFAULT_DECKS.find((x) => x.name === name || x.key === name);
    if (!d) throw new Error(`デフォルトデッキがありません: ${name}`);
    return d;
  });
  const entrants: Entrant[] = decks.flatMap((d) =>
    args.agents.map((agent) => ({ name: args.agents.length > 1 ? `${d.name}(${agent})` : d.name, deck: d.cards, agent })),
  );
  const specs = planGames(entrants.length, { gamesPerPair: args.games, seed: args.seed, mirror: args.mirror });
  console.log(`参加者 ${entrants.length}、${specs.length} 試合（1組 ${args.games} 試合、seed ${args.seed}）`);

  const records: GameRecord[] = [];
  const started = Date.now();
  for (const [i, spec] of specs.entries()) {
    records.push(runGame(spec, entrants));
    if ((i + 1) % 20 === 0 || i + 1 === specs.length) {
      process.stdout.write(`\r${i + 1}/${specs.length} 試合（${((Date.now() - started) / 1000).toFixed(1)}秒）`);
    }
  }
  process.stdout.write("\n\n");

  const s = summarize(entrants.length, records);
  const nameWidth = Math.max(...entrants.map((e) => width(e.name)));
  // 勝率の高い順
  const order = entrants.map((_, i) => i).sort((x, y) => {
    const rx = s.entrants[x]!.wins / Math.max(1, s.entrants[x]!.games);
    const ry = s.entrants[y]!.wins / Math.max(1, s.entrants[y]!.games);
    return ry - rx;
  });
  console.log(`${pad("", nameWidth)}  通算  ${order.map((_, k) => `  #${k + 1}`.padStart(4)).join(" ")}`);
  for (const [k, i] of order.entries()) {
    const e = s.entrants[i]!;
    const row = order.map((j) => (i === j ? "   -" : pct(s.wins[i]![j]!, s.games[i]![j]!))).join(" ");
    console.log(`${pad(`#${k + 1} ${entrants[i]!.name}`, nameWidth + 4)}${pct(e.wins, e.games)}  ${row}`);
  }
  console.log(`\n先攻の勝率 ${pct(s.firstPlayerWins, s.totalGames)}、平均 ${s.averageTurns.toFixed(1)} ターン`);
  if (s.errors.length > 0) {
    console.log(`\nエラー ${s.errors.length} 試合:`);
    for (const r of s.errors.slice(0, 10)) console.log(`  ${entrants[r.a]!.name} vs ${entrants[r.b]!.name} seed ${r.seed}: ${r.error}`);
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ args, entrants: entrants.map((e) => e.name), summary: s, records }, null, 2));
    console.log(`\n${args.json} に書き出しました`);
  }
  return s.errors.length > 0 ? 1 : 0;
}
