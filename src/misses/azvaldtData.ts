// アズヴォルト環境（前期のローテーション）の見落とし問題集の問（misses/azvaldt/*.json。docs/misses.md「新しいプールの問」）。
// アズヴォルト環境のページの問題集（src/azvaldt/App.tsx）が、開いたときに読み込む。見せるのはここでビルドに入れた決まった局面だけ
// （シミュレータの中の R3 どうしの自己対戦から取ったもの。プロの試合の局面は入れない。CLAUDE.md「決定済みの前提」）

import { readMissFiles, type MissesData } from "./load";

const problemFiles = import.meta.glob<unknown>("../../misses/azvaldt/*.json", { eager: true, import: "default" });

export function loadMisses(): MissesData {
  return readMissFiles(problemFiles, {});
}
