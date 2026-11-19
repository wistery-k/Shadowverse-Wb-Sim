// 見落とし問題集の問と打ち比べ調査の並びのファイル（import.meta.glob で読んだもの）を読む。
// 問のフォルダごとのモジュール（スターター: src/misses/data.ts、アズヴォルト環境: src/misses/azvaldtData.ts）が使う

import { parseLines, parseProblem, type MissLines, type MissProblem } from "./problems";

export interface MissesData {
  /** 問（名前の順） */
  problems: MissProblem[];
  /** 問の名前 → 打ち比べ調査の並び */
  lines: ReadonlyMap<string, MissLines>;
  /** 読めなかったファイル */
  errors: string[];
}

const fileName = (path: string) => path.replace(/^.*\//, "");

/** 問のファイル（道 → JSON）と並びのファイルを読む */
export function readMissFiles(problemFiles: Record<string, unknown>, lineFiles: Record<string, unknown>): MissesData {
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
