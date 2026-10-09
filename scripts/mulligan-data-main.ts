// マリガンの重みを推定するためのデータ取り（npm run mulligan-data）。
// 両プレイヤーとも、初手の各カードをコインで残す・返すを決め、プレイは探索 AI（エルフはリノセウス用 AI）で行う。
// 1 試合 1 行の JSON を出力ファイルに追記する。途中で止めても、書き終えた試合はそのまま使える。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { rhinoAgent } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, nextRandom, type PlayerIndex } from "../src/engine";
import { playMatch } from "../src/sim/match";

/** 比較に使うデッキ（npm run compare と同じ 7 つ） */
const EXCLUDED_DECKS = ["ランプドラゴン", "スペルウィッチ２"];

/** 1 試合の記録 */
export interface MulliganRecord {
  seed: number;
  /** 席ごとのデッキ名 */
  decks: [string, string];
  first: PlayerIndex;
  winner: PlayerIndex;
  turns: number;
  /** 席ごとの初手 4 枚のカードID（配られた順） */
  hands: [string[], string[]];
  /** 席ごとの、初手の各カードを残したか */
  kept: [boolean[], boolean[]];
}

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

/** マリガンだけコインで決める AI。初手と判断を observed に書く */
function randomMulligan(inner: Agent, coinSeed: number, observed: { hand: string[]; kept: boolean[] }): Agent {
  let s = coinSeed;
  return {
    name: `${inner.name}+randomMulligan`,
    chooseAction(state, legal, rng) {
      const first = legal[0];
      if (first?.type !== "mulligan") return inner.chooseAction(state, legal, rng);
      const hand = state.players[actingPlayer(state)].hand;
      const swap: number[] = [];
      observed.hand = hand.map((h) => h.cardId);
      observed.kept = hand.map((h) => {
        const [v, next] = nextRandom(s);
        s = next;
        const keep = v < 0.5;
        if (!keep) swap.push(h.iid);
        return keep;
      });
      const action = legal.find((a) => a.type === "mulligan" && a.swap.length === swap.length && a.swap.every((x) => swap.includes(x)));
      if (!action) throw new Error("マリガンの合法手が見つかりません");
      return action;
    },
  };
}

/**
 * npm run mulligan-data -- --games <n> --seed <s> --shard <i>/<k> --out <file.jsonl>
 * 試合番号 g（0 ≦ g < n）のうち g % k === i のものを行う。出力ファイルに既にある seed は飛ばす（再開用）。
 */
export async function main(argv: string[]): Promise<number> {
  let games = 100, seed = 1, shard = [0, 1], out = "mulligan-data.jsonl";
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--shard") shard = v.split("/").map(Number);
    else if (k === "--out") out = v;
    else throw new Error(`不明な引数: ${k}`);
  }
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const done = new Set<number>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) if (line) done.add((JSON.parse(line) as MulliganRecord).seed);
  }
  const t0 = Date.now();
  let n = 0;
  for (let g = 0; g < games; g++) {
    if (g % shard[1]! !== shard[0]) continue;
    const gameSeed = mix(seed, g);
    if (done.has(gameSeed)) continue;
    // デッキの組（ミラーを除く）をシードから決める
    const [r1, s1] = nextRandom(gameSeed);
    const [r2] = nextRandom(s1);
    const i = Math.floor(r1 * decks.length);
    const j = (i + 1 + Math.floor(r2 * (decks.length - 1))) % decks.length;
    const pair = [decks[i]!, decks[j]!];
    const obs = [{ hand: [] as string[], kept: [] as boolean[] }, { hand: [] as string[], kept: [] as boolean[] }];
    const agents = pair.map((d, p) => randomMulligan(d.name === "リノセウスエルフ" ? rhinoAgent : searchAgent, mix(gameSeed, 100 + p), obs[p]!)) as [Agent, Agent];
    const r = playMatch(agents, { decks: [pair[0]!.cards, pair[1]!.cards], seed: gameSeed });
    const rec: MulliganRecord = {
      seed: gameSeed,
      decks: [pair[0]!.name, pair[1]!.name],
      first: r.final.first,
      winner: r.winner,
      turns: r.turns,
      hands: [obs[0]!.hand, obs[1]!.hand],
      kept: [obs[0]!.kept, obs[1]!.kept],
    };
    appendFileSync(out, JSON.stringify(rec) + "\n");
    n++;
    if (n % 50 === 0) console.log(`${n} 試合（${((Date.now() - t0) / n / 1000).toFixed(2)} 秒/試合）`);
  }
  console.log(`完了: ${n} 試合、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
