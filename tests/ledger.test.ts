// 実験の台帳（docs/ledger.jsonl・scripts/ledger-main.ts）。台帳の 1 行の形は Rust のランナー（rust/engine/src/runner/ledger.rs）が書く

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LEDGER,
  canonical,
  filterRuns,
  groupRuns,
  latestDecisions,
  main,
  parseLedger,
  resultFromLabel,
  sumRuns,
  type RunRow,
} from "../scripts/ledger-main";

/** Rust の compare が書く形の 1 行（runner/ledger.rs のテストと同じ項目） */
function run(over: Partial<RunRow> = {}): RunRow {
  return {
    v: 1,
    kind: "compare",
    date: "2026-11-10",
    at: "2026-11-10T09:00:00Z",
    commit: "bcb49c2",
    branch: "main",
    label: "幅 256",
    a: { beamWidth: 256 },
    b: {},
    vs: null,
    decks: ["リノセウスエルフ", "アマリアロイヤル"],
    mirror: true,
    g: [0, 1599],
    n: 3200,
    wins: 1618,
    rate: 0.505625,
    se: 0.0016,
    seKind: "pairs",
    pairs: [120, 1352, 128],
    perDeck: { リノセウスエルフ: [300, 458] },
    seconds: 320,
    perGame: 0.1,
    threads: 28,
    machine: "svwb-docker",
    cmd: "compare 1600 '{\"beamWidth\":256}' '{}' 0",
    ...over,
  };
}

const line = (x: unknown) => JSON.stringify(x);

describe("台帳の読み込み", () => {
  it("回の行と採否の行を読み、形の合わない行は行番号つきで知らせる", () => {
    const decision = {
      v: 1,
      kind: "decision",
      date: null,
      item: "x",
      decision: "採用",
      inDefault: true,
      keys: ["dedup"],
      vs: "",
      result: null,
      labels: [],
      note: "",
      ref: "",
      source: "notes",
    };
    const text = [line(run()), "", line(decision), "{", line({ ...run(), n: "3200" }), line({ v: 1, kind: "other" }), line({ ...decision, decision: "たぶん" })].join("\n");
    const p = parseLedger(text);
    expect(p.runs).toHaveLength(1);
    expect(p.decisions).toHaveLength(1);
    expect(p.errors).toEqual([
      "4 行目: JSON が読めません",
      "5 行目: n が合いません",
      "6 行目: 知らない kind: other",
      "7 行目: decision が合いません",
    ]);
  });

  it("リポジトリの docs/ledger.jsonl は全部の行が形に合う", () => {
    const p = parseLedger(readFileSync(DEFAULT_LEDGER, "utf8"));
    expect(p.errors).toEqual([]);
    // 記録から写した、今の既定に入っている項目
    expect(p.decisions.filter((d) => d.inDefault && d.source === "notes").length).toBeGreaterThan(20);
  });
});

describe("回の足し合わせ", () => {
  it("同じ比べ（設定の項目の順番は問わない）の回を足し、誤差は試合数の重みで合わせる", () => {
    const a = run({ g: [0, 1599], n: 3200, wins: 1600, se: 0.004, a: { beamWidth: 256, rescoreTop: 4 } });
    const b = run({ g: [1600, 3199], n: 3200, wins: 1640, se: 0.003, a: { rescoreTop: 4, beamWidth: 256 } });
    const other = run({ b: { beamWidth: 128 } });
    const groups = groupRuns([a, b, other], false);
    expect(groups).toHaveLength(2);
    const s = groups[0];
    expect(s?.n).toBe(6400);
    expect(s?.wins).toBe(3240);
    expect(s?.se).toBeCloseTo(Math.sqrt((0.004 * 3200) ** 2 + (0.003 * 3200) ** 2) / 6400, 12);
    expect(s?.overlap).toBe(false);
    // コミットが違えば、--any-commit のときだけ足す
    expect(groupRuns([a, { ...b, commit: "1234567" }], false)).toHaveLength(2);
    expect(groupRuns([a, { ...b, commit: "1234567" }], true)).toHaveLength(1);
  });

  it("試合番号の重なりと、誤差の分からない回を知らせる", () => {
    expect(sumRuns([run({ g: [0, 99] }), run({ g: [50, 149] })]).overlap).toBe(true);
    expect(sumRuns([run(), run({ g: [1600, 3199], se: null })]).se).toBeNull();
  });

  it("絞り込み", () => {
    const rows = [run({ date: "2026-11-01", label: "旧" }), run({ kind: "yardstick", b: "strong" }), run({ label: "新しい案" })];
    expect(filterRuns(rows, { kind: "yardstick" })).toHaveLength(1);
    expect(filterRuns(rows, { since: "2026-11-05" })).toHaveLength(2);
    expect(filterRuns(rows, { label: "新しい" })).toHaveLength(1);
    expect(filterRuns(rows, { grep: "STRONG" })).toHaveLength(1);
    expect(filterRuns(rows, { last: 1 })[0]?.label).toBe("新しい案");
  });

  it("名前から採否の結果を作る（違う比べが混ざる・試合番号が重なるならエラー）", () => {
    const a = run({ label: "L", g: [0, 1599], wins: 1600 });
    const b = run({ label: "L", g: [1600, 3199], wins: 1700 });
    expect(resultFromLabel([a, b], "L").result).toEqual({ n: 6400, rate: 3300 / 6400, se: expect.any(Number) });
    expect(() => resultFromLabel([a, run({ label: "L", b: { beamWidth: 128 } })], "L")).toThrow("混ざって");
    expect(() => resultFromLabel([a, run({ label: "L" })], "L")).toThrow("重なって");
    expect(() => resultFromLabel([a], "M")).toThrow("ありません");
  });

  it("canonical は項目の順番によらない", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe("npm run ledger", () => {
  let dir = "";
  let file = "";
  let out: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-"));
    file = join(dir, "l.jsonl");
    writeFileSync(file, `${line(run({ label: "L", g: [0, 1599] }))}\n${line(run({ label: "L", g: [1600, 3199], wins: 1700 }))}\n`);
    out = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => {
      out.push(s);
    });
    vi.spyOn(console, "error").mockImplementation((s: string) => {
      out.push(s);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs・sum は Markdown の表を出す", async () => {
    expect(await main(["--file", file])).toBe(0);
    expect(out[0]?.split("\n")).toHaveLength(4);
    expect(out[0]).toContain("| 2026-11-10 | bcb49c2 | compare | L | `{\"beamWidth\":256}` | `{}` | 3200（g0〜1599） | 50.56% | 0.16 | 128・1352・120 |");
    out = [];
    expect(await main(["sum", "--file", file])).toBe(0);
    expect(out[0]).toContain("| L | `{\"beamWidth\":256}` | `{}` | 2 | 6400 | 51.84% |");
  });

  it("decide は回を足し合わせた結果つきの採否の行を足し、items が今の判定を出す", async () => {
    expect(await main(["decide", "--file", file, "--item", "幅 256", "--decision", "採用", "--from-label", "L", "--keys", "beamWidth", "--date", "2026-11-10"])).toBe(0);
    expect(await main(["decide", "--file", file, "--item", "幅 256", "--decision", "やめた", "--date", "2026-11-11", "--note", "外した"])).toBe(0);
    const p = parseLedger(readFileSync(file, "utf8"));
    expect(p.errors).toEqual([]);
    expect(p.decisions[0]).toMatchObject({ decision: "採用", inDefault: true, labels: ["L"], source: "runs", keys: ["beamWidth"], result: { n: 6400 } });
    expect(p.decisions[1]).toMatchObject({ decision: "やめた", inDefault: false, result: null, source: "manual" });
    expect(latestDecisions(p.decisions, false).map((d) => d.decision)).toEqual(["やめた"]);
    out = [];
    expect(await main(["items", "--file", file, "--all"])).toBe(0);
    expect(out[0]?.split("\n")).toHaveLength(4);
  });

  it("check は形の合わない行があれば 1 を返す。知らない引数は 2", async () => {
    expect(await main(["check", "--file", file])).toBe(0);
    writeFileSync(file, "{\n", { flag: "a" });
    expect(await main(["check", "--file", file])).toBe(1);
    expect(await main(["runs", "--file", file, "--nope", "1"])).toBe(2);
    expect(await main(["decide", "--file", file, "--item", "x", "--decision", "多分"])).toBe(2);
  });
});
