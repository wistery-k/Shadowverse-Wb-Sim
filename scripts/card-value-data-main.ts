// カード 1 枚の価値を介入で測るためのデータ取り（npm run card-value-data）。
//
// 探索 AI どうし（エルフはリノセウス用 AI）の対戦の途中で、各プレイヤーの自分のターンの最初の局面を 1 つずつ取り出し、
// そのままの局面と、次のように 1 か所だけ変えた局面を、同じシード（同じ山札の順・同じ乱数）で最後まで打たせる。
//   - hand: 手札からカード 1 枚を抜く（同じカードは 1 回だけ）
//   - board: 自分の場からカード 1 枚を抜く（同じカードは 1 回だけ）
//   - hp: 自分のリーダーの体力を 3 減らす（換算用）
// 勝敗の差（そのまま − 変えた局面）が、その局面でそれを持っていることの勝率上の価値になる。
// 評価関数の点数の差（探索 AI の重み）も記録し、card-value-fit で比べる。
// 1 局面 1 行の JSON を出力ファイルに追記する。途中で止めても、書き終えた局面はそのまま使える。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SEARCH_WEIGHTS, evaluateWith, type EvalWeights } from "../src/ai/evaluate";
import { createRhinoAgent } from "../src/ai/rhino";
import { createSearchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import {
  actingPlayer,
  applyAction,
  cloneState,
  createGame,
  invariantViolations,
  legalActions,
  nextRandom,
  rngFrom,
  type GameState,
  type PlayerIndex,
} from "../src/engine";
import { playFrom } from "../src/sim/match";

export type VariantKind = "hand" | "board" | "hp";

export interface CardValueVariant {
  kind: VariantKind;
  /** hand・board は抜いたカードのID。hp は空文字 */
  cardId: string;
  /** その局面のプレイヤーが勝ったか（エラーで最後まで打てなかったら null） */
  win: boolean | null;
  /** 評価関数の点数の差（そのまま − 変えた局面、プレイヤーから見て） */
  evalDelta: number;
}

/** 1 局面の記録 */
export interface CardValueRecord {
  /** 対戦のシード */
  seed: number;
  /** 取り出した局面のプレイヤー */
  p: PlayerIndex;
  /** 席ごとのデッキ名 */
  decks: [string, string];
  first: PlayerIndex;
  /** 自分のターンの何回目か / 全体のターン番号 */
  ownTurn: number;
  turn: number;
  /** その局面の自分の手札・場のカードID、体力・PP 最大値 */
  hand: string[];
  board: string[];
  hp: number;
  oppHp: number;
  maxPp: number;
  /** そのままの局面から打った結果 */
  baseWin: boolean | null;
  variants: CardValueVariant[];
}

/** 比較に使うデッキ（npm run compare と同じ 7 つ） */
const EXCLUDED_DECKS = ["ランプドラゴン"];

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

const isStartOfTurn = (s: GameState) => s.phase === "main" && !s.pending && s.stack.length === 0 && s.queue.length === 0;

/** 続きを打つたびに作り直す（探索 AI が覚えているリーサルの手順を、別の続きに持ち越さないため） */
function makeAgents(decks: [string, string], weights: EvalWeights): [Agent, Agent] {
  return decks.map((d) => (d === "リノセウスエルフ" ? createRhinoAgent({ weights }) : createSearchAgent({ weights }))) as [Agent, Agent];
}

function variantsOf(s: GameState, p: PlayerIndex): { kind: VariantKind; cardId: string; state: GameState }[] {
  const out: { kind: VariantKind; cardId: string; state: GameState }[] = [];
  const me = s.players[p];
  const seen = new Set<string>();
  me.hand.forEach((h, i) => {
    if (seen.has(h.cardId)) return;
    seen.add(h.cardId);
    const v = cloneState(s);
    v.players[p].hand.splice(i, 1);
    out.push({ kind: "hand", cardId: h.cardId, state: v });
  });
  seen.clear();
  me.board.forEach((c, i) => {
    if (seen.has(c.cardId)) return;
    seen.add(c.cardId);
    const v = cloneState(s);
    v.players[p].board.splice(i, 1);
    out.push({ kind: "board", cardId: c.cardId, state: v });
  });
  if (me.leaderHp > 3) {
    const v = cloneState(s);
    v.players[p].leaderHp -= 3;
    out.push({ kind: "hp", cardId: "", state: v });
  }
  return out;
}

/**
 * npm run card-value-data -- --games <n> --seed <s> --shard <i>/<k> --out <file.jsonl> [--turns 2-8] [--maxpp0] [--focus <デッキ名>]
 * 試合番号 g（0 ≦ g < n）のうち g % k === i のものを行う。1 試合から最大 2 局面（両プレイヤー 1 つずつ）。
 * --focus は片方の席をそのデッキ（ミラーを除く）にし、そのデッキの局面だけを取る。
 * 出力ファイルに既にある seed は飛ばす（再開用）。--maxpp0 は評価関数の PP 最大値の重みを 0 にする（竜の啓示で方法を確かめる用）
 */
export async function main(argv: string[]): Promise<number> {
  let games = 10, seed = 1, shard = [0, 1], out = "card-value-data.jsonl", turns = [2, 8], weights: EvalWeights = SEARCH_WEIGHTS, focus = "";
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--maxpp0") {
      weights = { ...SEARCH_WEIGHTS, maxPp: 0 };
      continue;
    }
    i++;
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--shard") shard = v.split("/").map(Number);
    else if (k === "--out") out = v;
    else if (k === "--turns") turns = v.split("-").map(Number);
    else if (k === "--focus") focus = v;
    else throw new Error(`不明な引数: ${k}`);
  }
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name) || d.name === focus);
  const focusIndex = decks.findIndex((d) => d.name === focus);
  if (focus && focusIndex < 0) throw new Error(`デッキが見つかりません: ${focus}`);
  const done = new Set<number>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) if (line) done.add((JSON.parse(line) as CardValueRecord).seed);
  }
  const t0 = Date.now();
  let positions = 0, plays = 0;
  for (let g = 0; g < games; g++) {
    if (g % shard[1]! !== shard[0]) continue;
    const gameSeed = mix(seed, g);
    if (done.has(gameSeed)) continue;
    // デッキの組（ミラーを除く）と、各プレイヤーの局面を取り出すターンをシードから決める
    const [r1, s1] = nextRandom(gameSeed);
    const [r2, s2] = nextRandom(s1);
    const [r3, s3] = nextRandom(s2);
    const [r4] = nextRandom(s3);
    let i = Math.floor(r1 * decks.length);
    let j = (i + 1 + Math.floor(r2 * (decks.length - 1))) % decks.length;
    if (focusIndex >= 0) {
      // 相手はフォーカス以外から選び、席はシードで入れ替える
      const others = decks.filter((_, k) => k !== focusIndex && !EXCLUDED_DECKS.includes(decks[k]!.name));
      const opp = decks.indexOf(others[Math.floor(r2 * others.length)]!);
      [i, j] = r1 < 0.5 ? [focusIndex, opp] : [opp, focusIndex];
    }
    const pair = [decks[i]!, decks[j]!];
    const names: [string, string] = [pair[0]!.name, pair[1]!.name];
    const span = turns[1]! - turns[0]! + 1;
    const target = [turns[0]! + Math.floor(r3 * span), turns[0]! + Math.floor(r4 * span)];

    // 本線の対戦を進め、目標のターンの最初の局面を取り出す
    const snaps: (GameState | null)[] = [null, null];
    let state = createGame({ decks: [pair[0]!.cards, pair[1]!.cards], seed: gameSeed });
    const agents = makeAgents(names, weights);
    const agentRng = rngFrom({ rng: (gameSeed ^ 0x9e3779b9) >>> 0 });
    let actions = 0;
    const wanted = ([0, 1] as const).filter((p) => focusIndex < 0 || names[p] === focus);
    while (state.phase !== "ended" && wanted.some((p) => snaps[p] === null)) {
      if (++actions > 10000) throw new Error(`アクション数が上限を超えました (seed ${gameSeed})`);
      const actor = actingPlayer(state);
      if (snaps[actor] === null && isStartOfTurn(state) && state.active === actor && state.players[actor].turnCount === target[actor]) {
        snaps[actor] = cloneState(state);
      }
      state = applyAction(state, agents[actor].chooseAction(state, legalActions(state), agentRng));
    }

    for (const p of [0, 1] as const) {
      const snap = snaps[p];
      if (!snap || !wanted.includes(p)) continue;
      const contSeed = mix(gameSeed, 200 + p);
      const run = (s: GameState): boolean | null => {
        plays++;
        try {
          if (invariantViolations(s).length > 0) return null;
          return playFrom(makeAgents(names, weights), s, { seed: contSeed }).winner === p;
        } catch {
          return null;
        }
      };
      const base = evaluateWith(snap, p, weights);
      const me = snap.players[p];
      const rec: CardValueRecord = {
        seed: gameSeed,
        p,
        decks: names,
        first: snap.first,
        ownTurn: me.turnCount,
        turn: snap.turn,
        hand: me.hand.map((h) => h.cardId),
        board: me.board.map((c) => c.cardId),
        hp: me.leaderHp,
        oppHp: snap.players[p === 0 ? 1 : 0].leaderHp,
        maxPp: me.maxPp,
        baseWin: run(snap),
        variants: variantsOf(snap, p).map((v) => ({
          kind: v.kind,
          cardId: v.cardId,
          win: run(v.state),
          evalDelta: Math.round((base - evaluateWith(v.state, p, weights)) * 100) / 100,
        })),
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
