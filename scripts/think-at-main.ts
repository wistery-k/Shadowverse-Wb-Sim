// 調べもの用: 記録した試合（棋譜の 1 行・npm run game の --json）の n 手目の局面で、AI の考え（候補の並びと点数）を出す
//
// 使い方: npm run think-at -- --json <試合のファイル> --at <n> [--line <行> | --g <試合番号> [--swap 0|1]] [--agent rhino] [--rng 1,2,3]
// ファイルは棋譜（.jsonl・.jsonl.gz。docs/kifu.md）か npm run game --json の出力（前の形と rhino-compare --record の 1 ファイルも）。
// 何試合もあるファイルは --line か --g（と --swap）で 1 試合を選ぶ。

import { applyAction, cardOf, type GameState } from "../src/engine";
import { replayStates } from "../src/sim/replay";
import { think, THINKING_AGENTS } from "../src/ai/think";
import { describeAction } from "../src/ui/describe";
import { gameLabel, pickGame, readGames, thinkingAgentOf, type GamePick } from "./game-files";

export async function main(argv: string[]): Promise<number> {
  let json = "";
  let at = 0;
  let agent = "";
  let rngs = [1];
  const pick: GamePick = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[++i]!;
    if (k === "--json" || k === "--kifu") json = v;
    else if (k === "--at") at = Number(v);
    else if (k === "--agent") agent = v;
    else if (k === "--rng") rngs = v.split(",").map(Number);
    else if (k === "--line") pick.line = Number(v);
    else if (k === "--g") pick.g = Number(v);
    else if (k === "--swap") pick.swap = v === "1" || v === "true";
    else throw new Error(`不明な引数: ${k}`);
  }
  if (!json) throw new Error("--json <試合のファイル> を渡してください");
  const game = pickGame(readGames(json), pick);
  const g = game.record;
  console.log(gameLabel(game));
  const states = replayStates(g.decks, g.seed, g.actions.slice(0, at));
  const s: GameState = states[at]!;
  const p = s.active;
  const who = agent || thinkingAgentOf(g, p);
  if (!who) {
    throw new Error(`この席の AI（${g.agents[p] || "記録なし"}）は名前から作れません。--agent で渡してください（${[...THINKING_AGENTS].join("・")}）`);
  }
  const names: [string, string] = ["P1", "P2"];
  const pl = s.players[p];
  console.log(`手番 P${p + 1}（AI ${who}）/ PP ${pl.pp}/${pl.maxPp} / 手札: ${pl.hand.map((h) => cardOf(h.cardId).name).join("、")}`);
  console.log(`場: ${pl.board.map((c) => cardOf(c.cardId).name).join("、")} / 相手の場: ${s.players[1 - p]!.board.map((c) => cardOf(c.cardId).name).join("、")}`);
  for (const rng of rngs) {
    const t = think(who, s, rng);
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
