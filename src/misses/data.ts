// リポジトリにある見落とし問題集の問（misses/*.json）と、打ち比べ調査の並び（misses/lines/*.json）。
// 問題集のページ（src/ui/Misses.tsx）は、このモジュールを開いたときに読み込む（別のチャンクになり、ほかの画面を重くしない）。
// 公開のサイトで見せるのは、ここにまとめてビルドに入れた決まった局面だけ（局面の貼り付け・読み込みはしない。CLAUDE.md「ソフト打ち」）

import { parseLines, parseProblem, type MissLines, type MissProblem } from "./problems";

const problemFiles = import.meta.glob<unknown>("../../misses/*.json", { eager: true, import: "default" });
const lineFiles = import.meta.glob<unknown>("../../misses/lines/*.json", { eager: true, import: "default" });

export interface MissesData {
  /** 問（名前の順） */
  problems: MissProblem[];
  /** 問の名前 → 打ち比べ調査の並び */
  lines: ReadonlyMap<string, MissLines>;
  /** 読めなかったファイル */
  errors: string[];
}

const fileName = (path: string) => path.replace(/^.*\//, "");

export function loadMisses(): MissesData {
  const errors: string[] = [];
  const problems: MissProblem[] = [];
  for (const [path, raw] of Object.entries(problemFiles).sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      const p = parseProblem(raw);
      if (`${p.id}.json` !== fileName(path)) throw new Error(`名前（${p.id}）とファイルの名前が違います`);
      problems.push(p);
    } catch (e) {
      errors.push(`${fileName(path)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const lines = new Map<string, MissLines>();
  for (const [path, raw] of Object.entries(lineFiles)) {
    try {
      const l = parseLines(raw);
      if (`${l.id}.json` !== fileName(path)) throw new Error(`名前（${l.id}）とファイルの名前が違います`);
      lines.set(l.id, l);
    } catch (e) {
      errors.push(`lines/${fileName(path)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { problems, lines, errors };
}
