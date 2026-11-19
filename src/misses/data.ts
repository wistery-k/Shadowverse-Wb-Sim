// リポジトリにある見落とし問題集の問（misses/*.json）と、打ち比べ調査の並び（misses/lines/*.json）。スターターのページの問題集。
// 問題集のページ（src/ui/Misses.tsx）は、このモジュールを開いたときに読み込む（別のチャンクになり、ほかの画面を重くしない）。
// 公開のサイトで見せるのは、ここにまとめてビルドに入れた決まった局面だけ（局面の貼り付け・読み込みはしない。CLAUDE.md「ソフト打ち」）。
// アズヴォルト環境のページの問（misses/azvaldt/）は src/misses/azvaldtData.ts

import { readMissFiles, type MissesData } from "./load";

const problemFiles = import.meta.glob<unknown>("../../misses/*.json", { eager: true, import: "default" });
const lineFiles = import.meta.glob<unknown>("../../misses/lines/*.json", { eager: true, import: "default" });

export type { MissesData } from "./load";

export function loadMisses(): MissesData {
  return readMissFiles(problemFiles, lineFiles);
}
