// AI の設定を変えたときに、人間の対戦記録の各ターンで AI の手順がどう変わり、勝率がどう変わるかを測る（npm run variant-plan-value）。
//
// human-plan-value の出力（--base）にある局面（マリガンを除く）ごとに、設定を変えた AI（--opts）で同じ局面から自分のターンを打つ。
// 手順が元の AI と同じなら差は 0。変わったら、human-plan-value と同じ M 個のシード（共通の乱数）で、変わった手順のターン末から
// 探索 AI に最後まで打たせ、元の AI の手順の勝率（--base に記録済み）と比べる。続きの AI は変えない（その 1 ターンの選択の差だけを測る）。
// 対戦で勝率を比べる前の、ふるい分けに使う（手順が変わった局面だけ打つので速い。採用は今までどおり対戦の勝率で決める）。
// 1 試合ごとに出力ファイルに追記し、最後に集計を出す。同じ引数で再開できる（済みの試合は飛ばす）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SEARCH_WEIGHTS } from "../src/ai/evaluate";
import type { RhinoOptions } from "../src/ai/rhino";
import { actingPlayer, applyAction, createGame, type GameState, type PlayerIndex } from "../src/engine";
import { compareMatch } from "../src/sim/humanCompare";
import { parseHumanRecord, type HumanGameRecord } from "../src/sim/humanRecord";
import { aiTurn, gameKey, isStartOfTurn, makeAgents, mix, rollouts, type HumanPlanRecord } from "./human-plan-value-main";
import { isParallelWorker, parallelMap } from "./parallel";

export interface VariantRecord {
  subject: string;
  deck: string;
  g: number;
  seat: number;
  ownTurn: number;
  /** 設定を変えた AI の手順が元の AI と違ったか */
  changed: boolean;
  steps: string[];
  oldSteps: string[];
  /** 設定を変えた AI の手順・元の AI の手順・人間の手順の勝敗（M 個のシード。変わらなかったら空） */
  wins: (boolean | null)[];
  oldWins: (boolean | null)[];
  humanWins: (boolean | null)[];
}

const winsOf = (end: GameState, subject: HumanGameRecord["subject"], p: PlayerIndex, M: number, posSeed: number) =>
  rollouts(end.phase === "ended" ? end : applyAction(end, { type: "endTurn" }), subject, p, M, posSeed);

function compareGame(rec: HumanGameRecord, base: Map<number, HumanPlanRecord>, opts: RhinoOptions, M: number, salt: number): VariantRecord[] {
  const { decks, seed } = compareMatch(rec.subject, rec.deck, rec.g, rec.seat);
  const p = rec.seat;
  const out: VariantRecord[] = [];
  let s = createGame({ decks, seed });
  let lastTurn = -1;
  for (let i = 0; i < rec.actions.length && s.phase !== "ended"; i++) {
    const a = rec.actions[i]!;
    const actor = actingPlayer(s);
    if (actor === p && s.active === p && isStartOfTurn(s) && s.players[p].turnCount !== lastTurn && a.type !== "mulligan") {
      lastTurn = s.players[p].turnCount;
      const b = base.get(lastTurn);
      if (b) {
        try {
          const posSeed = mix(seed, 100 + lastTurn);
          const v = aiTurn(s, p, makeAgents(rec.subject, p, opts), salt === 0 ? mix(posSeed, 1) : mix(mix(posSeed, 1), salt));
          const changed = v.steps.join("\n") !== b.ai.steps.join("\n");
          const row: VariantRecord = { subject: rec.subject, deck: rec.deck, g: rec.g, seat: p, ownTurn: lastTurn, changed, steps: v.steps, oldSteps: b.ai.steps, wins: [], oldWins: [], humanWins: [] };
          if (changed) {
            row.wins = winsOf(v.end, rec.subject, p, M, posSeed);
            if (b.same) {
              // 元の AI の手順は人間と同じ局面で、続きを打っていない。元の AI の手順を打ち直して続きを打つ
              const old = aiTurn(s, p, makeAgents(rec.subject, p), mix(posSeed, 1));
              row.oldWins = winsOf(old.end, rec.subject, p, M, posSeed);
              row.humanWins = row.oldWins;
            } else {
              row.oldWins = b.ai.wins;
              row.humanWins = b.human.wins;
            }
          }
          out.push(row);
        } catch (e) {
          console.error(`${gameKey(rec)} 自分の ${lastTurn} ターン目: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    s = applyAction(s, a);
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const se = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
const pct = (x: number) => (Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const pm = (xs: number[]) => `${pct(mean(xs))} ± ${Number.isNaN(se(xs)) ? "-" : `${(se(xs) * 100).toFixed(1)}%`}`;

/** 共通のシードで両方打てた組の差の平均 */
function pairDiff(a: (boolean | null)[], b: (boolean | null)[]): number {
  const ds: number[] = [];
  a.forEach((x, i) => {
    const y = b[i];
    if (x !== null && y !== null && y !== undefined) ds.push(Number(x) - Number(y));
  });
  return ds.length ? mean(ds) : NaN;
}

/** 集計（出力ファイルの全行から） */
export function summarizeVariant(rows: VariantRecord[]): string[] {
  const L: string[] = [];
  const d = rows.map((r) => (r.changed ? pairDiff(r.wins, r.oldWins) : 0)).filter((x) => !Number.isNaN(x));
  const games = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.subject}/${r.deck}/${r.g}/${r.seat}`;
    const x = r.changed ? pairDiff(r.wins, r.oldWins) : 0;
    games.set(k, (games.get(k) ?? 0) + (Number.isNaN(x) ? 0 : x));
  }
  const changed = rows.filter((r) => r.changed);
  L.push(
    `局面 ${rows.length}、手順が変わった ${changed.length}（${pct(changed.length / Math.max(1, rows.length))}）`,
    `差（変えた AI − 元の AI）: 全局面の平均 ${pm(d)}、変わった局面の平均 ${pm(changed.map((r) => pairDiff(r.wins, r.oldWins)).filter((x) => !Number.isNaN(x)))}、1 試合の合計 ${pm([...games.values()])}（${games.size} 試合）`,
    `変わった局面の、人間の手順との差: 元の AI ${pm(changed.map((r) => pairDiff(r.humanWins, r.oldWins)).filter((x) => !Number.isNaN(x)))}、変えた AI ${pm(changed.map((r) => pairDiff(r.humanWins, r.wins)).filter((x) => !Number.isNaN(x)))}`,
  );
  const bySubject = new Map<string, number[]>();
  for (const r of rows) {
    const x = r.changed ? pairDiff(r.wins, r.oldWins) : 0;
    if (!Number.isNaN(x)) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), x]);
  }
  L.push(`デッキ別（全局面の平均）: ${[...bySubject].map(([k, xs]) => `${k} ${pm(xs)}（変わった ${rows.filter((r) => r.subject === k && r.changed).length}）`).join("、")}`);
  return L;
}

/**
 * npm run variant-plan-value -- --base <human-plan-value の出力.jsonl> --opts '<JSON>' --out <file.jsonl> [--m 32] [--salt N] <人間の記録.jsonl>...
 * --opts は比べるデッキの AI の設定（SearchOptions の一部。リノセウスエルフは RhinoOptions。"weights" にオブジェクトを渡すと SEARCH_WEIGHTS のその項目だけを変える）。
 * --m は --base を作ったときと同じ値にする（シードを揃えるため）。並列数は環境変数 THREADS。
 * --salt に 0 以外を渡すと、AI のそのターンの乱数だけを変える（--opts '{}' と合わせると、AI の手順のばらつきだけで変わる分を測れる。
 * 差の大きい局面を選んで見ると、選んだこと自体で元の AI の手順が悪く見える（平均への回帰）ので、その対照に使う）
 */
export async function main(argv: string[]): Promise<number> {
  let out = "variant-plan-value.jsonl", M = 32, basePath = "", salt = 0;
  let opts: RhinoOptions = {};
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
    else if (k === "--base") basePath = v;
    else if (k === "--salt") salt = Number(v);
    else if (k === "--opts") {
      const raw = JSON.parse(v) as Record<string, unknown>;
      if (typeof raw.weights === "object" && raw.weights !== null) raw.weights = { ...SEARCH_WEIGHTS, ...raw.weights };
      opts = raw as RhinoOptions;
    } else throw new Error(`不明な引数: ${k}`);
  }
  if (!basePath || files.length === 0) throw new Error("--base と人間の記録（jsonl）を渡してください");
  const base = new Map<string, Map<number, HumanPlanRecord>>();
  for (const line of readFileSync(basePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as HumanPlanRecord;
    if (r.ownTurn === 0) continue;
    const k = gameKey(r);
    if (!base.has(k)) base.set(k, new Map());
    base.get(k)!.set(r.ownTurn, r);
  }
  const records: HumanGameRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = parseHumanRecord(JSON.parse(line));
      if (!r) throw new Error(`人間の記録として読めない行があります: ${f}`);
      if (base.has(gameKey(r))) records.push(r);
    }
  }
  const done = new Set<string>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      try {
        if (line) done.add(gameKey(JSON.parse(line) as VariantRecord));
      } catch {
        // 書きかけの行は飛ばす
      }
    }
  }
  const todo = records.filter((r) => !done.has(gameKey(r)));
  const t0 = Date.now();
  if (!isParallelWorker) console.log(`試合 ${todo.length}（済み ${records.length - todo.length}）、M ${M}、設定 ${JSON.stringify(opts)}`);
  await parallelMap(
    todo,
    (rec) => compareGame(rec, base.get(gameKey(rec))!, opts, M, salt).map((x) => JSON.stringify(x)),
    (n, total, lines) => {
      if (lines.length > 0) appendFileSync(out, lines.join("\n") + "\n");
      const sec = (Date.now() - t0) / 1000;
      if (n % 10 === 0 || n === total) console.log(`試合 ${n}/${total}（${sec.toFixed(0)} 秒）`);
    },
  );
  if (!isParallelWorker) {
    const rows = readFileSync(out, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as VariantRecord);
    console.log(summarizeVariant(rows).join("\n"));
  }
  return 0;
}
