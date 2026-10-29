// 調べもの用: 記録した試合（npm run game の --json）の n 手目の局面で、AI の考え（候補の並びと点数）を出す
//
// 使い方: npm run think-at -- --json <試合.json> --at <n> [--agent rhino] [--rng 1,2,3]

import { readFileSync } from "node:fs";
import { applyAction, cardOf, type Action, type GameState } from "../src/engine";
import { replayStates } from "../src/sim/replay";
import { think } from "../src/ai/think";
import { describeAction } from "../src/ui/describe";

export async function main(argv: string[]): Promise<number> {
  let json = "";
  let at = 0;
  let agent = "";
  let rngs = [1];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[++i]!;
    if (k === "--json") json = v;
    else if (k === "--at") at = Number(v);
    else if (k === "--agent") agent = v;
    else if (k === "--rng") rngs = v.split(",").map(Number);
    else throw new Error(`不明な引数: ${k}`);
  }
  const g = JSON.parse(readFileSync(json, "utf8")) as {
    seed: number;
    agents: [string, string];
    decks: [string[], string[]];
    actions: Action[];
  };
  const states = replayStates(g.decks, g.seed, g.actions.slice(0, at));
  const s: GameState = states[at]!;
  const p = s.active;
  const names: [string, string] = ["P1", "P2"];
  const pl = s.players[p];
  console.log(`手番 P${p + 1} / PP ${pl.pp}/${pl.maxPp} / 手札: ${pl.hand.map((h) => cardOf(h.cardId).name).join("、")}`);
  console.log(`場: ${pl.board.map((c) => cardOf(c.cardId).name).join("、")} / 相手の場: ${s.players[1 - p]!.board.map((c) => cardOf(c.cardId).name).join("、")}`);
  for (const rng of rngs) {
    const t = think(agent || g.agents[p]!, s, rng);
    if (!t) {
      console.log("考えなし");
      continue;
    }
    console.log(`\n--- rng ${rng}: 選ぶ手 ${describeAction(s, t.chosen, names)}`);
    for (const c of t.candidates) {
      let st = t.roots[c.sample]!;
      const descs: string[] = [];
      for (const a of c.steps) {
        descs.push(describeAction(st, a, names));
        st = applyAction(st, a);
      }
      const f = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(2));
      console.log(
        `value ${f(c.value)} read ${f(c.read?.total)} (eval ${f(c.read?.eval)} extra ${f(c.read?.extra)}) turnEnd ${f(c.turnEnd.total)} (eval ${f(c.turnEnd.eval)} extra ${f(c.turnEnd.extra)})\n    ${descs.join(" → ")}`,
      );
    }
  }
  return 0;
}
