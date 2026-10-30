// td train: 読んだ局面に一度も出ない入力の行は動かさない（Adam の減衰もかけない。docs/ai-notes.md「td train を速くする」）

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { main as td } from "../scripts/td-main";
import { defaultVocab, loadValueNet, VALUE_ZONES } from "../scripts/valueNet";

const idOf = (name: string): string => {
  const c = ALL_CARDS.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c.id;
};

describe("td train", () => {
  it("読んだ局面に出ない入力の行は、重みの減衰があっても動かさない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-train-"));
    try {
      const vocab = defaultVocab();
      const V = vocab.length, Z = VALUE_ZONES.length;
      const myHand = (name: string) => VALUE_ZONES.indexOf("myHand") * V + vocab.indexOf(idOf(name));
      // 局面には A と数値の入力だけが入り、B はどの局面にも出ない
      const A = myHand("フェアリーテイマー"), B = myHand("ナイト"), scalar = Z * V + 0;
      const record = (g: number) =>
        JSON.stringify({
          g,
          decks: ["a", "b"],
          winner: (g * 5 + Math.floor(g / 3)) % 2,
          turns: 8,
          samples: [0, 1].map((p) => Array.from({ length: 4 }, (_, t) => ({ ph: t % 2, s: ((g * 7 + t + p) % 11) - 5, x: [A, scalar], v: [1 + p, 0.5 + 0.1 * t] }))),
        });
      const p = (f: string) => join(dir, f);
      writeFileSync(p("d.jsonl"), Array.from({ length: 40 }, (_, g) => record(g)).join("\n") + "\n");
      const log = console.log;
      console.log = () => {};
      try {
        expect(await td(["init", "--out", p("m0.json"), "--hidden", "4", "--base", "current"])).toBe(0);
        expect(await td(["train", "--model", p("m0.json"), "--data", p("d.jsonl"), "--out", p("m1.json"), "--epochs", "2", "--lr", "0.01", "--l2", "0.01", "--holdout", "0.2"])).toBe(0);
      } finally {
        console.log = log;
      }
      const m0 = loadValueNet(p("m0.json")), m1 = loadValueNet(p("m1.json"));
      const H = m0.hidden;
      const rowOf = (m: typeof m0, r: number) => m.w1.slice(r * H, (r + 1) * H);
      expect(rowOf(m0, B).some((w) => w !== 0)).toBe(true);
      expect(rowOf(m1, B)).toEqual(rowOf(m0, B));
      expect(rowOf(m1, A)).not.toEqual(rowOf(m0, A));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
