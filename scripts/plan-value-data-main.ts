// 同じ局面で選べたターンの手順どうしを、探索 AI 自身に最後まで打たせて比べるデータ取り（npm run plan-value-data）。
//
// 評価関数が見ていない指標を探すため。探索 AI どうし（エルフはリノセウス用 AI）の対戦の途中で、各プレイヤーの自分のターンの
// 最初の局面を取り出し、探索 AI が候補にする「最初の手ごとのターン末の最善の並び」の上位 K 個を作る（相手のターンは読まない段階）。
// 各候補のターン末の局面からターンを終え、同じ M 個のシード（共通の乱数）で、視点のプレイヤーから見た決定化をしてから最後まで打たせる。
// 同じ局面の候補どうしなので、デッキの強さ・先攻後攻などは差に入らない。勝率の差と評価関数の点差のずれを plan-value-fit で調べる。
// 1 局面 1 行の JSON を出力ファイルに追記する。途中で止めても、書き終えた局面はそのまま使える（同じ引数で再開できる）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { settleConvergingTrades } from "../src/ai/convergingTrade";
import { determinize } from "../src/ai/determinize";
import { SEARCH_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { turnOrderKey } from "../src/ai/keySet";
import { createRhinoAgent } from "../src/ai/rhino";
import { createSearchAgent, simulateOpponentTurn, turnCandidates } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import {
  actingPlayer,
  applyAction,
  cardOf,
  cloneState,
  createGame,
  handCost,
  invariantViolations,
  legalActions,
  nextRandom,
  resolveTurnEnd,
  rngFrom,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../src/engine";
import { playFrom } from "../src/sim/match";
import { isParallelWorker, parallelMap } from "./parallel";

/** 局面の片方のプレイヤーの、特徴を後から計算するための要約 */
export interface SideSummary {
  hp: number;
  maxPp: number;
  /** ターン末に残った PP（相手側はターン外なので意味がない） */
  pp: number;
  ep: number;
  sep: number;
  extraPp: boolean;
  deck: number;
  graveyard: number;
  hand: { id: string; cost: number }[];
  board: { id: string; kind: "follower" | "amulet"; atk: number; def: number; kw: string[]; cd: number | null }[];
}

export interface PlanCandidate {
  /** 探索 AI のターン末の点数での順位（0 が最善） */
  rank: number;
  /** 手順（カード名入りの読みやすい形） */
  steps: string[];
  /** ターン末の点数（探索 AI がビームで使うもの） */
  value: number;
  /** 相手のターンを貪欲法で読んだ後の点数（決定化 3 回の平均。探索 AI が上位を選び直すときに使うもの） */
  rescored: number;
  /** ターン末の局面（ターン終了時の処理の後） */
  me: SideSummary;
  opp: SideSummary;
  /** M 個のシードそれぞれで勝ったか（エラーで最後まで打てなかったら null） */
  wins: (boolean | null)[];
}

export interface PlanValueRecord {
  seed: number;
  p: PlayerIndex;
  decks: [string, string];
  first: PlayerIndex;
  ownTurn: number;
  turn: number;
  /** ターン開始時の局面 */
  start: { me: SideSummary; opp: SideSummary };
  candidates: PlanCandidate[];
}

/** 比較に使うデッキ（npm run compare と同じ 7 つ） */
const EXCLUDED_DECKS = ["ランプドラゴン"];

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

const isStartOfTurn = (s: GameState) => s.phase === "main" && !s.pending && s.stack.length === 0 && s.queue.length === 0;

/** 続きを打つたびに作り直す（探索 AI が覚えている計画・リーサルの手順を、別の続きに持ち越さないため） */
function makeAgents(decks: [string, string]): [Agent, Agent] {
  return decks.map((d) => (d === "リノセウスエルフ" ? createRhinoAgent() : createSearchAgent())) as [Agent, Agent];
}

export function summarize(s: GameState, q: PlayerIndex): SideSummary {
  const pl = s.players[q];
  return {
    hp: pl.leaderHp,
    maxPp: pl.maxPp,
    pp: pl.pp,
    ep: pl.ep,
    sep: pl.sep,
    extraPp: pl.extraPpAvailable,
    deck: pl.deck.length,
    graveyard: pl.graveyard,
    hand: pl.hand.map((h) => ({ id: h.cardId, cost: handCost(h) })),
    board: pl.board.map((c) =>
      c.kind === "follower"
        ? { id: c.cardId, kind: c.kind, atk: c.attack, def: c.defense, kw: [...c.keywords, ...c.tempKeywords], cd: null }
        : { id: c.cardId, kind: c.kind, atk: 0, def: 0, kw: [...c.keywords], cd: c.countdown },
    ),
  };
}

const IID_KEYS = new Set(["iid", "attacker", "host", "target"]);

/** 手を読みやすい文字列にする（カードのiidはカード名に置き換える） */
function describe(s: GameState, a: Action): string {
  const names = new Map<number, string>();
  for (const pl of s.players) {
    for (const h of pl.hand) names.set(h.iid, cardOf(h.cardId).name);
    for (const c of pl.board) names.set(c.iid, cardOf(c.cardId).name);
  }
  return JSON.stringify(a, (k, v) => (typeof v === "number" && (IID_KEYS.has(k) || /^\d+$/.test(k)) && names.has(v) ? names.get(v) : v));
}

/**
 * npm run plan-value-data -- --games <n> --seed <s> --out <file.jsonl> [--turns 2-8] [--k 4] [--m 8]
 * 1 試合から最大 2 局面（両プレイヤー 1 つずつ）。並列数は環境変数 THREADS（既定は CPU のコア数）。
 * 出力ファイルに既にある seed は飛ばす（再開用）
 */
export async function main(argv: string[]): Promise<number> {
  let games = 10, seed = 1, out = "plan-value-data.jsonl", turns = [2, 8], K = 4, M = 8;
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--out") out = v;
    else if (k === "--turns") turns = v.split("-").map(Number);
    else if (k === "--k") K = Number(v);
    else if (k === "--m") M = Number(v);
    else throw new Error(`不明な引数: ${k}`);
  }
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const done = new Set<number>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      try {
        if (line) done.add((JSON.parse(line) as PlanValueRecord).seed);
      } catch {
        // 書きかけの行は飛ばす
      }
    }
  }
  const todo = [...Array(games).keys()].map((g) => mix(seed, g)).filter((s) => !done.has(s));
  const t0 = Date.now();
  if (!isParallelWorker) console.log(`試合 ${todo.length}（済み ${games - todo.length}）、K ${K}、M ${M}`);

  const counts = await parallelMap(
    todo,
    (gameSeed) => {
      const [r1, s1] = nextRandom(gameSeed);
      const [r2, s2] = nextRandom(s1);
      const [r3, s3] = nextRandom(s2);
      const [r4] = nextRandom(s3);
      const i = Math.floor(r1 * decks.length);
      const j = (i + 1 + Math.floor(r2 * (decks.length - 1))) % decks.length;
      const pair = [decks[i]!, decks[j]!];
      const names: [string, string] = [pair[0]!.name, pair[1]!.name];
      const span = turns[1]! - turns[0]! + 1;
      const target = [turns[0]! + Math.floor(r3 * span), turns[0]! + Math.floor(r4 * span)];

      // 本線の対戦を進め、目標のターンの最初の局面を取り出す
      const snaps: (GameState | null)[] = [null, null];
      let state = createGame({ decks: [pair[0]!.cards, pair[1]!.cards], seed: gameSeed });
      const agents = makeAgents(names);
      const agentRng = rngFrom({ rng: (gameSeed ^ 0x9e3779b9) >>> 0 });
      let actions = 0;
      while (state.phase !== "ended" && snaps.some((x) => x === null)) {
        if (++actions > 10000) throw new Error(`アクション数が上限を超えました (seed ${gameSeed})`);
        const actor = actingPlayer(state);
        if (snaps[actor] === null && isStartOfTurn(state) && state.active === actor && state.players[actor].turnCount === target[actor]) {
          snaps[actor] = cloneState(state);
        }
        state = applyAction(state, agents[actor].chooseAction(state, legalActions(state), agentRng));
      }

      let written = 0;
      for (const p of [0, 1] as const) {
        const snap = snaps[p];
        if (!snap) continue;
        const q: PlayerIndex = p === 0 ? 1 : 0;
        const rng = rngFrom({ rng: mix(gameSeed, 300 + p) });
        // 候補: 最初の手ごとの最善の並び。合流する相打ちを打った後、ターン末の局面が同じものは 1 つにまとめる
        const seen = new Set<string>();
        const picked: { actions: Action[]; end: GameState; value: number; rank: number }[] = [];
        turnCandidates(snap, p, rng).forEach((c, rank) => {
          if (picked.length >= K) return;
          const end = settleConvergingTrades(c.state, p);
          // ターンを終えられない局面（選択待ち等）は飛ばす
          if (end.phase !== "ended" && (end.pending || end.active !== p || !isStartOfTurn(end))) return;
          const key = JSON.stringify(turnOrderKey(end));
          if (seen.has(key)) return;
          seen.add(key);
          picked.push({ actions: c.actions, end, value: c.value, rank });
        });
        // リーサルのある局面は比べる意味がない（探索 AI はリーサル探索で打つ）
        if (picked.length < 2 || picked.some((c) => c.end.phase === "ended")) continue;

        const candidates: PlanCandidate[] = picked.map((c) => {
          const scored = resolveTurnEnd(c.end);
          let rescored = 0;
          for (let r = 0; r < 3; r++) {
            const det = determinize(c.end, p, rng);
            rescored += evaluateWith(simulateOpponentTurn(det, p, rng, SEARCH_WEIGHTS.doomed), p, SEARCH_WEIGHTS) / 3;
          }
          // 手順の読みやすい形（各手を打つ前の局面でカード名を引く）
          const steps: string[] = [];
          let s = snap;
          for (const a of c.actions) {
            steps.push(describe(s, a));
            try {
              s = applyAction(s, a);
            } catch {
              break;
            }
          }
          const wins: (boolean | null)[] = [];
          const after = applyAction(c.end, { type: "endTurn" });
          for (let r = 0; r < M; r++) {
            try {
              // 共通の乱数: 候補によらず、r 番目は同じシードで決定化し、同じ AI の乱数で打つ
              const det = after.phase === "ended" ? after : determinize(after, p, rngFrom({ rng: mix(gameSeed, 1000 + 100 * p + r) }));
              if (invariantViolations(det).length > 0) {
                wins.push(null);
                continue;
              }
              wins.push(playFrom(makeAgents(names), det, { seed: mix(gameSeed, 2000 + 100 * p + r) }).winner === p);
            } catch {
              wins.push(null);
            }
          }
          return {
            rank: c.rank,
            steps,
            value: Math.round(c.value * 100) / 100,
            rescored: Math.round(rescored * 100) / 100,
            me: summarize(scored, p),
            opp: summarize(scored, q),
            wins,
          };
        });
        const rec: PlanValueRecord = {
          seed: gameSeed,
          p,
          decks: names,
          first: snap.first,
          ownTurn: snap.players[p].turnCount,
          turn: snap.turn,
          start: { me: summarize(snap, p), opp: summarize(snap, q) },
          candidates,
        };
        appendFileSync(out, JSON.stringify(rec) + "\n");
        written++;
      }
      return written;
    },
    (n, total) => {
      const sec = (Date.now() - t0) / 1000;
      console.log(`試合 ${n}/${total}（${sec.toFixed(0)} 秒、残り約 ${((sec / n) * (total - n) / 60).toFixed(0)} 分）`);
    },
  );
  if (!isParallelWorker) console.log(`完了: 局面 ${counts.reduce((a, b) => a + b, 0)}、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
