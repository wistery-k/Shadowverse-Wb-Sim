// キューのテストの道具（tests/night.test.ts・tests/night-queue.test.ts）

import { spawnSync } from "node:child_process";

/** svwb の代わり: 台帳の行と棋譜だけを書く（区切り・再開・止め方・まとめを確かめる）。
 * FAKE_FAIL（その試合番号から始まる区切りを失敗にする）・FAKE_HANG（その区切りを FAKE_HANG_MS ミリ秒待たせる）・FAKE_STOP_AT（その区切りの後に STOP を置く）・
 * FAKE_LOG（引数を書く）・FAKE_WIN（全部 A の勝ち） */
export const FAKE = `#!/usr/bin/env node
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
else if (kind === "td" && (argv[1] === "train" || argv[1] === "prune")) {
  // Rust 版の学習（--impl rust）。--out に引数を書く
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  fs.writeFileSync(flag("--out"), JSON.stringify({ tool: "svwb", argv }));
  process.exit(0);
}
else if ((kind === "td" && argv[1] === "selfplay") || kind === "beam-gap") {
  const g = Number(flag("--games"));
  const s = Number(flag(kind === "td" ? "--start" : "--from"));
  if (g > 0 && process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  if (String(s) === process.env.FAKE_FAIL) { console.error("わざと失敗"); process.exit(3); }
  let t = kind === "td" ? JSON.stringify({ tdLayout: {} }) + "\\n" : "";
  for (let i = s; i < s + g; i++) t += JSON.stringify({ g: i }) + "\\n";
  fs.writeFileSync(flag(kind === "td" ? "--out" : "--inputs"), t);
  if (kind === "beam-gap" && flag("--out")) fs.writeFileSync(flag("--out"), "");
  process.exit(0);
}
if (count === 0) process.exit(0);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
if (String(first) === process.env.FAKE_FAIL) { console.error("わざと失敗"); process.exit(3); }
const finish = () => {
  // 棋譜（本物の svwb と同じく、SVWB_KIFU_DIR の下に .tmp で書いてから名前を替える）
  if (process.env.SVWB_KIFU_DIR) {
    fs.mkdirSync(process.env.SVWB_KIFU_DIR, { recursive: true });
    const k = path.join(process.env.SVWB_KIFU_DIR, kind + "-g" + first + "-" + (first + count - 1) + ".jsonl");
    fs.writeFileSync(k + ".tmp", JSON.stringify({ kind: "replay", version: 2, g: first }) + "\\n");
    fs.renameSync(k + ".tmp", k);
  }
  const pairs = [0, 0, 0]; let wins = 0;
  for (let g = first; g < first + count; g++) { const w = process.env.FAKE_WIN ? 2 : (g * 7) % 3; pairs[w]++; wins += w; }
  const n = 2 * count;
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a, b, decks: ["X"], mirror: true, g: [first, first + count - 1], n, wins, rate: wins / n, se: 0.01,
    seKind: kind === "yardstick" && b === "classic" ? "binomial" : "pairs", pairs, perDeck: { X: [wins, n] }, seconds: count / 10, perGame: count / 10 / n,
    threads: Number(process.env.THREADS), machine: process.env.SVWB_MACHINE, cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  if (String(first) === process.env.FAKE_STOP_AT) fs.writeFileSync(path.join(path.dirname(process.env.SVWB_LEDGER), "STOP"), "");
};
if (String(first) === process.env.FAKE_HANG) setTimeout(finish, Number(process.env.FAKE_HANG_MS || 60000)); else finish();
`;

/** git を回す（試す用の名前とメールで） */
export const gitT = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
