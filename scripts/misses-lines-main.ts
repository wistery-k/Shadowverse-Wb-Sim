// npm run misses-lines の本体: 見落とし問題集の問のうち、候補の打ち比べ調査（docs/survey.md）から足した問に、
// 調査で打ち比べた 2 つの並び（AI の選んだ候補と、二段目で比べた候補）を書き添える（<問のフォルダ>/lines/<問>.json）。
// 問題集のページ（src/ui/Misses.tsx）が盤面の下に並べ、1 手ずつ進めて見せるのに使う。
// 問のファイルには書かない（問題集の指紋 set_fingerprint は問のファイルの中身全部から作るので、足すと変わる）。
//
// 使い方: npm run misses-lines -- <調査の出力.jsonl(.gz)>… [--dir misses/azvaldt] [--force] [--check]
//   問のファイルの origin（"from":"state"、"file":"g<試合>-i<手>.json"）と同じ試合・手の行を探す。
//   --dir は問のフォルダ（既定 misses）。misses/azvaldt なら前期のローテーションのカードを足す。
//   既にある lines/<問>.json は書き直さない（--force で書き直す）。--check は書かずに、どこまで手に戻せたかだけ出す。
//
// 打ち比べは打ち直さない。調査の行から取るのは:
// - steps: AI がその候補を選んだときに、考え直すまで打つ手（調査が打った手。ドロー・ランダムの手の前まで）
// - full: ビームが読んだターンの終わりまでの並びの説明（文字列だけ。AI から見た決定化の局面のもの）
// - 勝ち負け: 一段目（候補ごとに m 回）と二段目（2 つの候補を confirm.n 回）
// actions は、問の局面に steps を打ち、full の残りを打てる手と文字列で突き合わせて（src/misses/stepText.ts）手に戻したもの。
// 最後に「ターン終了」を足す。突き合わせられない文字列が出たら（引いたカード・ランダムな結果が読みと違う）、そこから先は
// 探索 AI（--dir のプールの補正。アズヴォルト環境は R3）に問の名前から作った乱数で考え直させてターンの終わりまで打ち、
// 考え直した最初の手の番号を rethink に書く（調査の打ち比べも、steps の後は AI が考え直して打っている）。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { agentOf } from "../src/ai/registry";
import { actingPlayer, applyAction, legalActions, tryApplyAction } from "../src/engine/game";
import { rngFrom, seedOf } from "../src/engine/rng";
import type { Action, GameState, PlayerIndex } from "../src/engine/types";
import { selectNets } from "../src/engine/wasm";
import { parseProblem } from "../src/misses/problems";
import { stepText } from "../src/misses/stepText";

/** 調査の行の候補（必要な項目だけ） */
interface Plan {
  steps: Action[];
  text: string[];
  full: string[];
  turnEnd?: number;
}
interface Row {
  g?: number;
  i?: number;
  ai?: number;
  m?: number;
  w?: string[];
  plans?: Plan[];
  confirm?: { c: number; n: number; ai: string; alt: string } | null;
  state?: unknown;
}

/** 勝ち負けの数 */
export interface Tally {
  wins: number;
  games: number;
}

/** 並び 1 つ（lines/<問>.json の形。src/misses/problems.ts の MissLine と同じ） */
export interface LineOut {
  kind: "ai" | "good";
  label: string;
  /** 局面から打つ手（AI がこの並びを選んだときに、考え直すまで打つ手） */
  steps: Action[];
  /** steps の説明（調査が書いたもの） */
  text: string[];
  /** 調査で読んだターンの終わりまでの並びの説明（AI から見た決定化の局面のもの。途中で引くカードは予想） */
  full: string[];
  /** 問の局面から打つターンの終わりまでの手（steps ＋ full の残りを手に戻したもの。最後はターン終了） */
  actions: Action[];
  /** full を手に戻しきれず、AI に考え直させた最初の手の番号（actions の添字。全部戻せたら null） */
  rethink: number | null;
  /** 一段目の勝ち（m 回のうち） */
  first: Tally;
  /** 二段目の勝ち（confirm.n 回のうち） */
  second: Tally;
}

/** キーの順番によらない文字列（局面が同じかを見る） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const tally = (s: string): Tally => ({ wins: [...s].filter((c) => c === "1").length, games: s.length });

/** 手番の側のターンが終わったか（相手の手番になったか、勝負がついた） */
const turnOver = (s: GameState, p: PlayerIndex) => s.winner !== null || (s.active !== p && s.pending?.player !== p);

/**
 * full の文字列を、局面で打てる手と突き合わせて手に戻す。同じ文字列になる手が複数あれば（同じ名前のカード）、
 * 残りを最後まで戻せる方を選ぶ（戻せなければ最も長く戻せる方）
 */
function matchTexts(start: GameState, texts: readonly string[], viewer: PlayerIndex): { actions: Action[]; end: GameState } {
  let best: { actions: Action[]; end: GameState } = { actions: [], end: start };
  let budget = 20000;
  const go = (s: GameState, k: number, done: Action[]): boolean => {
    if (done.length > best.actions.length) best = { actions: [...done], end: s };
    if (k === texts.length) return true;
    if (--budget < 0) return false;
    for (const a of legalActions(s)) {
      if (stepText(s, a, viewer) !== texts[k]) continue;
      const next = tryApplyAction(s, a);
      if (!next) continue;
      done.push(a);
      if (go(next, k + 1, done)) return true;
      done.pop();
    }
    return false;
  };
  go(start, 0, []);
  return best;
}

function format(body: { v: number; id: string; source: string; lines: LineOut[] }): string {
  const list = (xs: readonly unknown[]) => (xs.length === 0 ? "[]" : `[\n${xs.map((x) => `        ${JSON.stringify(x)}`).join(",\n")}\n      ]`);
  const lines = body.lines.map((l) =>
    [
      `    {`,
      `      "kind": ${JSON.stringify(l.kind)},`,
      `      "label": ${JSON.stringify(l.label)},`,
      `      "first": ${JSON.stringify(l.first)},`,
      `      "second": ${JSON.stringify(l.second)},`,
      `      "steps": ${list(l.steps)},`,
      `      "text": ${list(l.text)},`,
      `      "full": ${list(l.full)},`,
      `      "rethink": ${JSON.stringify(l.rethink)},`,
      `      "actions": ${list(l.actions)}`,
      `    }`,
    ].join("\n"),
  );
  return `{\n  "v": ${body.v},\n  "id": ${JSON.stringify(body.id)},\n  "source": ${JSON.stringify(body.source)},\n  "lines": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

export async function main(argv: string[]): Promise<number> {
  const force = argv.includes("--force");
  const check = argv.includes("--check");
  let dir = "misses";
  const files: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === "--dir") dir = argv[++k] ?? "";
    else if (a !== "--force" && a !== "--check") files.push(a);
  }
  if (files.length === 0 || !dir) {
    console.error("使い方: npm run misses-lines -- <調査の出力.jsonl(.gz)>… [--dir misses/azvaldt] [--force] [--check]");
    return 2;
  }
  const MISSES = resolve(dir);
  const OUT = join(MISSES, "lines");
  if (basename(MISSES) === "azvaldt") {
    selectNets("azvaldt");
    await import("../src/record/pool");
  }

  // 調査の局面から足した問: 試合・手 → 問
  const wanted = new Map<string, { id: string; raw: unknown }>();
  for (const f of readdirSync(MISSES).filter((x) => x.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(MISSES, f), "utf8")) as { id: string; origin?: { from?: string; file?: string } };
    const m = raw.origin?.from === "state" ? /^g(\d+)-i(\d+)\.json$/.exec(raw.origin.file ?? "") : null;
    if (m) wanted.set(`${m[1]}/${m[2]}`, { id: raw.id, raw });
  }

  if (!check) mkdirSync(OUT, { recursive: true });
  let written = 0;
  let skipped = 0;
  const found = new Set<string>();
  for (const file of files) {
    const buf = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    // 共有フォルダの中の場所で書く（どのマシンのパスかによらない）
    const shown = file.replace(/^.*?(?=logs\/)/, "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Row;
      const key = `${row.g}/${row.i}`;
      const want = wanted.get(key);
      if (!want || !row.plans || row.ai === undefined) continue;
      const problem = parseProblem(want.raw);
      if (canonical(row.state) !== canonical(problem.state)) throw new Error(`${want.id}: 調査の行（${shown} の試合 ${row.g} の ${row.i} 手目）の局面が問の局面と違います`);
      if (!row.confirm) throw new Error(`${want.id}: 調査の行に二段目（confirm）がありません`);
      found.add(key);
      const out = join(OUT, `${want.id}.json`);
      if (existsSync(out) && !force && !check) {
        skipped++;
        continue;
      }
      const p = problem.player;
      if (actingPlayer(problem.state) !== p) throw new Error(`${want.id}: 問の局面の手番が問の player と違います`);
      const confirm = row.confirm;
      const pick = (k: number, kind: LineOut["kind"], label: string, second: string): LineOut => {
        const plan = row.plans![k];
        if (!plan) throw new Error(`${want.id}: 候補 ${k} がありません`);
        // steps を打つ
        let s = problem.state;
        for (const [j, a] of plan.steps.entries()) {
          const next = tryApplyAction(s, a);
          if (!next) throw new Error(`${want.id}: ${label}の ${j + 1} 手目（${plan.text[j] ?? ""}）が問の局面から打てません`);
          s = next;
        }
        const actions = [...plan.steps];
        const prefixOk = plan.text.every((t, j) => plan.full[j] === t);
        let rethink: number | null = null;
        let missed = "";
        if (!turnOver(s, p)) {
          const rest = prefixOk ? plan.full.slice(plan.steps.length) : [];
          const m = matchTexts(s, rest, p);
          actions.push(...m.actions);
          s = m.end;
          const end = m.actions.length === rest.length ? tryApplyAction(s, { type: "endTurn" }) : null;
          if (end) {
            actions.push({ type: "endTurn" });
            s = end;
          } else {
            // 読んだ並びを打ちきれない: そこから先は AI に考え直させる
            missed = rest[m.actions.length] ?? "";
            rethink = actions.length;
            const rng = rngFrom({ rng: seedOf([fnv(want.id), kind === "ai" ? 0 : 1]) });
            const agent = agentOf(problem.agent);
            for (let n = 0; !turnOver(s, p); n++) {
              if (n >= 60) throw new Error(`${want.id}: ${label}を考え直すと、60 手打ってもターンが終わりません`);
              const a = agent.chooseAction(s, legalActions(s), rng);
              actions.push(a);
              s = applyAction(s, a);
            }
          }
        }
        const w = row.w?.[k] ?? "";
        console.log(
          `${want.id} ${kind}: steps ${plan.steps.length}、full ${plan.full.length} → 手 ${actions.length}${rethink === null ? "" : `（${rethink + 1} 手目から考え直した。読みの「${missed}」が打てない）`}`,
        );
        return { kind, label, steps: plan.steps, text: plan.text, full: plan.full, actions, rethink, first: tally(w), second: tally(second) };
      };
      const body = {
        v: 2,
        id: want.id,
        source: `${shown} の試合 ${row.g} の ${row.i} 手目`,
        lines: [pick(row.ai, "ai", "問を作ったときの AI の手", confirm.ai), pick(confirm.c, "good", "打ち比べで良い手", confirm.alt)],
      };
      if (check) continue;
      writeFileSync(out, format(body));
      written++;
    }
  }
  const missing = [...wanted].filter(([k]) => !found.has(k)).map(([, v]) => v.id);
  if (!check) console.log(`書いた ${written}、既にあるので飛ばした ${skipped}（--force で書き直す）`);
  if (missing.length > 0) console.log(`調査の行が見つからない問 ${missing.length}: ${missing.join(", ")}`);
  return 0;
}
