// 試合の記録の検討（段階 4。docs/match-record.md「検討」）のうち、記録を確かめて、打ち比べる局面を作る部分。
// npm run review（scripts/review-main.ts）とテストから使う。開発のコマンドだけ（公開サイトの束にも、開発サーバーの画面にも入れない）。
// ここは AI を呼ばない。打ち比べは Rust（svwb review run。rust/engine/src/runner/review.rs）。
//
// 局面は、ターンごとに、記録に保存した各ターンの最初の局面（turns[t].state）から作る（docs/match-record.md の決め:
// エンジンやカードの能力を後で直すと、たどれなくなる手順がありうる。そのときは各ターンの最初の局面から検討する）。
// たどれるかはターンごとに見る（そのターンの手順を当てて、次のターンの保存した局面と合うか。最後のターンは試合の終わりと勝敗）。

import { AZVALDT_CARDS } from "../cards/pools";
import type { GameState } from "../engine/types";
import { applyStep, normalize, RecordError, resultOf, type MatchRecord } from "./record";

/** 1 ターンの局面（Rust に渡す 1 行）。states[j] は手順 step + j の前の局面。たどれないターンは最初の局面だけ */
export interface TurnPoints {
  turn: number;
  trace: string | null;
  states: { step: number; state: GameState }[];
}

/** 前期のローテーションのプールのカード（トークンを除く） */
const POOL_IDS: ReadonlySet<string> = new Set(AZVALDT_CARDS.filter((c) => c.set !== "token").map((c) => c.id));

/**
 * 検討してよい記録か（線引き 3・4。線引き 1 のデッキは parseRecord が確かめる）。駄目なら RecordError。
 * 勝敗が入っていること、各ターンの最初の局面があること、デッキのカードが前期のローテーションのプールにあること
 */
export function checkForReview(record: MatchRecord): void {
  if (!record.result) throw new RecordError("勝敗まで入れて保存した記録だけを検討します（この記録には勝敗がありません）");
  if (!record.turns || record.turns.length === 0) throw new RecordError("各ターンの最初の局面の無い記録は検討しません（画面で書き出した記録を使ってください）");
  for (const p of [0, 1] as const) {
    const bad = record.decks[p].find((id) => !POOL_IDS.has(id));
    if (bad !== undefined) throw new RecordError(`席 ${p} のデッキに、前期のローテーションのプールに無いカード ${bad} があります`);
  }
}

const same = (a: GameState, b: GameState) => JSON.stringify(a) === JSON.stringify(b);

/** ターンごとの局面（保存した最初の局面から、そのターンの手順を当てたもの）と、たどれたか */
export function turnPoints(record: MatchRecord): TurnPoints[] {
  checkForReview(record);
  const turns = record.turns!;
  const out: TurnPoints[] = [];
  for (let t = 0; t < turns.length; t++) {
    const snap = turns[t]!;
    const start = normalize(snap.state);
    const end = t + 1 < turns.length ? turns[t + 1]!.step : record.steps.length;
    const states: { step: number; state: GameState }[] = [];
    let cur = start;
    let trace: string | null = null;
    for (let j = snap.step; j < end; j++) {
      states.push({ step: j, state: cur });
      try {
        cur = applyStep(cur, record.steps[j]!);
      } catch (e) {
        trace = `手順 ${j + 1} をたどれません（${e instanceof Error ? e.message : String(e)}）`;
        break;
      }
    }
    if (trace === null) {
      if (t + 1 < turns.length) {
        if (!same(cur, normalize(turns[t + 1]!.state))) trace = "次のターンの保存した局面と合いません";
      } else {
        const r = resultOf(record.steps, cur);
        if (!r || r.winner !== record.result!.winner || r.reason !== record.result!.reason) trace = "試合の終わりが記録の勝敗と合いません";
      }
    }
    out.push({ turn: t, trace, states: trace === null ? states : [{ step: snap.step, state: start }] });
  }
  return out;
}

/** Rust に渡す局面のファイル（JSON Lines。1 行目は頭） */
export function pointsFile(record: MatchRecord, name: string, turns: readonly TurnPoints[]): string {
  const head = { header: true, record: name, result: record.result, turns: record.turns?.length ?? 0 };
  return [head, ...turns].map((x) => JSON.stringify(x)).join("\n") + "\n";
}
