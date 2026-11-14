// 試合の記録の検討（段階 4。docs/match-record.md「検討」）: 勝敗まで入れて保存したプロの試合の記録で、プロの手番ごとに、
// プロの並びと今の AI の並びを打ち比べる。開発のコマンドだけ（公開サイトにも、開発サーバーの画面にも出さない）。
//
//   npm run review -- <記録.json> [--out <フォルダ>] [--m 32] [--confirm 96] [--flag 10] [--seat 0|1] [--all 1] [--opts '<JSON>'] [--batch 4]
//
// 1. 記録を確かめる（src/record/review.ts。勝敗があること、各ターンの最初の局面があること、デッキがプロのデッキでプールのカードだけ）
// 2. ターンごとに、保存した最初の局面から、そのターンの手順を当てた局面を作る（<フォルダ>/points.jsonl）
// 3. 打ち比べる（svwb review run。rust/engine/src/runner/review.rs）→ <フォルダ>/review.jsonl
// 4. 報告を書く（svwb review report）→ <フォルダ>/report.md
//
// 既定の設定は、今の補正を 84 個全部のデッキの範囲に広げて、新しいカードの行を属性で埋めたもの（PR #250 の「属性で埋めた補正」）。
// 無ければ .cache/review/ に作る（npm run td -- extend と attr。数秒）。--opts で替えられるが、道具の確かめの間は既定だけで回す。
// <フォルダ> の既定は reviews/<記録の名前>/（コミットしない）。同じ引数で回し直すと、済んだターンは飛ばす。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseRecord, RecordError } from "../src/record/record";
import { pointsFile, turnPoints } from "../src/record/review";

/** 属性で埋めた補正（台帳の「新しいプール-属性で埋めた補正」の a と同じもの）の指紋 */
const FILLED_FINGERPRINT = "aa2d1cc1";
const FILLED_PATH = ".cache/review/value-net-attr-all84.json";

const RUN_FLAGS = ["m", "confirm", "flag", "seat", "all", "opts", "batch"];

/** FNV-1a（32 ビット）。台帳のファイルの指紋（rust/engine/src/canonical.rs の fnv）と同じ */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const run = (args: string[]) => execFileSync(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });

/** 属性で埋めた補正のファイル（無ければ作る）と、その指紋 */
function filledModel(): { path: string; fingerprint: string } {
  if (!existsSync(FILLED_PATH)) {
    mkdirSync(".cache/review", { recursive: true });
    const tmp = ".cache/review/value-net-all84.json";
    console.log("属性で埋めた補正を作ります（npm run td -- extend・attr）");
    run(["scripts/vite-run.mjs", "scripts/td-main.ts", "extend", "--model", "data/value-net.json", "--vocab", "@data/pools/azvaldt/sets/all84.txt", "--out", tmp]);
    run(["scripts/vite-run.mjs", "scripts/td-main.ts", "attr", "--model", tmp, "--out", FILLED_PATH, "--keepA", "0"]);
  }
  const fingerprint = fnv1a(readFileSync(FILLED_PATH));
  if (fingerprint !== FILLED_FINGERPRINT) {
    console.warn(`注意: ${FILLED_PATH} の指紋 ${fingerprint} が、台帳の属性で埋めた補正（${FILLED_FINGERPRINT}）と違います（data/value-net.json が変わった等）。報告にはこの指紋を書きます`);
  }
  return { path: FILLED_PATH, fingerprint };
}

function parseArgs(argv: string[]): { record: string; out: string | null; flags: Map<string, string> } {
  let record: string | null = null;
  let out: string | null = null;
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} の値がありません`);
      i++;
      if (k === "out") out = v;
      else if (RUN_FLAGS.includes(k)) flags.set(k, v);
      else throw new Error(`不明な引数: ${a}`);
    } else if (record === null) record = a;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (record === null) throw new Error("使い方: npm run review -- <記録.json> [--out <フォルダ>] [--m 32] [--confirm 96] [--flag 10] [--seat 0|1] [--all 1] [--opts '<JSON>']");
  return { record, out, flags };
}

export async function main(argv: string[]): Promise<number> {
  const { record: path, out: outArg, flags } = parseArgs(argv);
  const name = basename(path).replace(/\.json$/, "");
  let points: string;
  try {
    const record = parseRecord(readFileSync(path, "utf8"));
    const turns = turnPoints(record);
    const bad = turns.filter((t) => t.trace !== null);
    console.log(`${name}: ${turns.length} ターン（今のエンジンでたどれないターン ${bad.length}${bad.map((t) => `。ターン ${t.turn + 1}: ${t.trace}`).join("")}）`);
    points = pointsFile(record, basename(path), turns);
  } catch (e) {
    if (e instanceof RecordError) {
      console.error(`検討しません: ${e.message}`);
      return 1;
    }
    throw e;
  }
  const out = resolve(outArg ?? join("reviews", name));
  mkdirSync(out, { recursive: true });
  const pointsPath = join(out, "points.jsonl");
  writeFileSync(pointsPath, points);
  if (!flags.has("opts")) flags.set("opts", JSON.stringify({ valueNet: filledModel().path }));
  const result = join(out, "review.jsonl");
  const pass = [...flags].flatMap(([k, v]) => [`--${k}`, v]);
  run(["scripts/svwb.mjs", "review", "run", "--record", resolve(path), "--points", pointsPath, "--out", result, ...pass]);
  run(["scripts/svwb.mjs", "review", "report", result, "--out", join(out, "report.md")]);
  return 0;
}
