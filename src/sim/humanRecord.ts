// 人間が「人間との比較」の試合を打った記録（web で保存・書き出しする形式）
//
// 1 試合 1 行の JSON Lines で書き出す。subject・deck・g・seat・won は npm run rhino-compare の --out と同じ意味なので、
// AI の結果と試合ごとに突き合わせられる。actions は行動の列そのもので、同じ decks・seed から再生できる（src/sim/replay.ts）。
// version 1（リノセウスエルフだけの頃）は席を elfSeat に持っていた。読むときに version 2 の形にする。

import { actingPlayer, applyAction, createGame, type Action, type GameState, type PlayerIndex } from "../engine";
import { describeAction } from "../ui/describe";
import { compareMatch, DEFAULT_OPPONENT, isOpponentId, isSubjectId, OPPONENTS, type OpponentId, type SubjectId } from "./humanCompare";

export const HUMAN_RECORD_KIND = "human-compare";
const HUMAN_RECORD_KIND_V1 = "rhino-compare-human";

/** 1 ターン（同じプレイヤーが続けて行った行動）の選択 */
export interface TurnChoices {
  /** ゲーム全体のターン番号（マリガンは 0） */
  turn: number;
  /** "you"（人間＝比べるデッキ）か "opponent"（AI） */
  by: "you" | "opponent";
  choices: string[];
}

export interface HumanGameRecord {
  kind: typeof HUMAN_RECORD_KIND;
  version: 2;
  /** 人間が使ったデッキ（src/sim/humanCompare.ts の SUBJECTS のキー） */
  subject: SubjectId;
  /** 相手デッキの名前 */
  deck: string;
  g: number;
  /** 人間の席 */
  seat: PlayerIndex;
  seed: number;
  won: boolean;
  /** 人間が先攻か */
  first: boolean;
  turns: number;
  /** 相手の AI の選択肢（src/sim/humanCompare.ts の OPPONENTS）。選べるようにする前の記録はその頃の比較用の相手（物差しかその前身）なので yardstick として読む */
  opponent: OpponentId;
  /** 相手の AI（src/ai/registry.ts のキー。選べるようにする前は search-classic、2026-10-14 より前は search） */
  opponentAgent: string;
  /** ビルドのコミット（不明なら空） */
  commit: string;
  /** 対戦を終えた日時（ISO 8601） */
  playedAt: string;
  turnLog: TurnChoices[];
  actions: Action[];
  /** 「リーサルを取る」ボタンで自動で行った行動の番号（actions の添字） */
  autoActions: number[];
}

/** 行動の列をターンごとにまとめ、文章にする */
export function turnLog(initial: GameState, actions: readonly Action[], human: PlayerIndex, autoActions: readonly number[] = []): TurnChoices[] {
  const out: TurnChoices[] = [];
  const auto = new Set(autoActions);
  let s = initial;
  for (const [i, a] of actions.entries()) {
    const actor = actingPlayer(s);
    const by = actor === human ? "you" : "opponent";
    const last = out[out.length - 1];
    const next = applyAction(s, a);
    const text = describeAction(s, a, human, next) + (auto.has(i) ? "（自動）" : "");
    if (last && last.turn === s.turn && last.by === by) last.choices.push(text);
    else out.push({ turn: s.turn, by, choices: [text] });
    s = next;
  }
  return out;
}

export function buildHumanRecord(args: {
  subject: SubjectId;
  deck: string;
  g: number;
  seat: PlayerIndex;
  /** 相手の AI（省略すると物差し） */
  opponent?: OpponentId;
  actions: readonly Action[];
  autoActions?: readonly number[];
  commit: string;
  playedAt: string;
}): HumanGameRecord {
  const { subject, deck, g, seat, actions } = args;
  const opponent = args.opponent ?? DEFAULT_OPPONENT;
  const { decks, seed } = compareMatch(subject, deck, g, seat);
  const initial = createGame({ decks, seed });
  let final = initial;
  for (const a of actions) final = applyAction(final, a);
  if (final.phase !== "ended" || final.winner === null) throw new Error("試合が終わっていません");
  return {
    kind: HUMAN_RECORD_KIND,
    version: 2,
    subject,
    deck,
    g,
    seat,
    seed,
    won: final.winner === seat,
    first: initial.first === seat,
    turns: final.turn,
    opponent,
    opponentAgent: OPPONENTS[opponent].agent,
    commit: args.commit,
    playedAt: args.playedAt,
    turnLog: turnLog(initial, actions, seat, args.autoActions),
    actions: [...actions],
    autoActions: [...(args.autoActions ?? [])],
  };
}

/** 保存した値を検証する（形が違うものは null）。version 1 はリノセウスエルフの記録として読む */
export function parseHumanRecord(v: unknown): HumanGameRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const v1 = r.kind === HUMAN_RECORD_KIND_V1 && r.version === 1;
  if (!v1 && !(r.kind === HUMAN_RECORD_KIND && r.version === 2)) return null;
  const subject = v1 ? "rhino" : r.subject;
  const seat = v1 ? r.elfSeat : r.seat;
  if (
    !isSubjectId(subject) ||
    (seat !== 0 && seat !== 1) ||
    typeof r.deck !== "string" ||
    typeof r.g !== "number" ||
    typeof r.seed !== "number" ||
    typeof r.won !== "boolean" ||
    typeof r.turns !== "number" ||
    !Array.isArray(r.actions) ||
    !Array.isArray(r.turnLog)
  )
    return null;
  const { elfSeat: _elfSeat, ...rest } = r;
  return {
    ...(rest as Omit<HumanGameRecord, "kind" | "version" | "subject" | "seat" | "opponent" | "autoActions">),
    kind: HUMAN_RECORD_KIND,
    version: 2,
    subject,
    seat,
    opponent: isOpponentId(r.opponent) ? r.opponent : "yardstick",
    autoActions: Array.isArray(r.autoActions) ? (r.autoActions as number[]) : [],
  };
}

export const toJsonLines = (records: readonly HumanGameRecord[]) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
