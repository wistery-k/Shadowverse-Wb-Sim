// npm run sim の --json の結果（--shard で分けたものを含む）をまとめて Markdown の表にする（npm run sim-report）
//
// 使い方: npm run sim-report -- <結果.json>...
// 表は標準出力に出す。CI ではジョブサマリー（$GITHUB_STEP_SUMMARY）に追記する。
// エラーになった試合があれば終了コード 1。

import { readFileSync } from "node:fs";
import { AGENTS } from "../src/ai/registry";
import { summarize, type GameRecord } from "../src/sim/tournament";

interface SimResult {
  args: { games: number; seed: number; agents: string[]; shard?: { index: number; count: number } };
  entrants: string[];
  elapsedSec: number;
  records: GameRecord[];
}

function load(path: string): SimResult {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) throw new Error(`${path}: JSON がオブジェクトではありません`);
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entrants) || !Array.isArray(r.records) || typeof r.args !== "object" || typeof r.elapsedSec !== "number") {
    throw new Error(`${path}: npm run sim -- --json の出力ではありません`);
  }
  return raw as SimResult;
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 100)}%`);
const fmtSec = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒` : `${sec.toFixed(1)}秒`);

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error("使い方: npm run sim-report -- <結果.json>...");
    return 2;
  }
  const results = argv.map(load);
  const first = results[0]!;
  for (const [k, r] of results.entries()) {
    if (JSON.stringify(r.entrants) !== JSON.stringify(first.entrants) || r.args.games !== first.args.games || r.args.seed !== first.args.seed) {
      throw new Error(`${argv[k]}: 参加者・試合数・seed が ${argv[0]} と違います`);
    }
  }
  const entrants = first.entrants;
  const records = results.flatMap((r) => r.records);
  const s = summarize(entrants.length, records);
  const order = entrants.map((_, i) => i).sort((x, y) => {
    const rx = s.entrants[x]!.wins / Math.max(1, s.entrants[x]!.games);
    const ry = s.entrants[y]!.wins / Math.max(1, s.entrants[y]!.games);
    return ry - rx;
  });

  const cpuSec = results.reduce((t, r) => t + r.elapsedSec, 0);
  const wallSec = Math.max(...results.map((r) => r.elapsedSec));
  const agents = first.args.agents.map((a) => `${AGENTS[a]?.label ?? a}（${a}）`).join("、");
  const out: string[] = [];
  out.push("## 自動対戦の結果", "");
  out.push(`AI: ${agents}　1組 ${first.args.games} 試合・seed ${first.args.seed}・${results.length} 並列`, "");
  out.push(`合計 ${s.totalGames} 試合、先攻の勝率 ${pct(s.firstPlayerWins, s.totalGames)}、平均 ${s.averageTurns.toFixed(1)} ターン`, "");
  out.push(
    `所要時間: 対戦 ${fmtSec(wallSec)}（並列の最長）、合計 ${fmtSec(cpuSec)}、1 試合 ${(cpuSec / Math.max(1, records.length)).toFixed(2)}秒`,
    "",
  );

  out.push("### 通算勝率", "", "| 順位 | 参加者 | 勝率 | 勝ち / 試合 |", "|---:|---|---:|---:|");
  for (const [k, i] of order.entries()) {
    const e = s.entrants[i]!;
    out.push(`| ${k + 1} | ${entrants[i]} | ${pct(e.wins, e.games)} | ${e.wins} / ${e.games} |`);
  }
  out.push("");

  const noise = Math.round(50 / Math.sqrt(Math.max(1, first.args.games)));
  out.push("### 対戦表", "", `行の参加者から見た勝率。1 マス ${first.args.games} 試合なので ±${noise}% 程度はぶれる。`, "");
  out.push(`| | ${order.map((_, k) => `#${k + 1}`).join(" | ")} |`, `|---|${order.map(() => "---:").join("|")}|`);
  for (const [k, i] of order.entries()) {
    const cells = order.map((j) => (i === j ? "-" : pct(s.wins[i]![j]!, s.games[i]![j]!)));
    out.push(`| #${k + 1} ${entrants[i]} | ${cells.join(" | ")} |`);
  }
  out.push("");

  if (s.errors.length > 0) {
    out.push(`### エラー ${s.errors.length} 試合`, "");
    for (const r of s.errors.slice(0, 20)) out.push(`- ${entrants[r.a]} vs ${entrants[r.b]} seed ${r.seed}: \`${r.error ?? ""}\``);
    out.push("");
  }
  console.log(out.join("\n"));
  return s.errors.length > 0 ? 1 : 0;
}
