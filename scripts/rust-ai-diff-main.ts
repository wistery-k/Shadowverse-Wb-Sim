// TypeScript 版と Rust 版（rust/）の探索 AI が同じ手を選ぶかの差分テスト（npm run rust-ai-diff）。
//
//   npm run rust-ai-diff -- expect --games 14 [--start 0] [--agent search|rhino|rhino-lethal] [--probe] --out expected-ai.txt
//     AI どうしの試合（search は npm run bench と同じ組み合わせ・シード）を打ち、1 試合 1 行で行動の列を書き出す。
//     rhino・rhino-lethal は、片方の席（試合ごとに入れ替える）をリノセウスエルフにして、両方の席をその AI で打つ
//     （エルフ以外のデッキでは探索 AI と同じ）。
//     --probe を付けると、エルフの手番で手を選ぶたびに、相手の体力をリノセウスの上限の式の値にした局面でも
//     リーサル探索（searchLethalForRhinoTurn。全探索を含む）を行い、見つけた手順も書き出す（全探索の差分を多く調べるため）。
//     全探索のメモと局面数の上限はターンの間で共有なので、probe なしとは試合の流れが変わる
//     Rust 版の `svwb ai-diff expected-ai.txt` が同じ試合を打って突き合わせる
//
// 行動の書き方は rust/engine/src/canonical.rs の action_canon と同じ（scripts/rust-diff-main.ts の actionCanon）。

import { writeFileSync } from "node:fs";
import { createRhinoAgent, rhinoLethalBound, searchLethalForRhinoTurn } from "../src/ai/rhino";
import { createSearchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, cardOf, createGame, legalActions, rngFrom, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { actionCanon } from "./rust-diff-main";

const EXCLUDED_DECKS = ["ランプドラゴン"];
const ELF = "リノセウスエルフ";

const AGENT_KINDS = ["search", "rhino", "rhino-lethal"] as const;
type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * 試合 g の組み合わせとシード（search は scripts/bench-main.ts と同じ）。
 * elf なら、試合ごとに席を入れ替えてリノセウスエルフと、それ以外のデッキ（2 試合ごとに次のデッキ）を当てる
 */
export function aiGameSetup(g: number, elf = false): { decks: [readonly string[], readonly string[]]; seed: number } {
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const seed = g * 7 + 1;
  if (elf) {
    const others = decks.filter((d) => d.name !== ELF);
    const elfCards = decks.find((d) => d.name === ELF)!.cards;
    const other = others[Math.floor(g / 2) % others.length]!.cards;
    return { decks: g % 2 === 0 ? [elfCards, other] : [other, elfCards], seed };
  }
  const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
  return { decks: [decks[i]!.cards, decks[j]!.cards], seed };
}

function createAgent(kind: AgentKind): Agent {
  if (kind === "rhino") return createRhinoAgent();
  if (kind === "rhino-lethal") return createRhinoAgent({}, { rules: false });
  return createSearchAgent();
}

/**
 * --probe: エルフ（elf の席）の手番で選択待ちでなく、手札にリノセウスがあれば、相手の体力を上限の式の値にした局面で
 * リーサル探索を行い、見つけた手順（無ければ "-"）を "?" に続けて返す
 */
function probe(state: GameState, elf: PlayerIndex): string | null {
  if (state.phase !== "main" || state.active !== elf || state.pending) return null;
  if (!state.players[elf].hand.some((h) => cardOf(h.cardId).name === "殺戮のリノセウス")) return null;
  const hp = rhinoLethalBound(state, elf);
  if (hp < 1) return null;
  const opp = elf === 0 ? 1 : 0;
  const players = [...state.players] as GameState["players"];
  players[opp] = { ...state.players[opp], leaderHp: hp };
  const seq = searchLethalForRhinoTurn({ ...state, players }, elf);
  return `?${seq ? seq.map(actionCanon).join(",") : "-"}`;
}

function play(g: number, kind: AgentKind, withProbe: boolean): { log: string[]; winner: number | null; ms: number } {
  const { decks, seed } = aiGameSetup(g, kind !== "search");
  const agent: Agent = createAgent(kind);
  let state = createGame({ decks, seed });
  const rng = rngFrom({ rng: (seed ^ 0x9e3779b9) >>> 0 });
  const log: string[] = [];
  const elf: PlayerIndex = g % 2 === 0 ? 0 : 1;
  const t0 = performance.now();
  while (state.phase !== "ended") {
    const legal = legalActions(state);
    const action = agent.chooseAction(state, legal, rng);
    log.push(actionCanon(action));
    const p = withProbe ? probe(state, elf) : null;
    if (p !== null) log.push(p);
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
    console.error("使い方: npm run rust-ai-diff -- expect --games N [--start S] [--agent search|rhino|rhino-lethal] [--probe] --out FILE");
    return 2;
  }
  const a = argv.indexOf("--agent");
  const kind = (a >= 0 ? argv[a + 1] : "search") as AgentKind;
  if (!AGENT_KINDS.includes(kind)) {
    console.error(`未知の AI: ${kind}`);
    return 2;
  }
  const withProbe = argv.includes("--probe");
  if (withProbe && kind === "search") {
    console.error("--probe は rhino・rhino-lethal と一緒に使う");
    return 2;
  }
  const games = flag(argv, "games", 14);
  const start = flag(argv, "start", 0);
  const i = argv.indexOf("--out");
  const out = i >= 0 ? argv[i + 1]! : "expected-ai.txt";
  // 先頭の行で AI の種類を伝える（search なら書かない）
  const lines: string[] = kind === "search" ? [] : [`agent ${kind}${withProbe ? " probe" : ""}`];
  let total = 0;
  for (let g = start; g < start + games; g++) {
    const r = play(g, kind, withProbe);
    total += r.ms;
    lines.push(`${g} ${r.winner} ${r.log.join(" ")}`);
    console.log(`試合 ${g}: 勝者 ${r.winner}、${r.log.length} 手、${(r.ms / 1000).toFixed(2)}秒`);
  }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${games} 試合を ${out} に書き出しました（1 試合 ${(total / games / 1000).toFixed(2)}秒）`);
  return 0;
}
