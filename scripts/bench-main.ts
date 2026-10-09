// 探索 AI の速さの計測（npm run bench）
//
// 1. 「リノセウス用ルール＋探索」どうしで seed 319922105（アミュレット疾走ビショップ vs リノセウスエルフ）を 1 試合打ち、
//    ターンごとの思考時間を出す。行動の列のハッシュも出すので、変更の前後で AI の手が変わらないことを確かめられる
//    また、エルフの 4 ターン目（全体の 8 ターン目）の開始局面から、このターンに到達できる局面をすべて列挙し、
//    同じ局面の判定を JSON 文字列で行う場合と KeySet で行う場合の時間を比べる
// 2. 探索 AI どうしの試合（npm run compare と同じ組み合わせ）を数試合打ち、1 試合の時間と行動の列のハッシュを出す
// 使い方: npm run bench -- [探索AIどうしの試合数（既定 14）]

import { determinize } from "../src/ai/determinize";
import { KeySet, stateHash } from "../src/ai/keySet";
import { rhinoAgent } from "../src/ai/rhino";
import { searchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, createGame, legalActions, rngFrom, type Action, type GameState, type PlayerIndex } from "../src/engine";

const EXCLUDED_DECKS = ["ランプドラゴン", "スペルウィッチ２"];

/** 行動の列の簡単なハッシュ（FNV-1a、32 ビット） */
function digest(actions: readonly Action[]): string {
  let h = 0x811c9dc5;
  const s = JSON.stringify(actions);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** playMatch と同じ進め方で、ターンごとの思考時間を測る */
function timedMatch(agents: [Agent, Agent], decks: [readonly string[], readonly string[]], seed: number) {
  let state = createGame({ decks, seed });
  const rng = rngFrom({ rng: (seed ^ 0x9e3779b9) >>> 0 });
  const log: Action[] = [];
  const perTurn = new Map<number, number>();
  const turnStarts = new Map<number, GameState>();
  while (state.phase !== "ended") {
    if (!turnStarts.has(state.turn) && state.phase === "main") turnStarts.set(state.turn, state);
    const legal = legalActions(state);
    const t0 = performance.now();
    const action = agents[actingPlayer(state)].chooseAction(state, legal, rng);
    perTurn.set(state.turn, (perTurn.get(state.turn) ?? 0) + performance.now() - t0);
    log.push(action);
    state = applyAction(state, action);
  }
  return { winner: state.winner, turns: state.turn, log, perTurn, turnStarts };
}

/** root から p のターンのうちに到達できる異なる局面をすべて列挙する（同じ局面の判定を unique で行う） */
function enumerateTurn(root: GameState, p: PlayerIndex, unique: (s: GameState) => boolean) {
  const t0 = performance.now();
  let frontier = [root];
  unique(root);
  let states = 1, edges = 0, keyMs = 0;
  while (frontier.length > 0) {
    const next: GameState[] = [];
    for (const s of frontier) {
      const actor = s.pending ? s.pending.player : s.active;
      if (s.phase === "ended" || actor !== p) continue;
      for (const a of legalActions(s)) {
        if (a.type === "endTurn") continue;
        let t: GameState;
        try {
          t = applyAction(s, a);
        } catch {
          continue;
        }
        edges++;
        const k0 = performance.now();
        const isNew = unique(t);
        keyMs += performance.now() - k0;
        if (isNew) {
          states++;
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return { states, edges, keyMs, ms: performance.now() - t0 };
}

function timeEnumeration(root: GameState, p: PlayerIndex) {
  const strings = new Set<string>();
  const json = enumerateTurn(root, p, (s) => {
    const k = JSON.stringify(s);
    if (strings.has(k)) return false;
    strings.add(k);
    return true;
  });
  const keys = new KeySet();
  const keySet = enumerateTurn(root, p, (s) => keys.add(s, stateHash(s)));
  return { json, keySet };
}

export async function main(argv: string[]): Promise<number> {
  const deck = (name: string) => {
    const d = DEFAULT_DECKS.find((x) => x.name === name);
    if (!d) throw new Error(`デッキがありません: ${name}`);
    return d.cards;
  };

  const r = timedMatch([rhinoAgent, rhinoAgent], [deck("アミュレット疾走ビショップ"), deck("リノセウスエルフ")], 319922105);
  const total = [...r.perTurn.values()].reduce((a, b) => a + b, 0);
  console.log(`seed 319922105（リノセウス用ルール＋探索どうし）: 勝者 ${r.winner}、${r.turns} ターン、${r.log.length} 行動、行動列 ${digest(r.log)}`);
  console.log(`  思考時間 合計 ${(total / 1000).toFixed(2)}秒、ターンごと（ms）: ${[...r.perTurn].map(([t, ms]) => `${t}:${Math.round(ms)}`).join(" ")}`);

  const start = r.turnStarts.get(8);
  if (start) {
    const det = determinize(start, start.active, rngFrom({ rng: 1 }));
    // 1 回目は JIT の暖機。2 回目を表示する
    timeEnumeration(det, det.active);
    const e = timeEnumeration(det, det.active);
    console.log(`8 ターン目の全列挙: 局面 ${e.keySet.states}・遷移 ${e.keySet.edges}（JSON 方式 ${e.json.states}）`);
    const show = (x: { ms: number; keyMs: number }) => `全体 ${Math.round(x.ms)}ms（うち同じ局面の判定 ${Math.round(x.keyMs)}ms）`;
    console.log(`  JSON 文字列で判定: ${show(e.json)}、KeySet で判定: ${show(e.keySet)}`);
  }

  const games = Number(argv[0] ?? 14);
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const logs: Action[] = [];
  let time = 0;
  for (let g = 0; g < games; g++) {
    const i = g % 7, j = (g * 3 + 1 + Math.floor(g / 7)) % 7;
    const m = timedMatch([searchAgent, searchAgent], [decks[i]!.cards, decks[j]!.cards], g * 7 + 1);
    logs.push(...m.log);
    time += [...m.perTurn.values()].reduce((a, b) => a + b, 0);
  }
  console.log(`探索 AI どうし ${games} 試合: 1 試合 ${(time / games / 1000).toFixed(2)}秒、行動列 ${digest(logs)}`);
  return 0;
}
