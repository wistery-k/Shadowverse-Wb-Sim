// エンジンと AI の本体（Rust を WASM にしたもの。rust/wasm）を読み込んで呼ぶ。
// 要求と結果は JSON の文字列で受け渡す（rust/wasm/src/lib.rs）。局面・行動は GameState・Action と同じ形の JSON。
//
// ブラウザ（画面・Worker）では、使う前に initEngine() を待つ（WASM の読み込みは非同期にしかできない）。
// Chrome は画面（メインスレッド）では 8MB を超える WASM の同期のインスタンス化（new WebAssembly.Instance）も許さないので、
// ブラウザではインスタンスも WebAssembly.instantiate で作る。WASM が止まったときに読み込み直す分は、画面では先に作っておく。
// ブラウザが読み込むのは gzip で縮めた svwb.wasm.gz で、DecompressionStream で戻す。WASM は 10MB ほどあり（大半は埋め込んだ AI の学習データ）、
// 配信（GitHub Pages）が WASM を縮めて送るとは限らないため。縮めると 3.5MB ほどになる。
// Node（テスト・スクリプト）では、最初の呼び出しで src/engine/svwb.wasm を読み込む。
// svwb.wasm・svwb.wasm.gz は npm run wasm（scripts/build-wasm.mjs）で作る（ビルドの生成物なのでコミットしない）。

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
/** 画面で、WASM が止まったときに入れ替えるインスタンス（prepareSpare で先に作っておく） */
let spare: WebAssembly.Instance | null = null;
let spareLoading = false;

const nodeProcess = (globalThis as { process?: NodeJS.Process }).process;
const isNode = typeof nodeProcess?.versions?.node === "string";
/** 画面（メインスレッド）か。ここでは 8MB を超える WASM を同期でインスタンス化できない（Worker と Node ではできる） */
const isMainThread = !isNode && typeof document !== "undefined";

function use(instance: WebAssembly.Instance): void {
  wasm = instance.exports as unknown as Exports;
  generation++;
}

/** 画面では、WASM が止まったときのために次のインスタンスを非同期で作っておく */
function prepareSpare(): void {
  if (!isMainThread || !compiled || spare || spareLoading) return;
  spareLoading = true;
  WebAssembly.instantiate(compiled, {}).then(
    (instance) => {
      spare = instance;
      spareLoading = false;
    },
    () => {
      spareLoading = false;
    },
  );
}

/** 止まった WASM を読み込み直す。画面では先に作っておいたインスタンスに入れ替える */
function reload(module: WebAssembly.Module): void {
  if (spare) {
    use(spare);
    spare = null;
    prepareSpare();
    return;
  }
  if (isMainThread) {
    prepareSpare();
    throw new Error("エンジンを読み込み直しています。少し待ってからやり直してください");
  }
  use(new WebAssembly.Instance(module, {}));
}

function loadSync(): void {
  const fs = nodeProcess?.getBuiltinModule("node:fs");
  if (!fs) throw new Error("WASM を読み込めません（Node の fs が使えません）");
  if (!fs.existsSync(__SVWB_WASM_PATH__)) throw new Error(`${__SVWB_WASM_PATH__} がありません。npm run wasm で作ってください`);
  compiled = new WebAssembly.Module(fs.readFileSync(__SVWB_WASM_PATH__));
  use(new WebAssembly.Instance(compiled, {}));
}

/** fetch で受け取るバイト列 */
type Bytes = Uint8Array<ArrayBuffer>;

/** 読み込みの進み具合（受け取ったバイト数と、分かれば全体のバイト数。分からなければ 0） */
export type LoadProgress = (loaded: number, total: number) => void;

/**
 * エンジンを使えるようにする（ブラウザでは最初に待つ。Node では待たなくてもよい）。
 * onProgress は WASM を受け取るたびに呼ぶ（画面で読み込み中の表示を出すため。2 回目からの呼び出しでは使わない）
 */
export function initEngine(onProgress?: LoadProgress): Promise<void> {
  if (wasm) return Promise.resolve();
  if (isNode) {
    loadSync();
    return Promise.resolve();
  }
  loading ??= loadFrom(new URL("./svwb.wasm.gz", import.meta.url), onProgress);
  return loading;
}

/**
 * URL の gzip で縮めた WASM を非同期で読み込む。受け取りながら戻してコンパイルする（WebAssembly.compileStreaming）。
 * 配信が Content-Encoding: gzip を付けてブラウザが先に戻した場合も読めるよう、先頭の印（gzip は 1f 8b）を見て戻すかを決める
 */
async function loadFrom(url: URL, onProgress?: LoadProgress): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url.pathname} を読み込めません（${res.status}）`);
  let body: ReadableStream<Bytes> = res.body;
  if (onProgress) {
    const total = Number(res.headers.get("Content-Length")) || 0;
    let loaded = 0;
    body = body.pipeThrough(
      new TransformStream<Bytes, Bytes>({
        transform(chunk, out) {
          loaded += chunk.byteLength;
          onProgress(loaded, total);
          out.enqueue(chunk);
        },
      }),
    );
  }
  const [stream, gzipped] = await sniffGzip(body);
  const bytes = gzipped ? stream.pipeThrough(new DecompressionStream("gzip")) : stream;
  // 自分で作った Response なので Content-Type は application/wasm にできる（compileStreaming はこれが要る）
  const module = await WebAssembly.compileStreaming(new Response(bytes, { headers: { "Content-Type": "application/wasm" } }));
  const instance = await WebAssembly.instantiate(module, {});
  compiled = module;
  use(instance);
  prepareSpare();
}

/** 先頭の 2 バイトが gzip の印（1f 8b）か。読んだ分も含めて同じ中身を流すストリームと一緒に返す */
async function sniffGzip(body: ReadableStream<Bytes>): Promise<[ReadableStream<Bytes>, boolean]> {
  const reader = body.getReader();
  const head: Bytes[] = [];
  const first: number[] = [];
  while (first.length < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    head.push(value);
    for (const b of value.subarray(0, 2 - first.length)) first.push(b);
  }
  const stream = new ReadableStream<Bytes>({
    start(out) {
      for (const chunk of head) out.enqueue(chunk);
    },
    async pull(out) {
      const { done, value } = await reader.read();
      if (done) out.close();
      else out.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return [stream, first[0] === 0x1f && first[1] === 0x8b];
}

function exports(): Exports {
  if (wasm) return wasm;
  if (compiled) reload(compiled);
  else if (isNode) loadSync();
  else throw new Error("エンジンを読み込む前に呼ばれました（initEngine() を待ってから使います）");
  return wasm as unknown as Exports;
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
