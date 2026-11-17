// 調べもの用: 同じ試合（同じシード・デッキ）を 2 つの設定で打った棋譜（svwb rhino-compare 等。docs/kifu.md）を組にして、
// 最初に手が分かれた局面と、そこからそのターンの終わりまでの両方の手を出す
//
// 使い方: npm run diverge -- --a <棋譜 A> --b <棋譜 B> [--g <試合番号>] [--turns 1] [--skipFuse true]
// 棋譜は .jsonl・.jsonl.gz。同じ試合番号・組・シード・デッキの試合を組にする。比べるデッキの席は、棋譜の sides が A の席（無ければ P1）。
// 前の形（2026-11-17 までの rhino-compare --record のディレクトリ）を渡すと、同じファイル名の試合を組にする（--file <ファイル名> で 1 つだけ。席はファイル名から）
// --turns は、分かれたターンから何ターン分（手番の交代の数）の手を出すか
// --skipFuse true なら、ターンの終わりの局面（比べるデッキの手札の中身は除く）を比べ、最初に違ったターンの初めの両方の局面と、そこからの両方の手を出す
// （融合を回すかだけを変えた設定どうしで、融合の後に打つ手が分かれたところを見る）

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cardOf, type Action, type GameState } from "../src/engine";
import { replayStates } from "../src/sim/replay";
import { describeAction } from "../src/ui/describe";
import { readGames } from "./game-files";

interface Game {
  seed: number;
  agents: [string, string];
  decks: [string[], string[]];
  winner: number | null;
  actions: Action[];
}

const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Game;

/** 組にした 2 試合（見出し・比べるデッキの席） */
interface Pair {
  label: string;
  seat: number;
  ga: Game;
  gb: Game;
}

/** 前の形: 2 つのディレクトリの同じファイル名の試合 */
function dirPairs(a: string, b: string, only: string): Pair[] {
  return readdirSync(a)
    .filter((f) => f.endsWith(".json") && (!only || f === only) && existsSync(join(b, f)))
    .sort()
    .map((f) => ({ label: f, seat: Number(/-s(\d)\.json$/.exec(f)?.[1] ?? 0), ga: read(join(a, f)), gb: read(join(b, f)) }));
}

/** 棋譜: 同じ試合番号・組・シード・デッキの試合（g があればその試合番号だけ） */
function kifuPairs(a: string, b: string, g: number | null): Pair[] {
  const key = (r: { g?: number; swap?: boolean; seed: number; decks: [string[], string[]] }) => JSON.stringify([r.g ?? null, r.swap ?? null, r.seed, r.decks]);
  const bs = new Map(readGames(b).map((x) => [key(x.record), x.record]));
  const out: Pair[] = [];
  for (const { record: ra } of readGames(a)) {
    if (g !== null && ra.g !== g) continue;
    const rb = bs.get(key(ra));
    if (!rb) continue;
    const seat = Math.max(0, ra.sides?.indexOf("A") ?? 0);
    const swap = ra.swap === undefined ? "" : ra.swap ? " 入れ替え" : "";
    out.push({ label: `g${ra.g ?? "?"}${swap} ${ra.names[0]} 対 ${ra.names[1]}`, seat, ga: ra, gb: rb });
  }
  return out;
}

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

/** ターンごとの手の範囲（[最初の手, ターン終了の次)。マリガンは除く） */
function turnsOf(actions: Action[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (start < actions.length && actions[start]!.type === "mulligan") start++;
  for (let k = start; k < actions.length; k++) {
    if (actions[k]!.type === "endTurn") {
      out.push([start, k + 1]);
      start = k + 1;
    }
  }
  if (start < actions.length) out.push([start, actions.length]);
  return out;
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
  let g: number | null = null;
  let turns = 1;
  let skipFuse = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[++i]!;
    if (k === "--a") a = v;
    else if (k === "--b") b = v;
    else if (k === "--file") only = v;
    else if (k === "--g") g = Number(v);
    else if (k === "--turns") turns = Number(v);
    else if (k === "--skipFuse") skipFuse = v === "true";
    else throw new Error(`不明な引数: ${k}`);
  }
  const pairs = statSync(a).isDirectory() ? dirPairs(a, b, only) : kifuPairs(a, b, g);
  if (pairs.length === 0) console.log("組にできる試合がありません（同じ試合番号・シード・デッキの試合が両方に要ります）");
  for (const { label: f, seat, ga, gb } of pairs) {
    if (skipFuse) {
      printTurnDiverge(f, ga, gb, seat, turns);
      continue;
    }
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

/**
 * ターンの終わりの局面のうち、比べる所（両方のリーダーの体力・EP・SEP、両方の場（カード名・攻撃力・体力・進化。並びは問わない）、山札の枚数、
 * 相手（比べるデッキでないほう）の手札）。比べるデッキの手札は、融合を回すかで中身が変わるので比べない
 */
function turnKey(s: GameState, seat: number): string {
  return JSON.stringify(
    s.players.map((pl, p) => [
      pl.leaderHp,
      pl.ep,
      pl.sep,
      pl.deck.length,
      pl.board.map((c) => JSON.stringify([cardOf(c.cardId).name, c.kind === "follower" ? [c.attack, c.defense, c.evolve] : 0])).sort(),
      p === seat ? pl.hand.length > 0 : pl.hand.map((h) => cardOf(h.cardId).name),
    ]),
  );
}

/** --skipFuse: ターンの終わりの局面（融合を回すかで変わる比べるデッキの手札を除く）が最初に違ったターンの、両方の局面と手 */
function printTurnDiverge(f: string, ga: Game, gb: Game, seat: number, turns: number): void {
  const res = (g: Game) => (g.winner === seat ? "勝ち" : "負け");
  const ta = turnsOf(ga.actions);
  const tb = turnsOf(gb.actions);
  const sa = replayStates(ga.decks, ga.seed, ga.actions);
  const sb = replayStates(gb.decks, gb.seed, gb.actions);
  let t = 0;
  while (
    t < ta.length &&
    t < tb.length &&
    turnKey(sa[ta[t]![1]]!, seat) === turnKey(sb[tb[t]![1]]!, seat)
  )
    t++;
  console.log(`\n=== ${f}（比べるデッキは P${seat + 1}）A ${res(ga)}（${ta.length} ターン）/ B ${res(gb)}（${tb.length} ターン）、${t + 1} ターン目の終わりで局面が分かれる`);
  if (t >= ta.length || t >= tb.length) return;
  const names: [string, string] = ["P1", "P2"];
  for (const [label, g, states, range] of [
    ["A", ga, sa, ta[t]!],
    ["B", gb, sb, tb[t]!],
  ] as const) {
    const s = states[range[0]]!;
    console.log(`  ${label} のターンの初め:`);
    console.log(side(s, s.active));
    for (const l of lines(states, g.actions, range[0], turns, names)) console.log(`  ${l}`);
  }
}
