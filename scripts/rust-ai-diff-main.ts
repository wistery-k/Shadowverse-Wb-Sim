// TypeScript 版と Rust 版（rust/）の探索 AI が同じ手を選ぶかの差分テスト（npm run rust-ai-diff）。
//
//   npm run rust-ai-diff -- expect --games 14 [--start 0] --out expected-ai.txt
//     探索 AI どうしの試合（npm run bench と同じ組み合わせ・シード）を打ち、1 試合 1 行で行動の列を書き出す。
//     Rust 版の `svwb ai-diff expected-ai.txt` が同じ試合を打って突き合わせる
//
// 行動の書き方は rust/engine/src/canonical.rs の action_canon と同じ（scripts/rust-diff-main.ts の actionCanon）。

import { writeFileSync } from "node:fs";
import { createSearchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, createGame, legalActions, rngFrom, type Action } from "../src/engine";
import { actionCanon } from "./rust-diff-main";

const EXCLUDED_DECKS = ["ランプドラゴン"];

/** 試合 g の組み合わせとシード（scripts/bench-main.ts と同じ） */
export function aiGameSetup(g: number): { decks: [readonly string[], readonly string[]]; seed: number } {
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
  return { decks: [decks[i]!.cards, decks[j]!.cards], seed: g * 7 + 1 };
}

function play(g: number): { log: Action[]; winner: number | null; ms: number } {
  const { decks, seed } = aiGameSetup(g);
  const agent: Agent = createSearchAgent();
  let state = createGame({ decks, seed });
  const rng = rngFrom({ rng: (seed ^ 0x9e3779b9) >>> 0 });
  const log: Action[] = [];
  const t0 = performance.now();
  while (state.phase !== "ended") {
    const legal = legalActions(state);
    const action = agent.chooseAction(state, legal, rng);
    log.push(action);
    state = applyAction(state, action);
  }
  return { log, winner: state.winner, ms: performance.now() - t0 };
}

const flag = (argv: string[], name: string, def: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};

export async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "expect") {
    console.error("使い方: npm run rust-ai-diff -- expect --games N [--start S] --out FILE");
    return 2;
  }
  const games = flag(argv, "games", 14);
  const start = flag(argv, "start", 0);
  const i = argv.indexOf("--out");
  const out = i >= 0 ? argv[i + 1]! : "expected-ai.txt";
  const lines: string[] = [];
  let total = 0;
  for (let g = start; g < start + games; g++) {
    const r = play(g);
    total += r.ms;
    lines.push(`${g} ${r.winner} ${r.log.map(actionCanon).join(" ")}`);
    console.log(`試合 ${g}: 勝者 ${r.winner}、${r.log.length} 手、${(r.ms / 1000).toFixed(2)}秒`);
  }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${games} 試合を ${out} に書き出しました（1 試合 ${(total / games / 1000).toFixed(2)}秒）`);
  return 0;
}
