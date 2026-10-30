// ターン途中の局面の見込み（rust/engine/src/ai/potential.rs の potentialNet）を学ぶ（npm run potential）。
// docs/ai-notes.md「ターン途中の見込みを学ぶ」
//
//   npm run potential -- train --data d1.jsonl[,d2.jsonl] --out model.json [--hidden 64] [--epochs 8] [--T 5] [--lr 0.001]
//                          [--l2 0.000001] [--batch 256] [--scale 20] [--valid 160-199] [--seed 1]
//
// データは svwb beam-gap --sample k --inputs の JSON Lines（1 行目は語彙と入力の並び、2 行目からは途中の局面 1 つずつ）。
// 同じ局面・同じ段（試合・局面・手数）の途中の局面の組ごとに、キー = そこでターンを終えた点数 v + 見込み g(x) の softmax(キー / T) が、
// 幅の広いビームでその途中の局面から届いた最善 y の softmax(y / T) に近づくように学ぶ（ListNet）。
// ネットワークは入力 → 隠れ層 1 つ（ReLU）→ 出力。学ぶ間は出力の重みを小さく持ち、scale 倍して書き出す。
// --valid の範囲の試合は学ばず、確かめに使う（損失と、組の中で届いた最善が最大の局面をキーで 1 位にした割合）。
// この 2 つは目安で、採用は beam-gap（学びに使っていない局面での取りこぼし）で決める。

import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const USAGE = `使い方: npm run potential -- train --data d1.jsonl[,d2.jsonl] --out model.json [--hidden 64] [--epochs 8] [--T 5]
  [--lr 0.001] [--l2 0.000001] [--batch 256] [--scale 20] [--valid 160-199] [--seed 1]（docs/commands.md の「potential」）`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "train") {
    console.error(USAGE);
    return 2;
  }
  const args = parseArgs(rest);
  const t0 = Date.now();
  const data = loadPotentialData(need(args, "data").split(","));
  const [lo, hi] = need(args, "valid", "160-199").split("-").map(Number);
  if (lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error("--valid は 160-199 の形");
  const { train, valid } = makeGroups(data, (game) => game >= lo && game <= hi);
  console.log(`${data.v.length} 局面・入力 ${data.nIn}、学びの組 ${train.length}・確かめの組 ${valid.length}（読み込み ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  const opts: TrainOptions = {
    hidden: num(args, "hidden", 64),
    epochs: num(args, "epochs", 8),
    T: num(args, "T", 5),
    lr: num(args, "lr", 0.001),
    l2: num(args, "l2", 1e-6),
    batch: num(args, "batch", 256),
    scale: num(args, "scale", 20),
    seed: num(args, "seed", 1),
  };
  const model = trainPotential(data, train, valid, opts, (line) => console.log(`${line}（${((Date.now() - t0) / 1000).toFixed(0)}s）`));
  const out = need(args, "out");
  writeFileSync(out, JSON.stringify(model));
  console.log(`書いた: ${out}`);
  return 0;
}

type Args = Map<string, string>;

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`引数の形が違います: ${k}`);
    m.set(k.slice(2), v);
  }
  return m;
}

function need(args: Args, k: string, fallback?: string): string {
  const v = args.get(k) ?? fallback;
  if (v === undefined) throw new Error(`--${k} がありません`);
  return v;
}

function num(args: Args, k: string, fallback: number): number {
  const s = args.get(k);
  if (s === undefined) return fallback;
  const x = Number(s);
  if (!Number.isFinite(x)) throw new Error(`--${k} は数: ${s}`);
  return x;
}

/** 学びのデータ（途中の局面ごと。入力は疎な行列の行） */
export interface PotentialData {
  vocab: string[];
  zones: string[];
  scalars: string[];
  /** 入力の数（zones × vocab + scalars） */
  nIn: number;
  /** 局面 r の入力は idx・val の rowPtr[r]〜rowPtr[r + 1] */
  rowPtr: Int32Array;
  idx: Int32Array;
  val: Float32Array;
  /** そこでターンを終えた点数 */
  v: Float64Array;
  /** 幅の広いビームでそこから届いた最善 */
  y: Float64Array;
  game: Int32Array;
  /** 同じ局面・同じ段の組の名前（ファイル・試合・局面・手数） */
  group: string[];
}

/** 型付き配列を伸ばしながら足す */
class Grow<A extends Int32Array | Float32Array | Float64Array> {
  n = 0;
  constructor(
    public a: A,
    private readonly make: (n: number) => A,
  ) {}
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = this.make(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
  done(): A {
    return this.a.slice(0, this.n) as A;
  }
}

function strings(x: unknown, what: string): string[] {
  if (!Array.isArray(x) || !x.every((s) => typeof s === "string")) throw new Error(`${what} が文字列の配列ではありません`);
  return x;
}

function field(o: Record<string, unknown>, k: string, where: string): number {
  const x = o[k];
  if (typeof x !== "number") throw new Error(`${where}: ${k} が数ではありません`);
  return x;
}

/** ファイルを 1 行ずつ読む（大きなファイルを 1 つの文字列にしない） */
function* readLines(file: string): Generator<string> {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 24);
    const dec = new StringDecoder("utf8");
    let rest = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      const parts = (rest + (n === 0 ? dec.end() : dec.write(buf.subarray(0, n)))).split("\n");
      rest = n === 0 ? "" : (parts.pop() ?? "");
      yield* parts;
      if (n === 0) return;
    }
  } finally {
    closeSync(fd);
  }
}

export function loadPotentialData(files: string[]): PotentialData {
  let head: { vocab: string[]; zones: string[]; scalars: string[] } | undefined;
  const rowPtr = new Grow(new Int32Array(1024), (n) => new Int32Array(n));
  const idx = new Grow(new Int32Array(1 << 16), (n) => new Int32Array(n));
  const val = new Grow(new Float32Array(1 << 16), (n) => new Float32Array(n));
  const v = new Grow(new Float64Array(1024), (n) => new Float64Array(n));
  const y = new Grow(new Float64Array(1024), (n) => new Float64Array(n));
  const game = new Grow(new Int32Array(1024), (n) => new Int32Array(n));
  const group: string[] = [];
  rowPtr.push(0);
  files.forEach((file, fi) => {
    const lines = readLines(file);
    const h0: unknown = JSON.parse(lines.next().value ?? "");
    if (typeof h0 !== "object" || h0 === null) throw new Error(`${file}: 1 行目が語彙と入力の並びではありません`);
    const hr = h0 as Record<string, unknown>;
    const h = { vocab: strings(hr.vocab, "vocab"), zones: strings(hr.zones, "zones"), scalars: strings(hr.scalars, "scalars") };
    if (head === undefined) head = h;
    else if (JSON.stringify(h) !== JSON.stringify(head)) throw new Error(`${file}: 語彙・入力の並びが前のファイルと違います`);
    const nIn = h.zones.length * h.vocab.length + h.scalars.length;
    let li = 1;
    for (const line of lines) {
      li++;
      if (line === "") continue;
      const r0: unknown = JSON.parse(line);
      const where = `${file}:${li}`;
      if (typeof r0 !== "object" || r0 === null) throw new Error(`${where}: 局面の行ではありません`);
      const r = r0 as Record<string, unknown>;
      const x = r.x;
      if (!Array.isArray(x)) throw new Error(`${where}: x が配列ではありません`);
      for (const e of x) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "number" || typeof e[1] !== "number" || e[0] < 0 || e[0] >= nIn) {
          throw new Error(`${where}: x の要素は [添字, 値]`);
        }
        idx.push(e[0]);
        val.push(e[1]);
      }
      rowPtr.push(idx.n);
      v.push(field(r, "v", where));
      y.push(field(r, "y", where));
      const g = field(r, "game", where);
      game.push(g);
      group.push(`${fi}/${g}/${field(r, "k", where)}/${field(r, "depth", where)}`);
    }
  });
  if (head === undefined) throw new Error("--data がありません");
  return {
    ...head,
    nIn: head.zones.length * head.vocab.length + head.scalars.length,
    rowPtr: rowPtr.done(),
    idx: idx.done(),
    val: val.done(),
    v: v.done(),
    y: y.done(),
    game: game.done(),
    group,
  };
}

/** 局面を組にまとめ、届いた最善が 2 通り以上ある組だけを学び・確かめに分けて返す（組は局面の添字の配列） */
export function makeGroups(d: PotentialData, isValid: (game: number) => boolean): { train: Int32Array[]; valid: Int32Array[] } {
  const m = new Map<string, number[]>();
  d.group.forEach((g, i) => {
    const a = m.get(g);
    if (a) a.push(i);
    else m.set(g, [i]);
  });
  const train: Int32Array[] = [], valid: Int32Array[] = [];
  for (const ids of m.values()) {
    if (ids.length < 2) continue;
    let ylo = Infinity, yhi = -Infinity;
    for (const i of ids) {
      ylo = Math.min(ylo, d.y[i]!);
      yhi = Math.max(yhi, d.y[i]!);
    }
    if (yhi - ylo <= 1e-6) continue;
    (isValid(d.game[ids[0]!]!) ? valid : train).push(Int32Array.from(ids));
  }
  return { train, valid };
}

export interface TrainOptions {
  hidden: number;
  epochs: number;
  /** softmax の温度（点数の単位） */
  T: number;
  lr: number;
  l2: number;
  /** 1 回の更新の組の数 */
  batch: number;
  /** 出力の重みの倍率 */
  scale: number;
  seed: number;
}

/** モデルのファイルの形（rust/engine/src/ai/potential.rs の RawPotentialNet） */
export interface PotentialNetModel {
  kind: "potential-net";
  version: 1;
  vocab: string[];
  zones: string[];
  scalars: string[];
  hidden: number;
  /** 入力ごとに hidden 個 */
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/** 学ぶ値（w2 は scale 倍する前） */
interface Params {
  H: number;
  w1: Float64Array;
  b1: Float64Array;
  w2: Float64Array;
}

/** 局面 r の隠れ層の入力 z（長さ H）を書き、見込み（scale 倍する前）を返す */
function forward(d: PotentialData, p: Params, r: number, z: Float64Array): number {
  const H = p.H;
  z.set(p.b1);
  for (let e = d.rowPtr[r]!; e < d.rowPtr[r + 1]!; e++) {
    const o = d.idx[e]! * H, x = d.val[e]!;
    for (let j = 0; j < H; j++) z[j]! += x * p.w1[o + j]!;
  }
  let out = 0;
  for (let j = 0; j < H; j++) if (z[j]! > 0) out += z[j]! * p.w2[j]!;
  return out;
}

/** 組の中の softmax（s を上書きする） */
function softmax(s: Float64Array): void {
  let m = -Infinity;
  for (const x of s) m = Math.max(m, x);
  let z = 0;
  for (let i = 0; i < s.length; i++) {
    s[i] = Math.exp(s[i]! - m);
    z += s[i]!;
  }
  for (let i = 0; i < s.length; i++) s[i]! /= z;
}

/** 確かめの組の損失と、届いた最善が最大の局面をキー（と終えた点数だけ）で 1 位にした割合 */
export function evaluatePotential(d: PotentialData, groups: Int32Array[], p: Params, opts: Pick<TrainOptions, "T" | "scale">): { loss: number; top1: number; top1Base: number } {
  const z = new Float64Array(p.H);
  let loss = 0, top = 0, topBase = 0;
  for (const G of groups) {
    const key = new Float64Array(G.length), q = new Float64Array(G.length);
    let yb = -Infinity;
    G.forEach((r, i) => {
      key[i] = d.v[r]! + opts.scale * forward(d, p, r, z);
      q[i] = key[i]! / opts.T;
      yb = Math.max(yb, d.y[r]!);
    });
    const t = Float64Array.from(G, (r) => d.y[r]! / opts.T);
    softmax(q);
    softmax(t);
    for (let i = 0; i < G.length; i++) loss -= t[i]! * Math.log(q[i]! + 1e-12);
    const argmax = (f: (i: number) => number): number => {
      let b = 0;
      for (let i = 1; i < G.length; i++) if (f(i) > f(b)) b = i;
      return b;
    };
    if (d.y[G[argmax((i) => key[i]!)]!]! >= yb - 1e-6) top++;
    if (d.y[G[argmax((i) => d.v[G[i]!]!)]!]! >= yb - 1e-6) topBase++;
  }
  const n = Math.max(1, groups.length);
  return { loss: loss / n, top1: top / n, top1Base: topBase / n };
}

export function trainPotential(d: PotentialData, train: Int32Array[], valid: Int32Array[], opts: TrainOptions, log: (line: string) => void): PotentialNetModel {
  const rand = mulberry32(opts.seed);
  const H = opts.hidden, D = d.nIn;
  const p: Params = {
    H,
    w1: Float64Array.from({ length: D * H }, () => gaussian(rand) * 0.05),
    b1: new Float64Array(H),
    w2: Float64Array.from({ length: H }, () => (gaussian(rand) * 0.1) / Math.sqrt(H)),
  };
  const params = [p.w1, p.b1, p.w2];
  const grads = params.map((a) => new Float64Array(a.length));
  const m1 = params.map((a) => new Float64Array(a.length));
  const m2 = params.map((a) => new Float64Array(a.length));
  const [gw1, gb1, gw2] = grads as [Float64Array, Float64Array, Float64Array];
  const report = (label: string): void => {
    if (valid.length === 0) return log(label);
    const r = evaluatePotential(d, valid, p, opts);
    log(`${label} 確かめ: 損失 ${r.loss.toFixed(4)}、1 位の当たり ${(r.top1 * 100).toFixed(1)}%（終えた点数だけなら ${(r.top1Base * 100).toFixed(1)}%）`);
  };
  report("学ぶ前");
  let step = 0;
  const order = Int32Array.from(train, (_, i) => i);
  for (let ep = 0; ep < opts.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    let lossSum = 0;
    for (let b0 = 0; b0 < order.length; b0 += opts.batch) {
      const b1 = Math.min(order.length, b0 + opts.batch);
      for (const g of grads) g.fill(0);
      for (let bi = b0; bi < b1; bi++) {
        const G = train[order[bi]!]!;
        const zs = Array.from(G, () => new Float64Array(H));
        const q = new Float64Array(G.length), t = new Float64Array(G.length);
        G.forEach((r, i) => {
          q[i] = (d.v[r]! + opts.scale * forward(d, p, r, zs[i]!)) / opts.T;
          t[i] = d.y[r]! / opts.T;
        });
        softmax(q);
        softmax(t);
        G.forEach((r, i) => {
          lossSum -= t[i]! * Math.log(q[i]! + 1e-12);
          // 損失のキーでの微分 (q − t) / T を、見込み（scale 倍する前）の微分に直す
          const dg = (opts.scale * (q[i]! - t[i]!)) / opts.T / (b1 - b0);
          const z = zs[i]!;
          for (let j = 0; j < H; j++) {
            if (z[j]! <= 0) continue;
            gw2[j]! += z[j]! * dg;
            const dh = dg * p.w2[j]!;
            gb1[j]! += dh;
            for (let e = d.rowPtr[r]!; e < d.rowPtr[r + 1]!; e++) gw1[d.idx[e]! * H + j]! += d.val[e]! * dh;
          }
        });
      }
      // Adam（重みの 2 乗の罰を勾配に足す。隠れ層の切片には足さない）
      step++;
      const c1 = 1 - 0.9 ** step, c2 = 1 - 0.999 ** step;
      params.forEach((w, k) => {
        const g = grads[k]!, a = m1[k]!, s = m2[k]!;
        const l2 = w === p.b1 ? 0 : opts.l2;
        for (let q = 0; q < w.length; q++) {
          const gq = g[q]! + l2 * w[q]!;
          a[q] = 0.9 * a[q]! + 0.1 * gq;
          s[q] = 0.999 * s[q]! + 0.001 * gq * gq;
          w[q]! -= (opts.lr * (a[q]! / c1)) / (Math.sqrt(s[q]! / c2) + 1e-8);
        }
      });
    }
    report(`${ep + 1} 回目 学びの損失 ${(lossSum / Math.max(1, train.length)).toFixed(4)}`);
  }
  return {
    kind: "potential-net",
    version: 1,
    vocab: d.vocab,
    zones: d.zones,
    scalars: d.scalars,
    hidden: H,
    w1: Array.from(p.w1),
    b1: Array.from(p.b1),
    w2: Array.from(p.w2, (x) => x * opts.scale),
    b2: 0,
  };
}
