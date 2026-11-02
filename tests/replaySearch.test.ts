import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { insideRoots, looksLikeReplays, replayRoots } from "../scripts/replay-files";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, nextRandom, type Action, type PlayerIndex } from "../src/engine";
import { replayStates } from "../src/sim/replay";
import { loadTexts } from "../src/replays/games";
import { cardIdsOf, compileQuery, emptyQuery, gameView, newCond, numValue, searchGames, type Cond, type ReplayQuery } from "../src/replays/query";
import { deckClass, parseReplayTexts, splitReplayText } from "../src/replays/records";
import type { GameIndex, LoadedGame, SideSnap, TurnIndex } from "../src/replays/types";

/** ランダムな手で 1 試合打った記録（--replays の 1 行と同じ形） */
function randomRecord(seed: number, d0 = 0, d1 = 1): string {
  const decks: [string[], string[]] = [[...DEFAULT_DECKS[d0]!.cards], [...DEFAULT_DECKS[d1]!.cards]];
  let s = createGame({ decks, seed });
  let r = seed;
  const actions: Action[] = [];
  while (s.phase !== "ended" && actions.length < 3000) {
    const legal = legalActions(s);
    const [v, next] = nextRandom(r);
    r = next;
    const a = legal[Math.floor(v * legal.length)]!;
    actions.push(a);
    s = applyAction(s, a);
  }
  return JSON.stringify({ kind: "replay", version: 1, g: seed, names: [DEFAULT_DECKS[d0]!.name, DEFAULT_DECKS[d1]!.name], agents: ["random", "random"], seed, decks, winner: s.winner, actions });
}

const query = (q: Partial<ReplayQuery>): ReplayQuery => ({ ...emptyQuery(), ...q });
const cond = (c: Partial<Cond>): Cond => ({ ...newCond(c.kind), ...c });

describe("記録の読み込み", () => {
  const lines = [randomRecord(1), randomRecord(2, 2, 3), randomRecord(3, 4, 4)];
  const loaded = loadTexts("t.jsonl", [...lines, "", '{"g":1,"samples":[]}', "{壊れた行"], { nextId: 0, firstLine: 1 });

  it("試合を打ち直し、試合でない行は飛ばし、読めない行は数える", () => {
    expect(loaded.games).toHaveLength(3);
    expect(loaded.skipped).toBe(1);
    expect(loaded.failed).toBe(1);
    expect(loaded.errors[0]).toMatch(/^6 行目/);
    expect(loaded.mismatched).toBe(0);
    expect(loaded.games.map((g) => g.line)).toEqual([1, 2, 3]);
  });

  it("ターンの始めの局面の添字が、リプレイの局面と合う", () => {
    for (const g of loaded.games) {
      const states = replayStates(g.record.decks, g.record.seed, g.record.actions);
      expect(g.index.ended).toBe(true);
      expect(g.index.winner).toBe(states[states.length - 1]!.winner);
      for (const t of g.index.turns) {
        const s = states[t.s]!;
        expect(s.phase).toBe("main");
        expect(s.turn).toBe(t.n);
        expect(s.active).toBe(t.p);
        for (const p of [0, 1] as const) {
          expect(t.start[p].hp).toBe(s.players[p].leaderHp);
          expect(t.start[p].hand).toEqual(s.players[p].hand.map((h) => h.cardId));
          expect(t.start[p].board.map((b) => b.i)).toEqual(s.players[p].board.map((b) => b.iid));
        }
      }
    }
  });

  it("プレイの出来事の数が、行動の列のプレイの数と同じ", () => {
    for (const g of loaded.games) {
      const plays = g.index.turns.flatMap((t) => t.ev).filter((e) => e.k === "play").length;
      expect(plays).toBe(g.record.actions.filter((a) => a.type === "play").length);
    }
  });

  it("決着したターンは試合ごとに 1 つ（勝った側の視点だけ）", () => {
    const { stats } = searchGames(loaded.games, compileQuery(query({ conds: [cond({ kind: "decided", who: "me" })] })), 100);
    const decided = loaded.games.filter((g) => g.index.winner !== null).length;
    expect(stats.turns).toBe(decided);
    expect(stats.wins).toBe(decided);
  });

  it("クラスで絞る", () => {
    const g = loaded.games[0]!;
    const cls = g.classes[0];
    const { stats } = searchGames(loaded.games, compileQuery(query({ myClass: cls })), 100);
    expect(stats.scanned).toBe(loaded.games.reduce((n, x) => n + x.classes.filter((c) => c === cls).length, 0));
  });

  it("名前に配列の添字のある記録・JSON ファイル全体の記録も読める", () => {
    const parsed = parseReplayTexts(splitReplayText("x.json", `[${lines[0]},${lines[1]}]`));
    expect(parsed.records.map((r) => [r.line, r.sub])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    // npm run game --json の形（names・kind が無い）
    const plain = JSON.parse(lines[0]!) as Record<string, unknown>;
    delete plain.names;
    delete plain.kind;
    const one = parseReplayTexts(splitReplayText("game.json", JSON.stringify(plain, null, 2)));
    expect(one.records).toHaveLength(1);
    expect(one.records[0]!.record.names[0]).toBe(DEFAULT_DECKS[0]!.name);
  });

  it("打てない行動のある記録はエラーにする", () => {
    const bad = JSON.parse(lines[0]!) as { actions: Action[] };
    bad.actions.splice(3, 0, { type: "play", iid: 999999 });
    const r = loadTexts("bad.jsonl", [JSON.stringify(bad)], { nextId: 0, firstLine: 1 });
    expect(r.games).toHaveLength(0);
    expect(r.errors[0]).toMatch(/3 手目/);
  });
});

// ---- 手で作ったまとめで、条件の意味を確かめる ----

const ANNE = "マナリアフレンズ・アン＆グレア";
const anne = [...cardIdsOf(ANNE)!][0]!;
const other = DEFAULT_DECKS[0]!.cards[0]!;

function snap(o: Partial<SideSnap> = {}): SideSnap {
  return { hp: 20, maxHp: 20, maxPp: 1, pp: 1, ep: 0, sep: 0, xpp: false, deck: 30, grave: 0, hand: [], board: [], ...o };
}

function turn(n: number, o: Partial<TurnIndex> = {}): TurnIndex {
  return { n, p: ((n - 1) % 2) as PlayerIndex, tc: Math.ceil(n / 2), s: n * 10, e: n * 10 + 5, start: [snap(), snap()], end: [snap(), snap()], ev: [], ...o };
}

function fixture(turns: TurnIndex[], winner: PlayerIndex | null = 1): LoadedGame {
  const index: GameIndex = { first: 0, winner, ended: winner !== null, steps: 100, turns };
  const deck = DEFAULT_DECKS[0]!.cards;
  return {
    id: 0,
    file: "f.jsonl",
    line: 1,
    sub: 0,
    record: { seed: 1, decks: [[...deck], [...deck]], actions: [], agents: ["", ""], names: ["A", "B"], winner },
    index,
    classes: [deckClass(deck), deckClass(deck)],
    mismatch: false,
  };
}

describe("条件の意味", () => {
  // 1: P0 がアン＆グレアを出す → 2: P1 のターンを越えて残る → 3: P0（PP9＋エクストラPPなし）→ 4: P1（PP9＋エクストラPP）→ 5: P0 → 6: P1 がリーサル
  const board = [{ c: anne, i: 7, a: 2, d: 2, e: 0 as const }];
  const game = fixture([
    turn(1, { ev: [{ k: "play", p: 0, at: 10, c: anne, i: 7 }, { k: "enter", p: 0, at: 10, c: anne, i: 7 }], end: [snap({ board }), snap()] }),
    turn(2, { end: [snap({ board }), snap()] }),
    turn(3, { start: [snap({ maxPp: 9, pp: 9, board }), snap()], end: [snap({ board: [] }), snap()] }),
    turn(4, { start: [snap(), snap({ maxPp: 9, pp: 9, xpp: true })], end: [snap({ hp: 15 }), snap()] }),
    turn(5, { ev: [{ k: "play", p: 0, at: 50, c: other, i: 9 }] }),
    turn(6, { end: [snap({ hp: 0 }), snap()] }),
  ]);
  const find = (q: Partial<ReplayQuery>, me?: PlayerIndex) =>
    searchGames([game], compileQuery(query(q)), 100)
      .rows.filter((r) => me === undefined || r.me === me)
      .map((r) => r.n);

  it("処理されず残った: ターンの終わりにいて、次のターンの終わりにもいる", () => {
    expect(find({ conds: [cond({ kind: "survived", who: "me", card: ANNE })] }, 0)).toEqual([1]);
    // 名前の一部でも探せる
    expect(find({ conds: [cond({ kind: "survived", who: "me", card: "アン＆グレア" })] }, 0)).toEqual([1]);
  });

  it("リーサルを取られた: 相手の勝ちで決着したターンと、その直前の自分のターン", () => {
    expect(find({ conds: [cond({ kind: "decided", who: "opp" })] }, 0)).toEqual([6]);
    expect(find({ whose: "me", conds: [cond({ kind: "decided", who: "opp", scope: "next" })] }, 0)).toEqual([5]);
  });

  it("PP＋エクストラPP", () => {
    expect(find({ whose: "me", conds: [cond({ kind: "num", field: "ppx", op: "eq", value: 10, when: "start" })] })).toEqual([4]);
    expect(find({ whose: "me", conds: [cond({ kind: "num", field: "ppx", op: "eq", value: 9, when: "start" })] })).toEqual([3]);
  });

  it("関連ターン: これより前の自分のターンにプレイした・していない", () => {
    const played = cond({ kind: "played", who: "me", card: ANNE, scope: "beforeMine" });
    expect(find({ whose: "me", conds: [played] }, 0)).toEqual([3, 5]);
    expect(find({ whose: "me", conds: [{ ...played, negate: true }] }, 0)).toEqual([1]);
    expect(find({ whose: "me", conds: [cond({ kind: "played", who: "me", card: "", scope: "prevMine" })] }, 0)).toEqual([3]);
  });

  it("このターンに受けたダメージ・何ターン目", () => {
    expect(numValue(game.index.turns, 3, 0, "dmg", "start")).toBe(5);
    expect(numValue(game.index.turns, 4, 0, "tc", "start")).toBe(3);
    expect(numValue(game.index.turns, 4, 1, "tc", "start")).toBe(2);
  });

  it("式で書く条件", () => {
    expect(find({ expr: `t.mine && has(t.me.played, "アン")` })).toEqual([1]);
    expect(find({ expr: `t.next?.decided === "opp"`, whose: "me" }, 0)).toEqual([5]);
    const view = gameView(game, 0);
    expect(view.turns[0]!.me.played).toEqual([ANNE]);
    expect(view.won).toBe(false);
  });

  it("式の実行のエラーは数えて、そのターンは合わないものにする", () => {
    const r = searchGames([game], compileQuery(query({ expr: "t.nothing.x" })), 100);
    expect(r.stats.turns).toBe(0);
    expect(r.stats.exprError).toBeTruthy();
  });

  it("試合ごとに最初のターンだけ", () => {
    expect(find({ firstOnly: true, whose: "me" }, 0)).toEqual([1]);
  });
});

describe("開発サーバーが配る手元のファイル", () => {
  it("試合の記録らしいファイルだけを選ぶ（自己対戦の学習用の行は選ばない）", () => {
    expect(looksLikeReplays(randomRecord(5).slice(0, 4000))).toBe(true);
    expect(looksLikeReplays('{"g":1,"decks":["a","b"],"winner":0,"turns":3,"samples":[[{"ph":1}]]}')).toBe(false);
    expect(looksLikeReplays("ログ")).toBe(false);
  });

  it("探すフォルダの外のファイルは配らない", () => {
    const root = mkdtempSync(join(tmpdir(), "svwb-replays-"));
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "r.jsonl"), "{}");
    const outside = mkdtempSync(join(tmpdir(), "svwb-outside-"));
    writeFileSync(join(outside, "x.jsonl"), "{}");
    const roots = replayRoots({ SVWB_REPLAY_DIRS: `${root}` }, "/");
    expect(roots).toHaveLength(1);
    expect(insideRoots(join(root, "a", "r.jsonl"), roots)).toBe(true);
    expect(insideRoots(join(root, "a", "..", "..", outside.split("/").pop()!, "x.jsonl"), roots)).toBe(false);
    expect(insideRoots(join(outside, "x.jsonl"), roots)).toBe(false);
    expect(insideRoots(join(root, "nothing.jsonl"), roots)).toBe(false);
  });
});
