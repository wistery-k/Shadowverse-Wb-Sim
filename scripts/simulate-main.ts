// npm run sim の本体（scripts/vite-run.mjs から Vite のモジュールランナーで実行される）

import { writeFileSync } from "node:fs";
import { AGENTS } from "../src/ai/registry";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { planGames, runGame, summarize, type Entrant, type GameRecord } from "../src/sim/tournament";
import { isParallelWorker, parallelMap } from "./parallel";

interface Args {
  games: number;
  seed: number;
  agents: string[];
  decks: string[] | "all";
  mirror: boolean;
  json: string | null;
  /** 全試合を n 個に分けたうちの i 番目（0 始まり）だけを行う。CI で並列に回すため */
  shard: { index: number; count: number };
  /** デッキごとに AI を差し替える（デッキ名またはキー → AI）。--agents が 1 つのときだけ使える */
  deckAgents: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { games: 20, seed: 1, agents: ["greedy"], decks: "all", mirror: false, json: null, shard: { index: 0, count: 1 }, deckAgents: {} };
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
    else if (key === "--deck-agent") {
      const [deck, agent] = value().split("=");
      if (!deck || !agent) throw new Error("--deck-agent は <デッキ>=<AI> で指定します");
      args.deckAgents[deck] = agent;
    } else if (key === "--shard") {
      const m = /^(\d+)\/(\d+)$/.exec(value());
      if (!m || Number(m[1]) >= Number(m[2])) throw new Error(`--shard は i/n（0 ≦ i < n）で指定します`);
      args.shard = { index: Number(m[1]), count: Number(m[2]) };
    }
    else throw new Error(`不明な引数: ${key}`);
  }
  if (Object.keys(args.deckAgents).length > 0 && args.agents.length > 1) throw new Error("--deck-agent は --agents が 1 つのときだけ使えます");
  for (const a of [...args.agents, ...Object.values(args.deckAgents)]) if (!AGENTS[a]) throw new Error(`不明な AI: ${a}（${Object.keys(AGENTS).join(", ")}）`);
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
  for (const k of Object.keys(args.deckAgents)) {
    if (!decks.some((d) => d.name === k || d.key === k)) throw new Error(`--deck-agent のデッキがありません: ${k}`);
  }
  const entrants: Entrant[] = decks.flatMap((d) => {
    const override = args.deckAgents[d.name] ?? args.deckAgents[d.key];
    if (override) return [{ name: `${d.name}(${override})`, deck: d.cards, agent: override }];
    return args.agents.map((agent) => ({ name: args.agents.length > 1 ? `${d.name}(${agent})` : d.name, deck: d.cards, agent }));
  });
  const specs = planGames(entrants.length, { gamesPerPair: args.games, seed: args.seed, mirror: args.mirror })
    .filter((_, i) => i % args.shard.count === args.shard.index);
  const shardNote = args.shard.count > 1 ? `、分割 ${args.shard.index}/${args.shard.count}` : "";
  if (!isParallelWorker) console.log(`参加者 ${entrants.length}、${specs.length} 試合（1組 ${args.games} 試合、seed ${args.seed}${shardNote}）`);

  const started = Date.now();
  // 1 試合ずつ並列に行う（各試合はシードで決まるので、結果は並列数によらない）
  const records: GameRecord[] = await parallelMap(specs, (spec) => runGame(spec, entrants), (done, total) => {
    if (done % 20 === 0 || done === total) process.stdout.write(`\r${done}/${total} 試合（${((Date.now() - started) / 1000).toFixed(1)}秒）`);
  });
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
    writeFileSync(args.json, JSON.stringify({ args, entrants: entrants.map((e) => e.name), elapsedSec: (Date.now() - started) / 1000, summary: s, records }, null, 2));
    console.log(`\n${args.json} に書き出しました`);
  }
  return s.errors.length > 0 ? 1 : 0;
}
