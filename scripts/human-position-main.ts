// human-plan-value の 1 局面を詳しく見る（npm run human-position -- --key <subject>/<相手デッキ>/<g>/<席> --turn <自分のターン> [--m 32] [--cands 6] [--show 3] <人間の記録.jsonl>...）。
//
// 人間の記録を再生して、人間の自分のターンの最初の局面を作り、次を出す。
// - 開始時の局面（両者の場・手札・PP 等）
// - 人間の手順と AI の手順、それぞれのターン末の局面（合流する相打ちとターン終了時の処理の後）と、評価の内訳
//   （重みを 1 つずつ 0 にしたときに下がる点数と、場のカード 1 枚ごとの点数）
// - AI の候補（最初の手ごとのターン末の最善の並び）の上位
// - --m が 1 以上なら、human-plan-value と同じシードで両方の手順から最後まで打ち、相手の次のターンの後の局面の平均と、
//   結果が分かれたシードの相手の次のターンの手順を出す（human-plan-value の data.jsonl と同じ勝敗になる）
// - --opts '<JSON>' で、AI の手順（このターンだけ）を打つ AI の設定（SearchOptions の一部。リノセウスエルフは RhinoOptions）を変えられる。
//   "weights" にオブジェクトを渡すと SEARCH_WEIGHTS のその項目だけを変える。続きは変えない（同じシードで人間の手順と比べるため）

import { readFileSync } from "node:fs";
import { settleConvergingTrades } from "../src/ai/convergingTrade";
import { determinize } from "../src/ai/determinize";
import { SEARCH_WEIGHTS, evaluateWith, type EvalWeights, type NumericWeight } from "../src/ai/evaluate";
import { createRhinoAgent, type RhinoOptions } from "../src/ai/rhino";
import { createSearchAgent, rescoredCandidates, turnCandidates } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import {
  actingPlayer,
  applyAction,
  cardOf,
  createGame,
  handCost,
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
import { KEYWORD_NAMES, crestName, describeAction } from "../src/ui/describe";

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

const isStartOfTurn = (s: GameState) => s.phase === "main" && !s.pending && s.stack.length === 0 && s.queue.length === 0;
const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);
const round = (x: number) => Math.round(x * 100) / 100;

function makeAgents(subject: SubjectId, seat: PlayerIndex, opts: RhinoOptions = {}): [Agent, Agent] {
  const me = SUBJECTS[subject].agent === "rhino" ? createRhinoAgent(opts) : createSearchAgent(opts);
  const opp = createSearchAgent();
  return seat === 0 ? [me, opp] : [opp, me];
}

const endState = (s: GameState, p: PlayerIndex) => resolveTurnEnd(settleConvergingTrades(s, p));

/** プレイヤー q の様子（viewer から見て。相手の手札は枚数だけ） */
function sideText(s: GameState, q: PlayerIndex, viewer: PlayerIndex): string[] {
  const pl = s.players[q];
  const out: string[] = [];
  out.push(
    `体力 ${pl.leaderHp}/${pl.leaderMaxHp}、PP ${pl.pp}/${pl.maxPp}、EP ${pl.ep}・SEP ${pl.sep}${pl.extraPpAvailable ? "・エクストラPP" : ""}、山札 ${pl.deck.length}、墓場 ${pl.graveyard}` +
      (pl.crests.length ? `、クレスト ${pl.crests.map((c) => crestName(c.crestId)).join("・")}` : ""),
  );
  const hand = pl.hand.map((h) => {
    const c = cardOf(h.cardId);
    const extra = [h.boosts ? `ブースト${h.boosts}` : "", h.x !== null ? `X${h.x}` : "", h.fusedKinds.length ? `融合${h.fusedKinds.length}` : ""].filter(Boolean).join("・");
    return `${c.name}(${handCost(h)}${extra ? `・${extra}` : ""})`;
  });
  out.push(q === viewer ? `手札 ${pl.hand.length}: ${hand.join("、")}` : `手札 ${pl.hand.length}（実際: ${hand.join("、")}）`);
  const board = pl.board.map((c) => {
    const name = cardOf(c.cardId).name;
    if (c.kind === "amulet") return `${name}${c.countdown !== null ? `（カウント ${c.countdown}）` : ""}${c.sigils !== null ? `（印 ${c.sigils}）` : ""}`;
    const kw = [...c.keywords, ...c.tempKeywords].map((k) => KEYWORD_NAMES[k] ?? k);
    const evo = c.evolve === "superEvolved" ? "超進化" : c.evolve === "evolved" ? "進化" : "";
    return `${name} ${c.attack}/${c.defense}${[evo, ...kw].filter(Boolean).length ? `［${[evo, ...kw].filter(Boolean).join("・")}］` : ""}${c.granted.length ? "＋付与" : ""}`;
  });
  out.push(`場 ${pl.board.length}: ${board.join("、") || "なし"}`);
  return out;
}

function stateText(s: GameState, p: PlayerIndex, indent = "  "): string[] {
  return [`${indent}自分: ${sideText(s, p, p).join(" ／ ")}`, `${indent}相手: ${sideText(s, other(p), p).join(" ／ ")}`];
}

const NUMERIC_KEYS = (Object.keys(SEARCH_WEIGHTS) as (keyof EvalWeights)[]).filter((k): k is NumericWeight => k !== "hold");

/** 評価の内訳: 重みを 1 つずつ 0 にしたときに下がる点数（0 でないもの）と、場のカード 1 枚を取り除いたときに下がる点数 */
function breakdown(s: GameState, p: PlayerIndex): string[] {
  const w = SEARCH_WEIGHTS;
  const total = evaluateWith(s, p, w);
  const terms: string[] = [];
  for (const k of NUMERIC_KEYS) {
    if (w[k] === 0 || k === "lethalRange" || k === "boostCap") continue;
    const d = total - evaluateWith(s, p, { ...w, [k]: 0 });
    if (Math.abs(d) > 1e-6) terms.push(`${k} ${round(d)}`);
  }
  const hold = total - evaluateWith(s, p, { ...w, hold: {} });
  if (Math.abs(hold) > 1e-6) terms.push(`hold ${round(hold)}`);
  const cards = (q: PlayerIndex) =>
    s.players[q].board.map((c) => {
      const t = structuredClone(s);
      t.players[q].board = t.players[q].board.filter((x) => x.iid !== c.iid);
      return `${cardOf(c.cardId).name} ${round(total - evaluateWith(t, p, w))}`;
    });
  return [`  点数 ${round(total)}: ${terms.join("、")}`, `  場の 1 枚ごと（自分）: ${cards(p).join("、") || "なし"}`, `  場の 1 枚ごと（相手）: ${cards(other(p)).join("、") || "なし"}`];
}

interface Trace {
  win: boolean | null;
  /** 相手の次のターンの後（自分の次のターンの開始時）の局面。その前に終わったら null */
  next: GameState | null;
  /** 相手の次のターンの手順 */
  oppSteps: string[];
  /** 自分の次のターンの手順 */
  mySteps: string[];
  /** 試合が終わったときの全体のターン番号 */
  endTurn: number;
}

/** human-plan-value の rollouts と同じシードで 1 回打ち、相手の次のターンを記録する */
function trace(after: GameState, subject: SubjectId, p: PlayerIndex, seed: number, r: number): Trace {
  try {
    if (after.phase === "ended") return { win: after.winner === p, next: null, oppSteps: [], mySteps: [], endTurn: after.turn };
    let state = determinize(after, p, rngFrom({ rng: mix(seed, 1000 + r) }));
    const agents = makeAgents(subject, p);
    const agentRng = rngFrom({ rng: (mix(seed, 2000 + r) ^ 0x9e3779b9) >>> 0 });
    const oppSteps: string[] = [];
    const mySteps: string[] = [];
    let next: GameState | null = null;
    let phase: "opp" | "mine" | "done" = "opp";
    for (let n = 0; state.phase !== "ended" && n < 10000; n++) {
      if (phase === "opp" && state.active === p && isStartOfTurn(state)) {
        next = state;
        phase = "mine";
      } else if (phase === "mine" && state.active !== p) phase = "done";
      const actor = actingPlayer(state);
      const a = agents[actor].chooseAction(state, legalActions(state), agentRng);
      if (phase === "opp") oppSteps.push(describeAction(state, a, p));
      else if (phase === "mine") mySteps.push(describeAction(state, a, p));
      state = applyAction(state, a);
    }
    return { win: state.phase === "ended" ? state.winner === p : null, next, oppSteps, mySteps, endTurn: state.turn };
  } catch {
    return { win: null, next: null, oppSteps: [], mySteps: [], endTurn: -1 };
  }
}

function traceSummary(ts: Trace[], p: PlayerIndex): string[] {
  const done = ts.filter((t) => t.win !== null);
  const wins = done.filter((t) => t.win).length;
  const nexts = ts.flatMap((t) => (t.next ? [t.next] : []));
  const avg = (f: (s: GameState) => number) => (nexts.length ? round(nexts.reduce((a, s) => a + f(s), 0) / nexts.length) : "-");
  const diedOnOpp = ts.filter((t) => t.next === null && t.win === false).length;
  const wonBefore = ts.filter((t) => t.next === null && t.win === true).length;
  const me = (s: GameState) => s.players[p];
  const op = (s: GameState) => s.players[other(p)];
  const followers = (s: GameState, q: PlayerIndex) => s.players[q].board.filter((c) => c.kind === "follower");
  return [
    `  勝率 ${wins}/${done.length}、相手の次のターンで負け ${diedOnOpp}、それより前に勝ち ${wonBefore}、終わった全体のターンの平均 ${round(done.reduce((a, t) => a + t.endTurn, 0) / Math.max(1, done.length))}`,
    `  相手の次のターンの後（平均）: 自分の体力 ${avg((s) => me(s).leaderHp)}・場のフォロワー ${avg((s) => followers(s, p).length)}（攻撃力計 ${avg((s) => followers(s, p).reduce((a, c) => a + (c.kind === "follower" ? c.attack : 0), 0))}）・手札 ${avg((s) => me(s).hand.length)}、` +
      `相手の体力 ${avg((s) => op(s).leaderHp)}・場のフォロワー ${avg((s) => followers(s, other(p)).length)}（攻撃力計 ${avg((s) => followers(s, other(p)).reduce((a, c) => a + (c.kind === "follower" ? c.attack : 0), 0))}）・手札 ${avg((s) => op(s).hand.length)}`,
  ];
}

export async function main(argv: string[]): Promise<number> {
  let key = "", turn = -1, M = 32, ncands = 6, show = 3, nres = 0;
  let opts: RhinoOptions = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) {
      files.push(k);
      continue;
    }
    const v = argv[++i] ?? "";
    if (k === "--key") key = v;
    else if (k === "--turn") turn = Number(v);
    else if (k === "--m") M = Number(v);
    else if (k === "--cands") ncands = Number(v);
    else if (k === "--show") show = Number(v);
    else if (k === "--rescored") nres = Number(v);
    else if (k === "--opts") {
      const raw = JSON.parse(v) as Record<string, unknown>;
      if (typeof raw.weights === "object" && raw.weights !== null) raw.weights = { ...SEARCH_WEIGHTS, ...raw.weights };
      opts = raw as RhinoOptions;
    }
    else throw new Error(`不明な引数: ${k}`);
  }
  const [subject, deck, g, seat] = key.split("/");
  let rec: HumanGameRecord | null = null;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseHumanRecord(JSON.parse(line));
      if (r && r.subject === subject && r.deck === deck && r.g === Number(g) && r.seat === Number(seat)) rec = r;
    }
  }
  if (!rec) throw new Error(`記録が見つかりません: ${key}`);
  if (turn < 1) throw new Error("--turn に自分のターン番号（1 以上）を指定してください");
  const p = rec.seat;
  const { decks, seed } = compareMatch(rec.subject, rec.deck, rec.g, rec.seat);
  let s = createGame({ decks, seed });
  let i = 0;
  let found = false;
  let lastTurn = -1;
  for (; i < rec.actions.length && s.phase !== "ended"; i++) {
    const a = rec.actions[i]!;
    const actor = actingPlayer(s);
    if (actor === p && s.active === p && isStartOfTurn(s) && s.players[p].turnCount !== lastTurn && a.type !== "mulligan") {
      lastTurn = s.players[p].turnCount;
      if (lastTurn === turn) {
        found = true;
        break;
      }
    }
    s = applyAction(s, a);
  }
  if (!found) throw new Error(`自分の ${turn} ターン目が見つかりません`);
  const start = s;
  const posSeed = mix(seed, 100 + turn);
  const L: string[] = [];
  L.push(`# ${key} 自分の ${turn} ターン目（${rec.won ? "人間の勝ち" : "人間の負け"}、${start.first === p ? "先攻" : "後攻"}、全体の ${start.turn} ターン目）`, "");
  L.push("開始時:", ...stateText(start, p), "");

  // 人間の手順
  const humanSteps: string[] = [];
  let h = start;
  for (let j = i; j < rec.actions.length; j++) {
    const b = rec.actions[j]!;
    if (actingPlayer(h) === p && b.type === "endTurn") break;
    humanSteps.push(describeAction(h, b, p).replace(/^あなた: /, ""));
    h = applyAction(h, b);
    if (h.phase === "ended") break;
  }
  // AI の手順（human-plan-value の aiTurn と同じ）
  const agents = makeAgents(rec.subject, p, opts);
  const rng = rngFrom({ rng: mix(posSeed, 1) });
  const aiSteps: string[] = [];
  let t = start;
  for (let guard = 0; guard < 500 && t.phase !== "ended"; guard++) {
    const actor = actingPlayer(t);
    const a = agents[actor].chooseAction(t, legalActions(t), rng);
    if (actor === p && a.type === "endTurn") break;
    aiSteps.push(describeAction(t, a, p).replace(/^あなた: /, ""));
    t = applyAction(t, a);
  }

  const sides: [string, GameState, string[]][] = [
    ["人間", h, humanSteps],
    ["AI", t, aiSteps],
  ];
  for (const [name, end, steps] of sides) {
    L.push(`## ${name}: ${steps.join(" → ") || "何もしない"}`, "");
    if (end.phase === "ended") L.push(`  試合が終わった（${end.winner === p ? "勝ち" : "負け"}）`, "");
    else L.push("ターン末:", ...stateText(endState(end, p), p), ...breakdown(endState(end, p), p), "");
  }

  if (ncands > 0) {
    const cands = turnCandidates(start, p, rngFrom({ rng: mix(posSeed, 3) }));
    L.push(`## AI の候補（最初の手ごとの最善の並び、${cands.length} 個のうち上位 ${Math.min(ncands, cands.length)}）`, "");
    for (const c of cands.slice(0, ncands)) {
      let x = start;
      const st: string[] = [];
      for (const a of c.actions) {
        st.push(describeAction(x, a, p).replace(/^あなた: /, ""));
        x = applyAction(x, a);
      }
      L.push(`- ${round(c.value)}: ${st.join(" → ")}`);
    }
    L.push("");
  }

  if (nres > 0) {
    // 探索 AI が手を選ぶときと同じく、決定化 3 回それぞれで上位の手を相手のターンまで読み直した点数（--opts の設定で。乱数は AI の手順と別）
    const r2 = rngFrom({ rng: mix(posSeed, 4) });
    for (let k = 0; k < 3; k++) {
      const det = determinize(start, p, r2);
      L.push(`## 読み直した候補（決定化 ${k + 1}、相手の手札: ${det.players[other(p)].hand.map((h) => cardOf(h.cardId).name).join("・")}）`, "");
      for (const c of rescoredCandidates(det, p, r2, opts).slice(0, nres)) {
        let x = det;
        const st: string[] = [];
        for (const a of c.actions) {
          st.push(describeAction(x, a, p).replace(/^あなた: /, ""));
          x = applyAction(x, a);
        }
        L.push(`- ${round(c.value)}: ${st.join(" → ")}`);
      }
      L.push("");
    }
  }

  if (M > 0) {
    const traces = sides.map(([, end]) => {
      const after = end.phase === "ended" ? end : applyAction(end, { type: "endTurn" } as Action);
      return Array.from({ length: M }, (_, r) => trace(after, rec!.subject, p, posSeed, r));
    });
    L.push(`## 続き（同じ ${M} 個のシード）`, "");
    sides.forEach(([name], k) => L.push(`${name}:`, ...traceSummary(traces[k]!, p)));
    L.push("");
    const split = Array.from({ length: M }, (_, r) => r).filter((r) => traces[0]![r]!.win !== traces[1]![r]!.win);
    L.push(`結果が分かれたシード ${split.length}（人間だけ勝ち ${split.filter((r) => traces[0]![r]!.win).length}・AI だけ勝ち ${split.filter((r) => traces[1]![r]!.win).length}）。最初の ${Math.min(show, split.length)} 個:`, "");
    for (const r of split.slice(0, show)) {
      L.push(`### シード ${r}`);
      sides.forEach(([name], k) => {
        const tr = traces[k]![r]!;
        L.push(`- ${name}（${tr.win ? "勝ち" : "負け"}、全体の ${tr.endTurn} ターン目に終了）相手の次のターン: ${tr.oppSteps.join(" → ") || "-"}`);
        if (tr.next) L.push(...stateText(tr.next, p, "    "));
        L.push(`  自分の次のターン: ${tr.mySteps.map((x) => x.replace(/^あなた: /, "")).join(" → ") || "-"}`);
      });
      L.push("");
    }
  }
  console.log(L.join("\n"));
  return 0;
}
