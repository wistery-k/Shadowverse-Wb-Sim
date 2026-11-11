// 夜のキュー（scripts/night-main.ts・docs/night.md）。svwb の代わりに、台帳の行だけを書く偽物を回して、区切り・再開・止め方・まとめを確かめる

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLedger, type MissesRow, type RunRow, type SurveyRow } from "../scripts/ledger-main";
import {
  chunkJob,
  combineRows,
  estimate,
  main,
  parseJob,
  parseJobs,
  parseUntil,
  readStatus,
  runWorker,
  shellLine,
  shellWords,
  jobArgv,
  wallClock,
  type WorkerControl,
} from "../scripts/night-main";

describe("ジョブの行", () => {
  it("シェルと同じ形で語に分け、台帳の cmd と同じ形に戻す", () => {
    expect(shellWords(`compare 100 '{"beamWidth":128}' "{}" 0 --label 'a b' # 書き添え`)).toEqual([
      "compare",
      "100",
      '{"beamWidth":128}',
      "{}",
      "0",
      "--label",
      "a b",
    ]);
    // rust/engine/src/runner/ledger.rs の shell_line のテストと同じ
    expect(shellLine(["yardstick", "--opts", "{}", "--label", "it's"])).toBe(`yardstick --opts '{}' --label 'it'\\''s'`);
    expect(shellWords(shellLine(["x", "it's", "定例", ""]))).toEqual(["x", "it's", "定例", ""]);
  });

  it("compare・yardstick・profile・misses を読み、キューで使えない引数は断る", () => {
    const c = parseJob(`compare 3000 '{"beamWidth":128}' '{}' 100000 リノセウスエルフ --no-mirror --label 幅 --est 0.1`, 1);
    expect(c).toMatchObject({ label: "幅", games: 3000, start: 100000, est: 0.1 });
    expect(c.spec).toEqual({ kind: "compare", a: '{"beamWidth":128}', b: "{}", vs: "リノセウスエルフ", noMirror: true, decks: null });
    const y = parseJob("svwb yardstick --ref strong --games 4000 --label 強", 2);
    expect(y).toMatchObject({ games: 4000, start: 0, spec: { kind: "yardstick", ref: "strong", opts: "{}" } });
    expect(parseJob("profile", 3)).toMatchObject({ games: 49, label: "", spec: { kind: "profile", rhino: false } });
    expect(parseJob("misses run --trials 12 --seed 3 --label 定例", 4)).toMatchObject({ games: 12, start: 0, label: "定例", spec: { kind: "misses", opts: "{}", seed: 3 } });
    expect(parseJob(`misses --opts '{"beamWidth":512}' --label x`, 4)).toMatchObject({ games: 24, spec: { kind: "misses", opts: '{"beamWidth":512}', seed: 1 } });
    expect(() => parseJob("misses --trials 12", 1)).toThrow(/--label/);
    expect(() => parseJob("misses --label x --only a", 1)).toThrow(/--only/);
    expect(() => parseJob("misses --label x --no-ledger", 1)).toThrow(/--no-ledger/);
    expect(() => parseJob("compare 100 '{}' '{}'", 1)).toThrow(/--label/);
    expect(() => parseJob("compare 100 '{}' '{}' --label x --no-ledger", 1)).toThrow(/--no-ledger/);
    expect(() => parseJob("yardstick --label x --record", 1)).toThrow(/--record/);
    expect(() => parseJob("compare 100 '{beam}' '{}' --label x", 1)).toThrow(/JSON/);
    const s = parseJob("svwb survey run --games 1000-1799 --label 調査 --confirm 64", 5);
    expect(s).toMatchObject({ label: "調査", games: 800, start: 1000, spec: { kind: "survey", rate: 0.1, m: 32, extra: 4, confirm: 64, flag: 10, batch: 8 } });
    expect(parseJob("survey --games 40 --start 7 --rate 0.2 --label x", 5)).toMatchObject({ games: 40, start: 7, spec: { rate: 0.2 } });
    expect(jobArgv(s, 1200, 50, "/r")).toEqual(
      ["survey", "run", "--out", "/r/survey-5.jsonl", "--games", "1200-1249", "--rate", "0.1", "--m", "32", "--extra", "4", "--confirm", "64", "--flag", "10", "--batch", "8"],
    );
    expect(() => parseJob("survey --games 0-9", 1)).toThrow(/--label/);
    expect(() => parseJob("survey --label x", 1)).toThrow(/--games/);
    expect(() => parseJob("survey --games 0-9 --label x --out a.jsonl", 1)).toThrow(/--out/);
    expect(() => parseJob("survey --games 0-9 --label x --rate 2", 1)).toThrow(/--rate/);
    expect(() => parseJob("survey --games 0-9 --start 3 --label x", 1)).toThrow(/--start/);
    expect(() => parseJob("td selfplay", 1)).toThrow(/compare・yardstick・profile/);
    expect(() => parseJobs("# だけ\n\n")).toThrow(/ジョブがありません/);
    expect(() => parseJobs("profile\nyardstick --ref weak --label x")).toThrow(/2 行目/);
  });

  it("区切りは大きさをそろえ、試合番号をすき間なく覆う", () => {
    const job = parseJob("compare 1000 '{}' '{}' 500 --label x", 1);
    // 1 試合 0.1 秒・1 区切り 60 秒なら 300 組まで → 4 区切りにして 250 組ずつ
    const cs = chunkJob(job, 0.1, 60);
    expect(cs.map((c) => [c.id, c.first, c.count])).toEqual([
      ["1-1", 500, 250],
      ["1-2", 750, 250],
      ["1-3", 1000, 250],
      ["1-4", 1250, 250],
    ]);
    const odd = chunkJob(parseJob("compare 7 '{}' '{}' --label x", 2), 1, 4);
    expect(odd.map((c) => c.count)).toEqual([2, 2, 2, 1]);
    expect(chunkJob(parseJob("profile --games 49", 3), 10, 1)).toHaveLength(1);
    expect(chunkJob(parseJob("misses --trials 48 --label x", 4), 10, 1).map((c) => [c.first, c.count])).toEqual([[0, 48]]);
    // 打ち比べ調査は 1 つの番号で 1 試合。1 試合 20 秒・1 区切り 60 秒なら 3 試合ずつ
    expect(chunkJob(parseJob("survey --games 100-109 --label x", 5), 20, 60).map((c) => [c.first, c.count])).toEqual([
      [100, 3],
      [103, 3],
      [106, 3],
      [109, 1],
    ]);
  });

  it("見込みは --est、台帳の同じ比べ・同じマシンの回、決めておいた値の順に使う", () => {
    const job = parseJob("yardstick --ref strong --label x", 1);
    const row = (over: Partial<RunRow>): RunRow =>
      ({ kind: "yardstick", a: {}, b: "strong", machine: "svwb-docker", threads: 28, n: 2000, seconds: 200, date: "2026-11-05", cmd: "" }) as RunRow & typeof over;
    expect(estimate(job, [], "svwb-docker", 28).perGame).toBeCloseTo(2.7 / 28);
    expect(estimate(job, [{ ...row({}), seconds: 200 }], "svwb-docker", 28)).toMatchObject({ perGame: 0.1 });
    // 並列数が違えば、スレッド秒で割り直す
    expect(estimate(job, [{ ...row({}), seconds: 200, threads: 14 }], "svwb-docker", 28).perGame).toBeCloseTo(0.05);
    // ほかのマシン・ほかの相手の回は使わない
    expect(estimate(job, [{ ...row({}), machine: "vm" }, { ...row({}), b: "classic" }], "svwb-docker", 28).perGame).toBeCloseTo(2.7 / 28);
    // 見落とし問題集は、全部の問を 1 回ずつ解く秒。台帳の回の問の数が今と違えば、問の数で割り直す
    const mjob = parseJob("misses --label x", 2);
    const mrow = (over: Partial<MissesRow>): MissesRow =>
      ({ kind: "misses", machine: "svwb-docker", threads: 28, trials: 24, seconds: 24, problems: 10, date: "2026-11-11" }) as MissesRow & typeof over;
    expect(estimate(mjob, [], "svwb-docker", 28).perGame).toBeCloseTo(5.9 / 28);
    expect(estimate(mjob, [], "svwb-docker", 28, [mrow({})]).perGame).toBeCloseTo(1);
    expect(estimate(mjob, [], "svwb-docker", 28, [{ ...mrow({}), problems: 5 }, { ...mrow({}), problems: 10 }]).perGame).toBeCloseTo(1.5);
    expect(estimate(parseJob("yardstick --ref strong --label x --est 0.3", 1), [row({})], "svwb-docker", 28).perGame).toBe(0.3);
    // 打ち比べ調査は、決めておいた値を局面の割合に比べて使う
    const sv = estimate(parseJob("survey --games 0-9 --label x", 3), [], "svwb-docker", 28).perGame;
    expect(estimate(parseJob("survey --games 0-9 --rate 0.05 --label x", 3), [], "svwb-docker", 28).perGame).toBeCloseTo(sv / 2);
  });

  it("--until は時刻帯の次のその時刻か、今からの長さ", () => {
    // 2026-11-10T19:27:08Z は東京で 11-11 04:27:08
    const now = Date.parse("2026-11-10T19:27:08Z");
    expect(new Date(parseUntil("07:00", now, "Asia/Tokyo")).toISOString()).toBe("2026-11-10T22:00:00.000Z");
    expect(new Date(parseUntil("04:00", now, "Asia/Tokyo")).toISOString()).toBe("2026-11-11T19:00:00.000Z");
    expect(parseUntil("+90m", now, "Asia/Tokyo") - now).toBe(90 * 60 * 1000);
    expect(wallClock(now, "Asia/Tokyo")).toMatchObject({ d: 11, h: 4, mi: 27 });
    expect(() => parseUntil("朝", now, "Asia/Tokyo")).toThrow(/--until/);
  });
});

/** 区切りの行（偽物の svwb が書く形） */
function chunkRow(first: number, count: number, seKind: "pairs" | "binomial"): RunRow {
  const pairs: [number, number, number] = [0, 0, 0];
  let wins = 0;
  for (let g = first; g < first + count; g++) {
    const w = (g * 7) % 3;
    pairs[w as 0 | 1 | 2]++;
    wins += w;
  }
  return {
    v: 1,
    kind: seKind === "pairs" ? "compare" : "yardstick",
    date: "2026-11-11",
    at: `2026-11-11T00:00:${String(first % 60).padStart(2, "0")}Z`,
    commit: "abc1234",
    branch: "main",
    label: "x",
    a: {},
    b: seKind === "pairs" ? {} : "classic",
    decks: [],
    mirror: seKind === "pairs",
    g: [first, first + count - 1],
    n: 2 * count,
    wins,
    rate: wins / (2 * count),
    se: 0,
    seKind,
    pairs,
    perDeck: { X: [wins, 2 * count] },
    seconds: count,
    perGame: 0.5,
    threads: 4,
    machine: "vm",
    cmd: "",
  };
}

describe("区切りの行をまとめる", () => {
  it("1 回で回したときと同じ勝ち数・組・誤差になる", () => {
    for (const seKind of ["pairs", "binomial"] as const) {
      const whole = chunkRow(0, 90, seKind);
      const c = combineRows([chunkRow(60, 30, seKind), chunkRow(0, 30, seKind), chunkRow(30, 30, seKind)], "compare 90", "n1");
      expect(c).toMatchObject({ g: [0, 89], n: 180, wins: whole.wins, pairs: whole.pairs, perDeck: whole.perDeck, seconds: 90, queue: "n1", chunks: 3, cmd: "compare 90" });
      const p = whole.wins / whole.n;
      const m = 90;
      const mean = (whole.pairs[1] * 0.5 + whole.pairs[2]) / m;
      const v = (whole.pairs[0] * mean ** 2 + whole.pairs[1] * (0.5 - mean) ** 2 + whole.pairs[2] * (1 - mean) ** 2) / (m - 1);
      const se = seKind === "pairs" ? Math.sqrt(v / m) : Math.sqrt((p * (1 - p)) / whole.n);
      expect(c.se).toBeCloseTo(se, 6);
      expect(c.at).toBe("2026-11-11T00:00:00Z");
    }
  });
});

/** svwb の代わり。台帳の行だけを書く（FAKE_FAIL の区切りは失敗、FAKE_HANG は 1 分待つ、FAKE_STOP_AT は終わった後に STOP を置く） */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const shellLine = (a) => a.map((x) => (x !== "" && /^[A-Za-z0-9_./,:=+\\-@%]+$/.test(x) ? x : "'" + x.replace(/'/g, "'\\\\''") + "'")).join(" ");
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const kind = argv[0];
let count, first, a, b;
if (kind === "compare") { count = Number(argv[1]); a = JSON.parse(argv[2]); b = JSON.parse(argv[3]); first = Number(argv[4]); }
else if (kind === "yardstick") { count = Number(flag("--games")); first = Number(flag("--start")); a = JSON.parse(flag("--opts")); b = flag("--ref"); }
else if (kind === "profile") { fs.writeFileSync(flag("--json"), "{}"); fs.writeFileSync(flag("--report"), "# 速さ"); process.exit(0); }
else if (kind === "survey" && argv[1] === "run") {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  const out = flag("--out");
  const [g0, g1] = flag("--games").split("-").map(Number);
  const rows = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : [];
  const have = new Set(rows.filter((o) => o.game).map((o) => o.g));
  let t = "";
  for (let g = g0; g <= g1; g++) if (!have.has(g)) t += JSON.stringify({ g, i: 3, p: 0 }) + "\\n" + JSON.stringify({ game: true, g, turnStarts: [9, 9] }) + "\\n";
  fs.appendFileSync(out, t);
  process.exit(0);
}
else if (kind === "survey" && argv[1] === "report") {
  const rows = fs.readFileSync(argv[2], "utf8").split("\\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  const games = rows.filter((o) => o.game).map((o) => o.g);
  const n = rows.length - games.length;
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a: {}, g: [Math.min(...games), Math.max(...games)], games: games.length, rate: 0.1, m: 32, extra: 4, confirm: 96, flag: 10,
    turnStarts: 18 * games.length, positions: n, compared: n, gain4: [0.5, 0.25], gain8: [1, 0.5], gain2: [0.5, 0.25], gain2Extra: [0, 0], flagged: 0, misses: 0, missesPerGame: [0, 0],
    splitAny: 0.5, splitPair: 0.25, pairSe: 0.1, perRollout: 1, seconds: n, machines: ["m"], commits: [process.env.SVWB_COMMIT], cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  console.log("# 打ち比べ調査");
  process.exit(0);
}
else if (kind === "misses") {
  const trials = Number(flag("--trials"));
  if (trials === 0) process.exit(0);
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a: JSON.parse(flag("--opts")), problems: 2, set: "abcd1234", trials, seed: Number(flag("--seed")), n: 2 * trials, passes: trials,
    rate: 0.5, se: 0.01, perProblem: { a: [trials, trials], b: [0, trials] }, seconds: trials / 10,
    threads: Number(process.env.THREADS), machine: process.env.SVWB_MACHINE, cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  process.exit(0);
}
if (count === 0) process.exit(0);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
if (String(first) === process.env.FAKE_FAIL) { console.error("わざと失敗"); process.exit(3); }
const finish = () => {
  const pairs = [0, 0, 0]; let wins = 0;
  for (let g = first; g < first + count; g++) { const w = (g * 7) % 3; pairs[w]++; wins += w; }
  const n = 2 * count;
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a, b, decks: ["X"], mirror: true, g: [first, first + count - 1], n, wins, rate: wins / n, se: 0.01,
    seKind: kind === "yardstick" && b === "classic" ? "binomial" : "pairs", pairs, perDeck: { X: [wins, n] }, seconds: count / 10, perGame: count / 10 / n,
    threads: Number(process.env.THREADS), machine: process.env.SVWB_MACHINE, cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  if (String(first) === process.env.FAKE_STOP_AT) fs.writeFileSync(path.join(path.dirname(process.env.SVWB_LEDGER), "STOP"), "");
};
if (String(first) === process.env.FAKE_HANG) setTimeout(finish, 60000); else finish();
`;

describe("区切って回す（偽物の svwb で）", () => {
  let tmp = "";
  let root = "";
  let jobs = "";
  let fake = "";
  let fakeLog = "";
  const env = ["FAKE_FAIL", "FAKE_HANG", "FAKE_STOP_AT", "FAKE_LOG"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "night-"));
    root = join(tmp, "runs");
    fake = join(tmp, "fake-svwb");
    writeFileSync(fake, FAKE, { mode: 0o755 });
    fakeLog = join(tmp, "calls.log");
    process.env.FAKE_LOG = fakeLog;
    jobs = join(tmp, "jobs.txt");
    // 1 試合 0.5 秒・1 区切り 1 分 → compare 150 組は 50 組ずつ 3 区切り。物差し・速さ・見落とし問題集は 1 区切り
    writeFileSync(
      jobs,
      [
        "# 試す",
        "compare 150 '{}' '{\"beamWidth\":8}' 0 --label 幅 --est 0.5",
        "yardstick --ref classic --games 40 --start 10 --label 弱 --est 0.5",
        "profile --games 2",
        "misses --trials 4 --label 問題集 --est 0.5",
      ].join("\n"),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of env) delete process.env[k];
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const start = (...more: string[]) =>
    main(["start", jobs, "--yes", "--root", root, "--name", "n1", "--bin", fake, "--allow-dirty", "--threads", "2", "--chunk-min", "1", "--until", "+2h", ...more]);
  const resume = (...more: string[]) => main(["resume", "n1", "--yes", "--root", root, "--foreground", "--threads", "2", "--until", "+2h", ...more]);
  const dir = () => join(root, "n1");
  const calls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n") : []);
  const done = () => readdirSync(join(dir(), "done")).map((f) => f.replace(/\.json$/, "")).sort();

  it("全部の区切りを回し、finish がジョブごとに 1 行にまとめて台帳に足す（2 回目は足さない）", async () => {
    expect(await start("--foreground")).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
    expect(calls()).toHaveLength(5);
    expect(calls()[4]).toBe(`misses run --opts '{}' --trials 4 --seed 1 --label '問題集'`);
    expect(readStatus(dir())).toMatchObject({ state: "done" });
    expect(existsSync(join(dir(), "speed-3.md"))).toBe(true);
    const target = join(tmp, "ledger.jsonl");
    writeFileSync(target, "");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    const rows = parseLedger(readFileSync(target, "utf8")).runs as (RunRow & { queue: string; chunks: number })[];
    expect(rows.map((r) => [r.label, r.g, r.n, r.chunks, r.queue])).toEqual([
      ["幅", [0, 149], 300, 3, "n1"],
      ["弱", [10, 49], 80, 1, "n1"],
    ]);
    expect(rows[0]?.cmd).toBe(`compare 150 '{}' '{"beamWidth":8}' 0 --label '幅'`);
    expect(rows[1]?.seKind).toBe("binomial");
    expect(rows[0]?.threads).toBe(2);
    const misses = parseLedger(readFileSync(target, "utf8")).misses as (MissesRow & { queue: string; chunks: number })[];
    expect(misses.map((r) => [r.label, r.trials, r.rate, r.queue, r.chunks])).toEqual([["問題集", 4, 0.5, "n1", 1]]);
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    expect(parseLedger(readFileSync(target, "utf8")).runs).toHaveLength(2);
    expect(parseLedger(readFileSync(target, "utf8")).misses).toHaveLength(1);
  });

  it("打ち比べ調査は区切りごとに同じ出力に足し、全部済んでから finish が survey report の 1 行を足す", async () => {
    // 1 試合 20 秒・1 区切り 1 分 → 3 試合ずつ 4 区切り
    writeFileSync(jobs, "survey run --games 0-9 --label 調査 --est 20\n");
    expect(await start("--foreground")).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "1-4"]);
    expect(calls().map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual(["--games 0-2", "--games 3-5", "--games 6-8", "--games 9-9"]);
    const out = join(dir(), "survey-1.jsonl");
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(20);
    // 出力に試合が揃っていて印が無い区切りは回さない。最後の区切りを消すと、finish は待つ
    unlinkSync(join(dir(), "done", "1-2.json"));
    unlinkSync(join(dir(), "done", "1-4.json"));
    writeFileSync(out, readFileSync(out, "utf8").split("\n").filter((l) => !l.includes('"g":9')).join("\n"));
    const target = join(tmp, "ledger.jsonl");
    writeFileSync(target, "");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    expect(parseLedger(readFileSync(target, "utf8")).surveys).toHaveLength(0);
    const before = calls().length;
    expect(await resume()).toBe(0);
    expect(calls().slice(before).map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual(["--games 9-9"]);
    expect(JSON.parse(readFileSync(join(dir(), "done", "1-2.json"), "utf8"))).toMatchObject({ recovered: true });
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    const rows = parseLedger(readFileSync(target, "utf8")).surveys as (SurveyRow & { queue: string; chunks: number })[];
    expect(rows.map((r) => [r.label, r.g, r.games, r.positions, r.queue, r.chunks])).toEqual([["調査", [0, 9], 10, 10, "n1", 4]]);
    expect(readFileSync(join(dir(), "survey-1.md"), "utf8")).toContain("打ち比べ調査");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    expect(parseLedger(readFileSync(target, "utf8")).surveys).toHaveLength(1);
  });

  it("失敗した区切りの後はそのジョブを飛ばし、resume で続きから回す", async () => {
    process.env.FAKE_FAIL = "50";
    expect(await start("--foreground")).toBe(1);
    expect(done()).toEqual(["1-1", "2-1", "3-1", "4-1"]);
    expect(readFileSync(join(dir(), "failed.json"), "utf8")).toContain("1-2");
    delete process.env.FAKE_FAIL;
    const before = calls().length;
    expect(await resume()).toBe(0);
    // 済んだ区切りは回さない
    expect(calls().slice(before).map((c) => c.split(" ").slice(0, 5).join(" "))).toEqual(["compare 50 '{}' '{\"beamWidth\":8}' 50", "compare 50 '{}' '{\"beamWidth\":8}' 100"]);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
  });

  it("台帳に行があって印が無い区切り（行を書いた直後に電源が切れた）は回さない", async () => {
    expect(await start("--foreground")).toBe(0);
    unlinkSync(join(dir(), "done", "1-2.json"));
    const before = calls().length;
    expect(await resume()).toBe(0);
    expect(calls().length).toBe(before);
    expect(JSON.parse(readFileSync(join(dir(), "done", "1-2.json"), "utf8"))).toMatchObject({ recovered: true });
  });

  it("STOP があれば区切りの切れ目で止まる", async () => {
    process.env.FAKE_STOP_AT = "50";
    expect(await start("--foreground")).toBe(1);
    expect(done()).toEqual(["1-1", "1-2"]);
    expect(readStatus(dir())?.reason).toMatch(/手で止めた/);
    // resume は STOP を消して続きから
    expect(await resume()).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
  });

  it("止める時刻までに終わらない区切りは始めない", async () => {
    // 50 組（100 試合）× 0.5 秒 = 50 秒の区切りを、残り 20 秒では始めない
    expect(await start("--foreground", "--until", "+20s")).toBe(1);
    expect(existsSync(join(dir(), "done"))).toBe(false);
    expect(readStatus(dir())?.reason).toMatch(/止める時刻/);
  });

  it("すぐ止める（stop --now）と回していた区切りを捨て、resume で回し直す", async () => {
    process.env.FAKE_HANG = "50";
    expect(await start("--prepare-only")).toBe(0);
    const ctl: WorkerControl = { stopNow: false };
    const timer = setInterval(() => {
      if (calls().length >= 2) {
        ctl.stopNow = true;
        ctl.kill?.();
        clearInterval(timer);
      }
    }, 50);
    const st = await runWorker(dir(), ctl);
    expect(st.reason).toMatch(/すぐ止めた/);
    expect(done()).toEqual(["1-1"]);
    expect(parseLedger(readFileSync(join(dir(), "ledger.jsonl"), "utf8")).runs).toHaveLength(1);
    delete process.env.FAKE_HANG;
    expect(await resume()).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
  });
});
