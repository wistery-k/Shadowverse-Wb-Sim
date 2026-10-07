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
  /** 公式のカードID（文字列） */
  id: string;
  name: string;
  class: ClassId;
  set: CardSet;
  rarity: Rarity;
  cost: number;
  /** タイプ（例: 兵士、マナリア）。無ければ空配列。元データに情報が無く不明な場合は null。 */
  tribes: string[] | null;
  /**
   * 能力テキスト。公式表記から装飾タグを除いたもの。進化時・超進化時の能力も含む。
   * 区切り線は改行。キーワードの数値は公式表記どおり「【コンボ_3】」の形。無ければ空文字列。
   */
  text: string;
  /** 効果で生成・参照するカードのID（公式データの related_card_ids） */
  related: string[];
  /**
   * スターター用に当時の能力へ差し替えたカード
   * （公式データの is_starter_ability_changed、または data/starter-overrides.json で上書き）
   */
  starterAbilityChanged?: true;
}

export interface FollowerCard extends CardBase {
  type: "follower";
  attack: number;
  defense: number;
}

export interface SpellCard extends CardBase {
  type: "spell";
}

export interface AmuletCard extends CardBase {
  type: "amulet";
  /** カウントダウンの初期値。カウントダウンを持たないアミュレットには無い。 */
  countdown?: number;
}

export type Card = FollowerCard | SpellCard | AmuletCard;
