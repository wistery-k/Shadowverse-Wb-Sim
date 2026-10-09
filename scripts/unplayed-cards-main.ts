// 手札にあってプレイできたのにプレイされなかったカードを探すためのデータ取り（npm run unplayed-cards）。
// 自己対戦（探索 AI、リノセウスエルフはリノセウス用 AI）をしながら、手番ごとに手札の各カードについて
// 「そのターン中にプレイの合法手があったか」「プレイしたか」「ターン終了を選んだ時点でまだプレイできたか」を記録する。
// 1 試合 1 行の JSON を出力ファイルに追記する。途中で止めても、書き終えた試合はそのまま使える。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { rhinoAgent } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import {
  actingPlayer,
  applyAction,
  createGame,
  handCost,
  legalActions,
  nextRandom,
  rngFrom,
  type PlayerIndex,
} from "../src/engine";

/** 手番 1 回での手札の 1 枚 */
export interface HandTurn {
  /** プレイヤー */
  p: PlayerIndex;
  /** そのプレイヤーの何ターン目か */
  t: number;
  /** カードID */
  c: string;
  /** カードの iid（同じカードのターンをまたいだ記録をつなぐ） */
  i: number;
  /** そのターン中にプレイの合法手があった */
  ok: boolean;
  /** そのターンにプレイした */
  played: boolean;
  /** ターン終了を選んだ時点でまだプレイの合法手があった */
  skip: boolean;
  /** ターン終了時の残り PP・PP 最大値・そのカードのコスト（skip のときのみ） */
  pp?: number;
  maxPp?: number;
  cost?: number;
}

export interface UnplayedRecord {
  seed: number;
  decks: [string, string];
  first: PlayerIndex;
  winner: PlayerIndex;
  turns: number;
  hands: HandTurn[];
}

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

/**
 * npm run unplayed-cards -- --games <n> --seed <s> --shard <i>/<k> --out <file.jsonl>
 * 試合番号 g（0 ≦ g < n）のうち g % k === i のものを行う。出力ファイルに既にある seed は飛ばす（再開用）。
 */
export async function main(argv: string[]): Promise<number> {
  let games = 100, seed = 1, shard = [0, 1], out = "unplayed-cards.jsonl";
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--shard") shard = v.split("/").map(Number);
    else if (k === "--out") out = v;
    else throw new Error(`不明な引数: ${k}`);
  }
  const decks = DEFAULT_DECKS;
  const done = new Set<number>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) if (line) done.add((JSON.parse(line) as UnplayedRecord).seed);
  }
  const t0 = Date.now();
  let n = 0;
  for (let g = 0; g < games; g++) {
    if (g % shard[1]! !== shard[0]) continue;
    const gameSeed = mix(seed, g);
    if (done.has(gameSeed)) continue;
    // デッキの組（ミラーを含む）をシードから決める
    const [r1, s1] = nextRandom(gameSeed);
    const [r2] = nextRandom(s1);
    const pair = [decks[Math.floor(r1 * decks.length)]!, decks[Math.floor(r2 * decks.length)]!];
    const agents = pair.map((d) => (d.name === "リノセウスエルフ" ? rhinoAgent : searchAgent)) as [Agent, Agent];

    let state = createGame({ decks: [pair[0]!.cards, pair[1]!.cards], seed: gameSeed });
    const agentRng = rngFrom({ rng: (gameSeed ^ 0x9e3779b9) >>> 0 });
    const hands: HandTurn[] = [];
    // 手番中の手札のカード（iid → 記録）
    let cur = new Map<number, HandTurn>();
    let curKey = "";
    let actions = 0;
    while (state.phase !== "ended") {
      if (++actions > 10000) throw new Error("アクション数が上限を超えました");
      const legal = legalActions(state);
      const actor = actingPlayer(state);
      if (state.phase === "main" && state.pending === null && actor === state.active) {
        const pl = state.players[actor];
        const key = `${actor}:${pl.turnCount}`;
        if (key !== curKey) {
          hands.push(...cur.values());
          cur = new Map();
          curKey = key;
        }
        const playable = new Set(legal.flatMap((a) => (a.type === "play" ? [a.iid] : [])));
        for (const h of pl.hand) {
          let rec = cur.get(h.iid);
          if (!rec) {
            rec = { p: actor, t: pl.turnCount, c: h.cardId, i: h.iid, ok: false, played: false, skip: false };
            cur.set(h.iid, rec);
          }
          if (playable.has(h.iid)) rec.ok = true;
        }
      }
      const action = agents[actor].chooseAction(state, legal, agentRng);
      if (action.type === "play") {
        const rec = cur.get(action.iid);
        if (rec) rec.played = true;
      } else if (action.type === "endTurn") {
        const pl = state.players[actor];
        for (const h of pl.hand) {
          const rec = cur.get(h.iid);
          if (!rec || !legal.some((a) => a.type === "play" && a.iid === h.iid)) continue;
          rec.skip = true;
          rec.pp = pl.pp;
          rec.maxPp = pl.maxPp;
          rec.cost = handCost(h);
        }
      }
      state = applyAction(state, action);
    }
    hands.push(...cur.values());
    if (state.winner === null) throw new Error("勝者がいません");
    const rec: UnplayedRecord = {
      seed: gameSeed,
      decks: [pair[0]!.name, pair[1]!.name],
      first: state.first,
      winner: state.winner,
      turns: state.turn,
      hands,
    };
    appendFileSync(out, JSON.stringify(rec) + "\n");
    n++;
    if (n % 20 === 0) console.log(`${n} 試合（${((Date.now() - t0) / n / 1000).toFixed(2)} 秒/試合）`);
  }
  console.log(`完了: ${n} 試合、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
