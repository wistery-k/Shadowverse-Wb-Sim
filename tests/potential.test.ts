// ターン途中の見込みの学習（scripts/potential-main.ts、npm run potential）。推論は Rust（rust/engine/src/ai/tests/potential.rs）

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatePotential, loadPotentialData, main, makeGroups, trainPotential } from "../scripts/potential-main";

const HEAD = { vocab: ["a", "b"], zones: ["hand"], scalars: ["pp"] };

/** 組ごとに 4 局面。届いた最善は 終えた点数 + 10 × 残り PP（残り PP は数値の入力の 2 番、カード a は 0 番） */
function lines(games: number): string[] {
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = [JSON.stringify(HEAD)];
  for (let game = 0; game < games; game++) {
    for (let depth = 1; depth <= 3; depth++) {
      for (let i = 0; i < 4; i++) {
        const v = rand() * 10, pp = rand(), y = v + 10 * pp;
        out.push(JSON.stringify({ game, k: 0, depth, deck: "x", v, y, on: false, rank: i, layer: 4, x: [[0, 1], [2, pp]] }));
      }
    }
  }
  return out;
}

describe("見込みの学習（scripts/potential-main.ts）", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "svwb-potential-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("データを読み、試合ごとに学び・確かめに分ける", () => {
    const f = join(dir, "d.jsonl");
    writeFileSync(f, lines(10).join("\n") + "\n");
    const d = loadPotentialData([f]);
    expect(d.nIn).toBe(3);
    expect(d.v.length).toBe(120);
    expect(Array.from(d.idx.subarray(d.rowPtr[0]!, d.rowPtr[1]!))).toEqual([0, 2]);
    const { train, valid } = makeGroups(d, (g) => g >= 8);
    expect(train.length).toBe(24);
    expect(valid.length).toBe(6);
    expect(train.every((G) => G.length === 4)).toBe(true);
  });

  it("語彙の違うファイルは混ぜない", () => {
    const f1 = join(dir, "d1.jsonl"), f2 = join(dir, "d2.jsonl");
    writeFileSync(f1, lines(2).join("\n"));
    writeFileSync(f2, [JSON.stringify({ ...HEAD, vocab: ["a"] }), ...lines(2).slice(1)].join("\n"));
    expect(() => loadPotentialData([f1, f2])).toThrow(/語彙/);
  });

  it("残り PP の見込みを学び、確かめの組で 1 位を当てるようになる", () => {
    const f = join(dir, "d.jsonl");
    writeFileSync(f, lines(200).join("\n"));
    const d = loadPotentialData([f]);
    const { train, valid } = makeGroups(d, (g) => g >= 160);
    const opts = { hidden: 8, epochs: 30, T: 2, lr: 0.01, l2: 0, batch: 32, scale: 20, seed: 1 };
    const model = trainPotential(d, train, valid, opts, () => {});
    expect(model.w1.length).toBe(3 * 8);
    // 学んだ重みで確かめる（書き出した w2 は scale 倍してあるので戻す）
    const p = { H: 8, w1: Float64Array.from(model.w1), b1: Float64Array.from(model.b1), w2: Float64Array.from(model.w2, (x) => x / opts.scale) };
    const r = evaluatePotential(d, valid, p, opts);
    expect(r.top1Base).toBeLessThan(0.6);
    expect(r.top1).toBeGreaterThan(0.9);
  });

  it("npm run potential -- train がモデルを書き出す", async () => {
    const f = join(dir, "d.jsonl"), out = join(dir, "m.json");
    writeFileSync(f, lines(20).join("\n"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["train", "--data", f, "--out", out, "--hidden", "4", "--epochs", "1", "--valid", "15-19"])).toBe(0);
    const m: unknown = JSON.parse(readFileSync(out, "utf8"));
    expect(m).toMatchObject({ kind: "potential-net", version: 1, vocab: HEAD.vocab, zones: HEAD.zones, scalars: HEAD.scalars, hidden: 4, b2: 0 });
  });
});
