// plan-value-data の集計（npm run plan-value-fit -- <data.jsonl...> [--out report.md] [--exclude リノセウスエルフ]）。
//
// 同じ局面の候補どうしで、勝率（M 回の続きの平均）と評価関数の点数を、局面ごとの平均を引いてから比べる。
// - 評価関数の点数で、局面の中の勝率の違いがどれだけ説明できるか（打ち切りの誤差を除いた説明率）
// - 選び損: 探索 AI が選ぶ候補（相手のターンを読んだ後の点数が最大）と、勝率が最も高い候補の差。
//   続きの半分で最善を選び、残りの半分で測る（選んだ側の誤差で大きく見えないように）
// - 評価関数が見ていない指標の候補: 勝率から評価関数の点数で説明できる分を引いた残りを、特徴ごとに説明できるか
//   （特徴も評価関数の点数で説明できる分を引いてから当てはめる。標準誤差は局面ごとにまとめて計算する）

import { readFileSync, writeFileSync } from "node:fs";
import { cardOf } from "../src/engine";
import type { PlanCandidate, PlanValueRecord, SideSummary } from "./plan-value-data-main";

type Features = Record<string, number>;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const has = (c: SideSummary["board"][number], k: string) => c.kw.includes(k);

/** 候補のターン末の局面の特徴（視点のプレイヤーから見て） */
function features(c: PlanCandidate): Features {
  const me = c.me, opp = c.opp;
  const myF = me.board.filter((x) => x.kind === "follower");
  const opF = opp.board.filter((x) => x.kind === "follower");
  const myAtk = sum(myF.map((x) => x.atk));
  const opAtk = sum(opF.map((x) => x.atk));
  const nextPp = Math.min(10, me.maxPp + 1);
  const opMaxAtk = Math.max(0, ...opF.map((x) => x.atk));
  const myMaxAtk = Math.max(0, ...myF.map((x) => x.atk));
  const f: Features = {
    自分の体力: me.hp,
    相手の体力: opp.hp,
    手札の枚数: me.hand.length,
    残りPP: me.pp,
    EP: me.ep,
    SEP: me.sep,
    自分のフォロワー数: myF.length,
    自分の攻撃力計: myAtk,
    自分の体力計: sum(myF.map((x) => x.def)),
    自分のアミュレット数: me.board.length - myF.length,
    自分の守護: myF.filter((x) => has(x, "ward")).length,
    相手のフォロワー数: opF.length,
    相手の攻撃力計: opAtk,
    相手の体力計: sum(opF.map((x) => x.def)),
    相手の守護: opF.filter((x) => has(x, "ward")).length,
    相手のアミュレット数: opp.board.length - opF.length,
    "次のターンの打点−相手の体力": myAtk - opp.hp,
    "相手の打点−自分の体力": opAtk - me.hp,
    次のターンにリーサル圏: opF.some((x) => has(x, "ward")) ? 0 : myAtk >= opp.hp ? 1 : 0,
    相手のリーサル圏: myF.some((x) => has(x, "ward")) ? 0 : opAtk >= me.hp ? 1 : 0,
    相手の最大攻撃力より体力が多い自分のフォロワー: myF.filter((x) => x.def > opMaxAtk).length,
    自分の最大攻撃力より体力が多い相手のフォロワー: opF.filter((x) => x.def > myMaxAtk).length,
    "体力 1〜2 の自分のフォロワー": myF.filter((x) => x.def <= 2).length,
    "体力 1〜2 の相手のフォロワー": opF.filter((x) => x.def <= 2).length,
    手札のコスト計: sum(me.hand.map((h) => h.cost)),
    次のターンに出せる手札: me.hand.filter((h) => h.cost <= nextPp).length,
    "2 コスト以下の手札": me.hand.filter((h) => h.cost <= 2).length,
    "手札で次のターンに使える PP（上限 PP）": Math.min(nextPp, sum(me.hand.filter((h) => h.cost <= nextPp).map((h) => h.cost))),
    山札: me.deck,
    墓場: Math.min(me.graveyard, 30),
  };
  for (const h of me.hand) f[`手札: ${cardOf(h.id).name}`] = (f[`手札: ${cardOf(h.id).name}`] ?? 0) + 1;
  for (const b of me.board) f[`自分の場: ${cardOf(b.id).name}`] = (f[`自分の場: ${cardOf(b.id).name}`] ?? 0) + 1;
  for (const b of opp.board) f[`相手の場: ${cardOf(b.id).name}`] = (f[`相手の場: ${cardOf(b.id).name}`] ?? 0) + 1;
  return f;
}

interface Pos {
  rec: PlanValueRecord;
  /** 候補ごとの、全ての候補で打てた続きだけの勝敗（1/0） */
  wins: number[][];
  value: number[];
  rescored: number[];
  feats: Features[];
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const center = (xs: number[]) => {
  const m = sum(xs) / xs.length;
  return xs.map((x) => x - m);
};

export async function main(argv: string[]): Promise<number> {
  const files: string[] = [];
  let out = "plan-value-fit.md";
  const exclude: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i]!;
    else if (argv[i] === "--exclude") exclude.push(argv[++i]!);
    else files.push(argv[i]!);
  }
  const positions: Pos[] = [];
  let decided = 0;
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      let rec: PlanValueRecord;
      try {
        if (!line) continue;
        rec = JSON.parse(line) as PlanValueRecord;
      } catch {
        continue;
      }
      if (exclude.includes(rec.decks[rec.p])) continue;
      // 勝敗が決まった点数（±1e6。ターン終了時の処理や、読んだ相手のターンで決着）は直線で当てはめられないので除く
      if (rec.candidates.some((c) => Math.abs(c.value) >= 1e5 || Math.abs(c.rescored) >= 1e5)) {
        decided++;
        continue;
      }
      const m = rec.candidates[0]!.wins.length;
      const ok = [...Array(m).keys()].filter((r) => rec.candidates.every((c) => c.wins[r] !== null));
      if (ok.length < 2) continue;
      positions.push({
        rec,
        wins: rec.candidates.map((c) => ok.map((r) => (c.wins[r] ? 1 : 0))),
        value: rec.candidates.map((c) => c.value),
        rescored: rec.candidates.map((c) => c.rescored),
        feats: rec.candidates.map(features),
      });
    }
  }
  const lines: string[] = [];
  const log = (s = "") => lines.push(s);
  const nCand = sum(positions.map((p) => p.value.length));
  log(`# 手順どうしの比較（plan-value）`);
  log();
  log(`局面 ${positions.length}、候補 ${nCand}（データ: ${files.join(", ")}${exclude.length ? `、除外: ${exclude.join(", ")}` : ""}）。候補の点数が勝敗の決まった値（±1e6）になる ${decided} 局面は除いた`);
  log();

  // 局面の中の勝率の違いと、打ち切りの誤差
  const W = positions.map((p) => center(p.wins.map((w) => sum(w) / w.length)));
  let varW = 0, noise = 0;
  positions.forEach((p, i) => {
    const k = p.wins.length;
    W[i]!.forEach((x) => (varW += x * x));
    for (const w of p.wins) {
      const mean = sum(w) / w.length;
      // 候補の勝率の推定の分散（平均を引いた分の自由度 (k-1)/k を掛ける）
      noise += (mean * (1 - mean)) / Math.max(1, w.length - 1) * ((k - 1) / k);
    }
  });
  log(`## 評価関数でどれだけ説明できるか`);
  log();
  log(`局面の中の勝率の分散のうち、打ち切りの誤差を除いた分: ${(((varW - noise) / varW) * 100).toFixed(0)}%（残りは M 回の続きの誤差）`);
  log();
  log(`| 点数 | 1 点あたりの勝率 | 説明できた分（誤差を除いた分に対して） |`);
  log(`| --- | ---: | ---: |`);
  const fitScale = (key: "value" | "rescored") => {
    const X = positions.map((p) => center(p[key]));
    let xy = 0, xx = 0;
    positions.forEach((_, i) => X[i]!.forEach((x, j) => ((xy += x * W[i]![j]!), (xx += x * x))));
    const a = xy / xx;
    let rss = 0;
    positions.forEach((_, i) => X[i]!.forEach((x, j) => (rss += (W[i]![j]! - a * x) ** 2)));
    return { a, X, explained: (varW - rss) / (varW - noise) };
  };
  const byValue = fitScale("value");
  const byRescored = fitScale("rescored");
  log(`| ターン末の点数 | ${pct(byValue.a)} | ${(byValue.explained * 100).toFixed(0)}% |`);
  log(`| 相手のターンを読んだ後の点数 | ${pct(byRescored.a)} | ${(byRescored.explained * 100).toFixed(0)}% |`);
  log();

  // 選び損（続きを半分に分けて、片方で最善を選び、もう片方で測る）
  let regret = 0, regretN = 0, pickedTop = 0;
  const regretOf: number[] = [];
  for (const p of positions) {
    const chosen = p.rescored.indexOf(Math.max(...p.rescored));
    const m = p.wins[0]!.length;
    const half = (w: number[], h: 0 | 1) => {
      const xs = w.filter((_, r) => r % 2 === h);
      return xs.length ? sum(xs) / xs.length : 0;
    };
    let r = 0;
    for (const h of [0, 1] as const) {
      const sel = p.wins.map((w) => half(w, h));
      const best = sel.indexOf(Math.max(...sel));
      const g = h === 0 ? 1 : 0;
      r += (half(p.wins[best]!, g) - half(p.wins[chosen]!, g)) / 2;
    }
    if (m >= 2) {
      regret += r;
      regretN++;
    }
    regretOf.push(r);
    if (chosen === p.wins.map((w) => sum(w)).indexOf(Math.max(...p.wins.map((w) => sum(w))))) pickedTop++;
  }
  log(`## 選び損`);
  log();
  log(`探索 AI が選ぶ候補（相手のターンを読んだ後の点数が最大）と、続きで勝率が最も高かった候補の差の平均: ${pct(regret / regretN)}（続きを半分に分けて推定。1 局面の 1 回の判断あたり）`);
  log(`勝率が最も高かった候補を選んでいた局面: ${pickedTop}/${positions.length}`);
  log();

  // 評価関数が見ていない指標の候補
  const e = positions.map((_, i) => W[i]!.map((w, j) => w - byRescored.a * byRescored.X[i]![j]!));
  const names = new Set<string>();
  for (const p of positions) for (const f of p.feats) for (const k of Object.keys(f)) names.add(k);
  const rows: { name: string; b: number; se: number; t: number; n: number }[] = [];
  for (const name of names) {
    const F = positions.map((p) => center(p.feats.map((f) => f[name] ?? 0)));
    // 特徴から評価関数の点数で説明できる分を引く
    let fx = 0, xx = 0;
    positions.forEach((_, i) => F[i]!.forEach((f, j) => ((fx += f * byRescored.X[i]![j]!), (xx += byRescored.X[i]![j]! ** 2))));
    const c = fx / xx;
    const Fh = F.map((fs, i) => fs.map((f, j) => f - c * byRescored.X[i]![j]!));
    let fe = 0, ff = 0, n = 0;
    Fh.forEach((fs, i) => {
      let any = false;
      fs.forEach((f, j) => {
        fe += f * e[i]![j]!;
        ff += f * f;
        if (Math.abs(F[i]![j]!) > 1e-9) any = true;
      });
      if (any) n++;
    });
    if (ff < 1e-9 || n < 15) continue;
    const b = fe / ff;
    // 局面ごとにまとめた標準誤差
    let v = 0;
    Fh.forEach((fs, i) => {
      let s = 0;
      fs.forEach((f, j) => (s += f * (e[i]![j]! - b * f)));
      v += s * s;
    });
    const se = Math.sqrt(v) / ff;
    rows.push({ name, b, se, t: b / se, n });
  }
  rows.sort((x, y) => Math.abs(y.t) - Math.abs(x.t));
  log(`## 評価関数が見ていない指標の候補`);
  log();
  log(`勝率のうち評価関数（相手のターンを読んだ後の点数）で説明できない分を、特徴 1 つずつで当てはめた。`);
  log(`「1 あたり」は、評価関数の点数が同じとき、特徴が 1 増えると勝率がどれだけ変わるか。「局面」は候補の間で特徴が違った局面の数。`);
  log(`特徴をたくさん試しているので、|t| が 3 未満のものは偶然の可能性が高い。上位でも勝率の比較で確かめるまでは採用しない。`);
  log();
  log(`| 特徴 | 1 あたり | 標準誤差 | t | 局面 |`);
  log(`| --- | ---: | ---: | ---: | ---: |`);
  for (const r of rows.slice(0, 60)) log(`| ${r.name} | ${pct(r.b)} | ${pct(r.se)} | ${r.t.toFixed(2)} | ${r.n} |`);
  log();

  // 選び損の大きい局面（人が見る用）
  log(`## 選び損の大きい局面（上位 15）`);
  log();
  const order = positions.map((_, i) => i).sort((a, b) => regretOf[b]! - regretOf[a]!);
  for (const i of order.slice(0, 15)) {
    const p = positions[i]!;
    const rec = p.rec;
    log(`### seed ${rec.seed}、${rec.decks[rec.p]}（${rec.p === rec.first ? "先攻" : "後攻"}）vs ${rec.decks[rec.p === 0 ? 1 : 0]}、自分の ${rec.ownTurn} ターン目（選び損 ${pct(regretOf[i]!)}）`);
    log();
    rec.candidates.forEach((c, j) => {
      const w = p.wins[j]!;
      log(`- 勝率 ${((sum(w) / w.length) * 100).toFixed(0)}%（${w.length} 回）、点数 ${c.value} / 読んだ後 ${c.rescored}: ${c.steps.join(" → ")}`);
    });
    log();
  }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(lines.slice(0, 30).join("\n"));
  console.log(`… ${out} に書き出した`);
  return 0;
}
