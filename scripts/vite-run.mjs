// src/ の TypeScript を使うスクリプトを、Vite のモジュールランナーで実行する（import.meta.glob 等も使える）。
// 使い方: node scripts/vite-run.mjs <スクリプト.ts> [引数...]
// スクリプトは main(argv: string[]): Promise<number> を export し、戻り値が終了コードになる。

import { createServer, createServerModuleRunner } from "vite";

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("使い方: node scripts/vite-run.mjs <スクリプト.ts> [引数...]");
  process.exit(2);
}
const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  const { main } = await runner.import(`/${script.replace(/^\.?\//, "")}`);
  process.exitCode = await main(args);
} finally {
  await runner.close();
  await server.close();
}
