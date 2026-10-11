// 人間と AI を同じ試合で比べるときの試合の決め方（npm run rhino-compare / af-compare と web の「人間との比較」で共通に使う）
//
// 比べるデッキ（リノセウスエルフ・AFネメシス）vs 他の 6 デッキ（ランプドラゴンは除く）を、試合番号 g と、比べるデッキの席（0/1）ごとに
// 決まったシードで打つ。同じ（比べるデッキ・相手デッキ・g・席）なら、AI でも人間でも同じ初期局面（先攻・山札の順番・初手）から始まる。

import { DEFAULT_DECKS, type DefaultDeck } from "../cards/defaultDecks";
import type { PlayerIndex } from "../engine";

export type SubjectId = "rhino" | "af";

export interface CompareSubject {
  id: SubjectId;
  /** 比べるデッキ（人間が使う）の名前 */
  deck: string;
  /** スクリプトで比べるデッキ側に使う既定の AI（src/ai/registry.ts のキー） */
  agent: string;
  /** シードの基準（デッキごとに別の試合にする） */
  seedBase: number;
  /** 人間の記録を保存するブラウザのキー */
  storageKey: string;
}

export const SUBJECTS: Readonly<Record<SubjectId, CompareSubject>> = {
  rhino: { id: "rhino", deck: "リノセウスエルフ", agent: "rhino", seedBase: 900000, storageKey: "svwb-sim:rhino-human:v1" },
  af: { id: "af", deck: "AFネメシス", agent: "search", seedBase: 800000, storageKey: "svwb-sim:af-human:v1" },
};
export const SUBJECT_IDS = Object.keys(SUBJECTS) as SubjectId[];

export const isSubjectId = (v: unknown): v is SubjectId => typeof v === "string" && v in SUBJECTS;

const EXCLUDED_DECKS = ["ランプドラゴン"];
/** 相手の AI（src/ai/registry.ts のキー） */
export const OPPONENT_AGENT = "search";

export function subjectDeck(subject: SubjectId): DefaultDeck {
  const name = SUBJECTS[subject].deck;
  const deck = DEFAULT_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`${name} がありません`);
  return deck;
}

export function opponentsOf(subject: SubjectId): DefaultDeck[] {
  const name = SUBJECTS[subject].deck;
  return DEFAULT_DECKS.filter((d) => d.name !== name && !EXCLUDED_DECKS.includes(d.name));
}

export const compareSeed = (subject: SubjectId, g: number, seat: PlayerIndex) => SUBJECTS[subject].seedBase + g * 13 + seat;

/** 1 試合の設定。opponent は相手デッキの名前、seat は比べるデッキの席 */
export function compareMatch(subject: SubjectId, opponent: string, g: number, seat: PlayerIndex): { decks: [string[], string[]]; seed: number } {
  const me = subjectDeck(subject);
  const opp = opponentsOf(subject).find((d) => d.name === opponent);
  if (!opp) throw new Error(`相手デッキがありません: ${opponent}`);
  return { decks: seat === 0 ? [me.cards, opp.cards] : [opp.cards, me.cards], seed: compareSeed(subject, g, seat) };
}
