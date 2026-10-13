// 分析用: アマリアロイヤルの 2 ターン目に、手札に異端の侍と王家の御者が両方あるとき、探索 AI がどちらを出すかを数える
//
// 使い方: npm run royal-turn2 -- [--games N] [--seed S] [--out 結果.jsonl]
// ロイヤル vs 他の各デッキを、席を入れ替えて N 試合ずつ、ロイヤルの 2 ターン目が終わるところまで探索 AI どうしで打つ。
// 両方あった局面では、探索 AI が手を選ぶときの評価（侍を先に出す並び・御者を先に出す並びの最善）も別の乱数で取り直して記録する。

import { appendFileSync, writeFileSync } from "node:fs";
import { evaluateWith, SEARCH_WEIGHTS } from "../src/ai/evaluate";
import { createSearchAgent, firstActionValues } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { actingPlayer, applyAction, cardOf, createGame, legalActions, nextRandom, rngFrom, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { parallelMap } from "./parallel";

const SAMURAI = "10121150";
const COACHMAN = "10022110";
const ROYAL = "アマリアロイヤル";

interface Rec {
  opp: string;
  seat: PlayerIndex;
  g: number;
  first: boolean;
  both: boolean;
  played: string[];
  attacks: string[];
  oppBoard: string[];
  hand: string[];
  values?: { samurai: number | null; coachman: number | null; samuraiEnd: number | null; coachmanEnd: number | null; best: string };
}

function arg(argv: string[], name: string, def: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
}

function playedCard(s: GameState, p: PlayerIndex, a: Action): string | null {
  if (a.type !== "play") return null;
  const h = s.players[p].hand.find((c) => c.iid === a.iid);
  return h ? h.cardId : null;
}

function run(opp: string, seat: PlayerIndex, g: number, seed: number): Rec {
  const royal = DEFAULT_DECKS.find((d) => d.name === ROYAL)!;
  const other = DEFAULT_DECKS.find((d) => d.name === opp)!;
  let s = createGame({ decks: seat === 0 ? [royal.cards, other.cards] : [other.cards, royal.cards], seed });
  const agents = [createSearchAgent(), createSearchAgent()] as const;
  const rng = rngFrom({ rng: (seed ^ 0x9e3779b9) >>> 0 });
  const rec: Rec = { opp, seat, g, first: false, both: false, played: [], attacks: [], oppBoard: [], hand: [] };
  let inTurn2 = false;
  for (let n = 0; n < 2000 && s.phase !== "ended"; n++) {
    const me = s.players[seat];
    if (s.phase === "main" && s.active === seat && me.turnCount === 3) break;
    if (!inTurn2 && s.phase === "main" && s.active === seat && me.turnCount === 2 && !s.pending) {
      inTurn2 = true;
      rec.first = s.first === seat;
      rec.hand = me.hand.map((h) => cardOf(h.cardId).name);
      rec.oppBoard = s.players[seat === 0 ? 1 : 0].board.map((c) => cardOf(c.cardId).name);
      rec.both = me.hand.some((h) => h.cardId === SAMURAI) && me.hand.some((h) => h.cardId === COACHMAN);
      if (rec.both) {
        const vrng = rngFrom({ rng: (seed ^ 0x51ed270b) >>> 0 });
        const vals = firstActionValues(s, seat, vrng);
        // 最初の手ごとの最善の並びのうち、侍・御者のどちらを先に出すか
        const pick = (id: string) => vals.find((x) => firstPlayed(s, seat, x.actions) === id) ?? null;
        const sam = pick(SAMURAI);
        const coa = pick(COACHMAN);
        rec.values = {
          samurai: sam ? sam.value - (3 - sam.count) * 0.5 : null,
          coachman: coa ? coa.value - (3 - coa.count) * 0.5 : null,
          samuraiEnd: sam ? evaluateWith(sam.state, seat, SEARCH_WEIGHTS) : null,
          coachmanEnd: coa ? evaluateWith(coa.state, seat, SEARCH_WEIGHTS) : null,
          best: vals[0] ? describe(s, seat, vals[0].actions) : "",
        };
      }
    }
    const actor = actingPlayer(s);
    const legal = legalActions(s);
    const a = agents[actor].chooseAction(s, legal, rng);
    if (inTurn2 && actor === seat) {
      const c = playedCard(s, seat, a);
      if (c) rec.played.push(cardOf(c).name);
      if (a.type === "attack") {
        const att = s.players[seat].board.find((x) => x.iid === a.attacker);
        const tgt = a.target === "leader" ? "リーダー" : s.players[seat === 0 ? 1 : 0].board.find((x) => x.iid === a.target);
        rec.attacks.push(`${att ? cardOf(att.cardId).name : "?"}→${typeof tgt === "string" ? tgt : tgt ? cardOf(tgt.cardId).name : "?"}`);
      }
    }
    s = applyAction(s, a);
  }
  return rec;
}

/** 並びを最初から適用して、最初に出した侍か御者のカードID */
function firstPlayed(s0: GameState, p: PlayerIndex, actions: Action[]): string | null {
  let s = s0;
  for (const a of actions) {
    const c = playedCard(s, p, a);
    if (c === SAMURAI || c === COACHMAN) return c;
    s = applyAction(s, a);
  }
  return null;
}

function describe(s0: GameState, p: PlayerIndex, actions: Action[]): string {
  let s = s0;
  const out: string[] = [];
  for (const a of actions) {
    const c = playedCard(s, p, a);
    if (c) out.push(cardOf(c).name);
    else if (a.type === "attack") out.push("攻撃");
    else out.push(a.type);
    s = applyAction(s, a);
  }
  return out.join(" → ");
}

export async function main(argv: string[]): Promise<number> {
  const games = Number(arg(argv, "--games", "20"));
  const seed = Number(arg(argv, "--seed", "1"));
  const out = arg(argv, "--out", "");
  const opps = DEFAULT_DECKS.filter((d) => d.name !== ROYAL).map((d) => d.name);
  const tasks: { opp: string; seat: PlayerIndex; g: number; seed: number }[] = [];
  for (const [oi, opp] of opps.entries())
    for (let g = 0; g < games; g++)
      for (const seat of [0, 1] as const) tasks.push({ opp, seat, g, seed: nextRandom((seed * 1000003 + oi * 7919 + g * 31 + seat) >>> 0)[1] });
  if (out) writeFileSync(out, "");
  const t0 = Date.now();
  const recs = await parallelMap(
    tasks,
    (t) => {
      const r = run(t.opp, t.seat, t.g, t.seed);
      if (out) appendFileSync(out, JSON.stringify(r) + "\n");
      return r;
    },
    (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`${done}/${total}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    },
  );
  const both = recs.filter((r) => r.both);
  const count = (rs: Rec[], name: string) => rs.filter((r) => r.played.includes(name)).length;
  console.log(`2 ターン目まで ${recs.length} 試合。侍を出した ${count(recs, "異端の侍")}、御者を出した ${count(recs, "王家の御者")}`);
  console.log(`両方あった ${both.length}: 侍 ${count(both, "異端の侍")}、御者 ${count(both, "王家の御者")}、どちらも出さない ${both.filter((r) => !r.played.includes("異端の侍") && !r.played.includes("王家の御者")).length}`);
  return 0;
}
