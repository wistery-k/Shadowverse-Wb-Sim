// リプレイ検索（開発サーバー npm run dev だけの「リプレイ検索」タブ）で使う型。
// 自己対戦などで記録した試合（デッキ・シード・行動の列）をエンジンで打ち直し、ターンごとのまとめから条件に合うターンを探す。

import type { ClassId } from "../cards";
import type { Action, PlayerIndex } from "../engine";

/**
 * 1 試合の記録。--replays の 1 行（rust/engine/src/runner/mod.rs の ReplayRecord）と、
 * npm run game --json・rhino-compare --record の記録（seed・agents・decks・winner・actions）を読める
 */
export interface ReplayRecord {
  seed: number;
  /** プレイヤー0・1 のデッキ（カードIDの列。並び順も山札のシャッフルに効く） */
  decks: [string[], string[]];
  actions: Action[];
  /** 打った AI の名前（無ければ空） */
  agents: [string, string];
  /** デッキの名前（記録に無ければデフォルトデッキと照らすか、クラス名から作る） */
  names: [string, string];
  /** 記録にある勝者（打ち直した結果と比べる。無ければ null） */
  winner: PlayerIndex | null;
  /** 記録したランナー（td selfplay・compare 等） */
  source?: string;
  /** ランナーの試合番号 */
  g?: number;
}

// ---- rust/engine/src/replay_index.rs が返すターンごとのまとめ（形を変えたら両方を直す） ----

/** 場のカード。フォロワーは a・d・e（進化 0: なし、1: 進化、2: 超進化）、アミュレットは cd（カウントダウン） */
export interface BoardSnap {
  c: string;
  i: number;
  a?: number;
  d?: number;
  e?: 0 | 1 | 2;
  cd?: number | null;
}

/** あるときのプレイヤーの様子 */
export interface SideSnap {
  hp: number;
  maxHp: number;
  maxPp: number;
  pp: number;
  ep: number;
  sep: number;
  /** エクストラPPを使えるか */
  xpp: boolean;
  deck: number;
  grave: number;
  hand: string[];
  board: BoardSnap[];
}

export type TurnEventKind = "play" | "attack" | "act" | "fuse" | "extraPp" | "enter" | "leave" | "evolve" | "superEvolve";

/**
 * ターンに起きたこと。p は行動したプレイヤー（enter・leave・evolve・superEvolve は場のカードの持ち主）、
 * at はその出来事を起こした行動の添字。attack の t は攻撃先のカードID か "leader"
 */
export interface TurnEvent {
  k: TurnEventKind;
  p: PlayerIndex;
  at: number;
  c?: string;
  i?: number;
  t?: string;
  ti?: number;
  /** 融合の素材 */
  m?: string[];
}

export interface TurnIndex {
  /** 全体のターン番号（1〜） */
  n: number;
  /** 手番のプレイヤー */
  p: PlayerIndex;
  /** 手番のプレイヤーの何ターン目か */
  tc: number;
  /** ターンの始めの局面の添字（リプレイの局面 = その手番の最初の行動の直前） */
  s: number;
  /** ターンを終えた後の局面の添字 */
  e: number;
  start: [SideSnap, SideSnap];
  end: [SideSnap, SideSnap];
  ev: TurnEvent[];
}

export interface GameIndex {
  first: PlayerIndex;
  winner: PlayerIndex | null;
  /** 決着まで打ったか */
  ended: boolean;
  steps: number;
  turns: TurnIndex[];
}

/** 読み込んだ 1 試合 */
export interface LoadedGame {
  /** Worker の中での番号 */
  id: number;
  /** 読んだファイル */
  file: string;
  /** ファイルの何行目か（JSON Lines の行。JSON ファイルなら 1）と、その行が試合の配列なら何番目か（0〜） */
  line: number;
  sub: number;
  record: ReplayRecord;
  index: GameIndex;
  classes: [ClassId, ClassId];
  /** 記録の勝者と打ち直した勝者が違う（記録したときとエンジンの版が違う可能性） */
  mismatch: boolean;
}
