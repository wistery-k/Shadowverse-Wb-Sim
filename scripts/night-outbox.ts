// キューの出口（docs/queue.md「止まったときのまとめ」）。worker が止まるとき、回のフォルダの結果を出口のフォルダ（~/svwb-data/outbox/<回の名前>/）に
// .tar.gz（300MB ごとに分ける）と案内（案内.txt）としてまとめる。ユーザーはそのフォルダのファイルを全部スレッドに上げ、
// スレッドは npm run queue -- ingest <ファイル…> で、壊れていないかを確かめて共有フォルダに展開する（台帳の行は night-main.ts が足す）。
// ここはファイルを選ぶ・まとめる・読む・展開するところだけ。
//
// アーカイブの中は共有フォルダと同じ形（pack-run と同じ）: data/selfplay/<名前>/・data/models/<名前>/・data/kifu/<名前>/・logs/<名前>/。
// どのアーカイブにも、先頭に logs/<名前>/outbox.json（回の結果と、全部のファイルの置き場所・何個目・sha256）、次に MANIFEST.md を入れる。

import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import { classify, formatBytes, packItems, skipReason, sortItems, type Kind, type PackItem, type Skipped } from "./pack-run-main.ts";

/** 先頭に入れる回の結果（アーカイブの中では logs/<名前>/outbox.json） */
export const OUTBOX_JSON = "outbox.json";
/** 出口のフォルダの案内。1 行目がこれで始まる（ingest は読み飛ばす） */
export const GUIDE = "案内.txt";
export const GUIDE_MARK = "キューの出口";
/** 1 つのアーカイブの大きさの上限（共有フォルダに上げやすい大きさ。環境変数 SVWB_OUTBOX_MAX_MB で替えられる） */
export const OUTBOX_MAX_MB = 300;

/** outbox.json の形（result は回の結果。形は night-main.ts の OutboxResult） */
export interface OutboxHead<R = unknown> {
  v: 1;
  kind: "night-outbox";
  name: string;
  /** まとめた時刻（ISO）。同じ回を何度もまとめたとき、新しいものを見分ける */
  exported: string;
  parts: string[];
  /** アーカイブの中のファイル（outbox.json・MANIFEST.md のほか全部）。part は何個目（0 から）、size と sha256 はアーカイブの中のもの */
  entries: { path: string; part: number; size: number; sha256: string }[];
  result: R;
}

const KIND_DIR: Record<Exclude<Kind, "logs">, string> = { selfplay: "data/selfplay", models: "data/models", kifu: "data/kifu" };

/** 入れないもの（回のフォルダの 1 段目） */
const SKIP_TOP: Record<string, string> = {
  "worker.pid": "動いている印",
  STOP: "止める印",
  bin: "回す svwb の写し",
  done: "済んだ区切りの印（outbox.json の done に入れた）",
};

/** フォルダの中のファイル（深さ 1 まで。中のフォルダは入れない） */
function filesIn(dir: string): string[] {
  return readdirSync(dir)
    .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }))
    .filter((f) => statSync(join(dir, f), { throwIfNoEntry: false })?.isFile() === true);
}

/** 先頭の数 KB（gzip なら展開した先頭） */
async function head(file: string, bytes = 65536): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const src = createReadStream(file, file.endsWith(".gz") ? {} : { start: 0, end: bytes - 1 });
  const stream = file.endsWith(".gz") ? src.pipe(createGunzip()) : src;
  try {
    for await (const c of stream) {
      chunks.push(c as Buffer);
      total += (c as Buffer).length;
      if (total >= bytes) break;
    }
  } catch {
    // 壊れた gzip は読めたところまで
  } finally {
    src.destroy();
  }
  return Buffer.concat(chunks).subarray(0, bytes).toString("utf8");
}

/**
 * 回のフォルダから出口に入れるファイルを選ぶ。1 段目のファイル（台帳の行・計画・ログ・まとめ・作ったデータとモデル・速さの報告・調査の結果）、
 * kifu/（棋譜）、chunks/（区切りごとの svwb の出力。失敗した区切りの .log.tmp も）、survey-<番号>-states/（問題集に足す候補の局面）
 */
export async function outboxItems(dir: string, name: string): Promise<{ items: PackItem[]; skipped: Skipped[] }> {
  const items: PackItem[] = [];
  const skipped: Skipped[] = [];
  const add = async (rel: string, full: string, nested: boolean) => {
    const st = statSync(full);
    const base = rel.split("/").pop() ?? rel;
    // 中のフォルダ（棋譜のほか）はログとして入れる。1 段目と kifu/ は中身で種類を決める（pack-run と同じ）
    const kind: Kind = nested && !rel.startsWith("kifu/") ? "logs" : classify(base, await head(full));
    const gzip = base.endsWith(".jsonl");
    const path = kind === "logs" ? `logs/${name}/${rel}${gzip ? ".gz" : ""}` : `${KIND_DIR[kind]}/${name}/${base}${gzip ? ".gz" : ""}`;
    items.push({ file: rel, src: full, kind, path, gzip, size: st.size, mtimeMs: st.mtimeMs });
  };
  for (const f of readdirSync(dir).sort((a, b) => a.localeCompare(b, "ja", { numeric: true }))) {
    const full = join(dir, f);
    const st = statSync(full, { throwIfNoEntry: false });
    if (st === undefined) continue;
    const why = SKIP_TOP[f];
    if (why !== undefined) {
      skipped.push({ file: st.isDirectory() ? `${f}/` : f, reason: why });
      continue;
    }
    if (st.isDirectory()) {
      if (f === "kifu" || f === "chunks" || /^survey-\d+-states$/.test(f)) {
        for (const g of filesIn(full)) {
          // 書きかけ（.tmp）は入れない。ただし失敗した区切りの出力（chunks/<区切り>.log.tmp）は入れる
          const reason = f === "chunks" ? null : skipReason(g);
          if (reason !== null) skipped.push({ file: `${f}/${g}`, reason });
          else await add(`${f}/${g}`, join(full, g), true);
        }
      } else {
        skipped.push({ file: `${f}/`, reason: "フォルダ（中は入れない）" });
      }
      continue;
    }
    if (!st.isFile()) continue;
    const reason = f === OUTBOX_JSON ? "出口の結果と同じ名前" : skipReason(f);
    if (reason !== null) {
      skipped.push({ file: f, reason });
      continue;
    }
    await add(f, full, false);
  }
  sortItems(items);
  return { items, skipped };
}

/**
 * 回のフォルダを出口のフォルダ（outRoot/<名前>/）にまとめる。作り直すときは前のものと入れ替える（途中は outRoot/.<名前>.tmp/ に書く）。
 * guide は案内の本文（ファイルの一覧の後に足す）
 */
export async function writeOutbox<R>(o: {
  dir: string;
  name: string;
  outRoot: string;
  note: string;
  repo: string;
  result: R;
  guide: (files: { name: string; bytes: number }[], total: number) => string;
  maxBytes?: number;
  now?: Date;
}): Promise<{ folder: string; files: { name: string; bytes: number }[]; total: number }> {
  const created = o.now ?? new Date();
  const folder = join(o.outRoot, o.name);
  const tmp = join(o.outRoot, `.${o.name}.tmp`);
  const old = join(o.outRoot, `.${o.name}.old`);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const envMb = Number(process.env.SVWB_OUTBOX_MAX_MB);
  const maxBytes = o.maxBytes ?? Math.floor((envMb > 0 ? envMb : OUTBOX_MAX_MB) * 1024 * 1024);
  const { items, skipped } = await outboxItems(o.dir, o.name);
  const { partFiles } = await packItems({
    name: o.name,
    note: o.note,
    dir: o.dir,
    created,
    command: "キューが止まったときに自分でまとめた（npm run queue -- wrap でも作り直せる）",
    howTo: "取り込み: スレッドで `npm run queue -- ingest <上がったファイル…>`（壊れていないかを確かめて共有フォルダの data/・logs/ に展開し、台帳に行を足す。docs/queue.md）。",
    repo: o.repo,
    items,
    skipped,
    outDir: tmp,
    maxBytes,
    head: (entries, parts) => {
      const h: OutboxHead<R> = {
        v: 1,
        kind: "night-outbox",
        name: o.name,
        exported: created.toISOString(),
        parts: [...parts],
        entries: entries.map((e) => ({ path: e.path, part: e.part, size: e.packedSize, sha256: e.packedSha256 })),
        result: o.result,
      };
      return [{ path: `logs/${o.name}/${OUTBOX_JSON}`, data: Buffer.from(JSON.stringify(h), "utf8") }];
    },
  });
  const files = partFiles.map((f) => ({ name: f, bytes: statSync(join(tmp, f)).size }));
  const total = files.reduce((s, f) => s + f.bytes, 0);
  writeFileSync(join(tmp, GUIDE), o.guide(files, total));
  if (existsSync(folder)) renameSync(folder, old);
  renameSync(tmp, folder);
  rmSync(old, { recursive: true, force: true });
  return { folder, files, total };
}

/** 出口の案内のはじめの部分（どのファイルを上げるか） */
export function guideHead(name: string, files: { name: string; bytes: number }[], total: number): string {
  return [
    `${GUIDE_MARK}: ${name}`,
    "",
    `このフォルダのファイルを全部、スレッドに上げてください（${files.length} 個、合わせて ${formatBytes(total)}。この案内も一緒に上げてかまいません）。`,
    `上げたら、スレッドに「${name} を上げた」と伝えてください。取り込みが済んだら、このフォルダは消してかまいません。`,
    "",
    ...files.map((f) => `  ${f.name}  ${formatBytes(f.bytes)}`),
  ].join("\n");
}

// ---------------------------------------------------------------- 読む

/** 流れからちょうどの長さを読む */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private readonly it: AsyncIterator<unknown>;
  constructor(src: AsyncIterable<unknown>) {
    this.it = src[Symbol.asyncIterator]();
  }
  private async fill(): Promise<void> {
    const r = await this.it.next();
    if (r.done) throw new Error("途中で切れています");
    const b = r.value as Buffer;
    this.buf = this.buf.length === 0 ? b : Buffer.concat([this.buf, b]);
  }
  async exact(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0) await this.fill();
      const k = Math.min(left, this.buf.length);
      const out = this.buf.subarray(0, k);
      this.buf = this.buf.subarray(k);
      left -= k;
      yield out;
    }
  }
}

const cstr = (b: Buffer): string => {
  const i = b.indexOf(0);
  return b.subarray(0, i < 0 ? b.length : i).toString("utf8");
};
const octal = (b: Buffer): number => {
  const t = cstr(b).trim();
  if (!/^[0-7]*$/.test(t)) throw new Error(`tar の数が読めません: ${t}`);
  return t === "" ? 0 : Number.parseInt(t, 8);
};

/** PAX の path（"<長さ> key=value\n" の並び） */
function paxPath(b: Buffer): string | null {
  let i = 0;
  let path: string | null = null;
  while (i < b.length) {
    const sp = b.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(b.subarray(i, sp).toString("ascii"));
    if (!(len > 0)) break;
    const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === "path") path = rec.slice(eq + 1);
    i += len;
  }
  return path;
}

/**
 * .tar.gz を先頭から読み、ファイルごとに each を呼ぶ（data は読み切らなくてよい。残りは読み飛ばす）。each が "stop" を返せばそこでやめる。
 * gzip でない・tar でない・途中で切れているときは投げる
 */
export async function readTarGz(file: string, each: (path: string, size: number, data: AsyncIterable<Buffer>) => Promise<void | "stop">): Promise<void> {
  const src = createReadStream(file);
  const gunzip = createGunzip();
  src.pipe(gunzip);
  const r = new ByteReader(gunzip);
  try {
    let longPath: string | null = null;
    for (;;) {
      const h = await r.exact(512);
      if (h.every((x) => x === 0)) return;
      if (h.subarray(257, 262).toString("latin1") !== "ustar") throw new Error("tar ではありません");
      const size = octal(h.subarray(124, 136));
      const type = String.fromCharCode(h[156] ?? 0);
      const pad = (512 - (size % 512)) % 512;
      if (type === "x") {
        longPath = paxPath(await r.exact(size));
        await r.exact(pad);
        continue;
      }
      const prefix = cstr(h.subarray(345, 500));
      const name = longPath ?? (prefix === "" ? cstr(h.subarray(0, 100)) : `${prefix}/${cstr(h.subarray(0, 100))}`);
      longPath = null;
      if (type !== "0" && type !== "\0") {
        // ファイルのほか（フォルダ等）は読み飛ばす
        for await (const _ of r.take(size)) void _;
        await r.exact(pad);
        continue;
      }
      const data = r.take(size);
      const res = await each(name, size, data);
      if (res === "stop") return;
      for await (const _ of data) void _;
      await r.exact(pad);
    }
  } finally {
    src.destroy();
    gunzip.destroy();
  }
}

/** ファイルが出口のアーカイブなら outbox.json を、案内なら "guide" を、どちらでもなければ null を返す */
export async function peekOutbox(file: string): Promise<OutboxHead | "guide" | null> {
  const fd = openSync(file, "r");
  const first = Buffer.alloc(256);
  let n = 0;
  try {
    n = readSync(fd, first, 0, first.length, 0);
  } finally {
    closeSync(fd);
  }
  if (n < 2 || first[0] !== 0x1f || first[1] !== 0x8b) return first.subarray(0, n).toString("utf8").replace(/^\uFEFF/, "").startsWith(GUIDE_MARK) ? "guide" : null;
  let out: OutboxHead | null = null;
  try {
    await readTarGz(file, async (path, _size, data) => {
      if (path.endsWith(`/${OUTBOX_JSON}`) && path.startsWith("logs/")) {
        const chunks: Buffer[] = [];
        for await (const c of data) chunks.push(c);
        const o = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<OutboxHead>;
        // 回の名前はフォルダの名前に使うので、start と同じ文字だけを受け付ける
        const okName = typeof o.name === "string" && /^[A-Za-z0-9._-]+$/.test(o.name) && !o.name.startsWith(".");
        if (o.kind === "night-outbox" && o.v === 1 && okName && typeof o.exported === "string" && Array.isArray(o.entries) && Array.isArray(o.parts)) out = o as OutboxHead;
      }
      return "stop";
    });
  } catch {
    return null;
  }
  return out;
}

/** アーカイブの中の道を、展開先の下の道にする（.. や絶対の道は断る） */
/** 出口のアーカイブから置いてよい場所（その回の data/selfplay・data/models・data/kifu・logs の下だけ） */
export function outboxPathAllowed(name: string, path: string): boolean {
  return [`data/selfplay/${name}/`, `data/models/${name}/`, `data/kifu/${name}/`, `logs/${name}/`].some((d) => path.startsWith(d) && path.length > d.length);
}

export function safeJoin(root: string, path: string): string {
  if (path === "" || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "")) throw new Error(`使えない道: ${path}`);
  const full = resolve(root, path);
  const rel = relative(resolve(root), full);
  if (rel.startsWith("..") || rel.startsWith(sep)) throw new Error(`使えない道: ${path}`);
  return full;
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c as Buffer);
  return h.digest("hex");
}

export interface ExtractReport {
  /** 展開したアーカイブの中のファイルがどれだったか（何個目） */
  parts: Set<number>;
  written: string[];
  /** 同じ中身が既にあったもの */
  same: string[];
  /** 違う中身が既にあって、新しいまとめではないので残したもの */
  kept: string[];
  /** 壊れていた（大きさか sha256 が合わない・途中で切れた・見つからない）もの */
  bad: string[];
  /** アーカイブが途中で壊れていたら、その理由 */
  error: string | null;
}

/**
 * 出口のアーカイブを to の下に展開する。ファイルごとに outbox.json の sha256 と比べ、合ったものだけを置く（.ingest-tmp に書いてから名前を替える）。
 * 同じ中身のファイルは書き直さない。違う中身のファイルは overwrite のときだけ置き換える（同じ回の新しいまとめ）
 */
export async function extractOutbox(file: string, h: OutboxHead, to: string, overwrite: boolean): Promise<ExtractReport> {
  const want = new Map(h.entries.map((e) => [e.path, e]));
  const rep: ExtractReport = { parts: new Set(), written: [], same: [], kept: [], bad: [], error: null };
  const seen = new Set<string>();
  let tmpNow: string | null = null;
  try {
    await readTarGz(file, async (path, size, data) => {
      const e = want.get(path);
      // outbox.json と MANIFEST.md はどのアーカイブにも同じものが入っている（sha256 は一覧に無い）
      const headFile = path === `logs/${h.name}/${OUTBOX_JSON}` || path === `logs/${h.name}/MANIFEST.md`;
      if (e === undefined && !headFile) {
        rep.bad.push(`${path}（一覧に無い）`);
        return;
      }
      // 一覧にあっても、その回の置き場所（pack-run と同じ data/…/<回の名前>/・logs/<回の名前>/）の外には置かない
      if (!outboxPathAllowed(h.name, path)) {
        if (e !== undefined) seen.add(path);
        rep.bad.push(`${path}（置けない場所）`);
        return;
      }
      if (e !== undefined) {
        seen.add(path);
        rep.parts.add(e.part);
      }
      const dest = safeJoin(to, path);
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.ingest-tmp`;
      tmpNow = tmp;
      const hash = createHash("sha256");
      const w = createWriteStream(tmp);
      let n = 0;
      for await (const c of data) {
        hash.update(c);
        n += c.length;
        if (!w.write(c)) await once(w, "drain");
      }
      w.end();
      await once(w, "finish");
      const sha = hash.digest("hex");
      if (e !== undefined && (n !== e.size || size !== e.size || sha !== e.sha256)) {
        rmSync(tmp, { force: true });
        tmpNow = null;
        rep.bad.push(`${path}（中身が合わない）`);
        return;
      }
      if (existsSync(dest)) {
        if ((await sha256Of(dest)) === sha) {
          rmSync(tmp, { force: true });
          tmpNow = null;
          rep.same.push(path);
          return;
        }
        if (!overwrite) {
          rmSync(tmp, { force: true });
          tmpNow = null;
          rep.kept.push(path);
          return;
        }
      }
      renameSync(tmp, dest);
      tmpNow = null;
      rep.written.push(path);
    });
  } catch (err) {
    rep.error = (err as Error).message;
  } finally {
    if (tmpNow !== null) rmSync(tmpNow, { force: true });
  }
  // このアーカイブに入っているはずなのに無かったもの（何個目かは、見つかったファイルから決める）
  for (const e of h.entries) if (rep.parts.has(e.part) && !seen.has(e.path)) rep.bad.push(`${e.path}（見つからない）`);
  return rep;
}
