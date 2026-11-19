// 問題集の手順の候補（<問のフォルダ>/lines/<問>.json の actions。docs/misses.md「手順の候補」）と、一例の手の見分け（src/misses/example.ts）
import { describe, expect, it } from "vitest";
import "../src/record/pool";
import { actingPlayer, applyAction, tryApplyAction, type Action, type GameState } from "../src/engine";
import { loadMisses } from "../src/misses/azvaldtData";
import { groupNote, stepGroups, stepNotes } from "../src/misses/example";
import { judgeTurn } from "../src/misses/problems";
import { stepText } from "../src/misses/stepText";

const data = loadMisses();
const byId = new Map(data.problems.map((p) => [p.id, p]));

/** 局面から手を順に打った局面（打てない手があれば null） */
function statesOf(start: GameState, actions: readonly Action[]): GameState[] | null {
  const states = [start];
  for (const a of actions) {
    const next = tryApplyAction(states.at(-1)!, a);
    if (!next) return null;
    states.push(next);
  }
  return states;
}

describe("アズヴォルト環境の問題集の手順の候補", () => {
  it("全部の問に AI の手と良い手があり、問の局面からターンの終わりまで打てる", () => {
    expect(data.errors).toEqual([]);
    expect([...data.lines.keys()].sort()).toEqual(data.problems.map((p) => p.id));
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      expect(l.lines.map((x) => x.kind), l.id).toEqual(["ai", "good"]);
      for (const line of l.lines) {
        const actions = line.actions!;
        expect(actions.slice(0, line.steps.length), `${l.id} ${line.kind}`).toEqual(line.steps);
        const states = statesOf(p.state, actions);
        expect(states, `${l.id} ${line.kind}`).not.toBeNull();
        const end = states!.at(-1)!;
        // 最後の手でターンが終わる（その前は手番の側のターン）
        expect(end.active !== p.player || end.winner !== null, `${l.id} ${line.kind}`).toBe(true);
        for (const s of states!.slice(0, -1)) expect(actingPlayer(s) === p.player || s.active === p.player, `${l.id} ${line.kind}`).toBe(true);
        expect(line.second!.games, l.id).toBeGreaterThan(0);
      }
    }
  });

  it("考え直す前の手は、調査の読んだ並び（full）と同じ説明になる", () => {
    let rethinks = 0;
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      for (const line of l.lines) {
        const actions = line.actions!;
        const upto = line.rethink ?? actions.length;
        const states = statesOf(p.state, actions)!;
        const texts = actions.slice(0, upto).map((a, k) => stepText(states[k]!, a, p.player)).filter((t) => t !== "ターン終了");
        if (line.full.length > 0) expect(texts, `${l.id} ${line.kind}`).toEqual(line.full.slice(0, texts.length));
        if (line.rethink !== null) {
          // 考え直すのは、読んだ並びの手（full[rethink]）が打てないときだけ
          expect(texts.length, `${l.id} ${line.kind}`).toBe(line.rethink);
          expect(line.full[line.rethink], `${l.id} ${line.kind}`).toBeDefined();
          rethinks++;
        }
      }
    }
    expect(rethinks).toBe(4);
  });

  it("良い手は合格、AI の手は不合格（途中から考え直した並びも）", () => {
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      for (const line of l.lines) {
        const r = judgeTurn(p.state, line.actions!, p.player, p.pass);
        expect(r.done, `${l.id} ${line.kind}`).toBe(true);
        expect(r.passed, `${l.id} ${line.kind}`).toBe(line.kind === "good");
      }
    }
  });
});

describe("一例の手（src/misses/example.ts）", () => {
  const problem = (id: string) => byId.get(id)!;
  const lineOf = (id: string, kind: "ai" | "good") => data.lines.get(id)!.lines.find((l) => l.kind === kind)!;
  const notesOf = (id: string, actions: readonly Action[], rethink: number | null = null) => stepNotes(statesOf(problem(id).state, actions)!, actions, rethink);

  it("引いたカードを使う手だけが一例（引いた後でも、手札にあったカードを使う手はそうでない）", () => {
    // フェアリーを出すと山札の一番上の風の理・イーウィヤ（iid 16）を引く。手札にもう 1 枚（iid 15）ある
    const p = problem("elf-assassin-g1567");
    expect(p.state.players[p.player].deck[0]!.iid).toBe(16);
    const notes = notesOf(p.id, [
      { type: "play", iid: 90 },
      { type: "play", iid: 16 },
      { type: "play", iid: 15 },
      { type: "endTurn" },
    ]);
    expect(notes.map((n) => n.example)).toEqual([null, "draw", null, null]);
    expect(notes[0]!.drew).toEqual([16]);
  });

  it("ランダムな結果の後の手はみな一例（ターン終了は除く）", () => {
    // 刻みし約束の 1 番目の効果（相手の場のフォロワーからランダム 1 枚に 3 ダメージ）
    const line = lineOf("bishop-miko-g1006", "ai");
    const notes = notesOf("bishop-miko-g1006", line.actions!.slice(0, 7));
    expect(notes.map((n) => n.random)).toEqual([false, false, false, false, false, true, false]);
    expect(notes.map((n) => n.example)).toEqual([null, null, null, null, null, null, "random"]);
  });

  it("乱数の状態が変わっても、山札の順番だけが変わる手はランダムに数えない", () => {
    const p = problem("nightmare-macmillan-g1004");
    const actions = lineOf(p.id, "ai").actions!;
    const states = statesOf(p.state, actions)!;
    expect(states[1]!.rng).not.toBe(states[0]!.rng);
    expect(stepNotes(states, actions).map((n) => [n.random, n.example])).toEqual([
      [false, null],
      [false, null],
      [true, null],
    ]);
  });

  it("考え直した手から後は一例", () => {
    const line = lineOf("elf-assassin-g1567", "good");
    const notes = notesOf("elf-assassin-g1567", line.actions!, line.rethink);
    expect(line.rethink).toBe(1);
    expect(notes.map((n) => n.example)).toEqual([null, "rethink", "rethink", "rethink", "rethink", "rethink", null]);
  });

  it("選ぶ手・効果を選ぶ手は直前の手とまとめる", () => {
    // 希望の光彩・リテュエルをプレイ → 1 番目の効果 → 海蝕の三叉槍をプレイ → 選ぶ → 海蝕の三叉槍の能力 → 選ぶ → 攻撃 → 攻撃 → ターン終了
    const line = lineOf("bishop-gem-g1029", "ai");
    const states = statesOf(problem("bishop-gem-g1029").state, line.actions!)!;
    expect(stepGroups(states, line.actions!).map((g) => [g.start, g.end])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 6],
      [7, 7],
      [8, 8],
    ]);
  });

  it("まとめた手の一例は、中の手のいちばん強い種類", () => {
    const line = lineOf("bishop-miko-g1006", "ai");
    const states = statesOf(problem("bishop-miko-g1006").state, line.actions!)!;
    const notes = stepNotes(states, line.actions!, line.rethink);
    const groups = stepGroups(states, line.actions!);
    // 海蝕の三叉槍の能力（ランダムの後）と、考え直した選ぶ手（8 手目）
    const g = groups.find((x) => x.start === 6)!;
    expect(g.end).toBe(7);
    expect(groupNote(notes, g).example).toBe("rethink");
    // 刻みし約束をプレイ（1 番目の効果）: 効果を選んだ手でランダムな結果
    const h = groups.find((x) => x.start === 4)!;
    expect(groupNote(notes, h)).toMatchObject({ example: null, random: true });
  });
});
