// エンジンと AI の本体（Rust を WASM にしたもの。rust/wasm）を読み込んで呼ぶ。
// 要求と結果は JSON の文字列で受け渡す（rust/wasm/src/lib.rs）。局面・行動は GameState・Action と同じ形の JSON。
//
// ブラウザ（画面・Worker）では、使う前に initEngine() を待つ（WASM の読み込みは非同期にしかできない）。
// Chrome は画面（メインスレッド）では 8MB を超える WASM の同期のインスタンス化（new WebAssembly.Instance）も許さないので、
// ブラウザではインスタンスも WebAssembly.instantiate で作る。WASM が止まったときに読み込み直す分は、画面では先に作っておく。
// WASM は 3MB ほど（GitHub Pages が gzip で縮めて送れば 0.7MB ほど）。受け取りながらコンパイルし（WebAssembly.compileStreaming）、
// 画面には読み込みの進み具合を出す（src/ui/boot.tsx）。
//
// 探索 AI の補正と見込み（学習したネットワーク）は WASM に埋め込まず、ページごとのファイル（src/engine/nets/<名前>.bin。
// scripts/pack-nets.ts が JSON から作る。値は JSON とビットまで同じ）を読み込み、WASM を作るたびに入れる（load_nets）。
// スターターのページは starter（data/value-net.json と同じ）、アズヴォルト環境のページは azvaldt（今は補正 R6・見込み R4）。selectNets で選ぶ。
// AI を動かす Worker が自分で読み込む（Worker は作った画面が付けた名前 workerName() で、同じ補正を選ぶ）。
// 画面は AI を動かさないので補正を読み込まない（initEngine の nets: false。src/ui/boot.tsx）。
// 補正と一緒に、ページの探索 AI（"search"）の設定も入れる（SEARCH_OPTIONS。アズヴォルト環境のページは data/pools/azvaldt/search-options.json。
// 新しいプールの既定の探索 AI で、コマンドの compare・自己対戦の --opts と同じ。スターターのページは探索 AI の既定のまま）。
//
// Node（テスト・スクリプト）では、最初の呼び出しで src/engine/svwb.wasm と src/engine/nets/<名前>.bin を読み込む。
// どちらも npm run wasm（scripts/build-wasm.mjs）で作る（ビルドの生成物なのでコミットしない）。

import azvaldtSearchOptions from "../../data/pools/azvaldt/search-options.json";

/** WASM が書き出す関数（rust/wasm/src/lib.rs） */
interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  call(ptr: number, len: number): number;
  load_nets(ptr: number, len: number): number;
  nets_checksum_json(ptr: number, len: number): number;
  out_ptr(): number;
  out_len(): number;
}

/** ページの補正と見込み（scripts/pack-nets.ts の NETS_SOURCES） */
export type NetsName = "starter" | "azvaldt";
export const NETS_NAMES: readonly NetsName[] = ["starter", "azvaldt"];
const isNetsName = (x: unknown): x is NetsName => typeof x === "string" && (NETS_NAMES as readonly string[]).includes(x);

/** ブラウザで読み込む補正のファイル（Vite がビルドに入れる。ページは自分の分だけを取りに行く） */
const NETS_URLS: Record<NetsName, URL> = {
  starter: new URL("./nets/starter.bin", import.meta.url),
  azvaldt: new URL("./nets/azvaldt.bin", import.meta.url),
};

/**
 * ページの探索 AI（"search"）の設定（compare の --opts と同じ形。補正と見込みの項目は書かない。補正を入れた後に WASM に入れる）。
 * null なら探索 AI の既定（rust/engine/src/ai/search.rs の SearchOptions::default()）
 */
const SEARCH_OPTIONS: Record<NetsName, object | null> = {
  starter: null,
  azvaldt: azvaldtSearchOptions,
};

/** 行動が今の局面で打てないときのエラー */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

let wasm: Exports | null = null;
/** 読み込む補正（selectNets で選ぶ。Worker は作った画面が付けた名前から） */
let nets: NetsName = "starter";
/** 読み込んだ補正のファイル（gzip を戻したもの）。WASM を作り直すたびに入れ直すので持っておく。読み込まないなら null */
let netsBytes: Uint8Array | null = null;
/** 補正を読み込むか（画面は読み込まない。initEngine の nets） */
let withNets = true;
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

// Worker は、作った画面が付けた名前（new Worker の name。workerName()）の補正を読み込む
{
  const name = (globalThis as { name?: unknown }).name;
  const m = !isNode && !isMainThread && typeof name === "string" ? /^nets:(.+)$/.exec(name) : null;
  if (m && isNetsName(m[1])) nets = m[1];
}

/**
 * 読み込む補正を選ぶ（エンジンを使う前に呼ぶ。アズヴォルト環境のページの入口・テスト・スクリプト）。
 * 読み込んだ後は変えられない（WASM の中の既定の補正は 1 回だけ入れる）
 */
export function selectNets(name: NetsName): void {
  if (name === nets) return;
  if (wasm || compiled || loading) throw new Error(`補正はもう ${nets} を読み込んでいます（${name} にはできません）`);
  nets = name;
}

/** 読み込む（読み込んだ）補正 */
export const currentNets = (): NetsName => nets;

/** Worker を作るときの名前（Worker が画面と同じ補正を読み込む）。new Worker(url, { type: "module", name: workerName() }) */
export const workerName = (): string => `nets:${nets}`;

/** WASM に補正と、ページの探索 AI の設定を入れる */
function installNets(w: Exports, bytes: Uint8Array): void {
  const ptr = w.alloc(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  let code: number;
  try {
    code = w.load_nets(ptr, bytes.length);
  } catch (e) {
    throw new Error(`補正（${nets}）を読み込めません: ${readOut(w) || String(e)}`);
  }
  if (code !== 0) throw new Error(`補正（${nets}）を読み込めません: ${readOut(w)}`);
  const opts = SEARCH_OPTIONS[nets];
  if (opts) {
    try {
      callOn(w, { f: "setSearchOptions", opts });
    } catch (e) {
      throw new Error(`探索 AI の設定（${nets}）を入れられません: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function use(instance: WebAssembly.Instance): void {
  const w = instance.exports as unknown as Exports;
  if (netsBytes) installNets(w, netsBytes);
  wasm = w;
  generation++;
}

/** gzip したものなら戻す（先頭の 2 バイトで見分ける。配信が Content-Encoding で先に戻していれば、そのまま） */
const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

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
  const zlib = nodeProcess?.getBuiltinModule("node:zlib");
  if (!fs || !zlib) throw new Error("WASM を読み込めません（Node の fs・zlib が使えません）");
  const netsPath = `${__SVWB_NETS_DIR__}/${nets}.bin`;
  for (const path of [__SVWB_WASM_PATH__, netsPath]) if (!fs.existsSync(path)) throw new Error(`${path} がありません。npm run wasm で作ってください`);
  const raw = new Uint8Array(fs.readFileSync(netsPath));
  netsBytes = isGzip(raw) ? new Uint8Array(zlib.gunzipSync(raw)) : raw;
  compiled = new WebAssembly.Module(fs.readFileSync(__SVWB_WASM_PATH__));
  use(new WebAssembly.Instance(compiled, {}));
}

/** 読み込みの進み具合（受け取った WASM のバイト数（配信が縮めていても戻した後の数）と、受け取り終えたか） */
export type LoadProgress = (loaded: number, done: boolean) => void;

export interface InitOptions {
  /**
   * 探索 AI の補正と見込みを読み込むか（既定は読み込む）。AI を動かさない画面（メインスレッド）は false にして、
   * 補正のファイルを取りに行かない（AI を動かす Worker が自分で読み込む）。Node ではいつも読み込む
   */
  nets?: boolean;
}

/**
 * エンジンを使えるようにする（ブラウザでは最初に待つ。Node では待たなくてもよい）。
 * onProgress は WASM を受け取るたびと受け取り終えたときに呼ぶ（画面で読み込み中の表示を出すため。2 回目からの呼び出しでは使わない）
 */
export function initEngine(onProgress?: LoadProgress, options: InitOptions = {}): Promise<void> {
  if (wasm) return Promise.resolve();
  if (isNode) {
    loadSync();
    return Promise.resolve();
  }
  if (!loading) withNets = options.nets ?? true;
  loading ??= loadFrom(new URL("./svwb.wasm", import.meta.url), onProgress);
  return loading;
}

/** 補正のファイルを受け取り、gzip を戻す */
async function fetchNets(): Promise<Uint8Array> {
  const url = NETS_URLS[nets];
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url.pathname} を読み込めません（${res.status}）`);
  const raw = new Uint8Array(await res.arrayBuffer());
  if (!isGzip(raw)) return raw;
  const plain = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(plain).arrayBuffer());
}

/**
 * URL の WASM を非同期で読み込む。受け取りながらコンパイルする（WebAssembly.compileStreaming）。
 * compileStreaming は Content-Type が application/wasm の Response が要るので、配信の Content-Type によらず読めるよう、受け取った中身で Response を作り直す
 */
async function loadFrom(url: URL, onProgress?: LoadProgress): Promise<void> {
  const netsLoad = withNets ? fetchNets() : null;
  // 補正の読み込みが先に失敗しても、待つまで未処理の拒否にしない
  netsLoad?.catch(() => {});
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url.pathname} を読み込めません（${res.status}）`);
  let body: ReadableStream<Uint8Array<ArrayBuffer>> = res.body;
  if (onProgress) {
    let loaded = 0;
    body = body.pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, out) {
          loaded += chunk.byteLength;
          onProgress(loaded, false);
          out.enqueue(chunk);
        },
        flush() {
          onProgress(loaded, true);
        },
      }),
    );
  }
  const module = await WebAssembly.compileStreaming(new Response(body, { headers: { "Content-Type": "application/wasm" } }));
  if (netsLoad) netsBytes = await netsLoad;
  const instance = await WebAssembly.instantiate(module, {});
  compiled = module;
  use(instance);
  prepareSpare();
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
  return callOn(exports(), req);
}

/** callEngine の本体（WASM を指定して呼ぶ。補正を入れるときは、使う前の WASM を呼ぶ） */
function callOn(w: Exports, req: { f: string; [key: string]: unknown }): unknown {
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

/** WASM に入れたページの探索 AI の設定（SEARCH_OPTIONS。入れていなければ null で、探索 AI の既定） */
export function searchOptions(): unknown {
  return callEngine({ f: "searchOptions" });
}

/** 読み込んだ補正と見込みのハッシュ（rust/engine/src/ai/netpack.rs の checksum。読み込んでいなければ null） */
export function netsChecksum(): string | null {
  return callEngine({ f: "netsChecksum" }) as string | null;
}

/**
 * 補正と見込みの JSON（ファイルの中身の文字列）を、CLI と同じく WASM の中の serde_json で読んだもののハッシュ
 * （読み込んだ補正が JSON と同じ値かを確かめる。tests/nets.test.ts）
 */
export function netsChecksumOfJson(valueJson: string, potentialJson: string): string {
  const w = exports();
  const bytes = encoder.encode(`{"value":${valueJson},"potential":${potentialJson}}`);
  const ptr = w.alloc(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  let code: number;
  try {
    code = w.nets_checksum_json(ptr, bytes.length);
  } catch (e) {
    const message = readOut(w);
    wasm = null;
    throw new Error(`エンジンが止まりました（nets_checksum_json）: ${message || String(e)}`);
  }
  const text = readOut(w);
  if (code !== 0) throw new Error(text);
  return text;
}
