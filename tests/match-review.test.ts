// 試合の記録の検討（段階 4）の、記録を確かめて局面を作る部分（src/record/review.ts）のテスト。
// 打ち比べ（Rust の svwb review）のテストは rust/engine/src/runner/review.rs。

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalize, parseRecord, RecordError, type MatchRecord } from "../src/record/record";
import { checkForReview, pointsFile, turnPoints } from "../src/record/review";

const DIR = "records/pro";
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (f: string): MatchRecord => parseRecord(readFileSync(`${DIR}/${f}`, "utf8"));
const shortest = () => files.map(load).sort((a, b) => a.steps.length - b.steps.length)[0]!;

describe("検討に使う記録", () => {
  it("置いてある記録は、どれも検討できる形で、保存した各ターンの最初の局面を今のエンジンで読める", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = load(f);
      expect(() => checkForReview(r), f).not.toThrow();
      for (const t of r.turns!) expect(() => normalize(t.state), `${f} のターン ${t.turn}`).not.toThrow();
      const tp = turnPoints(r);
      expect(tp.length).toBe(r.turns!.length);
      for (const [i, t] of tp.entries()) {
        // ターンの最初の局面は保存した局面そのもの
        expect(t.states[0]!.step).toBe(r.turns![i]!.step);
        expect(JSON.stringify(t.states[0]!.state)).toBe(JSON.stringify(normalize(r.turns![i]!.state)));
        if (t.trace === null) {
          const end = i + 1 < r.turns!.length ? r.turns![i + 1]!.step : r.steps.length;
          expect(t.states.map((x) => x.step)).toEqual(Array.from({ length: end - t.states[0]!.step }, (_, k) => t.states[0]!.step + k));
        } else {
          expect(t.states.length).toBe(1);
        }
      }
    }
  });

  it("勝敗の無い記録・各ターンの最初の局面の無い記録・プールに無いカードの記録は検討しない", () => {
    const r = shortest();
    expect(() => checkForReview({ ...r, result: null })).toThrow(/勝敗/);
    expect(() => checkForReview({ ...r, turns: [] })).toThrow(/最初の局面/);
    const { turns: _drop, ...noTurns } = r;
    expect(() => checkForReview(noTurns)).toThrow(RecordError);
    // 第1弾にしか無いカード（グリードケルブ・ルビィ。前期のローテーションのプールに無い）を混ぜたデッキ
    const bad: MatchRecord = { ...r, decks: [["10101110", ...r.decks[0].slice(1)], r.decks[1]] };
    expect(() => checkForReview(bad)).toThrow(/プールに無いカード/);
  });

  it("たどれるかはターンごとに見て、合わないターンは最初の局面だけにする（記録の全部を止めない）", () => {
    const r = shortest();
    const turns = r.turns!;
    expect(turns.length).toBeGreaterThanOrEqual(3);
    // ターン 2 の保存した局面を変えると、ターン 1 は次のターンの局面と合わない。ほかのターンはたどれる
    const changed = structuredClone(turns);
    changed[1]!.state.players[0]!.leaderHp -= 1;
    const tp = turnPoints({ ...r, turns: changed });
    expect(tp[0]!.trace).toMatch(/次のターンの保存した局面と合いません/);
    expect(tp[0]!.states.length).toBe(1);
    expect(tp[2]!.trace).toBeNull();
    // 最後のターンは、試合の終わりが記録の勝敗と合うか
    const loser = (1 - r.result!.winner) as 0 | 1;
    const tp2 = turnPoints({ ...r, result: { winner: loser, reason: r.result!.reason } });
    expect(tp2[tp2.length - 1]!.trace).toMatch(/勝敗と合いません/);
    expect(tp2[0]!.trace).toBeNull();
    // 打てない手順のあるターンは、その手順を書いて止め、次のターンからまた見る
    const steps = structuredClone(r.steps);
    const t = turns.findIndex((x, i) => i + 2 < turns.length && steps.slice(x.step, turns[i + 1]!.step).some((s) => s.kind === "action" && s.action.type === "play"));
    expect(t).toBeGreaterThanOrEqual(0);
    const at = steps.findIndex((s, i) => i >= turns[t]!.step && s.kind === "action" && s.action.type === "play");
    const st = steps[at]!;
    if (st.kind === "action") st.action = { type: "play", iid: 99999 };
    const tp3 = turnPoints({ ...r, steps });
    expect(tp3[t]!.trace).toMatch(new RegExp(`手順 ${at + 1} をたどれません`));
    expect(tp3[t]!.states.length).toBe(1);
    expect(tp3[t + 1]!.trace).toBeNull();
  });

  it("Rust に渡すファイルは、頭の行とターンの行", () => {
    const r = shortest();
    const text = pointsFile(r, "x.json", turnPoints(r));
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ header: true, record: "x.json", result: r.result });
    expect(lines.length).toBe(r.turns!.length + 1);
    expect(lines[1]).toMatchObject({ turn: 0, trace: null });
  });
});
