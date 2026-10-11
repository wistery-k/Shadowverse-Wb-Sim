// play-now-data の集計（npm run play-now-fit）。
// デッキ・カードごとに「今出す − このターンは持っておく」の勝率の差と、AI がそのターンに実際に出した割合を並べる。
// 差が負なのに AI がよく出すカード、差が正なのに AI があまり出さないカードが、評価関数が見誤っている候補。

import { readFileSync } from "node:fs";
import { cardOf } from "../src/engine";
import type { PlayNowRecord } from "./play-now-data-main";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
function se(xs: number[]): number {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

interface Cell {
  deck: string;
  cardId: string;
  diffs: number[];
  /** 持っておく続きで PP が 2 以上余った局面 / それ以外の局面での差 */
  wasteDiffs: number[];
  fullDiffs: number[];
  /** エンハンスできるまで禁じた続きとの差（今出す − エンハンスまで待つ） */
  enhanceDiffs: number[];
  played: number;
  /** AI が出さなかった局面での、出さなかった続き（hold）と何も変えない続き（normal）の勝敗の一致（確かめ用） */
  holdSame: number;
  holdN: number;
}

/** npm run play-now-fit -- <data.jsonl>... [--min <n>] [--turns 2-4] */
export async function main(argv: string[]): Promise<number> {
  let min = 30, turns: number[] | null = null;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min") min = Number(argv[++i]);
    else if (argv[i] === "--turns") turns = argv[++i]!.split("-").map(Number);
    else files.push(argv[i]!);
  }
  const recs: PlayNowRecord[] = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l, i) => {
      try {
        return [JSON.parse(l) as PlayNowRecord];
      } catch {
        console.error(`読めない行を飛ばします: ${f}:${i + 1}`);
        return [];
      }
    }),
  );
  const cells = new Map<string, Cell>();
  let pairs = 0, discordant = 0;
  for (const r of recs) {
    if (turns && (r.ownTurn < turns[0]! || r.ownTurn > turns[1]!)) continue;
    const deck = r.decks[r.p];
    for (const c of r.cards) {
      if (c.playWin === null || c.holdWin === null) continue;
      const d = (c.playWin ? 1 : 0) - (c.holdWin ? 1 : 0);
      pairs++;
      if (d !== 0) discordant++;
      const key = `${deck}|${c.cardId}`;
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { deck, cardId: c.cardId, diffs: [], wasteDiffs: [], fullDiffs: [], enhanceDiffs: [], played: 0, holdSame: 0, holdN: 0 }));
      cell.diffs.push(d);
      if (c.holdPpLeft !== null && c.holdPpLeft >= 2) cell.wasteDiffs.push(d);
      else cell.fullDiffs.push(d);
      if (c.holdEnhanceWin !== null && c.holdEnhanceWin !== undefined) cell.enhanceDiffs.push((c.playWin ? 1 : 0) - (c.holdEnhanceWin ? 1 : 0));
      if (c.normalPlayed) cell.played++;
      else if (r.normalWin !== null) {
        cell.holdN++;
        if (r.normalWin === c.holdWin) cell.holdSame++;
      }
    }
  }
  const all = [...cells.values()];
  const holdN = all.reduce((a, c) => a + c.holdN, 0), holdSame = all.reduce((a, c) => a + c.holdSame, 0);
  console.log(`局面 ${recs.length}、対 ${pairs}、勝敗が入れ替わった対 ${((discordant / Math.max(pairs, 1)) * 100).toFixed(1)}%`);
  console.log(`確かめ: AI が出さなかった局面で、禁じた続きと何も変えない続きの勝敗が一致 ${holdSame}/${holdN}`);
  const allDiffs = all.flatMap((c) => c.diffs);
  console.log(`全カード: 今出す − 持っておく ${pct(mean(allDiffs))} ± ${pct(se(allDiffs))}`);
  console.log();
  console.log("持っておく続きで PP が 2 以上余った局面と、それ以外の局面に分けた差も出す（余った局面では今出す方が良く見えやすい）。");
  console.log("エンハンスは、エンハンスのコストに PP が届くまで禁じた続きとの差（今出す − 待つ）。");
  console.log();
  console.log("| デッキ | カード | コスト | 対 | 今出す − 持っておく | SE | AI が出した割合 | z | PP が余った局面 | 余らなかった局面 | エンハンスまで待つのと比べて |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |");
  const rows = all
    .filter((c) => c.diffs.length >= min)
    .map((c) => ({ c, m: mean(c.diffs), s: se(c.diffs), rate: c.played / c.diffs.length }))
    .map((x) => ({ ...x, z: x.s > 0 ? x.m / x.s : 0 }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  for (const { c, m, s, rate, z } of rows) {
    const card = cardOf(c.cardId);
    const sub = (xs: number[]) => (xs.length < 10 ? `（${xs.length} 対）` : `${pct(mean(xs))} ± ${pct(se(xs))}（${xs.length}）`);
    const enh = c.enhanceDiffs.length > 0 ? sub(c.enhanceDiffs) : "";
    console.log(`| ${c.deck} | ${card.name} | ${card.cost} | ${c.diffs.length} | ${pct(m)} | ${pct(s)} | ${(rate * 100).toFixed(0)}% | ${z.toFixed(2)} | ${sub(c.wasteDiffs)} | ${sub(c.fullDiffs)} | ${enh} |`);
  }
  return 0;
}
