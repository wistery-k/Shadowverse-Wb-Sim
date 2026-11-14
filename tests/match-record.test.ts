// 試合の記録（src/record/。開発サーバーだけの「試合の記録」の画面の中身）:
// プロのデッキだけを選べること、引いたカード・ランダムな結果を決めて手を打てること、記録をたどると同じ局面になること。

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_CARDS, CARDS_BY_ID } from "../src/cards";
import { AZVALDT_CARDS } from "../src/cards/pools";
import { applyAction, cardOf, legalActions, opponent, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { findProDeck, PRO_DECKS, PRO_EVENTS, proDeck } from "../src/record/decks";
import { POOL_CARD_BY_NAME } from "../src/record/pool";
import {
  applyStep,
  cleanMemo,
  drawnCards,
  evaluate,
  exportRecord,
  newRecord,
  nextHandOrder,
  outcomeMatches,
  parseRecord,
  reapplySteps,
  replay,
  RecordError,
  runStep,
  setInitialHand,
  turnSnapshots,
  varyingFacets,
  type Draws,
  type MatchRecord,
  type PendingStep,
  type RecordStep,
} from "../src/record/record";
import { FILLER, setup, toBoard, toHand } from "./poolScenario";

const NAMES: [string, string] = ["先攻", "後攻"];
const id = (name: string) => POOL_CARD_BY_NAME.get(name)!.id;

/** 引いたカードは cost の低い順で最初のもの、ランダムな結果は最初の候補を選んで、手を打ち切る */
function resolve(state: GameState, action: Action, pickDraw?: (p: PlayerIndex, remaining: Map<string, number>, taken: readonly string[]) => string): { step: RecordStep; next: GameState } {
  let step: PendingStep = { action, draws: [[], []] };
  for (let guard = 0; guard < 50; guard++) {
    const r = evaluate(state, step, NAMES);
    step = r.step;
    const ev = r.ev;
    if (ev.kind === "done") {
      return { step: { kind: "action", action, draws: step.draws, ...(step.rng !== undefined ? { rng: step.rng } : {}) }, next: ev.next };
    }
    if (ev.kind === "error" || ev.kind === "mismatch") throw new Error(JSON.stringify(ev));
    if (ev.kind === "random") {
      const o = ev.outcomes[0]!;
      step = { ...step, rng: o.rng, outcomeKey: o.key };
      continue;
    }
    const remaining = ev.pool;
    const card = pickDraw ? pickDraw(ev.player, remaining, step.draws[ev.player]) : [...remaining.keys()].sort((a, b) => cardOf(a).cost - cardOf(b).cost || a.localeCompare(b))[0]!;
    const draws: Draws = [[...step.draws[0]], [...step.draws[1]]];
    draws[ev.player].push(card);
    step = { ...step, draws };
  }
  throw new Error("決まりませんでした");
}

describe("試合の記録: プロのデッキ", () => {
  it("3 大会・84 デッキを読み、どれも 40 枚", () => {
    expect(PRO_EVENTS.map((e) => e.id)).toEqual(["ps26-27-08b", "ps26-27-09a", "ps26-27-09b"]);
    expect(PRO_EVENTS[0]!.name).toBe("Premier Series 26-27 第8節 後半戦");
    expect(PRO_EVENTS[0]!.date).toBe("2026-10-06");
    expect(PRO_DECKS).toHaveLength(84);
    for (const d of PRO_DECKS) expect(d.cards).toHaveLength(40);
    expect(findProDeck("ps26-27-08b", "CR", "witch")?.name).toBe("スペルW（CR）");
  });

  it("画面のカードの表に前期のローテーションのカードが足され、スターターのカードはそのまま", () => {
    const only = AZVALDT_CARDS.find((c) => !CARDS_BY_ID.has(c.id))!;
    expect(cardOf(only.id)).toBe(only);
    const starter = ALL_CARDS[0]!;
    expect(cardOf(starter.id)).toBe(starter);
    // 名前で引くと再録のストームブラスト（前期のローテーションの ID）
    expect(id("ストームブラスト")).toBe("10831310");
  });
});

/** 2 つのプロのデッキの記録を始める */
function start(): { record: MatchRecord; state: GameState } {
  const a = findProDeck("ps26-27-08b", "CR", "witch")!;
  const b = findProDeck("ps26-27-08b", "VL", "nightmare")!;
  const record = newRecord({
    event: "ps26-27-08b",
    eventName: "Premier Series 26-27 第8節 後半戦",
    seats: [
      { deck: a.id, team: a.team, cls: a.cls },
      { deck: b.id, team: b.team, cls: b.cls },
    ],
    memo: "",
    commit: "",
    dirty: false,
    seed: 7,
    now: "2026-11-14T00:00:00.000Z",
  });
  return { record, state: replay(record).states[0]! };
}

describe("試合の記録: 手を入れる", () => {
  it("席 0 が先攻で始まり、初期手札を決められる", () => {
    const { record, state } = start();
    expect(state.first).toBe(0);
    expect(state.phase).toBe("mulligan");
    const hand = record.decks[0].slice(0, 4);
    const s = setInitialHand(state, 0, hand);
    expect(s.players[0].hand.map((h) => h.cardId)).toEqual(hand);
    expect(s.players[0].deck).toHaveLength(36);
    // 実体 ID は重ならない
    const iids = [...s.players[0].hand.map((h) => h.iid), ...s.players[0].deck.map((c) => c.iid)];
    expect(new Set(iids).size).toBe(40);
    expect(() => setInitialHand(state, 0, ["10131320", ...hand.slice(1)])).toThrow(RecordError);
  });

  it("マリガンで引いたカードと、ターンの最初に引くカードを決めて打てる", () => {
    const { record, state: s0 } = start();
    const steps: RecordStep[] = [];
    let state = s0;
    const push = (step: RecordStep, next: GameState) => {
      steps.push(step);
      state = next;
    };
    const hand0 = [...new Set(record.decks[0])].slice(0, 4);
    push({ kind: "hand", player: 0, cards: hand0 }, setInitialHand(state, 0, hand0));
    const hand1 = record.decks[1].slice(0, 4);
    push({ kind: "hand", player: 1, cards: hand1 }, setInitialHand(state, 1, hand1));
    // 先攻は 2 枚返し、決めたカードを引く
    const want = [...new Set(record.decks[0])].slice(4, 6);
    const swap = state.players[0].hand.slice(0, 2).map((h) => h.iid);
    let r = resolve(state, { type: "mulligan", player: 0, swap }, (_, remaining, taken) => want[taken.length] ?? [...remaining.keys()][0]!);
    push(r.step, r.next);
    expect(state.players[0].hand.map((h) => h.cardId).slice(2).sort()).toEqual([...want].sort());
    // 後攻は返さない。先攻の 1 ターン目のドローも決める
    r = resolve(state, { type: "mulligan", player: 1, swap: [] });
    push(r.step, r.next);
    expect(state.phase).toBe("main");
    // 何ターンか打つ: 打てるカードを 1 枚打ってからターン終了
    for (let t = 0; t < 8 && state.phase === "main"; t++) {
      for (let k = 0; k < 3 && state.phase === "main"; k++) {
        const legal = legalActions(state);
        const a = legal.find((x) => x.type === "play") ?? legal.find((x) => x.type === "choose" || x.type === "mode") ?? legal.find((x) => x.type === "endTurn")!;
        r = resolve(state, a);
        push(r.step, r.next);
        if (a.type === "endTurn") break;
      }
      if (state.phase === "main" && !state.pending) {
        r = resolve(state, { type: "endTurn" });
        push(r.step, r.next);
      }
    }
    const full = { ...record, steps };
    const again = replay(full);
    expect(again.error).toBeNull();
    expect(JSON.stringify(again.states.at(-1))).toBe(JSON.stringify(state));
    // 各ターンの最初の局面
    const turns = turnSnapshots(again.states);
    expect(turns[0]!.turn).toBe(1);
    expect(turns.map((t) => t.turn)).toEqual([...new Set(again.states.filter((s) => s.phase === "main").map((s) => s.turn))]);
    // 書き出して読み直すと同じ手順
    const out = exportRecord(full, "2026-11-14T01:00:00.000Z");
    const back = parseRecord(JSON.stringify(out));
    expect(back.steps).toEqual(steps);
    expect(JSON.stringify(replay(back).states.at(-1))).toBe(JSON.stringify(state));
  });

  it("プロのデッキと違うデッキの記録は読まない", () => {
    const { record } = start();
    const text = JSON.stringify({ ...record, decks: [record.decks[1], record.decks[1]] });
    expect(() => parseRecord(text)).toThrow(/プロのデッキ/);
    const other = JSON.stringify({ ...record, meta: { ...record.meta, seats: [{ deck: "mine/自作_ウィッチ" }, record.meta.seats[1]] } });
    expect(() => parseRecord(other)).toThrow(/プロのデッキにありません/);
    expect(proDeck(record.meta.seats[0].deck)).toBeDefined();
  });
});

describe("試合の記録: ランダムな結果", () => {
  it("ランダムな対象の候補を並べ、選んだ結果の乱数でたどると同じ局面", () => {
    const { s, me, opp } = setup(3);
    const foes = [toBoard(s, opp, "キャラバンマンモス"), toBoard(s, opp, "キャラバンマンモス", { defense: 2, maxDefense: 2 })];
    const iid = toHand(s, me, "怠惰なる波揺花");
    const action: Action = { type: "play", iid };
    const r = evaluate(s, { action, draws: [[], []] }, NAMES);
    expect(r.ev.kind).toBe("random");
    if (r.ev.kind !== "random") return;
    // 2 回の 2 ダメージの割り振り: 同じフォロワーに 2 回か、1 回ずつ（2 体目は 2 回目で破壊）
    expect(r.ev.outcomes.length).toBeGreaterThanOrEqual(2);
    for (const o of r.ev.outcomes) expect(o.changes.length).toBeGreaterThan(0);
    const o = r.ev.outcomes[r.ev.outcomes.length - 1]!;
    const done = evaluate(s, { action, draws: [[], []], rng: o.rng, outcomeKey: o.key }, NAMES);
    expect(done.ev.kind).toBe("done");
    if (done.ev.kind !== "done") return;
    const again = applyStep(s, { kind: "action", action, rng: o.rng });
    expect(JSON.stringify(again)).toBe(JSON.stringify(done.ev.next));
    expect(foes.length).toBe(2);

    // 絞り込み: 打つ前に場にあったカードごとの、打った後の値（同じ名前が 2 枚あれば、場の古いほうから何枚目か）
    const facets = new Map(varyingFacets(r.ev.outcomes));
    const second = [...facets.keys()].find((k) => k.includes("キャラバンマンモス") && k.includes("2 枚目"));
    expect(second).toBeDefined();
    expect(facets.get(second!)).toContain("場から離れた");
    const gone = r.ev.outcomes.filter((x) => outcomeMatches(x, { [second!]: "場から離れた" }));
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.length).toBeLessThan(r.ev.outcomes.length);
    for (const x of gone) expect(x.changes.some((c) => c.includes("の場から: キャラバンマンモス") && c.includes("2 枚目"))).toBe(true);
    // 項目を全部決めると 1 つに決まる
    for (const x of r.ev.outcomes) {
      const all = Object.fromEntries(x.facets.filter((f) => facets.has(f.key)).map((f) => [f.key, f.value]));
      expect(r.ev.outcomes.filter((y) => outcomeMatches(y, all))).toEqual([x]);
    }
  });

  it("手札を山札に戻して切り直してから引く手でも、決めたカードを引く乱数を探す", () => {
    const { s, me } = setup(5);
    const names = ["不屈のファイター", "ベルエンジェル・リア", "激震のゴリアテ", "探偵のルーペ", "冒険者のギルド"];
    s.players[me].deck = [...names, ...names, ...names].map((n) => ({ iid: s.nextIid++, cardId: id(n) })).concat(s.players[me].deck.slice(0, 10));
    toHand(s, me, "キャラバンマンモス");
    toHand(s, me, "不屈のファイター");
    const iid = toHand(s, me, "霧巻花の激憤");
    s.players[me].pp = 10;
    const action: Action = { type: "play", iid };
    const want = [id(names[1]!), id(names[2]!), id(names[3]!)];
    const { step, next } = resolve(s, action, (p, _remaining, taken) => {
      expect(p).toBe(me);
      return want[taken.length]!;
    });
    expect(step.kind).toBe("action");
    const got = next.players[me].hand.map((h) => h.cardId);
    for (const w of want) expect(got).toContain(w);
    expect(JSON.stringify(applyStep(s, step))).toBe(JSON.stringify(next));
    const drawn = drawnCards(runStep(s, action, step.kind === "action" ? (step.draws ?? [[], []]) : [[], []], step.kind === "action" ? step.rng : undefined).arranged, next, me);
    expect(drawn.map((c) => c.cardId).sort()).toEqual([...want].sort());
    expect(opponent(me)).not.toBe(me);
  });

  it("手札を山札に戻してから引く手（陽光の耳飾り）は、戻したカードを引き直しても、ランダムな結果でなく引いたカードとして聞く", () => {
    const { s, me } = setup(7);
    const back = toHand(s, me, "探偵のルーペ");
    toHand(s, me, "不屈のファイター");
    const ear = toHand(s, me, "陽光の耳飾り");
    const played = applyAction(s, { type: "play", iid: ear });
    expect(played.pending?.kind).toBe("choose");
    const action: Action = { type: "choose", targets: [back] };
    const r = evaluate(played, { action, draws: [[], []] }, NAMES);
    expect(r.ev.kind).toBe("draw");
    if (r.ev.kind !== "draw") return;
    // 引けたカードには、山札に戻した（山札に 1 枚も無かった）カードも入る。仮に打った局面の手札に、まだ決めていない引いたカードがある
    expect(r.ev.pool.get(id("探偵のルーペ"))).toBe(1);
    const { undecided, preview } = r.ev;
    expect(undecided.length).toBe(1);
    expect(preview.players[me].hand.some((h) => h.iid === undecided[0])).toBe(true);
    // 戻したカードを引き直したことにしても、ほかのカードを引いたことにしても打てて、たどると同じ局面
    for (const pick of [id("探偵のルーペ"), FILLER]) {
      const { step, next } = resolve(played, action, () => pick);
      const hand = next.players[me].hand.map((h) => h.cardId);
      expect(hand).toContain(pick);
      expect(hand.filter((c) => c === id("探偵のルーペ")).length).toBe(pick === FILLER ? 0 : 1);
      expect(JSON.stringify(applyStep(played, step))).toBe(JSON.stringify(next));
    }
  });

  it("引けるカードが 1 種類に決まる確定サーチ（屈辱なる放逐）は聞かずに決め、2 種類以上なら条件に合うカードだけを並べる", () => {
    const { s, me } = setup(11);
    const bane = id("束刃の咎人・カットスロート");
    s.players[me].deck = [bane, bane, ...Array(20).fill(FILLER)].map((cardId: string) => ({ iid: s.nextIid++, cardId }));
    const discard = toHand(s, me, "不屈のファイター");
    toHand(s, me, "探偵のルーペ");
    const spell = toHand(s, me, "屈辱なる放逐");
    const played = applyAction(s, { type: "play", iid: spell });
    expect(played.pending?.kind).toBe("choose");
    const action: Action = { type: "choose", targets: [discard] };
    const r = evaluate(played, { action, draws: [[], []] }, NAMES);
    expect(r.ev.kind).toBe("done");
    expect(r.step.draws[me]).toEqual([bane]);
    if (r.ev.kind === "done") expect(r.ev.next.players[me].hand.map((h) => h.cardId)).toContain(bane);

    // 条件に合うカードが 2 種類: 聞く。並べるのはその 2 種類だけ
    const iron = id("獣性の鉄人");
    played.players[me].deck = [...played.players[me].deck, { iid: played.nextIid++, cardId: iron }];
    const r2 = evaluate(played, { action, draws: [[], []] }, NAMES);
    expect(r2.ev.kind).toBe("draw");
    if (r2.ev.kind === "draw") expect([...r2.ev.pool.keys()].sort()).toEqual([bane, iron].sort());

    // 山札に重複が無く、条件付きで引いた後に上から 2 枚引く: 最初の枠（条件付き）は条件に合うカードだけ、後の枠は山札の全部
    const others = ["激震のゴリアテ", "不屈のファイター", "探偵のルーペ", "知恵の輝き"].map(id);
    played.players[me].deck = [bane, iron, ...others].map((cardId) => ({ iid: played.nextIid++, cardId }));
    const r3 = evaluate(played, { action, draws: [[], []] }, NAMES);
    expect(r3.ev.kind).toBe("draw");
    if (r3.ev.kind !== "draw") return;
    expect(r3.ev.undecided).toHaveLength(3);
    expect([...r3.ev.pool.keys()].sort()).toEqual([bane, iron].sort());
    const draws: Draws = [[], []];
    draws[me].push(bane);
    const r4 = evaluate(played, { action, draws }, NAMES);
    expect(r4.ev.kind).toBe("draw");
    if (r4.ev.kind === "draw") expect([...r4.ev.pool.keys()].sort()).toEqual([iron, ...others].sort());
  });

  it("山札に同じカードで手札での状態の違うもの（バフを受けたもの）があれば、分けて並べ、選んだほうを引く", () => {
    const { s, opp } = setup(12);
    const x = id("不屈のファイター");
    toHand(s, opp, "不屈のファイター", { attackMod: 1, defenseMod: 1 });
    const buffed = s.players[opp].hand.pop()!;
    s.players[opp].deck = [{ iid: s.nextIid++, cardId: x }, { iid: buffed.iid, cardId: x, kept: buffed }, ...s.players[opp].deck];
    const action: Action = { type: "endTurn" };
    const r = evaluate(s, { action, draws: [[], []] }, NAMES);
    expect(r.ev.kind).toBe("draw");
    if (r.ev.kind !== "draw") return;
    expect(r.ev.pool.get(`${x}|+1/+1`)).toBe(1);
    expect(r.ev.pool.get(`${x}|`)).toBe(1);
    expect(r.ev.kept.get(`${x}|+1/+1`)?.attackMod).toBe(1);
    const drawWith = (entry: string) => {
      const draws: Draws = [[], []];
      draws[opp].push(entry);
      const d = evaluate(s, { action, draws }, NAMES);
      expect(d.ev.kind).toBe("done");
      return d.ev.kind === "done" ? d.ev.next.players[opp].hand.find((h) => h.cardId === x)?.attackMod : undefined;
    };
    expect(drawWith(`${x}|+1/+1`)).toBe(1);
    expect(drawWith(`${x}|`)).toBe(0);
    // 状態を付けない指定（前の記録）は、山札の上から見て最初のもの
    expect(drawWith(x)).toBe(0);
  });

  it("引けないカードを選ぶと mismatch", () => {
    const { s, me } = setup(9);
    s.players[me].deck = [id("不屈のファイター"), id("探偵のルーペ")].map((cardId) => ({ iid: s.nextIid++, cardId })).concat(s.players[me].deck);
    const end = applyAction(s, { type: "endTurn" });
    expect(end.active).not.toBe(me);
    // 相手のターンの最初のドロー: 山札に無いカードは並べられない
    const opp = opponent(me);
    const r = evaluate(s, { action: { type: "endTurn" }, draws: me === 0 ? [[], [id("激震のゴリアテ")]] : [[id("激震のゴリアテ")], []] }, NAMES);
    expect(r.ev.kind === "error" || r.ev.kind === "mismatch").toBe(true);
    expect(opp).not.toBe(me);
  });
});

describe("試合の記録: 選び直して、その先をたどり直す", () => {
  it("引いたカードを選び直すと、その先の手順をたどり直し、たどれなくなった所・手で直した局面で止める", () => {
    const { s, me, opp } = setup(21);
    const a = id("刹那のクイックブレイダー");
    const b = id("天晶の魔手");
    s.players[opp].deck = [a, b].map((cardId) => ({ iid: s.nextIid++, cardId })).concat(s.players[opp].deck);
    const aIid = s.players[opp].deck[0]!.iid;
    const end: Action = { type: "endTurn" };
    const drawsOf = (p: PlayerIndex, e: string): Draws => {
      const d: Draws = [[], []];
      d[p].push(e);
      return d;
    };
    const playA: RecordStep = { kind: "action", action: { type: "play", iid: aIid } };
    const endOpp: RecordStep = { kind: "action", action: end, draws: drawsOf(me, FILLER) };
    const s1 = applyStep(s, { kind: "action", action: end, draws: drawsOf(opp, a) });
    expect(reapplySteps(s1, [playA, endOpp], NAMES).stopped).toBeNull();
    // 刹那のクイックブレイダーでなく天晶の魔手を引いたことにする: 刹那のクイックブレイダーをプレイする手でたどれなくなる
    const redone = applyStep(s, { kind: "action", action: end, draws: drawsOf(opp, b) });
    const r = reapplySteps(redone, [playA, endOpp], NAMES);
    expect(r.steps).toHaveLength(0);
    expect(r.stopped?.at).toBe(0);
    // 刹那のクイックブレイダーを出さない先なら最後までたどる
    const mark: RecordStep = { kind: "mark", note: "x" };
    const r2 = reapplySteps(redone, [mark, endOpp], NAMES);
    expect(r2.stopped).toBeNull();
    expect(r2.steps).toHaveLength(2);
    expect(r2.states[1]!.players[opp].hand.some((h) => h.cardId === b)).toBe(true);
    // 手で直した局面では止める
    const r3 = reapplySteps(redone, [mark, { kind: "edit", label: "x", state: s1 }], NAMES);
    expect(r3.steps).toHaveLength(1);
    expect(r3.stopped?.at).toBe(1);
  });
});

describe("試合の記録: 手札を出す順", () => {
  it("マリガンで引いたカードは返したカードの枠に入り、そのあとも枠を保つ", () => {
    // エンジンは残したカードを前に詰め、引いたカードを末尾に足す
    const m = nextHandOrder([1, 2, 3, 4], [1, 2, 3, 4], [2, 4, 5, 6], [1, 3]);
    expect(m).toEqual([5, 2, 6, 4]);
    // 引いたカードは右に足す。プレイしたカードは抜ける
    expect(nextHandOrder(m, [2, 4, 5, 6], [2, 4, 5, 6, 7], null)).toEqual([5, 2, 6, 4, 7]);
    expect(nextHandOrder([5, 2, 6, 4, 7], [2, 4, 5, 6, 7], [2, 4, 6, 7], null)).toEqual([2, 6, 4, 7]);
    // 手札を離れて戻ってきたカード（山札に戻して引き直す等。実体 ID は同じ）は右に
    expect(nextHandOrder([5, 2, 6, 4], [2, 4, 5, 6], [2, 4, 6, 5], null)).toEqual([2, 6, 4, 5]);
    // 全部返したとき
    expect(nextHandOrder([1, 2, 3, 4], [1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 3, 4])).toEqual([5, 6, 7, 8]);
  });
});

describe("試合の記録: リポジトリに置いた記録（records/pro/）", () => {
  it("メモの URL から YouTube の si= を除く", () => {
    expect(cleanMemo("https://www.youtube.com/live/abc?si=XyZ_1&t=1657")).toBe("https://www.youtube.com/live/abc?t=1657");
    expect(cleanMemo("https://youtu.be/abc?si=XyZ 後半")).toBe("https://youtu.be/abc 後半");
    expect(cleanMemo("1 試合目 https://www.youtube.com/watch?v=abc&si=q&t=30s")).toBe("1 試合目 https://www.youtube.com/watch?v=abc&t=30s");
    expect(cleanMemo("動画の 28 分あたり")).toBe("動画の 28 分あたり");
  });

  // たどれるかは見ない（カードの能力を書き足すと、前に入れた記録がたどれなくなりうる。そのときは各ターンの最初の局面から検討する）
  const dir = "records/pro";
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("記録がある", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`${f}: 読めて、勝敗まで入っていて、各ターンの最初の局面がある`, () => {
      const rec = parseRecord(readFileSync(`${dir}/${f}`, "utf8"));
      expect(rec.result).not.toBeNull();
      expect(rec.turns?.length ?? 0).toBeGreaterThan(0);
      expect(rec.meta.memo).toBe(cleanMemo(rec.meta.memo));
    });
  }
});
