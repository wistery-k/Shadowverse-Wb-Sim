// td train: 読んだ局面に一度も出ない入力の行は動かさない（Adam の減衰もかけない。docs/ai-notes.md「td train を速くする」）。
// 探索の値を混ぜた λ 収益（--searchTarget。docs/ai-notes.md「補正の学習の目標に探索の値を使う」）

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { lambdaReturns, loadData, main as td } from "../scripts/td-main";
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

  it("--searchTarget: 次の局面の予測の代わりに探索の値を混ぜる（ターンの最初の局面は同じターンのターン末の値、ランダムに打った局面は予測のまま）", () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-search-"));
    try {
      const f = join(dir, "d.jsonl");
      const x = (ph: number, extra: object = {}) => ({ ph, s: 0, x: [], v: [], ...extra });
      writeFileSync(
        f,
        JSON.stringify({
          g: 1,
          decks: ["a", "b"],
          winner: 0,
          turns: 4,
          samples: [
            [x(1), x(0, { qe: 0.8, qr: 0.6 }), x(2), x(1), x(0, { qe: 0.2, qr: 0.4 })],
            [x(1), x(0, { qe: 0.9, qr: 0.5 }), x(1, { ex: 1 }), x(0, { qe: 0.1, qr: 0.3 })],
          ],
        }) + "\n",
      );
      const d = loadData([f], 0, 1, undefined, undefined, { searchMix: 0.5 });
      // 席 0: after・end・想像・after・end、席 1: after・end・after（ランダム）・end
      expect([...d.q].map((q) => (Number.isNaN(q) ? null : Math.round(q * 1e6) / 1e6))).toEqual([0.7, 0.7, null, 0.3, 0.3, 0.7, 0.7, null, 0.2]);
      const v = new Float64Array(d.q.length).fill(0.5);
      const near = (a: Float64Array, b: number[]) => [...a].forEach((y, i) => expect(y).toBeCloseTo(b[i]!, 9));
      // m = 0 は今までの λ 収益（λ 0.7。次がランダムに打った局面なら、その予測で切る）
      near(lambdaReturns(d, v, 0.7), [0.6715, 0.745, 0.745, 0.85, 1, 0.5, 0.5, 0.15, 0]);
      // m = 1: 0.3 × 探索の値 + 0.7 × 次の目標。ランダムに打った局面には探索の値が無いので、そこで切るのは予測のまま
      near(lambdaReturns(d, v, 0.7, 1), [0.6601, 0.643, 0.643, 0.79, 1, 0.56, 0.5, 0.06, 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
