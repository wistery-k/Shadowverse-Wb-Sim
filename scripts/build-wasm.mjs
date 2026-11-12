// エンジンと AI の WASM（rust/wasm）を作り、src/engine/svwb.wasm に置く（npm run wasm）。
// 1. npm run rust-data: カードのデータ・能力の定義・AI のデータを rust/engine/data/ に書き出す（中身が変わらなければ書き直さない）
// 2. cargo で wasm32-unknown-unknown 向けにビルドする（変更が無ければすぐ終わる）
// 3. できた .wasm を src/engine/svwb.wasm にコピーする（Node のテスト・スクリプトが読み込む）
// 4. gzip で縮めたもの（src/engine/svwb.wasm.gz）も作る。ブラウザはこちらを読み込んで戻す（src/engine/wasm.ts）。
//    WASM は 10MB ほどあり（大半は埋め込んだ AI の学習データ）、配信で縮められないと読み込みが重いため
// Rust（cargo と rustup target add wasm32-unknown-unknown）が要る。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gunzipSync, gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

run(process.execPath, [join(root, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
run("cargo", ["build", "--quiet", "--manifest-path", "rust/Cargo.toml", "-p", "svwb-wasm", "--profile", "wasm", "--target", "wasm32-unknown-unknown"]);
const built = join(root, "rust/target/wasm32-unknown-unknown/wasm/svwb_wasm.wasm");
const dest = join(root, "src/engine/svwb.wasm");
if (!existsSync(dest) || !readFileSync(dest).equals(readFileSync(built))) copyFileSync(built, dest);
// gzip の頭に時刻は入らない（Node の zlib は MTIME を 0 にする）ので、同じ WASM からは同じファイルになる
const gz = `${dest}.gz`;
const wasm = readFileSync(dest);
if (!existsSync(gz) || !gunzipSync(readFileSync(gz)).equals(wasm)) writeFileSync(gz, gzipSync(wasm, { level: constants.Z_BEST_COMPRESSION }));
