// マリガンの重みの評価（npm run mulligan-eval -- --weights <file> --games <n> --seed <s> --shard <i>/<k> --out <file.jsonl> [--decks <デッキ名,...>]）。
// 集計は npm run mulligan-eval -- --summary <file.jsonl ...>
// 自分側のデッキ（既定は比較用の 7 デッキ）× 相手（ミラーを除く）× 両方の席 × n シードについて、自分側だけマリガンを「今の AI の方針」と「重み」で打ち分ける。
// 相手は今の AI（今のマリガン）。シードが同じなので、マリガンの判断が同じなら試合はまったく同じになる。
// そのため判断が違う試合だけを両方の方針で打ち、勝ち負けが入れ替わった数を比べる。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { MULLIGAN_WEIGHTS, costMulliganSwap, weightedMulliganSwap, withMulligan, type MulliganWeights } from "../src/ai/mulligan";
import { mulliganSwap as rhinoMulliganSwap, rhinoAgent } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { createGame, nextRandom, type GameState, type PlayerIndex } from "../src/engine";
import { playMatch } from "../src/sim/match";

const EXCLUDED_DECKS = ["ランプドラゴン"];
const ELF = "リノセウスエルフ";

export interface EvalRecord {
  seed: number;
  deck: string;
  opponent: string;
  seat: PlayerIndex;
  /** 判断が同じだったか（同じなら試合は打たない） */
  same: boolean;
  baseWin?: boolean;
  newWin?: boolean;
}

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** 評価の集計（npm run mulligan-eval -- --summary <file.jsonl ...>） */
function summarize(files: string[]): void {
  const recs: EvalRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        recs.push(JSON.parse(line) as EvalRecord);
      } catch {
        console.log(`読めない行を飛ばしました（${f}）`);
      }
    }
  }
  const rows = new Map<string, { n: number; diff: number; base: number; neu: number; gain: number; loss: number }>();
  const add = (k: string, r: EvalRecord) => {
    const e = rows.get(k) ?? { n: 0, diff: 0, base: 0, neu: 0, gain: 0, loss: 0 };
    e.n++;
    if (!r.same) {
      e.diff++;
      if (r.baseWin) e.base++;
      if (r.newWin) e.neu++;
      if (r.newWin && !r.baseWin) e.gain++;
      if (!r.newWin && r.baseWin) e.loss++;
    }
    rows.set(k, e);
  };
  for (const r of recs) {
    add(r.deck, r);
    add("全体", r);
  }
  console.log("| デッキ | 組 | 判断が違った | 新で勝ち・旧で負け | 新で負け・旧で勝ち | 勝率の差 | z |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const [k, e] of [...rows].sort(([a], [b]) => (a === "全体" ? 1 : b === "全体" ? -1 : a.localeCompare(b)))) {
    // 勝率の差は全ての組（判断が同じ組は差 0）で割る。z は McNemar 検定
    const d = (e.gain - e.loss) / e.n;
    const z = e.gain + e.loss === 0 ? 0 : (e.gain - e.loss) / Math.sqrt(e.gain + e.loss);
    console.log(`| ${k} | ${e.n} | ${e.diff} | ${e.gain} | ${e.loss} | ${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}% | ${z.toFixed(2)} |`);
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--summary") {
    summarize(argv.slice(1));
    return 0;
  }
  let xNames: string[] | null = null;
  const fail = (name: string): never => {
    throw new Error(`デッキがありません: ${name}`);
  };
  let games = 10, seed = 2, shard = [0, 1], out = "mulligan-eval.jsonl", weightsFile = "data/mulligan-weights.json";
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--shard") shard = v.split("/").map(Number);
    else if (k === "--out") out = v;
    else if (k === "--weights") weightsFile = v;
    else if (k === "--decks") xNames = v.split(",");
    else throw new Error(`不明な引数: ${k}`);
  }
  const weights = JSON.parse(readFileSync(weightsFile, "utf8")) as MulliganWeights;
  const compareDecks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  // --decks: 自分側のデッキ（ランプドラゴンも可）。相手は比較用のデッキのうち自分側に無いもの
  const decks = xNames ? xNames.map((n) => DEFAULT_DECKS.find((d) => d.name === n) ?? fail(n)) : compareDecks;
  const opponents = xNames ? compareDecks.filter((d) => !xNames!.includes(d.name)) : compareDecks;
  const done = new Set<string>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) if (line) {
      const r = JSON.parse(line) as EvalRecord;
      done.add(`${r.seed}/${r.deck}/${r.opponent}/${r.seat}`);
    }
  }
  // 今の AI のマリガン（探索 AI は data/mulligan-weights.json の重み、無ければコスト。エルフはリノセウス用のルール）
  const baseSwap = (deck: string) => (s: GameState, p: PlayerIndex) =>
    deck === ELF ? rhinoMulliganSwap(s, p) : (weightedMulliganSwap(s, p, MULLIGAN_WEIGHTS) ?? costMulliganSwap(s, p));
  const baseAgent = (deck: string): Agent => (deck === ELF ? rhinoAgent : searchAgent);
  const t0 = Date.now();
  let n = 0, played = 0;
  let idx = 0;
  for (let g = 0; g < games; g++) {
    for (const x of decks) {
      for (const y of opponents) {
        if (x === y) continue;
        for (const seat of [0, 1] as const) {
          if (idx++ % shard[1]! !== shard[0]) continue;
          const gameSeed = mix(mix(seed, g), decks.indexOf(x) * 16 + opponents.indexOf(y));
          const key = `${gameSeed}/${x.name}/${y.name}/${seat}`;
          if (done.has(key)) continue;
          const deckList: [readonly string[], readonly string[]] = seat === 0 ? [x.cards, y.cards] : [y.cards, x.cards];
          const s0 = createGame({ decks: deckList, seed: gameSeed });
          const before = baseSwap(x.name)(s0, seat);
          const after = weightedMulliganSwap(s0, seat, weights) ?? before;
          const rec: EvalRecord = { seed: gameSeed, deck: x.name, opponent: y.name, seat, same: sameSet(before, after) };
          if (!rec.same) {
            const opp = baseAgent(y.name);
            const run = (me: Agent) => {
              const agents: [Agent, Agent] = seat === 0 ? [me, opp] : [opp, me];
              return playMatch(agents, { decks: deckList, seed: gameSeed }).winner === seat;
            };
            rec.baseWin = run(baseAgent(x.name));
            rec.newWin = run(withMulligan(baseAgent(x.name), "weighted", (s, p) => weightedMulliganSwap(s, p, weights)));
            played += 2;
          }
          appendFileSync(out, JSON.stringify(rec) + "\n");
          n++;
          if (n % 100 === 0) console.log(`${n} 組（${played} 試合、${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
        }
      }
    }
  }
  console.log(`完了: ${n} 組、${played} 試合、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
