// リノセウス用 AI の設定を変えたときの勝率（npm run rhino-compare）
//
// リノセウスエルフ（リノセウス用 AI）vs 他の 6 デッキ（探索 AI。ランプドラゴンは除く）を、両方の席で同じシードで打つ。
// 設定を変えても同じシードの試合になるので、変更前後を同じ試合数で比べられる。
// 例: npm run rhino-compare -- --games 50 --opts '{"nextLethal":10}'
//     （--opts はリノセウス用 AI の探索の設定 SearchOptions の一部。"weights" にオブジェクトを渡すとリノセウス用 AI の重み RHINO_WEIGHTS のその項目だけを変える。hold を渡すと hold 全体を置き換える（hold 無しは '{"weights":{"hold":{}}}'）。
//      試合は CPU のコア数だけ並列に行う）
// 自然の妖精姫・アリアを出した試合の数と、最初に出した自分のターン（平均）も出す。
// --agent で、リノセウスエルフ側の AI を registry のキーで選べる（既定は rhino。例: search、rhino-lethal。--opts は rhino のときだけ使う）。
// ベイル・ベビーカーバンクル・リノセウス・フェアリーテイマー・燐光の岩を出した回数と自分のターン（平均）も出す（手札の温存の点 hold を変えたときに比べる用。例: --opts '{"weights":{"hold":{"10113130":2}}}'）。
// --out ファイル名 で、試合ごとの結果（相手デッキ・g・席・勝ち・全探索でリーサルを見つけた回数・出したカード・森の神秘の得た数と使った数・自分のターンの開始時の様子）を JSON Lines で書き出す（変更前後で試合ごとに比べる用）。

import { writeFileSync } from "node:fs";
import { exactLethalCounts } from "../src/ai/exactLethal";
import { createRhinoAgent, rhinoLethalBound, RHINO_WEIGHTS } from "../src/ai/rhino";
import { agentOf } from "../src/ai/registry";
import { applyAction, cardOf, createGame } from "../src/engine";
import { searchAgent, type SearchOptions } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { playMatch } from "../src/sim/match";
import { parallelMap } from "./parallel";

const ELF = "リノセウスエルフ";
const EXCLUDED_DECKS = [ELF, "ランプドラゴン"];
const ARIA = "自然の妖精姫・アリア";
/** 出した自分のターンを数えるカード（温存の点 hold を変えたときに、出し方がどう変わるかを見る） */
const ROCK = "燐光の岩";
const MYSTERY = "森の神秘";
const TRACKED = ["煌撃の戦士・ベイル", "ベビーカーバンクル", "殺戮のリノセウス", "フェアリーテイマー", "燐光の岩"];

export async function main(argv: string[]): Promise<number> {
  let games = 50;
  let opts: Partial<SearchOptions> = {};
  let out: string | null = null;
  let agentKey = "rhino";
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} の値がありません`);
    if (key === "--games") games = Number(v);
    else if (key === "--out") out = v;
    else if (key === "--agent") agentKey = v;
    else if (key === "--opts") {
      const raw = JSON.parse(v) as Record<string, unknown>;
      if (typeof raw.weights === "object" && raw.weights !== null) raw.weights = { ...RHINO_WEIGHTS, ...raw.weights };
      opts = raw as Partial<SearchOptions>;
    }
    else throw new Error(`不明な引数: ${key}`);
  }
  const elf = DEFAULT_DECKS.find((d) => d.name === ELF);
  if (!elf) throw new Error(`${ELF} がありません`);
  const opponents = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  const agent = agentKey === "rhino" ? createRhinoAgent(opts) : agentOf(agentKey);
  const tasks = opponents.flatMap((o) => Array.from({ length: games }, (_, g) => ([0, 1] as const).map((elfSeat) => ({ o: o.name, g, elfSeat }))).flat());
  const t0 = Date.now();
  const results = await parallelMap(tasks, ({ o, g, elfSeat }) => {
    const opp = opponents.find((d) => d.name === o)!;
    const seed = 900000 + g * 13 + elfSeat;
    const decks: [string[], string[]] = elfSeat === 0 ? [elf.cards, opp.cards] : [opp.cards, elf.cards];
    const r = playMatch(elfSeat === 0 ? [agent, searchAgent] : [searchAgent, agent], { decks, seed, record: true });
    // アリアを最初に出した自分のターン
    let s = createGame({ decks, seed });
    let ariaTurn: number | null = null;
    // TRACKED のカードを出した自分のターン（カードごと）と、試合の最後の自分のターン
    const plays: Record<string, number[]> = Object.fromEntries(TRACKED.map((name) => [name, []]));
    let rockCombo3 = 0;
    // 自分のターンの開始時の様子（相手の体力・リノセウスで与えられるダメージの上限・手札の森の神秘とリノセウスの枚数・手札の枚数）
    const turns: { turn: number; oppHp: number; bound: number; mystery: number; rhino: number; hand: number }[] = [];
    // 自分の手札に森の神秘が加わった数と、プレイした数（差のうち手札に残っていない分は手札上限で溢れた）
    let mysteryGained = 0;
    let mysteryPlayed = 0;
    const mysteries = (x: typeof s) => x.players[elfSeat].hand.filter((h) => cardOf(h.cardId).name === MYSTERY);
    for (const a of r.log ?? []) {
      const me = s.players[elfSeat];
      if (s.active === elfSeat && !s.pending && turns[turns.length - 1]?.turn !== me.turnCount) {
        const count = (name: string) => me.hand.filter((h) => cardOf(h.cardId).name === name).length;
        turns.push({ turn: me.turnCount, oppHp: s.players[1 - elfSeat]!.leaderHp, bound: rhinoLethalBound(s, elfSeat), mystery: count(MYSTERY), rhino: count("殺戮のリノセウス"), hand: me.hand.length });
      }
      const before = new Set(mysteries(s).map((h) => h.iid));
      if (a.type === "play" && before.has(a.iid)) mysteryPlayed++;
      if (a.type === "play" && s.active === elfSeat && !s.pending) {
        const h = s.players[elfSeat].hand.find((c) => c.iid === a.iid);
        const name = h ? cardOf(h.cardId).name : null;
        if (name === ARIA && ariaTurn === null) ariaTurn = s.players[elfSeat].turnCount;
        if (name !== null && plays[name]) plays[name].push(s.players[elfSeat].turnCount);
        // 燐光の岩をコンボ 3 で出した（森の神秘が付く）回数
        if (name === ROCK && s.players[elfSeat].combo >= 2) rockCombo3++;
      }
      s = applyAction(s, a);
      mysteryGained += mysteries(s).filter((h) => !before.has(h.iid)).length;
    }
    const lastTurn = r.final.players[elfSeat].turnCount;
    return { deck: o, g, elfSeat, won: r.winner === elfSeat, ariaTurn, exactFound: exactLethalCounts.found, plays, lastTurn, rockCombo3, turns, mysteryGained, mysteryPlayed, mysteryLeft: mysteries(s).length };
  });
  const perDeck = new Map<string, [number, number]>();
  for (const { deck, won } of results) {
    const pd = perDeck.get(deck) ?? [0, 0];
    perDeck.set(deck, [pd[0] + (won ? 1 : 0), pd[1] + 1]);
  }
  const wins = results.filter((r) => r.won).length;
  const n = results.length;
  console.log(`agent ${agentKey} opts ${JSON.stringify(opts)}: ${wins}/${n} = ${((wins / n) * 100).toFixed(1)}%  ${((Date.now() - t0) / Math.max(1, n) / 1000).toFixed(2)}s/試合`);
  const aria = results.flatMap((r) => (r.ariaTurn === null ? [] : [r.ariaTurn]));
  const ariaWins = results.filter((r) => r.ariaTurn !== null && r.won).length;
  console.log(`アリアを出した試合 ${aria.length}/${n}（そのうち勝ち ${ariaWins}）、最初に出した自分のターン 平均 ${(aria.reduce((x, y) => x + y, 0) / Math.max(1, aria.length)).toFixed(2)}`);
  console.log([...perDeck].map(([name, [w, t]]) => `${name} ${w}/${t}`).join(", "));
  for (const name of TRACKED) {
    const turns = results.flatMap((r) => r.plays[name] ?? []);
    // 勝った試合の最後の自分のターン（ほぼリーサルのターン）に出した数
    const finishing = results.filter((r) => r.won).reduce((t, r) => t + (r.plays[name] ?? []).filter((x) => x === r.lastTurn).length, 0);
    console.log(`${name}: 出した回数 ${turns.length}（1 試合 ${(turns.length / n).toFixed(2)}）、平均の自分のターン ${(turns.reduce((x, y) => x + y, 0) / Math.max(1, turns.length)).toFixed(2)}、勝った試合の最後のターンに出した数 ${finishing}`);
  }
  console.log(`燐光の岩をコンボ 3 で出した回数 ${results.reduce((t, r) => t + r.rockCombo3, 0)}`);
  const exact = results.filter((r) => r.exactFound > 0);
  console.log(`全探索でリーサルを見つけた試合 ${exact.length}/${n}（そのうち勝ち ${exact.filter((r) => r.won).length}）`);
  if (out) writeFileSync(out, results.map((r) => JSON.stringify({ deck: r.deck, g: r.g, elfSeat: r.elfSeat, won: r.won, exactFound: r.exactFound, plays: r.plays, lastTurn: r.lastTurn, rockCombo3: r.rockCombo3, mysteryGained: r.mysteryGained, mysteryPlayed: r.mysteryPlayed, mysteryLeft: r.mysteryLeft, turns: r.turns })).join("\n") + "\n");
  return 0;
}
