// 調べもの用: 同じ試合（同じシード・デッキ）を 2 つの設定で打った記録（svwb rhino-compare --record）を組にして、
// 最初に手が分かれた局面と、そこからそのターンの終わりまでの両方の手を出す
//
// 使い方: npm run diverge -- --a <記録のディレクトリ A> --b <記録のディレクトリ B> [--file <ファイル名>] [--turns 1]
// --turns は、分かれたターンから何ターン分（手番の交代の数）の手を出すか

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cardOf, type Action, type GameState } from "../src/engine";
import { replayStates } from "../src/sim/replay";
import { describeAction } from "../src/ui/describe";

interface Game {
  seed: number;
  agents: [string, string];
  decks: [string[], string[]];
  winner: number;
  actions: Action[];
}

const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Game;

function side(s: GameState, p: number): string {
  const pl = s.players[p]!;
  const board = (q: number) =>
    s.players[q]!.board.map((c) => {
      const n = cardOf(c.cardId).name;
      return c.kind === "follower" ? `${n}(${c.attack}/${c.defense})` : n;
    }).join("、") || "なし";
  return [
    `  手番 P${p + 1}: 体力 ${pl.leaderHp} / PP ${pl.pp}/${pl.maxPp} / EP ${pl.ep} / SEP ${pl.sep} / 山札 ${pl.deck.length} / ${pl.turnCount} ターン目`,
    `  手札（${pl.hand.length}）: ${pl.hand.map((h) => cardOf(h.cardId).name).join("、")}`,
    `  場: ${board(p)}`,
    `  相手（体力 ${s.players[1 - p]!.leaderHp}、手札 ${s.players[1 - p]!.hand.length}）の場: ${board(1 - p)}`,
  ].join("\n");
}

/** i 手目から、手番の交代を turns 回見るまでの手の説明 */
function lines(states: GameState[], actions: Action[], i: number, turns: number, names: [string, string]): string[] {
  const out: string[] = [];
  let changes = 0;
  for (let k = i; k < actions.length; k++) {
    const s = states[k]!;
    out.push(`${String(k + 1).padStart(4)}. ${describeAction(s, actions[k]!, names, states[k + 1])}`);
    if (actions[k]!.type === "endTurn" && ++changes >= turns) break;
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  let a = "";
  let b = "";
  let only = "";
  let turns = 1;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[++i]!;
    if (k === "--a") a = v;
    else if (k === "--b") b = v;
    else if (k === "--file") only = v;
    else if (k === "--turns") turns = Number(v);
    else throw new Error(`不明な引数: ${k}`);
  }
  const files = readdirSync(a)
    .filter((f) => f.endsWith(".json") && (!only || f === only) && existsSync(join(b, f)))
    .sort();
  for (const f of files) {
    const ga = read(join(a, f));
    const gb = read(join(b, f));
    const seat = Number(/-s(\d)\.json$/.exec(f)?.[1] ?? 0);
    let i = 0;
    while (i < ga.actions.length && i < gb.actions.length && JSON.stringify(ga.actions[i]) === JSON.stringify(gb.actions[i])) i++;
    const res = (g: Game) => (g.winner === seat ? "勝ち" : "負け");
    console.log(`\n=== ${f}（比べるデッキは P${seat + 1}）A ${res(ga)} / B ${res(gb)}、${i + 1} 手目で分かれる`);
    if (i >= ga.actions.length || i >= gb.actions.length) continue;
    const sa = replayStates(ga.decks, ga.seed, ga.actions);
    const sb = replayStates(gb.decks, gb.seed, gb.actions);
    const s = sa[i]!;
    const names: [string, string] = ["P1", "P2"];
    console.log(side(s, s.active));
    console.log("  A:");
    for (const l of lines(sa, ga.actions, i, turns, names)) console.log(`  ${l}`);
    console.log("  B:");
    for (const l of lines(sb, gb.actions, i, turns, names)) console.log(`  ${l}`);
  }
  return 0;
}
