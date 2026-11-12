// 見落とし問題集の問のうち、候補の打ち比べ調査（docs/survey.md）から足した問に、調査で打ち比べた 2 つの並び
// （AI の選んだ候補と、二段目で比べた候補）を書き添える（misses/lines/<問>.json）。問題集のページ（src/ui/Misses.tsx）が
// 盤面で 1 手ずつ進めて見せるのに使う。問のファイルには書かない（問題集の指紋を変えないため）。
//
// 使い方: node scripts/misses-lines.ts <調査の出力.jsonl(.gz)>… [--force]
//   問のファイルの origin（"from":"state"、"file":"g<試合>-i<手>.json"）と同じ試合・手の行を探す。
//   既にある misses/lines/<問>.json は書き直さない（--force で書き直す）

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Action } from "../src/engine/types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MISSES = join(ROOT, "misses");
const OUT = join(MISSES, "lines");

/** 調査の行の候補（必要な項目だけ） */
interface Plan {
  steps: Action[];
  text: string[];
  full: string[];
}
interface Row {
  g?: number;
  i?: number;
  ai?: number;
  plans?: Plan[];
  confirm?: { c: number } | null;
  state?: unknown;
}

/** 並び 1 つ（misses/lines の形。src/misses/types.ts の MissLine と同じ） */
export interface LineOut {
  kind: "ai" | "good";
  label: string;
  /** 局面から打つ手（AI がこの並びを選んだときに、考え直すまで打つ手） */
  steps: Action[];
  /** steps の説明（調査が書いたもの） */
  text: string[];
  /** 調査で読んだターンの終わりまでの並びの説明（AI から見た決定化の局面のもの。途中で引くカードは予想） */
  full: string[];
}

/** キーの順番によらない文字列（局面が同じかを見る） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 読みやすい形で書く（並びの手は 1 手 1 行） */
function format(body: { v: number; id: string; source: string; lines: LineOut[] }): string {
  const list = (xs: readonly unknown[]) => (xs.length === 0 ? "[]" : `[\n${xs.map((x) => `        ${JSON.stringify(x)}`).join(",\n")}\n      ]`);
  const lines = body.lines.map(
    (l) =>
      `    {\n      "kind": ${JSON.stringify(l.kind)},\n      "label": ${JSON.stringify(l.label)},\n      "steps": ${list(l.steps)},\n      "text": ${list(l.text)},\n      "full": ${list(l.full)}\n    }`,
  );
  return `{\n  "v": ${body.v},\n  "id": ${JSON.stringify(body.id)},\n  "source": ${JSON.stringify(body.source)},\n  "lines": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

function main(argv: string[]): void {
  const force = argv.includes("--force");
  const files = argv.filter((a) => a !== "--force");
  if (files.length === 0) throw new Error("使い方: node scripts/misses-lines.ts <調査の出力.jsonl(.gz)>… [--force]");

  // 調査の局面から足した問: 試合・手 → 問
  const wanted = new Map<string, { id: string; state: unknown }>();
  for (const f of readdirSync(MISSES).filter((x) => x.endsWith(".json")).sort()) {
    const p = JSON.parse(readFileSync(join(MISSES, f), "utf8")) as { id: string; origin?: { from?: string; file?: string }; state: unknown };
    const m = p.origin?.from === "state" ? /^g(\d+)-i(\d+)\.json$/.exec(p.origin.file ?? "") : null;
    if (m) wanted.set(`${m[1]}/${m[2]}`, { id: p.id, state: p.state });
  }

  mkdirSync(OUT, { recursive: true });
  let written = 0;
  let skipped = 0;
  const found = new Set<string>();
  for (const file of files) {
    const buf = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    // 共有フォルダの中の場所で書く（どのマシンのパスかによらない）
    const shown = file.replace(/^.*?(?=logs\/)/, "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Row;
      const key = `${row.g}/${row.i}`;
      const want = wanted.get(key);
      if (!want || !row.plans || row.ai === undefined) continue;
      if (canonical(row.state) !== canonical(want.state)) throw new Error(`${want.id}: 調査の行（${shown} の試合 ${row.g} の ${row.i} 手目）の局面が問の局面と違います`);
      if (!row.confirm) throw new Error(`${want.id}: 調査の行に二段目（confirm）がありません`);
      found.add(key);
      const out = join(OUT, `${want.id}.json`);
      if (existsSync(out) && !force) {
        skipped++;
        continue;
      }
      const pick = (k: number, kind: LineOut["kind"], label: string): LineOut => {
        const plan = row.plans![k];
        if (!plan) throw new Error(`${want.id}: 候補 ${k} がありません`);
        return { kind, label, steps: plan.steps, text: plan.text, full: plan.full };
      };
      const body = {
        v: 1,
        id: want.id,
        source: `${shown} の試合 ${row.g} の ${row.i} 手目`,
        lines: [pick(row.ai, "ai", "調査の AI の手"), pick(row.confirm.c, "good", "打ち比べで良い手")],
      };
      writeFileSync(out, format(body));
      written++;
    }
  }
  const missing = [...wanted].filter(([k]) => !found.has(k)).map(([, v]) => v.id);
  console.log(`書いた ${written}、既にあるので飛ばした ${skipped}（--force で書き直す）`);
  if (missing.length > 0) console.log(`調査の行が見つからない問 ${missing.length}: ${missing.join(", ")}`);
}

main(process.argv.slice(2));
