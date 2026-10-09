// src/ の TypeScript を使うスクリプトを、Vite でビルドした 1 ファイルにしてから実行する（import.meta.glob 等も使える）。
// 使い方: node scripts/vite-run.mjs <スクリプト.ts> [引数...]
// スクリプトは main(argv: string[]): Promise<number> を export し、戻り値が終了コードになる。
//
// 以前は Vite のモジュールランナーで直接実行していたが、モジュールをまたぐ呼び出しが遅く（探索 AI で約 1 割）、
// worker_threads でも使えないため、ビルドしてから実行する。
// 自動対戦を並列に回すとき（scripts/parallel.ts）は、このファイルを Worker として起動し、同じビルド結果を読み込む。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, workerData } from "node:worker_threads";

if (!isMainThread && workerData?.viteRun) {
  // 並列実行の Worker: 親と同じビルド結果の main を同じ引数で呼ぶ（parallelMap が Worker 側の処理に切り替わる）
  globalThis.__viteRun = workerData.viteRun;
  const { main } = await import(workerData.viteRun.bundle);
  await main(workerData.viteRun.argv);
} else {
  const [script, ...args] = process.argv.slice(2);
  if (!script) {
    console.error("使い方: node scripts/vite-run.mjs <スクリプト.ts> [引数...]");
    process.exit(2);
  }
  const { build } = await import("vite");
  // 同時に複数のスクリプトを実行してもぶつからないよう、実行ごとに別のディレクトリにビルドする
  const outDir = mkdtempSync(join(tmpdir(), "vite-run-"));
  try {
    const name = basename(script).replace(/\.[^.]+$/, "");
    await build({
      logLevel: "error",
      build: {
        ssr: script,
        outDir,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: "[name].mjs" } },
      },
    });
    const bundle = pathToFileURL(join(outDir, `${name}.mjs`)).href;
    globalThis.__viteRun = { runner: import.meta.url, bundle, argv: args };
    const { main } = await import(bundle);
    process.exitCode = await main(args);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
