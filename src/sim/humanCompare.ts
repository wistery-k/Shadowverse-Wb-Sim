// 人間と AI を同じ試合で比べるときの試合の決め方（npm run rhino-compare / af-compare / spellwitch-compare / bishop-compare / dragon-compare / nightmare-compare / royal-compare と web の「人間との比較」で共通に使う）
//
// 比べるデッキ（リノセウスエルフ・AFネメシス・スペルウィッチ・アミュレット疾走ビショップ・疾走ドラゴン・ミッドレンジナイトメア・アマリアロイヤル）vs 他の 6 デッキ（ランプドラゴンは除く）を、試合番号 g と、比べるデッキの席（0/1）ごとに
// 決まったシードで打つ。同じ（比べるデッキ・相手デッキ・g・席）なら、AI でも人間でも同じ初期局面（先攻・山札の順番・初手）から始まる。

import { DEFAULT_DECKS, type DefaultDeck } from "../cards/defaultDecks";
import type { PlayerIndex } from "../engine";

export type SubjectId = "rhino" | "af" | "spellwitch" | "bishop" | "dragon" | "nightmare" | "royal";

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
  spellwitch: { id: "spellwitch", deck: "スペルウィッチ", agent: "search", seedBase: 700000, storageKey: "svwb-sim:spellwitch-human:v1" },
  bishop: { id: "bishop", deck: "アミュレット疾走ビショップ", agent: "search", seedBase: 600000, storageKey: "svwb-sim:bishop-human:v1" },
  dragon: { id: "dragon", deck: "疾走ドラゴン", agent: "search", seedBase: 500000, storageKey: "svwb-sim:dragon-human:v1" },
  nightmare: { id: "nightmare", deck: "ミッドレンジナイトメア", agent: "search", seedBase: 400000, storageKey: "svwb-sim:nightmare-human:v1" },
  royal: { id: "royal", deck: "アマリアロイヤル", agent: "search", seedBase: 300000, storageKey: "svwb-sim:royal-human:v1" },
};
export const SUBJECT_IDS = Object.keys(SUBJECTS) as SubjectId[];

export const isSubjectId = (v: unknown): v is SubjectId => typeof v === "string" && v in SUBJECTS;

const EXCLUDED_DECKS = ["ランプドラゴン"];
/**
 * 相手の AI の選択肢。
 * - yardstick: 強さの物差し（学習した評価の補正を入れる前の探索 AI を凍結したもの。rhino-compare の相手 search-classic と同じ手を指す）。
 *   今までの人間の対戦記録・AI の結果と比べられる
 * - latest: 今の既定の探索 AI（最新版）
 */
export type OpponentId = "yardstick" | "latest";

export const OPPONENTS: Readonly<Record<OpponentId, { agent: string; label: string }>> = {
  yardstick: { agent: "yardstick", label: "物差し" },
  latest: { agent: "search", label: "最新版" },
};
export const OPPONENT_IDS = Object.keys(OPPONENTS) as OpponentId[];
export const DEFAULT_OPPONENT: OpponentId = "yardstick";

export const isOpponentId = (v: unknown): v is OpponentId => typeof v === "string" && v in OPPONENTS;

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
