// 相手のリーサルを防げた負け試合の数え上げ（npm run lethal-prevent）。
//
// 探索 AI どうしで試合をし（デッキの組・席・シードは npm run compare と同じ）、負けた側について、
// 相手にとどめを刺される直前の自分のターン（最後の自分のターン）を調べる:
// 1. そのターンの手の並びを、同じ局面をまとめて全て調べる（局面が多すぎたら幅の広いビームサーチ）
// 2. ターンを終えた各局面から相手のターンを始め、相手に倒しきる手順があるかを全探索（exactLethal.ts）で調べる
// 3. 相手に倒しきる手順が無い終わり方が 1 つでもあれば「防げた」
// 局面は実際のもの（相手の手札・山札の順番・乱数の状態を知っている）を使う。防いでもその後に勝てたとは限らない。
//
// 使い方: npm run lethal-prevent -- <組の数> [最初の試合番号] [--out <file.jsonl>]
// 1 組で席とデッキを入れ替えた 2 試合。試合は CPU のコア数だけ並列に行う（THREADS で変えられる）。

import { appendFileSync } from "node:fs";
import { SEARCH_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { resetExactLethalCache, searchExactLethal } from "../src/ai/exactLethal";
import { KeySet, turnOrderHash, turnOrderKey } from "../src/ai/keySet";
import { searchAgent } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { legalActions, resolveTurnEnd, tryApplyAction, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { playMatch } from "../src/sim/match";
import { replayStates } from "../src/sim/replay";
import { parallelMap } from "./parallel";

const EXCLUDED_DECKS = ["ランプドラゴン"];
/** 自分のターンの全探索で調べる局面の上限（超えたらビームサーチ） */
const MAX_TURN_STATES = 30_000;
const BEAM_WIDTH = 512;
const BEAM_DEPTH = 12;
/** 相手のリーサルの全探索の 1 回の上限 */
const LETHAL_STATES = 200_000;

const actorOf = (s: GameState) => (s.pending ? s.pending.player : s.active);

function tryApply(s: GameState, a: Action): GameState | null {
  try {
    return tryApplyAction(s, a);
  } catch {
    return null;
  }
}

/** p のターンを終えられる局面（自分の手番で選択待ちでないもの、または試合が終わったもの）。全探索、多すぎればビームサーチ */
function turnEnds(root: GameState, p: PlayerIndex): { ends: GameState[]; exhaustive: boolean } {
  const isEnd = (s: GameState) => s.phase === "ended" || (actorOf(s) === p && !s.pending && s.stack.length === 0 && s.queue.length === 0);
  const children = (s: GameState) =>
    s.phase === "ended" || actorOf(s) !== p ? [] : legalActions(s).flatMap((a) => (a.type === "endTurn" ? [] : [tryApply(s, a)].filter((x): x is GameState => x !== null)));
  // 全探索
  const seen = new KeySet();
  const ends: GameState[] = [];
  const stack = [root];
  let count = 0;
  let overflow = false;
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (!seen.addLazy(() => turnOrderKey(s), turnOrderHash(s))) continue;
    if (++count > MAX_TURN_STATES) {
      overflow = true;
      break;
    }
    if (isEnd(s)) ends.push(s);
    stack.push(...children(s));
  }
  if (!overflow) return { ends, exhaustive: true };
  // ビームサーチ（評価関数の高い順に残す）
  const score = (s: GameState) => (s.phase === "ended" ? (s.winner === p ? 1e9 : -1e9) : evaluateWith(s, p, SEARCH_WEIGHTS));
  const seen2 = new KeySet();
  const out: GameState[] = [];
  let frontier = [root];
  for (let d = 0; d <= BEAM_DEPTH && frontier.length > 0; d++) {
    const next: { s: GameState; v: number }[] = [];
    for (const s of frontier) {
      if (isEnd(s)) out.push(s);
      for (const c of children(s)) if (seen2.addLazy(() => turnOrderKey(c), turnOrderHash(c))) next.push({ s: c, v: score(c) });
    }
    next.sort((x, y) => y.v - x.v);
    frontier = next.slice(0, BEAM_WIDTH).map((x) => x.s);
  }
  return { ends: out, exhaustive: false };
}

type LethalResult = "lethal" | "none" | "unknown";

/** p がターンを終えた局面 end から相手のターンを始め、相手に倒しきる手順があるか */
function opponentLethal(end: GameState, p: PlayerIndex): LethalResult {
  const opp: PlayerIndex = p === 0 ? 1 : 0;
  const next = tryApply(end, { type: "endTurn" });
  if (!next) return "unknown";
  if (next.phase === "ended") return next.winner === opp ? "lethal" : "none";
  if (actorOf(next) !== opp) return "unknown";
  const stats = { visited: 0, memo: 0 };
  const seq = searchExactLethal(next, opp, { maxStates: LETHAL_STATES, maxStatesPerTurn: Number.MAX_SAFE_INTEGER, stats });
  if (seq) return "lethal";
  return stats.visited > LETHAL_STATES ? "unknown" : "none";
}

export interface PreventRecord {
  g: number;
  swap: boolean;
  seed: number;
  decks: [string, string];
  winner: PlayerIndex;
  turns: number;
  /** 負けた側の最後のターンの記録（負けた側の席ごとではなく、負けた側 1 人分） */
  loser: PlayerIndex;
  /** とどめを刺されたのが相手のターンか（自分のターン中・ターン終了時に負けたなら false） */
  killedOnOppTurn: boolean;
  /** 負けた側の最後のターン（自分のターン数） */
  loserTurn: number;
  /** そのターンの手の並びを全て調べたか（false ならビームサーチ） */
  exhaustive: boolean;
  /** 調べたターン終了の局面の数 */
  ends: number;
  /** 自分がそのターンに勝てた（リーサルを逃していた） */
  hadOwnLethal: boolean;
  /** 実際の終わり方で、相手に倒しきる手順が見つかったか（確認用） */
  actual: LethalResult;
  /** 相手に倒しきる手順が無い終わり方の数・判定できなかった数 */
  safe: number;
  unknown: number;
  /** 防げる終わり方のうち評価関数が最も高いものの、全体の最善からの差と順位（1 始まり） */
  safeEvalGap: number | null;
  safeRank: number | null;
  /** 実際の終わり方の、全体の最善からの評価の差 */
  actualEvalGap: number;
  ms: number;
}

function analyze(g: number, swap: boolean, decks: readonly { name: string; cards: readonly string[] }[]): PreventRecord {
  const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
  const [da, db] = swap ? [decks[j]!, decks[i]!] : [decks[i]!, decks[j]!];
  const aSeat = (g + (swap ? 1 : 0)) % 2;
  const pair: [{ name: string; cards: readonly string[] }, { name: string; cards: readonly string[] }] = aSeat === 0 ? [da, db] : [db, da];
  const seed = g * 7 + (swap ? 1 : 2);
  const t0 = Date.now();
  resetExactLethalCache();
  const r = playMatch([searchAgent, searchAgent], { decks: [pair[0].cards, pair[1].cards], seed, record: true });
  const states = replayStates([pair[0].cards, pair[1].cards], seed, r.log!);
  const loser: PlayerIndex = r.winner === 0 ? 1 : 0;
  // 負けた側が最後に行動した局面と、そのターンの最初の局面（行動する直前）
  let last = -1;
  for (let k = states.length - 2; k >= 0; k--) {
    if (actorOf(states[k]!) === loser && states[k]!.phase === "main" && states[k]!.active === loser) {
      last = k;
      break;
    }
  }
  if (last < 0) throw new Error(`負けた側の行動がありません (seed ${seed})`);
  let start = last;
  while (start > 0 && states[start - 1]!.active === loser && states[start - 1]!.phase === "main") start--;
  // 勝った側のターン中に試合が終わったか
  const killedOnOppTurn = r.final.active === r.winner;
  const root = states[start]!;
  const actualEnd = states[last]!; // 最後の行動（ターン終了のはず）の前の局面
  const lastAction = r.log![last]!;

  const { ends, exhaustive } = turnEnds(root, loser);
  const value = (s: GameState) => (s.phase === "ended" ? (s.winner === loser ? 1e9 : -1e9) : evaluateWith(resolveTurnEnd(s), loser, SEARCH_WEIGHTS));
  const scored = ends.map((s) => ({ s, v: value(s) })).sort((x, y) => y.v - x.v);
  const best = scored[0]?.v ?? 0;
  const hadOwnLethal = ends.some((s) => s.phase === "ended" && s.winner === loser);
  let safe = 0, unknown = 0;
  let safeEvalGap: number | null = null, safeRank: number | null = null;
  if (killedOnOppTurn && !hadOwnLethal) {
    for (const [k, { s, v }] of scored.entries()) {
      if (s.phase === "ended") continue;
      const res = opponentLethal(s, loser);
      if (res === "none") {
        safe++;
        if (safeRank === null) {
          safeRank = k + 1;
          safeEvalGap = best - v;
        }
      } else if (res === "unknown") unknown++;
    }
  }
  const actual = lastAction.type === "endTurn" ? opponentLethal(actualEnd, loser) : "unknown";
  return {
    g, swap, seed,
    decks: [pair[0].name, pair[1].name],
    winner: r.winner,
    turns: r.turns,
    loser,
    killedOnOppTurn,
    loserTurn: root.players[loser].turnCount,
    exhaustive,
    ends: ends.length,
    hadOwnLethal,
    actual,
    safe,
    unknown,
    safeEvalGap,
    safeRank,
    actualEvalGap: lastAction.type === "endTurn" ? best - value(actualEnd) : NaN,
    ms: Date.now() - t0,
  };
}

export async function main(argv: string[]): Promise<number> {
  let out: string | null = null;
  const pos: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--out") out = argv[++k] ?? null;
    else pos.push(argv[k]!);
  }
  const games = Number(pos[0] ?? 7);
  const startG = Number(pos[1] ?? 0);
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  if (decks.length !== 7) throw new Error("比較用のデッキは 7 つの想定です");
  const tasks = Array.from({ length: games }, (_, k) => [false, true].map((swap) => ({ g: startG + k, swap }))).flat();
  const t0 = Date.now();
  const results = await parallelMap(
    tasks,
    ({ g, swap }) => analyze(g, swap, decks),
    (done, total) => {
      if (done % 20 === 0 || done === total) console.log(`${done}/${total}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    },
  );
  if (out) for (const rec of results) appendFileSync(out, JSON.stringify(rec) + "\n");
  summarize(results);
  return 0;
}

function summarize(rs: PreventRecord[]): void {
  const n = rs.length;
  const opp = rs.filter((r) => r.killedOnOppTurn);
  const own = opp.filter((r) => r.hadOwnLethal);
  const judged = opp.filter((r) => !r.hadOwnLethal);
  const safe = judged.filter((r) => r.safe > 0);
  const allUnknown = judged.filter((r) => r.safe === 0 && r.unknown > 0);
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`試合 ${n}（負けた側を 1 試合 1 人ずつ調べる）`);
  console.log(`相手のターンにとどめ: ${opp.length}、うち前のターンに自分のリーサルがあった: ${own.length}`);
  console.log(`防げる終わり方があった: ${safe.length}/${judged.length} = ${pct(safe.length, judged.length)}（判定できない終わり方だけ: ${allUnknown.length}）`);
  console.log(`全探索できたターン: ${judged.filter((r) => r.exhaustive).length}/${judged.length}、実際の終わり方で相手のリーサルを確認: ${judged.filter((r) => r.actual === "lethal").length}`);
  const gaps = safe.map((r) => r.safeEvalGap!).sort((a, b) => a - b);
  if (gaps.length) console.log(`防げる最善の終わり方の評価の差（最善との差）: 中央値 ${gaps[gaps.length >> 1]!.toFixed(1)}、最初の 1/4 ${gaps[gaps.length >> 2]!.toFixed(1)}、3/4 ${gaps[(gaps.length * 3) >> 2]!.toFixed(1)}`);
}
