// カード能力を宣言的に記述するためのデータ型。
// 能力はすべて JSON シリアライズ可能なデータで、エンジン（rust/engine/src/effects.rs）が解釈する。
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
  /** 「それ以外」: 能力を誘発させたカード（プレイしたカード等）を除く */
  excludeEvent?: boolean;
  /** 「選んでいない」: スロットのカードを除く */
  excludeSlot?: string;
  /** スロットのカードだけ（「〜を選んだなら」の確かめに使う） */
  inSlot?: string;
  costMin?: number;
  /** このタイプでない（「アサイラントでない」） */
  notTribe?: string;
  /** 進化後（超進化後を含む） */
  evolved?: boolean;
  /** 超進化後 */
  superEvolved?: boolean;
  /** 【ラストワード】を持つ（場のカードは今持つ能力、ほかはカードの元の能力で見る） */
  lastWords?: boolean;
  /** コストがこのどれか（手札のカードは手札のコスト） */
  costIn?: number[];
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
  | { kind: "maxAttack"; of: Target }
  /** 体力が最小のリーダー（同じならどちらも） */
  | { kind: "lowestHpLeaders" };

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
  | { kind: "destroyedThisTurn"; stat: "attack" | "defense"; filter?: CardFilter }
  /** 【自分がカードをプレイしたとき】で、プレイしたカードの元のコスト */
  | { kind: "playedCost" }
  /** -value */
  | { kind: "neg"; of: Value }
  /** この信仰に「自分の信仰は「…」を持つ」で付いた能力の数（信仰の能力の中で使う） */
  | { kind: "faithStacks" }
  /** これをプレイしたときに払ったコスト（「これのコストがNなら」） */
  | { kind: "paidCost" }
  /** このバトル中に場に出た自分の ids のカードの枚数（場に出たこれ自身も数える） */
  | { kind: "enteredCount"; ids: string[] };

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
  /** 対象が 1 つ以上ある */
  | { kind: "exists"; of: Target }
  /** 自分のリーダーの体力が value 以下 */
  | { kind: "leaderHpAtMost"; value: number }
  /** 自分のリーダーの体力が相手のリーダーの体力より大きい */
  | { kind: "leaderHpAboveOpponent" }
  /** これ（場のフォロワー）が進化後（超進化後を含む） */
  | { kind: "thisEvolved" }
  /** 対象が value 個以上ある */
  | { kind: "countAtLeast"; of: Target; value: number }
  /** 【奥義】（level 10）・【解放奥義】（level 15）: これをプレイしたときの奥義ゲージが level 以上 */
  | { kind: "ougi"; level: number }
  /** 【連携_N】: このバトル中に場に出た自分のフォロワーの枚数が atLeast 以上 */
  | { kind: "link"; atLeast: number }
  /** value が eq と等しい */
  | { kind: "valueEq"; value: Value; eq: number }
  /** value が atLeast 以上 */
  | { kind: "valueAtLeast"; value: Value; atLeast: number }
  /** 自分のターン（「自分のターンなら」） */
  | { kind: "ownTurn" }
  /** これ（場のフォロワー）に手札で【融合】していた（「これに【融合】していたなら」） */
  | { kind: "thisFused" }
  | { kind: "not"; cond: Condition };

export type Duration = "permanent" | "endOfTurn";

export type Effect =
  // 選択・乱数
  | { op: "choose"; slot: string; from: Target; count: number }
  | { op: "random"; slot: string; from: Target; count: number }
  /** allIf の条件を満たすなら、1 つを選ぶのではなくすべて（上から順に） */
  | { op: "mode"; options: Effect[][]; allIf?: Condition }
  /** 働くたびに options の 1 つ目から順に 1 つ（最後の次は 1 つ目に戻る）。何回働いたかは、これ（場のフォロワー）の X で数える */
  | { op: "inOrder"; options: Effect[][] }
  // ダメージ・破壊・移動
  | { op: "damage"; target: Target; amount: Value }
  | { op: "distribute"; target: Target; amount: Value }
  | { op: "destroy"; target: Target; countVar?: string }
  | { op: "banish"; target: Target }
  | { op: "bounce"; target: Target }
  | { op: "heal"; target: Target; amount: Value }
  | { op: "setDefense"; target: Target; value: number }
  // カードの生成・移動
  /** side が "opponent" なら相手が自身のデッキから引く */
  | { op: "draw"; count: Value; filter?: CardFilter; side?: "opponent" }
  | { op: "drawAll"; filter: CardFilter; slot?: string }
  /** slot に加えたカードを入れる（「それは…」） */
  | { op: "addToHand"; cardId: string; count: Value; slot?: string }
  /** side が "opponent" なら相手の場に出す */
  | { op: "summon"; cardId: string; count: Value; slot?: string; side?: "opponent" }
  /** スロットのカードと同名のカードを場に出す（コピー） */
  | { op: "summonCopy"; from: string; slot?: string }
  | { op: "reanimate"; cost: number }
  /** デッキの条件に合うカードからランダムに N 種類を場に出す */
  | { op: "summonFromDeck"; filter: CardFilter; kinds: number }
  /** このバトル中に破壊された自分の元のコスト最大のアミュレットからランダム1枚と同名のカードを場に出す */
  | { op: "summonDestroyedAmulet" }
  /**
   * このバトル中に破壊された自分のアミュレット（filter に合うもの。コストは元のコスト）から、ランダム count 枚と同名のカードを 1 枚ずつ場に出す。
   * 1 枚ずつ、破壊された回数に比例した確率で選ぶ。distinct なら count 種類（選んだものと同じカードを除いてから次を選ぶ）
   */
  | { op: "summonDestroyedAmulets"; filter: CardFilter; count: number; distinct: boolean }
  | { op: "returnToDeck"; target: Target }
  /** カードを生成して自分のデッキのランダムな位置に加える */
  | { op: "addToDeck"; cardId: string; count: Value }
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
  /** 手札のカードのコストを cost にする */
  | { op: "setCost"; target: Target; cost: number }
  | { op: "addX"; target: Target; amount: number }
  | { op: "countdown"; target: Target; amount: number }
  // リソース
  | { op: "gainPp"; amount: Value | "max" }
  | { op: "addMaxPp"; amount: number }
  /** 自分のEPを amount 回復（上限は試合の始めの EP） */
  | { op: "gainEp"; amount: number }
  | { op: "addCombo"; amount: number }
  | { op: "addGraveyard"; amount: number }
  | { op: "addSigils"; amount: Value }
  | { op: "earthRite"; amount: number; then: Effect[] }
  | { op: "necromancy"; amount: number; then: Effect[] }
  | { op: "crest"; crestId: string; side: "self" | "opponent" }
  /** クレストすべてを消滅（信仰は消えない） */
  | { op: "banishCrests"; side: Side }
  /** 自分の信仰 crestId の信仰値を amount 増やす（その信仰が無ければ何もしない） */
  | { op: "addFaith"; crestId: string; amount: number }
  /** 自分の信仰 crestId の信仰値が amount 以上なら、amount 減らして then を行う */
  | { op: "spendFaith"; crestId: string; amount: number; then: Effect[] }
  /** 自分の信仰 crestId は「…」を持つ（信仰ごとに決まった能力。何回付いたかを数え、能力は faithStacks 回働く） */
  | { op: "grantFaith"; crestId: string }
  /** 自分のデッキの filter に合うカードすべては +attack/+defense する */
  | { op: "buffDeck"; filter: CardFilter; attack: number; defense: number }
  /** options からランダムに 1 つ（「『A』『B』からランダム1枚」） */
  | { op: "randomOption"; options: Effect[][] }
  /** 【ラストワード】を失う */
  | { op: "loseLastWords"; target: Target }
  /** 場のカードを消滅して、そのコピー（受けたダメージ・かかっている効果を引き継ぐ）を自分の場に出す */
  | { op: "banishCopy"; target: Target }
  /** 自分の PP が amount 以上なら、amount 消費して then を行う（足りなければ消費せず、働かない） */
  | { op: "spendPp"; amount: number; then: Effect[] }
  /** 相手のターン終了まで、自分のリーダーは「受ける1以上のダメージを0にする。」を持つ */
  | { op: "leaderDamageZero"; until: "opponentTurnEnd" }
  | { op: "apocalypseDeck" }
  | { op: "setLeaderMaxHp"; side: "self" | "opponent"; value: number }
  /** リーダーの体力の最大値を増減する（体力は最大値まで下がる） */
  | { op: "addLeaderMaxHp"; side: "self" | "opponent"; amount: number }
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
  /** 自分のアミュレットが破壊されたとき */
  | { on: "allyAmuletDestroyed" }
  | { on: "leaderHealed" }
  /** 自分が他のカードをプレイしたとき（filter はプレイしたカードの条件。コストは元のコスト。enhanced なら【エンハンス】でプレイしたときだけ） */
  | { on: "allyPlay"; filter?: CardFilter; enhanced?: boolean }
  /** 自分のフォロワーが進化したとき（超進化・効果による進化を含む。docs/rules.md 12章の 15） */
  | { on: "allyEvolved" }
  /** 手札にある間、自分のターン終了時（「手札で働く。自分のターン終了時」） */
  | { on: "turnEndInHand" }
  /** 自分がカードを引いたとき（filter は引いたカードの条件。手札に入ったカード 1 枚ごと） */
  | { on: "allyDraw"; filter?: CardFilter }
  /** 自分のフォロワーが攻撃するとき（filter は攻撃するフォロワーの条件） */
  | { on: "allyAttack"; filter?: CardFilter };

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
  /** 【守護】を無視して攻撃できる */
  ignoreWard?: boolean;
  /** テキスト上の能力のうち未実装のもの（説明） */
  unimplemented?: string;
}
