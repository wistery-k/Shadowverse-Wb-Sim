// 手札の形のマリガン（src/ai/mulliganModel.ts）の係数の推定（npm run mulligan-model-fit -- <データ.jsonl ...> [--out <file.json>] [--feature-sd 0.05] [--card-sd 0.02] [--features a,b,...]）。
// --features で使う特徴を絞る（他の特徴は係数 0 で保存しない）。
// データは npm run mulligan-data で取る（初手の各カードの残す・返すを、コインまたは今の方針からの反転で決めた試合）。
// デッキごとに、勝敗 ~ 先後 + 相手デッキ + 初手にあったカード（調整） + 残した手札の特徴 + 残したカード の線形確率モデル（リッジ回帰）。
// 残すかどうかはランダムに決めたので、「残した手札の特徴」と「残したカード」の係数は因果的な効果として読める。
// 特徴は事前分布の SD --feature-sd、カードは --card-sd で 0 に向けて縮める。

import { readFileSync, writeFileSync } from "node:fs";
import { MODEL_FEATURES, MULLIGAN_ROLES, handFeatures, type MulliganModel } from "../src/ai/mulliganModel";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { cardOf } from "../src/engine";
import type { MulliganRecord } from "./mulligan-data-main";
import { ridge, type Row } from "./mulligan-fit-main";

export async function main(argv: string[]): Promise<number> {
  const files: string[] = [];
  let out: string | null = null;
  let featureSd = 0.05, cardSd = 0.02;
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? null;
    else if (argv[i] === "--feature-sd") featureSd = Number(argv[++i]);
    else if (argv[i] === "--card-sd") cardSd = Number(argv[++i]);
    else if (argv[i] === "--features") only = (argv[++i] ?? "").split(",");
    else files.push(argv[i]!);
  }
  const records: MulliganRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as MulliganRecord);
      } catch {
        console.log(`読めない行を飛ばしました（${f}）`);
      }
    }
  }
  console.log(`${records.length} 試合`);
  for (const f of only ?? []) if (!MODEL_FEATURES.includes(f)) throw new Error(`不明な特徴: ${f}`);
  const used = MODEL_FEATURES.map((f) => only === null || only.includes(f));
  const model: MulliganModel = {};
  const deckNames = [...new Set(records.flatMap((r) => r.decks))].sort();
  for (const deckName of deckNames) {
    const roles = MULLIGAN_ROLES[deckName];
    if (!roles) continue;
    const deck = DEFAULT_DECKS.find((d) => d.name === deckName)!;
    const cards = [...new Set(deck.cards)];
    const opps = deckNames.filter((n) => n !== deckName);
    // 列: 定数, 後攻, 相手デッキ（最初の 1 つを除く）, カードごとに [初手1枚以上, 初手2枚以上], 特徴, カードごとの残した1枚以上
    const nf = MODEL_FEATURES.length;
    const base = 2 + (opps.length - 1) + cards.length * 2;
    const d = base + nf + cards.length;
    const rows: Row[] = [];
    for (const r of records) {
      for (const s of [0, 1] as const) {
        if (r.decks[s] !== deckName) continue;
        const x = new Array<number>(d).fill(0);
        const second = r.first !== s;
        x[0] = 1;
        x[1] = second ? 1 : 0;
        const oi = opps.indexOf(r.decks[1 - s]!);
        if (oi > 0) x[1 + oi] = 1;
        const kept = r.hands[s].filter((_, i) => r.kept[s][i]);
        cards.forEach((c, ci) => {
          const h = r.hands[s].filter((id) => id === c).length;
          x[2 + (opps.length - 1) + ci * 2] = h >= 1 ? 1 : 0;
          x[2 + (opps.length - 1) + ci * 2 + 1] = h >= 2 ? 1 : 0;
          x[base + nf + ci] = kept.includes(c) ? 1 : 0;
        });
        handFeatures(kept, roles, second).forEach((v, i) => (x[base + i] = v));
        rows.push({ y: r.winner === s ? 1 : 0, x });
      }
    }
    const win = rows.reduce((s, r) => s + r.y, 0) / rows.length;
    const sigma2 = win * (1 - win);
    // 使わない特徴は列を 0 にしてごく強く縮める（係数は 0 になる）
    for (const r of rows) used.forEach((u, i) => u || (r.x[base + i] = 0));
    const penalty = Array.from({ length: d }, (_, j) => (j < base ? 0 : j < base + nf ? (used[j - base] ? sigma2 / featureSd ** 2 : 1e9) : sigma2 / cardSd ** 2));
    const fit = ridge(rows, penalty);
    const features: Record<string, number> = {};
    const cardCoef: Record<string, number> = {};
    console.log(`\n## ${deckName}（${rows.length} 試合、勝率 ${(win * 100).toFixed(1)}%）`);
    console.log("| 特徴 | 係数 |\n| --- | --- |");
    MODEL_FEATURES.forEach((name, i) => {
      if (!used[i]) return;
      const b = fit.b[base + i]!;
      features[name] = Math.round(b * 1e4) / 1e4;
      console.log(`| ${name} | ${b >= 0 ? "+" : ""}${(b * 100).toFixed(1)}±${(fit.se[base + i]! * 100).toFixed(1)} |`);
    });
    console.log("\n| カード | コスト | 役割 | 残した |\n| --- | --- | --- | --- |");
    cards
      .map((c, ci) => [c, fit.b[base + nf + ci]!, fit.se[base + nf + ci]!] as const)
      .sort((a, b) => b[1] - a[1])
      .forEach(([c, b, se]) => {
        cardCoef[c] = Math.round(b * 1e4) / 1e4;
        console.log(`| ${cardOf(c).name} | ${cardOf(c).cost} | ${(roles[c] ?? []).join("・")} | ${b >= 0 ? "+" : ""}${(b * 100).toFixed(1)}±${(se * 100).toFixed(1)} |`);
      });
    model[deckName] = { features, cards: cardCoef };
  }
  if (out) {
    writeFileSync(out, JSON.stringify(model, null, 1) + "\n");
    console.log(`\n${out} に書きました`);
  }
  return 0;
}
