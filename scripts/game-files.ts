// 調べもの用のスクリプト（think-at・diverge）が、記録した試合を読む口。
// 棋譜（ランナーが既定で書く .jsonl・夜のキューが持ち帰った .jsonl.gz。docs/kifu.md）と、npm run game --json の出力と、
// 前の形の記録（2026-11-17 までの npm run game --json・rhino-compare --record の 1 試合 1 ファイル）を、同じ形（ReplayRecord）で読む。

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { THINKING_AGENTS } from "../src/ai/think";
import type { PlayerIndex } from "../src/engine";
import { parseReplayTexts, splitReplayText } from "../src/replays/records";
import type { ReplayRecord } from "../src/replays/types";

/** ファイルの中の 1 試合と、その行番号（1 から） */
export interface FileGame {
  record: ReplayRecord;
  line: number;
}

/** ファイルの試合を全部読む（.gz は展開する。試合でない行は飛ばす。読めない行があればエラー） */
export function readGames(path: string): FileGame[] {
  const buf = readFileSync(path);
  const text = /\.gz$/i.test(path) ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  const parsed = parseReplayTexts(splitReplayText(path.replace(/\.gz$/i, ""), text));
  if (parsed.failed > 0) throw new Error(`${path} の ${parsed.failed} 試合を読めません: ${parsed.errors.join(" / ")}`);
  if (parsed.records.length === 0) throw new Error(`${path} に試合がありません`);
  return parsed.records.map((r) => ({ record: r.record, line: r.line }));
}

/** 試合の選び方（行番号か、試合番号と組のどちらか） */
export interface GamePick {
  line?: number;
  g?: number;
  swap?: boolean;
}

/** 試合の見出し（行番号・試合番号・組・デッキ） */
export function gameLabel(x: FileGame): string {
  const r = x.record;
  const g = r.g === undefined ? "" : ` g${r.g}`;
  const swap = r.swap === undefined ? "" : r.swap ? " 入れ替え" : "";
  return `${x.line} 行目${g}${swap}: ${r.names[0]} 対 ${r.names[1]}`;
}

/** 選び方に合う試合を 1 つ選ぶ（1 試合だけのファイルならそれ。合うものが 1 つでなければ、候補を並べたエラー） */
export function pickGame(games: readonly FileGame[], pick: GamePick): FileGame {
  const hit = games.filter(
    (x) =>
      (pick.line === undefined || x.line === pick.line) &&
      (pick.g === undefined || x.record.g === pick.g) &&
      (pick.swap === undefined || x.record.swap === pick.swap),
  );
  if (hit.length === 1) return hit[0]!;
  const list = hit.slice(0, 20).map(gameLabel).join("\n  ");
  if (hit.length === 0) throw new Error("合う試合がありません（--line・--g・--swap を見直してください）");
  throw new Error(`合う試合が ${hit.length} あります。--line（行番号）か --g・--swap で 1 つに絞ってください:\n  ${list}${hit.length > 20 ? "\n  …" : ""}`);
}

/**
 * 席 p の AI の名前（src/ai/registry.ts のキー。AI の考えを出すのに使う）。記録の agents がその名前ならそれ、
 * 棋譜の ai が {"agent": 名前}（rhino-compare・deck-compare）ならその名前、設定が {}（今の既定の探索 AI）なら "search"。
 * どれでもなければ null（--agent で渡してもらう）
 */
export function thinkingAgentOf(r: ReplayRecord, p: PlayerIndex): string | null {
  const name = r.agents[p];
  if (name && THINKING_AGENTS.has(name)) return name;
  const ai = r.ai?.[p];
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  if (isObj(ai)) {
    if (Object.keys(ai).length === 0) return "search";
    // 設定（opts）や補正（net）を変えた席は、名前だけでは同じ AI にならないので選ばない
    const { agent, opts, ...rest } = ai;
    const plain = Object.keys(rest).length === 0 && (opts === undefined || (isObj(opts) && Object.keys(opts).length === 0));
    if (typeof agent === "string" && THINKING_AGENTS.has(agent) && plain) return agent;
  }
  return null;
}
