// vite-run.mjs が VITE_RUN_OUT_DIR に作ったビルド結果を実行する（夜のキューが回のフォルダに写したものを回す。scripts/night-main.ts）。
// 使い方: node scripts/run-bundle.mjs <ディレクトリ>/<名前>.mjs [引数...]
// 並列に回すとき（scripts/parallel.ts）の Worker は、リポジトリの vite-run.mjs を使う（ビルド結果を読み込むだけ）。

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error("使い方: node scripts/run-bundle.mjs <ビルド結果>.mjs [引数...]");
  process.exit(2);
}
const bundle = pathToFileURL(resolve(file)).href;
globalThis.__viteRun = { runner: new URL("./vite-run.mjs", import.meta.url).href, bundle, argv: args };
const { main } = await import(bundle);
process.exitCode = await main(args);
