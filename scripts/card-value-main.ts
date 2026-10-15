// 手札のカード 1 枚の価値を介入で測る（npm run card-value）。docs/ai-notes.md「手札のカードの価値を介入で測る」
//
// 対象デッキの AI と他のデッキの AI の対戦の途中（対象デッキの自分のターンの最初）の局面から、
// 「そのまま」と「手札からカード X を 1 枚抜いた」局面を同じシードで最後まで打ち、勝敗の差を X を持っている価値とする。
// 同じ局面で、評価（手で作った評価 S ＋ 学習した補正）が見ている勝つ確率の差も出し、ずれの大きいカードを探す。
//
//   npm run card-value -- --deck リノセウスエルフ --games 300 [--start 0] [--turns 3-8] --out data.jsonl
//   npm run card-value -- report --data data.jsonl[,data2.jsonl]
//
// 対象デッキは、リノセウスエルフならリノセウス用 AI、他は探索 AI。相手は探索 AI。どちらも相手のターンは貪欲法で読む（速さのため）。
// 試合 g の相手は他のデッキを順に、席は 6 試合ごとに入れ替える。局面のターンは試合ごとに --turns の範囲から選ぶ。

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateWith, SEARCH_WEIGHTS } from "../src/ai/evaluate";
import { createRhinoAgent } from "../src/ai/rhino";
import { createSearchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { encodeState, forwardValueNet } from "../src/ai/valueNet";
import { VALUE_NET } from "../src/ai/valueNetModel";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, cardOf, createGame, nextRandom, type GameState, type PlayerIndex } from "../src/engine";
import { playFrom, playMatch } from "../src/sim/match";
import { isParallelWorker, parallelMap } from "./parallel";

const EXCLUDED_DECKS = ["ランプドラゴン"];
/** 試合のシード（他の実験と重ならないように大きくする） */
const SEED_BASE = 3_000_000;

interface Variant {
  cardId: string;
  win: boolean;
  /** 評価が見ている勝つ確率の差（そのまま − 抜いた局面） */
  dp: number;
  /** 手で作った評価 S の差（点） */
  ds: number;
  /** 学習した補正の差（点） */
  dl: number;
}

interface Position {
  g: number;
  opp: string;
  first: boolean;
  ownTurn: number;
  hand: string[];
  baseWin: boolean;
  p: number;
  variants: Variant[];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** 評価の中身: S、補正（点）、勝つ確率 */
function judge(state: GameState, p: PlayerIndex): { s: number; l: number; prob: number } {
  const s = evaluateWith(state, p, SEARCH_WEIGHTS);
  const z = forwardValueNet(VALUE_NET, encodeState(VALUE_NET, state, p, "after"));
  const { a, c } = VALUE_NET.model;
  return { s, l: (c + z) / a, prob: sigmoid(a * s + c + z) };
}

const mix = (seed: number, x: number) => nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "report") return report(argv.slice(1));
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i]!.replace(/^--/, ""), argv[i + 1]!);
  const deckName = args.get("deck") ?? "リノセウスエルフ";
  const games = Number(args.get("games") ?? 100);
  const start = Number(args.get("start") ?? 0);
  const [tMin, tMax] = (args.get("turns") ?? "3-8").split("-").map(Number) as [number, number];
  const out = args.get("out");
  if (!out) throw new Error("--out がありません");
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const subject = decks.find((d) => d.name === deckName);
  if (!subject) throw new Error(`デッキがありません: ${deckName}`);
  const others = decks.filter((d) => d !== subject);
  const subjectAgent = (): Agent => (deckName === "リノセウスエルフ" ? createRhinoAgent({ opponentSearch: null }) : createSearchAgent({ opponentSearch: null }));
  const oppAgent = (): Agent => createSearchAgent({ opponentSearch: null });

  const one = (g: number): Position | null => {
    const opp = others[g % others.length]!;
    const p: PlayerIndex = Math.floor(g / others.length) % 2 === 0 ? 0 : 1;
    const seed = SEED_BASE + g;
    const decksArg: [string[], string[]] = p === 0 ? [subject.cards, opp.cards] : [opp.cards, subject.cards];
    const agents = (): [Agent, Agent] => (p === 0 ? [subjectAgent(), oppAgent()] : [oppAgent(), subjectAgent()]);
    const ownTurn = tMin + (mix(seed, 1) % (tMax - tMin + 1));
    const r = playMatch(agents(), { decks: decksArg, seed, record: true });
    let s = createGame({ decks: decksArg, seed });
    let found = false;
    for (const a of r.log!) {
      if (s.phase === "main" && !s.pending && s.stack.length === 0 && s.queue.length === 0 && s.active === p && actingPlayer(s) === p && s.players[p].turnCount === ownTurn && a.type !== "mulligan") {
        found = true;
        break;
      }
      s = applyAction(s, a);
    }
    if (!found || s.phase === "ended") return null;
    const pseed = mix(seed, 2);
    const base = judge(s, p);
    const baseWin = playFrom(agents(), s, { seed: pseed }).winner === p;
    const variants: Variant[] = [];
    const seen = new Set<string>();
    for (const h of s.players[p].hand) {
      if (seen.has(h.cardId)) continue;
      seen.add(h.cardId);
      const t = structuredClone(s);
      t.players[p].hand = t.players[p].hand.filter((x) => x.iid !== h.iid);
      const j = judge(t, p);
      const win = playFrom(agents(), t, { seed: pseed }).winner === p;
      variants.push({ cardId: h.cardId, win, dp: round(base.prob - j.prob), ds: round(base.s - j.s), dl: round(base.l - j.l) });
    }
    return { g, opp: opp.name, first: p === 0, ownTurn, hand: s.players[p].hand.map((h) => h.cardId), baseWin, p, variants };
  };

  if (!isParallelWorker) writeFileSync(out, "");
  const t0 = Date.now();
  const tasks = Array.from({ length: games }, (_, k) => start + k);
  await parallelMap(
    tasks,
    (g) => JSON.stringify(one(g)),
    (done, total, line) => {
      if (line !== "null") appendFileSync(out, line + "\n");
      if (done % 20 === 0 || done === total) console.log(`${done}/${total} ${((Date.now() - t0) / done / 1000).toFixed(1)}s/局面`);
    },
  );
  return 0;
}

const round = (x: number) => Number(x.toFixed(4));

function report(argv: string[]): number {
  const files = (argv[argv.indexOf("--data") + 1] ?? "").split(",");
  const rows: Position[] = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Position));
  const by = new Map<string, { n: number; d: number; d2: number; dp: number; ds: number; dl: number }>();
  let allN = 0, allD = 0, flips = 0;
  for (const r of rows) {
    for (const v of r.variants) {
      const d = (r.baseWin ? 1 : 0) - (v.win ? 1 : 0);
      const cur = by.get(v.cardId) ?? { n: 0, d: 0, d2: 0, dp: 0, ds: 0, dl: 0 };
      cur.n++;
      cur.d += d;
      cur.d2 += d * d;
      cur.dp += v.dp;
      cur.ds += v.ds;
      cur.dl += v.dl;
      by.set(v.cardId, cur);
      allN++;
      allD += d;
      if (d !== 0) flips++;
    }
  }
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  console.log(`局面 ${rows.length}、対 ${allN}、勝敗が入れ替わった対 ${pct(flips / allN)}、手札 1 枚（全カード平均）${pct(allD / allN)}`);
  console.log("");
  console.log("| カード | 対 | 測った勝率の差 | SE | 評価が見ている差 | ずれ / SE | 差の内訳: S（点） | 補正（点） |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const lines = [...by].map(([id, c]) => {
    const mean = c.d / c.n;
    const se = Math.sqrt(Math.max(c.d2 / c.n - mean * mean, 1e-9) / c.n);
    const dp = c.dp / c.n;
    return { id, c, mean, se, dp, z: (mean - dp) / se };
  });
  lines.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  for (const l of lines) {
    console.log(`| ${cardOf(l.id).name} | ${l.c.n} | ${pct(l.mean)} | ${(l.se * 100).toFixed(1)}% | ${pct(l.dp)} | ${l.z.toFixed(2)} | ${(l.c.ds / l.c.n).toFixed(1)} | ${(l.c.dl / l.c.n).toFixed(1)} |`);
  }
  return 0;
}
