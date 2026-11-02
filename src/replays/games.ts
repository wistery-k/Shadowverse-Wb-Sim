// 記録した試合を打ち直して、検索に使う形（LoadedGame）にする。打ち直しはエンジン（WASM の replayIndex。rust/engine/src/replay_index.rs）が行う。

import { callEngine } from "../engine/wasm";
import { parseReplayTexts, deckClass } from "./records";
import type { GameIndex, LoadedGame, ReplayRecord } from "./types";

/** 試合を打ち直したターンごとのまとめ。打てない行動があればエラーを投げる */
export function indexReplay(record: ReplayRecord): GameIndex {
  return callEngine({ f: "replayIndex", decks: record.decks, seed: record.seed >>> 0, actions: record.actions }) as GameIndex;
}

export interface LoadResult {
  games: LoadedGame[];
  /** 試合でない値（自己対戦の学習用の行など）の数 */
  skipped: number;
  /** 読めなかった・打ち直せなかった試合の数と、最初のいくつかの理由 */
  failed: number;
  errors: string[];
  /** 記録の勝者と打ち直した勝者が違った試合の数 */
  mismatched: number;
}

/**
 * JSON の文字列の並び（JSON Lines の行、または JSON ファイル全体）から試合を読み、打ち直す。
 * nextId は Worker の中での試合の番号、firstLine は最初の文字列の行番号
 */
export function loadTexts(file: string, texts: readonly string[], opts: { nextId: number; firstLine: number; maxErrors?: number }): LoadResult {
  const maxErrors = opts.maxErrors ?? 5;
  const parsed = parseReplayTexts(texts, opts.firstLine, maxErrors);
  const out: LoadResult = { games: [], skipped: parsed.skipped, failed: parsed.failed, errors: [...parsed.errors], mismatched: 0 };
  for (const { record, line, sub } of parsed.records) {
    try {
      const index = indexReplay(record);
      const mismatch = record.winner !== null && index.winner !== record.winner;
      if (mismatch) out.mismatched++;
      out.games.push({
        id: opts.nextId + out.games.length,
        file,
        line,
        sub,
        record,
        index,
        classes: [deckClass(record.decks[0]), deckClass(record.decks[1])],
        mismatch,
      });
    } catch (e) {
      out.failed++;
      if (out.errors.length < maxErrors) out.errors.push(`${line} 行目${sub > 0 ? `の ${sub + 1} 試合目` : ""}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
