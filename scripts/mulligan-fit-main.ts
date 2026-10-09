// マリガンの重みの推定（npm run mulligan-fit -- <データ.jsonl ...> [--out data/mulligan-weights.json] [--seat] [--sig] [--merge]）。
// データは npm run mulligan-data で取る（初手の各カードをコインで残す・返すを決めた試合）。
// デッキごとに、勝敗 ~ 先後 + 相手デッキ + 初手にあったカード + 残したカード の線形確率モデルを当てはめ、
// 「残した」の係数（＝初手にあるとき、残すと返すより勝率がどれだけ上がるか）を重みにする。
// 残すかどうかはコインで決めたので、この係数は因果的な効果の推定になる。マリガン後に引いたカードは入れない（処置の後の変数）。
// 係数は経験ベイズで 0 に向けて縮める（偶然大きく出た係数をそのまま使わないため）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { cardOf } from "../src/engine";
import { parseMulliganWeights, type MulliganWeights } from "../src/ai/mulligan";
import type { MulliganRecord } from "./mulligan-data-main";

interface Row {
  y: number;
  x: number[];
}

/** A x = b を解いた結果と A の逆行列（ガウス・ジョルダン法） */
function invert(a: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new Error("特異行列");
    for (let j = 0; j < 2 * n; j++) m[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row) => row.slice(n));
}

/** リッジ回帰。penalty[j] が列 j の正則化の強さ。係数と標準誤差を返す */
function ridge(rows: Row[], penalty: number[]): { b: number[]; se: number[]; sigma2: number } {
  const d = penalty.length;
  const xtx = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const xty = new Array<number>(d).fill(0);
  for (const { x, y } of rows) {
    for (let i = 0; i < d; i++) {
      const xi = x[i]!;
      if (xi === 0) continue;
      xty[i]! += xi * y;
      for (let j = 0; j < d; j++) xtx[i]![j]! += xi * x[j]!;
    }
  }
  for (let i = 0; i < d; i++) xtx[i]![i]! += penalty[i]! + 1e-9;
  const inv = invert(xtx);
  const b = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j]!, 0));
  let sse = 0;
  for (const { x, y } of rows) {
    const p = x.reduce((s, v, j) => s + v * b[j]!, 0);
    sse += (y - p) ** 2;
  }
  const sigma2 = sse / Math.max(1, rows.length - d);
  return { b, se: inv.map((row, i) => Math.sqrt(sigma2 * row[i]!)), sigma2 };
}

export async function main(argv: string[]): Promise<number> {
  const files: string[] = [];
  let out: string | null = null;
  let seat = false;
  let sig = false;
  let merge = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? null;
    else if (argv[i] === "--seat") seat = true;
    else if (argv[i] === "--sig") sig = true;
    else if (argv[i] === "--merge") merge = true;
    else files.push(argv[i]!);
  }
  const records: MulliganRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as MulliganRecord);
      } catch {
        console.log(`読めない行を飛ばしました（${f}）: ${line.slice(0, 40)}`);
      }
    }
  }
  console.log(`${records.length} 試合`);
  const weights: MulliganWeights = {};
  // コインで決めた側（kept が空でない側）のデッキだけ推定する
  const deckNames = [...new Set(records.flatMap((r) => r.decks.filter((_, s) => (r.kept[s]?.length ?? 0) > 0)))].sort();

  for (const deckName of deckNames) {
    const deck = DEFAULT_DECKS.find((d) => d.name === deckName);
    if (!deck) throw new Error(`デッキがありません: ${deckName}`);
    const cards = [...new Set(deck.cards)];
    // このデッキが実際に当たった相手（定数項の基準は最初の 1 つ）
    const opps = [...new Set(records.flatMap((r) => ([0, 1] as const).filter((s) => r.decks[s] === deckName).map((s) => r.decks[1 - s]!)))].sort();
    // 列: 定数, 後攻, 相手デッキ（最初の 1 つを除く）, カードごとに [初手1枚以上, 初手2枚以上, 残した1枚以上, 残した2枚以上]（--seat なら残した×後攻も）
    const base = 2 + (opps.length - 1);
    const per = seat ? 6 : 4;
    const d = base + cards.length * per;
    const rows: Row[] = [];
    for (const r of records) {
      for (const s of [0, 1] as const) {
        if (r.decks[s] !== deckName || r.kept[s].length === 0) continue;
        const x = new Array<number>(d).fill(0);
        const second = r.first !== s ? 1 : 0;
        x[0] = 1;
        x[1] = second;
        const oi = opps.indexOf(r.decks[1 - s]!);
        if (oi > 0) x[1 + oi] = 1;
        cards.forEach((c, ci) => {
          const h = r.hands[s].filter((id) => id === c).length;
          const k = r.hands[s].filter((id, hi) => id === c && r.kept[s][hi]).length;
          const o = base + ci * per;
          x[o] = h >= 1 ? 1 : 0;
          x[o + 1] = h >= 2 ? 1 : 0;
          x[o + 2] = k >= 1 ? 1 : 0;
          x[o + 3] = k >= 2 ? 1 : 0;
          if (seat) {
            x[o + 4] = k >= 1 ? second : 0;
            x[o + 5] = k >= 2 ? second : 0;
          }
        });
        rows.push({ y: r.winner === s ? 1 : 0, x });
      }
    }
    const isKeep = (j: number) => j >= base && [2, 3, 4, 5].includes((j - base) % per);
    // 1 回目: ほぼ正則化なしで、係数のばらつきと標準誤差から事前分布の分散を見積もる（経験ベイズ）
    const raw = ridge(rows, Array.from({ length: d }, () => 0));
    // 2 枚目の列は試合数が少なく標準誤差が大きいので、見積もりには 1 枚目を残す列だけを使う
    const keepCols = [...Array(d).keys()].filter((j) => j >= base && (j - base) % per === 2 && raw.se[j]! < 0.5);
    const meanB2 = keepCols.reduce((s, j) => s + raw.b[j]! ** 2, 0) / keepCols.length;
    const meanSe2 = keepCols.reduce((s, j) => s + raw.se[j]! ** 2, 0) / keepCols.length;
    const tau2 = Math.max(meanB2 - meanSe2, 1e-5);
    const lambda = raw.sigma2 / tau2;
    const fit = ridge(rows, Array.from({ length: d }, (_, j) => (isKeep(j) ? lambda : 0)));
    const win = rows.reduce((s, r) => s + r.y, 0) / rows.length;
    console.log(`\n## ${deckName}（${rows.length} 試合、勝率 ${(win * 100).toFixed(1)}%、後攻の効果 ${(fit.b[1]! * 100).toFixed(1)}%、事前分布の SD ${(Math.sqrt(tau2) * 100).toFixed(1)}%）`);
    console.log(`| カード | コスト | 初手に1枚以上 | 1枚目を残す | 生の推定 | 2枚目も残す | 生の推定 |${seat ? " 1枚目×後攻 |" : ""}`);
    console.log(`| --- | --- | --- | --- | --- | --- | --- |${seat ? " --- |" : ""}`);
    const table: Record<string, [number, number]> = {};
    const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}`;
    const sorted = cards.map((c, ci) => ({ c, ci })).sort((a, b) => fit.b[base + b.ci * per + 2]! - fit.b[base + a.ci * per + 2]!);
    for (const { c, ci } of sorted) {
      const o = base + ci * per;
      const n1 = rows.filter((r) => r.x[o] === 1).length;
      // --sig: 2 SE に届かない重みは今の方針（コスト 3 以下を残す）にする
      const costSign = cardOf(c).cost <= 3 ? 1e-4 : -1e-4;
      const w = (j: number) => (sig && Math.abs(fit.b[j]!) < 2 * fit.se[j]! ? costSign : round(fit.b[j]!));
      // 2 枚目を残す効果は試合数が少なく（2 枚とも残した試合はまれ）ほとんど測れないので、
      // 2 SE に届かなければ 1 枚目と同じ判断にする（重みを 0 以上の小さな値にする）
      const w2 = Math.abs(fit.b[o + 3]!) < 2 * fit.se[o + 3]! ? 1e-4 : w(o + 3);
      table[c] = [w(o + 2), w2];
      const card = cardOf(c);
      const copies = deck.cards.filter((x) => x === c).length;
      const second = copies >= 2 ? `${pct(fit.b[o + 3]!)}±${(fit.se[o + 3]! * 100).toFixed(1)} | ${pct(raw.b[o + 3]!)}±${(raw.se[o + 3]! * 100).toFixed(1)}` : "- | -";
      const seatCol = seat ? ` ${pct(fit.b[o + 4]!)}±${(fit.se[o + 4]! * 100).toFixed(1)} |` : "";
      console.log(`| ${card.name} | ${card.cost} | ${n1} | ${pct(fit.b[o + 2]!)}±${(fit.se[o + 2]! * 100).toFixed(1)} | ${pct(raw.b[o + 2]!)}±${(raw.se[o + 2]! * 100).toFixed(1)} | ${second} |${seatCol}`);
    }
    // --sig のエルフは重みを出さない（今の方針がリノセウス用のルールで、カードごとの重みでは表せないため）
    if (!(sig && deckName === "リノセウスエルフ")) weights[deckName] = table;
  }
  if (out) {
    // --merge: 出力ファイルの既存の重みのうち、推定しなかったデッキは残す
    const base: MulliganWeights = merge && existsSync(out) ? parseMulliganWeights(JSON.parse(readFileSync(out, "utf8"))) : {};
    writeFileSync(out, JSON.stringify({ ...base, ...weights }, null, 2) + "\n");
    console.log(`\n${out} に書き出しました`);
  }
  return 0;
}

const round = (v: number) => Math.round(v * 10000) / 10000;
