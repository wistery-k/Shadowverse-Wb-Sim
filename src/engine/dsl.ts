// カード能力を宣言的に記述するためのデータ型。
// 能力はすべて JSON シリアライズ可能なデータで、エンジン（effects.ts）が解釈する。
// 能力の定義は src/cards/abilities/ にカードIDごとに置く。

import type { CardType, ClassId } from "../cards/types";
import type { StaticKeyword } from "./types";

/** 能力の持ち主から見た陣営 */
export type Side = "self" | "opponent" | "both";

/** カードの条件。省略した項目は問わない。 */
export interface CardFilter {
  type?: CardType;
  tribe?: string;
  class?: ClassId;
  /** カードID（いずれか） */
  ids?: string[];
  costMax?: number;
  /** コストが Value と等しい */
  costEq?: Value;
  defenseMax?: number;
  keyword?: StaticKeyword;
  /** 進化前（進化も超進化もしていない） */
  notEvolved?: boolean;
  /** 「他の」: 能力の持ち主自身を除く */
  excludeSelf?: boolean;
  /** 【スペルブースト時】を持つ */
  spellboost?: boolean;
  /** 【土の印】アミュレット */
  earthSigil?: boolean;
}

/** 対象の集合。解決すると実体ID（iid、リーダーは負の値）の配列になる。 */
export type Target =
  | { kind: "this" }
  | { kind: "leader"; side: Side }
  | { kind: "board"; side: Side; filter?: CardFilter }
  | { kind: "hand"; filter?: CardFilter }
  | { kind: "slot"; slot: string }
  /** 能力を誘発させたカード（場に出たフォロワー、交戦相手など） */
  | { kind: "event" }
  | { kind: "union"; of: Target[] }
  /** 攻撃力が最大のものに絞る */
  | { kind: "maxAttack"; of: Target };

/** 数値 */
export type Value =
  | number
  | { kind: "var"; name: string }
  | { kind: "count"; of: Target }
  | { kind: "combo" }
  | { kind: "sigils" }
  | { kind: "thisAttack" }
  /** スロットのカードのコストの合計 */
  | { kind: "costOf"; slot: string }
  /** これの X（ストームブラスト等） */
  | { kind: "thisX" }
  /** このターン中に破壊された自分のフォロワー（条件付き）の元の攻撃力/体力の合計 */
  | { kind: "destroyedThisTurn"; stat: "attack" | "defense"; filter?: CardFilter };

export type Condition =
  | { kind: "awakened" }
  | { kind: "combo"; atLeast: number }
  | { kind: "enhanced" }
  | { kind: "superEvolveTurn" }
  | { kind: "thisSuperEvolved" }
  | { kind: "handCount"; atMost: number }
  | { kind: "attackingFollower" }
  | { kind: "varAtLeast"; name: string; value: number }
  | { kind: "thisXAtLeast"; value: number }
  | { kind: "maxPp"; atLeast: number }
  | { kind: "not"; cond: Condition };

export type Duration = "permanent" | "endOfTurn";

export type Effect =
  // 選択・乱数
  | { op: "choose"; slot: string; from: Target; count: number }
  | { op: "random"; slot: string; from: Target; count: number }
  | { op: "mode"; options: Effect[][] }
  // ダメージ・破壊・移動
  | { op: "damage"; target: Target; amount: Value }
  | { op: "distribute"; target: Target; amount: Value }
  | { op: "destroy"; target: Target; countVar?: string }
  | { op: "banish"; target: Target }
  | { op: "bounce"; target: Target }
  | { op: "heal"; target: Target; amount: Value }
  | { op: "setDefense"; target: Target; value: number }
  // カードの生成・移動
  | { op: "draw"; count: Value; filter?: CardFilter }
  | { op: "drawAll"; filter: CardFilter; slot?: string }
  | { op: "addToHand"; cardId: string; count: Value }
  | { op: "summon"; cardId: string; count: Value; slot?: string }
  /** スロットのカードと同名のカードを場に出す（コピー） */
  | { op: "summonCopy"; from: string; slot?: string }
  | { op: "reanimate"; cost: number }
  /** デッキの条件に合うカードからランダムに N 種類を場に出す */
  | { op: "summonFromDeck"; filter: CardFilter; kinds: number }
  /** このバトル中に破壊された自分の元のコスト最大のアミュレットからランダム1枚と同名のカードを場に出す */
  | { op: "summonDestroyedAmulet" }
  | { op: "returnToDeck"; target: Target }
  | { op: "discard"; target: Target }
  | { op: "transform"; target: Target; cardId: string }
  // 能力値・能力の付与
  | { op: "buff"; target: Target; attack: Value; defense: Value; duration?: Duration }
  | { op: "grant"; target: Target; keywords?: StaticKeyword[]; maxAttacks?: number; abilities?: Ability[]; duration?: Duration }
  | { op: "loseKeyword"; target: Target; keyword: StaticKeyword }
  | { op: "cannotAttack"; target: Target; until: "opponentTurnEnd" }
  | { op: "evolve"; target: Target; kind: "evolve" | "superEvolve" }
  // 手札
  | { op: "spellboost"; target: Target; times: number }
  | { op: "costChange"; target: Target; amount: number }
  | { op: "addX"; target: Target; amount: number }
  | { op: "countdown"; target: Target; amount: number }
  // リソース
  | { op: "gainPp"; amount: Value | "max" }
  | { op: "addMaxPp"; amount: number }
  | { op: "addCombo"; amount: number }
  | { op: "addGraveyard"; amount: number }
  | { op: "addSigils"; amount: Value }
  | { op: "earthRite"; amount: number; then: Effect[] }
  | { op: "necromancy"; amount: number; then: Effect[] }
  | { op: "crest"; crestId: string; side: "self" | "opponent" }
  | { op: "apocalypseDeck" }
  | { op: "setLeaderMaxHp"; side: "self" | "opponent"; value: number }
  // 制御
  | { op: "if"; cond: Condition; then: Effect[]; else?: Effect[] }
  | { op: "repeat"; times: Value; effects: Effect[] }
  | { op: "setVar"; name: string; value: Value };

export type Trigger =
  | { on: "fanfare" }
  /** スペルを使ったとき */
  | { on: "spell" }
  | { on: "lastWords" }
  /** EP を使って進化させたとき */
  | { on: "evolve" }
  /** SEP を使って超進化させたとき */
  | { on: "superEvolve" }
  /** 効果を含め、これが進化したとき */
  | { on: "evolved" }
  | { on: "attack" }
  | { on: "clash" }
  | { on: "turnStart" }
  | { on: "turnEnd"; whose: "self" | "opponent" }
  /** 自分のカードが場に出たとき（これ自身は含まない） */
  | { on: "allyEnter"; filter?: CardFilter }
  /** これが場に出たとき */
  | { on: "enter" }
  /** アクト（プレイヤーが起動する） */
  | { on: "act"; cost: number }
  /** 自分がアミュレットをアクトしたとき */
  | { on: "allyAct" }
  /** これに融合したとき */
  | { on: "fused" }
  /** 自分が融合したとき */
  | { on: "allyFuse" }
  /** 手札にある間、スペルブーストされたとき */
  | { on: "spellboost" }
  /** 手札にある間、自分のフォロワーが場を離れたとき */
  | { on: "allyLeaveInHand" }
  | { on: "discarded" }
  /** 自分のフォロワーが破壊されたとき */
  | { on: "allyDestroyed"; filter?: CardFilter }
  | { on: "leaderHealed" };

export interface Ability {
  trigger: Trigger;
  effects: Effect[];
  /** 自分のターンごとに1回 */
  oncePerOwnTurn?: boolean;
  /** 【超進化時】で【進化時】を置き換える（「〜ではなく」） */
  replacesEvolve?: boolean;
}

/** カードごとの能力定義 */
export interface CardAbilities {
  abilities: Ability[];
  /** 場を離れる場合、消滅する */
  banishOnLeave?: boolean;
  /** プレイできない */
  unplayable?: boolean;
  /** 相手は能力でこれしか選べない */
  onlySelectable?: boolean;
  /** X の初期値（手札にある間に変化する） */
  initialX?: number;
  /** 【融合】できる素材の条件 */
  fusion?: CardFilter;
  /** テキスト上の能力のうち未実装のもの（説明） */
  unimplemented?: string;
}
