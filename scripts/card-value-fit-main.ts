// card-value-data の集計（npm run card-value-fit）。
// デッキ・種類（手札／場）・カードごとに、「そのまま − 抜いた局面」の勝率の差と、評価関数の点数の差を並べる。
// 評価関数の点数を勝率に直す換算率は、全ての変更（手札・場・体力）について「勝率の差 ~ 点数の差」を原点を通る直線で当てはめて決める。
// 測った勝率の差と、点数から換算した勝率の差のずれが大きい順に出す（評価関数が見誤っている候補）。

import { readFileSync } from "node:fs";
import { cardOf } from "../src/engine";
import type { CardValueRecord } from "./card-value-data-main";

interface Cell {
  deck: string;
  kind: string;
  cardId: string;
  diffs: number[];
  evalDeltas: number[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
function se(xs: number[]): number {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const RESOURCE_LABEL: Record<string, string> = { hp: "体力 −3", maxpp: "PP 最大値 −1", ep: "EP −1", sep: "SEP −1" };
const nameOf = (kind: string, id: string) => (id ? cardOf(id).name : (RESOURCE_LABEL[kind] ?? kind));

/** npm run card-value-fit -- <data.jsonl>... [--min <n>] */
export async function main(argv: string[]): Promise<number> {
  let min = 30;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min") min = Number(argv[++i]);
    else files.push(argv[i]!);
  }
  const recs: CardValueRecord[] = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l, i) => {
      // 共有フォルダへの追記が壊れた行（同期の途中の断片）は飛ばす
      try {
        return [JSON.parse(l) as CardValueRecord];
      } catch {
        console.error(`読めない行を飛ばします: ${f}:${i + 1}`);
        return [];
      }
    }),
  );
  const cells = new Map<string, Cell>();
  const all: { d: number; e: number }[] = [];
  let pairs = 0, discordant = 0;
  for (const r of recs) {
    if (r.baseWin === null) continue;
    const base = r.baseWin ? 1 : 0;
    for (const v of r.variants) {
      if (v.win === null) continue;
      const d = base - (v.win ? 1 : 0);
      pairs++;
      if (d !== 0) discordant++;
      all.push({ d, e: v.evalDelta });
      const deck = r.decks[r.p];
      const key = `${deck}|${v.kind}|${v.cardId}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { deck, kind: v.kind, cardId: v.cardId, diffs: [], evalDeltas: [] }));
      c.diffs.push(d);
      c.evalDeltas.push(v.evalDelta);
    }
  }
  // 換算率（勝率 / 点）: 原点を通る最小二乗
  const rate = all.reduce((a, x) => a + x.d * x.e, 0) / Math.max(all.reduce((a, x) => a + x.e * x.e, 0), 1e-9);

  console.log(`局面 ${recs.length}、対 ${pairs}、勝敗が入れ替わった対 ${(discordant / Math.max(pairs, 1) * 100).toFixed(1)}%`);
  console.log(`換算率: 評価関数の 1 点 ＝ 勝率 ${pct(rate)}（全ての変更を原点を通る直線で当てはめ）`);
  const handAll = [...cells.values()].filter((c) => c.kind === "hand").flatMap((c) => c.diffs);
  console.log(`手札 1 枚（全カード平均）: ${pct(mean(handAll))} ± ${pct(se(handAll))}（${handAll.length} 対）`);
  for (const kind of Object.keys(RESOURCE_LABEL)) {
    const cs = [...cells.values()].filter((c) => c.kind === kind);
    const ds = cs.flatMap((c) => c.diffs);
    if (ds.length === 0) continue;
    const es = cs.flatMap((c) => c.evalDeltas);
    console.log(`${RESOURCE_LABEL[kind]}（全デッキ）: ${pct(mean(ds))} ± ${pct(se(ds))}（${ds.length} 対、点数の差 ${mean(es).toFixed(1)} → 換算 ${pct(mean(es) * rate)}）`);
  }
  console.log();
  console.log(`| デッキ | 種類 | カード | 対 | 勝率の差 | SE | 点数の差 | 点数からの換算 | ずれ / SE |`);
  console.log(`| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  const rows = [...cells.values()]
    .filter((c) => c.diffs.length >= min)
    .map((c) => {
      const m = mean(c.diffs), s = se(c.diffs), e = mean(c.evalDeltas);
      return { c, m, s, e, z: (m - e * rate) / s };
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  for (const { c, m, s, e, z } of rows) {
    const kind = c.kind === "hand" ? "手札" : c.kind === "board" ? "場" : "資源";
    console.log(`| ${c.deck} | ${kind} | ${nameOf(c.kind, c.cardId)} | ${c.diffs.length} | ${pct(m)} | ${pct(s)} | ${e.toFixed(1)} | ${pct(e * rate)} | ${z.toFixed(2)} |`);
  }
  return 0;
}
