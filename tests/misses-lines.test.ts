// 問題集の手順の候補（<問のフォルダ>/lines/<問>.json の actions。docs/misses.md「手順の候補」）と、一例の手の見分け（src/misses/example.ts）、デッキと残りの山札（src/misses/deck.ts）
import { describe, expect, it } from "vitest";
import "../src/record/pool";
import { actingPlayer, applyAction, cardOf, legalActions, tryApplyAction, type Action, type GameState } from "../src/engine";
import { loadMisses } from "../src/misses/azvaldtData";
import { deckRows } from "../src/misses/deck";
import { groupNote, stepGroups, stepNotes } from "../src/misses/example";
import { judgeTurn, passesBefore } from "../src/misses/problems";
import { stepText } from "../src/misses/stepText";
import { leaderClasses } from "../src/ui/describe";

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
        // 調査の並びには二段目の勝ちがある（手で書いた並びは無い）
        if (line.hand === null) expect(line.second!.games, l.id).toBeGreaterThan(0);
        else expect(line.second, l.id).toBeNull();
      }
    }
    // 手で書いた並び: witch-tico-g1006 の良い手（ユーザーが見つけたリーサル）と、調査ではなくユーザーの指摘から足した
    // witch-ginger-ara-s425114133 の 2 本（元の試合の AI の手と、ユーザーが見つけた手順。2026-11-24）
    const hands = [...data.lines.values()].flatMap((l) => l.lines.filter((x) => x.hand !== null).map((x) => `${l.id} ${x.kind}`));
    expect(hands.sort()).toEqual(["witch-ginger-ara-s425114133 ai", "witch-ginger-ara-s425114133 good", "witch-tico-g1006 good"]);
  });

  it("AI が打つ前の手は、調査の読んだ並び（full）と同じ説明になる", () => {
    let rethinks = 0;
    let continued = 0;
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      for (const line of l.lines) {
        const actions = line.actions!;
        const upto = line.rethink ?? actions.length;
        const states = statesOf(p.state, actions)!;
        const texts = actions.slice(0, upto).map((a, k) => stepText(states[k]!, a, p.player)).filter((t) => t !== "ターン終了");
        if (line.full.length > 0) expect(texts, `${l.id} ${line.kind}`).toEqual(line.full.slice(0, texts.length));
        if (line.rethink === null) {
          // 読んだ並びを打ちきって、AI がすぐターンを終えた
          expect(texts.length, `${l.id} ${line.kind}`).toBe(line.full.length);
          continue;
        }
        expect(texts.length, `${l.id} ${line.kind}`).toBe(line.rethink);
        // 読んだ並びの手（full[rethink]）が打てずに考え直したか、読んだ並びを打ちきった後に AI が続きを打った
        if (line.rethink < line.full.length) rethinks++;
        else {
          expect(line.rethink, `${l.id} ${line.kind}`).toBe(line.full.length);
          expect(actions[line.rethink]!.type, `${l.id} ${line.kind}`).not.toBe("endTurn");
          continued++;
        }
      }
    }
    expect(rethinks).toBe(4);
    // 読んだ並び（ビームの終局面まで）の後にも、AI が攻撃などを打つ並び（2026-11-19 のユーザーの指摘まで、ここでターン終了を足していた）。
    // royal-firstmate-g1104・bishop-miko-g1006・witch-hold-g1066 の良い手と witch-tico-g1006 の AI の手
    expect(continued).toBe(4);
  });

  it("良い手は合格、AI の手は不合格（途中から考え直した並びも。AI が打った続きで不合格になる良い手は除く）", () => {
    const continuationFails: string[] = [];
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      for (const line of l.lines) {
        const r = judgeTurn(p.state, line.actions!, p.player, p.pass);
        expect(r.done, `${l.id} ${line.kind}`).toBe(true);
        if (line.kind === "good" && r.passed === false) {
          // 調査で読んだ並びまででターンを終えれば合格し、AI が打った続きで不合格になる
          expect(passesBefore(p.state, line.actions!, line.rethink, p.player, p.pass), l.id).toBe(true);
          continuationFails.push(l.id);
          continue;
        }
        expect(r.passed, `${l.id} ${line.kind}`).toBe(line.kind === "good");
      }
    }
    // witch-hold-g1066: 良い手の続きで、AI は条件が禁じる大遊戯世界とマナリアの魔弾を打つ。条件はそのまま（2026-11-19、ユーザーの判断。
    // 続きを今の AI に打たせる打ち比べのやり方の側を直す）
    expect(continuationFails).toEqual(["witch-hold-g1066"]);
  });

  it("witch-tico-g1006 のリーサル（ユーザーが見つけた手順）は、局面の乱数によらず勝てる", () => {
    const p = byId.get("witch-tico-g1006")!;
    const line = data.lines.get(p.id)!.lines.find((x) => x.hand !== null)!;
    expect(judgeTurn(p.state, line.actions!, p.player, p.pass)).toMatchObject({ done: true, won: true, passed: true });
    // ティコをプレイして進化 → 魔弾 → 魔弾 → ストームブラスト → テトラ＆ラティカ。選ぶ手と、その後の攻撃は深さ 3 まで探す
    const plan: [Action["type"], string][] = [
      ["play", "マナリアスクリプター・ティコ"],
      ["evolve", "マナリアスクリプター・ティコ"],
      ["play", "マナリアの魔弾"],
      ["play", "マナリアの魔弾"],
      ["play", "ストームブラスト"],
      ["play", "恩愛の大地・テトラ＆ラティカ"],
    ];
    const me = p.player;
    const wins = (s: GameState, rest: typeof plan, depth: number): boolean => {
      if (s.phase === "ended") return s.winner === me;
      if (s.active !== me && s.pending?.player !== me) return false;
      const legal = legalActions(s).filter((a) => a.type !== "endTurn");
      if (s.pending) return legal.some((a) => wins(applyAction(s, a), rest, depth));
      const head = rest[0];
      if (head) {
        return legal.some((a) => {
          if (a.type !== head[0] || !("iid" in a)) return false;
          const card = [...s.players[me].hand, ...s.players[me].board].find((c) => c.iid === a.iid);
          return !!card && cardOf(card.cardId).name === head[1] && wins(applyAction(s, a), rest.slice(1), depth);
        });
      }
      return depth > 0 && legal.some((a) => wins(applyAction(s, a), rest, depth - 1));
    };
    for (let k = 0; k < 12; k++) {
      const rng = k === 0 ? p.state.rng : (Math.imul(k, 0x9e3779b9) ^ p.state.rng) >>> 0;
      expect(wins({ ...p.state, rng }, plan, 3), `乱数 ${k}`).toBe(true);
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

describe("デッキと残りの山札（src/misses/deck.ts）", () => {
  it("全部の問に両方の席のデッキがあり、手番の側のデッキは問の説明の名前、クラスは盤面の席と同じ", () => {
    for (const l of data.lines.values()) {
      const p = byId.get(l.id)!;
      expect(l.decks, l.id).not.toBeNull();
      const decks = l.decks!;
      expect(p.note, l.id).toContain(`（${decks[p.player].name}、`);
      for (const q of [0, 1] as const) {
        expect(decks[q].cards.length, `${l.id} ${q}`).toBe(40);
        const cls = new Set(decks[q].cards.map((c) => cardOf(c).class).filter((c) => c !== "neutral"));
        expect([...cls], `${l.id} ${q}`).toEqual([leaderClasses(p.state)[q]]);
      }
    }
  });

  it("残りは山札の枚数と合い、コストの順に並び、デッキのカードは全部出す", () => {
    const l = data.lines.get("dragon-abyss-g1281")!;
    const p = byId.get(l.id)!;
    for (const q of [0, 1] as const) {
      const rows = deckRows(p.state, q, l.decks![q]);
      expect(rows.reduce((n, r) => n + r.left, 0)).toBe(p.state.players[q].deck.length);
      expect(rows.filter((r) => r.total !== 0).reduce((n, r) => n + r.total!, 0)).toBe(40);
      const costs = rows.map((r) => cardOf(r.cardId).cost);
      expect(costs).toEqual([...costs].sort((a, b) => a - b));
    }
    // デッキが分からなければ残りだけ
    const rows = deckRows(p.state, 0, null);
    expect(rows.every((r) => r.total === null && r.left > 0)).toBe(true);
  });

  it("能力で山札に足されたカードは、デッキの枚数より多く残る", () => {
    // 歩む《愚者》・リンクルの超進化で 10 枚足した後の局面
    const l = data.lines.get("witch-hold-g1066")!;
    const p = byId.get(l.id)!;
    const rinkle = deckRows(p.state, 0, l.decks![0]).find((r) => cardOf(r.cardId).name === "歩む《愚者》・リンクル")!;
    expect(rinkle.total).toBe(3);
    expect(rinkle.left).toBeGreaterThan(3);
  });
});
