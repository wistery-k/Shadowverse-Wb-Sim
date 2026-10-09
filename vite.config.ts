import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

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

export default defineConfig({
  // GitHub Pages はリポジトリ名のサブパスで配信される
  base: "/Shadowverse-Wb-Sim/",
  plugins: [preact()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(git.commit),
    __BUILD_DATE__: JSON.stringify(git.date),
    __BUILD_DIRTY__: JSON.stringify(git.dirty),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // 自己対戦のテストは時間がかかる（CI や負荷の高い環境でも落ちないようにする）
    testTimeout: 30_000,
  },
});
