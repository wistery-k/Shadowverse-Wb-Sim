// リプレイ検索の Web Worker。受け取った試合を打ち直して持っておき、検索の条件を受け取ると、持っている試合から条件に合うターンを返す。
// 試合はいくつかの Worker に分けて持つ（src/replays/library.ts）。

import { initEngine } from "../engine";
import { loadTexts } from "./games";
import { compileQuery, searchGames, type MatchRow, type ReplayQuery, type SearchStats } from "./query";
import type { GameIndex, LoadedGame, ReplayRecord } from "./types";

export type ReplayWorkerRequest =
  /** ファイルの一部（JSON の文字列の並び。firstLine は最初の文字列の行番号）を読む */
  | { type: "load"; job: number; file: string; texts: string[]; firstLine: number }
  | { type: "clear" }
  | { type: "query"; qid: number; query: ReplayQuery; limit: number }
  | { type: "game"; qid: number; id: number };

export type ReplayWorkerResponse =
  | { type: "loaded"; job: number; file: string; games: number; skipped: number; failed: number; errors: string[]; mismatched: number; decks: string[] }
  | { type: "result"; qid: number; rows: Omit<MatchRow, "w">[]; stats: SearchStats; error?: string }
  | { type: "game"; qid: number; game: { record: ReplayRecord; index: GameIndex; file: string; line: number; sub: number } | null };

const games: LoadedGame[] = [];

const post = (msg: ReplayWorkerResponse) => self.postMessage(msg);

self.onmessage = async (e: MessageEvent<ReplayWorkerRequest>) => {
  const msg = e.data;
  await initEngine();
  switch (msg.type) {
    case "load": {
      const r = loadTexts(msg.file, msg.texts, { nextId: games.length, firstLine: msg.firstLine });
      games.push(...r.games);
      const decks = [...new Set(r.games.flatMap((g) => g.record.names))];
      post({ type: "loaded", job: msg.job, file: msg.file, games: r.games.length, skipped: r.skipped, failed: r.failed, errors: r.errors, mismatched: r.mismatched, decks });
      break;
    }
    case "clear":
      games.length = 0;
      break;
    case "query": {
      try {
        const { rows, stats } = searchGames(games, compileQuery(msg.query), msg.limit);
        post({ type: "result", qid: msg.qid, rows, stats });
      } catch (err) {
        post({ type: "result", qid: msg.qid, rows: [], stats: { turns: 0, games: 0, wins: 0, scanned: 0, scannedWins: 0 }, error: err instanceof Error ? err.message : String(err) });
      }
      break;
    }
    case "game": {
      const g = games[msg.id];
      post({ type: "game", qid: msg.qid, game: g ? { record: g.record, index: g.index, file: g.file, line: g.line, sub: g.sub } : null });
      break;
    }
  }
};
