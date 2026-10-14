// 人間の対戦記録の各ターンで、人間の手順と探索 AI の手順を、同じ局面から探索 AI 自身に最後まで打たせて比べる（npm run human-plan-value）。
//
// 人間と AI の勝率の差が、どのターンのどの選択から来ているかを調べるため。人間の記録（「人間との比較」タブの書き出し）を再生し、
// 人間の自分のターンの最初の局面ごとに、(1) 人間が実際に打ったターン末、(2) 同じ局面から比べるデッキの既定の AI（リノセウスエルフは
// リノセウス用 AI、他は探索 AI）が打つターン末、を作る。それぞれのターンを終え、同じ M 個のシード（共通の乱数）で、人間側から見た
// 決定化をしてから最後まで打たせ、勝率を比べる（plan-value と同じ。相手は人間の試合と同じ探索 AI）。
// マリガンも 0 ターン目として比べる（同じ決定化の後に、人間の返し方と AI の返し方をそれぞれ打つ）。
// 人間の手順と AI の手順が同じ局面になったターンは打たない。
// あわせて、両方の手順のターン末の点数（探索 AI がビームで使うもの）と相手のターンを貪欲法で読んだ後の点数を出し、
// 人間の手順が AI の候補（最初の手ごとの最善の並び）にあったか、候補の最善の点数より人間の手順の点数が高いか（ビームが届かなかった）を記録する。
// 1 試合ごとに、その試合の全ターンの行を出力ファイルに追記する。同じ引数で再開できる（済みの試合は飛ばす）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { settleConvergingTrades } from "../src/ai/convergingTrade";
import { determinize } from "../src/ai/determinize";
import { SEARCH_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { turnOrderKey } from "../src/ai/keySet";
import { createRhinoAgent, type RhinoOptions } from "../src/ai/rhino";
import { createSearchAgent, simulateOpponentTurn, turnCandidates } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import {
  actingPlayer,
  applyAction,
  cardOf,
  createGame,
  invariantViolations,
  legalActions,
  nextRandom,
  resolveTurnEnd,
  rngFrom,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../src/engine";
import { compareMatch, SUBJECTS, type SubjectId } from "../src/sim/humanCompare";
import { parseHumanRecord, type HumanGameRecord } from "../src/sim/humanRecord";
import { playFrom } from "../src/sim/match";
import { describeAction } from "../src/ui/describe";
import { isParallelWorker, parallelMap } from "./parallel";
import { summarize, type SideSummary } from "./plan-value-data-main";

/** 片方の手順 */
export interface HumanPlanSide {
  /** 手順（人間側から見た文章） */
  steps: string[];
  /** ターン末の点数（探索 AI がビームで使うもの。マリガンは null） */
  value: number | null;
  /** 相手のターンを貪欲法で読んだ後の点数（決定化 3 回の平均。同じ局面・マリガンは null） */
  rescored: number | null;
  /** そのターンで試合が終わったか */
  ended: boolean;
  /** ターン末の局面の要約（ターン終了時の処理の後。マリガン・試合が終わったときは null） */
  end: { me: SideSummary; opp: SideSummary } | null;
  /** M 個のシードそれぞれで勝ったか（同じ局面は打たないので空。エラーで最後まで打てなかったら null） */
  wins: (boolean | null)[];
}

export interface HumanPlanRecord {
  subject: SubjectId;
  /** 相手デッキの名前 */
  deck: string;
  g: number;
  seat: PlayerIndex;
  /** 人間が実際に勝ったか */
  won: boolean;
  /** 人間が先攻か */
  first: boolean;
  /** 人間の自分のターン番号（マリガンは 0） */
  ownTurn: number;
  /** 局面の要約（ターン開始時、人間側から見て） */
  start: { hp: number; oppHp: number; maxPp: number; hand: number; oppHand: number; ep: number; sep: number; board: number; oppBoard: number };
  /** 人間の手順と AI の手順が同じ局面になったか */
  same: boolean;
  human: HumanPlanSide;
  ai: HumanPlanSide;
  /** AI の候補（最初の手ごとのターン末の最善の並び）の最善の点数（同じ局面・マリガンは null） */
  beamBest: number | null;
  /** 人間のターン末が AI の候補のどれかと同じ局面か（同じ局面・マリガンは null） */
  humanInCandidates: boolean | null;
}

export const gameKey = (r: { subject: string; deck: string; g: number; seat: number }) => `${r.subject}/${r.deck}/${r.g}/${r.seat}`;

export function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

export const isStartOfTurn = (s: GameState) => s.phase === "main" && !s.pending && s.stack.length === 0 && s.queue.length === 0;

/**
 * 比べるデッキの席に既定の AI、相手に探索 AI（人間の試合の相手と同じ）。続きを打つたびに作り直す（計画を持ち越さないため）。
 * opts は比べるデッキの AI の設定（variant-plan-value で AI の手順を変えるときだけ使う）
 */
export function makeAgents(subject: SubjectId, seat: PlayerIndex, opts: RhinoOptions = {}): [Agent, Agent] {
  const me = SUBJECTS[subject].agent === "rhino" ? createRhinoAgent(opts) : createSearchAgent(opts);
  const opp = createSearchAgent();
  return seat === 0 ? [me, opp] : [opp, me];
}

/** 探索 AI のターン末の点数（ビームの score と同じ: 合流する相打ちを打ち、ターン終了時の処理を進めてから評価） */
const endValue = (s: GameState, p: PlayerIndex) => evaluateWith(resolveTurnEnd(settleConvergingTrades(s, p)), p, SEARCH_WEIGHTS);

/** 相手のターンを貪欲法で読んだ後の点数（探索 AI が上位の手を読み直すときと同じ。決定化 3 回の平均） */
function rescoredValue(s: GameState, p: PlayerIndex, seed: number): number {
  const rng = rngFrom({ rng: seed });
  const settled = settleConvergingTrades(s, p);
  let v = 0;
  for (let r = 0; r < 3; r++) v += evaluateWith(simulateOpponentTurn(determinize(settled, p, rng), p, rng, SEARCH_WEIGHTS.doomed), p, SEARCH_WEIGHTS) / 3;
  return v;
}

const round = (x: number) => Math.round(x * 100) / 100;
export const keyOf = (s: GameState) => JSON.stringify(turnOrderKey(s));

function mulliganText(s: GameState, a: Action, p: PlayerIndex): string[] {
  if (a.type !== "mulligan") return [describeAction(s, a, p)];
  const swap = new Set(a.swap);
  const names = (keep: boolean) => s.players[p].hand.filter((h) => swap.has(h.iid) !== keep).map((h) => cardOf(h.cardId).name);
  return [`残す: ${names(true).join("、") || "なし"}`, `返す: ${names(false).join("、") || "なし"}`];
}

/** 局面 start から、席 p の AI がターンを終える直前まで打つ（相手の選択待ちは相手の AI が選ぶ） */
export function aiTurn(start: GameState, p: PlayerIndex, agents: [Agent, Agent], seed: number): { end: GameState; steps: string[] } {
  const rng = rngFrom({ rng: seed });
  const steps: string[] = [];
  let t = start;
  for (let guard = 0; guard < 500 && t.phase !== "ended"; guard++) {
    const actor = actingPlayer(t);
    const a = agents[actor].chooseAction(t, legalActions(t), rng);
    if (actor === p && a.type === "endTurn") return { end: t, steps };
    steps.push(describeAction(t, a, p).replace(/^あなた: /, ""));
    t = applyAction(t, a);
    if (t.phase !== "ended" && t.active !== p) throw new Error("ターンを終える手を打たずに相手の番になりました");
  }
  if (t.phase !== "ended") throw new Error("AI がターンを終えません");
  return { end: t, steps };
}

/** 局面 after（ターンを終えた後）から M 回最後まで打たせ、席 p が勝ったか。r 番目は手順によらず同じシード */
export function rollouts(after: GameState, subject: SubjectId, p: PlayerIndex, M: number, seed: number, prepare?: (det: GameState) => GameState): (boolean | null)[] {
  const wins: (boolean | null)[] = [];
  for (let r = 0; r < M; r++) {
    try {
      if (after.phase === "ended") {
        wins.push(after.winner === p);
        continue;
      }
      let det = determinize(after, p, rngFrom({ rng: mix(seed, 1000 + r) }));
      if (prepare) det = prepare(det);
      if (invariantViolations(det).length > 0) {
        wins.push(null);
        continue;
      }
      wins.push(playFrom(makeAgents(subject, p), det, { seed: mix(seed, 2000 + r) }).winner === p);
    } catch {
      wins.push(null);
    }
  }
  return wins;
}

const summarizeEnd = (s: GameState, p: PlayerIndex) => ({ me: summarize(s, p), opp: summarize(s, p === 0 ? 1 : 0) });

function summarizeStart(s: GameState, p: PlayerIndex): HumanPlanRecord["start"] {
  const me = s.players[p], opp = s.players[p === 0 ? 1 : 0];
  return { hp: me.leaderHp, oppHp: opp.leaderHp, maxPp: me.maxPp, hand: me.hand.length, oppHand: opp.hand.length, ep: me.ep, sep: me.sep, board: me.board.length, oppBoard: opp.board.length };
}

/** 1 試合の全ターンを比べる */
function compareGame(rec: HumanGameRecord, M: number, turns: [number, number]): HumanPlanRecord[] {
  const { decks, seed } = compareMatch(rec.subject, rec.deck, rec.g, rec.seat);
  const p = rec.seat;
  const out: HumanPlanRecord[] = [];
  const base = { subject: rec.subject, deck: rec.deck, g: rec.g, seat: p, won: rec.won };

  let s = createGame({ decks, seed });
  const first = s.first === p;
  let lastTurn = -1;
  for (let i = 0; i < rec.actions.length && s.phase !== "ended"; i++) {
    const a = rec.actions[i]!;
    const actor = actingPlayer(s);
    const isMulligan = actor === p && a.type === "mulligan";
    const isTurnStart = actor === p && s.active === p && isStartOfTurn(s) && s.players[p].turnCount !== lastTurn && !isMulligan;
    if (isTurnStart) lastTurn = s.players[p].turnCount;
    const ownTurn = isMulligan ? 0 : s.players[p].turnCount;
    if ((isMulligan || isTurnStart) && ownTurn >= turns[0] && ownTurn <= turns[1]) {
      try {
        const posSeed = mix(seed, 100 + ownTurn);
        const start = s;
        if (isMulligan) {
          const agents = makeAgents(rec.subject, p);
          const aiMull = agents[p].chooseAction(start, legalActions(start), rngFrom({ rng: mix(posSeed, 1) }));
          const sameSwap = aiMull.type === "mulligan" && [...aiMull.swap].sort().join() === [...a.swap].sort().join();
          // 同じ決定化（自分の山札の順番・相手の手札）の後に、それぞれの返し方を打つ
          const play = (m: Action) => (sameSwap ? [] : rollouts(start, rec.subject, p, M, posSeed, (det) => applyAction(det, m)));
          out.push({
            ...base,
            first,
            ownTurn,
            start: summarizeStart(start, p),
            same: sameSwap,
            human: { steps: mulliganText(start, a, p), value: null, rescored: null, ended: false, end: null, wins: play(a) },
            ai: { steps: mulliganText(start, aiMull, p), value: null, rescored: null, ended: false, end: null, wins: play(aiMull) },
            beamBest: null,
            humanInCandidates: null,
          });
        } else {
          // 人間の手順: 記録をターンを終える手の直前まで再生する
          const humanSteps: string[] = [];
          let h = start;
          let complete = false;
          for (let j = i; j < rec.actions.length; j++) {
            const b = rec.actions[j]!;
            if (actingPlayer(h) === p && b.type === "endTurn") {
              complete = true;
              break;
            }
            humanSteps.push(describeAction(h, b, p).replace(/^あなた: /, ""));
            h = applyAction(h, b);
            if (h.phase === "ended") {
              complete = true;
              break;
            }
          }
          if (complete) {
            const ai = aiTurn(start, p, makeAgents(rec.subject, p), mix(posSeed, 1));
            const bothEnded = h.phase === "ended" && ai.end.phase === "ended";
            const same = bothEnded ? h.winner === ai.end.winner : h.phase !== "ended" && ai.end.phase !== "ended" && keyOf(h) === keyOf(ai.end);
            const side = (end: GameState, steps: string[]): HumanPlanSide => {
              const ended = end.phase === "ended";
              return {
                steps,
                value: ended ? null : round(endValue(end, p)),
                rescored: ended || same ? null : round(rescoredValue(end, p, mix(posSeed, 2))),
                ended,
                end: ended ? null : summarizeEnd(resolveTurnEnd(end), p),
                wins: same ? [] : rollouts(ended ? end : applyAction(end, { type: "endTurn" }), rec.subject, p, M, posSeed),
              };
            };
            let beamBest: number | null = null;
            let humanInCandidates: boolean | null = null;
            if (!same && h.phase !== "ended") {
              const cands = turnCandidates(start, p, rngFrom({ rng: mix(posSeed, 3) }));
              beamBest = cands.length > 0 ? round(Math.max(...cands.map((c) => c.value))) : null;
              const hk = keyOf(settleConvergingTrades(h, p));
              humanInCandidates = cands.some((c) => c.state.phase !== "ended" && keyOf(settleConvergingTrades(c.state, p)) === hk);
            }
            out.push({
              ...base,
              first,
              ownTurn,
              start: summarizeStart(start, p),
              same,
              human: side(h, humanSteps),
              ai: side(ai.end, ai.steps),
              beamBest,
              humanInCandidates,
            });
          }
        }
      } catch (e) {
        // 1 局面の失敗で試合全体を止めない
        console.error(`${gameKey(rec)} 自分の ${ownTurn} ターン目: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    s = applyAction(s, a);
  }
  return out;
}

/**
 * npm run human-plan-value -- --out <file.jsonl> [--m 16] [--turns 0-30] [--games g0-g1] <人間の記録.jsonl>...
 * 並列数は環境変数 THREADS（既定は CPU のコア数）。出力ファイルに既にある試合は飛ばす（再開用）
 */
export async function main(argv: string[]): Promise<number> {
  let out = "human-plan-value.jsonl", M = 16, turns: [number, number] = [0, 30], games: [number, number] | null = null;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) {
      files.push(k);
      continue;
    }
    const v = argv[++i] ?? "";
    if (k === "--out") out = v;
    else if (k === "--m") M = Number(v);
    else if (k === "--turns") turns = v.split("-").map(Number) as [number, number];
    else if (k === "--games") games = v.split("-").map(Number) as [number, number];
    else throw new Error(`不明な引数: ${k}`);
  }
  if (files.length === 0) throw new Error("人間の記録（jsonl）を 1 つ以上渡してください");

  const records: HumanGameRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseHumanRecord(JSON.parse(line));
      if (!r) throw new Error(`人間の記録として読めない行があります: ${f}`);
      if (games && (r.g < games[0] || r.g > games[1])) continue;
      records.push(r);
    }
  }
  const done = new Set<string>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      try {
        if (line) done.add(gameKey(JSON.parse(line) as HumanPlanRecord));
      } catch {
        // 書きかけの行は飛ばす
      }
    }
  }
  const todo = records.filter((r) => !done.has(gameKey(r)));
  const t0 = Date.now();
  if (!isParallelWorker) console.log(`試合 ${todo.length}（済み ${records.length - todo.length}）、M ${M}、ターン ${turns[0]}〜${turns[1]}`);

  let positions = 0, compared = 0;
  await parallelMap(
    todo,
    (rec) => compareGame(rec, M, turns).map((x) => JSON.stringify(x)),
    (n, total, lines) => {
      // 親だけが書く（並列の Worker が同じファイルに書くと行が混ざるため）
      if (lines.length > 0) appendFileSync(out, lines.join("\n") + "\n");
      positions += lines.length;
      compared += lines.filter((l) => !(JSON.parse(l) as HumanPlanRecord).same).length;
      const sec = (Date.now() - t0) / 1000;
      console.log(`試合 ${n}/${total}（${sec.toFixed(0)} 秒、残り約 ${((sec / n) * (total - n) / 60).toFixed(0)} 分）`);
    },
  );
  if (!isParallelWorker) console.log(`完了: 局面 ${positions}（打ち比べ ${compared}）、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
