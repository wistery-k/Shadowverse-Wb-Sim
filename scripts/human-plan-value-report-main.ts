// human-plan-value の集計（npm run human-plan-value-report -- <data.jsonl...> [--out report.md] [--top 40]）。
//
// 差は「人間の手順の勝率 − AI の手順の勝率」（同じ M 個のシードの続きを探索 AI が打った勝率）。同じ局面になったターンは差 0 として数える。
// - デッキ別・ターン別の差の平均。1 試合あたりの差の合計（人間と AI の勝率の差のうち、ターンごとの選択で説明できる分の目安）
// - 打ち比べたターンを 3 つに分ける: 人間の手順の点数が AI の候補の最善より高い（ビームが届かなかった）／人間の手順が AI の候補にあった／
//   それ以外（評価が人間の手順を AI の候補より低く見た）
// - 差の大きいターン（人間が良い・AI が良い）を手順付きで並べる

import { readFileSync, writeFileSync } from "node:fs";
import type { HumanPlanRecord, HumanPlanSide } from "./human-plan-value-main";

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const se = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
const pct = (x: number) => (Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const rate = (s: HumanPlanSide) => mean(s.wins.filter((w): w is boolean => w !== null).map(Number));

/** 1 局面の差（共通のシードで両方とも打てた組だけ）と、その標準誤差 */
function diff(r: HumanPlanRecord): { d: number; se: number; n: number } {
  if (r.same) return { d: 0, se: 0, n: 0 };
  const ds: number[] = [];
  r.human.wins.forEach((h, i) => {
    const a = r.ai.wins[i];
    if (h !== null && a !== null && a !== undefined) ds.push(Number(h) - Number(a));
  });
  return { d: mean(ds), se: se(ds), n: ds.length };
}

type Kind = "ビームが届かなかった" | "AI の候補にあった" | "評価が低く見た" | "マリガン" | "試合が終わった";
function kindOf(r: HumanPlanRecord): Kind | null {
  if (r.same) return null;
  if (r.ownTurn === 0) return "マリガン";
  if (r.human.ended || r.ai.ended || r.human.value === null || r.beamBest === null) return "試合が終わった";
  if (r.human.value > r.beamBest + 1e-9) return "ビームが届かなかった";
  if (r.humanInCandidates) return "AI の候補にあった";
  return "評価が低く見た";
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

export async function main(argv: string[]): Promise<number> {
  let out: string | null = null, top = 40;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--out") out = argv[++i] ?? null;
    else if (k === "--top") top = Number(argv[++i]);
    else files.push(k);
  }
  const recs: HumanPlanRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        recs.push(JSON.parse(line) as HumanPlanRecord);
      } catch {
        // 壊れた行は飛ばす
      }
    }
  }
  const L: string[] = [];
  const withD = recs.map((r) => ({ r, ...diff(r) })).filter((x) => !Number.isNaN(x.d));
  const games = new Map<string, HumanPlanRecord[]>();
  for (const r of recs) {
    const k = `${r.subject}/${r.deck}/${r.g}/${r.seat}`;
    games.set(k, [...(games.get(k) ?? []), r]);
  }
  const perGameSum = (rs: HumanPlanRecord[]) => rs.reduce((a, r) => a + (Number.isNaN(diff(r).d) ? 0 : diff(r).d), 0);

  L.push("# 人間の手順と AI の手順の打ち比べ（human-plan-value）", "");
  L.push(`データ: ${files.join("、")}`, "");
  const compared = withD.filter((x) => !x.r.same);
  L.push(
    `- 試合 ${games.size}（人間の勝ち ${[...games.values()].filter((rs) => rs[0]!.won).length}）、局面 ${recs.length}、同じ局面 ${recs.filter((r) => r.same).length}、打ち比べ ${compared.length}`,
    `- 差（人間 − AI、続きは探索 AI）の平均: 全局面 ${pct(mean(withD.map((x) => x.d)))} ± ${pct(se(withD.map((x) => x.d)))}、打ち比べた局面 ${pct(mean(compared.map((x) => x.d)))} ± ${pct(se(compared.map((x) => x.d)))}`,
    `- 1 試合あたりの差の合計: ${pct(mean([...games.values()].map(perGameSum)))} ± ${pct(se([...games.values()].map(perGameSum)))}`,
    "",
  );

  L.push("## デッキ別", "");
  L.push(row(["デッキ", "試合", "人間の勝ち", "局面", "打ち比べ", "差の平均（打ち比べ）", "1 試合の合計"]), row(["---", "---:", "---:", "---:", "---:", "---:", "---:"]));
  for (const subject of [...new Set(recs.map((r) => r.subject))]) {
    const gs = [...games.values()].filter((rs) => rs[0]!.subject === subject);
    const cs = compared.filter((x) => x.r.subject === subject).map((x) => x.d);
    L.push(row([subject, gs.length, gs.filter((rs) => rs[0]!.won).length, recs.filter((r) => r.subject === subject).length, cs.length, `${pct(mean(cs))} ± ${pct(se(cs))}`, pct(mean(gs.map(perGameSum)))]));
  }
  L.push("");

  L.push("## 自分のターン別（0 はマリガン）", "");
  L.push(row(["ターン", "局面", "打ち比べ", "差の平均（全局面）", "差の平均（打ち比べ）"]), row(["---:", "---:", "---:", "---:", "---:"]));
  const maxTurn = Math.max(...recs.map((r) => r.ownTurn));
  for (let t = 0; t <= maxTurn; t++) {
    const all = withD.filter((x) => x.r.ownTurn === t).map((x) => x.d);
    if (all.length === 0) continue;
    const cs = compared.filter((x) => x.r.ownTurn === t).map((x) => x.d);
    L.push(row([t, all.length, cs.length, `${pct(mean(all))} ± ${pct(se(all))}`, `${pct(mean(cs))} ± ${pct(se(cs))}`]));
  }
  L.push("");

  L.push("## 打ち比べた局面の分類", "");
  L.push("- ビームが届かなかった: 人間のターン末の点数が、AI の候補（最初の手ごとの最善の並び）の最善より高い", "- AI の候補にあった: 人間のターン末が候補のどれかと同じ局面（相手のターンを読み直して別の手を選んだ）", "- 評価が低く見た: それ以外（人間のターン末の点数が候補の最善以下で、候補にもない）", "");
  L.push(row(["分類", "局面", "差の平均", "差 ≥ +25%", "差 ≤ −25%", "点数（人間 − AI）の平均"]), row(["---", "---:", "---:", "---:", "---:", "---:"]));
  const kinds: Kind[] = ["ビームが届かなかった", "AI の候補にあった", "評価が低く見た", "マリガン", "試合が終わった"];
  for (const k of kinds) {
    const xs = compared.filter((x) => kindOf(x.r) === k);
    if (xs.length === 0) continue;
    const dv = xs.filter((x) => x.r.human.value !== null && x.r.ai.value !== null).map((x) => x.r.human.value! - x.r.ai.value!);
    L.push(row([k, xs.length, `${pct(mean(xs.map((x) => x.d)))} ± ${pct(se(xs.map((x) => x.d)))}`, xs.filter((x) => x.d >= 0.25).length, xs.filter((x) => x.d <= -0.25).length, Number.isNaN(mean(dv)) ? "-" : mean(dv).toFixed(2)]));
  }
  L.push("");

  const show = (title: string, xs: typeof withD) => {
    L.push(`## ${title}`, "");
    for (const x of xs) {
      const r = x.r;
      const v = (s: HumanPlanSide) => `点数 ${s.value ?? "-"}・読み後 ${s.rescored ?? "-"}・勝率 ${pct(rate(s))}`;
      L.push(
        `### ${r.subject} vs ${r.deck} g${r.g} 席${r.seat}（${r.won ? "人間の勝ち" : "人間の負け"}）自分の ${r.ownTurn} ターン目: 差 ${pct(x.d)} ± ${pct(x.se)}（${kindOf(r)}）`,
        "",
        `- 開始時: 体力 ${r.start.hp}・相手 ${r.start.oppHp}、PP ${r.start.maxPp}、手札 ${r.start.hand}・相手 ${r.start.oppHand}、EP ${r.start.ep}・SEP ${r.start.sep}、場 ${r.start.board}・相手 ${r.start.oppBoard}。AI の候補の最善の点数 ${r.beamBest ?? "-"}`,
        `- 人間（${v(r.human)}）: ${r.human.steps.join(" → ") || "何もしない"}`,
        `- AI（${v(r.ai)}）: ${r.ai.steps.join(" → ") || "何もしない"}`,
        "",
      );
    }
  };
  const sorted = [...compared].sort((a, b) => b.d - a.d);
  show(`人間の手順が良かった局面（上位 ${top}）`, sorted.filter((x) => x.d > 0).slice(0, top));
  show(`AI の手順が良かった局面（上位 ${Math.ceil(top / 2)}）`, sorted.filter((x) => x.d < 0).reverse().slice(0, Math.ceil(top / 2)));

  const text = L.join("\n") + "\n";
  if (out) writeFileSync(out, text);
  else console.log(text);
  return 0;
}
