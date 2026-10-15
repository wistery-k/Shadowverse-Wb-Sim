// エンジンと AI の本体（Rust を WASM にしたもの。rust/wasm）を読み込んで呼ぶ。
// 要求と結果は JSON の文字列で受け渡す（rust/wasm/src/lib.rs）。局面・行動は GameState・Action と同じ形の JSON。
//
// ブラウザ（画面・Worker）では、使う前に initEngine() を待つ（WASM の読み込みは非同期にしかできない）。
// Node（テスト・スクリプト）では、最初の呼び出しで src/engine/svwb.wasm を読み込む。
// svwb.wasm は npm run wasm（scripts/build-wasm.mjs）で作る（ビルドの生成物なのでコミットしない）。

/** WASM が書き出す関数（rust/wasm/src/lib.rs） */
interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  call(ptr: number, len: number): number;
  out_ptr(): number;
  out_len(): number;
}

/** 行動が今の局面で打てないときのエラー */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

let wasm: Exports | null = null;
/** 読み込み直した回数（WASM が止まると読み込み直す。AI の番号はそのたびに作り直す） */
let generation = 0;
let compiled: WebAssembly.Module | null = null;
let loading: Promise<void> | null = null;

const nodeProcess = (globalThis as { process?: NodeJS.Process }).process;
const isNode = typeof nodeProcess?.versions?.node === "string";

function instantiate(module: WebAssembly.Module): void {
  compiled = module;
  wasm = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  generation++;
}

function loadSync(): void {
  const fs = nodeProcess?.getBuiltinModule("node:fs");
  if (!fs) throw new Error("WASM を読み込めません（Node の fs が使えません）");
  if (!fs.existsSync(__SVWB_WASM_PATH__)) throw new Error(`${__SVWB_WASM_PATH__} がありません。npm run wasm で作ってください`);
  instantiate(new WebAssembly.Module(fs.readFileSync(__SVWB_WASM_PATH__)));
}

/** エンジンを使えるようにする（ブラウザでは最初に待つ。Node では待たなくてもよい） */
export function initEngine(): Promise<void> {
  if (wasm) return Promise.resolve();
  if (isNode) {
    loadSync();
    return Promise.resolve();
  }
  loading ??= compileFrom(new URL("./svwb.wasm", import.meta.url)).then(instantiate);
  return loading;
}

/** URL の WASM を読み込む（配信の Content-Type が application/wasm でなくても読めるよう、ストリーミングにはしない） */
async function compileFrom(url: URL): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname} を読み込めません（${res.status}）`);
  return WebAssembly.compile(await res.arrayBuffer());
}

function exports(): Exports {
  if (wasm) return wasm;
  if (compiled) {
    instantiate(compiled);
    return wasm as unknown as Exports;
  }
  if (isNode) {
    loadSync();
    return wasm as unknown as Exports;
  }
  throw new Error("エンジンを読み込む前に呼ばれました（initEngine() を待ってから使います）");
}

/** 今の WASM の世代（AI の番号が使えるか確かめる） */
export const engineGeneration = (): number => {
  exports();
  return generation;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readOut(w: Exports): string {
  return decoder.decode(new Uint8Array(w.memory.buffer, w.out_ptr(), w.out_len()));
}

/**
 * WASM の関数を呼ぶ（f は関数の名前、他は引数）。結果は JSON を読んだ値。
 * 不正な行動なら IllegalActionError を投げる。WASM の中で panic したら、その内容でエラーを投げ、次の呼び出しで読み込み直す
 */
export function callEngine(req: { f: string; [key: string]: unknown }): unknown {
  const w = exports();
  const bytes = encoder.encode(JSON.stringify(req));
  const ptr = w.alloc(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  let code: number;
  try {
    code = w.call(ptr, bytes.length);
  } catch (e) {
    const message = readOut(w);
    wasm = null;
    throw new Error(`エンジンが止まりました（${req.f}）: ${message || String(e)}`);
  }
  const text = readOut(w);
  if (code === 0) return JSON.parse(text) as unknown;
  if (code === 1) throw new IllegalActionError(text);
  throw new Error(text);
}
