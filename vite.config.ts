import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { devOnlyModules, replayFiles } from "./scripts/replay-files.ts";

/** ビルド時点の最終コミット（画面に表示する）。git が使えなければ空 */
function gitInfo(): { commit: string; date: string; dirty: boolean } {
  try {
    const [commit = "", date = ""] = execSync("git log -1 --format=%H%n%cI", { encoding: "utf8" }).trim().split("\n");
    // 未コミットの変更があると、コミットだけでは試合を再現できない（リプレイ画面で知らせる）
    const dirty = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
    return { commit, date, dirty };
  } catch {
    return { commit: "", date: "", dirty: false };
  }
}

const git = gitInfo();

/** エンジンの WASM の大きさ（読み込み中の表示で、受け取った割合を出す）。npm run wasm で作った後に読む（無ければ 0） */
function wasmSize(): number {
  try {
    return statSync(fileURLToPath(new URL("./src/engine/svwb.wasm", import.meta.url))).size;
  } catch {
    return 0;
  }
}

export default defineConfig(({ command, isSsrBuild }) => ({
  // GitHub Pages はリポジトリ名のサブパスで配信される
  base: "/Shadowverse-Wb-Sim/",
  // replayFiles: 開発サーバーだけで、リプレイ検索が読む手元の試合の記録を配る（vite build では働かない）。
  // devOnlyModules: vite build で、リプレイ検索と試合の記録の画面を何も表示しないものに置き換える（公開サイトに入れない）
  plugins: [preact(), replayFiles(), devOnlyModules()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(git.commit),
    __BUILD_DATE__: JSON.stringify(git.date),
    __BUILD_DIRTY__: JSON.stringify(git.dirty),
    __SVWB_WASM_SIZE__: JSON.stringify(wasmSize()),
    // Node（テスト・スクリプト）で読み込むエンジンの WASM（src/engine/wasm.ts）。ブラウザ向けのビルドでは使わない（このマシンのパスを埋め込まない）
    __SVWB_WASM_PATH__: JSON.stringify(command === "build" && !isSsrBuild ? "" : fileURLToPath(new URL("./src/engine/svwb.wasm", import.meta.url))),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // 自己対戦のテストは時間がかかる（CI や負荷の高い環境でも落ちないようにする）
    testTimeout: 30_000,
  },
}));
