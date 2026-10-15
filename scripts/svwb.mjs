// Rust 版の CLI（svwb。rust/engine/src/main.rs）を作ってから、引数をそのまま渡して実行する（npm run compare・rhino-compare 等）。
// 使い方: node scripts/svwb.mjs <サブコマンド> [引数...]（サブコマンドは rust/README.md）
// Rust（cargo）が要る。カードのデータ等は npm run rust-data で書き出してから作る（中身が変わらなければ作り直さない）。

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

run(process.execPath, [join(root, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
run("cargo", ["build", "--quiet", "--release", "--manifest-path", "rust/Cargo.toml", "-p", "svwb-engine"]);
const r = spawnSync(join(root, "rust/target/release/svwb"), process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
