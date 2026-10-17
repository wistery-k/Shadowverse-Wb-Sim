import { describe, expect, it } from "vitest";
import { agentOf } from "../src/ai/registry";
import { lethalHint, resetAiCaches } from "../src/ai/lethalHint";
import { applyAction, createGame, legalActions, rngFrom } from "../src/engine";
import { buildHumanRecord, parseHumanRecord, toJsonLines } from "../src/sim/humanRecord";
import { playMatch } from "../src/sim/match";
import { compareMatch, OPPONENT_IDS, OPPONENTS, opponentsOf, SUBJECT_IDS, SUBJECTS } from "../src/sim/humanCompare";
import { PUZZLES, puzzleState } from "./rhinoPuzzles";

const randomAgent = agentOf("random");

describe("人間との比較の記録", () => {
  it("rhino-compare と同じシード・席でデッキを並べる", () => {
    const opp = opponentsOf("rhino");
    expect(opp).toHaveLength(6);
    expect(opp.map((d) => d.name)).not.toContain(SUBJECTS.rhino.deck);
    const m = compareMatch("rhino", opp[0]!.name, 3, 1);
    expect(m.seed).toBe(900000 + 3 * 13 + 1);
    expect(m.decks[0]).toEqual(opp[0]!.cards);
  });

  it("AFネメシスも他の 6 デッキと別のシードで並べる", () => {
    const opp = opponentsOf("af");
    expect(opp).toHaveLength(6);
    expect(opp.map((d) => d.name)).not.toContain("AFネメシス");
    expect(opp.map((d) => d.name)).toContain(SUBJECTS.rhino.deck);
    const m = compareMatch("af", opp[0]!.name, 3, 0);
    expect(m.seed).not.toBe(compareMatch("rhino", opponentsOf("rhino")[0]!.name, 3, 0).seed);
    expect(m.decks[1]).toEqual(opp[0]!.cards);
  });

  it("スペルウィッチも他の 6 デッキと別のシードで並べる", () => {
    const opp = opponentsOf("spellwitch");
    expect(opp).toHaveLength(6);
    expect(opp.map((d) => d.name)).not.toContain("スペルウィッチ");
    const seeds = SUBJECT_IDS.map((s) => compareMatch(s, opponentsOf(s)[0]!.name, 3, 0).seed);
    expect(new Set(seeds).size).toBe(SUBJECT_IDS.length);
  });

  it("疾走ドラゴン・ミッドレンジナイトメア・アマリアロイヤルも他の 6 デッキ（ランプドラゴンを除く）と並べる", () => {
    for (const subject of ["dragon", "nightmare", "royal"] as const) {
      const opp = opponentsOf(subject);
      expect(opp).toHaveLength(6);
      expect(opp.map((d) => d.name)).not.toContain(SUBJECTS[subject].deck);
      expect(opp.map((d) => d.name)).not.toContain("ランプドラゴン");
      expect(compareMatch(subject, opp[0]!.name, 0, 0).decks[0]).toHaveLength(40);
    }
  });

  it("勝敗・ターンごとの選択・行動の列を記録し、JSON Lines から読み戻せる", () => {
    for (const subject of SUBJECT_IDS)
      for (const seat of [0, 1] as const) {
        const deck = opponentsOf(subject)[1]!.name;
        const m = compareMatch(subject, deck, 0, seat);
        const r = playMatch([randomAgent, randomAgent], { ...m, record: true });
        const rec = buildHumanRecord({ subject, deck, g: 0, seat, actions: r.log!, commit: "abc", playedAt: "2026-01-01T00:00:00.000Z" });
        expect(rec.subject).toBe(subject);
        expect(rec.won).toBe(r.winner === seat);
        expect(rec.first).toBe(createGame(m).first === seat);
        expect(rec.turns).toBe(r.turns);
        expect(rec.turnLog.flatMap((t) => t.choices)).toHaveLength(r.log!.length);
        expect(rec.turnLog[0]!.turn).toBe(0);
        expect(rec.turnLog.some((t) => t.by === "you") && rec.turnLog.some((t) => t.by === "opponent")).toBe(true);
        const line = toJsonLines([rec]);
        expect(line.endsWith("\n")).toBe(true);
        expect(parseHumanRecord(JSON.parse(line))).toEqual(rec);
      }
  });

  it("終わっていない試合は記録しない", () => {
    expect(() => buildHumanRecord({ subject: "rhino", deck: opponentsOf("rhino")[0]!.name, g: 0, seat: 0, actions: [], commit: "", playedAt: "" })).toThrow();
    expect(parseHumanRecord({ kind: "other" })).toBeNull();
  });

  it("リノセウスエルフだけの頃の記録（version 1）をリノセウスエルフの記録として読む", () => {
    const deck = opponentsOf("rhino")[0]!.name;
    const m = compareMatch("rhino", deck, 2, 1);
    const r = playMatch([randomAgent, randomAgent], { ...m, record: true });
    const rec = buildHumanRecord({ subject: "rhino", deck, g: 2, seat: 1, actions: r.log!, commit: "", playedAt: "" });
    const { subject: _s, seat, ...rest } = rec;
    const v1 = { ...rest, kind: "rhino-compare-human", version: 1, elfSeat: seat };
    expect(parseHumanRecord(JSON.parse(JSON.stringify(v1)))).toEqual(rec);
  });

  it("相手の AI（物差し・最新版）を記録し、選べるようにする前の記録は物差しと打ったものとして読む", () => {
    const deck = opponentsOf("af")[0]!.name;
    const m = compareMatch("af", deck, 1, 0);
    const r = playMatch([randomAgent, randomAgent], { ...m, record: true });
    const base = { subject: "af" as const, deck, g: 1, seat: 0 as const, actions: r.log!, commit: "", playedAt: "" };
    const yardstick = buildHumanRecord(base);
    expect(yardstick.opponent).toBe("yardstick");
    expect(yardstick.opponentAgent).toBe(OPPONENTS.yardstick.agent);
    const latest = buildHumanRecord({ ...base, opponent: "latest" });
    expect(latest.opponent).toBe("latest");
    expect(latest.opponentAgent).toBe("search");
    expect(parseHumanRecord(JSON.parse(toJsonLines([latest])))).toEqual(latest);
    const { opponent: _o, ...old } = yardstick;
    expect(parseHumanRecord({ ...old, opponentAgent: "search-classic" })).toEqual({ ...yardstick, opponentAgent: "search-classic" });
    // どちらの相手もエンジン（WASM）で手を選べる
    const s = createGame(m);
    const legal = legalActions(s);
    for (const id of OPPONENT_IDS) expect(legal).toContainEqual(agentOf(OPPONENTS[id].agent).chooseAction(s, legal, rngFrom({ rng: 1 })));
  });
});

describe("対戦画面のリーサル表示", () => {
  it("リーサルがあれば勝てる手順を返し、相手の体力が 1 多ければ見つけない", () => {
    resetAiCaches();
    const puzzle = PUZZLES[0]!;
    const yes = puzzleState(puzzle, puzzle.expected);
    const steps = lethalHint(yes, 0, 1);
    expect(steps).not.toBeNull();
    let s = yes;
    for (const a of steps!) s = applyAction(s, a);
    expect(s.winner).toBe(0);
    resetAiCaches();
    expect(lethalHint(puzzleState(puzzle, puzzle.expected + 1), 0, 1)).toBeNull();
  });

  it("自動で行った行動に印をつけて記録する", () => {
    const deck = opponentsOf("rhino")[0]!.name;
    const m = compareMatch("rhino", deck, 0, 0);
    const r = playMatch([randomAgent, randomAgent], { ...m, record: true });
    const last = r.log!.length - 1;
    const rec = buildHumanRecord({ subject: "rhino", deck, g: 0, seat: 0, actions: r.log!, autoActions: [last], commit: "", playedAt: "" });
    expect(rec.autoActions).toEqual([last]);
    expect(rec.turnLog.at(-1)!.choices.at(-1)).toMatch(/（自動）$/);
  });
});
