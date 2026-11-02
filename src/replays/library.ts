// 読み込んだ試合を持つ Web Worker（src/replays/worker.ts）たちをまとめて扱う（画面側）。
// ファイルは画面で読んで行に分け、行のまとまりを、持っている分の少ない Worker から順に配る。検索はすべての Worker に投げて結果を合わせる。

import { MAX_WORKERS } from "../sim/pool";
import { splitReplayText } from "./records";
import type { MatchRow, ReplayQuery, SearchStats } from "./query";
import type { ReplayWorkerRequest, ReplayWorkerResponse } from "./worker";

/** 1 つの Worker に一度に渡す文字数のめやす */
const BATCH_CHARS = 2_000_000;

export interface FileStatus {
  file: string;
  games: number;
  skipped: number;
  failed: number;
  errors: string[];
  mismatched: number;
}

export interface SearchResult {
  rows: MatchRow[];
  stats: SearchStats;
  error?: string;
}

type GameResponse = Extract<ReplayWorkerResponse, { type: "game" }>["game"];

/** gzip（名前が .gz で終わる）なら展開して、文字列にする */
export async function readStreamText(name: string, body: ReadableStream<Uint8Array>): Promise<string> {
  // DOM の型では DecompressionStream の書く側が BufferSource なので、Uint8Array の流れにつなぐ形に直す
  const gunzip = new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array>;
  const stream = /\.gz$/i.test(name) ? body.pipeThrough(gunzip) : body;
  return await new Response(stream).text();
}

export class ReplayLibrary {
  private workers: Worker[] = [];
  /** Worker ごとに渡した文字数（少ない Worker に次を渡す） */
  private given: number[] = [];
  private next = 0;
  private waiting = new Map<number, { resolve: (msg: ReplayWorkerResponse) => void; reject: (e: Error) => void }>();
  /** 読み込んだデッキの名前 */
  readonly decks = new Set<string>();

  constructor(private readonly count = Math.max(1, Math.min(8, MAX_WORKERS, (navigator.hardwareConcurrency || 4) - 1))) {}

  private ensure(): void {
    while (this.workers.length < this.count) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<ReplayWorkerResponse>) => {
        const msg = e.data;
        const key = msg.type === "loaded" ? msg.job : msg.qid;
        const w = this.waiting.get(key);
        this.waiting.delete(key);
        w?.resolve(msg);
      };
      this.workers.push(w);
      this.given.push(0);
    }
  }

  private ask<T extends ReplayWorkerResponse>(w: number, make: (id: number) => ReplayWorkerRequest): Promise<T> {
    this.ensure();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: (msg) => resolve(msg as T), reject });
      this.workers[w]!.postMessage(make(id));
    });
  }

  /** ファイルの中身を読み込む（打ち直しは Worker で並列に行う） */
  async loadText(file: string, text: string, onProgress?: (done: number, total: number) => void): Promise<FileStatus> {
    this.ensure();
    const texts = splitReplayText(file, text);
    // 行をまとまりに分ける（行番号を保つ）
    const batches: { texts: string[]; firstLine: number }[] = [];
    let cur: string[] = [];
    let chars = 0;
    let firstLine = 1;
    texts.forEach((t, i) => {
      if (cur.length === 0) firstLine = i + 1;
      cur.push(t);
      chars += t.length;
      if (chars >= BATCH_CHARS) {
        batches.push({ texts: cur, firstLine });
        cur = [];
        chars = 0;
      }
    });
    if (cur.length > 0) batches.push({ texts: cur, firstLine });
    const status: FileStatus = { file, games: 0, skipped: 0, failed: 0, errors: [], mismatched: 0 };
    let done = 0;
    await Promise.all(
      batches.map(async (b) => {
        const size = b.texts.reduce((n, t) => n + t.length, 0);
        const w = this.given.indexOf(Math.min(...this.given));
        this.given[w]! += size;
        const r = await this.ask<Extract<ReplayWorkerResponse, { type: "loaded" }>>(w, (job) => ({ type: "load", job, file, texts: b.texts, firstLine: b.firstLine }));
        status.games += r.games;
        status.skipped += r.skipped;
        status.failed += r.failed;
        status.mismatched += r.mismatched;
        for (const e of r.errors) if (status.errors.length < 5) status.errors.push(e);
        for (const d of r.decks) this.decks.add(d);
        onProgress?.(++done, batches.length);
      }),
    );
    return status;
  }

  /** すべての Worker で探して結果を合わせる（一覧は limit 行まで） */
  async search(query: ReplayQuery, limit: number): Promise<SearchResult> {
    if (this.workers.length === 0) return { rows: [], stats: { turns: 0, games: 0, wins: 0, scanned: 0, scannedWins: 0 } };
    const results = await Promise.all(
      this.workers.map((_, w) => this.ask<Extract<ReplayWorkerResponse, { type: "result" }>>(w, (qid) => ({ type: "query", qid, query, limit }))),
    );
    const rows: MatchRow[] = [];
    const stats: SearchStats = { turns: 0, games: 0, wins: 0, scanned: 0, scannedWins: 0 };
    let error: string | undefined;
    results.forEach((r, w) => {
      for (const row of r.rows) rows.push({ ...row, w });
      stats.turns += r.stats.turns;
      stats.games += r.stats.games;
      stats.wins += r.stats.wins;
      stats.scanned += r.stats.scanned;
      stats.scannedWins += r.stats.scannedWins;
      if (r.stats.exprError !== undefined) stats.exprError ??= r.stats.exprError;
      error ??= r.error;
    });
    // 読んだファイル・行の順に並べる
    rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.sub - b.sub || a.me - b.me || a.k - b.k);
    rows.length = Math.min(rows.length, limit);
    return error === undefined ? { rows, stats } : { rows, stats, error };
  }

  /** 見つけたターンの試合（リプレイで開く） */
  async game(w: number, id: number): Promise<GameResponse> {
    const r = await this.ask<Extract<ReplayWorkerResponse, { type: "game" }>>(w, (qid) => ({ type: "game", qid, id }));
    return r.game;
  }

  /** 読み込んだ試合を捨てる（途中の読み込み・検索は中止のエラーになる） */
  clear(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.given = [];
    for (const w of this.waiting.values()) w.reject(new Error("中止しました"));
    this.waiting.clear();
    this.decks.clear();
  }
}
