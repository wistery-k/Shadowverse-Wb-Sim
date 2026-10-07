// カードデータの型定義。data/cards.json はこの形に従う。
// ゲーム用語との対応は docs/rules.md を参照。

export const CLASS_IDS = [
  "neutral",
  "elf",
  "royal",
  "witch",
  "dragon",
  "nightmare",
  "bishop",
  "nemesis",
] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const CLASS_NAMES: Record<ClassId, string> = {
  neutral: "ニュートラル",
  elf: "エルフ",
  royal: "ロイヤル",
  witch: "ウィッチ",
  dragon: "ドラゴン",
  nightmare: "ナイトメア",
  bishop: "ビショップ",
  nemesis: "ネメシス",
};

export const CARD_TYPES = ["follower", "spell", "amulet"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const RARITIES = ["bronze", "silver", "gold", "legend"] as const;
export type Rarity = (typeof RARITIES)[number];

/** 収録セット。token はデッキに入れられない生成専用カード。 */
export const CARD_SETS = ["basic", "legend_dawn", "token"] as const;
export type CardSet = (typeof CARD_SETS)[number];

export const SET_NAMES: Record<CardSet, string> = {
  basic: "ベーシック",
  legend_dawn: "伝説の幕開け",
  token: "トークン",
};

interface CardBase {
  /** 一意なID。公式のカードIDがあればそれを文字列で使う。 */
  id: string;
  name: string;
  class: ClassId;
  set: CardSet;
  /** トークンには無い場合がある */
  rarity?: Rarity;
  cost: number;
  /** タイプ（例: 兵士、マナリア）。無ければ空配列。 */
  tribes: string[];
  /** 能力テキスト（公式表記のまま）。無ければ空文字列。 */
  text: string;
  /** 取得元URLまたは出典の説明 */
  source: string;
  /** 人間がテキストと数値をレビュー済みか */
  verified: boolean;
  /** 後に能力調整された疑いがあり、スターター用の当時の能力への修正が必要 */
  needsOriginalText?: boolean;
}

export interface FollowerCard extends CardBase {
  type: "follower";
  attack: number;
  defense: number;
  evolvedAttack: number;
  evolvedDefense: number;
  /** 進化後の能力テキスト。無ければ空文字列。 */
  evolvedText: string;
}

export interface SpellCard extends CardBase {
  type: "spell";
}

export interface AmuletCard extends CardBase {
  type: "amulet";
}

export type Card = FollowerCard | SpellCard | AmuletCard;
