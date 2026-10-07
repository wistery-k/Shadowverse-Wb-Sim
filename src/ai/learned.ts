// 自己対戦のデータから学習した評価関数（線形モデル、scripts/learn-main.ts で学習する）。
//
// 局面の特徴量（体力・盤面・手札など）の重み付き和で「勝つ確率の対数オッズ」を近似する。
// 特徴量は数値の特徴（NUMERIC_FEATURES）と、カードごとの特徴（自分の手札・自分の場・相手の場にある枚数）。
// 相手の手札の中身は見えない情報なので使わない（枚数だけ使う）。

import model from "../../data/ai-model.json";
import type { FollowerOnBoard, GameState, PlayerIndex, PlayerState } from "../engine";
import { DEFAULT_WEIGHTS, evaluateWith, KEYWORD_VALUE } from "./evaluate";

/** 片方のプレイヤーについての数値の特徴 */
const SIDE_FEATURES = [
  "hp",
  "attack",
  "defense",
  "followers",
  "tempAttack",
  "keywords",
  "amulets",
  "sigils",
  "hand",
  "ep",
  "sep",
  "extraPp",
  "crests",
  "graveyard",
  "deck",
] as const;

/** 数値の特徴の名前（自分は my*, 相手は opp*、ほかに局面全体の特徴） */
export const NUMERIC_FEATURES: readonly string[] = [
  ...SIDE_FEATURES.map((f) => `my.${f}`),
  ...SIDE_FEATURES.map((f) => `opp.${f}`),
  // 手番が自分か
  "myTurn",
  // 相手リーダーの体力が 10 以下のときの自分のフォロワーの攻撃力の合計（逆も）
  "myLethalAttack",
  "oppLethalAttack",
];

export interface LinearModel {
  /** 基準の評価関数（evaluate.ts の DEFAULT_WEIGHTS）の値にかける重み。学習は基準の評価関数への補正として行う */
  base?: number;
  /** 数値の特徴の重み（NUMERIC_FEATURES の名前 → 重み） */
  num: Readonly<Record<string, number>>;
  /** カードIDごとの重み: 自分の手札・自分の場・相手の場にある 1 枚あたり */
  hand: Readonly<Record<string, number>>;
  myBoard: Readonly<Record<string, number>>;
  oppBoard: Readonly<Record<string, number>>;
}

/** 疎な特徴量（学習用）。数値は NUMERIC_FEATURES と同じ順、カードは ID の並び（重複あり） */
export interface Features {
  /** 基準の評価関数の値 */
  base: number;
  num: number[];
  hand: string[];
  myBoard: string[];
  oppBoard: string[];
}

function sideFeatures(pl: PlayerState): number[] {
  let attack = 0, defense = 0, followers = 0, tempAttack = 0, keywords = 0, amulets = 0, sigils = 0;
  for (const c of pl.board) {
    if (c.kind === "follower") {
      const f = c as FollowerOnBoard;
      attack += f.attack;
      defense += f.defense;
      followers++;
      tempAttack += f.tempAttack;
      for (const k of f.keywords) keywords += KEYWORD_VALUE[k] ?? 0;
      for (const k of f.tempKeywords) keywords += KEYWORD_VALUE[k] ?? 0;
    } else {
      amulets++;
      sigils += c.sigils ?? 0;
    }
  }
  return [
    pl.leaderHp,
    attack,
    defense,
    followers,
    tempAttack,
    keywords,
    amulets,
    sigils,
    pl.hand.length,
    pl.ep,
    pl.sep,
    pl.extraPpAvailable ? 1 : 0,
    pl.crests.length,
    Math.min(pl.graveyard, 10),
    pl.deck.length,
  ];
}

/** プレイヤー p から見た局面の特徴量（ゲーム終了後の局面には使わない） */
export function featuresOf(state: GameState, p: PlayerIndex): Features {
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  const my = sideFeatures(me);
  const their = sideFeatures(opp);
  const myAttack = my[1] as number;
  const oppAttack = their[1] as number;
  return {
    base: evaluateWith(state, p, DEFAULT_WEIGHTS),
    num: [
      ...my,
      ...their,
      state.active === p ? 1 : 0,
      opp.leaderHp <= 10 ? myAttack : 0,
      me.leaderHp <= 10 ? oppAttack : 0,
    ],
    hand: me.hand.map((h) => h.cardId),
    myBoard: me.board.map((c) => c.cardId),
    oppBoard: opp.board.map((c) => c.cardId),
  };
}

/** 線形モデルの値（勝つ確率の対数オッズ） */
export function linearValue(f: Features, m: LinearModel): number {
  let v = f.base * (m.base ?? 0);
  for (let i = 0; i < f.num.length; i++) v += (f.num[i] as number) * (m.num[NUMERIC_FEATURES[i] as string] ?? 0);
  for (const id of f.hand) v += m.hand[id] ?? 0;
  for (const id of f.myBoard) v += m.myBoard[id] ?? 0;
  for (const id of f.oppBoard) v += m.oppBoard[id] ?? 0;
  return v;
}

/**
 * 学習した評価関数でのプレイヤー p から見た評価値。
 * 探索 AI の他の数値（評価されなかった手の割り引きなど）と尺度を合わせるため、
 * 「相手リーダーの体力 1」が 1 点になるように換算する
 */
export function evaluateLearned(state: GameState, p: PlayerIndex, m: LinearModel = LEARNED_MODEL): number {
  if (state.phase === "ended") return state.winner === p ? 1e6 : -1e6;
  return linearValue(featuresOf(state, p), m) / unitOf(m);
}

/** 「相手リーダーの体力 1」にあたるモデルの値（基準の評価関数では相手リーダーの体力 1 が oppHp 点） */
export function unitOf(m: LinearModel): number {
  return Math.abs((m.num["opp.hp"] ?? 0) - (m.base ?? 0) * DEFAULT_WEIGHTS.oppHp) || 1;
}

export const LEARNED_MODEL: LinearModel = model as LinearModel;
