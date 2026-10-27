// 対戦の速さを測る（svwb profile。rust/engine/src/runner/profile.rs）。
// 測らないビルドでデッキごとの 1 試合の時間を、測るビルド（--features profile。rust/target/profile に作る）で処理ごとの内訳を取り、
// 同じ試合になったことを確かめてから 1 つの報告にまとめる（docs/profile.md）。
//
// 使い方: npm run profile -- [--games 49] [--start 0] [--opts '{}'] [--rhino] [--out <場所>] [--time-only] [--label 名前 --record]
//   --out        結果（time.json・sections.json・report.md）を置く場所（既定 rust/target/profile-report）
//   --time-only  測らないビルドだけで回す（内訳なし。半分の時間）
//   --label・--record は最後の実行に渡す（docs/profile.md の表に 1 行足す）。ほかの引数は両方の実行に渡す
// Rust（cargo）が要る。カードのデータ等は npm run rust-data で書き出してから作る（中身が変わらなければ作り直さない）。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });

const argv = process.argv.slice(2);
let out = join(root, "rust/target/profile-report");
let timeOnly = false;
const common = [];
const last = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") out = resolve(argv[++i]);
  else if (a === "--time-only") timeOnly = true;
  else if (a === "--record") last.push(a);
  else if (a === "--label") last.push(a, argv[++i]);
  else if (a === "--rhino") common.push(a);
  else if (["--games", "--start", "--opts"].includes(a)) common.push(a, argv[++i]);
  else {
    console.error(`未知の引数: ${a}`);
    process.exit(2);
  }
}
mkdirSync(out, { recursive: true });
const time = join(out, "time.json");
const report = join(out, "report.md");

run(process.execPath, [join(root, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
const manifest = ["--manifest-path", "rust/Cargo.toml", "-p", "svwb-engine"];
run("cargo", ["build", "--quiet", "--release", ...manifest]);
console.error("測らないビルドで時間を測る");
run(join(root, "rust/target/release/svwb"), [
  "profile",
  ...common,
  "--json",
  time,
  ...(timeOnly ? ["--report", report, ...last] : ["--report", join(out, "time.md")]),
]);
if (!timeOnly) {
  const target = join(root, "rust/target/profile");
  run("cargo", ["build", "--quiet", "--release", "--features", "profile", ...manifest], { CARGO_TARGET_DIR: target });
  console.error("測るビルドで処理ごとの内訳を測る");
  run(join(target, "release/svwb"), [
    "profile",
    ...common,
    "--json",
    join(out, "sections.json"),
    "--baseline",
    time,
    "--report",
    report,
    ...last,
  ]);
}
process.stdout.write(readFileSync(report, "utf8"));
console.error(`報告: ${report}`);
