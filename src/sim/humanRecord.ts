// 人間が「リノセウス比較」の試合を打った記録（web で保存・書き出しする形式）
//
// 1 試合 1 行の JSON Lines で書き出す。deck・g・elfSeat・won は npm run rhino-compare の --out と同じ意味なので、
// AI の結果と試合ごとに突き合わせられる。actions は行動の列そのもので、同じ decks・seed から再生できる（src/sim/replay.ts）。

import { actingPlayer, applyAction, createGame, type Action, type GameState, type PlayerIndex } from "../engine";
import { describeAction } from "../ui/describe";
import { rhinoMatch, RHINO_OPPONENT_AGENT } from "./rhinoCompare";

export const HUMAN_RECORD_KIND = "rhino-compare-human";

/** 1 ターン（同じプレイヤーが続けて行った行動）の選択 */
export interface TurnChoices {
  /** ゲーム全体のターン番号（マリガンは 0） */
  turn: number;
  /** "you"（人間＝リノセウスエルフ）か "opponent"（AI） */
  by: "you" | "opponent";
  choices: string[];
}

export interface HumanGameRecord {
  kind: typeof HUMAN_RECORD_KIND;
  version: 1;
  /** 相手デッキの名前 */
  deck: string;
  g: number;
  /** リノセウスエルフ（人間）の席 */
  elfSeat: PlayerIndex;
  seed: number;
  won: boolean;
  /** 人間が先攻か */
  first: boolean;
  turns: number;
  opponentAgent: string;
  /** ビルドのコミット（不明なら空） */
  commit: string;
  /** 対戦を終えた日時（ISO 8601） */
  playedAt: string;
  turnLog: TurnChoices[];
  actions: Action[];
}

/** 行動の列をターンごとにまとめ、文章にする */
export function turnLog(initial: GameState, actions: readonly Action[], human: PlayerIndex): TurnChoices[] {
  const out: TurnChoices[] = [];
  let s = initial;
  for (const a of actions) {
    const actor = actingPlayer(s);
    const by = actor === human ? "you" : "opponent";
    const last = out[out.length - 1];
    const text = describeAction(s, a, human);
    if (last && last.turn === s.turn && last.by === by) last.choices.push(text);
    else out.push({ turn: s.turn, by, choices: [text] });
    s = applyAction(s, a);
  }
  return out;
}

export function buildHumanRecord(args: {
  deck: string;
  g: number;
  elfSeat: PlayerIndex;
  actions: readonly Action[];
  commit: string;
  playedAt: string;
}): HumanGameRecord {
  const { deck, g, elfSeat, actions } = args;
  const { decks, seed } = rhinoMatch(deck, g, elfSeat);
  const initial = createGame({ decks, seed });
  let final = initial;
  for (const a of actions) final = applyAction(final, a);
  if (final.phase !== "ended" || final.winner === null) throw new Error("試合が終わっていません");
  return {
    kind: HUMAN_RECORD_KIND,
    version: 1,
    deck,
    g,
    elfSeat,
    seed,
    won: final.winner === elfSeat,
    first: initial.first === elfSeat,
    turns: final.turn,
    opponentAgent: RHINO_OPPONENT_AGENT,
    commit: args.commit,
    playedAt: args.playedAt,
    turnLog: turnLog(initial, actions, elfSeat),
    actions: [...actions],
  };
}

/** 保存した値を検証する（形が違うものは null） */
export function parseHumanRecord(v: unknown): HumanGameRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (
    r.kind !== HUMAN_RECORD_KIND ||
    r.version !== 1 ||
    typeof r.deck !== "string" ||
    typeof r.g !== "number" ||
    (r.elfSeat !== 0 && r.elfSeat !== 1) ||
    typeof r.seed !== "number" ||
    typeof r.won !== "boolean" ||
    typeof r.turns !== "number" ||
    !Array.isArray(r.actions) ||
    !Array.isArray(r.turnLog)
  )
    return null;
  return v as HumanGameRecord;
}

export const toJsonLines = (records: readonly HumanGameRecord[]) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
