// キュー: ジョブを並べたファイルを上から順に、5〜10 分の区切りに分けて回す（npm run queue）。運用は docs/queue.md。
//
//   npm run queue -- plan <ジョブのファイル> [--threads N] [--machine 名前] [--chunk-min 7.5] [--tz Asia/Tokyo] [--at 23:00] [--name 名前] [--until 07:00]
//   回す係は pueue（docs/queue.md「キュー（pueue）」。2026-11-23 から）。コンテナの中で（ホストからは docker/remote-control/queue.sh）:
//   npm run queue -- add <券|回の名前>
//   npm run queue -- start [--until 07:00|+2h]
//   npm run queue -- pause [--wait]
//   npm run queue -- status [名前]
//   npm run queue -- remove <回の名前>
//   npm run queue -- wrap [名前|--pending]
//   npm run queue -- list
//   スレッドで:
//   npm run queue -- ingest <回の名前|ファイル…> [--ledger 台帳] [--to /mnt/project-files]
//   （pueue の task が流すもの: enqueue・prepare・chunk・wrap）
//
// - ジョブのファイルは 1 行 1 ジョブで、svwb のコマンドと同じ形（compare・yardstick・profile・misses・survey）。# から行の終わりまでは書き添え
// - 学び直しの流れ（docs/queue.md「学び直しの流れ」）: td selfplay・td branch・beam-gap（--chunk 試合ずつ {k} を入れたファイルに書く）、
//   td・potential（TypeScript の学習。--out のファイルを 1 つ作る）、pick（前の compare の結果で、決めておいた線を越えたかでファイルを選ぶ）。
//   @/ は回のフォルダ、{1..20} は 1,2,…,20 に開く。作ったファイルがあれば済んだものとし、前のジョブの作るファイルが無ければ失敗にする。
//   @run:<回の名前>/<ファイル> は、同じ根の下の前の回のフォルダのファイル（前の回で作ったモデルを読む。PC の中の道をジョブのファイルに書かない）。
//   組み立てのときにあるかを確かめ、無ければ回さない
// - 回は ~/svwb-data/night/<名前>/ に置く（環境変数 SVWB_NIGHT_DIR か --root で替えられる）。区切りが済むたびに印を書き、
//   やり直したときは済んだ区切りを飛ばす。電源が切れても、失うのは回していた区切りだけ
// - plan が計画の表と積む券（svwb-queue-1。ブランチ・コミット・ジョブのファイル・計画の指紋の 1 行。止める時刻は持たない）を出す。
//   ユーザーがホストで docker/remote-control/queue.sh add <券> を流すと（いつでもよい）、券のコミットを回のフォルダの src/ に出し、そこの enqueue が
//   組み立て・区切りごと・まとめの task を pueue の組 svwb（同時に 1 つ）に積む（scripts/night-pueue.ts）。積んだだけでは回らない。
//   回すのはユーザーが決めたときの start（--until を付ければ、その時刻に組を一時停止する task を組 svwb-ctl に置く）、止めるのは pause（回している区切りは凍らせる）。
//   どこまで済んだかは回のフォルダの印（done/）で決め、pueue は流すだけ（pueue の状態が消えても、add <回の名前> で続きから積み直せる）
// - 区切りの結果は回のフォルダの台帳（ledger.jsonl）にだけ書く。回の最後の task（まとめ）と queue-push.sh の wrap --pending が、
//   ジョブごとに 1 行にまとめた行をブランチ night/<回の名前> にコミットし（作業ツリーには触らない）、棋譜などを出口（~/svwb-data/outbox/<回の名前>/）にまとめる。
//   ユーザーはホストで push だけ（docker/remote-control/queue-push.sh）。スレッドは ingest <回の名前> で台帳に足す

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { DEFAULT_LEDGER, canonical, markdownTable, parseLedger, type MissesRow, type RunRow, type SurveyRow } from "./ledger-main.ts";
import { OUTBOX_JSON, extractOutbox, guideHead, peekOutbox, writeOutbox, type OutboxHead } from "./night-outbox.ts";
import { formatBytes } from "./pack-run-main.ts";
import { CTL_GROUP, QUEUE_GROUP, STOP_LABEL, addTask, ensureGroups, isLive, labelOf, pq, pueueBin, pueueStatus, taskLabel, type PStatus, type PTask } from "./night-pueue.ts";

/** リポジトリの根 */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- ジョブのファイル

/** 物差しの相手（svwb yardstick --ref。rust/engine/src/runner/yardstick.rs） */
export const YARDSTICK_REFS = ["classic", "strong", "pool-v0", "pool-r3"] as const;
export type YardstickRef = (typeof YARDSTICK_REFS)[number];
const isYardstickRef = (x: string): x is YardstickRef => (YARDSTICK_REFS as readonly string[]).includes(x);

export type JobSpec =
  | { kind: "compare"; a: string; b: string; vs: string | null; noMirror: boolean; decks: string | null; with: string | null; without: string | null }
  | { kind: "yardstick"; ref: YardstickRef; opts: string }
  | { kind: "profile"; opts: string; rhino: boolean; decks: string | null; noMemo?: true; noJemalloc?: true }
  /** 見落とし問題集（docs/misses.md）。games は 1 問を打つ回数（--trials） */
  | { kind: "misses"; opts: string; seed: number }
  /** 候補の打ち比べ調査（docs/survey.md）。games は自己対戦の試合の数（1 つの番号で 1 試合）。opts は AI の設定（--opts）、decks は --decks */
  | {
      kind: "survey";
      rate: number;
      m: number;
      extra: number;
      confirm: number;
      flag: number;
      batch: number;
      opts: string;
      decks: string | null;
      /** マリガンの打ち比べ（svwb survey run --mulligan 1。docs/survey.md「マリガンの打ち比べ」）。null ならターンの打ち比べ */
      mulligan: { narrow: number; narrowTop: number; reseed: number } | null;
    }
  /** データを作る svwb（td selfplay・td branch・beam-gap）。chunk 試合ずつ、out（{k} に区切りの番号を入れる）に書く。out が .gz なら書いた後に gzip する。
   * args はそのほかの引数（そのまま渡す。{k} は区切りの番号にする） */
  | { kind: "data"; cmd: string[]; startFlag: "--start" | "--from"; outFlag: "--out" | "--inputs"; out: string; chunk: number; args: string[] }
  /** 学習（npm run td・npm run potential）。out を 1 つ作る。args は --out も含めた全部。
   * impl が rust なら、td train・td prune を Rust 版（svwb td train・prune。rust/engine/src/runner/td_train.rs）で回す。
   * td train・td prune の既定は rust（2026-11-15 から。行に --impl ts なら TypeScript 版）、ほかは ts。
   * extra は out のほかに作るファイル（td train の --epochOut のエポックごとの重み。svwb が直に書き、out は最後にできる） */
  | { kind: "node"; tool: "td" | "potential"; args: string[]; out: string; impl: "ts" | "rust"; extra: string[] }
  /** 前の compare（台帳の名前 from）の A の勝率 − 50% が 2 SE を越えたら pass、越えなければ fail のファイルを out に写す */
  | { kind: "pick"; from: string; pass: string; fail: string; out: string };

export interface Job {
  /** ファイルの中のジョブの番号（1 から） */
  index: number;
  /** ファイルの行（書き添えを除く） */
  line: string;
  /** 台帳の名前（--label）。profile は空でもよい */
  label: string;
  /** 試合番号の数（1 つの番号で席とデッキを入れ替えて 2 試合。survey は 1 試合）と、最初の番号。misses は 1 問を打つ回数と 0 */
  games: number;
  start: number;
  /** --est: 1 試合の見込みの秒（回すマシン・並列数で。キューだけが読む）。td・potential は全体の秒 */
  est: number | null;
  spec: JobSpec;
}

/** シェルと同じ形で語に分ける（'…' はそのまま、"…" は \" と \\ だけ解く。語の頭の # から後ろは書き添え） */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new Error("' が閉じていません");
      cur += line.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (c === '"') {
      has = true;
      i++;
      for (;;) {
        if (i >= line.length) throw new Error('" が閉じていません');
        const d = line[i] ?? "";
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
          cur += line[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new Error("行の終わりに \\ があります");
      cur += line[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (c === "#" && !has) {
      break;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** シェルにそのまま貼れる形に並べる（rust/engine/src/runner/ledger.rs の shell_line と同じ。台帳の cmd と比べる） */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (a !== "" && /^[A-Za-z0-9_./,:=+\-@%]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function intOf(s: string, what: string, min: number): number {
  if (!/^\d+$/.test(s) || Number(s) < min) throw new Error(`${what} は ${min} 以上の整数: ${s}`);
  return Number(s);
}

function jsonObject(s: string, what: string): string {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new Error(`${what} が JSON として読めません: ${s}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} は JSON のオブジェクト: ${s}`);
  return s;
}

/** ジョブの 1 行を読む（行の頭の svwb は飛ばす） */
export function parseJob(line: string, index: number): Job {
  let words = shellWords(line);
  if (words[0] === "svwb") words = words.slice(1);
  const kind = words[0];
  const rest = words.slice(1);
  const take = (name: string): string | null => {
    const i = rest.indexOf(name);
    if (i < 0) return null;
    const v = rest[i + 1];
    if (v === undefined) throw new Error(`${name} の値がありません`);
    rest.splice(i, 2);
    if (rest.includes(name)) throw new Error(`${name} が 2 回あります`);
    return v;
  };
  const flag = (name: string): boolean => {
    const i = rest.indexOf(name);
    if (i < 0) return false;
    rest.splice(i, 1);
    return true;
  };
  const refuse = (names: string[], why: string) => {
    for (const n of names) if (rest.includes(n)) throw new Error(`キューでは ${n} は使えません（${why}）`);
  };
  const estText = take("--est");
  const est = estText === null ? null : Number(estText);
  if (est !== null && !(est > 0)) throw new Error(`--est は見込みの秒（正の数）: ${estText}`);
  const noUnknown = () => {
    const bad = rest.filter((x) => x.startsWith("--"));
    if (bad.length > 0) throw new Error(`知らない引数: ${bad.join(" ")}`);
  };
  const text = line.trim();
  switch (kind) {
    case "compare": {
      refuse(["--no-ledger"], "結果は台帳から集める");
      refuse(["--kifu", "--replays", "--no-kifu"], "棋譜はキューが回のフォルダの kifu/ に書く");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます（区切りの結果を後で足し合わせるため）");
      const noMirror = flag("--no-mirror");
      const decks = take("--decks");
      const withDeck = take("--with");
      const withoutDeck = take("--without");
      if (withDeck !== null && withoutDeck !== null) throw new Error("--with と --without は一緒に使えません");
      noUnknown();
      const [g, a = "{}", b = "{}", s = "0", vs, ...extra] = rest;
      if (g === undefined) throw new Error("compare の試合数（1 つ目の引数）がありません");
      if (extra.length > 0) throw new Error(`多すぎる引数: ${extra.join(" ")}`);
      return {
        index,
        line: text,
        label,
        games: intOf(g, "試合数", 1),
        start: intOf(s, "最初の試合番号", 0),
        est,
        spec: { kind, a: jsonObject(a, "A の設定"), b: jsonObject(b, "B の設定"), vs: vs === undefined || vs === "" ? null : vs, noMirror, decks, with: withDeck, without: withoutDeck },
      };
    }
    case "yardstick": {
      refuse(["--no-ledger"], "結果は台帳から集める");
      refuse(["--record"], "物差しの表に足すのは、終わった後に足し合わせた数字で");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます（区切りの結果を後で足し合わせるため）");
      const ref = take("--ref") ?? "classic";
      if (!isYardstickRef(ref)) throw new Error(`--ref は ${YARDSTICK_REFS.join("・")} のどれか: ${ref}`);
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const games = intOf(take("--games") ?? "1000", "--games", 1);
      const start = intOf(take("--start") ?? "0", "--start", 0);
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games, start, est, spec: { kind, ref, opts } };
    }
    case "profile": {
      refuse(["--json", "--report"], "キューが回のフォルダに書く");
      refuse(["--baseline", "--record"], "終わった後に手で");
      const label = take("--label") ?? "";
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const games = intOf(take("--games") ?? "49", "--games", 1);
      const start = intOf(take("--start") ?? "0", "--start", 0);
      const rhino = flag("--rhino");
      // 補正の最後の隠れ層を使い回さない（使い回しの効きを同じコミットで測る。docs/value-net.md「最後の隠れ層の使い回し」）
      const noMemo = flag("--no-memo");
      // メモリの確保を jemalloc にしない（SVWB_PRELOAD があっても差し込まない。svwbEnv。効きを同じ回で比べる）。svwb には渡さない
      const noJemalloc = flag("--no-jemalloc");
      const decks = take("--decks");
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return {
        index,
        line: text,
        label,
        games,
        start,
        est,
        spec: { kind, opts, rhino, decks, ...(noMemo ? { noMemo: true as const } : {}), ...(noJemalloc ? { noJemalloc: true as const } : {}) },
      };
    }
    case "misses": {
      // 行の頭の run は書いても書かなくてもよい
      if (rest[0] === "run") rest.splice(0, 1);
      refuse(["--no-ledger"], "結果は台帳から集める");
      refuse(["--only", "--dir", "--out"], "問題集全体を、決まった場所で解く");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます");
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const games = intOf(take("--trials") ?? "24", "--trials", 1);
      const seed = intOf(take("--seed") ?? "1", "--seed", 0);
      take("--lines");
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games, start: 0, est, spec: { kind, opts, seed } };
    }
    case "survey": {
      // 行の頭の run は書いても書かなくてもよい。試合は --games a-b（svwb survey run と同じ）か --games N [--start S]
      if (rest[0] === "run") rest.splice(0, 1);
      refuse(["--out"], "キューが回のフォルダに書く");
      const label = take("--label");
      if (!label) throw new Error("--label で台帳の名前を付けます（まとめが survey report でこの名前の行を 1 つ足す）");
      const gamesText = take("--games");
      if (gamesText === null) throw new Error("survey は --games a-b で試合番号の範囲を渡します");
      const startText = take("--start");
      let games: number;
      let start: number;
      const range = /^(\d+)-(\d+)$/.exec(gamesText);
      if (range) {
        if (startText !== null) throw new Error("--games a-b と --start は一緒に使えません");
        start = Number(range[1]);
        games = Number(range[2]) - start + 1;
        if (games < 1) throw new Error(`--games は a ≤ b: ${gamesText}`);
      } else {
        games = intOf(gamesText, "--games", 1);
        start = intOf(startText ?? "0", "--start", 0);
      }
      const num = (name: string, def: number, ok: (x: number) => boolean, what: string): number => {
        const t = take(name);
        if (t === null) return def;
        const x = Number(t);
        if (t.trim() === "" || !Number.isFinite(x) || !ok(x)) throw new Error(`${name} は ${what}: ${t}`);
        return x;
      };
      const mulText = take("--mulligan");
      if (mulText !== null && mulText !== "0" && mulText !== "1") throw new Error(`--mulligan は 0 か 1: ${mulText}`);
      const isMul = mulText === "1";
      const rate = num("--rate", 0.1, (x) => x > 0 && x <= 1, "0 より大きく 1 以下");
      const m = num("--m", isMul ? 16 : 32, (x) => Number.isInteger(x) && x >= 2, "2 以上の整数");
      const extra = num("--extra", 4, (x) => Number.isInteger(x) && x >= 0, "0 以上の整数");
      const confirm = num("--confirm", 96, (x) => Number.isInteger(x) && x >= 0, "0 以上の整数");
      const flagPts = num("--flag", isMul ? 0 : 10, (x) => x >= 0, "0 以上の数");
      if (!isMul && ["--narrow", "--narrow-top", "--reseed"].some((a) => rest.includes(a))) {
        throw new Error("--narrow・--narrow-top・--reseed は --mulligan 1 のときだけ");
      }
      const intOr = (name: string, def: number): number => num(name, def, (x) => Number.isInteger(x) && x >= 0, "0 以上の整数");
      const narrow = intOr("--narrow", 32);
      const narrowTop = intOr("--narrow-top", 2);
      const reseed = intOr("--reseed", 8);
      const batch = num("--batch", 8, (x) => Number.isInteger(x) && x >= 1, "1 以上の整数");
      const opts = jsonObject(take("--opts") ?? "{}", "--opts");
      const decks = take("--decks");
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return {
        index,
        line: text,
        label,
        games,
        start,
        est,
        spec: { kind, rate, m, extra, confirm, flag: flagPts, batch, opts, decks, mulligan: isMul ? { narrow, narrowTop, reseed } : null },
      };
    }
    case "beam-gap":
    case "td":
    case "potential": {
      for (let i = 0; i < rest.length; i++) rest[i] = expandBraces(rest[i] ?? "");
      if (kind === "beam-gap" || rest[0] === "selfplay" || rest[0] === "branch") {
        // データを作る svwb。区切りの大きさは --chunk で決める（後のジョブがファイルの名前で読むので、時間では決めない）。
        // td branch（選ばなかった候補の枝）は、--from の棋譜の試合番号 [--start, --start + --games) を区切って回す
        const selfplay = kind === "td";
        const sub = selfplay ? rest.splice(0, 1)[0]! : "";
        const startFlag = selfplay ? "--start" : "--from";
        const outFlag = selfplay ? "--out" : "--inputs";
        refuse(["--positions", "--refFrom"], "キューではデータを作るときだけ");
        refuse(["--kifu", "--replays", "--no-kifu"], "棋譜はキューが回のフォルダの kifu/ に書く");
        const label = take("--label") ?? "";
        const gamesText = take("--games");
        if (gamesText === null) throw new Error("--games で試合数を書きます");
        const games = intOf(gamesText, "--games", 1);
        const start = intOf(take(startFlag) ?? "0", startFlag, 0);
        const chunkText = take("--chunk");
        if (chunkText === null) throw new Error("--chunk で 1 つのファイルの試合数を書きます");
        const chunk = intOf(chunkText, "--chunk", 1);
        const out = take(outFlag);
        if (out === null || !out.includes("{k}")) throw new Error(`${outFlag} は {k}（区切りの番号）を入れたファイル（例: @/s-{k}.jsonl.gz）`);
        if (est === null) throw new Error("--est で 1 試合の見込みの秒（回すマシン・並列数で）を書きます");
        const cmd = selfplay ? ["td", sub] : ["beam-gap"];
        return { index, line: text, label, games, start, est, spec: { kind: "data", cmd, startFlag, outFlag, out, chunk, args: [...rest] } };
      }
      const tool = kind === "potential" ? "potential" : "td";
      const label = take("--label") ?? "";
      const implFlag = take("--impl");
      const sub = rest[0];
      if (sub === undefined || sub.startsWith("--")) throw new Error(`${tool} のコマンド（train 等）がありません`);
      // td train・td prune は Rust 版が既定（B の 6 万試合で TypeScript 版と同じモデルになるのを確かめた、2026-11-15）
      const rustable = tool === "td" && (sub === "train" || sub === "prune");
      const implText = implFlag ?? (rustable ? "rust" : "ts");
      if (implText !== "ts" && implText !== "rust") throw new Error(`--impl は ts か rust: ${implText}`);
      if (implText === "rust" && !rustable) throw new Error("--impl rust は td train・td prune だけ");
      const i = rest.indexOf("--out");
      const out = i < 0 ? undefined : rest[i + 1];
      if (out === undefined) throw new Error("--out で作るファイルを書きます（そのファイルがあれば済んだものとする）");
      if (rest.indexOf("--out", i + 1) >= 0) throw new Error("--out が 2 回あります");
      if (est === null) throw new Error("--est で全体の見込みの秒（回すマシンで）を書きます");
      // td train --epochOut @/m-e{e}.json: エポックごとの重みも作る（--epochs の数だけ。R7 の候補、2026-11-25）
      const extra: string[] = [];
      const ei = rest.indexOf("--epochOut");
      if (ei >= 0) {
        const pat = rest[ei + 1];
        if (!(tool === "td" && sub === "train" && implText === "rust")) throw new Error("--epochOut は Rust 版の td train だけ");
        if (pat === undefined || !pat.startsWith("@/") || !pat.includes("{e}")) throw new Error("--epochOut は {e}（エポックの番号）を入れた回のフォルダのファイル（例: @/m-e{e}.json）");
        const n = Number(rest[rest.indexOf("--epochs") + 1]);
        if (rest.indexOf("--epochs") < 0 || !Number.isInteger(n) || n < 1) throw new Error("--epochOut には --epochs（1 以上の整数）を書きます");
        for (let e = 1; e <= n; e++) extra.push(pat.split("{e}").join(String(e)));
      }
      return { index, line: text, label, games: 1, start: 0, est, spec: { kind: "node", tool, args: [...rest], out, impl: implText, extra } };
    }
    case "pick": {
      const label = take("--label") ?? "";
      const from = take("--compare");
      const pass = take("--pass");
      const fail = take("--fail");
      const out = take("--out");
      if (from === null || pass === null || fail === null || out === null) {
        throw new Error("pick は --compare <前の compare の台帳の名前> --pass <越えたときのファイル> --fail <越えないときのファイル> --out <写す先>");
      }
      noUnknown();
      if (rest.length > 0) throw new Error(`知らない引数: ${rest.join(" ")}`);
      return { index, line: text, label, games: 1, start: 0, est: est ?? 1, spec: { kind: "pick", from, pass, fail, out } };
    }
    default:
      throw new Error(`ジョブは compare・yardstick・profile・misses・survey・td・beam-gap・potential・pick のどれか: ${kind ?? "（空）"}`);
  }
}

/** 語の中の {a..b} を a,a+1,…,b のカンマ区切りに開く（--data に並べる用。カンマで区切った 1 つに 1 つまで） */
export function expandBraces(word: string): string {
  return word
    .split(",")
    .map((part) => {
      const m = /^(.*)\{(\d+)\.\.(\d+)\}(.*)$/.exec(part);
      if (!m) return part;
      const lo = Number(m[2]);
      const hi = Number(m[3]);
      if (hi < lo) throw new Error(`{a..b} は a ≤ b: ${part}`);
      return Array.from({ length: hi - lo + 1 }, (_, i) => `${m[1]}${lo + i}${m[4]}`).join(",");
    })
    .join(",");
}

/** データを作るジョブの区切りの大きさ（chunkJob と同じく、大きさをそろえる） */
function dataChunkSize(job: Job, chunk: number): number {
  return Math.ceil(job.games / Math.ceil(job.games / chunk));
}

/** ジョブが作る回のフォルダのファイル（@/ の形。データを作るジョブは区切りの番号の順） */
export function jobProducts(job: Job): string[] {
  const s = job.spec;
  if (s.kind === "data") {
    const n = Math.ceil(job.games / dataChunkSize(job, s.chunk));
    return Array.from({ length: n }, (_, i) => s.out.split("{k}").join(String(i + 1)));
  }
  return s.kind === "node" ? [s.out, ...s.extra] : s.kind === "pick" ? [s.out] : [];
}

/** ジョブが読む回のフォルダのファイル（@/ の形。設定の JSON の中も見る） */
export function jobInputs(job: Job): string[] {
  const s = job.spec;
  const words =
    s.kind === "compare"
      ? [s.a, s.b]
      : s.kind === "yardstick" || s.kind === "profile" || s.kind === "misses" || s.kind === "survey"
        ? [s.opts]
        : s.kind === "data"
          ? s.args.filter((a) => !a.includes("{k}"))
          : s.kind === "node"
            ? s.args.filter((_, i) => s.args[i - 1] !== "--out" && s.args[i - 1] !== "--epochOut")
            : s.kind === "pick"
              ? [s.pass, s.fail]
              : [];
  return [...new Set(words.flatMap((w) => w.match(/@\/[^\s",]+/g) ?? []))];
}

/** @/ を回のフォルダに、@run:<回の名前>/ を同じ根の下のその回のフォルダにする */
export const atDir = (word: string, dir: string): string => word.split("@/").join(`${dir}/`).split("@run:").join(`${dirname(dir)}/`);

/** ジョブが読む前の回のファイル（@run:<回の名前>/<ファイル> の形のまま。{a..b} は開く） */
export function jobRunRefs(job: Job): string[] {
  return [...new Set((job.line.match(/@run:[^\s"',]+/g) ?? []).flatMap((ref) => expandBraces(ref).split(",")))];
}

/** @run: の書き方を確かめる（回の名前は英数字と . _ -、ファイルは回のフォルダの中） */
function checkRunRef(ref: string): void {
  const m = /^@run:([A-Za-z0-9._-]+)\/(.+)$/.exec(ref);
  if (m === null || m[1] === "." || m[1] === ".." || m[2]!.split("/").some((x) => x === "" || x === "." || x === "..")) {
    throw new Error(`前の回のファイルは @run:<回の名前>/<回のフォルダの中のファイル> と書きます: ${ref}`);
  }
}

/** 前の回のファイル（@run:）が根の下にあるかを確かめる（組み立てのとき） */
export function checkRunRefs(jobs: Job[], root: string): void {
  for (const job of jobs) {
    for (const ref of jobRunRefs(job)) {
      const file = atDir(ref, join(root, "-"));
      if (!existsSync(file)) throw new Error(`ジョブ ${job.index}: 前の回のファイル ${ref} がありません（${file}）`);
    }
  }
}

/** ジョブのファイルを読む（空の行と # で始まる行は飛ばす） */
export function parseJobs(text: string): Job[] {
  const jobs: Job[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    try {
      jobs.push(parseJob(line, jobs.length + 1));
    } catch (e) {
      throw new Error(`${i + 1} 行目: ${(e as Error).message}`);
    }
  });
  if (jobs.length === 0) throw new Error("ジョブがありません");
  // 回のフォルダのファイル（@/）は、前のジョブが作るものだけを読む（書き間違いを回す前に見つける）
  const made = new Set<string>();
  for (const job of jobs) {
    for (const ref of jobRunRefs(job)) checkRunRef(ref);
    for (const f of jobInputs(job)) if (!made.has(f)) throw new Error(`ジョブ ${job.index}（${job.line.slice(0, 40)}…）: ${f} を作るジョブが前にありません`);
    const s = job.spec;
    if (s.kind === "pick" && jobs.filter((j) => j.index < job.index && j.spec.kind === "compare" && j.label === s.from).length !== 1) {
      throw new Error(`ジョブ ${job.index}: 前に台帳の名前 ${s.from} の compare が 1 つだけあるようにします`);
    }
    for (const f of jobProducts(job)) {
      if (made.has(f)) throw new Error(`ジョブ ${job.index}: ${f} を作るジョブが 2 つあります`);
      made.add(f);
    }
    // 自己対戦は棋譜を回のフォルダの kifu/ に書く（キューの既定）。後の td branch が --from @/kifu で読める（いくつの自己対戦が書いてもよい）
    if (s.kind === "data" && s.cmd.join(" ") === "td selfplay") made.add("@/kifu");
  }
  return jobs;
}

/** データを作るジョブの、試合番号 first からの区切りが書くファイル（回のフォルダの道）と、svwb が書く途中のファイル */
export function dataProduct(job: Job, first: number, dir: string): { file: string; tmp: string; k: number } {
  const s = job.spec;
  if (s.kind !== "data") throw new Error("データを作るジョブではありません");
  const k = Math.floor((first - job.start) / dataChunkSize(job, s.chunk)) + 1;
  const file = atDir(s.out.split("{k}").join(String(k)), dir);
  return { file, tmp: file.endsWith(".gz") ? `${file.slice(0, -3)}.tmp` : `${file}.tmp`, k };
}

/** 試合番号 first から count 個を回す svwb の引数（dir は回のフォルダ。@/ をここにする）。td・potential は npm run td 等の引数 */
export function jobArgv(job: Job, first: number, count: number, dir: string): string[] {
  return jobArgvRaw(job, first, count, dir).map((a) => atDir(a, dir));
}

function jobArgvRaw(job: Job, first: number, count: number, dir: string): string[] {
  const s = job.spec;
  switch (s.kind) {
    case "data": {
      const { tmp, k } = dataProduct(job, first, dir);
      return [...s.cmd, "--games", String(count), s.startFlag, String(first), ...s.args.map((a) => a.split("{k}").join(String(k))), s.outFlag, tmp];
    }
    case "node":
      return [s.tool, ...s.args.map((a, i) => (s.args[i - 1] === "--out" ? `${a}.tmp` : a))];
    case "pick":
      return ["pick", "--compare", s.from, "--pass", s.pass, "--fail", s.fail, "--out", s.out];
    case "compare":
      return [
        "compare",
        String(count),
        s.a,
        s.b,
        String(first),
        ...(s.vs === null ? [] : [s.vs]),
        ...(s.noMirror ? ["--no-mirror"] : []),
        ...(s.decks === null ? [] : ["--decks", s.decks]),
        ...(s.with === null ? [] : ["--with", s.with]),
        ...(s.without === null ? [] : ["--without", s.without]),
        "--label",
        job.label,
      ];
    case "yardstick":
      return ["yardstick", "--ref", s.ref, "--opts", s.opts, "--games", String(count), "--start", String(first), "--label", job.label];
    case "profile":
      return [
        "profile",
        "--opts",
        s.opts,
        "--games",
        String(count),
        "--start",
        String(first),
        ...(s.rhino ? ["--rhino"] : []),
        ...(s.noMemo ? ["--no-memo"] : []),
        ...(s.decks === null ? [] : ["--decks", s.decks]),
        "--json",
        join(dir, `speed-${job.index}.json`),
        "--report",
        join(dir, `speed-${job.index}.md`),
      ];
    case "misses":
      return ["misses", "run", "--opts", s.opts, "--trials", String(count), "--seed", String(s.seed), "--label", job.label];
    case "survey":
      // 出力はジョブで 1 つ（svwb survey run は出力に既にある試合を飛ばすので、止めた区切りは回し直せば続きから）
      return [
        "survey",
        "run",
        "--out",
        surveyFile(dir, job),
        "--games",
        `${first}-${first + count - 1}`,
        ...(s.mulligan === null
          ? ["--rate", String(s.rate)]
          : ["--mulligan", "1", "--narrow", String(s.mulligan.narrow), "--narrow-top", String(s.mulligan.narrowTop), "--reseed", String(s.mulligan.reseed)]),
        "--m",
        String(s.m),
        ...(s.mulligan === null ? ["--extra", String(s.extra)] : []),
        "--confirm",
        String(s.confirm),
        "--flag",
        String(s.flag),
        "--batch",
        String(s.batch),
        ...(s.opts === "{}" ? [] : ["--opts", s.opts]),
        ...(s.decks === null ? [] : ["--decks", s.decks]),
      ];
  }
}

/** survey のジョブの出力（回のフォルダの中） */
export function surveyFile(dir: string, job: Job): string {
  return join(dir, `survey-${job.index}.jsonl`);
}

/** count（区切りの大きさ）が何試合か。misses は「全部の問を 1 回ずつ」を 1 と数える（見込みの 1 試合の秒も、その 1 回の秒）。
 * survey は 1 つの番号で 1 試合（見込みの 1 試合の秒は、その試合から取った局面の打ち比べを含む） */
export function unitsOf(job: Job, count: number): number {
  return job.spec.kind === "compare" || job.spec.kind === "yardstick" || job.spec.kind === "profile" ? 2 * count : count;
}

/** 試合を打たないジョブ（td・potential・pick。区切りは 1 つで、見込みは全体の秒） */
const isStep = (job: Job): boolean => job.spec.kind === "node" || job.spec.kind === "pick";

/** survey の既定（docs/survey.md）と違う設定だけを並べる（AI の設定とデッキは含めない） */
function surveyOpts(s: Extract<JobSpec, { kind: "survey" }>): string {
  if (s.mulligan !== null) {
    return `--mulligan 1 --m ${s.m} --narrow ${s.mulligan.narrow} --narrow-top ${s.mulligan.narrowTop} --confirm ${s.confirm} --flag ${s.flag} --reseed ${s.mulligan.reseed}`;
  }
  const def = { rate: 0.1, m: 32, extra: 4, confirm: 96, flag: 10 };
  return (Object.keys(def) as (keyof typeof def)[])
    .filter((k) => s[k] !== def[k])
    .map((k) => `--${k} ${s[k]}`)
    .join(" ");
}

/** survey の AI の設定とデッキ（表に出す） */
function surveyAi(s: Extract<JobSpec, { kind: "survey" }>): string {
  return `${s.opts === "{}" ? "" : ` ${s.opts}`}${s.decks === null ? "" : ` --decks ${s.decks}`}`;
}

/** ジョブの短い名前（表に出す） */
export function jobTitle(job: Job): string {
  const s = job.spec;
  if (s.kind === "compare") return `compare A ${s.a} 対 B ${s.b}${s.vs ? `（B は ${s.vs}）` : ""}${s.noMirror ? "（鏡なし）" : ""}${s.with ? `（${s.with} の絡む組だけ）` : ""}${s.without ? `（${s.without} の絡まない組だけ）` : ""}`;
  if (s.kind === "yardstick") return `yardstick ${s.ref}${s.opts === "{}" ? "" : ` ${s.opts}`}`;
  if (s.kind === "misses") return `misses（見落とし問題集）${s.opts === "{}" ? "" : ` ${s.opts}`}`;
  if (s.kind === "survey") return `survey（${s.mulligan === null ? "候補" : "マリガン"}の打ち比べ）${surveyOpts(s) === "" ? "" : ` ${surveyOpts(s)}`}${surveyAi(s)}`;
  if (s.kind === "data") return `${s.cmd.join(" ")} → ${s.out}`;
  if (s.kind === "node") return `${s.tool} ${s.args[0] ?? ""}${s.impl === "rust" ? "（Rust）" : ""} → ${s.out}`;
  if (s.kind === "pick") return `pick（${s.from} が線を越えたら ${s.pass}、越えなければ ${s.fail}）→ ${s.out}`;
  return `profile（速さ）${s.opts === "{}" ? "" : ` ${s.opts}`}${s.rhino ? " --rhino" : ""}${s.noMemo ? " --no-memo" : ""}${s.noJemalloc ? " --no-jemalloc" : ""}${s.decks === null ? "" : ` --decks ${s.decks}`}`;
}

// ---------------------------------------------------------------- 見積もりと区切り

type SpeedKey = "compare" | YardstickRef | "profile" | "misses" | "survey";

/** 決めておいた速さ（1 試合あたりのスレッド秒 = 1 試合の秒 × 並列数。今の既定の探索 AI で）。台帳に同じ比べ・同じマシンの回が無いときに使う。
 * misses は全部の問を 1 回ずつ解く秒（10 問のとき。問が増えればその分かかる） */
export const SPEEDS: Record<string, { threads: number; note: string; ts: Record<SpeedKey, number> }> = {
  // ユーザーの PC（Core i7-14700F、28 スレッド。Docker の svwb-docker）。compare は 3200 試合 5 分ほど、物差しは docs/yardstick.md の「（PC）」の行。
  // misses・survey は測っていないので、クラウド環境の値に compare の比（2.6 / 2.0）を掛けた
  // 新しいプールの物差し（pool-v0・pool-r3）は、段階 4 の R3 の compare（84 個のデッキ、R3 対 R2）の 0.176 秒/試合（2026-11-16）から
  "svwb-docker": {
    threads: 28,
    note: "PC の決めておいた値",
    ts: { compare: 2.6, classic: 1.3, strong: 2.7, "pool-v0": 4.9, "pool-r3": 4.9, profile: 2.6, misses: 5.9, survey: 860 },
  },
  // Claude のクラウド環境（4 スレッド）で 2026-11-10 に測った値（compare 0.50・弱い相手 0.21・強い相手 0.44 秒/試合、各 56 試合。
  // misses は 10 問 × 24 回が 27 秒。survey は 2026-11-11 の試し 2（10 試合・15 局面、読み直しを打ち切った候補を入れた後）で 1 局面 328 秒、局面の割合 0.1 で 1 試合 2.0 局面として）。
  // ほかのマシンもこれで見積もる
  // 新しいプールの物差しは 2026-11-16 に測った値（R3 の補正どうし、代表 10 型の 40 試合で 0.72 秒/試合）
  default: {
    threads: 4,
    note: "クラウド環境の決めておいた値",
    ts: { compare: 2.0, classic: 0.85, strong: 1.8, "pool-v0": 2.9, "pool-r3": 2.9, profile: 2.0, misses: 4.5, survey: 660 },
  },
};

export interface Estimate {
  /** 1 試合の秒（そのマシン・並列数で） */
  perGame: number;
  /** どこから見積もったか */
  source: string;
}

/** ジョブと同じ比べの、台帳の回か（種類・両方の設定・絞り込み・鏡・相手） */
function sameComparison(job: Job, r: RunRow): boolean {
  const s = job.spec;
  if (s.kind === "compare") {
    return (
      r.kind === "compare" &&
      canonical(r.a) === canonical(JSON.parse(s.a)) &&
      canonical(r.b) === canonical(JSON.parse(s.b)) &&
      (r.vs ?? null) === s.vs &&
      r.mirror === !s.noMirror &&
      (r.with ?? null) === s.with &&
      (r.without ?? null) === s.without &&
      (s.decks === null) === (r.decks.length === 7 && !r.cmd.includes("--decks"))
    );
  }
  if (s.kind === "yardstick") return r.kind === "yardstick" && r.b === s.ref && canonical(r.a) === canonical(JSON.parse(s.opts));
  return false;
}

/** 1 試合の秒を見積もる（--est → 台帳の同じ比べ・同じマシンの最近の回 → 決めておいた値）。misses は全部の問を 1 回ずつ解く秒 */
export function estimate(job: Job, runs: RunRow[], machine: string, threads: number, misses: MissesRow[] = []): Estimate {
  if (job.est !== null) return { perGame: job.est, source: "--est" };
  const mhit = job.spec.kind === "misses" ? misses.filter((r) => r.machine === machine && r.trials > 0 && r.seconds > 0).slice(-5) : [];
  const mlast = mhit[mhit.length - 1];
  if (mlast) {
    // 問の数が変わっていれば、問の数で割り直す
    const now = mlast.problems;
    const perRound = (r: MissesRow) => ((r.seconds / r.trials) * r.threads * now) / Math.max(1, r.problems);
    return {
      perGame: mhit.reduce((s, r) => s + perRound(r), 0) / mhit.length / threads,
      source: `台帳（${machine}・${mlast.date}・${mhit.length} 回）`,
    };
  }
  const hit = runs.filter((r) => r.machine === machine && r.n > 0 && r.seconds > 0 && sameComparison(job, r)).slice(-5);
  if (hit.length > 0) {
    const last = hit[hit.length - 1];
    const same = hit.filter((r) => r.threads === threads);
    const n = (xs: RunRow[]) => xs.reduce((s, r) => s + r.n, 0);
    const perGame =
      same.length > 0
        ? same.reduce((s, r) => s + r.seconds, 0) / n(same)
        : hit.reduce((s, r) => s + r.seconds * r.threads, 0) / n(hit) / threads;
    return { perGame, source: `台帳（${machine}・${last?.date ?? "?"}・${n(hit)} 試合${same.length > 0 ? "" : "・並列数で割り直し"}）` };
  }
  const sp = SPEEDS[machine] ?? SPEEDS.default;
  if (!sp) throw new Error("決めておいた速さがありません");
  const s = job.spec;
  // データを作るジョブ・td・potential は --est が要る（ジョブの行を読むときに確かめた）。pick はすぐ済む
  if (s.kind === "data" || s.kind === "node" || s.kind === "pick") return { perGame: 1, source: "決めた値" };
  const key: SpeedKey = s.kind === "yardstick" ? s.ref : s.kind;
  if (s.kind === "survey") {
    // 決めておいた値は既定の設定（docs/survey.md）のもの。局面の割合には比べて、ほかの設定の違いは見ない
    const other = surveyOpts({ ...s, rate: 0.1 }) !== "" || surveyAi(s) !== "";
    return { perGame: (sp.ts.survey * (s.rate / 0.1)) / threads, source: `${sp.note}${other ? "（局面の割合のほかの設定の違いは見ていない）" : ""}` };
  }
  const plain =
    s.kind === "compare"
      ? s.a === "{}" && s.b === "{}" && s.decks === null
      : s.kind === "profile"
        ? s.opts === "{}" && s.decks === null
        : s.opts === "{}";
  if (s.kind === "misses") return { perGame: sp.ts.misses / threads, source: `${sp.note}（10 問のとき）` };
  return { perGame: sp.ts[key] / threads, source: `${sp.note}${plain ? "" : "（設定の違いは見ていない）"}` };
}

export interface Chunk {
  /** "<ジョブの番号>-<区切りの番号>"（どちらも 1 から） */
  id: string;
  job: number;
  k: number;
  first: number;
  count: number;
}

/** ジョブを、1 つが targetSec 秒ほどの区切りに分ける（大きさはそろえる。profile・misses は分けない） */
export function chunkJob(job: Job, perGame: number, targetSec: number): Chunk[] {
  const s = job.spec;
  const per =
    s.kind === "data"
      ? s.chunk
      : s.kind === "profile" || s.kind === "misses" || isStep(job)
        ? job.games
        : Math.max(1, Math.floor(targetSec / (unitsOf(job, 1) * perGame)));
  const n = Math.ceil(job.games / per);
  const size = Math.ceil(job.games / n);
  const out: Chunk[] = [];
  for (let k = 0; k * size < job.games; k++) {
    out.push({ id: `${job.index}-${k + 1}`, job: job.index, k: k + 1, first: job.start + k * size, count: Math.min(size, job.games - k * size) });
  }
  return out;
}

// ---------------------------------------------------------------- 時刻

/** 時刻帯 tz での年月日・時分秒 */
export function wallClock(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

const p2 = (x: number) => String(x).padStart(2, "0");

/** "11-11 07:00"（時刻帯 tz で） */
export function fmtClock(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${p2(w.mo)}-${p2(w.d)} ${p2(w.h)}:${p2(w.mi)}`;
}

/** "1 時間 5 分" */
export function fmtDur(sec: number): string {
  if (!Number.isFinite(sec)) return "?";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 時間${m % 60 === 0 ? "" : ` ${m % 60} 分`}`;
}

/** --until: "HH:MM"（時刻帯 tz で次に来るその時刻）、"+90m"・"+2h"（今から）、または ISO の日時 */
export function parseUntil(text: string, now: number, tz: string): number {
  const rel = /^\+(\d+(?:\.\d+)?)(s|m|h)$/.exec(text);
  if (rel) return now + Number(rel[1]) * { s: 1, m: 60, h: 3600 }[rel[2] as "s" | "m" | "h"] * 1000;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hm) {
    const w = wallClock(now, tz);
    let diff = Number(hm[1]) * 60 + Number(hm[2]) - (w.h * 60 + w.mi) - w.s / 60;
    if (diff <= 0) diff += 24 * 60;
    return now + Math.round(diff * 60) * 1000 - (now % 1000);
  }
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`--until は HH:MM・+90m・+2h・ISO の日時: ${text}`);
  return t;
}

// ---------------------------------------------------------------- 回のフォルダ

export interface Plan {
  v: 1;
  name: string;
  /** 作った時刻（ISO） */
  created: string;
  /** リポジトリの根（svwb を回す場所。設定の中のファイルの道はここから） */
  repo: string;
  jobsFile: string;
  commit: string;
  /** 回のコミットの全部の sha（台帳の行をコミットするブランチの元。前の回には無い） */
  commitFull?: string;
  branch: string;
  /** 台帳の行をコミットする git のリポジトリ（券で積んだ回は、回のフォルダに出したソースではなく /workspace。無ければ repo） */
  gitDir?: string;
  /** 回す svwb（回のフォルダに写したもの） */
  bin: string;
  chunkMin: number;
  jobs: Job[];
  estimates: Estimate[];
  chunks: Chunk[];
  /** キュー（pueue。add で積んだ回）の印 */
  queue?: 1;
  /** 試す用: 組み立てずに写す svwb と、ビルドせずに写す td・potential（add の --bin・--node-bin） */
  prebuilt?: string;
  nodeBin?: string;
}

/** 回の設定（積んだときのもの）。前のやり方（2026-11-25 に外した）で回した回の session.json には、止める時刻（until）もある */
export interface Session {
  /** 回を作った時刻（ミリ秒） */
  started: number;
  tz: string;
  threads: number;
  machine: string;
  /** 止まったときにまとめる版（2026-11-19 から）で作った回の印（キューの回にはいつもある）。まとめが済んでいない回を拾う（needsWrap）のは、これがある回だけ
   * （それより前に回した回のフォルダを、queue-push.sh の wrap --pending がまとめ直して上げないように） */
  wraps?: 1;
  /** キュー（pueue）の回の印 */
  queue?: 1;
}

/** 区切りが済んだ印 */
interface Marker {
  id: string;
  seconds: number;
  /** 済んだ時刻（ISO） */
  at: string;
  /** 回したスレッド数（速さの見込みは、同じスレッド数の区切りだけから） */
  threads: number;
  /** 台帳の行から作り直した印か */
  recovered?: boolean;
}

export interface Status {
  state: "running" | "stopped" | "done";
  reason: string;
  /** 書いた時刻（ミリ秒） */
  at: number;
  current: { id: string; since: number } | null;
  /** 止まったときのまとめ: 出口のフォルダと、台帳の行をコミットしたブランチ（どちらも、できなかったときはその理由） */
  outbox?: string;
  branch?: string;
}

export const runsRoot = (opt?: string): string => resolve(opt ?? (process.env.SVWB_NIGHT_DIR || join(homedir(), "svwb-data", "night")));

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** 書きかけを残さないよう、.tmp に書いて fsync してから名前を替える */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function fsyncFile(file: string): void {
  if (!existsSync(file)) return;
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const readPlan = (dir: string): Plan => readJson<Plan>(join(dir, "plan.json"));
export const readSession = (dir: string): Session => readJson<Session>(join(dir, "session.json"));
export function readStatus(dir: string): Status | null {
  const f = join(dir, "status.json");
  return existsSync(f) ? readJson<Status>(f) : null;
}

function writeStatus(dir: string, s: Omit<Status, "at">): void {
  writeAtomic(join(dir, "status.json"), JSON.stringify({ ...s, at: Date.now() }));
}

function log(dir: string, tz: string, text: string): void {
  appendFileSync(join(dir, "night.log"), `${fmtClock(Date.now(), tz)} ${text}\n`);
}

function markers(dir: string): Map<string, Marker> {
  const out = new Map<string, Marker>();
  const d = join(dir, "done");
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = readJson<Marker>(join(d, f));
      out.set(m.id, m);
    } catch {
      // 書きかけ（電源が切れた等）は済んでいないものとする
    }
  }
  return out;
}

function writeMarker(dir: string, m: Marker): void {
  mkdirSync(join(dir, "done"), { recursive: true });
  writeAtomic(join(dir, "done", `${m.id}.json`), JSON.stringify(m));
}

/** 回のフォルダの台帳の行（区切りごと） */
export function chunkRows(dir: string): RunRow[] {
  const f = join(dir, "ledger.jsonl");
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")).runs : [];
}

/** 回のフォルダの台帳の、見落とし問題集の行 */
function chunkMisses(dir: string): MissesRow[] {
  const f = join(dir, "ledger.jsonl");
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")).misses : [];
}

/** 区切りの台帳の行（同じ引数で回した行） */
function rowOf<R extends { cmd: string }>(rows: R[], plan: Pick<Plan, "jobs">, dir: string, c: Chunk): R | undefined {
  const job = plan.jobs[c.job - 1];
  if (!job) return undefined;
  const cmd = shellLine(jobArgv(job, c.first, c.count, dir));
  return rows.find((r) => r.cmd === cmd);
}

/** survey の出力にある試合と局面の数（試合の行のある試合だけ。途中で止めた試合の局面は数えない） */
export function surveyProgress(file: string): { games: Set<number>; positions: number } {
  const games = new Set<number>();
  const pos: number[] = [];
  if (!existsSync(file)) return { games, positions: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as { game?: boolean; g?: number };
      if (typeof o.g !== "number") continue;
      if (o.game === true) games.add(o.g);
      else pos.push(o.g);
    } catch {
      // 書きかけの行（止めた等）は数えない
    }
  }
  return { games, positions: pos.filter((g) => games.has(g)).length };
}

/** survey の区切りの試合が、全部出力にあるか */
function surveyChunkDone(plan: Plan, dir: string, c: Chunk): boolean {
  const job = plan.jobs[c.job - 1];
  if (!job) return false;
  const { games } = surveyProgress(surveyFile(dir, job));
  for (let g = c.first; g < c.first + c.count; g++) if (!games.has(g)) return false;
  return true;
}

/** 区切りの台帳の行（ジョブの種類に合わせて読む。profile・survey は区切りごとの行を書かない） */
function chunkRowOf(plan: Plan, dir: string, c: Chunk): RunRow | MissesRow | undefined {
  const kind = plan.jobs[c.job - 1]?.spec.kind;
  if (kind === "profile" || kind === "survey") return undefined;
  return kind === "misses" ? rowOf(chunkMisses(dir), plan, dir, c) : rowOf(chunkRows(dir), plan, dir, c);
}

/** 根の下の回（作った順） */
export function listRuns(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((d) => existsSync(join(d, "plan.json")))
    .sort((x, y) => readPlan(x).created.localeCompare(readPlan(y).created));
}

/** 名前の回のフォルダ（名前を省くと最後に作った回） */
function findRun(root: string, name: string | undefined): string {
  if (name !== undefined) {
    const d = join(root, name);
    if (!existsSync(join(d, "plan.json"))) throw new Error(`回がありません: ${d}`);
    return d;
  }
  const all = listRuns(root);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error(`${root} に当てはまる回がありません`);
  return last;
}

// ---------------------------------------------------------------- 計画と表示

export function makePlanParts(
  jobs: Job[],
  runs: RunRow[],
  machine: string,
  threads: number,
  chunkMin: number,
  misses: MissesRow[] = [],
): { estimates: Estimate[]; chunks: Chunk[] } {
  const estimates = jobs.map((j) => estimate(j, runs, machine, threads, misses));
  const chunks = jobs.flatMap((j, i) => chunkJob(j, estimates[i]?.perGame ?? 1, chunkMin * 60));
  return { estimates, chunks };
}

/** 区切りの見込みの秒（そのジョブで済んだ区切りがあれば、その速さで） */
function chunkSeconds(c: Chunk, plan: Plan, measured: Map<number, number>): number {
  const perGame = measured.get(c.job) ?? plan.estimates[c.job - 1]?.perGame ?? 1;
  const job = plan.jobs[c.job - 1];
  return (job ? unitsOf(job, c.count) : 2 * c.count) * perGame;
}

/** ジョブごとの、同じスレッド数で済んだ区切りから測った 1 試合の秒 */
function measuredSpeed(plan: Pick<Plan, "jobs" | "chunks">, done: Map<string, Marker>, threads: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const job of plan.jobs) {
    const cs = plan.chunks.filter((c) => {
      const m = done.get(c.id);
      return c.job === job.index && m !== undefined && !m.recovered && m.threads === threads;
    });
    const games = cs.reduce((s, c) => s + unitsOf(job, c.count), 0);
    const secs = cs.reduce((s, c) => s + (done.get(c.id)?.seconds ?? 0), 0);
    if (games > 0 && secs > 0) out.set(job.index, secs / games);
  }
  return out;
}

/** 計画の表（済んだ区切りは除いて、startAt から順に回したときの見込み） */
export function planText(
  plan: Pick<Plan, "jobs" | "estimates" | "chunks"> & Partial<Plan>,
  o: { threads: number; machine: string; startAt: number; until: number | null; tz: string; done?: Map<string, Marker>; title: string },
): string {
  const done = o.done ?? new Map<string, Marker>();
  const measured = measuredSpeed(plan, done, o.threads);
  let t = o.startAt;
  let cut: string | null = null;
  const rows: string[][] = [];
  let total = 0;
  let nChunks = 0;
  for (const [i, job] of plan.jobs.entries()) {
    const cs = plan.chunks.filter((c) => c.job === job.index && !done.has(c.id));
    const perGame = measured.get(job.index) ?? plan.estimates[i]?.perGame ?? 1;
    const secs = cs.reduce((s, c) => s + unitsOf(job, c.count) * perGame, 0);
    for (const c of cs) {
      if (cut === null && o.until !== null && t + unitsOf(job, c.count) * perGame * 1000 > o.until) cut = `ジョブ ${job.index} の区切り ${c.k}`;
      t += unitsOf(job, c.count) * perGame * 1000;
    }
    total += secs;
    nChunks += cs.length;
    const games = cs.reduce((s, c) => s + c.count, 0);
    const first = cs[0]?.first ?? job.start;
    rows.push([
      String(job.index),
      jobTitle(job),
      job.label,
      cs.length === 0 ? "済み" : job.spec.kind === "misses" ? `各問 ${games} 回` : isStep(job) ? "―" : `${unitsOf(job, games)}（g${first}〜${first + games - 1}）`,
      String(cs.length),
      isStep(job) ? `${fmtDur(perGame)}（全体）` : `${perGame.toFixed(3)} 秒${job.spec.kind === "misses" ? "（全問 1 回）" : ""}`,
      fmtDur(secs),
      cs.length === 0 ? "" : fmtClock(t, o.tz),
      measured.has(job.index) ? "この回で測った速さ" : (plan.estimates[i]?.source ?? ""),
    ]);
  }
  const head =
    `${o.title}: ${plan.jobs.length} ジョブ・${nChunks} 区切り、見込み ${fmtDur(total)}（${o.machine}・${o.threads} スレッド）。` +
    `${fmtClock(o.startAt, o.tz)} に始めると ${fmtClock(o.startAt + total * 1000, o.tz)} ごろ終わる。` +
    (o.until === null ? "" : `止める時刻 ${fmtClock(o.until, o.tz)}（${o.tz}）`);
  const warn =
    o.until === null
      ? ""
      : cut === null
        ? "止める時刻までに全部終わる見込み。\n"
        : `止める時刻までに終わらない見込み: ${cut} の途中で一時停止する（次の start で続きから）。\n`;
  return `${head}\n${warn}\n${markdownTable(["#", "ジョブ", "台帳の名前", "試合", "区切り", "1 試合", "見込み", "終わる時刻", "見込みの出どころ"], rows)}`;
}

// ---------------------------------------------------------------- 結果のまとめ

const round = (x: number, k: number) => Math.round(x * 10 ** k) / 10 ** k;

/** 区切りの行（同じジョブの、試合番号の続いた区切り）を、1 回で回したときと同じ数字の 1 行にまとめる */
export function combineRows(rows: RunRow[], cmd: string, queue: string): RunRow & { queue: string; chunks: number } {
  const sorted = [...rows].sort((x, y) => x.g[0] - y.g[0]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error("まとめる行がありません");
  const n = sorted.reduce((s, r) => s + r.n, 0);
  const wins = sorted.reduce((s, r) => s + r.wins, 0);
  const pairs: [number, number, number] = [0, 0, 0];
  const perDeck: Record<string, [number, number]> = {};
  for (const r of sorted) {
    for (let i = 0; i < 3; i++) pairs[i as 0 | 1 | 2] += r.pairs[i as 0 | 1 | 2];
    for (const [d, [w, t]] of Object.entries(r.perDeck)) {
      const x = perDeck[d] ?? [0, 0];
      perDeck[d] = [x[0] + w, x[1] + t];
    }
  }
  let se: number | null = null;
  if (first.seKind === "pairs") {
    // 組の勝率（0・0.5・1）のばらつき（rust/engine/src/runner/compare.rs の pair_stats と同じ）
    const m = pairs[0] + pairs[1] + pairs[2];
    if (m >= 2) {
      const mean = (pairs[1] * 0.5 + pairs[2]) / m;
      const v = (pairs[0] * mean ** 2 + pairs[1] * (0.5 - mean) ** 2 + pairs[2] * (1 - mean) ** 2) / (m - 1);
      se = Math.sqrt(v / m);
    }
  } else if (n > 0) {
    const p = wins / n;
    se = Math.sqrt((p * (1 - p)) / n);
  }
  const seconds = sorted.reduce((s, r) => s + r.seconds, 0);
  // 棋譜は区切りごとに 1 つのファイル（kifu.rs の名前。共有フォルダでは data/kifu/<回の名前>/ の下に .gz が付いて置かれる）。試合番号の順に並べる
  const kifu = sorted.flatMap((r) => (typeof r.kifu === "string" ? [r.kifu] : Array.isArray(r.kifu) ? r.kifu : []));
  return {
    ...first,
    kifu: kifu.length > 0 ? kifu : null,
    date: last.date,
    at: last.at,
    g: [first.g[0], last.g[1]],
    n,
    wins,
    rate: n > 0 ? round(wins / n, 6) : null,
    se: se === null ? null : round(se, 6),
    pairs,
    perDeck,
    seconds: round(seconds, 1),
    perGame: n > 0 ? round(seconds / n, 6) : null,
    cmd,
    queue,
    chunks: sorted.length,
  };
}

/** ジョブの済んだ区切りの行を、試合番号の続いたまとまりに分ける */
function contiguous(rows: RunRow[]): RunRow[][] {
  const sorted = [...rows].sort((x, y) => x.g[0] - y.g[0]);
  const out: RunRow[][] = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && prev.g[1] + 1 === r.g[0] && prev.threads === r.threads && prev.machine === r.machine) cur.push(r);
    else out.push([r]);
  }
  return out;
}

const pct = (x: number | null) => (x === null ? "?" : `${(x * 100).toFixed(2)}%`);
const pts = (x: number | null) => (x === null ? "?" : (x * 100).toFixed(2));

/** 回の今の様子（表）。final なら、まとめの結果の行を書かない（止まったときのまとめに書く） */
export function statusText(dir: string, o: { final?: boolean } = {}): string {
  const plan = readPlan(dir);
  const session = existsSync(join(dir, "session.json")) ? readSession(dir) : null;
  const tz = session?.tz ?? "Asia/Tokyo";
  const st = readStatus(dir);
  const done = markers(dir);
  const rows = chunkRows(dir);
  const missesRows = chunkMisses(dir);
  const failed = existsSync(join(dir, "failed.json")) ? readJson<Record<string, string>>(join(dir, "failed.json")) : {};
  let state: string;
  if (plan.queue === 1) {
    const ps = pueueOrNull();
    state = queueRunState(plan, ps === null ? null : runTasks(ps, plan.name), done, tz);
  } else {
    // 前のやり方（券と go。2026-11-25 に外した）で回した回。続きは回せない
    state = `前のやり方で回した回（${st === null ? "始めていない" : st.state === "done" ? `全部済んだ、${fmtClock(st.at, tz)}` : `最後の記録 ${fmtClock(st.at, tz)}`}）`;
  }
  const tableRows: string[][] = plan.jobs.map((job) => {
    const cs = plan.chunks.filter((c) => c.job === job.index);
    const ds = cs.filter((c) => done.has(c.id));
    const secs = ds.reduce((s, c) => s + (done.get(c.id)?.seconds ?? 0), 0);
    const games = ds.reduce((s, c) => s + unitsOf(job, c.count), 0);
    let result = "";
    const sp = job.spec;
    if (sp.kind === "profile") {
      result = ds.length > 0 ? `speed-${job.index}.md` : "";
    } else if (sp.kind === "data") {
      result = ds.length > 0 ? `ファイル ${ds.length}/${cs.length}` : "";
    } else if (sp.kind === "node") {
      result = ds.length > 0 ? `${sp.out} を作った` : "";
    } else if (sp.kind === "pick") {
      const f = join(dir, `pick-${job.index}.json`);
      if (existsSync(f)) result = pickText(readJson<PickResult>(f));
    } else if (job.spec.kind === "survey") {
      const p = surveyProgress(surveyFile(dir, job));
      if (p.games.size > 0) result = `試合 ${p.games.size}・局面 ${p.positions}（survey-${job.index}.jsonl）`;
    } else if (job.spec.kind === "misses") {
      const m = ds.map((c) => rowOf(missesRows, plan, dir, c)).find((r) => r !== undefined);
      if (m) result = `正解率 ${pct(m.rate)} ± ${pts(m.se)}`;
    } else {
      const rs = ds.map((c) => rowOf(rows, plan, dir, c)).filter((r): r is RunRow => r !== undefined);
      if (rs.length > 0) {
        const c = combineRows(rs, "", plan.name);
        result = `${pct(c.rate)} ± ${pts(c.se)}`;
      }
    }
    const f = failed[String(job.index)];
    return [
      String(job.index),
      jobTitle(job),
      job.label,
      `${ds.length}/${cs.length}`,
      job.spec.kind === "misses" ? `${games}/${job.games} 回` : isStep(job) ? "―" : `${games}/${unitsOf(job, job.games)}`,
      fmtDur(secs),
      result,
      f ? `失敗: ${f}` : "",
    ];
  });
  const s = session;
  const head = [
    `キュー ${plan.name}（${dir}）`,
    `状態: ${state}`,
    `コミット ${plan.commit}（${plan.branch}）、${s ? `${s.machine}・${s.threads} スレッド` : ""}${plan.queue === 1 ? "、キュー（回す・止めるは queue.sh start・pause）" : ""}`,
    ...(o.final !== true && st?.branch !== undefined ? [`台帳の行: ${st.branch}（上げるのはホストで docker/remote-control/queue-push.sh）`] : []),
    ...(o.final !== true && st?.outbox !== undefined ? [`出口: ${st.outbox}`] : []),
    ...(o.final !== true && needsWrap(dir)
      ? ["まとめ: まだ（止まっているか、電源が切れたか、まとめている途中で落ちた）。docker/remote-control/queue-push.sh がまとめてから push する（手でなら npm run queue -- wrap）"]
      : []),
  ];
  return `${head.join("\n")}\n\n${markdownTable(["#", "ジョブ", "台帳の名前", "区切り", "試合", "かかった時間", "結果（A の勝率・正解率・局面・ファイル）", "メモ"], tableRows)}`;
}

/** 止まったときのまとめが済んでいない回か（止まったときにまとめる版で作った・済んだ区切りがある・status にまとめの結果が無い・区切りを回していない）。
 * 一時停止した回・電源が切れた回と、まとめている途中で落ちた回。queue-push.sh が wrap --pending でまとめる。
 * 2026-11-19 より前の版で回した回（session.json に wraps が無い）は拾わない（手で wrap <名前> を流したときだけまとめる） */
export function needsWrap(dir: string): boolean {
  if (!existsSync(join(dir, "session.json")) || readSession(dir).wraps !== 1) return false;
  const st = readStatus(dir);
  // 区切りが回っている間はまとめない（一時停止して凍っている区切りは、まとめてよい）
  return st !== null && (st.outbox === undefined || st.branch === undefined) && markers(dir).size > 0 && !chunkRunning(dir);
}

/** pick の結果（回のフォルダの pick-<番号>.json） */
export interface PickResult {
  compare: string;
  n: number;
  rate: number | null;
  se: number | null;
  /** A の勝率 − 50% − 2 SE */
  lower: number | null;
  pass: boolean;
  chosen: string;
  out: string;
}

const pickText = (p: PickResult): string =>
  `${p.compare}: ${pct(p.rate)} ± ${pts(p.se)}（${p.n} 試合、差 − 2 SE ${p.lower === null ? "?" : (p.lower * 100).toFixed(2)}）→ ${p.pass ? "越えた" : "越えない"}。${p.out} は ${p.chosen}`;

/** pick を回す: 前の compare の区切りの行をまとめ、A の勝率 − 50% − 2 SE > 0 なら pass、そうでなければ fail のファイルを out に写す */
export function runPick(plan: Plan, dir: string, job: Job): PickResult {
  const s = job.spec;
  if (s.kind !== "pick") throw new Error("pick ではありません");
  const cj = plan.jobs.find((j) => j.spec.kind === "compare" && j.label === s.from);
  if (!cj) throw new Error(`台帳の名前 ${s.from} の compare がありません`);
  const done = markers(dir);
  const cs = plan.chunks.filter((c) => c.job === cj.index);
  const left = cs.filter((c) => !done.has(c.id));
  if (left.length > 0) throw new Error(`compare ${s.from}（ジョブ ${cj.index}）が済んでいない（区切り ${cs.length - left.length}/${cs.length}）`);
  const all = chunkRows(dir);
  const rows = cs.map((c) => rowOf(all, plan, dir, c));
  if (rows.some((r) => r === undefined)) throw new Error(`compare ${s.from} の台帳の行が揃っていない`);
  const r = combineRows(rows as RunRow[], "", plan.name);
  const lower = r.rate === null || r.se === null ? null : r.rate - 0.5 - 2 * r.se;
  const pass = lower !== null && lower > 0;
  const chosen = pass ? s.pass : s.fail;
  const out = atDir(s.out, dir);
  copyFileSync(atDir(chosen, dir), `${out}.tmp`);
  const res: PickResult = { compare: s.from, n: r.n, rate: r.rate, se: r.se, lower, pass, chosen, out: s.out };
  writeAtomic(join(dir, `pick-${job.index}.json`), JSON.stringify(res));
  renameSync(`${out}.tmp`, out);
  return res;
}

// ---------------------------------------------------------------- 区切りを回す

export interface ChunkControl {
  /** すぐ止める（回している区切りを止める。pueue kill のとき） */
  stopNow: boolean;
  kill?: (() => void) | undefined;
}

/** 区切りが作るファイル（回のフォルダの道。データを作るジョブ・td・potential・pick だけ） */
export function chunkProducts(plan: Pick<Plan, "jobs">, dir: string, c: Chunk): string[] {
  const job = plan.jobs[c.job - 1];
  if (!job) return [];
  const s = job.spec;
  if (s.kind === "data") return [dataProduct(job, c.first, dir).file];
  if (s.kind === "node") return [s.out, ...s.extra].map((f) => atDir(f, dir));
  return s.kind === "pick" ? [atDir(s.out, dir)] : [];
}

/** 済んだ区切りの途中のファイルを、できたファイルにする（データは .gz なら gzip する） */
async function finishProducts(job: Job, c: Chunk, dir: string): Promise<void> {
  const s = job.spec;
  if (s.kind === "data") {
    const { file, tmp } = dataProduct(job, c.first, dir);
    if (!existsSync(tmp)) throw new Error(`書いたはずのファイルがありません: ${tmp}`);
    if (file.endsWith(".gz")) {
      await pipeline(createReadStream(tmp), createGzip(), createWriteStream(`${file}.tmp`));
      fsyncFile(`${file}.tmp`);
      renameSync(`${file}.tmp`, file);
      rmSync(tmp, { force: true });
    } else {
      fsyncFile(tmp);
      renameSync(tmp, file);
    }
  } else if (s.kind === "node") {
    const out = atDir(s.out, dir);
    if (!existsSync(`${out}.tmp`)) throw new Error(`書いたはずのファイルがありません: ${out}.tmp`);
    fsyncFile(`${out}.tmp`);
    renameSync(`${out}.tmp`, out);
  }
}

/** 回のフォルダの棋譜の置き場 */
export function kifuDir(dir: string): string {
  return join(dir, "kifu");
}

/** 棋譜の置き場の .jsonl ごとの様子（inode・大きさ・更新時刻）。区切りの前に取り、その区切りが書いたものだけを gzip するため */
export function kifuSnapshot(dir: string): Map<string, string> {
  const kdir = kifuDir(dir);
  const out = new Map<string, string>();
  if (!existsSync(kdir)) return out;
  for (const f of readdirSync(kdir)) {
    if (!f.endsWith(".jsonl")) continue;
    const st = statSync(join(kdir, f));
    out.set(f, `${st.ino}:${st.size}:${st.mtimeMs}`);
  }
  return out;
}

/**
 * 棋譜の置き場の、区切りが書いた .jsonl を gzip して .jsonl.gz にする（区切りが済んだ後）。書きかけは svwb が .tmp に書くので触らない。
 * before（区切りの前の kifuSnapshot）と同じままのファイルは触らない: survey run は .tmp を使わずに書き足していくので、
 * 止まった区切りの書きかけの棋譜を、ほかの区切りが済んだときに gzip しないように（その区切りを続きから回すと、同じファイルに書き足す）
 */
export async function gzipKifu(dir: string, before: Map<string, string> = new Map()): Promise<string[]> {
  const kdir = kifuDir(dir);
  if (!existsSync(kdir)) return [];
  const now = kifuSnapshot(dir);
  const done: string[] = [];
  for (const f of readdirSync(kdir)) {
    if (!f.endsWith(".jsonl")) continue;
    if (before.has(f) && before.get(f) === now.get(f)) continue;
    const src = join(kdir, f);
    const gz = `${src}.gz`;
    await pipeline(createReadStream(src), createGzip(), createWriteStream(`${gz}.tmp`));
    fsyncFile(`${gz}.tmp`);
    renameSync(`${gz}.tmp`, gz);
    rmSync(src, { force: true });
    done.push(`${f}.gz`);
  }
  return done;
}

/**
 * svwb に差し込むメモリの確保の置き換え（環境変数 SVWB_PRELOAD に書いた共有ライブラリ。PC のコンテナは jemalloc。
 * docker/remote-control/Dockerfile）。値も試合も変わらず、速さだけが変わる（docs/profile.md「メモリの確保」）。
 * svwb にだけ LD_PRELOAD で渡す（node などには入れない）。無ければ何もしない
 */
function svwbPreload(): { LD_PRELOAD?: string } {
  const lib = process.env.SVWB_PRELOAD;
  return lib && existsSync(lib) ? { LD_PRELOAD: lib } : {};
}

/** 区切りを 1 つ回す。終わりの状態（0 なら済んだ）と秒 */
function runChunk(plan: Plan, session: Session, dir: string, c: Chunk, ctl: ChunkControl): Promise<{ code: number | null; seconds: number; why: string }> {
  const job = plan.jobs[c.job - 1];
  if (!job) throw new Error(`ジョブ ${c.job} がありません`);
  const argv = jobArgv(job, c.first, c.count, dir);
  mkdirSync(join(dir, "chunks"), { recursive: true });
  const logFile = join(dir, "chunks", `${c.id}.log`);
  const t0 = Date.now();
  const s = job.spec;
  if (s.kind === "pick") {
    try {
      const r = runPick(plan, dir, job);
      writeFileSync(logFile, `${pickText(r)}\n`);
      return Promise.resolve({ code: 0, seconds: (Date.now() - t0) / 1000, why: "" });
    } catch (e) {
      writeFileSync(`${logFile}.tmp`, `${(e as Error).message}\n`);
      return Promise.resolve({ code: null, seconds: (Date.now() - t0) / 1000, why: (e as Error).message });
    }
  }
  // td・potential は、回のフォルダに写したビルド結果を回す（組み立てが作る）。--impl rust の td train・prune は svwb td train・prune
  const [cmd, args] =
    s.kind === "node" && s.impl === "ts"
      ? [process.execPath, [join(dir, "bin", "run-bundle.mjs"), join(dir, "bin", s.tool, `${s.tool}-main.mjs`), ...argv.slice(1)]]
      : [plan.bin, argv];
  const out = openSync(`${logFile}.tmp`, "w");
  const kifuBefore = kifuSnapshot(dir);
  const preload = cmd === plan.bin && !(s.kind === "profile" && s.noJemalloc) ? svwbPreload() : {};
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: plan.repo,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        ...preload,
        THREADS: String(session.threads),
        SVWB_LEDGER: join(dir, "ledger.jsonl"),
        SVWB_COMMIT: plan.commit,
        SVWB_BRANCH: plan.branch,
        SVWB_MACHINE: session.machine,
        // 棋譜（rust/engine/src/runner/kifu.rs）は回のフォルダの kifu/ に、引数から決まる名前で書く（区切りを回し直すと上書きする。survey は続きから書き足す）
        SVWB_KIFU_DIR: kifuDir(dir),
      },
    });
    let why = "";
    ctl.kill = () => {
      why = "すぐ止めた";
      child.kill("SIGTERM");
    };
    // 止める時刻はキューのもの（キューを一時停止すると、区切りは svwb ごと凍る）
    const finish = async (code: number | null) => {
      ctl.kill = undefined;
      closeSync(out);
      if (code === 0) {
        try {
          await finishProducts(job, c, dir);
          await gzipKifu(dir, kifuBefore);
        } catch (e) {
          why = (e as Error).message;
          code = null;
        }
      }
      if (code === 0) renameSync(`${logFile}.tmp`, logFile);
      done({ code, seconds: (Date.now() - t0) / 1000, why });
    };
    child.on("error", (e) => {
      why = e.message;
      void finish(null);
    });
    child.on("exit", (code) => void finish(code));
  });
}

/** 印が無くても済んでいる区切り（台帳に行がある・survey の出力に試合が揃っている・作るファイルがある。電源が切れた直後など）なら、
 * 回さずに印を作って true */
function recoverChunk(plan: Plan, session: Session, dir: string, c: Chunk): boolean {
  const tz = session.tz;
  const job = plan.jobs[c.job - 1];
  if (!job) throw new Error(`ジョブ ${c.job} がありません`);
  // 台帳に行があって印が無い（行を書いた直後に電源が切れた）なら、回さずに印を作る
  const row = chunkRowOf(plan, dir, c);
  if (row) {
    writeMarker(dir, { id: c.id, seconds: row.seconds, at: new Date().toISOString(), threads: row.threads, recovered: true });
    log(dir, tz, `区切り ${c.id} は台帳に行があるので済んだものとした`);
    return true;
  }
  if (job.spec.kind === "survey" && surveyChunkDone(plan, dir, c)) {
    writeMarker(dir, { id: c.id, seconds: 0, at: new Date().toISOString(), threads: session.threads, recovered: true });
    log(dir, tz, `区切り ${c.id} は出力に全部の試合があるので済んだものとした`);
    return true;
  }
  // 作るファイルがあれば（できた直後に電源が切れた・手で置いた）、回さずに印を作る
  const products = chunkProducts(plan, dir, c);
  if (products.length > 0 && products.every((f) => existsSync(f))) {
    writeMarker(dir, { id: c.id, seconds: 0, at: new Date().toISOString(), threads: session.threads, recovered: true });
    log(dir, tz, `区切り ${c.id} は ${products.map((f) => basename(f)).join("・")} があるので済んだものとした`);
    return true;
  }
  return false;
}

/** 前のジョブが作るファイルのうち、無いもの（失敗した・まだ済んでいない） */
const missingInputs = (job: Job, dir: string): string[] =>
  jobInputs(job)
    .map((f) => atDir(f, dir))
    .filter((f) => !existsSync(f));

/** 区切りを 1 つ回し、済めば印を書く */
async function runAndMark(
  plan: Plan,
  session: Session,
  dir: string,
  c: Chunk,
  ctl: ChunkControl,
  expected: number,
): Promise<{ code: number | null; seconds: number; why: string }> {
  const tz = session.tz;
  const job = plan.jobs[c.job - 1];
  if (!job) throw new Error(`ジョブ ${c.job} がありません`);
  const ledgerFile = join(dir, "ledger.jsonl");
  // 前の行が書きかけ（電源が切れた等）なら、次の行がそれにつながらないよう改行を足す
  if (existsSync(ledgerFile)) {
    const text = readFileSync(ledgerFile, "utf8");
    if (text.length > 0 && !text.endsWith("\n")) appendFileSync(ledgerFile, "\n");
  }
  writeStatus(dir, { state: "running", reason: "", current: { id: c.id, since: Date.now() } });
  log(dir, tz, `区切り ${c.id}（${job.label || jobTitle(job)}${isStep(job) ? "" : `、g${c.first}〜${c.first + c.count - 1}`}、見込み ${fmtDur(expected)}）を始める`);
  const r = await runChunk(plan, session, dir, c, ctl);
  if (r.code === 0) {
    fsyncFile(ledgerFile);
    writeMarker(dir, { id: c.id, seconds: r.seconds, at: new Date().toISOString(), threads: session.threads });
    const got = chunkRowOf(plan, dir, c);
    const k = job.spec.kind;
    if ((k === "compare" || k === "yardstick" || k === "misses") && got === undefined) log(dir, tz, `注意: 区切り ${c.id} の台帳の行が見つからない（chunks/${c.id}.log を見る）`);
    if (job.spec.kind === "survey" && !surveyChunkDone(plan, dir, c)) log(dir, tz, `注意: 区切り ${c.id} の試合が survey-${job.index}.jsonl に揃っていない（chunks/${c.id}.log を見る）`);
    const what = got === undefined ? "" : got.kind === "misses" ? `、正解率 ${pct(got.rate)}` : `、A ${pct(got.rate)}`;
    const pace = isStep(job) ? "" : `、${(r.seconds / unitsOf(job, c.count)).toFixed(3)} 秒/${job.spec.kind === "misses" ? "全問 1 回" : "試合"}`;
    const made = chunkProducts(plan, dir, c).map((f) => basename(f));
    log(dir, tz, `区切り ${c.id} 済み（${fmtDur(r.seconds)}${pace}${what}${made.length > 0 ? `、${made.join("・")}` : ""}）`);
  }
  return r;
}

/** 失敗した区切りを書き残し、途中のファイルを消す */
function recordFailure(plan: Plan, session: Session, dir: string, c: Chunk, r: { code: number | null; why: string }, failed: Record<string, string>): void {
  const job = plan.jobs[c.job - 1];
  if (!job) throw new Error(`ジョブ ${c.job} がありません`);
  failed[String(job.index)] = `区切り ${c.id}（終わりの状態 ${r.code ?? "?"}${r.why ? `、${r.why}` : ""}。chunks/${c.id}.log.tmp）`;
  for (const f of chunkProducts(plan, dir, c)) rmSync(`${f}.tmp`, { force: true });
  if (job.spec.kind === "data") rmSync(dataProduct(job, c.first, dir).tmp, { force: true });
  log(dir, session.tz, `区切り ${c.id} が失敗した（終わりの状態 ${r.code ?? "?"}）。ジョブ ${job.index} の残りを飛ばす`);
  writeAtomic(join(dir, "failed.json"), JSON.stringify(failed));
}

// ---------------------------------------------------------------- コマンド

interface Args {
  pos: string[];
  opts: Map<string, string>;
}

const FLAGS = new Set(["--pending", "--wait"]);

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    if (FLAGS.has(a)) {
      opts.set(a, "true");
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${a} の値がありません`);
    opts.set(a, v);
    i++;
  }
  return { pos, opts };
}

function known(a: Args, names: string[], maxPos: number): void {
  const bad = [...a.opts.keys()].filter((k) => !names.includes(k) && k !== "--root");
  if (bad.length > 0) throw new Error(`使えない引数: ${bad.join(" ")}`);
  if (a.pos.length > maxPos) throw new Error(`多すぎる引数: ${a.pos.slice(maxPos).join(" ")}`);
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** 今のコミット（台帳と物差しの表のほかに変更があれば末尾に +。rust の commit_label_excluding と同じ）とブランチ */
export function gitState(): { commit: string; branch: string; dirty: boolean } {
  // SVWB_COMMIT（svwb が台帳の行に書くコミット）があれば、それを回のコミットにする（試す用）
  const fixed = process.env.SVWB_COMMIT;
  if (fixed) return { commit: fixed, branch: process.env.SVWB_BRANCH || git(["rev-parse", "--abbrev-ref", "HEAD"]) || "?", dirty: false };
  const head = git(["rev-parse", "--short=7", "HEAD"]) || "?";
  const dirty = dirtyIn(REPO);
  return { commit: dirty ? `${head}+` : head, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || "?", dirty };
}

/** 台帳と物差しの表のほかに、コミットしていない変更があるか */
function dirtyIn(cwd: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "--", ":/", ":(exclude,top)docs/yardstick.md", ":(exclude,top)docs/ledger.jsonl"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() !== "";
}

const thisMachine = (): string => process.env.SVWB_MACHINE || hostname();

function repoLedger(): { runs: RunRow[]; misses: MissesRow[] } {
  const f = process.env.SVWB_LEDGER || DEFAULT_LEDGER;
  return existsSync(f) ? parseLedger(readFileSync(f, "utf8")) : { runs: [], misses: [] };
}

function sessionOf(a: Args, machine: string): Session {
  const tz = a.opts.get("--tz") ?? "Asia/Tokyo";
  const threadsText = a.opts.get("--threads");
  const threads = threadsText === undefined ? (SPEEDS[machine] && machine !== thisMachine() ? (SPEEDS[machine]?.threads ?? 1) : availableParallelism()) : intOf(threadsText, "--threads", 1);
  return { started: Date.now(), tz, threads, machine, wraps: 1 };
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} が失敗しました`);
}

/** 確かめるときの、回のフォルダのモデルの代わり（設定の JSON の鍵ごと） */
const STAND_INS: Record<string, string> = { valueNet: "data/value-net.json", potentialNet: "data/potential-net.json" };

/** 回のフォルダか前の回のフォルダのファイル（@/・@run:）を指す言葉か */
const inRunDir = (word: string): boolean => word.includes("@/") || word.includes("@run:");

/** 設定の JSON の中の @/・@run:（前のジョブ・前の回が作るモデル）を、確かめる間だけ今の既定のモデルにする */
export function standIn(text: string): string {
  if (!inRunDir(text)) return text;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string" && inRunDir(v)) {
      const s = STAND_INS[key];
      if (s === undefined) throw new Error(`回のフォルダのファイル（@/・@run:）は ${Object.keys(STAND_INS).join("・")} にだけ書けます: ${key}`);
      return s;
    }
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return JSON.stringify(walk(JSON.parse(text), ""));
}

/** 回す前に設定の書き間違いを見つけるための svwb の引数（0 試合の compare は設定を読むだけ。0 回の misses は設定と問題集を読むだけ。
 * データを作るジョブは 0 試合で回す）。td・potential・pick・survey は確かめない（undefined）。
 * 前のジョブが作るファイル（@/）は、モデル（--model・--vocab・--potential と設定の JSON）なら今の既定のモデルに、ほかは tmp の下の名前にする */
export function checkArgv(job: Job, tmp: string): string[] | undefined {
  const s = job.spec;
  // survey の設定の数は、ジョブの行を読むときに確かめた。AI の設定とデッキは 0 試合の compare で読む
  if (s.kind === "survey") {
    if (s.opts === "{}" && s.decks === null) return undefined;
    return ["compare", "0", standIn(s.opts), "{}", "0", ...(s.decks === null ? [] : ["--decks", s.decks]), "--no-ledger"];
  }
  if (s.kind === "node" || s.kind === "pick") return undefined;
  if (s.kind === "data") {
    const standInFor = (prev: string | undefined): string | undefined =>
      prev === "--model" || prev === "--vocab" ? STAND_INS.valueNet : prev === "--potential" ? STAND_INS.potentialNet : undefined;
    const sub = (a: string, prev: string | undefined): string =>
      a.startsWith("{") ? standIn(a) : inRunDir(a) ? (standInFor(prev) ?? join(tmp, basename(a.split("{k}").join("0")))) : a;
    const rest = s.args.map((a, i) => sub(a, s.args[i - 1]));
    return [...s.cmd, "--games", "0", s.startFlag, String(job.start), ...rest, s.outFlag, join(tmp, `check-${job.index}.tmp`)];
  }
  if (s.kind === "compare") {
    return [
      "compare",
      "0",
      standIn(s.a),
      standIn(s.b),
      "0",
      ...(s.vs === null ? [] : [s.vs]),
      ...(s.decks === null ? [] : ["--decks", s.decks]),
      ...(s.with === null ? [] : ["--with", s.with]),
      ...(s.without === null ? [] : ["--without", s.without]),
      "--no-ledger",
    ];
  }
  if (s.kind === "misses") return ["misses", "run", "--opts", standIn(s.opts), "--trials", "0", "--no-ledger"];
  const decks = s.kind === "profile" && s.decks !== null ? ["--decks", s.decks] : [];
  return ["compare", "0", standIn(s.opts), "{}", "0", ...decks, "--no-ledger"];
}

/** 設定の書き間違いを、回す前に見つける（checkArgv の引数で svwb を回す） */
function validate(bin: string, jobs: Job[]): void {
  const tmp = mkdtempSync(join(tmpdir(), "night-check-"));
  try {
    for (const job of jobs) {
      const args = checkArgv(job, tmp);
      if (args === undefined) continue;
      const r = spawnSync(bin, args, { cwd: REPO, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`ジョブ ${job.index} の設定が読めません: ${(r.stderr || r.stdout).trim()}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** td・potential のジョブがあれば、そのスクリプトをビルドして回のフォルダに置く（組み立てたときのコードで回す）。
 * nodeBin（試す用）があれば、ビルドせずにそこの <td|potential>/<td|potential>-main.mjs を写す */
function prepareNodeTools(jobs: Job[], dir: string, nodeBin: string | undefined): void {
  const tools = [...new Set(jobs.flatMap((j) => (j.spec.kind === "node" && j.spec.impl === "ts" ? [j.spec.tool] : [])))];
  if (tools.length === 0) return;
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const f of ["run-bundle.mjs", "vite-run.mjs"]) copyFileSync(join(REPO, "scripts", f), join(bin, f));
  for (const tool of tools) {
    const to = join(bin, tool);
    if (nodeBin !== undefined) {
      cpSync(join(nodeBin, tool), to, { recursive: true });
      continue;
    }
    console.log(`npm run ${tool} をビルドする…`);
    const r = spawnSync(process.execPath, [join(REPO, "scripts/vite-run.mjs"), `scripts/${tool}-main.ts`], {
      cwd: REPO,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, VITE_RUN_OUT_DIR: to },
    });
    if (r.status !== 0 || !existsSync(join(to, `${tool}-main.mjs`))) throw new Error(`${tool} のビルドが失敗しました`);
  }
}

export type QueueRun = RunRow & { queue: string; chunks: number };
export type QueueMisses = MissesRow & { queue: string; chunks: number };
export type QueueSurvey = SurveyRow & { queue: string; chunks: number };

/** 回の区切りの結果（回のフォルダか、出口の outbox.json から） */
export interface RowsSource {
  /** 済んだ区切り */
  done: Set<string>;
  /** 区切りごとの台帳の行 */
  runs: RunRow[];
  misses: MissesRow[];
  /** pick の結果（まだなら null） */
  pick: (job: Job) => PickResult | null;
  /** survey のジョブの台帳の行（全部の区切りが済んだジョブだけで呼ぶ。作れなければ null） */
  survey: (job: Job) => SurveyRow | null;
}

/** 台帳に足す行 */
export interface QueueRows {
  runs: QueueRun[];
  misses: QueueMisses[];
  surveys: QueueSurvey[];
  notes: string[];
  /** 足し終えた区切り（前から足してあったものと、今回の行に入れたもの） */
  merged: Set<string>;
}

type LedgerRows = { runs: RunRow[]; misses: MissesRow[]; surveys: SurveyRow[] };
const queueOf = (r: object): string | undefined => (r as { queue?: string }).queue;

/**
 * 台帳の行とコミットのメッセージに書く道。PC の中の回のフォルダ（/home/wk/svwb-data/night/<回>/…）を、回の名前からの道（@<回>/…）にする。
 * 共有フォルダでは、@<回>/<ファイル> は ingest が置いた data/…/<回>/ か logs/<回>/ の同じ名前（pack-run の分け方）。ほかの道は替えない
 */
export function portablePath(text: string, dir: string, name: string): string {
  if (dir === "" || !text.includes(dir)) return text;
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${esc}(?![A-Za-z0-9._-])`, "g"), `@${name}`);
}

/** 行の中の文字列（鍵も）を portablePath で書き換える */
export function portableRow<T>(row: T, dir: string, name: string): T {
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? portablePath(v, dir, name)
      : Array.isArray(v)
        ? v.map(walk)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [portablePath(k, dir, name), walk(x)]))
          : v;
  return walk(row) as T;
}

/** メッセージの道: 回のフォルダは @<回>、ホームは ~（出口の ~/svwb-data/outbox/<回> はホストでも同じ場所） */
function portableText(text: string, dir: string, name: string): string {
  const home = homedir();
  const t = portablePath(text, dir, name);
  return home.length > 1 ? t.split(`${home}/`).join("~/") : t;
}

/**
 * 回の済んだ区切りの行を、台帳に足す行にまとめる（ブランチのコミット・出口のまとめの表で同じ）。compare・yardstick は試合番号の続いたまとまりごとに 1 行、
 * misses は区切りの行に回の名前を足してそのまま、survey は全部の区切りが済んでから 1 行。merged の区切りは足さない。
 * target の台帳に同じ回の同じ行があれば足さない
 */
export function queueRows(plan: Pick<Plan, "name" | "jobs" | "chunks">, dir: string, src: RowsSource, merged: Set<string>, target: LedgerRows): QueueRows {
  const out = queueRowsRaw(plan, dir, src, merged, target);
  const p = <R>(r: R): R => portableRow(r, dir, plan.name);
  return { ...out, runs: out.runs.map(p), misses: out.misses.map(p), surveys: out.surveys.map(p), notes: out.notes.map((n) => portablePath(n, dir, plan.name)) };
}

function queueRowsRaw(plan: Pick<Plan, "name" | "jobs" | "chunks">, dir: string, src: RowsSource, merged: Set<string>, target: LedgerRows): QueueRows {
  const out: QueueRows = { runs: [], misses: [], surveys: [], notes: [], merged: new Set(merged) };
  const key = (r: { label: string; g: [number, number]; commit: string; kind: string }) => `${r.kind}\u0001${r.label}\u0001${r.g[0]}\u0001${r.g[1]}\u0001${r.commit}`;
  const have = new Set(target.runs.filter((r) => queueOf(r) === plan.name).map(key));
  const mkey = (r: MissesRow) => `${r.label}\u0001${r.commit}\u0001${r.seed}\u0001${r.trials}\u0001${r.set}`;
  const haveMisses = new Set(target.misses.filter((r) => queueOf(r) === plan.name).map(mkey));
  const haveSurveys = new Set(target.surveys.filter((r) => queueOf(r) === plan.name).map((r) => r.label));
  for (const job of plan.jobs) {
    if (job.spec.kind === "profile" || job.spec.kind === "data" || job.spec.kind === "node") continue;
    if (job.spec.kind === "pick") {
      const p = src.pick(job);
      out.notes.push(`ジョブ ${job.index}（pick）: ${p ? pickText(p) : "まだ"}`);
      continue;
    }
    if (job.spec.kind === "survey") {
      // 打ち比べ調査は、ジョブの区切りが全部済んでから svwb survey report で 1 行にまとめる（局面ごとの結果は回のフォルダの survey-<番号>.jsonl）
      const cs = plan.chunks.filter((c) => c.job === job.index);
      if (cs.every((c) => out.merged.has(c.id))) continue;
      const nDone = cs.filter((c) => src.done.has(c.id)).length;
      if (nDone < cs.length) {
        out.notes.push(`ジョブ ${job.index}（${job.label}）はまだ途中（区切り ${nDone}/${cs.length}）。続きを回してから台帳に足す`);
        continue;
      }
      if (!haveSurveys.has(job.label)) {
        const row = src.survey(job);
        if (row === null) {
          out.notes.push(`ジョブ ${job.index}（${job.label}）: survey report の行を作れなかった（台帳に足していない）`);
          continue;
        }
        out.surveys.push({ ...row, queue: plan.name, chunks: cs.length });
      }
      for (const c of cs) out.merged.add(c.id);
      continue;
    }
    if (job.spec.kind === "misses") {
      // 見落とし問題集は分けずに回すので、区切りの行に回の名前を足してそのまま写す
      for (const c of plan.chunks.filter((c) => c.job === job.index && src.done.has(c.id) && !out.merged.has(c.id))) {
        const r = rowOf(src.misses, plan, dir, c);
        if (r && !haveMisses.has(mkey(r))) out.misses.push({ ...r, queue: plan.name, chunks: 1 });
        out.merged.add(c.id);
      }
      continue;
    }
    const cs = plan.chunks.filter((c) => c.job === job.index && src.done.has(c.id) && !out.merged.has(c.id));
    const rs = cs.map((c) => rowOf(src.runs, plan, dir, c)).filter((r): r is RunRow => r !== undefined);
    for (const group of contiguous(rs)) {
      const g0 = group[0]?.g[0] ?? 0;
      const g1 = group[group.length - 1]?.g[1] ?? 0;
      const row = combineRows(group, shellLine(jobArgv(job, g0, g1 - g0 + 1, dir)), plan.name);
      if (!have.has(key(row))) out.runs.push(row);
    }
    for (const c of cs) out.merged.add(c.id);
  }
  return out;
}

/** 台帳に足す行の表（ブランチのコミット・出口のまとめ・ingest） */
export function rowsTables(plan: Pick<Plan, "jobs">, r: Pick<QueueRows, "runs" | "misses" | "surveys" | "notes">): string {
  return `${
    r.runs.length > 0
      ? markdownTable(
          ["名前", "試合", "A の勝率", "±", "区切り", "秒/試合"],
          r.runs.map((x) => [x.label, `${x.n}（g${x.g[0]}〜${x.g[1]}）`, pct(x.rate), pts(x.se), String(x.chunks), x.perGame?.toFixed(3) ?? "?"]),
        )
      : ""
  }${
    r.misses.length > 0
      ? `\n\n${markdownTable(
          ["名前", "問", "回数", "正解率", "±", "秒"],
          r.misses.map((x) => [x.label, `${x.problems}（${x.set}）`, String(x.trials), pct(x.rate), pts(x.se), x.seconds.toFixed(0)]),
        )}`
      : ""
  }${
    r.surveys.length > 0
      ? `\n\n${markdownTable(
          ["名前", "試合", "局面（打ち比べた）", "二段目で測る得", "半分で選ぶ得（8 つ）", "（上位 4 つ）", "大きなミス", "結果"],
          r.surveys.map((x) => {
            const f = (v: [number | null, number | null], k: number) => (v[0] === null ? "?" : `${v[0].toFixed(k)} ± ${(v[1] ?? 0).toFixed(k)}`);
            const i = plan.jobs.find((j) => j.label === x.label && j.spec.kind === "survey")?.index ?? "?";
            return [x.label, `${x.games}（g${x.g[0]}〜${x.g[1]}）`, `${x.positions}（${x.compared}）`, f(x.gain2, 2), f(x.gain8, 2), f(x.gain4, 2), `${x.misses}（1 試合 1 席 ${f(x.missesPerGame, 3)}）`, `survey-${i}.md`];
          }),
        )}`
      : ""
  }${r.notes.length > 0 ? `\n\n${r.notes.join("\n")}` : ""}`;
}

/** survey のジョブを svwb survey report で 1 行にまとめる（報告は survey-<番号>.md、問題集に足す候補の局面は survey-<番号>-states/、行は survey-<番号>-ledger.jsonl）。
 * 前に作った行があればそれを使う（同じ調査の結果から作り直すと、行の at だけが違ってしまう） */
function surveyReport(plan: Plan, dir: string, job: Job): SurveyRow {
  const one = join(dir, `survey-${job.index}-ledger.jsonl`);
  // 前に作った行は、その後に調査の結果が書き足されていなければ使う
  if (existsSync(one) && statSync(one).mtimeMs >= (statSync(surveyFile(dir, job), { throwIfNoEntry: false })?.mtimeMs ?? 0)) {
    const rows = parseLedger(readFileSync(one, "utf8")).surveys;
    const row = rows[rows.length - 1];
    if (row) return row;
  }
  rmSync(one, { force: true });
  const states = join(dir, `survey-${job.index}-states`);
  mkdirSync(states, { recursive: true });
  const r = spawnSync(plan.bin, ["survey", "report", surveyFile(dir, job), "--label", job.label, "--states", states], {
    cwd: plan.repo,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, SVWB_LEDGER: one, SVWB_COMMIT: plan.commit, SVWB_BRANCH: plan.branch },
  });
  if (r.status !== 0) throw new Error(`ジョブ ${job.index} の survey report が失敗しました: ${(r.stderr || r.stdout).trim()}`);
  writeFileSync(join(dir, `survey-${job.index}.md`), r.stdout);
  const rows = existsSync(one) ? parseLedger(readFileSync(one, "utf8")).surveys : [];
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`ジョブ ${job.index} の survey report が台帳の行を書きませんでした（${one}）`);
  return row;
}

/** 回のフォルダの pick の結果 */
function readPick(dir: string, job: Job): PickResult | null {
  const f = join(dir, `pick-${job.index}.json`);
  return existsSync(f) ? readJson<PickResult>(f) : null;
}

/** 台帳に行を足す（前の行が書きかけなら改行を足してから） */
function appendRows(target: string, text: string): void {
  if (text === "") return;
  if (existsSync(target)) {
    const t = readFileSync(target, "utf8");
    if (t.length > 0 && !t.endsWith("\n")) appendFileSync(target, "\n");
  }
  appendFileSync(target, text);
}

const rowsText = (r: Pick<QueueRows, "runs" | "misses" | "surveys">): string => [...r.runs, ...r.misses, ...r.surveys].map((x) => `${JSON.stringify(x)}\n`).join("");
const rowCount = (r: Pick<QueueRows, "runs" | "misses" | "surveys">): number => r.runs.length + r.misses.length + r.surveys.length;

// ---------------------------------------------------------------- 止まったときのまとめ（結果を上げるのに何も打たなくてよいように）
//
// 回の最後の task（まとめ）と、queue-push.sh の wrap --pending（一時停止した回・電源が切れた回）が、次の 2 つをする（docs/queue.md「止まったときのまとめ」）。
// 1. 台帳の行を、ブランチ night/<回の名前> にコミットする（回のコミットから枝分かれ。作業ツリーと index には触らない）。
//    ユーザーはホストで push だけをし（docker/remote-control/queue-push.sh）、スレッドは npm run queue -- ingest <回の名前> で台帳に足す
// 2. 棋譜・ログ・作ったデータとモデルを、出口のフォルダ（~/svwb-data/outbox/<回の名前>/）に .tar.gz でまとめる。要るときだけスレッドに上げ、
//    スレッドは npm run queue -- ingest <ファイル…> で共有フォルダに展開する

/** 出口の outbox.json の result */
export interface OutboxResult {
  name: string;
  commit: string;
  branch: string;
  /** 回を始めた時刻（ISO） */
  created: string;
  tz: string;
  status: Status | null;
  /** PC で見た様子と、この回の済んだ区切りを全部まとめた表 */
  summary: string;
}

/** 出口の置き場（環境変数 SVWB_OUTBOX_DIR。無ければ回の置き場の隣の outbox。既定は ~/svwb-data/outbox） */
export function outboxRoot(dir: string): string {
  return resolve(process.env.SVWB_OUTBOX_DIR || join(dirname(dirname(resolve(dir))), "outbox"));
}

/** 台帳の行を足すブランチ */
export const nightBranch = (name: string): string => `night/${name}`;

/** リポジトリの中の台帳の道 */
const LEDGER_PATH = "docs/ledger.jsonl";

/** ブランチ night/<回> を置く・取ってくる git のリポジトリ（環境変数 SVWB_NIGHT_GIT_DIR。試す用。既定は回のリポジトリ・このリポジトリ） */
const nightGitDir = (repo: string): string => process.env.SVWB_NIGHT_GIT_DIR || repo;

const EMPTY_LEDGER: LedgerRows = { runs: [], misses: [], surveys: [] };

/** 回のフォルダの今の結果（survey のジョブは、全部の区切りが済んでいれば survey report で 1 行にする。前に作った行があればそれを使う） */
function runSource(plan: Plan, dir: string): { src: RowsSource; errors: string[] } {
  const done = markers(dir);
  const surveys = new Map<number, SurveyRow>();
  const errors: string[] = [];
  for (const job of plan.jobs) {
    if (job.spec.kind !== "survey" || !plan.chunks.filter((c) => c.job === job.index).every((c) => done.has(c.id))) continue;
    try {
      surveys.set(job.index, surveyReport(plan, dir, job));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return {
    src: { done: new Set(done.keys()), runs: chunkRows(dir), misses: chunkMisses(dir), pick: (job) => readPick(dir, job), survey: (job) => surveys.get(job.index) ?? null },
    errors,
  };
}

/** この回の済んだ区切りを全部まとめた表（PC で見た様子と一緒に） */
function runSummary(plan: Plan, dir: string, src: RowsSource, errors: string[]): string {
  const tables = rowsTables(plan, queueRows(plan, dir, src, new Set(), EMPTY_LEDGER));
  const text = `${statusText(dir, { final: true })}\n\nこの回の結果（済んだ区切りをジョブごとにまとめた）\n${tables === "" ? "（まだ結果の行はありません）" : tables}${
    errors.length > 0 ? `\n\n${errors.join("\n")}` : ""
  }`;
  return portableText(text, dir, plan.name);
}

/** 回のフォルダの結果を出口のフォルダにまとめる */
export async function makeOutbox(dir: string, summary?: string): Promise<{ folder: string; files: { name: string; bytes: number }[]; total: number }> {
  const plan = readPlan(dir);
  const tz = existsSync(join(dir, "session.json")) ? readSession(dir).tz : "Asia/Tokyo";
  let text = summary;
  if (text === undefined) {
    const { src, errors } = runSource(plan, dir);
    text = runSummary(plan, dir, src, errors);
  }
  const result: OutboxResult = { name: plan.name, commit: plan.commit, branch: plan.branch, created: plan.created, tz, status: readStatus(dir), summary: text };
  writeFileSync(join(dir, "outbox-summary.md"), `${text}\n`);
  const now = new Date();
  return writeOutbox({
    dir,
    name: plan.name,
    outRoot: outboxRoot(dir),
    note: `キュー ${plan.name}（${plan.commit}）`,
    repo: `回のコミット: ${plan.commit}（ブランチ ${plan.branch}）`,
    result,
    now,
    guide: (files, total) => `${guideHead(plan.name, files, total)}\n\nまとめた時刻: ${fmtClock(now.getTime(), tz)}（${tz}）\n\n${text}\n`,
  });
}

/**
 * 台帳に、同じ回の行が既に覆っている区切り（compare・yardstick は同じ種類・名前・コミットで試合番号が入る行、misses は同じ名前・コミット・回数・シード、
 * survey は同じ名前）。まとめるたびのコミットは、ブランチの台帳が覆っている区切りを足し終えたものとして扱う
 */
export function coveredChunks(plan: Pick<Plan, "name" | "jobs" | "chunks" | "commit">, target: LedgerRows): Set<string> {
  const out = new Set<string>();
  const mine = <R extends object>(rows: R[]) => rows.filter((r) => queueOf(r) === plan.name);
  for (const job of plan.jobs) {
    const cs = plan.chunks.filter((c) => c.job === job.index);
    const s = job.spec;
    if (s.kind === "compare" || s.kind === "yardstick") {
      const rs = mine(target.runs).filter((r) => r.kind === s.kind && r.label === job.label && r.commit === plan.commit);
      for (const c of cs) if (rs.some((r) => r.g[0] <= c.first && c.first + c.count - 1 <= r.g[1])) out.add(c.id);
    } else if (s.kind === "misses") {
      if (mine(target.misses).some((r) => r.label === job.label && r.commit === plan.commit && r.seed === s.seed && r.trials === job.games)) for (const c of cs) out.add(c.id);
    } else if (s.kind === "survey") {
      if (mine(target.surveys).some((r) => r.label === job.label)) for (const c of cs) out.add(c.id);
    }
  }
  return out;
}

/** git を回す（失敗したら投げる） */
function gitIn(repo: string, args: string[], o: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", input: o.input, env: { ...process.env, ...o.env }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} が失敗しました: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** コミットに使う名前とメール。行を運ぶだけのコミットで、ブランチは公開されるので、git の設定（.env のメールなど）は使わずにいつも決まったものにする */
const NIGHT_IDENT: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "svwb queue",
  GIT_AUTHOR_EMAIL: "queue@svwb.invalid",
  GIT_COMMITTER_NAME: "svwb queue",
  GIT_COMMITTER_EMAIL: "queue@svwb.invalid",
};

/**
 * 台帳の行をブランチ night/<回の名前> にコミットする。ブランチが無ければ回のコミットから作り、あれば先に積む。
 * 足すのは、ブランチの台帳がまだ覆っていない区切りの行だけ（止まった回の続きを回した後は、残りの区切りの行）。行が無くてもコミットし、
 * メッセージに様子と結果の表を書く（スレッドが読む）。前のコミットと同じメッセージで足す行も無ければ、コミットしない
 */
export function commitNight(dir: string, summary: string, outbox: string): { branch: string; sha: string | null; rows: number } {
  const plan = readPlan(dir);
  const repo = nightGitDir(plan.gitDir ?? plan.repo);
  const branch = nightBranch(plan.name);
  const ref = `refs/heads/${branch}`;
  const tip = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo, encoding: "utf8" });
  const old = tip.status === 0 ? tip.stdout.trim() : null;
  const parent = old ?? gitIn(repo, ["rev-parse", "--verify", `${plan.commitFull ?? plan.commit.replace(/\+$/, "")}^{commit}`]).trim();
  const ledgerPath = LEDGER_PATH;
  const cur = spawnSync("git", ["show", `${parent}:${ledgerPath}`], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 30 });
  const before = cur.status === 0 ? cur.stdout : "";
  const target = parseLedger(before);
  const { src, errors } = runSource(plan, dir);
  const rows = queueRows(plan, dir, src, coveredChunks(plan, target), target);
  const n = rowCount(rows);
  const text = rowsText(rows);
  const msg = [
    `台帳: キュー ${plan.name} の結果（${n} 行、${plan.commit}）`,
    "",
    "このブランチはキューの結果の台帳の行を運ぶためのもの（PC で作った）。スレッドは npm run queue -- ingest " + plan.name + " で自分のブランチの台帳に足す。",
    `出口: ${portableText(outbox, dir, plan.name)}`,
    "",
    summary,
    ...(errors.length > 0 ? ["", ...errors.map((e) => portableText(e, dir, plan.name))] : []),
  ].join("\n");
  // 足す行が無く、様子と結果の表（1 行目と出口の行のほか）が前のコミットと同じなら、新しいことは無い
  const gist = (m: string) => m.split("\n").slice(1).filter((l) => !l.startsWith("出口: ")).join("\n").trim();
  if (old !== null && n === 0 && gist(gitIn(repo, ["log", "-1", "--format=%B", old])) === gist(msg)) return { branch, sha: null, rows: 0 };
  const content = before === "" || before.endsWith("\n") ? before + text : `${before}\n${text}`;
  const blob = gitIn(repo, ["hash-object", "-w", "--stdin"], { input: content }).trim();
  const index = join(mkdtempSync(join(tmpdir(), "night-index-")), "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    gitIn(repo, ["read-tree", parent], { env });
    gitIn(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${ledgerPath}`], { env });
    const tree = gitIn(repo, ["write-tree"], { env }).trim();
    const sha = gitIn(repo, ["commit-tree", tree, "-p", parent, "-F", "-"], { input: msg, env: NIGHT_IDENT }).trim();
    gitIn(repo, ["update-ref", "-m", `キュー ${plan.name}`, ref, sha, old ?? ""]);
    return { branch, sha, rows: n };
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}

/** 止まったときのまとめ（出口のフォルダとブランチのコミット）。どちらが失敗しても、もう一方はする */
export async function wrapUp(dir: string, log: (text: string) => void): Promise<{ outbox: string; branch: string }> {
  const plan = readPlan(dir);
  const { src, errors } = runSource(plan, dir);
  const summary = runSummary(plan, dir, src, errors);
  let outbox: string;
  try {
    const o = await makeOutbox(dir, summary);
    outbox = `${o.folder}（${o.files.length} 個、${formatBytes(o.total)}）`;
    log(`出口に置いた: ${outbox}`);
  } catch (e) {
    outbox = `まとめられなかった（${(e as Error).message}）`;
    log(`出口にまとめられなかった: ${(e as Error).message}（npm run queue -- wrap で作り直す）`);
  }
  let branch: string;
  try {
    const c = commitNight(dir, summary, outbox);
    branch = c.sha === null ? `${c.branch}（足すものは無かった）` : `${c.branch}（${c.sha.slice(0, 7)}、台帳の行 ${c.rows}）`;
    log(`台帳の行をコミットした: ${branch}`);
  } catch (e) {
    branch = `コミットできなかった（${(e as Error).message}）`;
    log(`台帳の行をコミットできなかった: ${(e as Error).message}（npm run queue -- wrap でやり直す）`);
  }
  return { outbox, branch };
}

/** 手でまとめ直す（回の最後の task と同じこと。電源が切れた回や、まとめが失敗したときに）。
 * --pending は、まとめが済んでいない回（needsWrap）を全部まとめる（queue-push.sh が push の前に流す） */
async function cmdWrap(a: Args): Promise<number> {
  known(a, ["--pending"], 1);
  const root = runsRoot(a.opts.get("--root"));
  if (a.opts.has("--pending")) {
    if (a.pos.length > 0) throw new Error("--pending には名前を渡しません");
    const dirs = listRuns(root).filter(needsWrap);
    if (dirs.length === 0) {
      console.log("まとめが済んでいない回はありません");
      return 0;
    }
    for (const dir of dirs) await wrapOne(dir);
    return 0;
  }
  const dir = findRun(root, a.pos[0]);
  if (chunkRunning(dir)) throw new Error(`区切りを回しています: ${dir}（回の最後の task がまとめる）`);
  await wrapOne(dir);
  return 0;
}

async function wrapOne(dir: string): Promise<void> {
  const tz = existsSync(join(dir, "session.json")) ? readSession(dir).tz : "Asia/Tokyo";
  console.log(`${basename(dir)} をまとめる…`);
  const r = await wrapUp(dir, (t) => log(dir, tz, t));
  const st = readStatus(dir);
  if (st !== null) writeAtomic(join(dir, "status.json"), JSON.stringify({ ...st, outbox: r.outbox, branch: r.branch }));
  console.log(`出口: ${r.outbox}\n台帳のブランチ: ${r.branch}\n上げるのはホストで docker/remote-control/queue-push.sh（push だけ）`);
}

/** 台帳の行の重なり（同じ回・種類・名前・コミットで試合番号が重なる行、misses は同じ鍵、survey は同じ名前があるか） */
function alreadyIn(row: RunRow | MissesRow | SurveyRow, target: LedgerRows): boolean {
  const q = queueOf(row);
  if (row.kind === "compare" || row.kind === "yardstick") {
    const r = row as RunRow;
    return target.runs.some((x) => queueOf(x) === q && x.kind === r.kind && x.label === r.label && x.commit === r.commit && x.g[0] <= r.g[1] && r.g[0] <= x.g[1]);
  }
  if (row.kind === "misses") {
    const r = row as MissesRow;
    return target.misses.some((x) => queueOf(x) === q && x.label === r.label && x.commit === r.commit && x.seed === r.seed && x.trials === r.trials && x.set === r.set);
  }
  return target.surveys.some((x) => queueOf(x) === q && x.label === row.label);
}

/** ブランチ night/<回> の台帳の、その回の行（ブランチの台帳の並びのまま） */
export function branchRows(ledgerText: string, name: string): { runs: QueueRun[]; misses: QueueMisses[]; surveys: QueueSurvey[] } {
  const l = parseLedger(ledgerText);
  const mine = <R extends object>(rows: R[]) => rows.filter((r) => queueOf(r) === name) as (R & { queue: string; chunks: number })[];
  return { runs: mine(l.runs), misses: mine(l.misses), surveys: mine(l.surveys) };
}

/**
 * スレッド: キューの結果を取り込む。引数が回の名前（か night/<回の名前>）なら、GitHub からそのブランチを取ってきて、台帳にまだ無い行を足す。
 * ファイルなら出口のアーカイブとして、壊れていないかを確かめて共有フォルダに展開する
 */
export async function cmdIngest(a: Args): Promise<number> {
  known(a, ["--to", "--ledger", "--remote"], Number.POSITIVE_INFINITY);
  if (a.pos.length === 0) throw new Error("回の名前（ブランチ night/<回の名前> から台帳の行を足す）か、上がった出口のファイルを渡します");
  const target = a.opts.get("--ledger") ?? (process.env.SVWB_LEDGER || DEFAULT_LEDGER);
  const remote = a.opts.get("--remote") ?? "origin";
  const repo = nightGitDir(REPO);
  const out: string[] = [];
  const notes: string[] = [];
  let ok = true;
  const files: string[] = [];
  for (const arg of a.pos) {
    if (existsSync(arg) && statSync(arg).isFile()) {
      files.push(arg);
      continue;
    }
    const name = arg.replace(/^night\//, "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      notes.push(`${arg}: ファイルでも回の名前でもありません`);
      ok = false;
      continue;
    }
    const branch = nightBranch(name);
    // 取ってきたものは refs/night/<回の名前> に置く（作業のブランチには触らない）
    const tip = `refs/night/${name}`;
    // --update-shallow: 浅いクローン（クラウド環境）どうしでも取れるように。git は断った ref があっても 0 で終わることがあるので、取れたかを確かめる
    const f = spawnSync("git", ["fetch", "--quiet", "--update-shallow", remote, `+refs/heads/${branch}:${tip}`], { cwd: repo, encoding: "utf8" });
    if (f.status === 0 && spawnSync("git", ["rev-parse", "--verify", "--quiet", `${tip}^{commit}`], { cwd: repo }).status !== 0) {
      notes.push(`${branch}: 取ってきたはずのブランチがありません: ${(f.stderr || f.stdout).trim()}`);
      ok = false;
      continue;
    }
    if (f.status !== 0) {
      notes.push(`${branch}: GitHub から取ってこられませんでした（ホストで docker/remote-control/queue-push.sh を流したか）: ${(f.stderr || f.stdout).trim()}`);
      ok = false;
      continue;
    }
    const rows = branchRows(gitIn(repo, ["show", `${tip}:${LEDGER_PATH}`]), name);
    const have = existsSync(target) ? parseLedger(readFileSync(target, "utf8")) : EMPTY_LEDGER;
    const add = {
      runs: rows.runs.filter((r) => !alreadyIn(r, have)),
      misses: rows.misses.filter((r) => !alreadyIn(r, have)),
      surveys: rows.surveys.filter((r) => !alreadyIn(r, have)),
    };
    appendRows(target, rowsText(add));
    const msg = gitIn(repo, ["log", "-1", "--format=%B", tip]).trim();
    const jobs = rows.surveys.map((r, i) => ({ index: i + 1, label: r.label, spec: { kind: "survey" } }) as unknown as Job);
    out.push(
      [
        `## ${name}（ブランチ ${branch}、${gitIn(repo, ["rev-parse", "--short=7", tip]).trim()}）`,
        "",
        `台帳（${target}）に足した行: ${rowCount(add)}（ブランチにあるこの回の行 ${rowCount(rows)}、前から台帳にあったもの ${rowCount(rows) - rowCount(add)}）`,
        rowsTables({ jobs }, { ...add, notes: [] }),
        "",
        "### PC で見た結果（ブランチの最後のコミットのメッセージ）",
        "",
        msg.split("\n").slice(2).join("\n").trim(),
      ].join("\n"),
    );
  }
  if (files.length > 0) {
    const to = resolve(a.opts.get("--to") ?? "/mnt/project-files");
    if (!existsSync(to)) throw new Error(`展開する先がありません: ${to}（--to で渡す）`);
    const r = await ingestFiles(files, to);
    if (!r.ok) ok = false;
    out.push(...r.text);
    notes.push(...r.notes);
  }
  console.log([...out, ...(notes.length > 0 ? ["", ...notes] : [])].join("\n"));
  return ok ? 0 : 1;
}

/** 上がった出口のアーカイブを、確かめて共有フォルダに展開する */
async function ingestFiles(paths: string[], to: string): Promise<{ ok: boolean; text: string[]; notes: string[] }> {
  const groups = new Map<string, { head: OutboxHead<OutboxResult>; files: string[] }>();
  const notes: string[] = [];
  let ok = true;
  for (const f of paths) {
    const h = await peekOutbox(f);
    if (h === "guide") {
      notes.push(`${f}: 出口の案内（読み飛ばした）`);
      continue;
    }
    if (h === null) {
      notes.push(`${f}: 出口のアーカイブではありません（読み飛ばした）`);
      ok = false;
      continue;
    }
    const k = `${h.name}\u0001${h.exported}`;
    const g = groups.get(k) ?? { head: h as OutboxHead<OutboxResult>, files: [] };
    g.files.push(f);
    groups.set(k, g);
  }
  const text: string[] = [];
  // 同じ回を何度もまとめたもの（止まった回の続きなど）は、古いものから順に
  for (const { head: h, files } of [...groups.values()].sort((x, y) => x.head.exported.localeCompare(y.head.exported))) {
    // 共有フォルダに同じ回のもっと新しいまとめがあれば、置き換えずに足りないものだけ置く
    const prevFile = join(to, "logs", h.name, OUTBOX_JSON);
    let overwrite = true;
    if (existsSync(prevFile)) {
      try {
        overwrite = (JSON.parse(readFileSync(prevFile, "utf8")) as OutboxHead).exported <= h.exported;
      } catch {
        // 読めなければ置き換える
      }
    }
    const parts = new Set<number>();
    const lines: string[] = [];
    let written = 0;
    let same = 0;
    let kept = 0;
    for (const f of files) {
      const r = await extractOutbox(f, h, to, overwrite);
      for (const p of r.parts) parts.add(p);
      written += r.written.length;
      same += r.same.length;
      kept += r.kept.length;
      if (r.error !== null || r.bad.length > 0) {
        ok = false;
        const why = [...(r.error === null ? [] : [r.error]), ...r.bad];
        lines.push(`壊れていた: ${f}（${why.slice(0, 5).join("・")}${why.length > 5 ? " ほか" : ""}）。上げ直して、もう一度 ingest する`);
      }
    }
    const missing = h.parts.filter((_, i) => !parts.has(i));
    if (missing.length > 0) {
      ok = false;
      lines.push(`足りない: ${missing.join("・")}（上げてから、もう一度 ingest する）`);
    }
    text.push(
      [
        `## ${h.name} の出口（${fmtClock(Date.parse(h.exported), h.result.tz)} にまとめたもの。アーカイブ ${parts.size}/${h.parts.length} 個）`,
        "",
        `共有フォルダ（${to}）: 置いた ${written}・同じ中身があった ${same}${kept > 0 ? `・新しいまとめがあるので残した ${kept}` : ""}（data/…/${h.name}/・logs/${h.name}/）`,
        ...lines,
      ].join("\n"),
    );
  }
  return { ok, text, notes };
}

// ---------------------------------------------------------------- 券（積むコマンドの 1 行。docs/queue.md「キュー（pueue）」）

/** 券の 1 語目（形を変えたら数を上げる）。svwb-queue-1 は積む券（add。止める時刻を持たない） */
export const TICKET_Q = "svwb-queue-1";
/** 前のやり方の券（go。止める時刻を持っていた。2026-11-25 に外した） */
const TICKET_OLD = "svwb-night-1";
/** ユーザーがホストで券を流すスクリプト */
export const QUEUE_SH = "~/Shadowverse-Wb-Sim/docker/remote-control/queue.sh";

/** 券: 積むものの 1 行（スレッドが plan で出し、ユーザーがホストで queue.sh add <券> を流す） */
export interface Ticket {
  name: string;
  branch: string;
  /** 回すコミット（sha の頭 12 桁） */
  commit: string;
  /** ジョブのファイル（リポジトリの根からの道） */
  jobs: string;
  threads?: number;
  /** 区切りのおよその長さ（--chunk-min） */
  chunk?: number;
  /** 計画の指紋（ほかの項目とジョブのファイルの中身の sha256 の頭 12 桁） */
  plan: string;
}

type TicketBody = Omit<Ticket, "plan">;
const TICKET_FIELDS = ["name", "branch", "commit", "jobs", "threads", "chunk"] as const;
/** ブランチとジョブのファイルの道に使えるもの（シェルで引用符が要らない） */
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

const ticketWords = (t: TicketBody): string[] => TICKET_FIELDS.flatMap((k) => (t[k] === undefined ? [] : [`${k}=${String(t[k])}`]));
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 計画の指紋。券の項目とジョブのファイルの中身から決まる（写し間違い・書き換えと、違うジョブのファイルを見つける） */
export function ticketPlan(t: TicketBody, jobsText: string): string {
  return sha256([TICKET_Q, ...ticketWords(t), `jobs-sha256=${sha256(jobsText)}`].join("\n")).slice(0, 12);
}

export const makeTicket = (t: TicketBody, jobsText: string): Ticket => ({ ...t, plan: ticketPlan(t, jobsText) });
export const ticketText = (t: Ticket): string => [TICKET_Q, ...ticketWords(t), `plan=${t.plan}`].join(" ");

/** 券を読む（語に分かれていても、1 つの文字列でもよい） */
export function parseTicket(words: string[]): Ticket {
  const ws = words.join(" ").trim().split(/\s+/).filter((w) => w !== "");
  const head = ws[0];
  if (head !== TICKET_Q) {
    if (head === TICKET_OLD) {
      throw new Error(`これは前のやり方の券（${TICKET_OLD}。queue.sh go で流していたもの）で、もう使えません。スレッドに積む券（${TICKET_Q}）を作り直してもらいます`);
    }
    if (head !== undefined && /^svwb-(night|queue)-\d+$/.test(head)) {
      throw new Error(`この券（${head}）は、このチェックアウトのキューと形が違います。ホストの ~/Shadowverse-Wb-Sim で git pull してから流します`);
    }
    throw new Error(`券ではありません（${TICKET_Q} で始まる 1 行。スレッドが出したものをそのまま渡します）`);
  }
  const kv = new Map<string, string>();
  for (const w of ws.slice(1)) {
    const i = w.indexOf("=");
    const k = i < 0 ? w : w.slice(0, i);
    if (k === "until" || k === "tz") throw new Error("積む券には止める時刻（until・tz）を書きません（止める時刻は queue.sh start --until で決める）");
    if (i < 0 || !([...TICKET_FIELDS, "plan"] as string[]).includes(k)) throw new Error(`券の読めない語: ${w}`);
    if (kv.has(k)) throw new Error(`券に ${k} が 2 つあります`);
    kv.set(k, w.slice(i + 1));
  }
  const need = (k: string): string => {
    const v = kv.get(k);
    if (v === undefined || v === "") throw new Error(`券に ${k} がありません`);
    return v;
  };
  const bad = (k: string, v: string): Error => new Error(`券の ${k} が使えない形: ${v}`);
  const name = need("name");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw bad("name", name);
  const branch = need("branch");
  if (!SAFE_PATH.test(branch) || branch.endsWith(".lock") || branch.includes("..")) throw bad("branch", branch);
  const commit = need("commit");
  if (!/^[0-9a-f]{12,40}$/.test(commit)) throw bad("commit", commit);
  const jobs = need("jobs");
  if (!SAFE_PATH.test(jobs)) throw bad("jobs", jobs);
  const threadsText = kv.get("threads");
  const chunkText = kv.get("chunk");
  const chunk = chunkText === undefined ? undefined : Number(chunkText);
  if (chunk !== undefined && !(chunk > 0 && Number.isFinite(chunk))) throw bad("chunk", chunkText ?? "");
  const plan = need("plan");
  if (!/^[0-9a-f]{12}$/.test(plan)) throw bad("plan", plan);
  return {
    name,
    branch,
    commit,
    jobs,
    ...(threadsText === undefined ? {} : { threads: intOf(threadsText, "券の threads", 1) }),
    ...(chunk === undefined ? {} : { chunk }),
    plan,
  };
}

/** 回のフォルダの ticket.txt の券（無い・前のやり方の券なら null） */
function readTicketFile(file: string): Ticket | null {
  if (!existsSync(file)) return null;
  try {
    return parseTicket([readFileSync(file, "utf8")]);
  } catch {
    return null;
  }
}

/** plan で券を作る。ジョブのファイルがリポジトリにコミットしてあり、今のコミットを push してあるときだけ（どちらかが欠けると理由を返す） */
export function ticketHere(file: string, o: Pick<TicketBody, "name" | "threads" | "chunk">, cwd: string = REPO): { ticket: Ticket } | { why: string } {
  const gitHere = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  const top = gitHere(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { why: "git のリポジトリの中で流していない" };
  const root = top.stdout.trim();
  const rel = relative(root, resolve(file)).split(sep).join("/");
  if (rel.startsWith("../") || isAbsolute(rel)) return { why: `ジョブのファイルがリポジトリの外にある（${file}。リポジトリの night/ に置いてコミットする）` };
  if (!SAFE_PATH.test(rel)) return { why: `ジョブのファイルの道に使えない文字がある（${rel}。英数字と . _ - / だけ）` };
  if (gitHere(["ls-files", "--error-unmatch", "--", rel]).status !== 0) return { why: `ジョブのファイル（${rel}）をコミットしていない` };
  if (dirtyIn(root) || gitHere(["diff", "--quiet", "HEAD", "--", rel]).status !== 0) return { why: "コミットしていない変更がある（コミットして push してから plan を流し直す）" };
  const branch = gitHere(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch === "" || branch === "HEAD" || !SAFE_PATH.test(branch)) return { why: `ブランチの上にいないか、ブランチの名前に使えない文字がある（${branch}）` };
  if (gitHere(["merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${branch}`]).status !== 0) {
    return { why: `今のコミットを origin/${branch} に push していない（push してから plan を流し直す）` };
  }
  const full = gitHere(["rev-parse", "HEAD"]).stdout.trim();
  const jobsText = gitHere(["show", `HEAD:${rel}`]).stdout;
  return {
    ticket: makeTicket(
      {
        name: o.name,
        branch,
        commit: full.slice(0, 12),
        jobs: rel,
        ...(o.threads === undefined ? {} : { threads: o.threads }),
        ...(o.chunk === undefined ? {} : { chunk: o.chunk }),
      },
      jobsText,
    ),
  };
}

/** origin の URL を、認証の要らない https の形にする（git@github.com:o/r.git → https://github.com/o/r.git。リポジトリは公開なので、コンテナに認証情報が無くても取れる） */
export function httpsRemote(url: string): string {
  const m = /^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `https://github.com/${m[1]}.git` : url.trim();
}

/** 券のコミット（全部の sha）。手元に無ければ GitHub から券のブランチを取ってくる */
function ensureCommit(repo: string, t: Ticket): string {
  const has = (): string | null => {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${t.commit}^{commit}`], { cwd: repo, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const before = has();
  if (before !== null) return before;
  const url = process.env.SVWB_NIGHT_REMOTE || httpsRemote(gitIn(repo, ["remote", "get-url", "origin"]));
  console.log(`券のコミット ${t.commit} を取ってくる（${url} のブランチ ${t.branch}）…`);
  const f = spawnSync("git", ["fetch", "--quiet", "--no-tags", "--update-shallow", url, `refs/heads/${t.branch}`], { cwd: repo, encoding: "utf8" });
  if (f.status !== 0) throw new Error(`ブランチ ${t.branch} を取ってこられませんでした: ${(f.stderr || f.stdout).trim()}`);
  const after = has();
  if (after === null) throw new Error(`券のコミット ${t.commit} がブランチ ${t.branch} にありません（スレッドに券を作り直してもらう）`);
  return after;
}

/** 券のコミットを回のフォルダの src/ に出す（git の一時の index で。/workspace の作業ツリー・index・今のブランチには触らない） */
function exportSource(repo: string, full: string, src: string): void {
  if (existsSync(src)) return;
  const tmp = `${src}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const index = join(mkdtempSync(join(tmpdir(), "night-src-")), "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    gitIn(repo, ["read-tree", full], { env });
    gitIn(repo, ["checkout-index", "--all", "--force", `--prefix=${tmp}/`], { env });
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
  renameSync(tmp, src);
}

function npmCi(src: string): void {
  console.log("券のコミットの依存が /workspace と違うので、回のソースに npm ci する（数分）…");
  const r = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: src, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    rmSync(join(src, "node_modules"), { recursive: true, force: true });
    throw new Error("回のソースの npm ci が失敗しました");
  }
}

/**
 * 回のソースの node_modules。依存（package-lock.json）が /workspace と同じなら /workspace のものを指し、違えば npm ci。
 * 組み立てのたびに確かめる: 前に /workspace を指した後に /workspace の依存が変わっていたら、指すのをやめて npm ci
 */
export function prepareNodeModules(repo: string, src: string, ci: (src: string) => void = npmCi): void {
  const nm = join(src, "node_modules");
  const lock = (d: string) => (existsSync(join(d, "package-lock.json")) ? readFileSync(join(d, "package-lock.json"), "utf8") : null);
  const same = lock(src) !== null && lock(src) === lock(repo) && existsSync(join(repo, "node_modules"));
  const st = lstatSync(nm, { throwIfNoEntry: false });
  if (st !== undefined) {
    // npm ci で入れたもの、または今も依存が同じ /workspace を指しているもの
    if (!st.isSymbolicLink() || same) return;
    unlinkSync(nm);
  } else if (same) {
    symlinkSync(join(repo, "node_modules"), nm);
    return;
  }
  ci(src);
}

// ---------------------------------------------------------------- キュー（pueue。docs/queue.md「キュー（pueue）」）
//
// 券（svwb-queue-1）を add で積むと、回のフォルダに計画を作り、組み立て・区切り・まとめを 1 つずつ pueue の task にして組 svwb に積む。
// 回す・止めるは積むことと別で、キュー全体の start（止める時刻は組 svwb-ctl に積む時刻つきの pause）と pause。
// どこまで済んだかは回のフォルダの印で決める（pueue は流すだけ）。pueue の状態が消えても、add <回の名前> で続きから積み直せる。

/** 回の task の役目（区切りの役目は区切りの番号 <ジョブ>-<k>） */
const ROLE_PREPARE = "組み立て";
const ROLE_WRAP = "まとめ";

/** 組み立て（svwb・td・potential・依存）が済んだ印 */
const readyFile = (dir: string): string => join(dir, "bin", "ready");

/** pueue の様子（つながらなければ null。pueue の無いところで status・wrap を流したとき） */
function pueueOrNull(): PStatus | null {
  try {
    return pueueStatus();
  } catch {
    return null;
  }
}

/** これから回る・回っている・止めてあるか、中断した（start が積み直す）task */
const isKept = (t: PTask): boolean => isLive(t.state) || t.state === "Killed";

/** 回の task（役目ごと）。同じ役目が 2 つ以上あれば、まだ終わっていないもの・中断したものを先に、その中で新しいもの */
export function runTasks(st: PStatus, name: string): Map<string, PTask> {
  const out = new Map<string, PTask>();
  const rank = (t: PTask) => (isLive(t.state) ? 2 : t.state === "Killed" ? 1 : 0);
  for (const t of st.tasks) {
    if (t.group !== QUEUE_GROUP) continue;
    const l = labelOf(t.label);
    if (l === null || l.run !== name) continue;
    const had = out.get(l.role);
    if (had === undefined || rank(t) >= rank(had)) out.set(l.role, t);
  }
  return out;
}

/** 積む task の形。after は同じ回の前に済ませる役目、afterIds はほかの回の task の番号 */
export interface TaskSpec {
  role: string;
  note: string;
  args: string[];
  after: string[];
  afterIds: number[];
}

/**
 * 回の済んでいない作業を、積む順の task にする（組み立て → 区切り（計画の順）→ まとめ）。全部の区切りが済んでいれば空。
 * 区切りは同じジョブの 1 つ前の区切りの後（前が失敗したら残りを飛ばす）。ジョブの最初の区切りは組み立てと、
 * そのジョブが読むファイルを作るジョブ（pick はその compare）の済んでいない区切りの後。
 * 前の回のファイル（@run:）がまだ無ければ、組み立てをそれを作る区切りの後にする（producer がその task の番号を返す。無ければ断る）
 */
export function queueSpecs(plan: Plan, dir: string, done: Set<string>, ready: boolean, producer: (ref: string) => number | null): TaskSpec[] {
  if (plan.chunks.every((c) => done.has(c.id))) return [];
  const specs: TaskSpec[] = [];
  if (!ready) {
    const afterIds: number[] = [];
    for (const job of plan.jobs) {
      for (const ref of jobRunRefs(job)) {
        if (existsSync(atDir(ref, dir))) continue;
        const id = producer(ref);
        if (id === null) throw new Error(`ジョブ ${job.index}: 前の回のファイル ${ref} がまだ無く、それを作る区切りも積まれていません`);
        afterIds.push(id);
      }
    }
    specs.push({ role: ROLE_PREPARE, note: plan.commit, args: ["prepare", dir], after: [], afterIds: [...new Set(afterIds)] });
  }
  const undone = (index: number): string[] => plan.chunks.filter((c) => c.job === index && !done.has(c.id)).map((c) => c.id);
  for (const job of plan.jobs) {
    const inputs = new Set(jobInputs(job));
    const from = new Set<number>();
    for (const j of plan.jobs) {
      if (j.index >= job.index) continue;
      if (jobProducts(j).some((f) => inputs.has(f))) from.add(j.index);
      if (job.spec.kind === "pick" && j.spec.kind === "compare" && j.label === job.spec.from) from.add(j.index);
    }
    let prev: string | null = null;
    for (const c of plan.chunks.filter((x) => x.job === job.index)) {
      if (done.has(c.id)) continue;
      const after = prev !== null ? [prev] : [...(ready ? [] : [ROLE_PREPARE]), ...[...from].flatMap(undone)];
      const note = `${job.label || jobTitle(job)}${isStep(job) ? "" : ` g${c.first}-${c.first + c.count - 1}`}`;
      specs.push({ role: c.id, note, args: ["chunk", dir, c.id], after, afterIds: [] });
      prev = c.id;
    }
  }
  specs.push({ role: ROLE_WRAP, note: "", args: ["wrap", plan.name], after: [], afterIds: [] });
  return specs;
}

/** 前の回のファイル（@run:<回>/<ファイル>）を作る区切りの、積んである task の番号 */
function runRefProducer(root: string, st: PStatus, ref: string): number | null {
  const m = /^@run:([A-Za-z0-9._-]+)\/(.+)$/.exec(ref);
  if (m === null) return null;
  const other = join(root, m[1] ?? "");
  if (!existsSync(join(other, "plan.json"))) return null;
  const op = readPlan(other);
  const file = join(other, m[2] ?? "");
  const c = op.chunks.find((x) => chunkProducts(op, other, x).includes(file));
  const t = c === undefined ? undefined : runTasks(st, op.name).get(c.id);
  return t !== undefined && isKept(t) ? t.id : null;
}

/** 回の済んでいない作業を積む（積んであるものは積み直さない）。足した数と、前から積んであった数 */
export function enqueueRun(dir: string, root: string): { added: number; kept: number } {
  const plan = readPlan(dir);
  const st = ensureGroups();
  const have = runTasks(st, plan.name);
  const specs = queueSpecs(plan, dir, new Set(markers(dir).keys()), existsSync(readyFile(dir)) && existsSync(plan.bin), (ref) => runRefProducer(root, st, ref));
  const ids = new Map<string, number>();
  let added = 0;
  let kept = 0;
  for (const sp of specs) {
    const t = have.get(sp.role);
    if (t !== undefined && isKept(t)) {
      // まとめは最後に回るように、新しく積んだものがあれば積み直す（回していなければ）
      if (sp.role === ROLE_WRAP && added > 0 && (t.state === "Queued" || t.state === "Stashed")) {
        pq(["remove", String(t.id)]);
      } else {
        ids.set(sp.role, t.id);
        kept++;
        continue;
      }
    }
    const after = sp.after.map((r) => {
      const id = ids.get(r);
      if (id === undefined) throw new Error(`内側の誤り: ${r} の task の番号がありません`);
      return id;
    });
    const id = addTask({
      group: QUEUE_GROUP,
      label: taskLabel(plan.name, sp.role, sp.note),
      command: shellLine([process.execPath, SELF, ...sp.args, "--root", root]),
      cwd: plan.repo,
      after: [...after, ...sp.afterIds],
    });
    ids.set(sp.role, id);
    added++;
  }
  return { added, kept };
}

/** キューの回の様子（1 行） */
function queueRunState(plan: Plan, tasks: Map<string, PTask> | null, done: Map<string, Marker>, tz: string): string {
  const left = plan.chunks.filter((c) => !done.has(c.id));
  if (left.length === 0) return "全部済んだ";
  if (tasks === null) return `あと ${left.length} 区切り（pueue につながらないので、積んであるかは分からない）`;
  const work = [...tasks.entries()].filter(([role]) => role !== ROLE_WRAP).map(([, t]) => t);
  const role = (t: PTask) => labelOf(t.label)?.role ?? "?";
  const running = work.find((t) => t.state === "Running");
  const paused = work.find((t) => t.state === "Paused");
  const prep = tasks.get(ROLE_PREPARE);
  const waiting = left.filter((c) => {
    const t = tasks.get(c.id);
    return t !== undefined && isLive(t.state);
  }).length;
  const killed = left.filter((c) => tasks.get(c.id)?.state === "Killed").length;
  const loose = left.length - waiting - killed;
  const parts: string[] = [];
  if (running) parts.push(`回している（${role(running)}${running.start === null ? "" : `、${fmtClock(running.start, tz)} から`}）`);
  else if (paused) parts.push(`一時停止している（${role(paused)} の途中。queue.sh start で続きから）`);
  if (prep !== undefined && (prep.state === "Failed" || prep.state === "FailedToSpawn" || prep.state === "Errored")) parts.push(`組み立てが失敗した（pueue log ${prep.id}）`);
  if (waiting > 0) parts.push(`積んである ${waiting} 区切り`);
  if (killed > 0) parts.push(`中断した ${killed} 区切り（queue.sh start で積み直す）`);
  if (loose > 0) parts.push(`積んでいない ${loose} 区切り（失敗した・取り消した。直したら queue.sh add ${plan.name} で積み直す）`);
  return parts.join("・");
}

/** キューの回の区切りが、いま回っているか（一時停止して凍っているものは回っていないとする。まとめの task は数えない） */
function chunkRunning(dir: string): boolean {
  const plan = readPlan(dir);
  if (plan.queue !== 1) return false;
  const st = pueueOrNull();
  if (st === null) return false;
  return [...runTasks(st, plan.name).entries()].some(([role, t]) => role !== ROLE_WRAP && t.state === "Running");
}

/** 残りの区切りの見込みの秒（その回で測った速さがあればそれで） */
function leftSeconds(plan: Plan, done: Map<string, Marker>, threads: number): number {
  const measured = measuredSpeed(plan, done, threads);
  return plan.chunks.filter((c) => !done.has(c.id)).reduce((s, c) => s + chunkSeconds(c, plan, measured), 0);
}

/** キュー全体の様子（キューが回っているか・止める時刻・回ごとの残り） */
export function queueOverview(root: string, st: PStatus | null = pueueOrNull(), tz = "Asia/Tokyo"): string {
  if (st === null) return "pueue につながりません（キューの様子は出せません。コンテナを作り直してから流します: ホストで docker compose up -d）";
  const g = st.groups[QUEUE_GROUP];
  const stop = st.tasks.find((t) => t.group === CTL_GROUP && t.label.startsWith(STOP_LABEL) && t.state === "Stashed" && t.enqueueAt !== null);
  const head =
    g === undefined
      ? "キュー: まだありません（最初の queue.sh add で作る）"
      : g.status === "Running"
        ? `キュー: 回っている（${stop?.enqueueAt ? `止める時刻 ${fmtClock(stop.enqueueAt, tz)}` : "止める時刻なし"}。止める: queue.sh pause）`
        : "キュー: 止まっている（回す: queue.sh start）";
  const rows: string[][] = [];
  let total = 0;
  for (const dir of listRuns(root)) {
    const plan = readPlan(dir);
    if (plan.queue !== 1) continue;
    const tasks = runTasks(st, plan.name);
    const done = markers(dir);
    const left = plan.chunks.filter((c) => !done.has(c.id)).length;
    const live = [...tasks.values()].some((t) => isKept(t));
    if (left === 0 && !live) continue;
    const session = readSession(dir);
    const secs = leftSeconds(plan, done, session.threads);
    total += secs;
    rows.push([plan.name, plan.commit, `${plan.chunks.length - left}/${plan.chunks.length}`, queueRunState(plan, tasks, done, tz), left === 0 ? "" : fmtDur(secs)]);
  }
  const table = rows.length === 0 ? "積んである回はありません" : `${markdownTable(["回", "コミット", "区切り", "状態", "残りの見込み"], rows)}\n\n残りの見込みの合計: ${fmtDur(total)}（回ごとの詳しい様子は queue.sh status <回の名前>）`;
  return `${head}\n\n${table}`;
}

/** 区切りの lock（同じ区切りが 2 つ回らないように。pueued だけが落ちて立ち上げ直ったとき、前の区切りがまだ動いていることがある） */
async function holdLock(dir: string, id: string): Promise<() => void> {
  const file = join(dir, "chunks", `${id}.lock`);
  mkdirSync(dirname(file), { recursive: true });
  let said = false;
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    const pid = Number(text);
    if (text !== "" && !lockAlive(pid)) {
      rmSync(file, { force: true });
      continue;
    }
    if (!said && text !== "") {
      console.log(`区切り ${id} を前に回したもの（pid ${pid}）がまだ動いているので、終わるのを待つ`);
      said = true;
    }
    await new Promise((r) => setTimeout(r, text === "" ? 1000 : 5000));
  }
}

const lockAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("night-main");
  } catch {
    try {
      process.kill(pid, 0);
      return !existsSync("/proc");
    } catch {
      return false;
    }
  }
};

/** 積む（コンテナの中で。ホストからは queue.sh add <券>）。券の代わりに回の名前を渡すと、その回の券で済んでいない作業を積み直す */
export async function cmdAdd(a: Args): Promise<number> {
  // --bin・--node-bin は試す用（組み立てずにこの svwb・td・potential を使う）
  known(a, ["--bin", "--node-bin"], Number.POSITIVE_INFINITY);
  const root = runsRoot(a.opts.get("--root"));
  const first = a.pos[0];
  if (first === undefined) throw new Error(`券を渡します（スレッドが出した ${TICKET_Q} で始まる 1 行）。積み直すなら回の名前`);
  let t: Ticket;
  if (a.pos.length === 1 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(first)) {
    const f = join(root, first, "ticket.txt");
    if (!existsSync(f)) throw new Error(`券で積んだ回がありません: ${join(root, first)}`);
    const had = readTicketFile(f);
    if (had === null) throw new Error(`前のやり方で回した回です: ${join(root, first)}（続きは積めない。スレッドに積む券を作ってもらう）`);
    t = had;
  } else {
    t = parseTicket(a.pos);
  }
  const repo = nightGitDir(REPO);
  const dir = join(root, t.name);
  const src = join(dir, "src");
  const ticketFile = join(dir, "ticket.txt");
  const full = ensureCommit(repo, t);
  const shown = spawnSync("git", ["show", `${full}:${t.jobs}`], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 });
  if (shown.status !== 0) throw new Error(`券のジョブのファイル ${t.jobs} が、コミット ${t.commit} にありません`);
  if (ticketPlan(t, shown.stdout) !== t.plan) {
    throw new Error("券の指紋が合いません（写すときに欠けたか、書き換わった）。スレッドが出した 1 行をそのまま流します。直らなければ、スレッドに券を作り直してもらう");
  }
  if (existsSync(dir)) {
    const had = readTicketFile(ticketFile);
    if (had === null) throw new Error(`同じ名前の回が、積む券を使わずに作ってあります: ${dir}（スレッドに名前を替えた券を作ってもらう）`);
    if (had.plan !== t.plan) throw new Error(`同じ名前の別の回があります: ${dir}（その券: ${ticketText(had)}）。スレッドに名前を替えた券を作ってもらう`);
  }
  if (!existsSync(join(dir, "plan.json"))) {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(ticketFile)) writeFileSync(ticketFile, `${ticketText(t)}\n`);
    console.log(`券のコミット ${t.commit} を ${src} に出す…`);
    exportSource(repo, full, src);
  }
  const pass = (k: string): string[] => {
    const v = a.opts.get(k);
    return v === undefined ? [] : [k, resolve(v)];
  };
  const args = [
    "enqueue",
    join(src, t.jobs),
    "--name",
    t.name,
    "--root",
    root,
    "--git-dir",
    repo,
    ...(t.threads === undefined ? [] : ["--threads", String(t.threads)]),
    ...(t.chunk === undefined ? [] : ["--chunk-min", String(t.chunk)]),
    ...pass("--bin"),
    ...pass("--node-bin"),
  ];
  const env = {
    ...process.env,
    // 台帳の行のコミットとブランチ（回のソースには .git が無い）
    SVWB_COMMIT: gitIn(repo, ["rev-parse", "--short=7", full]).trim(),
    SVWB_BRANCH: t.branch,
    // Rust のビルド結果は /workspace の置き場（コンテナではボリューム）を使い回す
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(repo, "rust", "target"),
  };
  const r = spawnSync(process.execPath, [join(src, "scripts", "night-main.ts"), ...args], { cwd: src, stdio: "inherit", env });
  return r.status ?? 1;
}

/** 回のフォルダに計画を作り（無ければ）、済んでいない作業を積む（add が回のソースで流す。手では流さない） */
async function cmdEnqueue(a: Args): Promise<number> {
  known(a, ["--name", "--root", "--git-dir", "--threads", "--chunk-min", "--bin", "--node-bin"], 1);
  const file = a.pos[0];
  const name = a.opts.get("--name");
  if (file === undefined || name === undefined) throw new Error("ジョブのファイルと --name を渡します");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error(`--name は英数字と . _ - だけ: ${name}`);
  const root = runsRoot(a.opts.get("--root"));
  const dir = join(root, name);
  if (!existsSync(join(dir, "plan.json"))) {
    const jobsText = readFileSync(file, "utf8");
    const jobs = parseJobs(jobsText);
    const machine = thisMachine();
    const session: Session = { ...sessionOf(a, machine), queue: 1 };
    const chunkMin = Number(a.opts.get("--chunk-min") ?? "7.5");
    if (!(chunkMin > 0)) throw new Error("--chunk-min は正の数");
    const g = gitState();
    const { estimates, chunks } = makePlanParts(jobs, repoLedger().runs, machine, session.threads, chunkMin, repoLedger().misses);
    const gitDirOpt = a.opts.get("--git-dir");
    const gitDir = gitDirOpt === undefined ? undefined : resolve(gitDirOpt);
    const full = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${g.commit.replace(/\+$/, "")}^{commit}`], { cwd: nightGitDir(gitDir ?? REPO), encoding: "utf8" });
    const bin = a.opts.get("--bin");
    const nodeBin = a.opts.get("--node-bin");
    const plan: Plan = {
      v: 1,
      name,
      created: new Date(session.started).toISOString(),
      repo: REPO,
      jobsFile: resolve(file),
      commit: g.commit,
      ...(full.status === 0 ? { commitFull: full.stdout.trim() } : {}),
      ...(gitDir === undefined ? {} : { gitDir }),
      branch: g.branch,
      bin: join(dir, "bin", "svwb"),
      chunkMin,
      jobs,
      estimates,
      chunks,
      queue: 1,
      ...(bin === undefined ? {} : { prebuilt: resolve(bin) }),
      ...(nodeBin === undefined ? {} : { nodeBin: resolve(nodeBin) }),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jobs.txt"), jobsText);
    writeAtomic(join(dir, "plan.json"), JSON.stringify(plan, null, 1));
    writeAtomic(join(dir, "session.json"), JSON.stringify(session));
    log(dir, session.tz, `キューの回を作った（${jobs.length} ジョブ・${chunks.length} 区切り、コミット ${g.commit}）`);
  }
  const plan = readPlan(dir);
  if (plan.queue !== 1) throw new Error(`この回はキューの回ではありません: ${dir}`);
  const session = readSession(dir);
  const done = markers(dir);
  console.log(planText(plan, { threads: session.threads, machine: session.machine, startAt: Date.now(), until: null, tz: session.tz, done, title: `キューの回 ${name}` }));
  const r = enqueueRun(dir, root);
  log(dir, session.tz, `積んだ（task ${r.added} 個。前から積んであった ${r.kept} 個）`);
  console.log(
    r.added + r.kept === 0
      ? "\nこの回は全部済んでいます。"
      : `\n積みました（task ${r.added} 個。前から積んであった ${r.kept} 個）。回すのは queue.sh start（キューの先頭から順に回る）\n`,
  );
  console.log(queueOverview(root, pueueOrNull(), session.tz));
  return 0;
}

/** 組み立て（キューの最初の task。回のソースで svwb を組み立てて回のフォルダに写し、設定の書き間違いを確かめる） */
async function cmdPrepare(a: Args): Promise<number> {
  known(a, ["--root"], 1);
  const dirArg = a.pos[0];
  if (dirArg === undefined) throw new Error("回のフォルダを渡します");
  const dir = resolve(dirArg);
  const root = runsRoot(a.opts.get("--root"));
  const plan = readPlan(dir);
  const tz = readSession(dir).tz;
  if (existsSync(readyFile(dir)) && existsSync(plan.bin)) {
    console.log("組み立ては済んでいます");
    return 0;
  }
  log(dir, tz, "組み立てを始める");
  try {
    // 回のソース（REPO）の node_modules。依存が /workspace と同じなら、そこを指す
    if (plan.gitDir !== undefined && resolve(plan.gitDir) !== REPO) prepareNodeModules(plan.gitDir, REPO);
    let bin = plan.prebuilt;
    if (bin === undefined) {
      console.log("svwb を組み立てる…");
      run(process.execPath, [join(REPO, "scripts/vite-run.mjs"), "scripts/rust-data-main.ts", "--quiet"]);
      run("cargo", ["build", "--quiet", "--release", "--manifest-path", "rust/Cargo.toml", "-p", "svwb-engine"]);
      bin = join(process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(REPO, "rust/target"), "release/svwb");
    }
    checkRunRefs(plan.jobs, root);
    validate(resolve(bin), plan.jobs);
    mkdirSync(dirname(plan.bin), { recursive: true });
    copyFileSync(resolve(bin), plan.bin);
    chmodSync(plan.bin, 0o755);
    prepareNodeTools(plan.jobs, dir, plan.nodeBin);
    writeAtomic(readyFile(dir), `${new Date().toISOString()}\n`);
  } catch (e) {
    log(dir, tz, `組み立てが失敗した: ${(e as Error).message}`);
    throw e;
  }
  log(dir, tz, "組み立てた");
  return 0;
}

/** 区切りを 1 つ回す（キューの task。済んでいれば何もしない） */
async function cmdChunk(a: Args): Promise<number> {
  known(a, ["--root"], 2);
  const [dirArg, id] = a.pos;
  if (dirArg === undefined || id === undefined) throw new Error("回のフォルダと区切りの番号を渡します");
  const dir = resolve(dirArg);
  const plan = readPlan(dir);
  const session = readSession(dir);
  const tz = session.tz;
  const c = plan.chunks.find((x) => x.id === id);
  const job = c === undefined ? undefined : plan.jobs[c.job - 1];
  if (c === undefined || job === undefined) throw new Error(`区切り ${id} がありません`);
  const release = await holdLock(dir, id);
  try {
    const failedFile = join(dir, "failed.json");
    const failed: Record<string, string> = existsSync(failedFile) ? readJson<Record<string, string>>(failedFile) : {};
    if (markers(dir).has(id)) {
      console.log(`区切り ${id} は済んでいます`);
      return 0;
    }
    if (recoverChunk(plan, session, dir, c)) return 0;
    const missing = missingInputs(job, dir);
    if (missing.length > 0) {
      failed[String(job.index)] = `入力がありません: ${missing.map((f) => basename(f)).join("・")}（前のジョブが失敗したか、済んでいない）`;
      log(dir, tz, `ジョブ ${job.index} の入力がない（${missing.map((f) => basename(f)).join("・")}）ので回さない`);
      writeAtomic(failedFile, JSON.stringify(failed));
      console.error(failed[String(job.index)]);
      return 1;
    }
    if (!existsSync(plan.bin)) throw new Error(`回す svwb がありません: ${plan.bin}（組み立てが済んでいない）`);
    const ctl: ChunkControl = { stopNow: false };
    const onSignal = () => {
      ctl.stopNow = true;
      ctl.kill?.();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    const expected = chunkSeconds(c, plan, measuredSpeed(plan, markers(dir), session.threads));
    const r = await runAndMark(plan, session, dir, c, ctl, expected);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (r.code === 0) {
      // 前に失敗した区切りをやり直して済んだら、そのジョブの失敗の書き残しを消す
      if (failed[String(job.index)] !== undefined) {
        delete failed[String(job.index)];
        writeAtomic(failedFile, JSON.stringify(failed));
      }
      const all = plan.chunks.every((x) => markers(dir).has(x.id));
      writeStatus(dir, { state: all ? "done" : "running", reason: all ? "全部の区切りが済んだ" : "", current: null });
      return 0;
    }
    if (ctl.stopNow) {
      log(dir, tz, `区切り ${id} を止めた（積み直すと回し直す）`);
      writeStatus(dir, { state: "stopped", reason: `区切り ${id} を止めた`, current: null });
      return 1;
    }
    recordFailure(plan, session, dir, c, r, failed);
    writeStatus(dir, { state: "stopped", reason: `区切り ${id} が失敗した`, current: null });
    const out = join(dir, "chunks", `${id}.log.tmp`);
    const tail = existsSync(out) ? readFileSync(out, "utf8").trimEnd().split("\n").slice(-20).join("\n") : "";
    console.error(`区切り ${id} が失敗した（終わりの状態 ${r.code ?? "?"}${r.why ? `、${r.why}` : ""}。${out}）${tail === "" ? "" : `\n${tail}`}`);
    return 1;
  } finally {
    release();
  }
}

/** キューを回す（積んである task を先頭から。止める時刻を決めると、その時刻にキューを一時停止する task を積む） */
function cmdQueueStart(a: Args): number {
  // いつ回すかはユーザーが決める（流したら回す。昼かは聞かない）。止める時刻は --until を付けたときだけ（none は付けないのと同じ）
  if (a.pos.length > 0) throw new Error("start はキューを回すだけで、ジョブのファイルは渡しません（積むのは plan が出す queue.sh add <券>）");
  known(a, ["--until", "--tz"], 0);
  const root = runsRoot(a.opts.get("--root"));
  const tz = a.opts.get("--tz") ?? "Asia/Tokyo";
  const now = Date.now();
  const untilText = a.opts.get("--until") ?? "none";
  const until = untilText === "none" ? null : parseUntil(untilText, now, tz);
  const st = ensureGroups();
  // 中断した task（電源が切れた・コンテナが止まった）を、同じ番号のまま積み直す（後ろの task はそれを待っている）
  const killed = st.tasks.filter((t) => t.group === QUEUE_GROUP && t.state === "Killed" && labelOf(t.label) !== null).map((t) => String(t.id));
  if (killed.length > 0) {
    pq(["restart", "--in-place", ...killed]);
    console.log(`中断した task を積み直した: ${killed.join(", ")}`);
  }
  // 前の止める時刻はやめる
  const old = st.tasks.filter((t) => t.group === CTL_GROUP && t.label.startsWith(STOP_LABEL) && (t.state === "Stashed" || t.state === "Queued")).map((t) => String(t.id));
  if (old.length > 0) pq(["remove", ...old]);
  if (until !== null) {
    addTask({
      group: CTL_GROUP,
      label: `${STOP_LABEL} ${fmtClock(until, tz)}`,
      command: shellLine([pueueBin(), "pause", "--group", QUEUE_GROUP]),
      cwd: REPO,
      delaySec: (until - now) / 1000,
    });
  }
  pq(["start", "--group", CTL_GROUP]);
  pq(["start", "--group", QUEUE_GROUP]);
  console.log(
    `キューを回しました。${until === null ? "止める時刻なし（全部済むか pause まで回る）" : `止める時刻 ${fmtClock(until, tz)}（${tz}）に一時停止する（回していた区切りは凍らせ、次の start で続きから）`}。\n` +
      "止める: queue.sh pause（すぐ一時停止。--wait なら回している区切りが済んでから）　様子: queue.sh status\n",
  );
  console.log(queueOverview(root, pueueOrNull(), tz));
  return 0;
}

/** キューを一時停止する（回している区切りは凍らせる。--wait なら回している区切りが済んでから止まる） */
function cmdPause(a: Args): number {
  known(a, ["--wait"], 0);
  ensureGroups();
  const wait = a.opts.has("--wait");
  pq(["pause", "--group", QUEUE_GROUP, ...(wait ? ["--wait"] : [])]);
  console.log(
    wait
      ? "回している区切りが済んだら止まります（次の区切りは始めません）。続きは queue.sh start"
      : "止めました。回していた区切りは凍らせてあり（CPU は使わないが、メモリは持ったまま）、queue.sh start で続きから回ります",
  );
  return 0;
}

/** 回の task を、まだ回していないものだけキューから外す（回のフォルダと済んだ区切りは残る。積み直すなら add <回の名前>） */
function cmdRemove(a: Args): number {
  known(a, [], 1);
  const name = a.pos[0];
  if (name === undefined) throw new Error("回の名前を渡します");
  const st = pueueStatus();
  const mine = st.tasks.filter((t) => t.group === QUEUE_GROUP && labelOf(t.label)?.run === name);
  const ids = mine.filter((t) => t.state === "Queued" || t.state === "Stashed" || t.state === "Locked" || t.state === "Killed").map((t) => String(t.id));
  const busy = mine.filter((t) => t.state === "Running" || t.state === "Paused");
  if (ids.length > 0) pq(["remove", ...ids]);
  console.log(
    `${name} の task を ${ids.length} 個外しました。${busy.length > 0 ? `回している・一時停止している task（${busy.map((t) => t.id).join(", ")}）は残しました（止めるなら pueue kill <番号>）。` : ""}積み直すなら queue.sh add ${name}`,
  );
  return 0;
}

function cmdList(a: Args): number {
  known(a, [], 0);
  const root = runsRoot(a.opts.get("--root"));
  const ps = listRuns(root).some((d) => readPlan(d).queue === 1) ? pueueOrNull() : null;
  const rows = listRuns(root).map((d) => {
    const plan = readPlan(d);
    const done = markers(d);
    const st = readStatus(d);
    return [
      plan.name,
      plan.commit,
      `${plan.chunks.filter((c) => done.has(c.id)).length}/${plan.chunks.length}`,
      plan.queue === 1
        ? `キュー: ${queueRunState(plan, ps === null ? null : runTasks(ps, plan.name), done, "Asia/Tokyo")}`
        : `前のやり方: ${st === null ? "始めていない" : st.state === "done" ? "全部済んだ" : `止まった（${st.reason || "落ちた"}）`}`,
    ];
  });
  console.log(rows.length === 0 ? `${root} に回はありません` : markdownTable(["名前", "コミット", "区切り", "状態"], rows));
  return 0;
}

const USAGE = `使い方（docs/queue.md）:
  npm run queue -- plan <ジョブのファイル> [--threads N] [--machine 名前] [--chunk-min 7.5] [--name 名前] [--at 23:00] [--until 07:00]   （見込みと積むコマンド。--until は表の見込みだけ）
  キュー（pueue。コンテナの中で。ホストからは docker/remote-control/queue.sh <同じ引数>）:
  npm run queue -- add <券|回の名前>           （積む。いつ流してもよい。回の名前なら、済んでいない作業を積み直す）
  npm run queue -- start [--until 07:00|+2h]   （キューを回す。全部済むか pause まで。--until を付ければその時刻に一時停止する）
  npm run queue -- pause [--wait]              （キューを一時停止。回している区切りは凍らせる。--wait なら済んでから止まる）
  npm run queue -- status [名前]               （名前なしはキュー全体）
  npm run queue -- remove <回の名前>           （まだ回していない task をキューから外す）
  npm run queue -- wrap [名前|--pending]       （止まったときのまとめをやり直す: 台帳の行を night/<名前> にコミットし、出口にまとめる。--pending はまとめていない回を全部）
  npm run queue -- list
  スレッドで:
  npm run queue -- ingest <回の名前|ファイル…> [--ledger 台帳] [--to /mnt/project-files]   （台帳に足す・出口のファイルを展開する）
  （回の置き場所は --root か環境変数 SVWB_NIGHT_DIR。既定は ~/svwb-data/night。出口は SVWB_OUTBOX_DIR、既定は ~/svwb-data/outbox）`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const a = parseArgs(rest);
    switch (cmd) {
      case "plan": {
        // 積む券（ユーザーがホストで queue.sh add <券> を流す。いつ流してもよく、回すのは queue.sh start。docs/queue.md「キュー（pueue）」）。
        // --at: 始める時刻、--until: 止める時刻（どちらも見込みの表だけ。券には入らない）
        known(a, ["--until", "--tz", "--threads", "--machine", "--chunk-min", "--at", "--name"], 1);
        const file = a.pos[0];
        if (file === undefined) throw new Error("ジョブのファイルを渡します");
        const jobs = parseJobs(readFileSync(file, "utf8"));
        const machine = a.opts.get("--machine") ?? thisMachine();
        const session = sessionOf(a, machine);
        const chunkMin = Number(a.opts.get("--chunk-min") ?? "7.5");
        const parts = makePlanParts(jobs, repoLedger().runs, machine, session.threads, chunkMin, repoLedger().misses);
        const at = a.opts.get("--at");
        const startAt = at === undefined ? session.started : parseUntil(at, session.started, session.tz);
        const untilText = a.opts.get("--until");
        const until = untilText === undefined ? null : parseUntil(untilText, startAt, session.tz);
        console.log(planText({ jobs, ...parts }, { threads: session.threads, machine, startAt, until, tz: session.tz, title: `キュー（${file}）` }));
        const w = wallClock(startAt, session.tz);
        const date = `${w.y}${p2(w.mo)}${p2(w.d)}`;
        const stem = basename(file).replace(/\.txt$/, "");
        const name = a.opts.get("--name") ?? (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(stem) ? `${stem}-${date}` : `q-${date}`);
        if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error(`--name は英数字と . _ - だけ: ${name}`);
        const tk = ticketHere(file, {
          name,
          ...(a.opts.has("--threads") ? { threads: session.threads } : {}),
          ...(a.opts.has("--chunk-min") ? { chunk: chunkMin } : {}),
        });
        console.log(
          "ticket" in tk
            ? `\n積むコマンド（ユーザーがホストで流す。積むだけでは回らず、回すのは queue.sh start。docs/queue.md「キュー（pueue）」）:\n${QUEUE_SH} add ${ticketText(tk.ticket)}`
            : `\n積むコマンドは出していません: ${tk.why}`,
        );
        return 0;
      }
      case "add":
        return await cmdAdd(a);
      case "enqueue":
        return await cmdEnqueue(a);
      case "prepare":
        return await cmdPrepare(a);
      case "chunk":
        return await cmdChunk(a);
      case "start":
        return cmdQueueStart(a);
      case "pause":
        return cmdPause(a);
      case "remove":
        return cmdRemove(a);
      case "status": {
        known(a, [], 1);
        const root = runsRoot(a.opts.get("--root"));
        // 名前を渡さず、キューの回があれば、キュー全体の様子
        if (a.pos.length === 0 && listRuns(root).some((d) => readPlan(d).queue === 1)) {
          console.log(queueOverview(root));
          return 0;
        }
        console.log(statusText(findRun(root, a.pos[0])));
        return 0;
      }
      case "wrap":
        return await cmdWrap(a);
      case "ingest":
        return await cmdIngest(a);
      case "list":
        return cmdList(a);
      default:
        console.log(USAGE);
        return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
    }
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
