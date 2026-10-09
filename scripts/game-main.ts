// npm run game の本体: 1試合だけ行い、行動の列と結果を表示する（リプレイ画面の「再現」のコマンドで使う）
//
// 使い方: npm run game -- --seed <seed> --p0 <AI> --p0-deck <デッキ> --p1 <AI> --p1-deck <デッキ> [--quiet] [--json <出力.json>]
// デッキはデフォルトデッキのキー（data/decks のファイル名）か「ID*枚数,…」（src/sim/reproduce.ts の deckArg）。
// 行動の番号はリプレイ画面の「n 手」と同じ（n 番目の行動の後の局面が n 手目）。

import { writeFileSync } from "node:fs";
import { agentOf, AGENTS } from "../src/ai/registry";
import { playMatch } from "../src/sim/match";
import { parseDeckArg } from "../src/sim/reproduce";
import { replayStates } from "../src/sim/replay";
import { describeAction } from "../src/ui/describe";

interface Args {
  seed: number | null;
  agents: [string | null, string | null];
  decks: [string | null, string | null];
  quiet: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: null, agents: [null, null], decks: [null, null], quiet: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${key} の値がありません`);
      return v;
    };
    if (key === "--seed") args.seed = Number(value());
    else if (key === "--p0") args.agents[0] = value();
    else if (key === "--p1") args.agents[1] = value();
    else if (key === "--p0-deck") args.decks[0] = value();
    else if (key === "--p1-deck") args.decks[1] = value();
    else if (key === "--quiet") args.quiet = true;
    else if (key === "--json") args.json = value();
    else throw new Error(`不明な引数: ${key}`);
  }
  if (args.seed === null || !Number.isInteger(args.seed)) throw new Error("--seed を整数で指定してください");
  for (const a of args.agents) {
    if (a === null) throw new Error("--p0 と --p1 で AI を指定してください");
    if (!AGENTS[a]) throw new Error(`不明な AI: ${a}（${Object.keys(AGENTS).join(", ")}）`);
  }
  if (args.decks.includes(null)) throw new Error("--p0-deck と --p1-deck でデッキを指定してください");
  return args;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const seed = args.seed!;
  const agents = args.agents as [string, string];
  const decks: [string[], string[]] = [parseDeckArg(args.decks[0]!), parseDeckArg(args.decks[1]!)];
  const started = Date.now();
  const r = playMatch([agentOf(agents[0]), agentOf(agents[1])], { decks, seed, record: true, checkInvariants: true });
  const elapsed = (Date.now() - started) / 1000;
  const actions = r.log ?? [];
  const names: [string, string] = [`P1(${agents[0]})`, `P2(${agents[1]})`];

  if (!args.quiet) {
    const states = replayStates(decks, seed, actions);
    for (const [i, a] of actions.entries()) console.log(`${String(i + 1).padStart(4)}. ${describeAction(states[i]!, a, names)}`);
    console.log("");
  }
  console.log(`勝者: ${names[r.winner]} / 先攻: ${names[r.final.first]} / ${r.turns} ターン / ${actions.length} 手（${elapsed.toFixed(1)}秒）`);
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ seed, agents, decks, winner: r.winner, turns: r.turns, actions }, null, 2));
    console.log(`${args.json} に書き出しました`);
  }
  return 0;
}
