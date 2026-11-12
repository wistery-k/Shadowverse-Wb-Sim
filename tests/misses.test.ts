import { describe, expect, it } from "vitest";
import { actingPlayer, legalActions, tryApplyAction, type Action, type GameState } from "../src/engine";
import { loadMisses } from "../src/misses/data";
import { condTexts, judgeTurn, parsePass } from "../src/misses/problems";

const data = loadMisses();
const byId = new Map(data.problems.map((p) => [p.id, p]));
const END: Action = { type: "endTurn" };

/** 局面から手の並びを打てるところまで打つ（打てなかった手の添字） */
function playable(start: GameState, actions: readonly Action[]): number | null {
  let s = start;
  for (let i = 0; i < actions.length; i++) {
    const next = tryApplyAction(s, actions[i]!);
    if (!next) return i;
    s = next;
  }
  return null;
}

describe("見落とし問題集のページのデータ", () => {
  it("全部の問と並びが読める", () => {
    expect(data.errors).toEqual([]);
    expect(data.problems.length).toBeGreaterThan(0);
  });

  it("問の局面は対戦の途中で、手番が問の手番の側", () => {
    for (const p of data.problems) {
      expect(p.state.phase, p.id).toBe("main");
      expect(actingPlayer(p.state), p.id).toBe(p.player);
      expect(legalActions(p.state).length, p.id).toBeGreaterThan(0);
      expect(condTexts(p.pass[0]!).length, p.id).toBeGreaterThan(0);
    }
  });

  it("調査の並びは問があり、問の局面から打てる", () => {
    for (const l of data.lines.values()) {
      const p = byId.get(l.id);
      expect(p, l.id).toBeDefined();
      for (const line of l.lines) expect(playable(p!.state, line.steps), `${l.id} ${line.kind}`).toBeNull();
    }
  });

  it("調査の並びが読んだターンの終わりまであれば、良い手は合格・AI の手は不合格", () => {
    let checked = 0;
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      for (const line of l.lines) {
        const ends = line.steps.at(-1)?.type === "endTurn";
        // エクストラPP・ターン終了は full に入らない
        if (line.steps.filter((a) => a.type !== "extraPp" && a.type !== "endTurn").length !== line.full.filter((t) => t !== "エクストラPP").length) continue;
        const r = judgeTurn(p.state, ends ? line.steps : [...line.steps, END], p.player, p.pass);
        expect(r.done, `${l.id} ${line.kind}`).toBe(true);
        expect(r.passed, `${l.id} ${line.kind}`).toBe(line.kind === "good");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe("合格の判定", () => {
  const p = byId.get("witch-od-hold")!;

  it("ターンを終えるまでは判定しない", () => {
    expect(judgeTurn(p.state, [], p.player, p.pass)).toMatchObject({ done: false, passed: null });
  });

  it("含まない手の条件: 何もせずにターンを終えれば合格", () => {
    expect(judgeTurn(p.state, [END], p.player, p.pass)).toMatchObject({ done: true, passed: true, endIndex: 0 });
  });

  it("含む手の条件: 何もせずにターンを終えれば不合格", () => {
    const q = byId.get("witch-mira-g1270")!;
    expect(judgeTurn(q.state, [END], q.player, q.pass)).toMatchObject({ done: true, passed: false });
  });

  it("条件の形を読む", () => {
    expect(parsePass({ must: [{ target: "楽朗の天宮・フィルドア" }] })[0]!.must[0]).toMatchObject({ verb: "target", card: "楽朗の天宮・フィルドア", target: null });
    expect(parsePass([{ win: true }, { minHp: 11 }])).toHaveLength(2);
    expect(() => parsePass({ must: [{ jump: "x" }] })).toThrow();
    expect(condTexts(parsePass({ must: [{ choose: "燐光の岩", by: "虫の知らせ" }], mustNot: [{ superEvolve: "*" }] })[0]!)).toEqual([
      "このターンに 虫の知らせで燐光の岩を選ぶ をする",
      "このターンに どれかを超進化 をしない",
    ]);
  });
});
