// 調べもの用のスクリプトが記録した試合を読む口（scripts/game-files.ts。think-at・diverge）

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { pickGame, readGames, thinkingAgentOf } from "../scripts/game-files";

const decks: [string[], string[]] = [DEFAULT_DECKS[0]!.cards, DEFAULT_DECKS[1]!.cards];

/** 棋譜の 1 行（docs/kifu.md の形。打ち直さないので行動は空） */
function line(g: number, swap: boolean | undefined, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "replay",
    version: 2,
    source: "compare",
    g,
    ...(swap === undefined ? {} : { swap }),
    names: ["甲", "乙"],
    agents: ["A {}", "B {}"],
    sides: ["A", "B"],
    ai: [{}, { beamWidth: 8 }],
    seed: 10 + g,
    decks,
    winner: 0,
    actions: [],
    ...extra,
  });
}

describe("記録した試合を読む（scripts/game-files.ts）", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "svwb-game-files-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("棋譜の .jsonl.gz を読み、行番号・試合番号・組・側・設定を持つ", () => {
    const path = join(dir, "k.jsonl.gz");
    writeFileSync(path, gzipSync(`${line(0, false)}\n${line(0, true)}\n${line(1, false)}\n`));
    const games = readGames(path);
    expect(games.map((x) => [x.line, x.record.g, x.record.swap])).toEqual([
      [1, 0, false],
      [2, 0, true],
      [3, 1, false],
    ]);
    expect(games[0]!.record.sides).toEqual(["A", "B"]);
    expect(games[0]!.record.ai).toEqual([{}, { beamWidth: 8 }]);
  });

  it("前の形（1 試合の JSON）も読む", () => {
    const path = join(dir, "g.json");
    writeFileSync(path, JSON.stringify({ seed: 3, agents: ["search", "rhino"], decks, winner: 1, actions: [] }, null, 2));
    const [x] = readGames(path);
    expect(x!.record.agents).toEqual(["search", "rhino"]);
    expect(x!.record.swap).toBeUndefined();
  });

  it("試合を選ぶ: 1 試合ならそれ、合うものが 1 つでなければ候補を並べたエラー", () => {
    const path = join(dir, "k.jsonl");
    writeFileSync(path, `${line(0, false)}\n${line(0, true)}\n${line(1, false)}\n`);
    const games = readGames(path);
    expect(pickGame(games, { line: 2 }).record.swap).toBe(true);
    expect(pickGame(games, { g: 1 }).line).toBe(3);
    expect(pickGame(games, { g: 0, swap: false }).line).toBe(1);
    expect(() => pickGame(games, { g: 0 })).toThrow(/2 あります[\s\S]*1 行目 g0: 甲 対 乙[\s\S]*2 行目 g0 入れ替え/);
    expect(() => pickGame(games, { g: 5 })).toThrow(/合う試合がありません/);
    expect(() => pickGame(games, {})).toThrow(/3 あります/);
    expect(pickGame(games.slice(0, 1), {}).line).toBe(1);
  });

  it("考えを出す AI の名前: 記録の名前、棋譜の {agent}、設定が {} なら search。設定や補正を変えた席は分からない", () => {
    const path = join(dir, "k.jsonl");
    writeFileSync(
      path,
      [
        line(0, undefined, { agents: ["rhino", "search-classic"] }),
        line(1, undefined, { ai: [{ agent: "search-classic", opts: {} }, { agent: "search", net: "n.json" }] }),
        line(2, undefined),
      ].join("\n"),
    );
    const [a, b, c] = readGames(path).map((x) => x.record);
    expect([thinkingAgentOf(a!, 0), thinkingAgentOf(a!, 1)]).toEqual(["rhino", "search-classic"]);
    expect([thinkingAgentOf(b!, 0), thinkingAgentOf(b!, 1)]).toEqual(["search-classic", null]);
    expect([thinkingAgentOf(c!, 0), thinkingAgentOf(c!, 1)]).toEqual(["search", null]);
  });
});
