// アズヴォルト環境のページ（azvaldt/index.html、src/azvaldt/）の選択肢と問題集（CLAUDE.md「決定済みの前提」のユーザーの依頼 2026-11-19）

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AZVALDT_DECK_OPTIONS, eventShort, REP10_IDS, setDeckIds } from "../src/azvaldt/decks";
import { loadMisses } from "../src/misses/azvaldtData";
import { PRO_DECKS } from "../src/record/decks";
import "../src/record/pool";
import { applyAction, createGame, legalActions, nextRandom, type Action } from "../src/engine";
import { loadTexts } from "../src/replays/games";
import { cardIdsOf } from "../src/replays/query";
import { deckClass } from "../src/replays/records";

describe("アズヴォルト環境のページ", () => {
  it("選べるデッキは取り込んだプロのデッキ 84 個だけ", () => {
    expect(AZVALDT_DECK_OPTIONS).toHaveLength(84);
    expect(AZVALDT_DECK_OPTIONS.map((d) => d.key)).toEqual(PRO_DECKS.map((d) => d.id));
    expect(new Set(AZVALDT_DECK_OPTIONS.map((d) => d.key)).size).toBe(84);
    for (const d of AZVALDT_DECK_OPTIONS) expect(d.cards).toHaveLength(40);
  });

  it("既定は代表 10 型（data/pools/azvaldt/sets/rep10.txt）", () => {
    expect(REP10_IDS).toHaveLength(10);
    const keys = new Set(AZVALDT_DECK_OPTIONS.map((d) => d.key));
    for (const id of REP10_IDS) expect(keys.has(id)).toBe(true);
    expect(() => setDeckIds("data/pools/azvaldt/decks/no-such/deck.txt")).toThrow();
  });

  it("大会の短い名前", () => {
    const d = AZVALDT_DECK_OPTIONS[0]!;
    expect(d.label.endsWith(eventShort(PRO_DECKS[0]!.event))).toBe(true);
    expect(eventShort("no-such-event")).toBe("no-such-event");
  });

  it("問題集は misses/azvaldt の問だけ（プロの試合の局面は入れない）", () => {
    const data = loadMisses();
    expect(data.errors).toEqual([]);
    const files = readdirSync("misses/azvaldt").filter((f) => f.endsWith(".json"));
    expect(data.problems.map((p) => `${p.id}.json`)).toEqual([...files].sort());
    for (const p of data.problems) expect(p.source).not.toMatch(/records\/pro/);
  });

  it("開発サーバーのリプレイ検索で、前期のローテーションの試合の棋譜を読める（カードの表に足したプールのカードを引く）", () => {
    const [a, b] = [AZVALDT_DECK_OPTIONS[0]!, AZVALDT_DECK_OPTIONS.find((d) => d.cls !== AZVALDT_DECK_OPTIONS[0]!.cls)!];
    const decks: [string[], string[]] = [[...a.cards], [...b.cards]];
    let s = createGame({ decks, seed: 3 });
    let r = 3;
    const actions: Action[] = [];
    while (s.phase !== "ended" && actions.length < 3000) {
      const legal = legalActions(s);
      const [v, next] = nextRandom(r);
      r = next;
      const act = legal[Math.floor(v * legal.length)]!;
      actions.push(act);
      s = applyAction(s, act);
    }
    const loaded = loadTexts("g.json", [JSON.stringify({ seed: 3, decks, actions, winner: s.winner })], { nextId: 0, firstLine: 1 });
    expect(loaded.errors).toEqual([]);
    expect(loaded.games).toHaveLength(1);
    expect(deckClass(a.cards)).toBe(a.cls);
    expect(cardIdsOf("空の命運を握る少女・ルリア")).toEqual(new Set(["10403120"]));
  });
});
