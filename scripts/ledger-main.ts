// 実験の台帳（docs/ledger.jsonl）を表にする・採否の行を足す・形を確かめる（npm run ledger）。1 行の形と使い方は docs/ledger.md。
//
//   npm run ledger -- [runs] [--kind compare|yardstick] [--since 日付] [--until 日付] [--grep 文字列] [--label 文字列] [--last N]
//   npm run ledger -- sum [runs と同じ絞り込み] [--any-commit]
//   npm run ledger -- misses [--since 日付] [--until 日付] [--grep 文字列] [--label 文字列] [--last N]
//   npm run ledger -- survey [--since 日付] [--until 日付] [--grep 文字列] [--label 文字列] [--last N]
//   npm run ledger -- items [--all] [--grep 文字列] [--in-default]
//   npm run ledger -- decide --item 名前 --decision 採用|不採用|保留|やめた [--in-default true|false] [--keys a,b]
//                            [--from-label 回の名前] [--vs 比べた相手] [--ref 記録の節] [--note メモ] [--date 日付]
//   npm run ledger -- check
//
// 回の行（compare・yardstick・misses・survey）は Rust のランナーが回すたびに書く（rust/engine/src/runner/ledger.rs。survey は report のとき）。
// 採否の行（decision）はこのスクリプトの decide で足す。どれも足すだけで、前の行は書き換えない。
// 台帳のファイルは環境変数 SVWB_LEDGER か --file で替えられる。外部のコマンドは使わない。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_LEDGER = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "ledger.jsonl");

export type RunKind = "compare" | "yardstick";
export const DECISIONS = ["採用", "不採用", "保留", "やめた"] as const;
export type Decision = (typeof DECISIONS)[number];

/** compare・yardstick の 1 回 */
export interface RunRow {
  v: number;
  kind: RunKind;
  date: string;
  at: string;
  commit: string;
  branch: string;
  label: string;
  /** A の設定（JSON） */
  a: unknown;
  /** B の設定（compare は JSON、yardstick は相手の名前） */
  b: unknown;
  vs?: string | null;
  /** compare --with: そのデッキの絡む組だけ */
  with?: string | null;
  refVersion?: number;
  decks: string[];
  mirror: boolean;
  /** 最初と最後の試合番号（1 つの番号で 2 試合） */
  g: [number, number];
  n: number;
  wins: number;
  rate: number | null;
  se: number | null;
  seKind: "pairs" | "binomial";
  /** A の勝ち数が 0・1・2 の組の数 */
  pairs: [number, number, number];
  perDeck: Record<string, [number, number]>;
  seconds: number;
  perGame: number | null;
  threads: number;
  machine: string;
  cmd: string;
}

/** 採否の結果（勝率は 0〜1） */
export interface Result {
  n: number;
  rate: number;
  se: number | null;
}

/** 採否を決めた行（記録から写したもの、または decide で足したもの） */
export interface DecisionRow {
  v: number;
  kind: "decision";
  /** 決めた日（TypeScript 版のころの記録で日付が分からないものは null） */
  date: string | null;
  /** 項目の名前（同じ項目の行は、後の行が今の判定） */
  item: string;
  decision: Decision;
  /** この判定の後、今の既定に入っているか */
  inDefault: boolean;
  /** 関わる設定の名前（SearchOptions の JSON の名前等） */
  keys: string[];
  /** 比べた相手（ふつうは当時の既定） */
  vs: string;
  result: Result | null;
  /** 回の名前（decide --from-label） */
  labels: string[];
  note: string;
  /** 詳しい記録の場所（docs/ai-notes/… の節の名前） */
  ref: string;
  /** notes: 記録から写した。runs: 台帳の回から計算した。manual: 手で書いた */
  source: "notes" | "runs" | "manual";
}

/** 見落とし問題集（npm run misses -- run。docs/misses.md）の 1 回 */
export interface MissesRow {
  v: number;
  kind: "misses";
  date: string;
  at: string;
  commit: string;
  branch: string;
  label: string;
  /** AI の設定（JSON） */
  a: unknown;
  /** 問の数と問題集の指紋（指紋の違う回の正解率は比べられない） */
  problems: number;
  set: string;
  /** 1 問を打つ回数と乱数の元 */
  trials: number;
  seed: number;
  /** 打った回数（問の数 × 回数）と合格した回数 */
  n: number;
  passes: number;
  /** 正解率（問ごとの合格率の平均、0〜1）と標準誤差 */
  rate: number | null;
  se: number | null;
  /** 問ごとの [合格, 回数] */
  perProblem: Record<string, [number, number]>;
  seconds: number;
  threads: number;
  machine: string;
  cmd: string;
}

/** 候補の打ち比べ調査（npm run svwb -- survey report。docs/survey.md）の 1 回。得・大きなミスは 1 試合 1 席あたり [値, 標準誤差] */
export interface SurveyRow {
  v: number;
  kind: "survey";
  date: string;
  at: string;
  commit: string;
  branch: string;
  label: string;
  /** AI の設定（今は今の既定 {} だけ） */
  a: unknown;
  /** 最初と最後の試合番号 */
  g: [number, number];
  games: number;
  rate: number | null;
  m: number | null;
  extra: number | null;
  confirm: number | null;
  flag: number | null;
  turnStarts: number;
  positions: number;
  compared: number;
  /** 半分の回で選ぶ得（回す前に決めた決まり）: AI が読み直す候補だけで選び直す得と、足した候補を含めた得（ポイント） */
  gain4: [number | null, number | null];
  gain8: [number | null, number | null];
  /** 二段目で測る得（試しの後、本番の前に足した決まり）: 一段目で差が --flag 以上なら選び直し、二段目の回で測る。と、そのうち足した候補を選んだ局面の分 */
  gain2: [number | null, number | null];
  gain2Extra: [number | null, number | null];
  flagged: number;
  misses: number;
  missesPerGame: [number | null, number | null];
  splitAny: number | null;
  splitPair: number | null;
  pairSe: number | null;
  perRollout: number | null;
  seconds: number | null;
  /** 局面を打ったマシンとコミット */
  machines: string[];
  commits: string[];
  cmd: string;
}

export type Row = RunRow | DecisionRow | MissesRow | SurveyRow;

export interface Parsed {
  runs: RunRow[];
  decisions: DecisionRow[];
  misses: MissesRow[];
  surveys: SurveyRow[];
  errors: string[];
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isDate = (x: unknown): x is string => isStr(x) && /^\d{4}-\d{2}-\d{2}$/.test(x);
const isNumArr = (x: unknown, len: number): boolean => Array.isArray(x) && x.length === len && x.every(isNum);

function checkRun(o: Obj): string[] {
  const bad: string[] = [];
  const need = (ok: boolean, key: string) => {
    if (!ok) bad.push(key);
  };
  need(isDate(o.date), "date");
  for (const k of ["at", "commit", "branch", "label", "machine", "cmd"]) need(isStr(o[k]), k);
  need("a" in o && "b" in o, "a・b");
  need(Array.isArray(o.decks) && o.decks.every(isStr), "decks");
  need(typeof o.mirror === "boolean", "mirror");
  need(isNumArr(o.g, 2), "g");
  for (const k of ["n", "wins", "seconds", "threads"]) need(isNum(o[k]), k);
  for (const k of ["rate", "se", "perGame"]) need(o[k] === null || isNum(o[k]), k);
  need(o.seKind === "pairs" || o.seKind === "binomial", "seKind");
  need(isNumArr(o.pairs, 3), "pairs");
  need(isObj(o.perDeck) && Object.values(o.perDeck).every((x) => isNumArr(x, 2)), "perDeck");
  if (isNum(o.n) && isNum(o.wins) && o.wins > o.n) bad.push("wins > n");
  return bad;
}

function checkDecision(o: Obj): string[] {
  const bad: string[] = [];
  const need = (ok: boolean, key: string) => {
    if (!ok) bad.push(key);
  };
  need(o.date === null || isDate(o.date), "date");
  need(isStr(o.item) && o.item !== "", "item");
  need((DECISIONS as readonly unknown[]).includes(o.decision), "decision");
  need(typeof o.inDefault === "boolean", "inDefault");
  need(Array.isArray(o.keys) && o.keys.every(isStr), "keys");
  need(Array.isArray(o.labels) && o.labels.every(isStr), "labels");
  for (const k of ["vs", "note", "ref"]) need(isStr(o[k]), k);
  need(o.source === "notes" || o.source === "runs" || o.source === "manual", "source");
  const r = o.result;
  need(r === null || (isObj(r) && isNum(r.n) && isNum(r.rate) && (r.se === null || isNum(r.se))), "result");
  return bad;
}

function checkMisses(o: Obj): string[] {
  const bad: string[] = [];
  const need = (ok: boolean, key: string) => {
    if (!ok) bad.push(key);
  };
  need(isDate(o.date), "date");
  for (const k of ["at", "commit", "branch", "label", "set", "machine", "cmd"]) need(isStr(o[k]), k);
  need("a" in o, "a");
  for (const k of ["problems", "trials", "seed", "n", "passes", "seconds", "threads"]) need(isNum(o[k]), k);
  for (const k of ["rate", "se"]) need(o[k] === null || isNum(o[k]), k);
  need(isObj(o.perProblem) && Object.values(o.perProblem).every((x) => isNumArr(x, 2)), "perProblem");
  if (isNum(o.n) && isNum(o.passes) && o.passes > o.n) bad.push("passes > n");
  return bad;
}

function checkSurvey(o: Obj): string[] {
  const bad: string[] = [];
  const need = (ok: boolean, key: string) => {
    if (!ok) bad.push(key);
  };
  const numOrNull = (x: unknown) => x === null || isNum(x);
  need(isDate(o.date), "date");
  for (const k of ["at", "commit", "branch", "label", "cmd"]) need(isStr(o[k]), k);
  need("a" in o, "a");
  need(isNumArr(o.g, 2), "g");
  for (const k of ["games", "turnStarts", "positions", "compared", "flagged", "misses"]) need(isNum(o[k]), k);
  for (const k of ["rate", "m", "extra", "confirm", "flag", "splitAny", "splitPair", "pairSe", "perRollout", "seconds"]) need(numOrNull(o[k]), k);
  for (const k of ["gain4", "gain8", "gain2", "gain2Extra", "missesPerGame"]) need(Array.isArray(o[k]) && (o[k] as unknown[]).length === 2 && (o[k] as unknown[]).every(numOrNull), k);
  for (const k of ["machines", "commits"]) need(Array.isArray(o[k]) && (o[k] as unknown[]).every(isStr), k);
  return bad;
}

/** 台帳の中身を読む。形の合わない行は errors に（行番号つきで）入れて飛ばす */
export function parseLedger(text: string): Parsed {
  const out: Parsed = { runs: [], decisions: [], misses: [], surveys: [], errors: [] };
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const at = `${i + 1} 行目`;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      out.errors.push(`${at}: JSON が読めません`);
      return;
    }
    if (!isObj(o) || o.v !== 1) {
      out.errors.push(`${at}: 版（"v":1）のあるオブジェクトではありません`);
      return;
    }
    if (o.kind === "compare" || o.kind === "yardstick") {
      const bad = checkRun(o);
      if (bad.length > 0) out.errors.push(`${at}: ${bad.join("・")} が合いません`);
      else out.runs.push(o as unknown as RunRow);
    } else if (o.kind === "decision") {
      const bad = checkDecision(o);
      if (bad.length > 0) out.errors.push(`${at}: ${bad.join("・")} が合いません`);
      else out.decisions.push(o as unknown as DecisionRow);
    } else if (o.kind === "misses") {
      const bad = checkMisses(o);
      if (bad.length > 0) out.errors.push(`${at}: ${bad.join("・")} が合いません`);
      else out.misses.push(o as unknown as MissesRow);
    } else if (o.kind === "survey") {
      const bad = checkSurvey(o);
      if (bad.length > 0) out.errors.push(`${at}: ${bad.join("・")} が合いません`);
      else out.surveys.push(o as unknown as SurveyRow);
    } else {
      out.errors.push(`${at}: 知らない kind: ${String(o.kind)}`);
    }
  });
  return out;
}

export interface RunFilter {
  kind?: RunKind;
  since?: string;
  until?: string;
  /** 行の JSON のどこかに含む（大文字小文字を区別しない） */
  grep?: string;
  /** label に含む */
  label?: string;
  /** 後ろから N 回 */
  last?: number;
}

export function filterRuns<R extends RunRow | MissesRow | SurveyRow>(runs: R[], f: RunFilter): R[] {
  const g = f.grep?.toLowerCase();
  let out = runs.filter(
    (r) =>
      (f.kind === undefined || r.kind === f.kind) &&
      (f.since === undefined || r.date >= f.since) &&
      (f.until === undefined || r.date <= f.until) &&
      (f.label === undefined || r.label.includes(f.label)) &&
      (g === undefined || JSON.stringify(r).toLowerCase().includes(g)),
  );
  if (f.last !== undefined) out = out.slice(Math.max(0, out.length - f.last));
  return out;
}

/** 設定の JSON を項目の名前順にした文字列（同じ設定かを比べるため） */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (isObj(x))
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
      .join(",")}}`;
  return JSON.stringify(x) ?? "null";
}

const optsText = (x: unknown): string => (isStr(x) ? x : JSON.stringify(x));

/** B の表示（yardstick は相手の名前と版） */
function bText(r: RunRow): string {
  if (r.kind === "yardstick") return `物差し ${optsText(r.b)}${r.refVersion !== undefined ? ` ${r.refVersion}` : ""}`;
  return optsText(r.b) + (r.vs ? `（B は ${r.vs} のみ）` : "") + (r.with ? `（${r.with} の絡む組だけ）` : "");
}

/** 足し合わせてよい回の組（種類・両方の設定・デッキ・鏡・絞り込み・相手の版、any でなければコミットも同じ） */
export function groupKey(r: RunRow, anyCommit: boolean): string {
  return [
    r.kind,
    canonical(r.a),
    canonical(r.b),
    r.decks.join(","),
    r.mirror,
    r.vs ?? "",
    r.with ?? "",
    r.refVersion ?? "",
    anyCommit ? "" : r.commit,
  ].join("\u0001");
}

export interface Sum {
  runs: RunRow[];
  n: number;
  wins: number;
  rate: number;
  se: number | null;
  /** 試合番号の重なる回があるか（同じ試合を 2 回数えている） */
  overlap: boolean;
}

/** 同じ比べの回を足し合わせる（誤差は回ごとの誤差を試合数で重みを付けて合わせる。回どうしは別の試合番号の前提） */
export function sumRuns(runs: RunRow[]): Sum {
  const n = runs.reduce((s, r) => s + r.n, 0);
  const wins = runs.reduce((s, r) => s + r.wins, 0);
  const rate = n > 0 ? wins / n : Number.NaN;
  let se: number | null = 0;
  for (const r of runs) {
    if (r.se === null || se === null) {
      se = null;
      continue;
    }
    se += (r.se * r.n) ** 2;
  }
  se = se === null || n === 0 ? null : Math.sqrt(se) / n;
  const ranges = runs.map((r) => r.g).sort((x, y) => x[0] - y[0]);
  const overlap = ranges.some((r, i) => i > 0 && r[0] <= (ranges[i - 1]?.[1] ?? -1));
  return { runs, n, wins, rate, se, overlap };
}

export function groupRuns(runs: RunRow[], anyCommit: boolean): Sum[] {
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) {
    const k = groupKey(r, anyCommit);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map(sumRuns);
}

const pct = (x: number | null): string => (x === null || !Number.isFinite(x) ? "?" : `${(x * 100).toFixed(2)}%`);
const pts = (x: number | null): string => (x === null || !Number.isFinite(x) ? "?" : (x * 100).toFixed(2));
const zOf = (rate: number, se: number | null): string => (se === null || se === 0 || !Number.isFinite(rate) ? "?" : ((rate - 0.5) / se).toFixed(1));
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdownTable(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(head), `|${" --- |".repeat(head.length)}`, ...rows.map(line)].join("\n");
}

const gText = (r: RunRow): string => `${r.n}（g${r.g[0]}〜${r.g[1]}）`;

export function runsTable(runs: RunRow[]): string {
  return markdownTable(
    ["日付", "コミット", "種類", "名前", "A", "B", "試合", "A の勝率", "±", "組 2・1・0 勝", "秒/試合", "マシン"],
    runs.map((r) => [
      r.date,
      r.commit,
      r.kind,
      r.label,
      `\`${optsText(r.a)}\``,
      r.kind === "compare" ? `\`${bText(r)}\`` : bText(r),
      gText(r),
      pct(r.rate),
      pts(r.se),
      `${r.pairs[2]}・${r.pairs[1]}・${r.pairs[0]}`,
      r.perGame === null ? "?" : r.perGame.toFixed(2),
      `${r.machine}（${r.threads}）`,
    ]),
  );
}

export function sumTable(sums: Sum[]): string {
  return markdownTable(
    ["名前", "A", "B", "回", "試合", "A の勝率", "±", "z", "試合番号", "コミット"],
    sums.map((s) => {
      const first = s.runs[0];
      const labels = [...new Set(s.runs.map((r) => r.label).filter((x) => x !== ""))].join("・");
      const commits = [...new Set(s.runs.map((r) => r.commit))].join("・");
      const ranges = s.runs.map((r) => `${r.g[0]}〜${r.g[1]}`).join("・") + (s.overlap ? "（重なりあり）" : "");
      return [
        labels,
        first ? `\`${optsText(first.a)}\`` : "",
        first ? (first.kind === "compare" ? `\`${bText(first)}\`` : bText(first)) : "",
        String(s.runs.length),
        String(s.n),
        pct(s.rate),
        pts(s.se),
        zOf(s.rate, s.se),
        ranges,
        commits,
      ];
    }),
  );
}

/** 見落とし問題集の回の表（問ごとの合格は「名前 合格/回数」） */
export function missesTable(rows: MissesRow[]): string {
  return markdownTable(
    ["日付", "コミット", "名前", "設定", "問（指紋）", "回数", "正解率", "±", "問ごと", "秒", "マシン"],
    rows.map((r) => [
      r.date,
      r.commit,
      r.label,
      `\`${optsText(r.a)}\``,
      `${r.problems}（${r.set}）`,
      `${r.trials}（乱数 ${r.seed}）`,
      pct(r.rate),
      pts(r.se),
      Object.entries(r.perProblem)
        .map(([k, [w, t]]) => `${k} ${w}/${t}`)
        .join("、"),
      r.seconds.toFixed(0),
      `${r.machine}（${r.threads}）`,
    ]),
  );
}

/** 候補の打ち比べ調査の回の表（得・大きなミスは 1 試合 1 席あたり） */
export function surveyTable(rows: SurveyRow[]): string {
  const pm = ([m, se]: [number | null, number | null], f: number) =>
    m === null ? "-" : se === null ? m.toFixed(f) : `${m.toFixed(f)} ± ${se.toFixed(f)}`;
  return markdownTable(
    ["日付", "コミット", "名前", "試合", "局面（打ち比べた）", "二段目で測る得", "うち足した候補", "半分で選ぶ得（読み直す候補だけ）", "（足した候補も）", "大きなミス", "大きなミス（1 試合 1 席）", "続き 1 試合の秒", "マシン"],
    rows.map((r) => [
      r.date,
      r.commits.join("・") || r.commit,
      r.label,
      `${r.games}（g${r.g[0]}〜${r.g[1]}）`,
      `${r.positions}（${r.compared}）`,
      pm(r.gain2, 2),
      pm(r.gain2Extra, 2),
      pm(r.gain4, 2),
      pm(r.gain8, 2),
      `${r.misses}（二段目 ${r.flagged}）`,
      pm(r.missesPerGame, 3),
      r.perRollout === null ? "-" : r.perRollout.toFixed(2),
      r.machines.join("・"),
    ]),
  );
}

/** 項目ごとの最後の行（今の判定）。all なら全部 */
export function latestDecisions(rows: DecisionRow[], all: boolean): DecisionRow[] {
  if (all) return rows;
  const last = new Map<string, DecisionRow>();
  for (const r of rows) {
    last.delete(r.item);
    last.set(r.item, r);
  }
  return [...last.values()];
}

export function resultText(r: Result | null): string {
  if (r === null) return "";
  return `${pct(r.rate)}${r.se === null ? "" : ` ± ${pts(r.se)}`}（${r.n} 試合${r.se === null ? "" : `、z ${zOf(r.rate, r.se)}`}）`;
}

export function itemsTable(rows: DecisionRow[]): string {
  return markdownTable(
    ["項目", "判定", "既定", "日付", "結果", "比べた相手", "設定", "記録"],
    rows.map((r) => [
      r.item,
      r.decision,
      r.inDefault ? "入っている" : "",
      r.date ?? "?",
      [resultText(r.result), r.note].filter((x) => x !== "").join("。"),
      r.vs,
      r.keys.map((k) => `\`${k}\``).join("・"),
      r.ref,
    ]),
  );
}

/** decide --from-label: その名前の回を足し合わせた結果（同じ比べの回でなければエラー） */
export function resultFromLabel(runs: RunRow[], label: string): { result: Result; runs: RunRow[] } {
  const hit = runs.filter((r) => r.label === label);
  if (hit.length === 0) throw new Error(`名前が ${label} の回がありません`);
  const groups = groupRuns(hit, true);
  if (groups.length > 1) throw new Error(`名前が ${label} の回に、違う比べ（設定・デッキ・相手）が混ざっています（${groups.length} 組）`);
  const s = groups[0];
  if (!s) throw new Error("回がありません");
  if (s.overlap) throw new Error(`名前が ${label} の回の試合番号が重なっています（同じ試合を 2 回数えないよう、名前を分けます）`);
  return { result: { n: s.n, rate: s.wins / s.n, se: s.se }, runs: s.runs };
}

function localDate(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** decide で足す行 */
export function decisionRow(
  opts: {
    item: string;
    decision: Decision;
    inDefault: boolean;
    keys: string[];
    vs: string;
    note: string;
    ref: string;
    date: string;
    fromLabel: string | null;
  },
  runs: RunRow[],
): DecisionRow {
  let result: Result | null = null;
  let labels: string[] = [];
  let vs = opts.vs;
  if (opts.fromLabel !== null) {
    const r = resultFromLabel(runs, opts.fromLabel);
    result = r.result;
    labels = [opts.fromLabel];
    const first = r.runs[0];
    if (vs === "" && first) vs = first.kind === "compare" ? `A ${optsText(first.a)} 対 B ${bText(first)}` : `${optsText(first.a)} 対 ${bText(first)}`;
  }
  return {
    v: 1,
    kind: "decision",
    date: opts.date,
    item: opts.item,
    decision: opts.decision,
    inDefault: opts.inDefault,
    keys: opts.keys,
    vs,
    result,
    labels,
    note: opts.note,
    ref: opts.ref,
    source: opts.fromLabel !== null ? "runs" : "manual",
  };
}

const USAGE = `使い方（docs/ledger.md）:
  npm run ledger -- [runs] [--kind compare|yardstick] [--since 日付] [--until 日付] [--grep 文字列] [--label 文字列] [--last N]
  npm run ledger -- sum [runs と同じ絞り込み] [--any-commit]
  npm run ledger -- misses [--since 日付] [--until 日付] [--grep 文字列] [--label 文字列] [--last N]
  npm run ledger -- survey [--since 日付] [--until 日付] [--grep 文字列] [--label 文字列] [--last N]
  npm run ledger -- items [--all] [--grep 文字列] [--in-default]
  npm run ledger -- decide --item 名前 --decision 採用|不採用|保留|やめた [--in-default true|false] [--keys a,b]
                           [--from-label 回の名前] [--vs 比べた相手] [--ref 記録の節] [--note メモ] [--date 日付]
  npm run ledger -- check
  （どれも --file 台帳 で別のファイルを読む。既定は環境変数 SVWB_LEDGER か docs/ledger.jsonl）`;

const FLAGS = new Set(["--all", "--any-commit"]);

/** 引数を { 名前: 値 } にする（値の要らない名前は "true"） */
function parseArgs(argv: string[]): { cmd: string; opts: Map<string, string> } {
  const opts = new Map<string, string>();
  let cmd = "runs";
  let i = 0;
  if (argv[0] !== undefined && !argv[0].startsWith("--")) {
    cmd = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new Error(`知らない引数: ${a}`);
    // items の --in-default は値なし、decide の --in-default は true|false
    if (FLAGS.has(a) || (a === "--in-default" && cmd === "items")) {
      opts.set(a, "true");
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${a} の値がありません`);
    opts.set(a, v);
    i++;
  }
  return { cmd, opts };
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { cmd, opts } = parsed;
  const file = opts.get("--file") ?? (process.env.SVWB_LEDGER || DEFAULT_LEDGER);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const ledger = parseLedger(text);
  for (const e of ledger.errors) console.error(`注意: ${file} ${e}`);
  const known = (names: string[]) => {
    const bad = [...opts.keys()].filter((k) => k !== "--file" && !names.includes(k));
    if (bad.length > 0) throw new Error(`${cmd} で使えない引数: ${bad.join(" ")}`);
  };
  try {
    const filter = (): RunFilter => {
      const f: RunFilter = {};
      const kind = opts.get("--kind");
      if (kind !== undefined) {
        if (kind !== "compare" && kind !== "yardstick") throw new Error(`--kind は compare か yardstick: ${kind}`);
        f.kind = kind;
      }
      const since = opts.get("--since");
      if (since !== undefined) f.since = since;
      const until = opts.get("--until");
      if (until !== undefined) f.until = until;
      const grep = opts.get("--grep");
      if (grep !== undefined) f.grep = grep;
      const label = opts.get("--label");
      if (label !== undefined) f.label = label;
      const last = opts.get("--last");
      if (last !== undefined) f.last = Number(last);
      return f;
    };
    const runFlags = ["--kind", "--since", "--until", "--grep", "--label", "--last"];
    switch (cmd) {
      case "runs":
        known(runFlags);
        console.log(runsTable(filterRuns(ledger.runs, filter())));
        return 0;
      case "sum":
        known([...runFlags, "--any-commit"]);
        console.log(sumTable(groupRuns(filterRuns(ledger.runs, filter()), opts.has("--any-commit"))));
        return 0;
      case "misses":
        known(runFlags.filter((k) => k !== "--kind"));
        console.log(missesTable(filterRuns(ledger.misses, filter())));
        return 0;
      case "survey":
        known(runFlags.filter((k) => k !== "--kind"));
        console.log(surveyTable(filterRuns(ledger.surveys, filter())));
        return 0;
      case "items": {
        known(["--all", "--grep", "--in-default"]);
        const g = opts.get("--grep")?.toLowerCase();
        let rows = latestDecisions(ledger.decisions, opts.has("--all"));
        if (g !== undefined) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(g));
        if (opts.has("--in-default")) rows = rows.filter((r) => r.inDefault);
        console.log(itemsTable(rows));
        return 0;
      }
      case "decide": {
        known(["--item", "--decision", "--in-default", "--keys", "--from-label", "--vs", "--ref", "--note", "--date"]);
        const item = opts.get("--item");
        const decision = opts.get("--decision");
        if (!item) throw new Error("--item で項目の名前を渡します");
        if (!(DECISIONS as readonly string[]).includes(decision ?? "")) throw new Error(`--decision は ${DECISIONS.join("・")} のどれか`);
        const inDefaultText = opts.get("--in-default") ?? (decision === "採用" ? "true" : "false");
        if (inDefaultText !== "true" && inDefaultText !== "false") throw new Error("--in-default は true か false");
        const date = opts.get("--date") ?? localDate(new Date());
        if (!isDate(date)) throw new Error(`--date は YYYY-MM-DD: ${date}`);
        const row = decisionRow(
          {
            item,
            decision: decision as Decision,
            inDefault: inDefaultText === "true",
            keys: (opts.get("--keys") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
            vs: opts.get("--vs") ?? "",
            note: opts.get("--note") ?? "",
            ref: opts.get("--ref") ?? "",
            date,
            fromLabel: opts.get("--from-label") ?? null,
          },
          ledger.runs,
        );
        appendFileSync(file, `${JSON.stringify(row)}\n`);
        console.log(`${file} に 1 行足しました:\n${itemsTable([row])}`);
        return 0;
      }
      case "check":
        known([]);
        console.log(
          `${file}: 回 ${ledger.runs.length} 行・見落とし問題集 ${ledger.misses.length} 行・打ち比べ調査 ${ledger.surveys.length} 行・採否 ${ledger.decisions.length} 行・合わない行 ${ledger.errors.length}`,
        );
        return ledger.errors.length > 0 ? 1 : 0;
      default:
        throw new Error(`知らないサブコマンド: ${cmd}`);
    }
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
