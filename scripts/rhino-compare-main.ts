// リノセウス用 AI の設定を変えたときの勝率（npm run rhino-compare）。--subject af（npm run af-compare）で AFネメシスの AI を、--subject spellwitch（npm run spellwitch-compare）でスペルウィッチの AI を、--subject bishop（npm run bishop-compare）でアミュレット疾走ビショップの AI を、--subject dragon・nightmare・royal（npm run dragon-compare・nightmare-compare・royal-compare）で疾走ドラゴン・ミッドレンジナイトメア・アマリアロイヤルの AI を同じ形で比べる
//
// リノセウスエルフ（リノセウス用 AI）vs 他の 6 デッキ（探索 AI。ランプドラゴンは除く）を、両方の席で同じシードで打つ。
// --subject af・spellwitch・bishop・dragon・nightmare・royal のときは AFネメシス・スペルウィッチ・アミュレット疾走ビショップ・疾走ドラゴン・ミッドレンジナイトメア・アマリアロイヤル（既定は探索 AI。--opts は探索 AI の設定 SearchOptions の一部）vs 他の 6 デッキ。
// 設定を変えても同じシードの試合になるので、変更前後を同じ試合数で比べられる。
// 例: npm run rhino-compare -- --games 50 --opts '{"nextLethal":10}'
//     （--opts はリノセウス用 AI の探索の設定 SearchOptions の一部。"weights" にオブジェクトを渡すと SEARCH_WEIGHTS のその項目だけを変える。"potential" は次のターンのリノセウスの打点の不足分を評価に足す係数。"holds" は温存のルールを外す（例: {"mystery":false}）。"beamPp" はビームで残す局面を選ぶときに残り PP 1 につき足す点。"exhaustive" は序盤のターンを全探索する（例: {"untilTurn":5,"maxStates":10000}）。
//      試合は CPU のコア数だけ並列に行う）
// 自然の妖精姫・アリアを出した試合の数と、最初に出した自分のターン（平均）も出す。
// --agent で、リノセウスエルフ側の AI を registry のキーで選べる（既定は rhino。例: search、rhino-lethal。--opts は rhino のときだけ使う）。
// --start N で、最初の試合番号を N にする（既定 0。前に回した試合と重ならない別の試合で確かめるため）。
// --subject bishop のときは、ジャンヌを出した回数と、そのときアミュレットから出たフォロワーが場にいた回数も出す。
// --out ファイル名 で、試合ごとの結果（相手デッキ・g・席・勝ち・全探索でリーサルを見つけた回数）を JSON Lines で書き出す（変更前後で試合ごとに比べる用）。
// --matches ファイル名 で、JSON Lines の各行の（deck・g・seat）の試合だけを打つ（web の「人間との比較」で人間が打った記録を渡すと、
// 人間と同じ試合で AI の勝率を出し、人間の勝敗と並べて表示する。--games は使わない）。
// 試合のシードと相手は src/sim/humanCompare.ts で決める（web と共通）。

import { SEARCH_WEIGHTS } from "../src/ai/evaluate";
import { readFileSync, writeFileSync } from "node:fs";
import { exactLethalCounts } from "../src/ai/exactLethal";
import { createRhinoAgent, type RhinoOptions } from "../src/ai/rhino";
import { agentOf } from "../src/ai/registry";
import { applyAction, cardOf, createGame } from "../src/engine";
import { createSearchAgent, exhaustiveCounts, searchAgent } from "../src/ai/search";
import type { Agent } from "../src/ai/types";
import { playMatch } from "../src/sim/match";
import { compareMatch, isSubjectId, opponentsOf, SUBJECTS, type SubjectId } from "../src/sim/humanCompare";
import { parallelMap } from "./parallel";
import { applyValueNetOption } from "./valueNetOption";

const ARIA = "自然の妖精姫・アリア";
const JEANNE = "純白の聖女・ジャンヌ";
/** フォロワーを出すカウントダウンのアミュレットから出るフォロワー（ホーリーファルコンはフェザーレインでも出るので数えない） */
const AMULET_TOKENS = ["ホーリーフレイムタイガー", "壮麗なる隼"];

export async function main(argv: string[]): Promise<number> {
  let games = 50;
  let opts: RhinoOptions = {};
  let out: string | null = null;
  let agentKey: string | null = null;
  let subject: SubjectId = "rhino";
  let matches: string | null = null;
  let start = 0;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} の値がありません`);
    if (key === "--games") games = Number(v);
    else if (key === "--start") start = Number(v);
    else if (key === "--out") out = v;
    else if (key === "--agent") agentKey = v;
    else if (key === "--matches") matches = v;
    else if (key === "--subject") {
      if (!isSubjectId(v)) throw new Error(`--subject は ${Object.keys(SUBJECTS).join(" / ")} のどれか: ${v}`);
      subject = v;
    }
    else if (key === "--opts") {
      // "valueNet" にファイル名を渡すと、TD 学習で作った評価の補正を使う（scripts/valueNetOption.ts）
      const raw = applyValueNetOption(JSON.parse(v) as Record<string, unknown>);
      if (typeof raw.weights === "object" && raw.weights !== null) raw.weights = { ...SEARCH_WEIGHTS, ...raw.weights };
      opts = raw as RhinoOptions;
    }
    else throw new Error(`不明な引数: ${key}`);
  }
  agentKey ??= SUBJECTS[subject].agent;
  // --opts は rhino・search のときだけ使う
  const agent: Agent = agentKey === "rhino" ? createRhinoAgent(opts) : agentKey === "search" ? createSearchAgent(opts) : agentOf(agentKey);
  const given = matches === null ? null : readMatches(matches, subject);
  const tasks =
    given?.map(({ deck, g, seat }) => ({ o: deck, g, elfSeat: seat })) ??
    opponentsOf(subject).flatMap((o) => Array.from({ length: games }, (_, k) => ([0, 1] as const).map((elfSeat) => ({ o: o.name, g: start + k, elfSeat }))).flat());
  const t0 = Date.now();
  const results = await parallelMap(tasks, ({ o, g, elfSeat }) => {
    const { decks, seed } = compareMatch(subject, o, g, elfSeat);
    Object.assign(exhaustiveCounts, { searches: 0, overflow: 0, states: 0, maxStates: 0, better: 0, gain: 0, firstDiffers: 0, byTurn: {} });
    const t = Date.now();
    const r = playMatch(elfSeat === 0 ? [agent, searchAgent] : [searchAgent, agent], { decks, seed, record: true });
    // アリアを最初に出した自分のターン
    let s = createGame({ decks, seed });
    let ariaTurn: number | null = null;
    for (const a of r.log ?? []) {
      if (a.type === "play" && s.active === elfSeat && !s.pending) {
        const h = s.players[elfSeat].hand.find((c) => c.iid === a.iid);
        if (h && cardOf(h.cardId).name === ARIA) {
          ariaTurn = s.players[elfSeat].turnCount;
          break;
        }
      }
      s = applyAction(s, a);
    }
    // ビショップ: ジャンヌを出した回数と、そのときアミュレットから出たフォロワーが場にいて +2/+4 された回数
    let jeanne = 0, jeanneTokens = 0;
    if (subject === "bishop") {
      let b = createGame({ decks, seed });
      for (const a of r.log ?? []) {
        if (a.type === "play" && b.active === elfSeat && !b.pending) {
          const h = b.players[elfSeat].hand.find((c) => c.iid === a.iid);
          if (h && cardOf(h.cardId).name === JEANNE) {
            jeanne++;
            if (b.players[elfSeat].board.some((c) => AMULET_TOKENS.includes(cardOf(c.cardId).name))) jeanneTokens++;
          }
        }
        b = applyAction(b, a);
      }
    }
    return { deck: o, g, elfSeat, won: r.winner === elfSeat, ariaTurn, jeanne, jeanneTokens, exactFound: exactLethalCounts.found, ex: { ...exhaustiveCounts }, sec: (Date.now() - t) / 1000 };
  });
  const perDeck = new Map<string, [number, number]>();
  for (const { deck, won } of results) {
    const pd = perDeck.get(deck) ?? [0, 0];
    perDeck.set(deck, [pd[0] + (won ? 1 : 0), pd[1] + 1]);
  }
  const wins = results.filter((r) => r.won).length;
  const n = results.length;
  console.log(`${SUBJECTS[subject].deck} agent ${agentKey} opts ${JSON.stringify(opts)}: ${wins}/${n} = ${((wins / n) * 100).toFixed(1)}%  ${((Date.now() - t0) / Math.max(1, n) / 1000).toFixed(2)}s/試合`);
  const aria = results.flatMap((r) => (r.ariaTurn === null ? [] : [r.ariaTurn]));
  const ariaWins = results.filter((r) => r.ariaTurn !== null && r.won).length;
  if (subject === "bishop") {
    const sum = (k: "jeanne" | "jeanneTokens") => results.reduce((x, r) => x + r[k], 0);
    console.log(`ジャンヌを出した回数 ${sum("jeanne")}、そのうちアミュレットから出たフォロワー（${AMULET_TOKENS.join("・")}）が場にいた回数 ${sum("jeanneTokens")}`);
  }
  if (subject === "rhino") console.log(`アリアを出した試合 ${aria.length}/${n}（そのうち勝ち ${ariaWins}）、最初に出した自分のターン 平均 ${(aria.reduce((x, y) => x + y, 0) / Math.max(1, aria.length)).toFixed(2)}`);
  console.log([...perDeck].map(([name, [w, t]]) => `${name} ${w}/${t}`).join(", "));
  const exact = results.filter((r) => r.exactFound > 0);
  console.log(`全探索でリーサルを見つけた試合 ${exact.length}/${n}（そのうち勝ち ${exact.filter((r) => r.won).length}）`);
  if (opts.exhaustive) {
    const sum = (k: Exclude<keyof typeof exhaustiveCounts, "byTurn">) => results.reduce((x, r) => x + r.ex[k], 0);
    const solved = sum("searches") - sum("overflow");
    console.log(`全探索 ${sum("searches")} 回（サンプルごと）: 上限超え ${sum("overflow")}、読み切り ${solved}（平均 ${(sum("states") / Math.max(1, solved)).toFixed(0)} 局面、最大 ${Math.max(...results.map((r) => r.ex.maxStates))}）`);
    console.log(`  ビームより良いターン末を見つけた ${sum("better")}/${solved}（差の平均 ${(sum("gain") / Math.max(1, sum("better"))).toFixed(2)}）、そのうち最初の手も違う ${sum("firstDiffers")}`);
    const byTurn = new Map<number, [number, number, number, number]>();
    for (const r of results) for (const [t, v] of Object.entries(r.ex.byTurn)) {
      const c = byTurn.get(Number(t)) ?? [0, 0, 0, 0];
      byTurn.set(Number(t), [c[0] + v[0], c[1] + v[1], c[2] + v[2], c[3] + v[3]]);
    }
    for (const [t, [n, over, better, states]] of [...byTurn].sort((a, b) => a[0] - b[0]))
      console.log(`  自分の ${t} ターン目: 全探索 ${n}、上限超え ${over}、ビームより良い ${better}/${n - over}、平均 ${(states / Math.max(1, n - over)).toFixed(0)} 局面`);
    for (const r of results) console.log(`  ${r.deck} g${r.g} 席${r.elfSeat}: ${r.won ? "勝ち" : "負け"} ${r.sec.toFixed(1)}秒 全探索${r.ex.searches} 上限超え${r.ex.overflow} 良い${r.ex.better} 最大${r.ex.maxStates}`);
  }
  if (given) {
    const humanWins = given.filter((m) => m.won === true).length;
    console.log(`同じ試合の --matches の勝ち ${humanWins}/${given.length} = ${((humanWins / Math.max(1, given.length)) * 100).toFixed(1)}%`);
    for (const [i, m] of given.entries()) {
      const r = results[i]!;
      console.log(`  ${m.deck} g=${m.g} 席${m.seat}: ${m.won === undefined ? "-" : m.won ? "勝ち" : "負け"} / AI ${r.won ? "勝ち" : "負け"}`);
    }
  }
  if (out) writeFileSync(out, results.map((r) => JSON.stringify({ subject, deck: r.deck, g: r.g, seat: r.elfSeat, won: r.won, exactFound: r.exactFound })).join("\n") + "\n");
  return 0;
}

/** --matches のファイル（JSON Lines。各行に deck・g・seat（古い形式は elfSeat）、あれば subject・won） */
function readMatches(file: string, subject: SubjectId): { deck: string; g: number; seat: 0 | 1; won?: boolean }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      const v = JSON.parse(line) as Record<string, unknown>;
      const seat = v.seat ?? v.elfSeat;
      if (typeof v.deck !== "string" || typeof v.g !== "number" || (seat !== 0 && seat !== 1))
        throw new Error(`${file} の ${i + 1} 行目に deck・g・seat がありません`);
      const lineSubject = v.subject ?? "rhino";
      if (lineSubject !== subject) throw new Error(`${file} の ${i + 1} 行目は ${String(lineSubject)} の試合です（--subject ${subject}）`);
      return { deck: v.deck, g: v.g, seat, ...(typeof v.won === "boolean" ? { won: v.won } : {}) };
    });
}
