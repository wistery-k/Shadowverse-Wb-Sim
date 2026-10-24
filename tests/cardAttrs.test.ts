// カードの属性と、補正の最初の層のカードの行を属性で表す学習（scripts/cardAttrs.ts・scripts/td-main.ts の attr・train --attr・prune）

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { attributeMatrix, attributeNames, attributeRow, INTERCEPTS, rawAttributes, ridgePenalty, ridgeSolve } from "../scripts/cardAttrs";
import { main as td } from "../scripts/td-main";
import { defaultVocab, loadValueNet, VALUE_ZONES } from "../scripts/valueNet";

const idOf = (name: string): string => {
  const c = ALL_CARDS.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c.id;
};

describe("カードの属性（scripts/cardAttrs.ts）", () => {
  it("カードのデータと能力の定義から属性を作る", () => {
    const a = rawAttributes(idOf("コンタクトフェアリー"));
    expect(a.get("card")).toBe(1);
    expect(a.get("type:follower")).toBe(1);
    expect(a.get("class:elf")).toBe(1);
    expect(a.get("cost=3")).toBe(1);
    expect(a.get("atk")).toBeCloseTo(0.2);
    expect(a.get("fanfare/summon")).toBe(1);
    expect(a.get("evolve/summon")).toBe(1);
    expect(a.get("evolve/addToHand")).toBe(1);
    // スペル・クレスト
    const s = rawAttributes(idOf("フェザーレイン"));
    expect(s.get("type:spell")).toBe(1);
    expect(s.has("atk")).toBe(false);
    const vocab = defaultVocab();
    const crest = rawAttributes(vocab[vocab.length - 1]!);
    expect(crest.get("crest")).toBe(1);
    expect(crest.has("card")).toBe(false);
  });

  it("属性の名前は 3 項目以上が持つもの（切片は必ず入る）で、決まった順", () => {
    const vocab = defaultVocab();
    const names = attributeNames(vocab);
    expect(names).toEqual(attributeNames(vocab));
    for (const k of INTERCEPTS) expect(names).toContain(k);
    const x = attributeMatrix(vocab, names);
    names.forEach((n, k) => {
      if (INTERCEPTS.includes(n)) return;
      let support = 0;
      for (let c = 0; c < vocab.length; c++) if (x[c * names.length + k] !== 0) support++;
      expect(support).toBeGreaterThanOrEqual(3);
    });
  });

  it("リッジ回帰は、罰が小さければ属性で表せる行をそのまま当てる", () => {
    const vocab = defaultVocab().slice(0, 60);
    const names = ["card", "cost", "atk", "def", "type:spell"];
    const K = names.length, H = 3;
    const x = attributeMatrix(vocab, names);
    const truth = Float64Array.from({ length: K * H }, (_, i) => Math.sin(i + 1));
    const gram = new Float64Array(K * K), xty = new Float64Array(K * H);
    const y = new Float64Array(H);
    for (let c = 0; c < vocab.length; c++) {
      attributeRow(x, K, H, c, truth, y);
      for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) gram[i * K + j]! += x[c * K + i]! * x[c * K + j]!;
        for (let h = 0; h < H; h++) xty[i * H + h]! += x[c * K + i]! * y[h]!;
      }
    }
    const a = ridgeSolve(gram, xty, K, H, ridgePenalty(names, 1e-9));
    a.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 5));
  });
});

describe("最初の層のカードの行を属性で表す学習（td attr・train --attr・prune）", () => {
  it("学習データに出なかったカードの行は属性の分になり、出た行は学んだ分を持つ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-attr-"));
    try {
      const vocab = defaultVocab();
      const V = vocab.length, Z = VALUE_ZONES.length;
      const myHand = (name: string) => VALUE_ZONES.indexOf("myHand") * V + vocab.indexOf(idOf(name));
      const oppBoard = (name: string) => VALUE_ZONES.indexOf("oppBoard") * V + vocab.indexOf(idOf(name));
      const used = [myHand("フェアリーテイマー"), myHand("フェザーレイン"), oppBoard("フェアリー"), oppBoard("ナイト"), Z * V + 0];
      const lines: string[] = [];
      for (let g = 0; g < 40; g++) {
        const samples = [0, 1].map((p) =>
          Array.from({ length: 4 }, (_, t) => {
            const x = used.filter((_, k) => (g + p + t + k) % 3 !== 0);
            return { ph: t % 2, s: ((g * 7 + t) % 11) - 5, x, v: x.map((_, k) => 1 + ((k + t) % 2)) };
          }),
        );
        lines.push(JSON.stringify({ g, decks: ["a", "b"], winner: (g * 5) % 2, turns: 8, samples }));
      }
      const data = join(dir, "d.jsonl");
      writeFileSync(data, lines.join("\n") + "\n");
      const p = (f: string) => join(dir, f);
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
      await quiet(["prune", "--model", p("m0.json"), "--data", data, "--out", p("m0p.json")]);
      await quiet(["train", "--model", p("m0p.json"), "--data", data, "--out", p("m1.json"), "--attr", "1", "--epochs", "2", "--lr", "0.01", "--holdout", "0.2"]);
      const m1 = loadValueNet(p("m1.json"));
      const H = m1.hidden;
      expect(m1.attr).toBeDefined();
      const names = m1.attr!.names, K = names.length;
      expect(m1.attr!.a.length).toBe(Z * K * H);
      const x = attributeMatrix(vocab, names);
      const rowOf = (m: typeof m1, r: number) => m.w1.slice(r * H, (r + 1) * H);
      const attrRowOf = (r: number) => {
        const z = Math.floor(r / V), out = new Float64Array(H);
        attributeRow(x, K, H, r % V, m1.attr!.a.slice(z * K * H, (z + 1) * K * H), out);
        return Array.from(out);
      };
      // 出なかった行（知らないカード）は属性の分だけ。0 ではない
      const unseen = myHand("コンタクトフェアリー");
      rowOf(m1, unseen).forEach((w, j) => expect(w).toBeCloseTo(attrRowOf(unseen)[j]!, 5));
      expect(rowOf(m1, unseen).some((w) => w !== 0)).toBe(true);
      // 出た行は残り R を持つ
      const seen = myHand("フェアリーテイマー");
      expect(rowOf(m1, seen).some((w, j) => Math.abs(w - attrRowOf(seen)[j]!) > 1e-4)).toBe(true);
      // prune は出なかったカードの行を 0 でなく属性の分のままにし、A を外す
      await quiet(["prune", "--model", p("m1.json"), "--data", data, "--out", p("m1p.json")]);
      const m1p = loadValueNet(p("m1p.json"));
      expect(m1p.attr).toBeUndefined();
      rowOf(m1p, unseen).forEach((w, j) => expect(w).toBeCloseTo(rowOf(m1, unseen)[j]!, 5));
      expect(rowOf(m1p, seen)).toEqual(rowOf(m1, seen));
      // td attr: 学んでいない（0 の）行を属性の分で埋め、学んだ行は変えない
      await quiet(["attr", "--model", p("m0p.json"), "--out", p("m2.json")]);
      const m0p = loadValueNet(p("m0p.json")), m2 = loadValueNet(p("m2.json"));
      expect(rowOf(m0p, unseen).every((w) => w === 0)).toBe(true);
      expect(rowOf(m2, unseen).some((w) => w !== 0)).toBe(true);
      expect(rowOf(m2, seen)).toEqual(rowOf(m0p, seen));
      // --lrAttr 0: A は当てはめたまま動かない（td attr と同じ当てはめ）
      await quiet(["train", "--model", p("m0p.json"), "--data", data, "--out", p("m3.json"), "--attr", "1", "--lrAttr", "0", "--epochs", "1", "--lr", "0.01", "--holdout", "0.2"]);
      const m3 = loadValueNet(p("m3.json"));
      m3.attr!.a.forEach((v, i) => expect(v).toBeCloseTo(m2.attr!.a[i]!, 5));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
