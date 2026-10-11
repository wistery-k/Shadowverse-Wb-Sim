// 評価関数の重みを変えると手が変わる局面を集める（npm run weight-diff）。
//
// 探索 AI どうし（エルフはリノセウス用 AI）で対戦させ、各ターンについて、今の重みの AI と候補の重みの AI に
// 同じ局面・同じ乱数で手を選ばせる。最初に手が分かれたところで、両方の AI にそのターンの残りを打たせ、
// 局面と 2 つの手順を Markdown で書き出す（1 ターンに 1 か所）。対戦そのものは今の AI で進める。

import { appendFileSync, writeFileSync } from "node:fs";
import { DEFAULT_WEIGHTS, SEARCH_WEIGHTS, type EvalWeights } from "../src/ai/evaluate";
import { createRhinoAgent } from "../src/ai/rhino";
import { createSearchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import {
  actingPlayer,
  applyAction,
  cardOf,
  createGame,
  legalActions,
  nextRandom,
  rngFrom,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../src/engine";
import { describeAction } from "../src/ui/describe";

/** 比較に使うデッキ（npm run compare と同じ 7 つ） */
const EXCLUDED_DECKS = ["ランプドラゴン"];

function mix(seed: number, x: number): number {
  return nextRandom((seed ^ Math.imul(x + 1, 0x9e3779b1)) >>> 0)[1];
}

/** 候補の重み: 今の重みに JSON の値を上書きする。myHand を変えたら、融合で作るカードの価値も同じ倍率にする */
function candidateWeights(json: string): EvalWeights {
  const patch = JSON.parse(json) as Partial<EvalWeights>;
  const w: EvalWeights = { ...SEARCH_WEIGHTS, ...patch };
  if (patch.myHand !== undefined && patch.hold === undefined) {
    const k = patch.myHand / DEFAULT_WEIGHTS.myHand;
    w.hold = Object.fromEntries(Object.entries(SEARCH_WEIGHTS.hold).map(([id, v]) => [id, v * k]));
  }
  return w;
}

/** 比べる側の AI（計画の使い回しは、それまでの自分の手に依存するので使わない） */
function makeAgent(deck: string, weights: EvalWeights): Agent {
  const opts = { weights, reusePlan: false };
  return deck === "リノセウスエルフ" ? createRhinoAgent(opts) : createSearchAgent(opts);
}

function describeState(s: GameState, p: PlayerIndex): string[] {
  const me = s.players[p];
  const opp = s.players[p === 0 ? 1 : 0];
  const board = (b: GameState["players"][0]["board"]) =>
    b.map((c) => {
      const name = cardOf(c.cardId).name;
      if (c.kind === "amulet") return c.countdown !== null ? `${name}(カウントダウン${c.countdown})` : name;
      const evo = c.evolve === "superEvolved" ? "・超進化" : c.evolve === "evolved" ? "・進化" : "";
      return `${name} ${c.attack}/${c.defense}${evo}${c.keywords.length ? `・${c.keywords.join("・")}` : ""}`;
    }).join("、") || "なし";
  return [
    `- 自分: 体力 ${me.leaderHp}、PP ${me.pp}/${me.maxPp}、EP ${me.ep}、SEP ${me.sep}${me.extraPpAvailable ? "、エクストラPP あり" : ""}、コンボ ${me.combo}`,
    `  - 手札: ${me.hand.map((h) => `${cardOf(h.cardId).name}(${cardOf(h.cardId).cost})`).join("、") || "なし"}`,
    `  - 場: ${board(me.board)}`,
    `- 相手: 体力 ${opp.leaderHp}、手札 ${opp.hand.length} 枚、EP ${opp.ep}、SEP ${opp.sep}`,
    `  - 場: ${board(opp.board)}`,
  ];
}

/** その局面から、手番のプレイヤーのターンが終わるまで agent に打たせ、行動の説明を返す */
function restOfTurn(state: GameState, agent: Agent, rngSeed: number, names: readonly [string, string]): { lines: string[]; end: GameState } {
  const p = actingPlayer(state);
  const rng = rngFrom({ rng: rngSeed });
  const lines: string[] = [];
  let s = state;
  for (let i = 0; i < 60 && s.phase !== "ended" && actingPlayer(s) === p && s.turn === state.turn; i++) {
    const a = agent.chooseAction(s, legalActions(s), rng);
    lines.push(describeAction(s, a, names).replace(/^[^:]+: /, ""));
    s = applyAction(s, a);
  }
  return { lines, end: s };
}

const keyOf = (a: Action) => JSON.stringify(a);

/** ターン終了時の局面が同じか（体力・手札・場・EP/SEP だけを比べる。手の順番違いを除くため） */
function sameEnd(x: GameState, y: GameState): boolean {
  const sig = (s: GameState) =>
    JSON.stringify([
      s.phase,
      s.winner,
      s.players.map((pl) => [
        pl.leaderHp,
        pl.ep,
        pl.sep,
        pl.hand.map((h) => h.cardId).sort(),
        pl.board.map((c) => (c.kind === "follower" ? `${c.cardId}:${c.attack}/${c.defense}:${c.evolve}` : `${c.cardId}:${c.countdown}`)).sort(),
      ]),
    ]);
  return sig(x) === sig(y);
}

/**
 * npm run weight-diff -- --games <n> --seed <s> --weights '<JSON>' --out <file.md> [--shard i/k]
 * 例: npm run weight-diff -- --games 20 --weights '{"myHand":2,"ep":3}' --out diff.md
 */
export async function main(argv: string[]): Promise<number> {
  let games = 10, seed = 1, shard = [0, 1], out = "weight-diff.md", weightsJson = "{}";
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] ?? "";
    if (k === "--games") games = Number(v);
    else if (k === "--seed") seed = Number(v);
    else if (k === "--shard") shard = v.split("/").map(Number);
    else if (k === "--out") out = v;
    else if (k === "--weights") weightsJson = v;
    else throw new Error(`不明な引数: ${k}`);
  }
  const cand = candidateWeights(weightsJson);
  const decks = DEFAULT_DECKS.filter((d) => !EXCLUDED_DECKS.includes(d.name));
  writeFileSync(out, `# 重みを変えると手が変わる局面\n\n候補: \`${weightsJson}\`（他は今の探索 AI の重み）\n\n`);
  const t0 = Date.now();
  const compared = new Set<string>();
  let diffs = 0, orderOnly = 0;
  for (let g = 0; g < games; g++) {
    if (g % shard[1]! !== shard[0]) continue;
    const gameSeed = mix(seed, g);
    const [r1, s1] = nextRandom(gameSeed);
    const [r2] = nextRandom(s1);
    const i = Math.floor(r1 * decks.length);
    const j = (i + 1 + Math.floor(r2 * (decks.length - 1))) % decks.length;
    const pair = [decks[i]!, decks[j]!];
    const names = [pair[0]!.name, pair[1]!.name] as const;
    // 対戦を進める AI（今の既定）
    const live = names.map((d) => (d === "リノセウスエルフ" ? createRhinoAgent() : createSearchAgent())) as [Agent, Agent];
    const agentRng = rngFrom({ rng: (gameSeed ^ 0x9e3779b9) >>> 0 });
    let state = createGame({ decks: [pair[0]!.cards, pair[1]!.cards], seed: gameSeed });
    let checkedTurn = -1;
    let step = 0;
    while (state.phase !== "ended") {
      const actor = actingPlayer(state);
      const legal = legalActions(state);
      if (state.phase === "main" && state.turn !== checkedTurn && legal.length > 1) {
        // このターンで、まだ手が分かれていない。今の重みと候補の重みで選ばせて比べる
        compared.add(`${g}:${state.turn}`);
        const rngSeed = mix(gameSeed, 1000 + step);
        const base = makeAgent(names[actor], SEARCH_WEIGHTS);
        const alt = makeAgent(names[actor], cand);
        const a = base.chooseAction(state, legal, rngFrom({ rng: rngSeed }));
        const b = alt.chooseAction(state, legal, rngFrom({ rng: rngSeed }));
        if (keyOf(a) !== keyOf(b)) {
          checkedTurn = state.turn;
          const ra = restOfTurn(state, makeAgent(names[actor], SEARCH_WEIGHTS), rngSeed, names);
          const rb = restOfTurn(state, makeAgent(names[actor], cand), rngSeed, names);
          // 手の順番が違うだけで同じ局面に着いたものは数えるだけにする
          if (sameEnd(ra.end, rb.end)) {
            orderOnly++;
          } else {
          diffs++;
          const me = (s: GameState) => s.players[actor];
          const opp = (s: GameState) => s.players[actor === 0 ? 1 : 0];
          const summary = (s: GameState) =>
            `ターン終了時: 手札 ${me(s).hand.length} 枚、自分の場 ${me(s).board.length}、相手の場 ${opp(s).board.length}、相手の体力 ${opp(s).leaderHp}、EP ${me(s).ep}・SEP ${me(s).sep}`;
          appendFileSync(
            out,
            [
              `## ${names[actor]} vs ${names[actor === 0 ? 1 : 0]}（seed ${gameSeed}、${actor === state.first ? "先攻" : "後攻"}、自分の ${me(state).turnCount} ターン目・全体の ${state.turn} ターン目）`,
              "",
              ...describeState(state, actor),
              "",
              `**今の重み:** ${ra.lines.join(" → ")}`,
              `  - ${summary(ra.end)}`,
              "",
              `**候補の重み:** ${rb.lines.join(" → ")}`,
              `  - ${summary(rb.end)}`,
              "",
              "",
            ].join("\n"),
          );
          }
        }
      }
      state = applyAction(state, live[actor].chooseAction(state, legal, agentRng));
      step++;
    }
    console.log(`試合 ${g}: 手が分かれたターン ${diffs}/${compared.size}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  }
  appendFileSync(out, `比べたターン ${compared.size}、ターン終了時の局面が変わったターン ${diffs}、手の順番だけが変わったターン ${orderOnly}\n`);
  console.log(`完了: 手が分かれたターン ${diffs}/${compared.size}、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return 0;
}
