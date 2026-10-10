// カードを「今出す」のと「このターンは出さずに持っておく」のとで勝率がどれだけ違うかを測る（npm run play-now-data）。
//
// 探索 AI どうし（エルフはリノセウス用 AI）の対戦の途中で、各プレイヤーの自分のターンの最初の局面を 1 つずつ取り出す。
// 手札のうち今プレイできるカード（同じカードは 1 回）から最大 --cards 枚を選び、それぞれ次の 2 つを同じシードで最後まで打たせる。
//   - play: そのカードを最初にプレイしてから、残りは AI に任せる
//   - hold: そのターンだけ、そのカードのプレイを禁じる（次のターンからは自由）
// あわせて、何も変えない局面（normal）も 1 回打ち、AI がそのターンにそのカードを出したかを記録する。
// play − hold が「今出す価値」。normal で出したかと比べると、AI の判断が合っているかがわかる。
// リノセウスエルフの局面は取らない（ルールベースのまま扱うため）。
// 1 局面 1 行の JSON を出力ファイルに追記する。途中で止めても、書き終えた局面はそのまま使える。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRhinoAgent } from "../src/ai/rhino";
import { createSearchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import {
  actingPlayer,
  applyAction,
  cloneState,
  createGame,
  legalActions,
  nextRandom,
  rngFrom,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../src/engine";
import { playFrom } from "../src/sim/match";

export interface PlayNowCard {
  cardId: string;
  /** そのカードを最初にプレイした場合 / そのターンは出さなかった場合に勝ったか（エラーなら null） */
  playWin: boolean | null;
  holdWin: boolean | null;
  /** 何も変えない局面で、AI がそのターンにこのカードをプレイしたか */
  normalPlayed: boolean;
}

/** 1 局面の記録 */
export interface PlayNowRecord {
  seed: number;
  p: PlayerIndex;
  decks: [string, string];
  first: PlayerIndex;
  ownTurn: number;
  turn: number;
  hand: string[];
  pp: number;
  normalWin: boolean | null;
  cards: PlayNowCard[];
}

const EXCLUDED_DECKS = ["ランプドラゴン"];
const RULE_BASED = "リノセウスエルフ";

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

const isStartOfTurn = (s: GameState) => s.phase === "main" && !s.pending && s.stack.length === 0 && s.queue.length === 0;

/** 続きを打つたびに作り直す。forbid があれば、プレイヤー p がターン turn にそのカードをプレイするのを禁じる */
function makeAgents(decks: readonly [string, string], forbid?: { p: PlayerIndex; turn: number; cardId: string }): [Agent, Agent] {
  return decks.map((d, i) => {
    if (d === RULE_BASED) return createRhinoAgent();
    if (!forbid || forbid.p !== i) return createSearchAgent();
    return createSearchAgent({
      allow: (s, a, p) =>
        !(p === forbid.p && s.turn === forbid.turn && a.type === "play" && s.players[p].hand.find((h) => h.iid === a.iid)?.cardId === forbid.cardId),
    });
  }) as [Agent, Agent];
}

/**
 * 最後まで打つ。observe があれば、プレイヤー p がターン turn にプレイしたカードIDを集める
 * （playFrom と同じ進め方。AI の乱数は seed から作る）
 */
function playOut(agents: [Agent, Agent], start: GameState, seed: number, observe?: { p: PlayerIndex; turn: number; played: Set<string> }): PlayerIndex {
  if (!observe) return playFrom(agents, start, { seed }).winner;
  let state = start;
  const agentRng = rngFrom({ rng: (seed ^ 0x9e3779b9) >>> 0 });
  for (let n = 0; state.phase !== "ended"; n++) {
    if (n > 10000) throw new Error("アクション数が上限を超えました");
    const actor = actingPlayer(state);
    const a: Action = agents[actor].chooseAction(state, legalActions(state), agentRng);
    if (a.type === "play" && actor === observe.p && state.turn === observe.turn) {
      const h = state.players[actor].hand.find((c) => c.iid === a.iid);
      if (h) observe.played.add(h.cardId);
    }
    state = applyAction(state, a);
  }
  if (state.winner === null) throw new Error("勝者がいません");
  return state.winner;
}

/**
 * npm run play-now-data -- --games <n> --seed <s> --shard <i>/<k> --out <file.jsonl> [--turns 2-8] [--cards 2]
 * 試合番号 g のうち g % k === i のものを行う。1 試合から最大 2 局面（リノセウスエルフ以外の両プレイヤー）。
 */
export async function main(argv: string[]): Promise<number> {
  let games = 10, seed = 1, shard = [0, 1], out = "play-now-data.jsonl", turns = [2, 8], maxCards = 2;
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--shard") shard = v.split("/").map(Number);
    else if (k === "--out") out = v;
    else if (k === "--turns") turns = v.split("-").map(Number);
    else if (k === "--cards") maxCards = Number(v);
    else throw new Error(`不明な引数: ${k}`);
  }
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const done = new Set<string>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      try {
        const r = JSON.parse(line) as PlayNowRecord;
        done.add(`${r.seed}:${r.p}`);
      } catch {
        // 壊れた行は飛ばす
      }
    }
  }
  const t0 = Date.now();
  let positions = 0, plays = 0;
  for (let g = 0; g < games; g++) {
    if (g % shard[1]! !== shard[0]) continue;
    const gameSeed = mix(seed, g);
    const [r1, s1] = nextRandom(gameSeed);
    const [r2, s2] = nextRandom(s1);
    const [r3, s3] = nextRandom(s2);
    const [r4, s4] = nextRandom(s3);
    const i = Math.floor(r1 * decks.length);
    const j = (i + 1 + Math.floor(r2 * (decks.length - 1))) % decks.length;
    const names: [string, string] = [decks[i]!.name, decks[j]!.name];
    const span = turns[1]! - turns[0]! + 1;
    const target = [turns[0]! + Math.floor(r3 * span), turns[0]! + Math.floor(r4 * span)];
    const wanted = ([0, 1] as const).filter((p) => names[p] !== RULE_BASED && !done.has(`${gameSeed}:${p}`));
    if (wanted.length === 0) continue;

    const snaps: (GameState | null)[] = [null, null];
    let state = createGame({ decks: [decks[i]!.cards, decks[j]!.cards], seed: gameSeed });
    const live = makeAgents(names);
    const agentRng = rngFrom({ rng: (gameSeed ^ 0x9e3779b9) >>> 0 });
    for (let n = 0; state.phase !== "ended" && wanted.some((p) => snaps[p] === null); n++) {
      if (n > 10000) throw new Error(`アクション数が上限を超えました (seed ${gameSeed})`);
      const actor = actingPlayer(state);
      if (snaps[actor] === null && isStartOfTurn(state) && state.active === actor && state.players[actor].turnCount === target[actor]) {
        snaps[actor] = cloneState(state);
      }
      state = applyAction(state, live[actor].chooseAction(state, legalActions(state), agentRng));
    }

    let pick = s4;
    for (const p of wanted) {
      const snap = snaps[p];
      if (!snap) continue;
      const contSeed = mix(gameSeed, 200 + p);
      const legal = legalActions(snap);
      // 今プレイできるカード（同じカードは 1 回）から最大 maxCards 枚をシードで選ぶ
      const playable = new Map<string, Action>();
      for (const a of legal) {
        if (a.type !== "play") continue;
        const h = snap.players[p].hand.find((c) => c.iid === a.iid);
        if (h && !playable.has(h.cardId)) playable.set(h.cardId, a);
      }
      const ids = [...playable.keys()];
      const chosen: string[] = [];
      while (chosen.length < maxCards && ids.length > 0) {
        const [r, next] = nextRandom(pick);
        pick = next;
        chosen.push(ids.splice(Math.floor(r * ids.length), 1)[0]!);
      }
      if (chosen.length === 0) continue;
      const run = (f: () => PlayerIndex): boolean | null => {
        plays++;
        try {
          return f() === p;
        } catch {
          return null;
        }
      };
      const played = new Set<string>();
      const normalWin = run(() => playOut(makeAgents(names), snap, contSeed, { p, turn: snap.turn, played }));
      const cards: PlayNowCard[] = chosen.map((cardId) => ({
        cardId,
        playWin: run(() => playOut(makeAgents(names), applyAction(snap, playable.get(cardId)!), contSeed)),
        holdWin: run(() => playOut(makeAgents(names, { p, turn: snap.turn, cardId }), snap, contSeed)),
        normalPlayed: played.has(cardId),
      }));
      const me = snap.players[p];
      const rec: PlayNowRecord = {
        seed: gameSeed,
        p,
        decks: names,
        first: snap.first,
        ownTurn: me.turnCount,
        turn: snap.turn,
        hand: me.hand.map((h) => h.cardId),
        pp: me.pp,
        normalWin,
        cards,
      };
      appendFileSync(out, JSON.stringify(rec) + "\n");
      positions++;
    }
    const sec = (Date.now() - t0) / 1000;
    console.log(`試合 ${g}: 局面 ${positions}、続きの対戦 ${plays}（${(sec / Math.max(positions, 1)).toFixed(1)} 秒/局面）`);
  }
  console.log(`完了: 局面 ${positions}、続きの対戦 ${plays}、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
