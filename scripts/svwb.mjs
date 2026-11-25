// Rust 版の CLI（svwb。rust/engine/src/main.rs）を作ってから、引数をそのまま渡して実行する（npm run compare・rhino-compare 等）。
// 使い方: node scripts/svwb.mjs <サブコマンド> [引数...]（サブコマンドは rust/README.md）
// Rust（cargo）が要る。カードのデータ等は npm run rust-data で書き出してから作る（中身が変わらなければ作り直さない）。

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

run(process.execPath, [join(root, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
run("cargo", ["build", "--quiet", "--release", "--manifest-path", "rust/Cargo.toml", "-p", "svwb-engine"]);
// cargo の置き場は CARGO_TARGET_DIR があればそこ（scripts/build-wasm.mjs と同じ）
const target = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, "rust/target");
// SVWB_PRELOAD（PC のコンテナは jemalloc。docker/remote-control/Dockerfile）があれば、svwb にだけ LD_PRELOAD で差し込む
// （メモリの確保が速くなる。値も試合も変わらない。docs/profile.md「メモリの確保」。scripts/night-main.ts の svwbPreload と同じ）
const lib = process.env.SVWB_PRELOAD;
const env = lib && existsSync(lib) ? { ...process.env, LD_PRELOAD: lib } : process.env;
const r = spawnSync(join(target, "release/svwb"), process.argv.slice(2), { stdio: "inherit", env });
process.exit(r.status ?? 1);
