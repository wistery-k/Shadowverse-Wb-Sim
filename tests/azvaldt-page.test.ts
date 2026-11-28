// アズヴォルト環境のページ（azvaldt/index.html、src/azvaldt/）の選択肢と問題集（CLAUDE.md「決定済みの前提」のユーザーの依頼 2026-11-19）

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AZVALDT_DECK_OPTIONS, eventShort, REP10_IDS, setDeckIds } from "../src/azvaldt/decks";
import { loadMisses } from "../src/misses/azvaldtData";
import { PRO_DECKS } from "../src/record/decks";

describe("アズヴォルト環境のページ", () => {
  it("選べるデッキは取り込んだプロのデッキ 84 個だけ", () => {
    expect(AZVALDT_DECK_OPTIONS).toHaveLength(84);
    expect(AZVALDT_DECK_OPTIONS.map((d) => d.key)).toEqual(PRO_DECKS.map((d) => d.id));
    expect(new Set(AZVALDT_DECK_OPTIONS.map((d) => d.key)).size).toBe(84);
    for (const d of AZVALDT_DECK_OPTIONS) expect(d.cards).toHaveLength(40);
  });

  it("デッキはコマンドと同じカード ID で読む（tests/fixtures/azvaldt-decks.json。Rust の deck_compare.rs の pro_decks_match_fixture が同じファイルを比べる）", () => {
    // ページの AI がコマンドと同じ手を打つため（補正と見込みはカードを ID で見る）。2026-11-28 まで、ストームブラストをページは 10831310 で読んでいた
    const saved = JSON.parse(readFileSync("tests/fixtures/azvaldt-decks.json", "utf8")) as Record<string, string[]>;
    expect(Object.keys(saved).sort()).toEqual(PRO_DECKS.map((d) => d.id).sort());
    for (const d of PRO_DECKS) expect(d.cards, d.id).toEqual(saved[d.id]);
    for (const o of AZVALDT_DECK_OPTIONS) expect(o.cards, o.key).toEqual(saved[o.key]);
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
});
