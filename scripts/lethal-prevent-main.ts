// 相手のリーサルを防げた負け試合の数え上げ（npm run lethal-prevent）。
//
// 探索 AI どうしで試合をし（デッキの組・席・シードは npm run compare と同じ）、負けた側について、
// 相手にとどめを刺される直前の自分のターン（最後の自分のターン）を調べる:
// 1. そのターンの手の並びを、同じ局面をまとめて全て調べる（局面が多すぎたら幅の広いビームサーチ）
// 2. ターンを終えた各局面から相手のターンを始め、相手に倒しきる手順があるかを全探索（exactLethal.ts）で調べる
// 3. 相手に倒しきる手順が無い終わり方が 1 つでもあれば「防げた」
// 局面は実際のもの（相手の手札・山札の順番・乱数の状態を知っている）を使う。防いでもその後に勝てたとは限らない。
//
// 使い方: npm run lethal-prevent -- <組の数> [最初の試合番号] [--out <file.jsonl>] [--continue <回数>]
// --continue を付けると、防げる終わり方からその回数だけ試合を続けて、逆転できたかを数える
// 1 組で席とデッキを入れ替えた 2 試合。試合は CPU のコア数だけ並列に行う（THREADS で変えられる）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SEARCH_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { resetExactLethalCache, searchExactLethal } from "../src/ai/exactLethal";
import { KeySet, turnOrderHash, turnOrderKey } from "../src/ai/keySet";
import { createSearchAgent, searchAgent } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, legalActions, resolveTurnEnd, rngFrom, shuffle, tryApplyAction, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { playMatch } from "../src/sim/match";
import { replayStates } from "../src/sim/replay";
import { parallelMap } from "./parallel";

const EXCLUDED_DECKS = ["ランプドラゴン"];
/** 自分のターンの全探索で調べる局面の上限（超えたらビームサーチ） */
const MAX_TURN_STATES = 30_000;
const BEAM_WIDTH = 512;
const BEAM_DEPTH = 12;
/** 相手のリーサルの全探索の 1 回の上限 */
const LETHAL_STATES = 50_000;
/** 1 試合で相手のリーサルを調べる時間の上限（ミリ秒。超えたら残りの終わり方は調べない） */
const CHECK_BUDGET_MS = 60_000;

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
  if (stats.visited > LETHAL_STATES) return "unknown";
  // exactLethal はターン終了を試さないので、ターン終了時の能力（ララミア等）で倒しきる手順も調べる
  return winsByTurnEnd(next, opp);
}

/** q のターンの手の並び（ターン終了まで）で q が勝つものがあるか。ターン終了時の処理も含める */
function winsByTurnEnd(root: GameState, q: PlayerIndex): LethalResult {
  const other: PlayerIndex = q === 0 ? 1 : 0;
  const seen = new KeySet();
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (s.phase === "ended") {
      if (s.winner === q) return "lethal";
      continue;
    }
    if (actorOf(s) !== q && s.active !== q) continue;
    if (!seen.addLazy(() => [s.players[other].leaderHp, turnOrderKey(s)], turnOrderHash(s) ^ s.players[other].leaderHp)) continue;
    if (++count > LETHAL_STATES) return "unknown";
    if (actorOf(s) !== q) continue;
    for (const a of legalActions(s)) {
      const next = tryApply(s, a);
      if (!next) continue;
      if (a.type === "endTurn") {
        if (next.phase === "ended" && next.winner === q) return "lethal";
        continue;
      }
      stack.push(next);
    }
  }
  return "none";
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
  /** 相手に倒しきる手順が無い終わり方が見つかったか（1 つ見つけたら止める。0 か 1）・判定できなかった数・時間切れで調べなかった数 */
  safe: number;
  unknown: number;
  unchecked: number;
  /** 防げる終わり方のうち評価関数が最も高いものの、全体の最善からの差と順位（1 始まり） */
  safeEvalGap: number | null;
  safeRank: number | null;
  /** 防げる終わり方からターンを終えて試合を続けたとき、負けた側が勝ったか（続けた回数分。山札の順番と乱数を回ごとに変える） */
  comebacks: boolean[];
  /** 実際の終わり方の、全体の最善からの評価の差 */
  actualEvalGap: number;
  ms: number;
}

/**
 * p がターンを終えた局面 end から、探索 AI どうしで試合を最後まで続けて勝者を返す。
 * 先のドローは分からないので、両者の山札の順番を seed で並べ直す。ただし相手の次のドロー（山札の一番上）と局面の乱数の状態は
 * そのままにする（防げるかはそのドローと乱数で調べたため）。回ごとの違いは山札の残りの順番と AI の乱数
 */
function continueGame(end: GameState, p: PlayerIndex, seed: number): PlayerIndex {
  const rng = rngFrom({ rng: seed });
  const opp: PlayerIndex = p === 0 ? 1 : 0;
  const players = end.players.map((pl, i) => {
    const keep = i === opp ? 1 : 0;
    const rest = pl.deck.slice(keep);
    shuffle(rest, rng);
    return { ...pl, deck: [...pl.deck.slice(0, keep), ...rest] };
  }) as unknown as GameState["players"];
  let state: GameState = { ...end, players };
  state = applyAction(state, { type: "endTurn" });
  const agents = [createSearchAgent(), createSearchAgent()];
  const agentRng = rngFrom({ rng: (seed ^ 0x9e3779b9) >>> 0 });
  for (let n = 0; state.phase !== "ended"; n++) {
    if (n > 10000) throw new Error(`続きの試合が終わりません (seed ${seed})`);
    const legal = legalActions(state);
    state = applyAction(state, agents[actingPlayer(state)]!.chooseAction(state, legal, agentRng));
  }
  if (state.winner === null) throw new Error("勝者がいません");
  resetExactLethalCache();
  return state.winner;
}

function analyze(g: number, swap: boolean, decks: readonly { name: string; cards: readonly string[] }[], continuations: number): PreventRecord {
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
  let safe = 0, unknown = 0, unchecked = 0;
  let safeEnd: GameState | null = null;
  let safeEvalGap: number | null = null, safeRank: number | null = null;
  if (killedOnOppTurn && !hadOwnLethal) {
    // 評価の高い順に調べ、防げる終わり方が 1 つ見つかったら止める
    const tc = Date.now();
    for (const [k, { s, v }] of scored.entries()) {
      if (s.phase === "ended") continue;
      if (Date.now() - tc > CHECK_BUDGET_MS) {
        unchecked = scored.length - k;
        break;
      }
      const res = opponentLethal(s, loser);
      if (res === "none") {
        safe++;
        safeRank = k + 1;
        safeEvalGap = best - v;
        safeEnd = s;
        break;
      } else if (res === "unknown") unknown++;
    }
  }
  const actual = lastAction.type === "endTurn" ? opponentLethal(actualEnd, loser) : "unknown";
  const comebacks = safeEnd ? Array.from({ length: continuations }, (_, c) => continueGame(safeEnd!, loser, (seed * 31 + c + 1) >>> 0) === loser) : [];
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
    unchecked,
    safeEvalGap,
    safeRank,
    comebacks,
    actualEvalGap: lastAction.type === "endTurn" ? best - value(actualEnd) : NaN,
    ms: Date.now() - t0,
  };
}

export async function main(argv: string[]): Promise<number> {
  let out: string | null = null;
  let continuations = 0;
  const pos: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--out") out = argv[++k] ?? null;
    else if (argv[k] === "--continue") continuations = Number(argv[++k] ?? 0);
    else pos.push(argv[k]!);
  }
  const games = Number(pos[0] ?? 7);
  const startG = Number(pos[1] ?? 0);
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  if (decks.length !== 7) throw new Error("比較用のデッキは 7 つの想定です");
  const done = new Map<string, PreventRecord>();
  if (out && existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line) as PreventRecord;
      done.set(`${rec.g}/${rec.swap}`, rec);
    }
  }
  const tasks = Array.from({ length: games }, (_, k) => [false, true].map((swap) => ({ g: startG + k, swap }))).flat();
  const t0 = Date.now();
  // 終わった試合はすぐに出力ファイルに追記する（途中で止めても使える。既にある試合は飛ばす）
  const results = await parallelMap(
    tasks,
    ({ g, swap }) => {
      const prev = done.get(`${g}/${swap}`);
      if (prev) return prev;
      const rec = analyze(g, swap, decks, continuations);
      if (out) appendFileSync(out, JSON.stringify(rec) + "\n");
      return rec;
    },
    (done, total) => {
      if (done % 20 === 0 || done === total) console.log(`${done}/${total}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    },
  );
  summarize(results);
  return 0;
}

function summarize(rs: PreventRecord[]): void {
  const n = rs.length;
  const opp = rs.filter((r) => r.killedOnOppTurn);
  const own = opp.filter((r) => r.hadOwnLethal);
  const judged = opp.filter((r) => !r.hadOwnLethal);
  const safe = judged.filter((r) => r.safe > 0);
  const allUnknown = judged.filter((r) => r.safe === 0 && (r.unknown > 0 || r.unchecked > 0));
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`試合 ${n}（負けた側を 1 試合 1 人ずつ調べる）`);
  console.log(`相手のターンにとどめ: ${opp.length}、うち前のターンに自分のリーサルがあった: ${own.length}`);
  console.log(`防げる終わり方があった: ${safe.length}/${judged.length} = ${pct(safe.length, judged.length)}（見つからず、判定できないか時間切れの終わり方が残った: ${allUnknown.length}）`);
  console.log(`全探索できたターン: ${judged.filter((r) => r.exhaustive).length}/${judged.length}、実際の終わり方で相手のリーサルを確認: ${judged.filter((r) => r.actual === "lethal").length}`);
  const tried = safe.filter((r) => r.comebacks.length > 0);
  if (tried.length) {
    const rate = tried.reduce((a, r) => a + r.comebacks.filter(Boolean).length / r.comebacks.length, 0);
    console.log(`防いで続けた ${tried.length} 試合の、負けた側の勝ちの期待値: ${rate.toFixed(1)} 試合（${pct(rate, tried.length)}）。全試合の ${pct(rate, n)}`);
  }
  const gaps = safe.map((r) => r.safeEvalGap!).sort((a, b) => a - b);
  if (gaps.length) console.log(`防げる最善の終わり方の評価の差（最善との差）: 中央値 ${gaps[gaps.length >> 1]!.toFixed(1)}、最初の 1/4 ${gaps[gaps.length >> 2]!.toFixed(1)}、3/4 ${gaps[(gaps.length * 3) >> 2]!.toFixed(1)}`);
}
