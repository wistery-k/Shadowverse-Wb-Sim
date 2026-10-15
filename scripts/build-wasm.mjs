// エンジンと AI の WASM（rust/wasm）を作り、src/engine/svwb.wasm に置く（npm run wasm）。
// 1. npm run rust-data: カードのデータ・能力の定義・AI のデータを rust/engine/data/ に書き出す（中身が変わらなければ書き直さない）
// 2. cargo で wasm32-unknown-unknown 向けにビルドする（変更が無ければすぐ終わる）
// 3. できた .wasm を src/engine/svwb.wasm にコピーする（src/engine/wasm.ts が読み込む）
// Rust（cargo と rustup target add wasm32-unknown-unknown）が要る。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

run(process.execPath, [join(root, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
run("cargo", ["build", "--quiet", "--manifest-path", "rust/Cargo.toml", "-p", "svwb-wasm", "--profile", "wasm", "--target", "wasm32-unknown-unknown"]);
const built = join(root, "rust/target/wasm32-unknown-unknown/wasm/svwb_wasm.wasm");
const dest = join(root, "src/engine/svwb.wasm");
if (!existsSync(dest) || !readFileSync(dest).equals(readFileSync(built))) copyFileSync(built, dest);
