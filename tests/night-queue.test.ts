// キュー（pueue。scripts/night-main.ts・scripts/night-pueue.ts・docs/queue.md「キュー（pueue）」）。
// 券と task の作り方はいつも確かめる。本物の pueue（pueue・pueued が PATH にあるか、SVWB_PUEUE が pueue を指すとき）で、
// 積む・回す・一時停止・落ちたときの続きを、svwb の偽物で通す（pueue の無いところでは飛ばす）

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLedger, type RunRow } from "../scripts/ledger-main";
import { main, makeTicket, parseJobs, queueSpecs, ticketText, type Plan } from "../scripts/night-main";
import { labelOf, parseStatus, pueueStatus, taskLabel, type PStatus } from "../scripts/night-pueue";
import { FAKE, gitT } from "./night-helpers";

describe("pueue の様子と task の名前", () => {
  it("pueue status --json（4.0.5 の形）を読む", () => {
    const st = parseStatus(
      JSON.stringify({
        tasks: {
          "0": { id: 0, label: "q1 1-1 幅 g0-49", group: "svwb", status: { Done: { enqueued_at: "2026-11-23T17:41:20Z", start: "2026-11-23T17:41:21Z", end: "2026-11-23T17:41:28Z", result: "Success" } }, dependencies: [] },
          "1": { id: 1, label: "q1 1-2", group: "svwb", status: { Done: { start: null, end: "2026-11-23T17:41:28Z", result: { Failed: 3 } } }, dependencies: [0] },
          "2": { id: 2, label: "q1 1-3", group: "svwb", status: { Done: { result: "DependencyFailed" } }, dependencies: [1] },
          "3": { id: 3, label: "q2 1-1", group: "svwb", status: { Running: { enqueued_at: "2026-11-23T17:41:20Z", start: "2026-11-23T17:41:30Z" } }, dependencies: [] },
          "4": { id: 4, label: "止める時刻 07:00", group: "svwb-ctl", status: { Stashed: { enqueue_at: "2026-11-23T22:00:00Z" } }, dependencies: [] },
          "5": { id: 5, label: null, group: "default", status: { Queued: { enqueued_at: "2026-11-23T17:41:20Z" } }, dependencies: [] },
        },
        groups: { svwb: { status: "Paused", parallel_tasks: 1 }, "svwb-ctl": { status: "Running", parallel_tasks: 0 } },
      }),
    );
    expect(st.tasks.map((t) => [t.id, t.state])).toEqual([
      [0, "Success"],
      [1, "Failed"],
      [2, "DependencyFailed"],
      [3, "Running"],
      [4, "Stashed"],
      [5, "Queued"],
    ]);
    expect(st.tasks[3]?.start).toBe(Date.parse("2026-11-23T17:41:30Z"));
    expect(st.tasks[4]?.enqueueAt).toBe(Date.parse("2026-11-23T22:00:00Z"));
    expect(st.groups).toEqual({ svwb: { status: "Paused", parallel: 1 }, "svwb-ctl": { status: "Running", parallel: 0 } });
  });
  it("task の名前の頭 2 語が回の名前と役目", () => {
    expect(taskLabel("q1", "1-3", "幅 g100-149")).toBe("q1 1-3 幅 g100-149");
    expect(labelOf("q1 1-3 幅 g100-149")).toEqual({ run: "q1", role: "1-3" });
    expect(labelOf("q1 まとめ")).toEqual({ run: "q1", role: "まとめ" });
    expect(labelOf("止める時刻 07:00")).toBeNull();
    expect(labelOf("")).toBeNull();
  });
});

describe("積む task の並びとつながり", () => {
  const plan = (text: string, chunks: [number, string, number, number][]): Plan => ({
    v: 1,
    name: "q1",
    created: "2026-11-24T00:00:00Z",
    repo: "/r/src",
    jobsFile: "/r/src/night/t.txt",
    commit: "abc1234",
    branch: "claude/x",
    bin: "/r/bin/svwb",
    chunkMin: 7.5,
    jobs: parseJobs(text),
    estimates: [],
    chunks: chunks.map(([job, id, first, count]) => ({ job, k: Number(id.split("-")[1]), id, first, count })),
    queue: 1,
  });
  const p = plan(
    [
      "td selfplay --model data/value-net.json --games 8 --start 100 --chunk 4 --out @/s-{k}.jsonl.gz --est 0.1",
      "td train --model data/value-net.json --data @/s-{1..2}.jsonl.gz --out @/a.json --est 1",
      `compare 20 '{"valueNet":"@/a.json"}' '{}' 0 --label c --est 0.1`,
      "pick --compare c --pass @/a.json --fail @/a.json --out @/p.json",
      `compare 10 '{"valueNet":"@run:prev/w.json"}' '{}' 0 --label d --est 0.1`,
    ].join("\n"),
    [
      [1, "1-1", 100, 4],
      [1, "1-2", 104, 4],
      [2, "2-1", 0, 1],
      [3, "3-1", 0, 10],
      [3, "3-2", 10, 10],
      [4, "4-1", 0, 1],
      [5, "5-1", 0, 10],
    ],
  );
  const pairs = (specs: ReturnType<typeof queueSpecs>) => specs.map((s) => [s.role, s.after, s.afterIds]);

  it("組み立て → 区切り（同じジョブは 1 つ前の後、最初は読むファイルを作るジョブの後）→ まとめ。前の回のファイルが無ければ、それを作る task の後", () => {
    const asked: string[] = [];
    const specs = queueSpecs(p, "/r", new Set(), false, (ref) => {
      asked.push(ref);
      return 41;
    });
    expect(asked).toEqual(["@run:prev/w.json"]);
    expect(pairs(specs)).toEqual([
      ["組み立て", [], [41]],
      ["1-1", ["組み立て"], []],
      ["1-2", ["1-1"], []],
      ["2-1", ["組み立て", "1-1", "1-2"], []],
      ["3-1", ["組み立て", "2-1"], []],
      ["3-2", ["3-1"], []],
      // pick は compare の後と、pass・fail のファイルを作るジョブの後
      ["4-1", ["組み立て", "2-1", "3-1", "3-2"], []],
      ["5-1", ["組み立て"], []],
      ["まとめ", [], []],
    ]);
    expect(specs[1]?.args).toEqual(["chunk", "/r", "1-1"]);
    expect(specs[1]?.note).toBe("td selfplay → @/s-{k}.jsonl.gz g100-103");
    expect(specs.at(-1)?.args).toEqual(["wrap", "q1"]);
  });

  it("済んだ区切りと組み立ては積まない。全部済んでいれば何も積まない。前の回のファイルが無く、作る task も無ければ断る", () => {
    const specs = queueSpecs(p, "/r", new Set(["1-1", "1-2", "3-1"]), true, () => null);
    // ready（組み立て済み）なら @run: は組み立ての時に確かめるので、ここでは聞かない
    expect(pairs(specs)).toEqual([
      ["2-1", [], []],
      ["3-2", ["2-1"], []],
      ["4-1", ["2-1", "3-2"], []],
      ["5-1", [], []],
      ["まとめ", [], []],
    ]);
    expect(queueSpecs(p, "/r", new Set(p.chunks.map((c) => c.id)), false, () => null)).toEqual([]);
    expect(() => queueSpecs(p, "/r", new Set(), false, () => null)).toThrow(/@run:prev\/w.json/);
  });
});

// ---------------------------------------------------------------- 本物の pueue で

const PUEUE = process.env.SVWB_PUEUE || "pueue";
const PUEUED = process.env.SVWB_PUEUE ? join(dirname(process.env.SVWB_PUEUE), "pueued") : "pueued";
const hasPueue = spawnSync(PUEUE, ["--version"]).status === 0 && spawnSync(PUEUED, ["--version"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** cmdline に s を含むプロセスを全部 kill -9（コンテナが止まったのと同じ: pueued も task も） */
function killAll(s: string): void {
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${p}/cmdline`, "utf8").includes(s)) process.kill(Number(p), "SIGKILL");
    } catch {
      // もう終わった
    }
  }
}

/** プロセスの様子（ps の STAT の 1 文字目。T なら止めてある） */
function procState(match: (cmd: string) => boolean): string[] {
  const out: string[] = [];
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").join(" ");
      if (match(cmd)) out.push(readFileSync(`/proc/${p}/stat`, "utf8").replace(/^.*\) /, "")[0] ?? "?");
    } catch {
      // もう終わった
    }
  }
  return out;
}

describe.skipIf(!hasPueue)("キュー（本物の pueue・偽物の svwb で）", () => {
  let tmp = "";
  let root = "";
  let fake = "";
  let fakeLog = "";
  let pcGit = "";
  let orig = "";
  let cfg = "";
  const env = ["FAKE_FAIL", "FAKE_HANG", "FAKE_HANG_MS", "FAKE_LOG", "SVWB_NIGHT_GIT_DIR", "SVWB_NIGHT_REMOTE", "PUEUE_CONFIG_PATH", "SVWB_OUTBOX_DIR"];
  const calls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n").filter((l) => l !== "") : []);
  const done = (name: string) => (existsSync(join(root, name, "done")) ? readdirSync(join(root, name, "done")).map((f) => f.replace(/\.json$/, "")).sort() : []);
  const said = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
  const mine = (st: PStatus, name: string) => st.tasks.filter((t) => labelOf(t.label)?.run === name);

  const startDaemon = async () => {
    const d = spawn(PUEUED, ["--config", cfg], { detached: true, stdio: "ignore" });
    d.unref();
    for (let i = 0; i < 100; i++) {
      if (spawnSync(PUEUE, ["status"], { encoding: "utf8" }).status === 0) return;
      await sleep(100);
    }
    throw new Error("pueued が立ち上がらない");
  };
  /** 組 svwb の task が全部終わるまで待つ */
  const idle = async (ms = 60_000) => {
    const t0 = Date.now();
    for (;;) {
      const st = pueueStatus();
      if (!st.tasks.some((t) => t.group === "svwb" && ["Queued", "Running", "Locked"].includes(t.state))) return st;
      if (Date.now() - t0 > ms) throw new Error(`終わらない: ${JSON.stringify(st.tasks.map((t) => [t.label, t.state]))}`);
      await sleep(200);
    }
  };
  const until = async (f: (st: PStatus) => boolean, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const st = pueueStatus();
      if (f(st)) return st;
      if (Date.now() - t0 > ms) throw new Error(`そうならない: ${JSON.stringify(st.tasks.map((t) => [t.label, t.state]))}`);
      await sleep(100);
    }
  };
  /** GitHub の代わりのリポジトリにジョブのファイルをコミットし、積む券を作る */
  const ticket = (name: string, file: string, text: string) => {
    writeFileSync(join(orig, "night", file), text);
    gitT(orig, "add", ".");
    gitT(orig, "commit", "-q", "--allow-empty", "-m", `ジョブ ${file}`);
    const full = gitT(orig, "rev-parse", "HEAD");
    return ticketText(makeTicket({ name, branch: "claude/x", commit: full.slice(0, 12), jobs: `night/${file}`, threads: 2, chunk: 1 }, text));
  };
  const add = (t: string) => main(["add", ...t.split(" "), "--root", root, "--bin", fake]);

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nq-"));
    root = join(tmp, "runs");
    cfg = join(tmp, "pueue.yml");
    writeFileSync(cfg, `shared:\n  pueue_directory: ${join(tmp, "pq")}\n  runtime_directory: ${join(tmp, "rt")}\n`);
    mkdirSync(join(tmp, "rt"));
    process.env.PUEUE_CONFIG_PATH = cfg;
    process.env.SVWB_OUTBOX_DIR = join(tmp, "outbox");
    await startDaemon();
    // PC の /workspace の代わり（台帳の行を night/<回> にコミットする先）。依存は券のコミットと同じ（node_modules を指す）
    pcGit = join(tmp, "pc-git");
    mkdirSync(join(pcGit, "docs"), { recursive: true });
    mkdirSync(join(pcGit, "node_modules"));
    writeFileSync(join(pcGit, "docs", "ledger.jsonl"), `${JSON.stringify({ v: 1, kind: "decision", note: "前からある行" })}\n`);
    writeFileSync(join(pcGit, "package-lock.json"), "{}\n");
    gitT(pcGit, "init", "-q", "-b", "main");
    gitT(pcGit, "add", ".");
    gitT(pcGit, "commit", "-q", "-m", "最初");
    process.env.SVWB_NIGHT_GIT_DIR = pcGit;
    // GitHub の代わり。キューのスクリプト（今のもの）をコミットする
    const here = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
    orig = join(tmp, "origin-git");
    for (const d of ["scripts", "night", "docs"]) mkdirSync(join(orig, d), { recursive: true });
    for (const f of ["night-main.ts", "night-outbox.ts", "night-pueue.ts", "ledger-main.ts", "pack-run-main.ts"]) copyFileSync(join(here, f), join(orig, "scripts", f));
    copyFileSync(join(pcGit, "docs", "ledger.jsonl"), join(orig, "docs", "ledger.jsonl"));
    writeFileSync(join(orig, "package-lock.json"), "{}\n");
    gitT(orig, "init", "-q", "-b", "claude/x");
    gitT(orig, "add", ".");
    gitT(orig, "commit", "-q", "-m", "キュー");
    process.env.SVWB_NIGHT_REMOTE = orig;
    fake = join(tmp, "fake-svwb");
    writeFileSync(fake, FAKE, { mode: 0o755 });
    fakeLog = join(tmp, "calls.log");
    process.env.FAKE_LOG = fakeLog;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    killAll(tmp);
    for (const k of env) delete process.env[k];
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("いつでも積めて、積んだだけでは回らない。start で先頭から順に回り、回ごとに台帳の行を night/<回> にコミットする", async () => {
    // 1 試合 0.5 秒・1 区切り 1 分 → compare 150 組は 50 組ずつ 3 区切り
    const t1 = ticket("q1", "t.txt", ["compare 150 '{}' '{\"beamWidth\":8}' 0 --label 幅 --est 0.5", "misses --trials 4 --label 問題集 --est 0.5"].join("\n"));
    const t2 = ticket("q2", "u.txt", "yardstick --ref classic --games 40 --start 10 --label 弱 --est 0.5\n");
    expect(await add(t1)).toBe(0);
    let st = pueueStatus();
    expect(st.groups.svwb?.status).toBe("Paused");
    expect(mine(st, "q1").map((t) => [labelOf(t.label)?.role, t.state])).toEqual([
      ["組み立て", "Queued"],
      ["1-1", "Queued"],
      ["1-2", "Queued"],
      ["1-3", "Queued"],
      ["2-1", "Queued"],
      ["まとめ", "Queued"],
    ]);
    // 後ろに別の券を積み、同じ券をもう一度積んでも増えない
    expect(await add(t2)).toBe(0);
    expect(await add(t1)).toBe(0);
    st = pueueStatus();
    expect(mine(st, "q1")).toHaveLength(6);
    expect(mine(st, "q2").map((t) => labelOf(t.label)?.role)).toEqual(["組み立て", "1-1", "まとめ"]);
    await sleep(500);
    expect(calls()).toEqual([]);
    expect(existsSync(join(root, "q1", "done"))).toBe(false);
    vi.mocked(console.log).mockClear();
    expect(await main(["status", "--root", root])).toBe(0);
    expect(said()).toContain("キュー: 止まっている");
    expect(said()).toMatch(/q1 .*積んである 4 区切り/);
    // 回す
    expect(await main(["start", "--root", root, "--until", "+2h"])).toBe(0);
    st = await idle();
    expect(st.tasks.filter((t) => t.group === "svwb-ctl").map((t) => [t.label.split(" ")[0], t.state])).toEqual([["止める時刻", "Stashed"]]);
    expect(mine(st, "q1").every((t) => t.state === "Success")).toBe(true);
    expect(done("q1")).toEqual(["1-1", "1-2", "1-3", "2-1"]);
    expect(done("q2")).toEqual(["1-1"]);
    // 回は積んだ順（q1 の区切り → q2）
    expect(calls().map((c) => c.split(" ").slice(0, 5).join(" "))).toEqual([
      "compare 50 '{}' '{\"beamWidth\":8}' 0",
      "compare 50 '{}' '{\"beamWidth\":8}' 50",
      "compare 50 '{}' '{\"beamWidth\":8}' 100",
      "misses run --opts '{}' --trials",
      "yardstick --ref classic --opts '{}'",
    ]);
    const rows = parseLedger(gitT(pcGit, "show", "night/q1:docs/ledger.jsonl")).runs as (RunRow & { queue?: string; chunks?: number })[];
    expect(rows.filter((r) => r.queue === "q1").map((r) => [r.label, r.g, r.chunks])).toEqual([["幅", [0, 149], 3]]);
    expect(parseLedger(gitT(pcGit, "show", "night/q2:docs/ledger.jsonl")).runs.map((r) => r.label)).toEqual(["弱"]);
    expect(JSON.parse(readFileSync(join(root, "q1", "status.json"), "utf8"))).toMatchObject({ state: "done", branch: expect.stringContaining("night/q1") });
    vi.mocked(console.log).mockClear();
    expect(await main(["status", "--root", root])).toBe(0);
    expect(said()).toContain("積んである回はありません");
    // --until を付けずに start し直すと、前の止める時刻はやめる（止める時刻は付けたときだけ）
    expect(await main(["start", "--root", root])).toBe(0);
    expect(pueueStatus().tasks.filter((t) => t.group === "svwb-ctl" && t.state === "Stashed")).toEqual([]);
    // まとめが済んだ回は、queue-push.sh の wrap --pending が拾わない
    vi.mocked(console.log).mockClear();
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toContain("まとめが済んでいない回はありません");
  }, 120_000);

  it("一時停止すると回している区切りは凍り（失わない）、start で続きから。落ちると中断になり、start がその区切りから積み直す", async () => {
    process.env.FAKE_HANG = "50";
    process.env.FAKE_HANG_MS = "3000";
    const t1 = ticket("q1", "t.txt", "compare 150 '{}' '{\"beamWidth\":8}' 0 --label 幅 --est 0.5\n");
    expect(await add(t1)).toBe(0);
    expect(await main(["start", "--root", root, "--until", "none"])).toBe(0);
    await until((st) => mine(st, "q1").some((t) => labelOf(t.label)?.role === "1-2" && t.state === "Running"));
    await sleep(300);
    expect(await main(["pause", "--root", root])).toBe(0);
    await until((st) => mine(st, "q1").some((t) => labelOf(t.label)?.role === "1-2" && t.state === "Paused"));
    // 偽物の svwb は止めてある（T）。待たせる時間を過ぎても済まない
    expect(procState((c) => c.includes(join(root, "q1", "bin", "svwb")) && c.includes(" 50 --label"))).toEqual(["T"]);
    await sleep(3500);
    expect(done("q1")).toEqual(["1-1"]);
    // 凍っている間でも、済んだ区切りはまとめられる（朝の queue-push.sh）
    vi.mocked(console.log).mockClear();
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toContain("q1 をまとめる");
    expect(await main(["start", "--root", root])).toBe(0);
    await idle();
    expect(done("q1")).toEqual(["1-1", "1-2", "1-3"]);
    // 回し直していない（g50 の区切りは 1 回だけ）
    expect(calls().filter((c) => c.includes("compare 50 '{}' '{\"beamWidth\":8}' 50 "))).toHaveLength(1);

    // 落ちる: 回している途中で pueued も task も kill -9（コンテナが止まったのと同じ）
    const t2 = ticket("q2", "u.txt", "compare 150 '{}' '{\"beamWidth\":16}' 0 --label 幅2 --est 0.5\n");
    expect(await add(t2)).toBe(0);
    await until((st) => mine(st, "q2").some((t) => labelOf(t.label)?.role === "1-2" && t.state === "Running"));
    // 偽物の svwb が回り始めてから（引数を書いた後）
    const g50 = (c: string) => c.includes("compare 50 '{}' '{\"beamWidth\":16}' 50 ");
    for (let i = 0; i < 100 && !calls().some(g50); i++) await sleep(100);
    killAll(tmp);
    await sleep(300);
    await startDaemon();
    let st = pueueStatus();
    // 回していたものは中断になり、組は止まったまま（勝手に始まらない）
    expect(st.groups.svwb?.status).toBe("Paused");
    expect(mine(st, "q2").map((t) => [labelOf(t.label)?.role, t.state])).toEqual([
      ["組み立て", "Success"],
      ["1-1", "Success"],
      ["1-2", "Killed"],
      ["1-3", "Queued"],
      ["まとめ", "Queued"],
    ]);
    vi.mocked(console.log).mockClear();
    expect(await main(["status", "--root", root])).toBe(0);
    expect(said()).toMatch(/q2 .*中断した 1 区切り/);
    expect(await main(["start", "--root", root])).toBe(0);
    st = await idle();
    expect(done("q2")).toEqual(["1-1", "1-2", "1-3"]);
    // 中断した区切りは最初から回し直した（g50 を 2 回）
    expect(calls().filter(g50)).toHaveLength(2);
    expect(parseLedger(gitT(pcGit, "show", "night/q2:docs/ledger.jsonl")).runs.filter((r) => r.label === "幅2").map((r) => r.g)).toEqual([[0, 149]]);
  }, 120_000);

  it("区切りが失敗したらそのジョブの残りは飛ばし、ほかのジョブと後ろの券は回る。直したら回の名前で積み直す", async () => {
    process.env.FAKE_FAIL = "50";
    const t1 = ticket("q1", "t.txt", ["compare 150 '{}' '{\"beamWidth\":8}' 0 --label 幅 --est 0.5", "misses --trials 4 --label 問題集 --est 0.5"].join("\n"));
    const t2 = ticket("q2", "u.txt", "yardstick --ref classic --games 40 --start 10 --label 弱 --est 0.5\n");
    expect(await add(t1)).toBe(0);
    expect(await add(t2)).toBe(0);
    expect(await main(["start", "--root", root])).toBe(0);
    let st = await idle();
    expect(mine(st, "q1").map((t) => [labelOf(t.label)?.role, t.state])).toEqual([
      ["組み立て", "Success"],
      ["1-1", "Success"],
      ["1-2", "Failed"],
      ["1-3", "DependencyFailed"],
      ["2-1", "Success"],
      ["まとめ", "Success"],
    ]);
    expect(done("q1")).toEqual(["1-1", "2-1"]);
    expect(done("q2")).toEqual(["1-1"]);
    expect(readFileSync(join(root, "q1", "failed.json"), "utf8")).toContain("1-2");
    vi.mocked(console.log).mockClear();
    expect(await main(["status", "--root", root])).toBe(0);
    expect(said()).toMatch(/q1 .*積んでいない 2 区切り/);
    // 直して積み直す（回の名前で。済んだ区切りと組み立ては積まない）。止めてから積むと、積むだけで回らない
    delete process.env.FAKE_FAIL;
    expect(await main(["pause", "--root", root])).toBe(0);
    expect(await main(["add", "q1", "--root", root])).toBe(0);
    st = pueueStatus();
    expect(mine(st, "q1").filter((t) => t.state === "Queued").map((t) => labelOf(t.label)?.role)).toEqual(["1-2", "1-3", "まとめ"]);
    expect(await main(["start", "--root", root])).toBe(0);
    st = await idle();
    expect(done("q1")).toEqual(["1-1", "1-2", "1-3", "2-1"]);
    expect(JSON.parse(readFileSync(join(root, "q1", "failed.json"), "utf8"))).toEqual({});
    const rows = parseLedger(gitT(pcGit, "show", "night/q1:docs/ledger.jsonl")).runs as (RunRow & { queue?: string })[];
    expect(rows.filter((r) => r.queue === "q1").map((r) => [r.label, r.g])).toEqual([
      ["幅", [0, 49]],
      ["幅", [50, 149]],
    ]);
  }, 120_000);
});
