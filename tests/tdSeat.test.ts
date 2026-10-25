// td train・prune の --seat（td selfplay --frozen の学ぶ側・固定した相手の席だけを読む。docs/ai-notes.md「狙い撃ちする相手を学ばせて死角を探す」）

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

describe("td train・prune の --seat", () => {
  it("学ぶ側・固定した相手の席の局面だけを読む", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-seat-"));
    try {
      const vocab = defaultVocab();
      const V = vocab.length, Z = VALUE_ZONES.length;
      const myHand = (name: string) => VALUE_ZONES.indexOf("myHand") * V + vocab.indexOf(idOf(name));
      // 学ぶ側の局面には A、固定した相手の局面には B のカードだけが入る
      const A = myHand("フェアリーテイマー"), B = myHand("ナイト"), scalar = Z * V + 0;
      const record = (g: number, learner?: number) => {
        const seat = learner ?? 0;
        const samples = [0, 1].map((p) =>
          Array.from({ length: 4 }, (_, t) => {
            const x = [p === seat ? A : B, scalar];
            return { ph: t % 2, s: ((g * 7 + t) % 11) - 5, x, v: [1, 0.5 + 0.1 * t] };
          }),
        );
        return JSON.stringify({ g, decks: ["a", "b"], winner: (g * 5 + Math.floor(g / 3)) % 2, turns: 8, ...(learner === undefined ? {} : { learner }), samples });
      };
      const p = (f: string) => join(dir, f);
      const data = p("x.jsonl"), plain = p("d.jsonl");
      writeFileSync(data, Array.from({ length: 40 }, (_, g) => record(g, g % 2)).join("\n") + "\n");
      writeFileSync(plain, Array.from({ length: 10 }, (_, g) => record(g)).join("\n") + "\n");
      const quiet = async (argv: string[]) => {
        const log = console.log;
        console.log = () => {};
        try {
          expect(await td(argv)).toBe(0);
        } finally {
          console.log = log;
        }
      };
      await quiet(["init", "--out", p("m0.json"), "--hidden", "4", "--base", "current"]);
      const m0 = loadValueNet(p("m0.json"));
      const H = m0.hidden;
      const rowOf = (m: typeof m0, r: number) => m.w1.slice(r * H, (r + 1) * H);
      const train = (seat: string, out: string) =>
        quiet(["train", "--model", p("m0.json"), "--data", data, "--out", p(out), "--seat", seat, "--epochs", "2", "--lr", "0.01", "--l2", "0", "--holdout", "0.2"]);
      // --seat learner: 固定した相手の席にしか無い B の行は動かない
      await train("learner", "ml.json");
      const ml = loadValueNet(p("ml.json"));
      expect(rowOf(ml, B)).toEqual(rowOf(m0, B));
      expect(rowOf(ml, A)).not.toEqual(rowOf(m0, A));
      // --seat frozen: その逆
      await train("frozen", "mf.json");
      const mf = loadValueNet(p("mf.json"));
      expect(rowOf(mf, A)).toEqual(rowOf(m0, A));
      expect(rowOf(mf, B)).not.toEqual(rowOf(m0, B));
      // 既定（both）は両方の行が動く
      await train("both", "mb.json");
      const mb = loadValueNet(p("mb.json"));
      expect(rowOf(mb, A)).not.toEqual(rowOf(m0, A));
      expect(rowOf(mb, B)).not.toEqual(rowOf(m0, B));
      // prune --seat learner: 学ぶ側の局面に出なかった B の行を 0 にする
      await quiet(["prune", "--model", p("ml.json"), "--data", data, "--out", p("mlp.json"), "--seat", "learner"]);
      const mlp = loadValueNet(p("mlp.json"));
      expect(rowOf(mlp, B).every((w) => w === 0)).toBe(true);
      expect(rowOf(mlp, A)).toEqual(rowOf(ml, A));
      // "learner" の無い自己対戦に --seat learner はエラー
      await expect(td(["train", "--model", p("m0.json"), "--data", plain, "--out", p("e.json"), "--seat", "learner"])).rejects.toThrow(/td selfplay --frozen/);
      await expect(td(["train", "--model", p("m0.json"), "--data", data, "--out", p("e.json"), "--seat", "x"])).rejects.toThrow(/--seat は/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
