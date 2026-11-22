// 探索 AI の既定の補正（value-net.json）と見込み（potential-net.json）を、ページに置く形にする（npm run wasm が呼ぶ。scripts/build-wasm.mjs）。
// 形と戻し方は rust/engine/src/ai/netpack.rs。重みの数を 10 進の仮数と指数に分けてバイトの面ごとに並べ、gzip で縮める（JSON の gzip より 25% ほど小さい）。
// 戻した値は JSON を解析した値とビットまで同じ（書き出す前に、全部の数をここで戻して確かめる。WASM の中の値は tests/nets.test.ts が確かめる）。
//
// 出力は src/engine/nets/<名前>.bin（ビルドの生成物なのでコミットしない）。ページは自分の分だけを読む（src/engine/wasm.ts）:
// - starter: スターターのページ（data/value-net.json・data/potential-net.json。CLI が埋め込むものと同じ）
// - azvaldt: アズヴォルト環境のページ（data/pools/azvaldt/ の補正と見込み。今は補正 R5・見込み R4）
//
//   node scripts/pack-nets.ts [--quiet]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** ページの補正の名前 → [補正, 見込み]（リポジトリの最上位からの道） */
export const NETS_SOURCES = {
  starter: ["data/value-net.json", "data/potential-net.json"],
  azvaldt: ["data/pools/azvaldt/value-net.json", "data/pools/azvaldt/potential-net.json"],
} as const;

export type NetsName = keyof typeof NETS_SOURCES;

/** 出力の道（リポジトリの最上位から） */
export const netsOutPath = (name: NetsName): string => `src/engine/nets/${name}.bin`;

const MAGIC = "SVWBNET1";
/** -0 の指数（m = 0 のとき） */
const NEG_ZERO_EXP = -32768;
/** 10^0〜10^22（どれも f64 でちょうど表せる。Rust の POW10 と同じ） */
const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/** m × 10^e（rust/engine/src/ai/netpack.rs の decode と同じ計算） */
export function decode(m: number, e: number): number {
  if (m === 0) return e === NEG_ZERO_EXP ? -0 : 0;
  if (e === 0) return m;
  if (e > 0 && e <= 22) return m * POW10[e]!;
  if (e < 0 && e >= -22) return m / POW10[-e]!;
  return Number(`${m}e${e}`);
}

/** 数を整数の仮数 m と指数 e に分ける（x を表す最も短い 10 進の数。戻して同じにならなければ投げる） */
export function split(x: number): [number, number] {
  if (!Number.isFinite(x)) throw new Error(`有限の数ではありません: ${x}`);
  let m: number;
  let e: number;
  if (x === 0) [m, e] = [0, Object.is(x, -0) ? NEG_ZERO_EXP : 0];
  else {
    const r = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential());
    if (!r) throw new Error(`数を分けられません: ${x}`);
    const frac = r[3] ?? "";
    m = Number(`${r[2]}${frac}`) * (r[1] ? -1 : 1);
    e = Number(r[4]) - frac.length;
  }
  if (x !== 0 && (!Number.isInteger(m) || Math.abs(m) > 2 ** 31 - 1 || e <= NEG_ZERO_EXP || e > 32767)) throw new Error(`仮数か指数が大きすぎます: ${x}`);
  if (!Object.is(decode(m, e), x)) throw new Error(`戻すと値が変わります: ${x}（${m}e${e}）`);
  return [m, e];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: Json | undefined): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** 数の配列にする道（rust/engine/src/ai/netpack.rs の slot と同じ名前） */
function arrayPaths(value: { [k: string]: Json }): string[] {
  const layers = (v: Json | undefined, prefix: string) => (Array.isArray(v) ? v.flatMap((_, i) => [`${prefix}.${i}.w`, `${prefix}.${i}.b`]) : []);
  const board = value["board"];
  return [
    "value.w1",
    "value.b1",
    ...layers(value["layers"], "value.layers"),
    "value.w2",
    ...(isObj(board) ? layers(board["layers"], "value.board.layers") : []),
    "potential.w1",
    "potential.b1",
    "potential.w2",
  ];
}

/** 道の配列を取り出し、元の場所を空の配列にする */
function takeArray(root: { [k: string]: Json }, path: string): number[] {
  const keys = path.split(".");
  let o: Json | undefined = root;
  for (const k of keys.slice(0, -1)) o = Array.isArray(o) ? o[Number(k)] : isObj(o) ? o[k] : undefined;
  const last = keys[keys.length - 1]!;
  if (!isObj(o) || !Array.isArray(o[last])) throw new Error(`補正の JSON に配列 ${path} がありません`);
  const xs = o[last];
  o[last] = [];
  return xs.map((x) => {
    if (typeof x !== "number") throw new Error(`${path} に数でない値があります`);
    return x;
  });
}

/** -0 があれば投げる（ヘッダの JSON に書くと 0 になるので、値が変わる） */
function checkNoNegZero(v: Json, at: string): void {
  if (typeof v === "number" && Object.is(v, -0)) throw new Error(`${at} が -0 です（ヘッダに書くと 0 になる）`);
  if (Array.isArray(v)) v.forEach((x, i) => checkNoNegZero(x, `${at}[${i}]`));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) checkNoNegZero(x, `${at}.${k}`);
}

/** 補正と見込み（JSON を解析したもの）を補正のファイルの形（gzip の前）にする */
export function packNets(value: Json, potential: Json): Uint8Array {
  if (!isObj(value) || !isObj(potential)) throw new Error("補正と見込みはオブジェクトの JSON");
  // 読みの出力（readHead）は手を選ぶのに使わない（棋譜の数え用）ので、ページには詰めない（補正の指紋にも入らない。netpack.rs の checksum）
  const { readHead: _read, ...played } = value;
  const root: { [k: string]: Json } = structuredClone({ value: played, potential });
  const paths = arrayPaths(played);
  const arrays = paths.map((p) => takeArray(root, p));
  checkNoNegZero(root, "ヘッダ");
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const head = new TextEncoder().encode(JSON.stringify({ ...root, arrays: paths.map((p, i) => [p, arrays[i]!.length]) }));
  const out = new Uint8Array(12 + head.length + n * 6);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, head.length, true);
  out.set(head, 12);
  const body = 12 + head.length;
  let i = 0;
  for (const xs of arrays) {
    for (const x of xs) {
      const [m, e] = split(x);
      const z = ((m << 1) ^ (m >> 31)) >>> 0;
      for (let k = 0; k < 4; k++) out[body + k * n + i] = (z >>> (8 * k)) & 0xff;
      out[body + 4 * n + i] = e & 0xff;
      out[body + 5 * n + i] = (e >> 8) & 0xff;
      i++;
    }
  }
  return out;
}

/** 補正のファイル（gzip したもの）を作る。中身が同じなら書き直さない。書いたら true */
export function writeNets(root: string, name: NetsName): boolean {
  const [valuePath, potentialPath] = NETS_SOURCES[name];
  const read = (p: string): Json => JSON.parse(readFileSync(join(root, p), "utf8")) as Json;
  // gzip のヘッダの時刻は 0（同じ中身なら同じファイル）
  const bytes = gzipSync(packNets(read(valuePath), read(potentialPath)), { level: 9 });
  const out = join(root, netsOutPath(name));
  if (existsSync(out) && readFileSync(out).equals(bytes)) return false;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const quiet = process.argv.includes("--quiet");
  for (const name of Object.keys(NETS_SOURCES) as NetsName[]) {
    const wrote = writeNets(root, name);
    if (!quiet) console.log(`${netsOutPath(name)}: ${wrote ? "書き出しました" : "変わっていません"}`);
  }
}
