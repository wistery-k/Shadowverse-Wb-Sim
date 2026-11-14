// 試合の記録（src/record/。開発サーバーだけの「試合の記録」の画面の中身）:
// プロのデッキだけを選べること、引いたカード・ランダムな結果を決めて手を打てること、記録をたどると同じ局面になること。

import { describe, expect, it } from "vitest";
import { ALL_CARDS, CARDS_BY_ID } from "../src/cards";
import { AZVALDT_CARDS } from "../src/cards/pools";
import { applyAction, cardOf, legalActions, opponent, type Action, type GameState, type PlayerIndex } from "../src/engine";
import { findProDeck, PRO_DECKS, PRO_EVENTS, proDeck } from "../src/record/decks";
import { POOL_CARD_BY_NAME } from "../src/record/pool";
import {
  applyStep,
  deckRemaining,
  drawnCards,
  evaluate,
  exportRecord,
  newRecord,
  parseRecord,
  replay,
  RecordError,
  runStep,
  setInitialHand,
  turnSnapshots,
  type Draws,
  type MatchRecord,
  type PendingStep,
  type RecordStep,
} from "../src/record/record";
import { setup, toBoard, toHand } from "./poolScenario";

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
    const remaining = deckRemaining(state, ev.player, step.draws[ev.player]);
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
