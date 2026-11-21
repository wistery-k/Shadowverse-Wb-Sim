// 問題集の手順の候補（<問のフォルダ>/lines/<問>.json の actions）の最後の「ターン終了」が、問の AI の選ぶ手か。
// 読んだ並び（full）を打ちきった後に、AI に続きを打たせずにターン終了を足していた不具合（2026-11-19、ユーザーの指摘。
// royal-firstmate-g1104 の良い手が、波濤の副船長の超進化の後にリリムを攻撃せずに終わっていた）の再発を防ぐ。
// 手順の候補を書く scripts/misses-lines-main.ts は、読みの後を AI にターンの終わりまで打たせる。ここでは乱数を変えても、
// ターン終了の手前の局面で問の AI がターン終了を選ぶ（まだ打てる手を残していない）ことを確かめる。
// 手順の候補は、ページの補正が R3 だったとき（2026-11-19）に R3 で書いた（調査の並びも R3 の手）。ページの補正を R4 にした後（2026-11-21）も
// 書き直さず（問を作った AI の手のまま見せる）、ここでは今のページの補正（R4）で確かめる。R4 が R3 と違って続けて打つところは R4_CONTINUES に挙げて除く
import { describe, expect, it } from "vitest";
import { agentOf } from "../src/ai/registry";
import { applyAction, legalActions, selectNets } from "../src/engine";
import { rngFrom, seedOf } from "../src/engine/rng";

// エンジンを使う前に選ぶ（アズヴォルト環境のページの補正。今は R4）
selectNets("azvaldt");

/**
 * 読みを打ちきった後に R3 はターンを終えたが、R4 は続けて打つ並び（"<問> <並びの種類>"）。
 * elf-assassin-g1360 の AI の手: 森の神秘を 1 枚出して PP 1 を残して終えたところで、R4 は手札のもう 1 枚の森の神秘（iid 96）も出す
 */
const R4_CONTINUES = new Set(["elf-assassin-g1360 ai"]);

const { loadMisses } = await import("../src/misses/azvaldtData");
await import("../src/record/pool");
const data = loadMisses();

describe("アズヴォルト環境の問題集の手順の候補の終わり", () => {
  it("ターン終了の手前の局面で、問の AI もターン終了を選ぶ（候補の打つ手でターンを終える並びと、手で書いた並びは除く）", () => {
    const wrong: string[] = [];
    for (const l of data.lines.values()) {
      const p = data.problems.find((x) => x.id === l.id)!;
      for (const line of l.lines) {
        // 手で書いた並び（witch-tico-g1006 のユーザーが見つけたリーサル。このターンに勝って終わる）は AI の手ではない
        if (line.hand !== null) continue;
        const actions = line.actions!;
        expect(actions.at(-1)?.type, `${l.id} ${line.kind}`).toBe("endTurn");
        // 候補の打つ手（steps）でターンを終える並び（elf-dustdays-g1067 の良い手「何も出さずにターンを終える」）は、候補そのものの手
        if (line.steps.length === actions.length) continue;
        if (R4_CONTINUES.has(`${l.id} ${line.kind}`)) continue;
        let s = p.state;
        for (const a of actions.slice(0, -1)) s = applyAction(s, a);
        for (const seed of [1, 2, 3]) {
          const a = agentOf(p.agent).chooseAction(s, legalActions(s), rngFrom({ rng: seedOf([seed, l.id.length]) }));
          if (a.type !== "endTurn") wrong.push(`${l.id} ${line.kind}（乱数 ${seed}）: ${JSON.stringify(a)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 600_000);
});
