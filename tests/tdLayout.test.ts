// 自己対戦の先頭の入力の並び（{"tdLayout": …}）と、td train の --dropInputs・--excludeDecks・--onlyDecks（docs/value-net.md「自己対戦のデータ」）

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "../src/cards";
import { dataRecords, dropInputs, layoutMap, main as td } from "../scripts/td-main";
import { defaultVocab, loadValueNet, VALUE_SCALARS, VALUE_ZONES } from "../scripts/valueNet";

const idOf = (name: string): string => {
  const c = ALL_CARDS.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c.id;
};

const NEW = ["myDeckCards", "oppUnseen"];

describe("自己対戦の入力の並び", () => {
  it("並びの違うモデルへ読み替える（無い入力は捨てる）", () => {
    const vocab = defaultVocab();
    const V = vocab.length;
    const full = { vocab, zones: [...VALUE_ZONES] as string[], scalars: [...VALUE_SCALARS] as string[] };
    const old = { vocab, zones: full.zones.filter((z) => !NEW.includes(z)), scalars: full.scalars };
    expect(layoutMap(full, full)).toBeNull();
    const map = layoutMap(full, old);
    expect(map).not.toBeNull();
    const k = vocab.indexOf(idOf("ナイト"));
    const zf = (z: string) => full.zones.indexOf(z) * V + k;
    const zo = (z: string) => old.zones.indexOf(z) * V + k;
    expect(map![zf("myHand")]).toBe(zo("myHand"));
    expect(map![zf("oppBoardDef")]).toBe(zo("oppBoardDef"));
    expect(map![zf("myDeckCards")]).toBe(-1);
    expect(map![zf("oppUnseen")]).toBe(-1);
    // 数値の入力は、ゾーンの数が違うので添字がずれる
    expect(map![full.zones.length * V + 3]).toBe(old.zones.length * V + 3);
  });

  it("入力ありの自己対戦から、--dropInputs でも足す前の並びのモデルでも同じ補正を学ぶ。gzip も読む", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-layout-"));
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
    try {
      const vocab = defaultVocab();
      const V = vocab.length, Z = VALUE_ZONES.length;
      const at = (zone: string, name: string) => VALUE_ZONES.indexOf(zone as (typeof VALUE_ZONES)[number]) * V + vocab.indexOf(idOf(name));
      const hand = at("myHand", "フェアリーテイマー"), deck = at("myDeckCards", "ナイト"), unseen = at("oppUnseen", "ゴブリン"), scalar = Z * V + 2;
      const decks = ["アマリアロイヤル", "ミッドレンジナイトメア", "疾走ドラゴン"];
      const record = (g: number) =>
        JSON.stringify({
          g,
          decks: [decks[g % 3], decks[(g + 1) % 3]],
          winner: (g * 5 + Math.floor(g / 3)) % 2,
          turns: 8,
          samples: [0, 1].map((q) =>
            Array.from({ length: 4 }, (_, t) => ({ ph: t % 2, s: 0, x: [hand, deck, unseen, scalar], v: [1 + q, 3 - t * 0.5, 2, 0.3 + 0.1 * t] })),
          ),
        });
      const layout = JSON.stringify({ tdLayout: { vocab, zones: [...VALUE_ZONES], scalars: [...VALUE_SCALARS] } });
      const text = [layout, ...Array.from({ length: 42 }, (_, g) => record(g))].join("\n") + "\n";
      writeFileSync(p("d.jsonl.gz"), gzipSync(text));
      await quiet(["init", "--out", p("m0.json"), "--hidden", "4", "--base", "current"]);
      const m0 = loadValueNet(p("m0.json"));
      writeFileSync(p("old.json"), JSON.stringify(dropInputs(m0, NEW)));
      const old = loadValueNet(p("old.json"));
      expect(old.zones).toEqual(VALUE_ZONES.filter((z) => !NEW.includes(z)));
      expect(old.w1.length).toBe((old.zones.length * V + old.scalars.length) * old.hidden);
      // 並びの行は読み飛ばし、"x" はモデルの並びに直す
      const recs = [...dataRecords(p("d.jsonl.gz"), old)];
      expect(recs.length).toBe(42);
      const first = recs[0]!;
      if ("cmp" in first) throw new Error("試合の行のはず");
      expect(first.samples[0]![0]!.x).toEqual([old.zones.indexOf("myHand") * V + vocab.indexOf(idOf("フェアリーテイマー")), old.zones.length * V + 2]);
      const train = (model: string, out: string, extra: string[] = []) =>
        quiet(["train", "--model", p(model), "--data", p("d.jsonl.gz"), "--out", p(out), "--epochs", "2", "--lr", "0.01", "--l2", "0.001", "--holdout", "0.2", ...extra]);
      await train("m0.json", "a.json", ["--dropInputs", NEW.join(",")]);
      await train("old.json", "b.json");
      expect(readFileSync(p("a.json"), "utf8")).toBe(readFileSync(p("b.json"), "utf8"));
      // 入力ありは、山札の中身の行も学ぶ
      await train("m0.json", "c.json");
      const c = loadValueNet(p("c.json"));
      const H = c.hidden;
      const rowOf = (m: typeof c, r: number) => m.w1.slice(r * H, (r + 1) * H);
      expect(rowOf(c, deck)).not.toEqual(rowOf(m0, deck));
      expect(rowOf(c, unseen)).not.toEqual(rowOf(m0, unseen));
      // td prune も読み替える（入力なしのモデルに、入力ありの自己対戦）
      await quiet(["prune", "--model", p("a.json"), "--data", p("d.jsonl.gz"), "--out", p("ap.json")]);
      const ap = loadValueNet(p("ap.json"));
      const aRow = old.zones.indexOf("myHand") * V + vocab.indexOf(idOf("フェアリーテイマー"));
      expect(rowOf(ap, aRow)).toEqual(rowOf(loadValueNet(p("a.json")), aRow));
      expect(rowOf(ap, old.zones.indexOf("myHand") * V + vocab.indexOf(idOf("ナイト"))).every((w) => w === 0)).toBe(true);
      await expect(td(["train", "--model", p("m0.json"), "--data", p("d.jsonl.gz"), "--out", p("e.json"), "--dropInputs", "nope"])).rejects.toThrow(/入力にありません/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--excludeDecks・--onlyDecks で、そのデッキの試合を除く・そのデッキの試合だけを学ぶ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-decks-"));
    const p = (f: string) => join(dir, f);
    try {
      const vocab = defaultVocab();
      const V = vocab.length;
      const at = (name: string) => VALUE_ZONES.indexOf("myHand") * V + vocab.indexOf(idOf(name));
      // ナイトメアの試合にだけ B のカードが出る
      const A = at("フェアリーテイマー"), B = at("ナイト");
      const decks = ["アマリアロイヤル", "ミッドレンジナイトメア", "疾走ドラゴン"];
      const record = (g: number) => {
        const ds = [decks[g % 3]!, decks[Math.floor(g / 3) % 3]!];
        const x = ds.includes("ミッドレンジナイトメア") ? [A, B] : [A];
        return JSON.stringify({
          g,
          decks: ds,
          winner: (g * 5 + Math.floor(g / 3)) % 2,
          turns: 8,
          samples: [0, 1].map(() => Array.from({ length: 4 }, (_, t) => ({ ph: t % 2, s: 0, x, v: x.map(() => 1 + 0.1 * t) }))),
        });
      };
      writeFileSync(p("d.jsonl"), Array.from({ length: 45 }, (_, g) => record(g)).join("\n") + "\n");
      const logs: string[] = [];
      const run = async (argv: string[]) => {
        const log = console.log;
        console.log = (...xs: unknown[]) => void logs.push(xs.join(" "));
        try {
          expect(await td(argv)).toBe(0);
        } finally {
          console.log = log;
        }
      };
      await run(["init", "--out", p("m0.json"), "--hidden", "4", "--base", "current"]);
      const m0 = loadValueNet(p("m0.json"));
      const H = m0.hidden;
      const rowOf = (m: typeof m0, r: number) => m.w1.slice(r * H, (r + 1) * H);
      const train = (out: string, extra: string[]) =>
        run(["train", "--model", p("m0.json"), "--data", p("d.jsonl"), "--out", p(out), "--epochs", "3", "--lr", "0.01", "--l2", "0", "--holdout", "0.2", "--batch", "16", ...extra]);
      await train("x.json", ["--excludeDecks", "ミッドレンジナイトメア"]);
      const x = loadValueNet(p("x.json"));
      expect(rowOf(x, B)).toEqual(rowOf(m0, B));
      expect(rowOf(x, A)).not.toEqual(rowOf(m0, A));
      // 45 試合のうちナイトメアの絡まない試合は 2 × 2 の組の 4/9（20 試合）、1 試合 8 局面
      expect(logs.some((l) => /局面 160（/.test(l))).toBe(true);
      await train("o.json", ["--onlyDecks", "ミッドレンジナイトメア"]);
      expect(logs.some((l) => /局面 200（/.test(l))).toBe(true);
      expect(rowOf(loadValueNet(p("o.json")), B)).not.toEqual(rowOf(m0, B));
      // prune も同じ試合を除く
      await run(["prune", "--model", p("x.json"), "--data", p("d.jsonl"), "--out", p("xp.json"), "--excludeDecks", "ミッドレンジナイトメア"]);
      expect(rowOf(loadValueNet(p("xp.json")), B).every((w) => w === 0)).toBe(true);
      await expect(td(["train", "--model", p("m0.json"), "--data", p("d.jsonl"), "--out", p("e.json"), "--onlyDecks", "ナイトメア"])).rejects.toThrow(/デフォルトデッキの名前/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
