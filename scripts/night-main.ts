// 夜のキュー: ジョブを並べたファイルを上から順に、5〜10 分の区切りに分けて回す（npm run night）。運用は docs/night.md。
//
//   npm run night -- plan <ジョブのファイル> [--until 07:00] [--threads N] [--machine 名前] [--chunk-min 7.5] [--tz Asia/Tokyo]
//   npm run night -- start <ジョブのファイル> --yes [--name 名前] [--until 07:00] [--threads N] [--chunk-min 7.5] [--allow-dirty]
//   npm run night -- status [名前]
//   npm run night -- stop [名前] [--now]
//   npm run night -- resume [名前] --yes [--until 07:00] [--threads N]
//   npm run night -- finish [名前] [--commit] [--pack] [--ledger 台帳]
//   npm run night -- list
//
// - ジョブのファイルは 1 行 1 ジョブで、svwb のコマンドと同じ形（compare・yardstick・profile・misses）。# から行の終わりまでは書き添え
// - 回は ~/svwb-data/night/<名前>/ に置く（環境変数 SVWB_NIGHT_DIR か --root で替えられる）。区切りが済むたびに印を書き、
//   やり直したときは済んだ区切りを飛ばす。電源が切れても、失うのは回していた区切りだけ
// - start・resume は、組み立てた svwb を回のフォルダに写し、セッションから切り離した worker を立てて、すぐに戻る。
//   PC やコンテナの起動で勝手には始めない（始めるのは start・resume だけ）
// - 止める時刻（--until）までに次の区切りが終わらない見込みなら、区切りの切れ目で止まる。stop で手で止める（--now ならすぐ）
// - 区切りの結果は回のフォルダの台帳（ledger.jsonl）にだけ書く。finish がジョブごとに 1 行にまとめて、リポジトリの台帳に足す

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_LEDGER, canonical, markdownTable, parseLedger, type MissesRow, type RunRow, type SurveyRow } from "./ledger-main.ts";

/** リポジトリの根 */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
/** 止める時刻を過ぎても終わらない区切りを、ここまで待ってから止める（秒） */
const HARD_GRACE = 15 * 60;

// ---------------------------------------------------------------- ジョブのファイル

export type JobSpec =
  | { kind: "compare"; a: string; b: string; vs: string | null; noMirror: boolean; decks: string | null }
  | { kind: "yardstick"; ref: "classic" | "strong"; opts: string }
  | { kind: "profile"; opts: string; rhino: boolean }
  /** 見落とし問題集（docs/misses.md）。games は 1 問を打つ回数（--trials） */
  | { kind: "misses"; opts: string; seed: number }
  /** 候補の打ち比べ調査（docs/survey.md）。games は自己対戦の試合の数（1 つの番号で 1 試合） */
  | { kind: "survey"; rate: number; m: number; extra: number; confirm: number; flag: number; batch: number };

export interface Job {
  /** ファイルの中のジョブの番号（1 から） */
  index: number;
  /** ファイルの行（書き添えを除く） */
  line: string;
  /** 台帳の名前（--label）。profile は空でもよい */
  label: string;
  /** 試合番号の数（1 つの番号で席とデッキを入れ替えて 2 試合。survey は 1 試合）と、最初の番号。misses は 1 問を打つ回数と 0 */
  games: number;
  start: number;
  /** --est: 1 試合の見込みの秒（回すマシン・並列数で。キューだけが読む） */
  est: number | null;
  spec: JobSpec;
}

/** シェルと同じ形で語に分ける（'…' はそのまま、"…" は \" と \\ だけ解く。語の頭の # から後ろは書き添え） */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new Error("' が閉じていません");
      cur += line.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (c === '"') {
      has = true;
      i++;
      for (;;) {
        if (i >= line.length) throw new Error('" が閉じていません');
        const d = line[i] ?? "";
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
          cur += line[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new Error("行の終わりに \\ があります");
      cur += line[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (c === "#" && !has) {
      break;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** シェルにそのまま貼れる形に並べる（rust/engine/src/runner/ledger.rs の shell_line と同じ。台帳の cmd と比べる） */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (a !== "" && /^[A-Za-z0-9_./,:=+\-@%]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function intOf(s: string, what: string, min: number): number {
  if (!/^\d+$/.test(s) || Number(s) < min) throw new Error(`${what} は ${min} 以上の整数: ${s}`);
  return Number(s);
}

function jsonObject(s: string, what: string): string {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new Error(`${what} が JSON として読めません: ${s}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} は JSON のオブジェクト: ${s}`);
  return s;
}

/** ジョブの 1 行を読む（行の頭の svwb は飛ばす） */
export function parseJob(line: string, index: number): Job {
  let words = shellWords(line);
  if (words[0] === "svwb") words = words.slice(1);
  const kind = words[0];
  const rest = words.slice(1);
  const take = (name: string): string | null => {
    const i = rest.indexOf(name);
    if (i < 0) return null;
    const v = rest[i + 1];
    if (v === undefined) throw new Error(`${name} の値がありません`);
    rest.splice(i, 2);
    if (rest.includes(name)) throw new Error(`${name} が 2 回あります`);
    return v;
  };
  const flag = (name: string): boolean => {
    const i = rest.indexOf(name);
    if (i < 0) return false;
    rest.splice(i, 1);
    return true;
  };
  const refuse = (names: string[], why: string) => {
    for (const n of names) if (rest.includes(n)) throw new Error(`キューでは ${n} は使えません（${why}）`);
  };
  const estText = take("--est");
  const est = estText === null ? null : Number(estText);
  if (est !== null && !(est > 0)) throw new Error(`--est は 1 試合の秒（正の数）: ${estText}`);
  const noUnknown = () => {
    const bad = rest.filter((x) => x.startsWith("--"));
    if (bad.length > 0) throw new Error(`知らない引数: ${bad.join(" ")}`);
  };
  const text = line.trim();
  switch (kind) {
    case "compare": {
      refuse(["--no-ledger"], "結果は台帳から集める");
      refuse(["--replays"], "区切りごとにファイルが替わる");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます（区切りの結果を後で足し合わせるため）");
      const noMirror = flag("--no-mirror");
      const decks = take("--decks");
      noUnknown();
      const [g, a = "{}", b = "{}", s = "0", vs, ...extra] = rest;
      if (g === undefined) throw new Error("compare の試合数（1 つ目の引数）がありません");
      if (extra.length > 0) throw new Error(`多すぎる引数: ${extra.join(" ")}`);
      return {
        index,
        line: text,
        label,
        games: intOf(g, "試合数", 1),
        start: intOf(s, "最初の試合番号", 0),
        est,
        spec: { kind, a: jsonObject(a, "A の設定"), b: jsonObject(b, "B の設定"), vs: vs === undefined || vs === "" ? null : vs, noMirror, decks },
      };
    }
    case "yardstick": {
      refuse(["--no-ledger"], "結果は台帳から集める");
      refuse(["--record"], "物差しの表に足すのは、終わった後に足し合わせた数字で");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます（区切りの結果を後で足し合わせるため）");
      const ref = take("--ref") ?? "classic";
      if (ref !== "classic" && ref !== "strong") throw new Error(`--ref は classic か strong: ${ref}`);
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const games = intOf(take("--games") ?? "1000", "--games", 1);
      const start = intOf(take("--start") ?? "0", "--start", 0);
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games, start, est, spec: { kind, ref, opts } };
    }
    case "profile": {
      refuse(["--json", "--report"], "キューが回のフォルダに書く");
      refuse(["--baseline", "--record"], "終わった後に手で");
      const label = take("--label") ?? "";
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const games = intOf(take("--games") ?? "49", "--games", 1);
      const start = intOf(take("--start") ?? "0", "--start", 0);
      const rhino = flag("--rhino");
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games, start, est, spec: { kind, opts, rhino } };
    }
    case "misses": {
      // 行の頭の run は書いても書かなくてもよい
      if (rest[0] === "run") rest.splice(0, 1);
      refuse(["--no-ledger"], "結果は台帳から集める");
      refuse(["--only", "--dir", "--out"], "問題集全体を、決まった場所で解く");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます");
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const games = intOf(take("--trials") ?? "24", "--trials", 1);
      const seed = intOf(take("--seed") ?? "1", "--seed", 0);
      take("--lines");
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games, start: 0, est, spec: { kind, opts, seed } };
    }
    case "survey": {
      // 行の頭の run は書いても書かなくてもよい。試合は --games a-b（svwb survey run と同じ）か --games N [--start S]
      if (rest[0] === "run") rest.splice(0, 1);
      refuse(["--out"], "キューが回のフォルダに書く");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます（朝の finish が survey report でこの名前の行を 1 つ足す）");
      const gamesText = take("--games");
      if (gamesText === null) throw new Error("survey は --games a-b で試合番号の範囲を渡します");
      const startText = take("--start");
      let games: number;
      let start: number;
      const range = /^(\d+)-(\d+)$/.exec(gamesText);
      if (range) {
        if (startText !== null) throw new Error("--games a-b と --start は一緒に使えません");
        start = Number(range[1]);
        games = Number(range[2]) - start + 1;
        if (games < 1) throw new Error(`--games は a ≤ b: ${gamesText}`);
      } else {
        games = intOf(gamesText, "--games", 1);
        start = intOf(startText ?? "0", "--start", 0);
      }
      const num = (name: string, def: number, ok: (x: number) => boolean, what: string): number => {
        const t = take(name);
        if (t === null) return def;
        const x = Number(t);
        if (t.trim() === "" || !Number.isFinite(x) || !ok(x)) throw new Error(`${name} は ${what}: ${t}`);
        return x;
      };
      const rate = num("--rate", 0.1, (x) => x > 0 && x <= 1, "0 より大きく 1 以下");
      const m = num("--m", 32, (x) => Number.isInteger(x) && x >= 2, "2 以上の整数");
      const extra = num("--extra", 4, (x) => Number.isInteger(x) && x >= 0, "0 以上の整数");
      const confirm = num("--confirm", 96, (x) => Number.isInteger(x) && x >= 0, "0 以上の整数");
      const flagPts = num("--flag", 10, (x) => x >= 0, "0 以上の数");
      const batch = num("--batch", 8, (x) => Number.isInteger(x) && x >= 1, "1 以上の整数");
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games, start, est, spec: { kind, rate, m, extra, confirm, flag: flagPts, batch } };
    }
    default:
      throw new Error(`ジョブは compare・yardstick・profile・misses・survey のどれか: ${kind ?? "（空）"}`);
  }
}

/** ジョブのファイルを読む（空の行と # で始まる行は飛ばす） */
export function parseJobs(text: string): Job[] {
  const jobs: Job[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    try {
      jobs.push(parseJob(line, jobs.length + 1));
    } catch (e) {
      throw new Error(`${i + 1} 行目: ${(e as Error).message}`);
    }
  });
  if (jobs.length === 0) throw new Error("ジョブがありません");
  return jobs;
}

/** 試合番号 first から count 個を回す svwb の引数（dir は profile の結果を書く回のフォルダ） */
export function jobArgv(job: Job, first: number, count: number, dir: string): string[] {
  const s = job.spec;
  switch (s.kind) {
    case "compare":
      return [
        "compare",
        String(count),
        s.a,
        s.b,
        String(first),
        ...(s.vs === null ? [] : [s.vs]),
        ...(s.noMirror ? ["--no-mirror"] : []),
        ...(s.decks === null ? [] : ["--decks", s.decks]),
        "--label",
        job.label,
      ];
    case "yardstick":
      return ["yardstick", "--ref", s.ref, "--opts", s.opts, "--games", String(count), "--start", String(first), "--label", job.label];
    case "profile":
      return [
        "profile",
        "--opts",
        s.opts,
        "--games",
        String(count),
        "--start",
        String(first),
        ...(s.rhino ? ["--rhino"] : []),
        "--json",
        join(dir, `speed-${job.index}.json`),
        "--report",
        join(dir, `speed-${job.index}.md`),
      ];
    case "misses":
      return ["misses", "run", "--opts", s.opts, "--trials", String(count), "--seed", String(s.seed), "--label", job.label];
    case "survey":
      // 出力はジョブで 1 つ（svwb survey run は出力に既にある試合を飛ばすので、止めた区切りは回し直せば続きから）
      return [
        "survey",
        "run",
        "--out",
        surveyFile(dir, job),
        "--games",
        `${first}-${first + count - 1}`,
        "--rate",
        String(s.rate),
        "--m",
        String(s.m),
        "--extra",
        String(s.extra),
        "--confirm",
        String(s.confirm),
        "--flag",
        String(s.flag),
        "--batch",
        String(s.batch),
      ];
  }
}

/** survey のジョブの出力（回のフォルダの中） */
export function surveyFile(dir: string, job: Job): string {
  return join(dir, `survey-${job.index}.jsonl`);
}

/** count（区切りの大きさ）が何試合か。misses は「全部の問を 1 回ずつ」を 1 と数える（見込みの 1 試合の秒も、その 1 回の秒）。
 * survey は 1 つの番号で 1 試合（見込みの 1 試合の秒は、その試合から取った局面の打ち比べを含む） */
export function unitsOf(job: Job, count: number): number {
  return job.spec.kind === "misses" || job.spec.kind === "survey" ? count : 2 * count;
}

/** survey の既定（docs/survey.md）と違う設定だけを並べる */
function surveyOpts(s: Extract<JobSpec, { kind: "survey" }>): string {
  const def = { rate: 0.1, m: 32, extra: 4, confirm: 96, flag: 10 };
  return (Object.keys(def) as (keyof typeof def)[])
    .filter((k) => s[k] !== def[k])
    .map((k) => `--${k} ${s[k]}`)
    .join(" ");
}

/** ジョブの短い名前（表に出す） */
export function jobTitle(job: Job): string {
  const s = job.spec;
  if (s.kind === "compare") return `compare A ${s.a} 対 B ${s.b}${s.vs ? `（B は ${s.vs}）` : ""}${s.noMirror ? "（鏡なし）" : ""}`;
  if (s.kind === "yardstick") return `yardstick ${s.ref}${s.opts === "{}" ? "" : ` ${s.opts}`}`;
  if (s.kind === "misses") return `misses（見落とし問題集）${s.opts === "{}" ? "" : ` ${s.opts}`}`;
  if (s.kind === "survey") return `survey（候補の打ち比べ）${surveyOpts(s) === "" ? "" : ` ${surveyOpts(s)}`}`;
  return `profile（速さ）${s.opts === "{}" ? "" : ` ${s.opts}`}${s.rhino ? " --rhino" : ""}`;
}

// ---------------------------------------------------------------- 見積もりと区切り

type SpeedKey = "compare" | "classic" | "strong" | "profile" | "misses" | "survey";

/** 決めておいた速さ（1 試合あたりのスレッド秒 = 1 試合の秒 × 並列数。今の既定の探索 AI で）。台帳に同じ比べ・同じマシンの回が無いときに使う。
 * misses は全部の問を 1 回ずつ解く秒（10 問のとき。問が増えればその分かかる） */
export const SPEEDS: Record<string, { threads: number; note: string; ts: Record<SpeedKey, number> }> = {
  // ユーザーの PC（Core i7-14700F、28 スレッド。Docker の svwb-docker）。compare は 3200 試合 5 分ほど、物差しは docs/yardstick.md の「（PC）」の行。
  // misses・survey は測っていないので、クラウド環境の値に compare の比（2.6 / 2.0）を掛けた
  "svwb-docker": { threads: 28, note: "PC の決めておいた値", ts: { compare: 2.6, classic: 1.3, strong: 2.7, profile: 2.6, misses: 5.9, survey: 860 } },
  // Claude のクラウド環境（4 スレッド）で 2026-11-10 に測った値（compare 0.50・弱い相手 0.21・強い相手 0.44 秒/試合、各 56 試合。
  // misses は 10 問 × 24 回が 27 秒。survey は 2026-11-11 の試し 2（10 試合・15 局面、読み直しを打ち切った候補を入れた後）で 1 局面 328 秒、局面の割合 0.1 で 1 試合 2.0 局面として）。
  // ほかのマシンもこれで見積もる
  default: { threads: 4, note: "クラウド環境の決めておいた値", ts: { compare: 2.0, classic: 0.85, strong: 1.8, profile: 2.0, misses: 4.5, survey: 660 } },
};

export interface Estimate {
  /** 1 試合の秒（そのマシン・並列数で） */
  perGame: number;
  /** どこから見積もったか */
  source: string;
}

/** ジョブと同じ比べの、台帳の回か（種類・両方の設定・絞り込み・鏡・相手） */
function sameComparison(job: Job, r: RunRow): boolean {
  const s = job.spec;
  if (s.kind === "compare") {
    return (
      r.kind === "compare" &&
      canonical(r.a) === canonical(JSON.parse(s.a)) &&
      canonical(r.b) === canonical(JSON.parse(s.b)) &&
      (r.vs ?? null) === s.vs &&
      r.mirror === !s.noMirror &&
      (s.decks === null) === (r.decks.length === 7 && !r.cmd.includes("--decks"))
    );
  }
  if (s.kind === "yardstick") return r.kind === "yardstick" && r.b === s.ref && canonical(r.a) === canonical(JSON.parse(s.opts));
  return false;
}

/** 1 試合の秒を見積もる（--est → 台帳の同じ比べ・同じマシンの最近の回 → 決めておいた値）。misses は全部の問を 1 回ずつ解く秒 */
export function estimate(job: Job, runs: RunRow[], machine: string, threads: number, misses: MissesRow[] = []): Estimate {
  if (job.est !== null) return { perGame: job.est, source: "--est" };
  const mhit = job.spec.kind === "misses" ? misses.filter((r) => r.machine === machine && r.trials > 0 && r.seconds > 0).slice(-5) : [];
  const mlast = mhit[mhit.length - 1];
  if (mlast) {
    // 問の数が変わっていれば、問の数で割り直す
    const now = mlast.problems;
    const perRound = (r: MissesRow) => ((r.seconds / r.trials) * r.threads * now) / Math.max(1, r.problems);
    return {
      perGame: mhit.reduce((s, r) => s + perRound(r), 0) / mhit.length / threads,
      source: `台帳（${machine}・${mlast.date}・${mhit.length} 回）`,
    };
  }
  const hit = runs.filter((r) => r.machine === machine && r.n > 0 && r.seconds > 0 && sameComparison(job, r)).slice(-5);
  if (hit.length > 0) {
    const last = hit[hit.length - 1];
    const same = hit.filter((r) => r.threads === threads);
    const n = (xs: RunRow[]) => xs.reduce((s, r) => s + r.n, 0);
    const perGame =
      same.length > 0
        ? same.reduce((s, r) => s + r.seconds, 0) / n(same)
        : hit.reduce((s, r) => s + r.seconds * r.threads, 0) / n(hit) / threads;
    return { perGame, source: `台帳（${machine}・${last?.date ?? "?"}・${n(hit)} 試合${same.length > 0 ? "" : "・並列数で割り直し"}）` };
  }
  const sp = SPEEDS[machine] ?? SPEEDS.default;
  if (!sp) throw new Error("決めておいた速さがありません");
  const s = job.spec;
  const key: SpeedKey = s.kind === "yardstick" ? s.ref : s.kind;
  if (s.kind === "survey") {
    // 決めておいた値は既定の設定（docs/survey.md）のもの。局面の割合には比べて、ほかの設定の違いは見ない
    const other = surveyOpts({ ...s, rate: 0.1 }) !== "";
    return { perGame: (sp.ts.survey * (s.rate / 0.1)) / threads, source: `${sp.note}${other ? "（局面の割合のほかの設定の違いは見ていない）" : ""}` };
  }
  const plain = s.kind === "compare" ? s.a === "{}" && s.b === "{}" && s.decks === null : s.opts === "{}";
  if (s.kind === "misses") return { perGame: sp.ts.misses / threads, source: `${sp.note}（10 問のとき）` };
  return { perGame: sp.ts[key] / threads, source: `${sp.note}${plain ? "" : "（設定の違いは見ていない）"}` };
}

export interface Chunk {
  /** "<ジョブの番号>-<区切りの番号>"（どちらも 1 から） */
  id: string;
  job: number;
  k: number;
  first: number;
  count: number;
}

/** ジョブを、1 つが targetSec 秒ほどの区切りに分ける（大きさはそろえる。profile・misses は分けない） */
export function chunkJob(job: Job, perGame: number, targetSec: number): Chunk[] {
  const per = job.spec.kind === "profile" || job.spec.kind === "misses" ? job.games : Math.max(1, Math.floor(targetSec / (unitsOf(job, 1) * perGame)));
  const n = Math.ceil(job.games / per);
  const size = Math.ceil(job.games / n);
  const out: Chunk[] = [];
  for (let k = 0; k * size < job.games; k++) {
    out.push({ id: `${job.index}-${k + 1}`, job: job.index, k: k + 1, first: job.start + k * size, count: Math.min(size, job.games - k * size) });
  }
  return out;
}

// ---------------------------------------------------------------- 時刻

/** 時刻帯 tz での年月日・時分秒 */
export function wallClock(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

const p2 = (x: number) => String(x).padStart(2, "0");

/** "11-11 07:00"（時刻帯 tz で） */
export function fmtClock(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${p2(w.mo)}-${p2(w.d)} ${p2(w.h)}:${p2(w.mi)}`;
}

/** "1 時間 5 分" */
export function fmtDur(sec: number): string {
  if (!Number.isFinite(sec)) return "?";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 時間${m % 60 === 0 ? "" : ` ${m % 60} 分`}`;
}

/** --until: "HH:MM"（時刻帯 tz で次に来るその時刻）、"+90m"・"+2h"（今から）、または ISO の日時 */
export function parseUntil(text: string, now: number, tz: string): number {
  const rel = /^\+(\d+(?:\.\d+)?)(s|m|h)$/.exec(text);
  if (rel) return now + Number(rel[1]) * { s: 1, m: 60, h: 3600 }[rel[2] as "s" | "m" | "h"] * 1000;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hm) {
    const w = wallClock(now, tz);
    let diff = Number(hm[1]) * 60 + Number(hm[2]) - (w.h * 60 + w.mi) - w.s / 60;
    if (diff <= 0) diff += 24 * 60;
    return now + Math.round(diff * 60) * 1000 - (now % 1000);
  }
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`--until は HH:MM・+90m・+2h・ISO の日時: ${text}`);
  return t;
}

// ---------------------------------------------------------------- 回のフォルダ

export interface Plan {
  v: 1;
  name: string;
  /** 作った時刻（ISO） */
  created: string;
  /** リポジトリの根（svwb を回す場所。設定の中のファイルの道はここから） */
  repo: string;
  jobsFile: string;
  commit: string;
  branch: string;
  /** 回す svwb（回のフォルダに写したもの） */
  bin: string;
  chunkMin: number;
  jobs: Job[];
  estimates: Estimate[];
  chunks: Chunk[];
}

/** 1 回の start・resume の設定 */
export interface Session {
  /** 始めた時刻と止める時刻（ミリ秒） */
  started: number;
  until: number;
  tz: string;
  threads: number;
  machine: string;
}

/** 区切りが済んだ印 */
interface Marker {
  id: string;
  seconds: number;
  /** 済んだ時刻（ISO） */
  at: string;
  /** 回したスレッド数（速さの見込みは、同じスレッド数の区切りだけから） */
  threads: number;
  /** 台帳の行から作り直した印か */
  recovered?: boolean;
}

export interface Status {
  state: "running" | "stopped" | "done";
  reason: string;
  /** 書いた時刻（ミリ秒） */
  at: number;
  current: { id: string; since: number } | null;
}

export const runsRoot = (opt?: string): string => resolve(opt ?? (process.env.SVWB_NIGHT_DIR || join(homedir(), "svwb-data", "night")));

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** 書きかけを残さないよう、.tmp に書いて fsync してから名前を替える */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function fsyncFile(file: string): void {
  if (!existsSync(file)) return;
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const readPlan = (dir: string): Plan => readJson<Plan>(join(dir, "plan.json"));
export const readSession = (dir: string): Session => readJson<Session>(join(dir, "session.json"));
export function readStatus(dir: string): Status | null {
  const f = join(dir, "status.json");
  return existsSync(f) ? readJson<Status>(f) : null;
}

function writeStatus(dir: string, s: Omit<Status, "at">): void {
  writeAtomic(join(dir, "status.json"), JSON.stringify({ ...s, at: Date.now() }));
}

function log(dir: string, tz: string, text: string): void {
  appendFileSync(join(dir, "night.log"), `${fmtClock(Date.now(), tz)} ${text}\n`);
}

function markers(dir: string): Map<string, Marker> {
  const out = new Map<string, Marker>();
  const d = join(dir, "done");
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = readJson<Marker>(join(d, f));
      out.set(m.id, m);
    } catch {
      // 書きかけ（電源が切れた等）は済んでいないものとする
    }
  }
  return out;
}

function writeMarker(dir: string, m: Marker): void {
  mkdirSync(join(dir, "done"), { recursive: true });
  writeAtomic(join(dir, "done", `${m.id}.json`), JSON.stringify(m));
}

/** 回のフォルダの台帳の行（区切りごと） */
export function chunkRows(dir: string): RunRow[] {
  const f = join(dir, "ledger.jsonl");
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")).runs : [];
}

/** 回のフォルダの台帳の、見落とし問題集の行 */
function chunkMisses(dir: string): MissesRow[] {
  const f = join(dir, "ledger.jsonl");
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")).misses : [];
}

/** 区切りの台帳の行（同じ引数で回した行） */
function rowOf<R extends { cmd: string }>(rows: R[], plan: Plan, dir: string, c: Chunk): R | undefined {
  const job = plan.jobs[c.job - 1];
  if (!job) return undefined;
  const cmd = shellLine(jobArgv(job, c.first, c.count, dir));
  return rows.find((r) => r.cmd === cmd);
}

/** survey の出力にある試合と局面の数（試合の行のある試合だけ。途中で止めた試合の局面は数えない） */
export function surveyProgress(file: string): { games: Set<number>; positions: number } {
  const games = new Set<number>();
  const pos: number[] = [];
  if (!existsSync(file)) return { games, positions: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as { game?: boolean; g?: number };
      if (typeof o.g !== "number") continue;
      if (o.game === true) games.add(o.g);
      else pos.push(o.g);
    } catch {
      // 書きかけの行（止めた等）は数えない
    }
  }
  return { games, positions: pos.filter((g) => games.has(g)).length };
}

/** survey の区切りの試合が、全部出力にあるか */
function surveyChunkDone(plan: Plan, dir: string, c: Chunk): boolean {
  const job = plan.jobs[c.job - 1];
  if (!job) return false;
  const { games } = surveyProgress(surveyFile(dir, job));
  for (let g = c.first; g < c.first + c.count; g++) if (!games.has(g)) return false;
  return true;
}

/** 区切りの台帳の行（ジョブの種類に合わせて読む。profile・survey は区切りごとの行を書かない） */
function chunkRowOf(plan: Plan, dir: string, c: Chunk): RunRow | MissesRow | undefined {
  const kind = plan.jobs[c.job - 1]?.spec.kind;
  if (kind === "profile" || kind === "survey") return undefined;
  return kind === "misses" ? rowOf(chunkMisses(dir), plan, dir, c) : rowOf(chunkRows(dir), plan, dir, c);
}

/** worker が動いていれば、その pid */
export function workerPid(dir: string): number | null {
  const f = join(dir, "worker.pid");
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // pid が使い回されていないか（電源を入れ直した後など）。worker は引数に回のフォルダを持つ
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("night-main") && cmd.includes(dir) ? pid : null;
  } catch {
    try {
      process.kill(pid, 0);
      return existsSync("/proc") ? null : pid;
    } catch {
      return null;
    }
  }
}

/** 根の下の回（作った順） */
export function listRuns(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((d) => existsSync(join(d, "plan.json")))
    .sort((x, y) => readPlan(x).created.localeCompare(readPlan(y).created));
}

function findRun(root: string, name: string | undefined, pick: (dir: string) => boolean): string {
  if (name !== undefined) {
    const d = join(root, name);
    if (!existsSync(join(d, "plan.json"))) throw new Error(`回がありません: ${d}`);
    return d;
  }
  const all = listRuns(root).filter(pick);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error(`${root} に当てはまる回がありません`);
  return last;
}

// ---------------------------------------------------------------- 計画と表示

export function makePlanParts(
  jobs: Job[],
  runs: RunRow[],
  machine: string,
  threads: number,
  chunkMin: number,
  misses: MissesRow[] = [],
): { estimates: Estimate[]; chunks: Chunk[] } {
  const estimates = jobs.map((j) => estimate(j, runs, machine, threads, misses));
  const chunks = jobs.flatMap((j, i) => chunkJob(j, estimates[i]?.perGame ?? 1, chunkMin * 60));
  return { estimates, chunks };
}

/** 区切りの見込みの秒（そのジョブで済んだ区切りがあれば、その速さで） */
function chunkSeconds(c: Chunk, plan: Plan, measured: Map<number, number>): number {
  const perGame = measured.get(c.job) ?? plan.estimates[c.job - 1]?.perGame ?? 1;
  const job = plan.jobs[c.job - 1];
  return (job ? unitsOf(job, c.count) : 2 * c.count) * perGame;
}

/** ジョブごとの、同じスレッド数で済んだ区切りから測った 1 試合の秒 */
function measuredSpeed(plan: Pick<Plan, "jobs" | "chunks">, done: Map<string, Marker>, threads: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const job of plan.jobs) {
    const cs = plan.chunks.filter((c) => {
      const m = done.get(c.id);
      return c.job === job.index && m !== undefined && !m.recovered && m.threads === threads;
    });
    const games = cs.reduce((s, c) => s + unitsOf(job, c.count), 0);
    const secs = cs.reduce((s, c) => s + (done.get(c.id)?.seconds ?? 0), 0);
    if (games > 0 && secs > 0) out.set(job.index, secs / games);
  }
  return out;
}

/** 計画の表（済んだ区切りは除いて、startAt から順に回したときの見込み） */
export function planText(
  plan: Pick<Plan, "jobs" | "estimates" | "chunks"> & Partial<Plan>,
  o: { threads: number; machine: string; startAt: number; until: number; tz: string; done?: Map<string, Marker>; title: string },
): string {
  const done = o.done ?? new Map<string, Marker>();
  const measured = measuredSpeed(plan, done, o.threads);
  let t = o.startAt;
  let cut: string | null = null;
  const rows: string[][] = [];
  let total = 0;
  let nChunks = 0;
  for (const [i, job] of plan.jobs.entries()) {
    const cs = plan.chunks.filter((c) => c.job === job.index && !done.has(c.id));
    const perGame = measured.get(job.index) ?? plan.estimates[i]?.perGame ?? 1;
    const secs = cs.reduce((s, c) => s + unitsOf(job, c.count) * perGame, 0);
    for (const c of cs) {
      if (cut === null && t + unitsOf(job, c.count) * perGame * 1000 > o.until) cut = `ジョブ ${job.index} の区切り ${c.k}`;
      t += unitsOf(job, c.count) * perGame * 1000;
    }
    total += secs;
    nChunks += cs.length;
    const games = cs.reduce((s, c) => s + c.count, 0);
    const first = cs[0]?.first ?? job.start;
    rows.push([
      String(job.index),
      jobTitle(job),
      job.label,
      cs.length === 0 ? "済み" : job.spec.kind === "misses" ? `各問 ${games} 回` : `${unitsOf(job, games)}（g${first}〜${first + games - 1}）`,
      String(cs.length),
      `${perGame.toFixed(3)} 秒${job.spec.kind === "misses" ? "（全問 1 回）" : ""}`,
      fmtDur(secs),
      cs.length === 0 ? "" : fmtClock(t, o.tz),
      measured.has(job.index) ? "この回で測った速さ" : (plan.estimates[i]?.source ?? ""),
    ]);
  }
  const head =
    `${o.title}: ${plan.jobs.length} ジョブ・${nChunks} 区切り、見込み ${fmtDur(total)}（${o.machine}・${o.threads} スレッド）。` +
    `${fmtClock(o.startAt, o.tz)} に始めると ${fmtClock(o.startAt + total * 1000, o.tz)} ごろ終わる。止める時刻 ${fmtClock(o.until, o.tz)}（${o.tz}）`;
  const warn =
    cut === null ? "止める時刻までに全部終わる見込み。" : `止める時刻までに終わらない見込み: ${cut} の前で止まる（残りは resume で次の夜に続きから）。`;
  return `${head}\n${warn}\n\n${markdownTable(["#", "ジョブ", "台帳の名前", "試合", "区切り", "1 試合", "見込み", "終わる時刻", "見込みの出どころ"], rows)}`;
}

// ---------------------------------------------------------------- 結果のまとめ

const round = (x: number, k: number) => Math.round(x * 10 ** k) / 10 ** k;

/** 区切りの行（同じジョブの、試合番号の続いた区切り）を、1 回で回したときと同じ数字の 1 行にまとめる */
export function combineRows(rows: RunRow[], cmd: string, queue: string): RunRow & { queue: string; chunks: number } {
  const sorted = [...rows].sort((x, y) => x.g[0] - y.g[0]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error("まとめる行がありません");
  const n = sorted.reduce((s, r) => s + r.n, 0);
  const wins = sorted.reduce((s, r) => s + r.wins, 0);
  const pairs: [number, number, number] = [0, 0, 0];
  const perDeck: Record<string, [number, number]> = {};
  for (const r of sorted) {
    for (let i = 0; i < 3; i++) pairs[i as 0 | 1 | 2] += r.pairs[i as 0 | 1 | 2];
    for (const [d, [w, t]] of Object.entries(r.perDeck)) {
      const x = perDeck[d] ?? [0, 0];
      perDeck[d] = [x[0] + w, x[1] + t];
    }
  }
  let se: number | null = null;
  if (first.seKind === "pairs") {
    // 組の勝率（0・0.5・1）のばらつき（rust/engine/src/runner/compare.rs の pair_stats と同じ）
    const m = pairs[0] + pairs[1] + pairs[2];
    if (m >= 2) {
      const mean = (pairs[1] * 0.5 + pairs[2]) / m;
      const v = (pairs[0] * mean ** 2 + pairs[1] * (0.5 - mean) ** 2 + pairs[2] * (1 - mean) ** 2) / (m - 1);
      se = Math.sqrt(v / m);
    }
  } else if (n > 0) {
    const p = wins / n;
    se = Math.sqrt((p * (1 - p)) / n);
  }
  const seconds = sorted.reduce((s, r) => s + r.seconds, 0);
  return {
    ...first,
    date: last.date,
    at: last.at,
    g: [first.g[0], last.g[1]],
    n,
    wins,
    rate: n > 0 ? round(wins / n, 6) : null,
    se: se === null ? null : round(se, 6),
    pairs,
    perDeck,
    seconds: round(seconds, 1),
    perGame: n > 0 ? round(seconds / n, 6) : null,
    cmd,
    queue,
    chunks: sorted.length,
  };
}

/** ジョブの済んだ区切りの行を、試合番号の続いたまとまりに分ける */
function contiguous(rows: RunRow[]): RunRow[][] {
  const sorted = [...rows].sort((x, y) => x.g[0] - y.g[0]);
  const out: RunRow[][] = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && prev.g[1] + 1 === r.g[0] && prev.threads === r.threads && prev.machine === r.machine) cur.push(r);
    else out.push([r]);
  }
  return out;
}

const pct = (x: number | null) => (x === null ? "?" : `${(x * 100).toFixed(2)}%`);
const pts = (x: number | null) => (x === null ? "?" : (x * 100).toFixed(2));

/** 回の今の様子（表） */
export function statusText(dir: string): string {
  const plan = readPlan(dir);
  const session = existsSync(join(dir, "session.json")) ? readSession(dir) : null;
  const tz = session?.tz ?? "Asia/Tokyo";
  const st = readStatus(dir);
  const pid = workerPid(dir);
  const done = markers(dir);
  const rows = chunkRows(dir);
  const missesRows = chunkMisses(dir);
  const failed = existsSync(join(dir, "failed.json")) ? readJson<Record<string, string>>(join(dir, "failed.json")) : {};
  let state: string;
  if (pid !== null) {
    const cur = st?.current;
    state = `動いている（pid ${pid}${cur ? `、区切り ${cur.id} を ${fmtClock(cur.since, tz)} から` : ""}）`;
  } else if (st === null) {
    state = "まだ始めていない";
  } else if (st.state === "running") {
    state = `止まっている（最後の記録 ${fmtClock(st.at, tz)}。電源が切れたか、途中で落ちた。resume で続きから）`;
  } else {
    state = `${st.state === "done" ? "全部済んだ" : "止まった"}（${st.reason}、${fmtClock(st.at, tz)}）`;
  }
  const tableRows: string[][] = plan.jobs.map((job) => {
    const cs = plan.chunks.filter((c) => c.job === job.index);
    const ds = cs.filter((c) => done.has(c.id));
    const secs = ds.reduce((s, c) => s + (done.get(c.id)?.seconds ?? 0), 0);
    const games = ds.reduce((s, c) => s + unitsOf(job, c.count), 0);
    let result = "";
    if (job.spec.kind === "profile") {
      result = ds.length > 0 ? `speed-${job.index}.md` : "";
    } else if (job.spec.kind === "survey") {
      const p = surveyProgress(surveyFile(dir, job));
      if (p.games.size > 0) result = `試合 ${p.games.size}・局面 ${p.positions}（survey-${job.index}.jsonl）`;
    } else if (job.spec.kind === "misses") {
      const m = ds.map((c) => rowOf(missesRows, plan, dir, c)).find((r) => r !== undefined);
      if (m) result = `正解率 ${pct(m.rate)} ± ${pts(m.se)}`;
    } else {
      const rs = ds.map((c) => rowOf(rows, plan, dir, c)).filter((r): r is RunRow => r !== undefined);
      if (rs.length > 0) {
        const c = combineRows(rs, "", plan.name);
        result = `${pct(c.rate)} ± ${pts(c.se)}`;
      }
    }
    const f = failed[String(job.index)];
    return [
      String(job.index),
      jobTitle(job),
      job.label,
      `${ds.length}/${cs.length}`,
      job.spec.kind === "misses" ? `${games}/${job.games} 回` : `${games}/${unitsOf(job, job.games)}`,
      fmtDur(secs),
      result,
      f ? `失敗: ${f}` : "",
    ];
  });
  const s = session;
  const head = [
    `夜のキュー ${plan.name}（${dir}）`,
    `状態: ${state}`,
    `コミット ${plan.commit}（${plan.branch}）、${s ? `${s.machine}・${s.threads} スレッド、止める時刻 ${fmtClock(s.until, tz)}（${tz}）` : ""}`,
  ];
  return `${head.join("\n")}\n\n${markdownTable(["#", "ジョブ", "台帳の名前", "区切り", "試合", "かかった時間", "A の勝率・正解率・局面", "メモ"], tableRows)}`;
}

// ---------------------------------------------------------------- worker

export interface WorkerControl {
  /** すぐ止める（回している区切りを止める） */
  stopNow: boolean;
  kill?: (() => void) | undefined;
}

/** 区切りを 1 つ回す。終わりの状態（0 なら済んだ）と秒 */
function runChunk(plan: Plan, session: Session, dir: string, c: Chunk, ctl: WorkerControl): Promise<{ code: number | null; seconds: number; why: string }> {
  const job = plan.jobs[c.job - 1];
  if (!job) throw new Error(`ジョブ ${c.job} がありません`);
  const argv = jobArgv(job, c.first, c.count, dir);
  mkdirSync(join(dir, "chunks"), { recursive: true });
  const logFile = join(dir, "chunks", `${c.id}.log`);
  const out = openSync(`${logFile}.tmp`, "w");
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn(plan.bin, argv, {
      cwd: plan.repo,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        THREADS: String(session.threads),
        SVWB_LEDGER: join(dir, "ledger.jsonl"),
        SVWB_COMMIT: plan.commit,
        SVWB_BRANCH: plan.branch,
        SVWB_MACHINE: session.machine,
      },
    });
    let why = "";
    ctl.kill = () => {
      why = "すぐ止めた";
      child.kill("SIGTERM");
    };
    // 止める時刻を HARD_GRACE 過ぎても終わらなければ止める（朝に PC を使う人のため）
    const hard = setTimeout(
      () => {
        why = `止める時刻を ${fmtDur(HARD_GRACE)} 過ぎた`;
        child.kill("SIGTERM");
      },
      Math.max(0, session.until + HARD_GRACE * 1000 - Date.now()),
    );
    const finish = (code: number | null) => {
      clearTimeout(hard);
      ctl.kill = undefined;
      closeSync(out);
      if (code === 0) renameSync(`${logFile}.tmp`, logFile);
      done({ code, seconds: (Date.now() - t0) / 1000, why });
    };
    child.on("error", (e) => {
      why = e.message;
      finish(null);
    });
    child.on("exit", (code) => finish(code));
  });
}

/** 回のフォルダの計画を、済んでいない区切りから順に回す */
export async function runWorker(dir: string, ctl: WorkerControl = { stopNow: false }): Promise<Status> {
  const plan = readPlan(dir);
  const session = readSession(dir);
  const tz = session.tz;
  const ledgerFile = join(dir, "ledger.jsonl");
  const failedFile = join(dir, "failed.json");
  const failed: Record<string, string> = {};
  writeFileSync(join(dir, "worker.pid"), String(process.pid));
  log(dir, tz, `始めた（pid ${process.pid}、${session.machine}・${session.threads} スレッド、止める時刻 ${fmtClock(session.until, tz)}）`);
  const end = (state: Status["state"], reason: string): Status => {
    writeStatus(dir, { state, reason, current: null });
    log(dir, tz, `${state === "done" ? "終わった" : "止まった"}: ${reason}`);
    writeAtomic(failedFile, JSON.stringify(failed));
    return { state, reason, at: Date.now(), current: null };
  };
  writeStatus(dir, { state: "running", reason: "", current: null });
  for (const job of plan.jobs) {
    const cs = plan.chunks.filter((c) => c.job === job.index);
    for (const c of cs) {
      const done = markers(dir);
      if (done.has(c.id)) continue;
      // 台帳に行があって印が無い（行を書いた直後に電源が切れた）なら、回さずに印を作る
      const row = chunkRowOf(plan, dir, c);
      if (row) {
        writeMarker(dir, { id: c.id, seconds: row.seconds, at: new Date().toISOString(), threads: row.threads, recovered: true });
        log(dir, tz, `区切り ${c.id} は台帳に行があるので済んだものとした`);
        continue;
      }
      if (job.spec.kind === "survey" && surveyChunkDone(plan, dir, c)) {
        writeMarker(dir, { id: c.id, seconds: 0, at: new Date().toISOString(), threads: session.threads, recovered: true });
        log(dir, tz, `区切り ${c.id} は出力に全部の試合があるので済んだものとした`);
        continue;
      }
      if (existsSync(join(dir, "STOP"))) return end("stopped", "手で止めた（stop）");
      if (ctl.stopNow) return end("stopped", "すぐ止めた（stop --now）");
      const expected = chunkSeconds(c, plan, measuredSpeed(plan, done, session.threads));
      if (Date.now() + expected * 1000 > session.until) {
        return end("stopped", `止める時刻 ${fmtClock(session.until, tz)} までに区切り ${c.id}（見込み ${fmtDur(expected)}）が終わらない`);
      }
      // 前の行が書きかけ（電源が切れた等）なら、次の行がそれにつながらないよう改行を足す
      if (existsSync(ledgerFile)) {
        const text = readFileSync(ledgerFile, "utf8");
        if (text.length > 0 && !text.endsWith("\n")) appendFileSync(ledgerFile, "\n");
      }
      writeStatus(dir, { state: "running", reason: "", current: { id: c.id, since: Date.now() } });
      log(dir, tz, `区切り ${c.id}（${job.label || jobTitle(job)}、g${c.first}〜${c.first + c.count - 1}、見込み ${fmtDur(expected)}）を始める`);
      const r = await runChunk(plan, session, dir, c, ctl);
      if (r.code === 0) {
        fsyncFile(ledgerFile);
        writeMarker(dir, { id: c.id, seconds: r.seconds, at: new Date().toISOString(), threads: session.threads });
        const got = chunkRowOf(plan, dir, c);
        if (job.spec.kind !== "profile" && job.spec.kind !== "survey" && got === undefined) log(dir, tz, `注意: 区切り ${c.id} の台帳の行が見つからない（chunks/${c.id}.log を見る）`);
        if (job.spec.kind === "survey" && !surveyChunkDone(plan, dir, c)) log(dir, tz, `注意: 区切り ${c.id} の試合が survey-${job.index}.jsonl に揃っていない（chunks/${c.id}.log を見る）`);
        const what = got === undefined ? "" : got.kind === "misses" ? `、正解率 ${pct(got.rate)}` : `、A ${pct(got.rate)}`;
        log(dir, tz, `区切り ${c.id} 済み（${fmtDur(r.seconds)}、${(r.seconds / unitsOf(job, c.count)).toFixed(3)} 秒/${job.spec.kind === "misses" ? "全問 1 回" : "試合"}${what}）`);
        continue;
      }
      if (ctl.stopNow) return end("stopped", `すぐ止めた（stop --now。区切り ${c.id} は回し直す）`);
      if (r.why.startsWith("止める時刻")) return end("stopped", `${r.why}ので区切り ${c.id} を止めた（回し直す）`);
      failed[String(job.index)] = `区切り ${c.id}（終わりの状態 ${r.code ?? "?"}${r.why ? `、${r.why}` : ""}。chunks/${c.id}.log.tmp）`;
      log(dir, tz, `区切り ${c.id} が失敗した（終わりの状態 ${r.code ?? "?"}）。ジョブ ${job.index} の残りを飛ばす`);
      writeAtomic(failedFile, JSON.stringify(failed));
      break;
    }
  }
  const allDone = plan.chunks.every((c) => markers(dir).has(c.id));
  return end(allDone ? "done" : "stopped", allDone ? "全部の区切りが済んだ" : "失敗したジョブがある（resume でやり直す）");
}

// ---------------------------------------------------------------- コマンド

interface Args {
  pos: string[];
  opts: Map<string, string>;
}

const FLAGS = new Set(["--yes", "--allow-dirty", "--now", "--commit", "--pack", "--foreground", "--prepare-only"]);

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    if (FLAGS.has(a)) {
      opts.set(a, "true");
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${a} の値がありません`);
    opts.set(a, v);
    i++;
  }
  return { pos, opts };
}

function known(a: Args, names: string[], maxPos: number): void {
  const bad = [...a.opts.keys()].filter((k) => !names.includes(k) && k !== "--root");
  if (bad.length > 0) throw new Error(`使えない引数: ${bad.join(" ")}`);
  if (a.pos.length > maxPos) throw new Error(`多すぎる引数: ${a.pos.slice(maxPos).join(" ")}`);
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** 今のコミット（台帳と物差しの表のほかに変更があれば末尾に +。rust の commit_label_excluding と同じ）とブランチ */
export function gitState(): { commit: string; branch: string; dirty: boolean } {
  const head = git(["rev-parse", "--short=7", "HEAD"]) || "?";
  const dirty =
    git(["status", "--porcelain", "--untracked-files=no", "--", ":/", ":(exclude,top)docs/yardstick.md", ":(exclude,top)docs/ledger.jsonl"]) !== "";
  return { commit: dirty ? `${head}+` : head, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || "?", dirty };
}

const thisMachine = (): string => process.env.SVWB_MACHINE || hostname();

function repoLedger(): { runs: RunRow[]; misses: MissesRow[] } {
  const f = process.env.SVWB_LEDGER || DEFAULT_LEDGER;
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")) : { runs: [], misses: [] };
}

function sessionOf(a: Args, machine: string): Session {
  const tz = a.opts.get("--tz") ?? "Asia/Tokyo";
  const now = Date.now();
  const threadsText = a.opts.get("--threads");
  const threads = threadsText === undefined ? (SPEEDS[machine] && machine !== thisMachine() ? (SPEEDS[machine]?.threads ?? 1) : availableParallelism()) : intOf(threadsText, "--threads", 1);
  return { started: now, until: parseUntil(a.opts.get("--until") ?? "07:00", now, tz), tz, threads, machine };
}

function activeRuns(root: string): string[] {
  return listRuns(root).filter((d) => workerPid(d) !== null);
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} が失敗しました`);
}

/** 設定の書き間違いを、回す前に見つける（0 試合の compare は設定を読むだけ。0 回の misses は設定と問題集を読むだけ） */
function validate(bin: string, jobs: Job[]): void {
  for (const job of jobs) {
    const s = job.spec;
    // survey の設定は数だけで、ジョブの行を読むときに確かめた
    if (s.kind === "survey") continue;
    const args =
      s.kind === "compare"
        ? ["compare", "0", s.a, s.b, "0", ...(s.vs === null ? [] : [s.vs]), ...(s.decks === null ? [] : ["--decks", s.decks]), "--no-ledger"]
        : s.kind === "misses"
          ? ["misses", "run", "--opts", s.opts, "--trials", "0", "--no-ledger"]
          : ["compare", "0", s.opts, "{}", "0", "--no-ledger"];
    const r = spawnSync(bin, args, { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ジョブ ${job.index} の設定が読めません: ${(r.stderr || r.stdout).trim()}`);
  }
}

/** worker を、このセッションから切り離して立てる（setsid。Remote Control のセッションが終わっても続く） */
function launch(dir: string): number {
  const out = openSync(join(dir, "worker.out"), "a");
  const child = spawn(process.execPath, [SELF, "worker", dir], { cwd: REPO, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  closeSync(out);
  return child.pid ?? -1;
}

function stamp(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.y}${p2(w.mo)}${p2(w.d)}-${p2(w.h)}${p2(w.mi)}`;
}

function afterStart(dir: string, session: Session): string {
  return [
    `回のフォルダ: ${dir}（進み具合は night.log）`,
    `止める時刻: ${fmtClock(session.until, session.tz)}（${session.tz}）`,
    "様子: npm run night -- status　止める: npm run night -- stop（--now ですぐ）　朝: npm run night -- finish --commit",
  ].join("\n");
}

export async function cmdStart(a: Args): Promise<number> {
  // --bin（組み立てずにこの svwb を使う）・--foreground（切り離さずに回す）・--prepare-only（回のフォルダを作るだけ）は試す用
  known(a, ["--yes", "--name", "--until", "--tz", "--threads", "--chunk-min", "--allow-dirty", "--bin", "--foreground", "--prepare-only"], 1);
  const file = a.pos[0];
  if (file === undefined) throw new Error("ジョブのファイルを渡します");
  const jobsText = readFileSync(file, "utf8");
  const jobs = parseJobs(jobsText);
  const root = runsRoot(a.opts.get("--root"));
  const machine = thisMachine();
  const session = sessionOf(a, machine);
  const chunkMin = Number(a.opts.get("--chunk-min") ?? "7.5");
  if (!(chunkMin > 0)) throw new Error("--chunk-min は正の数");
  const g = gitState();
  const { estimates, chunks } = makePlanParts(jobs, repoLedger().runs, machine, session.threads, chunkMin, repoLedger().misses);
  const name = a.opts.get("--name") ?? `night-${stamp(session.started, session.tz)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`--name は英数字と . _ - だけ: ${name}`);
  console.log(planText({ jobs, estimates, chunks }, { threads: session.threads, machine, startAt: session.started, until: session.until, tz: session.tz, title: `夜のキュー ${name}（${file}）` }));
  if (!a.opts.has("--yes")) {
    console.log("\nまだ始めていません。ユーザーが今夜回すと決めたら --yes を付けて流します（承認は 1 晩分まとめて。docs/night.md）。");
    return 0;
  }
  const active = activeRuns(root);
  if (active.length > 0) throw new Error(`ほかの回が動いています: ${active.join(", ")}（1 晩に 1 つ）`);
  if (g.dirty && !a.opts.has("--allow-dirty")) throw new Error("コミットしていない変更があります（push してから回す。試すだけなら --allow-dirty）");
  const dir = join(root, name);
  if (existsSync(dir)) throw new Error(`もうあります: ${dir}（続きなら resume）`);
  let bin = a.opts.get("--bin");
  if (bin === undefined) {
    console.log("svwb を組み立てる…");
    run(process.execPath, [join(REPO, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
    run("cargo", ["build", "--quiet", "--release", "--manifest-path", "rust/Cargo.toml", "-p", "svwb-engine"]);
    bin = join(REPO, "rust/target/release/svwb");
  }
  validate(resolve(bin), jobs);
  mkdirSync(join(dir, "bin"), { recursive: true });
  // 夜の間にほかのセッションが組み立て直しても替わらないよう、写したものを回す
  const copied = join(dir, "bin", "svwb");
  copyFileSync(resolve(bin), copied);
  chmodSync(copied, 0o755);
  const plan: Plan = {
    v: 1,
    name,
    created: new Date(session.started).toISOString(),
    repo: REPO,
    jobsFile: resolve(file),
    commit: g.commit,
    branch: g.branch,
    bin: copied,
    chunkMin,
    jobs,
    estimates,
    chunks,
  };
  writeFileSync(join(dir, "jobs.txt"), jobsText);
  writeAtomic(join(dir, "plan.json"), JSON.stringify(plan, null, 1));
  writeAtomic(join(dir, "session.json"), JSON.stringify(session));
  if (a.opts.has("--prepare-only")) return 0;
  if (a.opts.has("--foreground")) {
    const st = await runWorker(dir);
    console.log(statusText(dir));
    return st.state === "done" ? 0 : 1;
  }
  const pid = launch(dir);
  console.log(`\n始めました（worker の pid ${pid}。このセッションが終わっても続きます）。\n${afterStart(dir, session)}`);
  return 0;
}

export async function cmdResume(a: Args): Promise<number> {
  known(a, ["--yes", "--until", "--tz", "--threads", "--foreground"], 1);
  const root = runsRoot(a.opts.get("--root"));
  const dir = findRun(root, a.pos[0], (d) => readPlan(d).chunks.some((c) => !markers(d).has(c.id)));
  if (workerPid(dir) !== null) throw new Error(`動いています: ${dir}`);
  const plan = readPlan(dir);
  const prev = existsSync(join(dir, "session.json")) ? readSession(dir) : null;
  const machine = thisMachine();
  const session = sessionOf(a, machine);
  if (prev && !a.opts.has("--tz")) session.tz = prev.tz;
  if (!a.opts.has("--until")) session.until = parseUntil("07:00", session.started, session.tz);
  console.log(
    planText(plan, { threads: session.threads, machine, startAt: session.started, until: session.until, tz: session.tz, done: markers(dir), title: `夜のキュー ${plan.name} の続き` }),
  );
  if (!a.opts.has("--yes")) {
    console.log("\nまだ始めていません。ユーザーが今夜回すと決めたら --yes を付けて流します。");
    return 0;
  }
  const active = activeRuns(root);
  if (active.length > 0) throw new Error(`ほかの回が動いています: ${active.join(", ")}（1 晩に 1 つ）`);
  if (gitState().commit !== plan.commit) {
    console.log(`注意: 今のチェックアウト（${gitState().commit}）は回のコミット（${plan.commit}）と違う。回すのは回のフォルダに写した svwb なので、結果は ${plan.commit} のもの`);
  }
  rmSync(join(dir, "STOP"), { force: true });
  writeAtomic(join(dir, "session.json"), JSON.stringify(session));
  if (a.opts.has("--foreground")) {
    const st = await runWorker(dir);
    console.log(statusText(dir));
    return st.state === "done" ? 0 : 1;
  }
  const pid = launch(dir);
  console.log(`\n続きを始めました（worker の pid ${pid}）。\n${afterStart(dir, session)}`);
  return 0;
}

function cmdStop(a: Args): number {
  known(a, ["--now"], 1);
  const root = runsRoot(a.opts.get("--root"));
  const dir = findRun(root, a.pos[0], (d) => workerPid(d) !== null);
  const pid = workerPid(dir);
  writeFileSync(join(dir, "STOP"), new Date().toISOString());
  if (pid === null) {
    console.log(`動いていません: ${dir}（STOP を置いた。resume で消える）`);
    return 0;
  }
  if (a.opts.has("--now")) {
    process.kill(pid, "SIGTERM");
    console.log(`すぐ止めます（pid ${pid}。回していた区切りは、次の resume で回し直す）`);
  } else {
    console.log(`回している区切りが終わったら止まります（pid ${pid}）。すぐ止めるなら --now`);
  }
  return 0;
}

/** git の名前とメールが決まるか（決まらないと git commit が断る）。コンテナでは .env の GIT_AUTHOR_NAME 等で渡す */
function checkGitIdent(): void {
  for (const v of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const r = spawnSync("git", ["var", v], { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        "git の名前とメールが決まらないので、コミットできません。台帳には何も足していません。\n" +
          "コンテナなら docker/remote-control/.env に GIT_AUTHOR_NAME・GIT_AUTHOR_EMAIL・GIT_COMMITTER_NAME・GIT_COMMITTER_EMAIL を書き、" +
          "ホストで docker compose up -d を流してから、finish --commit を流し直す（docs/night.md「台帳の行のコミット」）",
      );
    }
  }
}

/** この回の行のうち、作業ツリーの docs/ledger.jsonl にあって HEAD に無いものの数 */
function uncommittedQueueRows(name: string): number {
  const count = (text: string) => {
    const l = parseLedger(text);
    return [...l.runs, ...l.misses, ...l.surveys].filter((r) => (r as { queue?: string }).queue === name).length;
  };
  const work = existsSync(DEFAULT_LEDGER) ? count(readFileSync(DEFAULT_LEDGER, "utf8")) : 0;
  const head = spawnSync("git", ["show", "HEAD:docs/ledger.jsonl"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 30 });
  return work - (head.status === 0 ? count(head.stdout) : 0);
}

/** 朝: ジョブごとに 1 行にまとめた行をリポジトリの台帳に足す（足した区切りは覚えておき、2 回足さない） */
export function cmdFinish(a: Args): number {
  known(a, ["--commit", "--pack", "--ledger"], 1);
  const root = runsRoot(a.opts.get("--root"));
  const dir = findRun(root, a.pos[0], () => true);
  if (workerPid(dir) !== null) throw new Error(`まだ動いています: ${dir}（止めるなら stop）`);
  const plan = readPlan(dir);
  const done = markers(dir);
  const rows = chunkRows(dir);
  const mergedFile = join(dir, "merged.json");
  const merged = new Set<string>(existsSync(mergedFile) ? readJson<string[]>(mergedFile) : []);
  const target = a.opts.get("--ledger") ?? (process.env.SVWB_LEDGER || DEFAULT_LEDGER);
  const commit = a.opts.has("--commit");
  // コミットできないと分かっているなら、台帳に足す前に止める（足した後で止まると、足した行がコミットされずに残る）
  if (commit) {
    if (resolve(target) !== resolve(DEFAULT_LEDGER)) throw new Error("--commit はリポジトリの台帳（docs/ledger.jsonl）に足すときだけ");
    checkGitIdent();
  }
  const targetLedger = existsSync(target) ? parseLedger(readFileSync(target, "utf8")) : { runs: [], misses: [], surveys: [] };
  const existing = targetLedger.runs;
  const key = (r: { label: string; g: [number, number]; commit: string; kind: string }) => `${r.kind}\u0001${r.label}\u0001${r.g[0]}\u0001${r.g[1]}\u0001${r.commit}`;
  const have = new Set(existing.filter((r) => (r as RunRow & { queue?: string }).queue === plan.name).map(key));
  const out: RunRow[] = [];
  // 見落とし問題集は分けずに回すので、区切りの行に回の名前を足してそのまま写す
  const outMisses: (MissesRow & { queue: string; chunks: number })[] = [];
  const mrows = chunkMisses(dir);
  const mkey = (r: MissesRow) => `${r.label}\u0001${r.commit}\u0001${r.seed}\u0001${r.trials}\u0001${r.set}`;
  const haveMisses = new Set(targetLedger.misses.filter((r) => (r as MissesRow & { queue?: string }).queue === plan.name).map(mkey));
  // 打ち比べ調査は、ジョブの区切りが全部済んでから svwb survey report で 1 行にまとめる（局面ごとの結果は回のフォルダの survey-<番号>.jsonl）
  const outSurveys: (SurveyRow & { queue: string; chunks: number })[] = [];
  const haveSurveys = new Set(targetLedger.surveys.filter((r) => (r as SurveyRow & { queue?: string }).queue === plan.name).map((r) => r.label));
  const notes: string[] = [];
  for (const job of plan.jobs) {
    if (job.spec.kind === "profile") continue;
    if (job.spec.kind === "survey") {
      const cs = plan.chunks.filter((c) => c.job === job.index);
      if (cs.every((c) => merged.has(c.id))) continue;
      const nDone = cs.filter((c) => done.has(c.id)).length;
      if (nDone < cs.length) {
        notes.push(`ジョブ ${job.index}（${job.label}）はまだ途中（区切り ${nDone}/${cs.length}）。resume で続きを回してから finish で台帳に足す`);
        continue;
      }
      if (!haveSurveys.has(job.label)) {
        const one = join(dir, `survey-${job.index}-ledger.jsonl`);
        rmSync(one, { force: true });
        const states = join(dir, `survey-${job.index}-states`);
        mkdirSync(states, { recursive: true });
        const r = spawnSync(plan.bin, ["survey", "report", surveyFile(dir, job), "--label", job.label, "--states", states], {
          cwd: plan.repo,
          encoding: "utf8",
          maxBuffer: 1 << 28,
          env: { ...process.env, SVWB_LEDGER: one, SVWB_COMMIT: plan.commit, SVWB_BRANCH: plan.branch },
        });
        if (r.status !== 0) throw new Error(`ジョブ ${job.index} の survey report が失敗しました: ${(r.stderr || r.stdout).trim()}`);
        writeFileSync(join(dir, `survey-${job.index}.md`), r.stdout);
        const rows = existsSync(one) ? parseLedger(readFileSync(one, "utf8")).surveys : [];
        const row = rows[rows.length - 1];
        if (!row) throw new Error(`ジョブ ${job.index} の survey report が台帳の行を書きませんでした（${one}）`);
        outSurveys.push({ ...row, queue: plan.name, chunks: cs.length });
      }
      for (const c of cs) merged.add(c.id);
      continue;
    }
    if (job.spec.kind === "misses") {
      for (const c of plan.chunks.filter((c) => c.job === job.index && done.has(c.id) && !merged.has(c.id))) {
        const r = rowOf(mrows, plan, dir, c);
        if (r && !haveMisses.has(mkey(r))) outMisses.push({ ...r, queue: plan.name, chunks: 1 });
        merged.add(c.id);
      }
      continue;
    }
    const cs = plan.chunks.filter((c) => c.job === job.index && done.has(c.id) && !merged.has(c.id));
    const rs = cs.map((c) => rowOf(rows, plan, dir, c)).filter((r): r is RunRow => r !== undefined);
    for (const group of contiguous(rs)) {
      const g0 = group[0]?.g[0] ?? 0;
      const g1 = group[group.length - 1]?.g[1] ?? 0;
      const row = combineRows(group, shellLine(jobArgv(job, g0, g1 - g0 + 1, dir)), plan.name);
      if (!have.has(key(row))) out.push(row);
    }
    for (const c of cs) merged.add(c.id);
  }
  const text = [...out, ...outMisses, ...outSurveys].map((r) => `${JSON.stringify(r)}\n`).join("");
  const added = out.length + outMisses.length + outSurveys.length;
  if (added > 0) {
    if (existsSync(target)) {
      const t = readFileSync(target, "utf8");
      if (t.length > 0 && !t.endsWith("\n")) appendFileSync(target, "\n");
    }
    appendFileSync(target, text);
    appendFileSync(join(dir, "ledger-jobs.jsonl"), text);
  }
  writeAtomic(mergedFile, JSON.stringify([...merged]));
  const summary = `${statusText(dir)}\n\n台帳（${target}）に足した行: ${added}\n${
    out.length > 0
      ? markdownTable(
          ["名前", "試合", "A の勝率", "±", "区切り", "秒/試合"],
          out.map((r) => [r.label, `${r.n}（g${r.g[0]}〜${r.g[1]}）`, pct(r.rate), pts(r.se), String((r as RunRow & { chunks?: number }).chunks ?? 1), r.perGame?.toFixed(3) ?? "?"]),
        )
      : ""
  }${
    outMisses.length > 0
      ? `\n\n${markdownTable(
          ["名前", "問", "回数", "正解率", "±", "秒"],
          outMisses.map((r) => [r.label, `${r.problems}（${r.set}）`, String(r.trials), pct(r.rate), pts(r.se), r.seconds.toFixed(0)]),
        )}`
      : ""
  }${
    outSurveys.length > 0
      ? `\n\n${markdownTable(
          ["名前", "試合", "局面（打ち比べた）", "二段目で測る得", "半分で選ぶ得（8 つ）", "（上位 4 つ）", "大きなミス", "結果"],
          outSurveys.map((r) => {
            const f = (x: [number | null, number | null], k: number) => (x[0] === null ? "?" : `${x[0].toFixed(k)} ± ${(x[1] ?? 0).toFixed(k)}`);
            const i = plan.jobs.find((j) => j.label === r.label && j.spec.kind === "survey")?.index ?? "?";
            return [r.label, `${r.games}（g${r.g[0]}〜${r.g[1]}）`, `${r.positions}（${r.compared}）`, f(r.gain2, 2), f(r.gain8, 2), f(r.gain4, 2), `${r.misses}（1 試合 1 席 ${f(r.missesPerGame, 3)}）`, `survey-${i}.md`];
          }),
        )}`
      : ""
  }${notes.length > 0 ? `\n\n${notes.join("\n")}` : ""}`;
  writeFileSync(join(dir, "summary.md"), `${summary}\n`);
  console.log(summary);
  if (commit) {
    // 今回足した行だけでなく、前の finish で足したがコミットできなかった行もコミットする（流し直せば済むように）
    const pending = uncommittedQueueRows(plan.name);
    if (pending > 0) {
      const msg = `台帳: 夜のキュー ${plan.name} の結果（${pending} 行、${plan.commit}）`;
      const r = spawnSync("git", ["commit", "-m", msg, "--", "docs/ledger.jsonl"], { cwd: REPO, stdio: "inherit" });
      if (r.status !== 0) throw new Error("コミットできませんでした。直してから finish --commit を流し直す（足した行はそのままコミットする）");
      console.log(`コミットしました（${gitState().branch}）。push はしていません（コンテナからはできない。ホストで git push）`);
    } else {
      console.log("コミットする行はありません");
    }
  }
  if (a.opts.has("--pack")) {
    run("npm", ["run", "-s", "pack-run", "--", dir, "--name", plan.name, "--note", `夜のキュー ${plan.name}（${plan.commit}）`, "--only", "logs", "--force"]);
  }
  return 0;
}

function cmdList(a: Args): number {
  known(a, [], 0);
  const root = runsRoot(a.opts.get("--root"));
  const rows = listRuns(root).map((d) => {
    const plan = readPlan(d);
    const done = markers(d);
    const st = readStatus(d);
    const pid = workerPid(d);
    return [
      plan.name,
      plan.commit,
      `${plan.chunks.filter((c) => done.has(c.id)).length}/${plan.chunks.length}`,
      pid !== null ? "動いている" : st === null ? "まだ" : st.state === "done" ? "全部済んだ" : st.state === "running" ? "止まっている（落ちた？）" : `止まった（${st.reason}）`,
    ];
  });
  console.log(rows.length === 0 ? `${root} に回はありません` : markdownTable(["名前", "コミット", "区切り", "状態"], rows));
  return 0;
}

const USAGE = `使い方（docs/night.md）:
  npm run night -- plan <ジョブのファイル> [--until 07:00] [--threads N] [--machine 名前] [--chunk-min 7.5] [--tz Asia/Tokyo]
  npm run night -- start <ジョブのファイル> --yes [--name 名前] [--until 07:00] [--threads N] [--chunk-min 7.5] [--allow-dirty]
  npm run night -- status [名前]
  npm run night -- stop [名前] [--now]
  npm run night -- resume [名前] --yes [--until 07:00] [--threads N]
  npm run night -- finish [名前] [--commit] [--pack] [--ledger 台帳]
  npm run night -- list
  （回の置き場所は --root か環境変数 SVWB_NIGHT_DIR。既定は ~/svwb-data/night）`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const a = parseArgs(rest);
    switch (cmd) {
      case "plan": {
        known(a, ["--until", "--tz", "--threads", "--machine", "--chunk-min"], 1);
        const file = a.pos[0];
        if (file === undefined) throw new Error("ジョブのファイルを渡します");
        const jobs = parseJobs(readFileSync(file, "utf8"));
        const machine = a.opts.get("--machine") ?? thisMachine();
        const session = sessionOf(a, machine);
        const chunkMin = Number(a.opts.get("--chunk-min") ?? "7.5");
        const parts = makePlanParts(jobs, repoLedger().runs, machine, session.threads, chunkMin, repoLedger().misses);
        console.log(planText({ jobs, ...parts }, { threads: session.threads, machine, startAt: session.started, until: session.until, tz: session.tz, title: `夜のキュー（${file}）` }));
        return 0;
      }
      case "start":
        return await cmdStart(a);
      case "resume":
        return await cmdResume(a);
      case "status": {
        known(a, [], 1);
        const root = runsRoot(a.opts.get("--root"));
        console.log(statusText(findRun(root, a.pos[0], () => true)));
        return 0;
      }
      case "stop":
        return cmdStop(a);
      case "finish":
        return cmdFinish(a);
      case "list":
        return cmdList(a);
      case "worker": {
        // start・resume が切り離して立てる本体（手では流さない）
        const dir = a.pos[0];
        if (dir === undefined) throw new Error("回のフォルダを渡します");
        const ctl: WorkerControl = { stopNow: false };
        process.on("SIGHUP", () => {});
        for (const sig of ["SIGTERM", "SIGINT"] as const) {
          process.on(sig, () => {
            ctl.stopNow = true;
            ctl.kill?.();
          });
        }
        const st = await runWorker(dir, ctl);
        return st.state === "done" ? 0 : 1;
      }
      default:
        console.log(USAGE);
        return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
    }
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
