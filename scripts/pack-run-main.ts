// 1 回分の実行の出力（自己対戦の .jsonl・学習したモデル・ログ）を、共有フォルダに上げやすい .tar.gz にまとめる（npm run pack-run）。
// 使い方と、クラウドでの展開のしかたは docs/commands.md の「pack-run」。
//
//   npm run pack-run -- <フォルダ> [--name 名前] [--note 'メモ'] [--out ~/svwb-upload] [--only selfplay,models,logs]
//                       [--include 'f*,rf*'] [--exclude 'r*'] [--max-mb 0] [--force]
//
// アーカイブの中は共有フォルダと同じ形にする（そのまま /mnt/project-files/ に展開できる）:
//   data/selfplay/<名前>/  td selfplay の自己対戦（.jsonl は 1 ファイルずつ gzip して .jsonl.gz にする）
//   data/models/<名前>/    学習した補正（"kind":"td-value-net" の .json）
//   logs/<名前>/           それ以外（.log・.sh・.txt・他の .jsonl（gzip する）など）と、中身の一覧 MANIFEST.md
// tar は自前で書く（ustar。名前が長いか ASCII 以外を含むときは PAX の path を付ける）。外部のコマンドは git だけ（無くてもよい）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export type Kind = "selfplay" | "models" | "logs";
export const KINDS: readonly Kind[] = ["selfplay", "models", "logs"];
const KIND_LABEL: Record<Kind, string> = { selfplay: "自己対戦", models: "モデル", logs: "ログ等" };

const USAGE = `使い方: npm run pack-run -- <フォルダ> [--name 名前] [--note 'メモ'] [--out ~/svwb-upload] [--only selfplay,models,logs]
                     [--include 'f*,rf*'] [--exclude 'r*'] [--max-mb 0] [--force]
（docs/commands.md の「pack-run」）`;

interface Args {
  dir: string;
  name: string | null;
  note: string | null;
  out: string;
  only: Kind[];
  include: string[];
  exclude: string[];
  /** 1 つのアーカイブの大きさの上限（バイト）。0 なら分けない */
  maxBytes: number;
  force: boolean;
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const splitList = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

export function parseArgs(argv: string[]): Args {
  const args: Args = { dir: "", name: null, note: null, out: join(homedir(), "svwb-upload"), only: [...KINDS], include: [], exclude: [], maxBytes: 0, force: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i] ?? "";
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${key} の値がありません`);
      return v;
    };
    if (key === "--name") args.name = value();
    else if (key === "--note") args.note = value();
    else if (key === "--out") args.out = resolve(expandHome(value()));
    else if (key === "--only") {
      const kinds = splitList(value());
      for (const k of kinds) if (!(KINDS as readonly string[]).includes(k)) throw new Error(`--only に使えるのは ${KINDS.join("・")}（${k} は知らない）`);
      args.only = kinds as Kind[];
    } else if (key === "--include") args.include = splitList(value());
    else if (key === "--exclude") args.exclude = splitList(value());
    else if (key === "--max-mb") {
      const mb = Number(value());
      if (!Number.isFinite(mb) || mb < 0) throw new Error("--max-mb は 0 以上の数");
      args.maxBytes = Math.floor(mb * 1024 * 1024);
    } else if (key === "--force") args.force = true;
    else if (key.startsWith("--")) throw new Error(`知らない引数: ${key}`);
    else positional.push(key);
  }
  if (positional.length !== 1) throw new Error("まとめるフォルダを 1 つ書く");
  args.dir = resolve(expandHome(positional[0] ?? ""));
  return args;
}

/** 名前はフォルダ名とファイル名に使う。区切りや Windows で使えない文字・空白を含まず、. で始まらない */
export function checkName(name: string): void {
  if (name === "" || name.length > 80 || name.startsWith(".") || /[\s/\\:*?"<>|]/.test(name)) {
    throw new Error(`名前「${name}」は使えない（空白・/ \\ : * ? " < > | を含まず、. で始まらない 80 文字以内）`);
  }
}

/** * と ? だけのワイルドカード（ファイル名に当てる） */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/** 入れないファイルなら理由を返す */
export function skipReason(file: string): string | null {
  if (file.startsWith(".")) return "隠しファイル";
  if (file.endsWith(".done")) return "終わった印（.done）";
  if (file.endsWith(".tmp")) return "書きかけ（.tmp）";
  if (file === "MANIFEST.md") return "まとめの一覧と同じ名前";
  return null;
}

/** ファイル名と先頭（gzip なら展開した先頭）から種類を決める */
export function classify(file: string, head: string): Kind {
  const base = file.endsWith(".gz") ? file.slice(0, -3) : file;
  const firstLine = head.split("\n", 1)[0] ?? "";
  if (base.endsWith(".jsonl") && /"samples"\s*:/.test(firstLine)) return "selfplay";
  if (base.endsWith(".json") && /^\s*\{\s*"kind"\s*:\s*"td-value-net"/.test(head)) return "models";
  return "logs";
}

/** アーカイブの中のパスと、gzip して入れるか（.jsonl だけ。もう .gz のものはそのまま） */
export function destination(kind: Kind, name: string, file: string): { path: string; gzip: boolean } {
  const dir = kind === "selfplay" ? `data/selfplay/${name}` : kind === "models" ? `data/models/${name}` : `logs/${name}`;
  const gzip = file.endsWith(".jsonl");
  return { path: `${dir}/${file}${gzip ? ".gz" : ""}`, gzip };
}

/** 各ファイルを何個目のアーカイブに入れるか（0 始まり）。順に詰め、上限を超えるところで次に移る（1 つで上限を超えるファイルはそれだけで 1 個） */
export function planParts(sizes: readonly number[], maxBytes: number): number[] {
  const parts: number[] = [];
  let part = 0;
  let used = 0;
  for (const size of sizes) {
    const cost = tarCost(size);
    if (maxBytes > 0 && used > 0 && used + cost > maxBytes) {
      part++;
      used = 0;
    }
    parts.push(part);
    used += cost;
  }
  return parts;
}

const tarCost = (size: number): number => 512 + Math.ceil(size / 512) * 512;

// ---- tar（ustar + PAX の path） ----

function writeOctal(h: Buffer, offset: number, length: number, n: number): void {
  const s = Math.floor(n).toString(8).padStart(length - 1, "0");
  if (s.length > length - 1) throw new Error(`tar の数の欄に入らない: ${n}`);
  h.write(s, offset, length - 1, "ascii");
  h[offset + length - 1] = 0;
}

function header(name: string, size: number, mtimeSec: number, type: "0" | "x"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtimeSec);
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, "ascii");
  h.write("ustar\u0000", 257, 6, "latin1");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8, "latin1");
  return h;
}

/** PAX の 1 行（"<長さ> key=value\n"。長さはこの行全体のバイト数） */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf8");
  let len = bodyLen + String(bodyLen).length;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, "utf8");
}

const needsPax = (path: string): boolean => Buffer.byteLength(path, "utf8") > 100 || /[^\x20-\x7e]/.test(path);
const asciiFallback = (path: string): string => path.replace(/[^\x20-\x7e]/g, "_").slice(-100);
const padding = (size: number): Buffer => Buffer.alloc((512 - (size % 512)) % 512);

class TarGzWriter {
  private readonly gz = createGzip({ level: 6 });
  private readonly done: Promise<void>;

  constructor(file: string) {
    this.done = pipeline(this.gz, createWriteStream(file));
    this.done.catch(() => undefined); // 失敗は finish で受け取る
  }

  private async write(b: Buffer): Promise<void> {
    if (!this.gz.write(b)) await once(this.gz, "drain");
  }

  private async entryHeader(path: string, size: number, mtimeSec: number): Promise<void> {
    if (size >= 8 ** 11) throw new Error(`${path} は大きすぎて入れられない（8 GB まで）`);
    if (needsPax(path)) {
      const pax = paxRecord("path", path);
      await this.write(header("PaxHeader", pax.length, mtimeSec, "x"));
      await this.write(pax);
      await this.write(padding(pax.length));
    }
    await this.write(header(needsPax(path) ? asciiFallback(path) : path, size, mtimeSec, "0"));
  }

  async addBuffer(path: string, data: Buffer, mtimeSec: number): Promise<void> {
    await this.entryHeader(path, data.length, mtimeSec);
    await this.write(data);
    await this.write(padding(data.length));
  }

  /** ファイルの先頭 size バイトを入れる（書き足されている途中でも、数えたときの大きさで切る） */
  async addFile(path: string, src: string, size: number, mtimeSec: number): Promise<void> {
    await this.entryHeader(path, size, mtimeSec);
    let written = 0;
    if (size > 0) {
      for await (const chunk of createReadStream(src, { start: 0, end: size - 1 })) {
        const b = chunk as Buffer;
        written += b.length;
        await this.write(b);
      }
    }
    if (written !== size) throw new Error(`${src} が途中で短くなった（${size} バイトのはずが ${written}）`);
    await this.write(padding(size));
  }

  async finish(): Promise<void> {
    await this.write(Buffer.alloc(1024));
    this.gz.end();
    await this.done;
  }
}

// ---- ファイルを読む ----

async function readHead(file: string, bytes = 65536): Promise<string> {
  if (!file.endsWith(".gz")) {
    const fd = openSync(file, "r");
    try {
      const b = Buffer.alloc(bytes);
      const n = readSync(fd, b, 0, bytes, 0);
      return b.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const src = createReadStream(file);
  const gunzip = createGunzip();
  src.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      const b = chunk as Buffer;
      chunks.push(b);
      total += b.length;
      if (total >= bytes) break;
    }
  } catch {
    // 壊れた gzip は読めたところまで
  } finally {
    src.destroy();
    gunzip.destroy();
  }
  return Buffer.concat(chunks).subarray(0, bytes).toString("utf8");
}

/** 先頭 size バイトの sha256 と行数。gzTo があれば gzip したものをそこに書き、その大きさも返す */
async function digest(src: string, size: number, gzTo: string | null): Promise<{ sha256: string; lines: number; packedSize: number }> {
  const hash = createHash("sha256");
  let lines = 0;
  let last = 10;
  const gz = gzTo === null ? null : createGzip({ level: 6 });
  const done = gz === null || gzTo === null ? Promise.resolve() : pipeline(gz, createWriteStream(gzTo));
  done.catch(() => undefined); // 失敗は下の await で受け取る
  if (size > 0) {
    for await (const chunk of createReadStream(src, { start: 0, end: size - 1 })) {
      const b = chunk as Buffer;
      hash.update(b);
      for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) lines++;
      last = b[b.length - 1] ?? last;
      if (gz !== null && !gz.write(b)) await once(gz, "drain");
    }
  }
  if (last !== 10) lines++;
  gz?.end();
  await done;
  return { sha256: hash.digest("hex"), lines, packedSize: gzTo === null ? size : statSync(gzTo).size };
}

// ---- 表示 ----

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function localTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（UTC${off >= 0 ? "+" : "-"}${p(Math.floor(a / 60))}:${p(a % 60)}）`;
}

function shortTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const shellQuote = (a: string): string => (/^[\w@%+=:,./~-]+$/u.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

const dateStamp = (d: Date): string => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

function gitInfo(): string {
  const git = (...a: string[]): string => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git("rev-parse", "--short", "HEAD");
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
    return `commit ${commit}（ブランチ ${branch}${dirty ? "、手元の変更あり" : ""}）`;
  } catch {
    return "（git で調べられなかった）";
  }
}

const cell = (s: string): string => s.replace(/\|/g, "\\|");

interface Entry {
  file: string;
  kind: Kind;
  path: string;
  gzip: boolean;
  size: number;
  mtimeMs: number;
  sha256: string;
  lines: number | null;
  packedSize: number;
  tmp: string | null;
  part: number;
}

interface Skipped {
  file: string;
  reason: string;
}

function manifest(o: {
  name: string;
  note: string | null;
  dir: string;
  created: Date;
  argv: string[];
  entries: readonly Entry[];
  skipped: readonly Skipped[];
  partFiles: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${o.name}`, "");
  if (o.note !== null) lines.push(o.note, "");
  lines.push(`- まとめた日時: ${localTime(o.created)}`);
  lines.push(`- 元のフォルダ: \`${o.dir}\``);
  lines.push(`- まとめたときのリポジトリ: ${gitInfo()}（データを作ったときの版とは違うことがある。作った版はログや .sh を見る）`);
  lines.push(`- まとめたコマンド: \`npm run pack-run -- ${o.argv.map(shellQuote).join(" ")}\``);
  if (o.partFiles.length > 1) {
    lines.push(`- アーカイブ: ${o.partFiles.length} 個に分けた（${o.partFiles.join("・")}）。どれにもこの一覧が入っていて、単独で展開できる`);
  } else {
    lines.push(`- アーカイブ: ${o.partFiles[0] ?? ""}`);
  }
  const count = (k: Kind): number => o.entries.filter((e) => e.kind === k).length;
  lines.push(`- ファイル: ${o.entries.length}（${KINDS.map((k) => `${KIND_LABEL[k]} ${count(k)}`).join("・")}）、元の大きさ ${formatBytes(o.entries.reduce((s, e) => s + e.size, 0))}`);
  lines.push("", "展開: `tar -xzf <アーカイブ> -C /mnt/project-files/ --skip-old-files`（共有フォルダの data/・logs/ に入る）。.jsonl.gz は `zcat` で読む。", "");
  const split = o.partFiles.length > 1;
  const zone = localTime(o.created).replace(/^.*（/, "").replace("）", "");
  lines.push(`| ファイル | 種類 | 入れた場所 | 元の大きさ | 行数 | 更新日時（${zone}） | sha256（元のファイル） |${split ? " 何個目 |" : ""}`);
  lines.push(`|---|---|---|---|---|---|---|${split ? "---|" : ""}`);
  for (const e of o.entries) {
    lines.push(
      `| ${cell(e.file)} | ${KIND_LABEL[e.kind]} | ${cell(e.path)} | ${formatBytes(e.size)} | ${e.lines ?? "—"} | ${shortTime(new Date(e.mtimeMs))} | ${e.sha256} |${split ? ` ${e.part + 1} |` : ""}`,
    );
  }
  if (o.skipped.length > 0) {
    lines.push("", "## 入れなかったもの", "");
    for (const s of o.skipped) lines.push(`- ${s.file}: ${s.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- 本体 ----

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
    if (args.name !== null) checkName(args.name);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (!existsSync(args.dir) || !statSync(args.dir).isDirectory()) {
    console.error(`フォルダが無い: ${args.dir}`);
    return 1;
  }
  const created = new Date();
  const name = args.name ?? `${basename(args.dir)}-${dateStamp(created)}`;
  try {
    checkName(name);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}（--name で名前を付ける）`);
    return 2;
  }

  // このスクリプトが作るアーカイブの名前（前のまとめ）
  const escaped = name.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const ours = (f: string): boolean => new RegExp(`^${escaped}(-\\d+of\\d+)?\\.tar\\.gz$`).test(f);
  const sameDir = resolve(args.out) === args.dir;

  // 1. ファイルを選ぶ
  const include = args.include.map(globToRegExp);
  const exclude = args.exclude.map(globToRegExp);
  const skipped: Skipped[] = [];
  const picked: { file: string; kind: Kind; size: number; mtimeMs: number }[] = [];
  const files = readdirSync(args.dir).sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  for (const file of files) {
    const full = join(args.dir, file);
    const st = statSync(full, { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (st.isDirectory()) {
      skipped.push({ file: `${file}/`, reason: "フォルダ（中は入れない）" });
      continue;
    }
    if (!st.isFile()) continue;
    const reason = sameDir && ours(file) ? "前のまとめ" : skipReason(file);
    if (reason !== null) {
      skipped.push({ file, reason });
      continue;
    }
    if (include.length > 0 && !include.some((r) => r.test(file))) {
      skipped.push({ file, reason: "--include に当たらない" });
      continue;
    }
    if (exclude.some((r) => r.test(file))) {
      skipped.push({ file, reason: "--exclude に当たった" });
      continue;
    }
    const kind = classify(file, await readHead(full));
    if (!args.only.includes(kind)) {
      skipped.push({ file, reason: `--only に無い種類（${KIND_LABEL[kind]}）` });
      continue;
    }
    picked.push({ file, kind, size: st.size, mtimeMs: st.mtimeMs });
  }
  if (picked.length === 0) {
    console.error(`入れるファイルが無い: ${args.dir}`);
    return 1;
  }
  // 小さいもの（ログ・モデル）を先に入れる（分けるとき 1 個目に揃う）
  const order: Record<Kind, number> = { logs: 0, models: 1, selfplay: 2 };
  picked.sort((a, b) => order[a.kind] - order[b.kind]);

  // 前のまとめと名前がぶつからないか
  mkdirSync(args.out, { recursive: true });
  const old = readdirSync(args.out).filter(ours);
  if (old.length > 0) {
    if (!args.force) {
      console.error(`${args.out} に同じ名前のまとめがある（${old.join("・")}）。別の --name にするか、--force で作り直す`);
      return 1;
    }
    for (const f of old) rmSync(join(args.out, f));
  }

  const now = Date.now();
  const recent = picked.filter((p) => now - p.mtimeMs < 60_000).map((p) => p.file);
  if (recent.length > 0) console.log(`注意: 1 分以内に書き換わったファイルがある（まだ書き込み中かもしれない）: ${recent.join("・")}`);

  // 2. 読む（sha256・行数。.jsonl は gzip して一時ファイルに）
  const tmpDir = mkdtempSync(join(args.out, ".pack-tmp-"));
  try {
    const entries: Entry[] = [];
    for (const p of picked) {
      const { path, gzip } = destination(p.kind, name, p.file);
      const tmp = gzip ? join(tmpDir, `${entries.length}.gz`) : null;
      const d = await digest(join(args.dir, p.file), p.size, tmp);
      const isJsonl = p.file.endsWith(".jsonl");
      entries.push({ ...p, path, gzip, sha256: d.sha256, lines: isJsonl ? d.lines : null, packedSize: d.packedSize, tmp, part: 0 });
      console.log(`  ${p.file}（${KIND_LABEL[p.kind]}）${formatBytes(p.size)}${gzip ? ` → ${formatBytes(d.packedSize)}` : ""}${isJsonl ? `、${d.lines} 行` : ""}`);
    }

    // 3. 分ける
    const parts = planParts(
      entries.map((e) => e.packedSize),
      args.maxBytes > 0 ? Math.max(1, args.maxBytes - 64 * 1024) : 0, // MANIFEST.md の分を空ける
    );
    entries.forEach((e, i) => (e.part = parts[i] ?? 0));
    const nParts = Math.max(...parts) + 1;
    const partFiles = Array.from({ length: nParts }, (_, i) => (nParts === 1 ? `${name}.tar.gz` : `${name}-${i + 1}of${nParts}.tar.gz`));
    const big = entries.filter((e) => args.maxBytes > 0 && e.packedSize > args.maxBytes);
    if (big.length > 0) console.log(`注意: 1 つで --max-mb を超えるファイルがある（そのファイルだけで 1 個にした）: ${big.map((e) => e.file).join("・")}`);

    // 4. 書く（一覧はどのアーカイブにも同じものを入れる）
    const text = manifest({ name, note: args.note, dir: args.dir, created, argv, entries, skipped, partFiles });
    for (let part = 0; part < nParts; part++) {
      const out = join(args.out, partFiles[part] ?? "");
      const w = new TarGzWriter(out);
      await w.addBuffer(`logs/${name}/MANIFEST.md`, Buffer.from(text, "utf8"), Math.floor(created.getTime() / 1000));
      for (const e of entries) {
        if (e.part !== part) continue;
        const mtime = Math.floor(e.mtimeMs / 1000);
        if (e.tmp !== null) await w.addFile(e.path, e.tmp, e.packedSize, mtime);
        else await w.addFile(e.path, join(args.dir, e.file), e.size, mtime);
      }
      await w.finish();
    }

    // 5. まとめ
    const count = (k: Kind): number => entries.filter((e) => e.kind === k).length;
    console.log("");
    console.log(`まとめた: ${entries.length} ファイル（${KINDS.map((k) => `${KIND_LABEL[k]} ${count(k)}`).join("・")}）、元の大きさ ${formatBytes(entries.reduce((s, e) => s + e.size, 0))}`);
    if (skipped.length > 0) console.log(`入れなかった: ${skipped.length} ファイル（一覧はアーカイブの logs/${name}/MANIFEST.md）`);
    console.log("できたファイル:");
    for (const f of partFiles) console.log(`  ${join(args.out, f)}  ${formatBytes(statSync(join(args.out, f)).size)}`);
    const distro = process.env.WSL_DISTRO_NAME;
    if (distro !== undefined && distro !== "" && args.out.startsWith("/")) {
      console.log(`Windows のエクスプローラーでは \\\\wsl.localhost\\${distro}${args.out.replace(/\//g, "\\")} に見えます。`);
    }
    console.log(`これをプロジェクトのファイル（共有フォルダ）に上げて、スレッドで「${name} を上げた」と伝えてください。`);
    return 0;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
