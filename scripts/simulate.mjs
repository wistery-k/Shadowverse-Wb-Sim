// AI 同士の総当たり対戦（Node）。Vite のモジュールランナーで src/ の TypeScript をそのまま実行する。
// 使い方: npm run sim -- [--games 20] [--seed 1] [--agents greedy] [--decks all|名前,名前] [--mirror] [--json 出力先]

import { createServer, createServerModuleRunner } from "vite";

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "error",
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  const { main } = await runner.import("/scripts/simulate-main.ts");
  process.exitCode = await main(process.argv.slice(2));
} finally {
  await runner.close();
  await server.close();
}
