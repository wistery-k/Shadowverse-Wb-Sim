// ゲーム状態とアクションの型。状態は JSON シリアライズ可能に保つ（クラス・関数・Map を入れない）。

export type PlayerIndex = 0 | 1;

/** 常在型のキーワード（能力テキストに単独行で書かれるもの） */
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

/** 手札・山札のカード */
export interface CardRef {
  /** ゲーム内で一意なインスタンスID */
  iid: number;
  cardId: string;
}

/** 場のフォロワー */
export interface FollowerOnBoard extends CardRef {
  kind: "follower";
  attack: number;
  defense: number;
  maxDefense: number;
  keywords: StaticKeyword[];
  /** 1ターンに攻撃できる回数 */
  maxAttacks: number;
  attacksThisTurn: number;
  /** 場に出た時点の、場に出したプレイヤーのターン番号（全体のターン番号） */
  enteredTurn: number;
  evolve: EvolveState;
}

/** 場のアミュレット */
export interface AmuletOnBoard extends CardRef {
  kind: "amulet";
  /** カウントダウンを持たなければ null */
  countdown: number | null;
  keywords: StaticKeyword[];
}

export type OnBoard = FollowerOnBoard | AmuletOnBoard;

export interface PlayerState {
  leaderHp: number;
  leaderMaxHp: number;
  maxPp: number;
  pp: number;
  ep: number;
  sep: number;
  /** 自分のターンが何回目か（未開始は0） */
  turnCount: number;
  deck: CardRef[];
  hand: CardRef[];
  board: OnBoard[];
  /** 墓場のカウント */
  graveyard: number;
  /** リアニメイトの対象になるフォロワーのカードID（墓場に行った順） */
  graveyardFollowers: string[];
  /** このターンにプレイしたカードの枚数（コンボ） */
  playedThisTurn: number;
  /** このターンに進化または超進化したか */
  evolvedThisTurn: boolean;
  mulliganDone: boolean;
}

export type Phase = "mulligan" | "main" | "ended";

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
}

export type AttackTarget = number | "leader";

export type Action =
  | { type: "mulligan"; player: PlayerIndex; swap: number[] }
  | { type: "play"; iid: number }
  | { type: "attack"; attacker: number; target: AttackTarget }
  | { type: "evolve"; iid: number }
  | { type: "superEvolve"; iid: number }
  | { type: "endTurn" };
