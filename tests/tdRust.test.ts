// td train・td prune の TypeScript 版が、Rust 版（svwb td train・prune）と同じ照らし合わせの出力を書く（rust/engine/tests/td-train/README.md）。
// Rust 版は rust/engine/src/runner/td_train.rs の fixtures_match_typescript が同じファイルと比べる。docs/ai-notes.md「補正の学習を Rust に移す」

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main as td } from "../scripts/td-main";

const DIR = join(__dirname, "../rust/engine/tests/td-train");
const FILES = new Set(["model.json", "data.jsonl", "train-a.json"]);

interface Case {
  name: string;
  cmd: "train" | "prune";
  args: string[];
}

const cases = JSON.parse(readFileSync(join(DIR, "cases.json"), "utf8")) as Case[];

describe("td train・prune の照らし合わせ", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s は Rust 版と同じファイルを書く", async (_, c) => {
    const tmp = mkdtempSync(join(tmpdir(), "svwb-td-rust-"));
    const log = console.log;
    console.log = () => {};
    try {
      const out = join(tmp, `${c.name}.json`);
      const args = c.args.map((a) => (FILES.has(a) ? join(DIR, a) : a));
      expect(await td([c.cmd, ...args, "--out", out])).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(readFileSync(join(DIR, `${c.name}.json`), "utf8"));
    } finally {
      console.log = log;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
