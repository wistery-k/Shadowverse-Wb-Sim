// ゲーム状態とアクションの型。状態は JSON シリアライズ可能に保つ（クラス・関数・Map を入れない）。

import type { Ability, Effect } from "./dsl";

export type PlayerIndex = 0 | 1;

/** 常在型のキーワード */
export type StaticKeyword =
  | "ward" // 守護
  | "storm" // 疾走
  | "rush" // 突進
  | "bane" // 必殺
  | "drain" // ドレイン
  | "ambush" // 潜伏
  | "intimidate" // 威圧
  | "barrier" // バリア
  | "aura"; // オーラ

export type EvolveState = "none" | "evolved" | "superEvolved";

/** 山札のカード */
export interface CardRef {
  /** ゲーム内で一意なインスタンスID（正の整数）。リーダーは負の値（LEADER_ID）。 */
  iid: number;
  cardId: string;
}

/** 手札のカード。手札にある間に受けた変化を持つ。 */
export interface HandCard extends CardRef {
  costMod: number;
  attackMod: number;
  defenseMod: number;
  /** スペルブーストされた回数 */
  boosts: number;
  /** X（ストームブラスト等）。持たないカードは null */
  x: number | null;
  /** 手札で付与されたキーワード（魔煌のトリックスター・ラスティ等） */
  keywords: StaticKeyword[];
  /** これまでに融合した素材のカードID（種類） */
  fusedKinds: string[];
  fusedThisTurn: boolean;
}

interface OnBoardBase extends CardRef {
  keywords: StaticKeyword[];
  /** ターン終了までの一時的なキーワード */
  tempKeywords: StaticKeyword[];
  /** 付与された能力 */
  granted: Ability[];
  /** 場に出た順の通し番号（古いもの優先の処理に使う） */
  order: number;
}

/** 場のフォロワー */
export interface FollowerOnBoard extends OnBoardBase {
  kind: "follower";
  attack: number;
  defense: number;
  maxDefense: number;
  /** ターン終了までの攻撃力の増減 */
  tempAttack: number;
  /** 1ターンに攻撃できる回数 */
  maxAttacks: number;
  attacksThisTurn: number;
  /** 場に出たときの全体のターン番号 */
  enteredTurn: number;
  evolve: EvolveState;
  /** このターン番号の終了まで攻撃できない（スノーアウェイク） */
  cannotAttackUntil: number | null;
  x: number | null;
  /** 能力の「自分のターンごとに1回」を使ったターン番号（能力の添字ごと） */
  usedOncePerTurn: Record<string, number>;
}

/** 場のアミュレット */
export interface AmuletOnBoard extends OnBoardBase {
  kind: "amulet";
  /** カウントダウンを持たなければ null */
  countdown: number | null;
  /** 【土の印】アミュレットのスタック。持たなければ null */
  sigils: number | null;
  actedThisTurn: boolean;
}

export type OnBoard = FollowerOnBoard | AmuletOnBoard;

/** リーダーが持つクレスト */
export interface CrestInstance {
  iid: number;
  crestId: string;
  countdown: number | null;
  order: number;
  usedOncePerTurn: Record<string, number>;
}

/** このターン中に破壊された自分のフォロワーの記録（式神・貴人） */
export interface DestroyedRecord {
  cardId: string;
  attack: number;
  defense: number;
}

export interface PlayerState {
  leaderHp: number;
  leaderMaxHp: number;
  maxPp: number;
  pp: number;
  ep: number;
  sep: number;
  /** エクストラPPを使えるか（後攻のみ） */
  extraPpAvailable: boolean;
  /** 自分のターンが何回目か（未開始は0） */
  turnCount: number;
  deck: CardRef[];
  hand: HandCard[];
  board: OnBoard[];
  crests: CrestInstance[];
  /** 墓場のカウント */
  graveyard: number;
  /** リアニメイトの対象になるフォロワーのカードID（墓場に行った順） */
  graveyardFollowers: string[];
  /** このバトル中に破壊された自分のアミュレットのカードID */
  destroyedAmulets: string[];
  /** このターン中に破壊された自分のフォロワー */
  destroyedThisTurn: DestroyedRecord[];
  /** コンボ（このターンにプレイしたカードの枚数と、効果による加算） */
  combo: number;
  /** このターンに進化または超進化したか */
  evolvedThisTurn: boolean;
  /** 「自分のリーダーが回復したとき」等、リーダーのターンごとに1回の能力の使用記録 */
  leaderOncePerTurn: Record<string, number>;
  mulliganDone: boolean;
}

export type Phase = "mulligan" | "main" | "ended";

/** 能力の解決中の文脈 */
export interface EffectContext {
  /** 能力の持ち主 */
  controller: PlayerIndex;
  /** 能力の持ち主のカード（場・手札・クレスト）。スペルは使用したカード */
  source: number;
  sourceCardId: string;
  /** 能力を誘発させたカード（場に出たフォロワー、交戦相手など） */
  event: number | null;
  /** 選択・乱数の結果 */
  slots: Record<string, number[]>;
  vars: Record<string, number>;
  /** エンハンスでプレイしたか */
  enhanced: boolean;
  /** 能力の持ち主が場・手札から離れた後でも参照できる値 */
  sourceX: number | null;
  sourceAttack: number;
}

/** エンジン内部の処理（能力の DSL の外） */
export type InternalEffect =
  | { op: "_combat"; attacker: number; target: number | "leader" }
  /** 戦闘の後処理（ぶっとばし） */
  | { op: "_combatEnd" }
  | { op: "_endTurn" }
  | { op: "_cleanup" }
  | { op: "_startTurn" }
  | { op: "_startTurnDraw" }
  | { op: "_finishMulligan" };

export interface Frame {
  effects: (Effect | InternalEffect)[];
  pc: number;
  ctx: EffectContext;
}

/** プレイヤーの選択待ち */
export type PendingChoice =
  | { kind: "choose"; player: PlayerIndex; slot: string; candidates: number[]; count: number }
  | { kind: "mode"; player: PlayerIndex; options: number };

/** 誘発して解決を待っている能力 */
export interface QueuedAbility {
  ability: Ability;
  ctx: EffectContext;
}

export interface GameState {
  phase: Phase;
  players: [PlayerState, PlayerState];
  /** 先攻のプレイヤー */
  first: PlayerIndex;
  /** 手番のプレイヤー（マリガン中は先攻） */
  active: PlayerIndex;
  /** 全体のターン番号（先攻1ターン目が1） */
  turn: number;
  winner: PlayerIndex | null;
  /** 乱数の状態 */
  rng: number;
  nextIid: number;
  /** 場に出た順の通し番号の次の値 */
  nextOrder: number;
  /** 解決中の処理（末尾が実行中） */
  stack: Frame[];
  /** 誘発して解決を待っている能力（先頭から解決） */
  queue: QueuedAbility[];
  pending: PendingChoice | null;
  /** 進行中のフォロワーへの攻撃（ぶっとばしの判定に使う） */
  attack: AttackInProgress | null;
}

export interface AttackInProgress {
  attacker: number;
  defender: number;
  /** 攻撃したフォロワーが超進化していたか */
  superEvolved: boolean;
  /** 攻撃中に攻撃先が破壊されたか */
  defenderDestroyed: boolean;
}

export type AttackTarget = number | "leader";

export type Action =
  | { type: "mulligan"; player: PlayerIndex; swap: number[] }
  | { type: "play"; iid: number }
  | { type: "attack"; attacker: number; target: AttackTarget }
  | { type: "evolve"; iid: number }
  | { type: "superEvolve"; iid: number }
  | { type: "act"; iid: number }
  | { type: "fuse"; host: number; materials: number[] }
  /** エクストラPP（後攻のみ） */
  | { type: "extraPp" }
  | { type: "choose"; targets: number[] }
  | { type: "mode"; index: number }
  | { type: "endTurn" };
