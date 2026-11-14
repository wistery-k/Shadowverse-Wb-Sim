// 前期のローテーションの能力定義のための補助関数。
// スターターの ../helpers.ts のうち、カード名・クレスト名から ID を引くものを、前期のローテーションのカードから引くものに置き換える
// （同じ名前のストームブラストが、スターターは 10131320、前期のローテーションは 10831310）。ほかはそのまま使う。

import rawRotCards from "../../../../data/pools/azvaldt/cards.json";
import rawRotCrests from "../../../../data/pools/azvaldt/crests.json";
import rawRotSpecials from "../../../../data/pools/azvaldt/specials.json";
import type { Ability, CardFilter, Condition, Effect, Target, Value } from "../../../engine/dsl";

export {
  AWAKENED,
  BOTH_LEADERS,
  COMBO,
  ENHANCED,
  EVENT,
  OPP_LEADER,
  SELF_LEADER,
  THIS,
  THIS_ATTACK,
  THIS_X,
  act,
  addSigils,
  allFollowers,
  allyAmulets,
  allyCards,
  allyFollowers,
  banish,
  bounce,
  buff,
  choose,
  combo,
  costChange,
  count,
  damage,
  destroy,
  discard,
  distribute,
  draw,
  evolveIt,
  fanfare,
  gainPp,
  grant,
  grantAttacks,
  handCards,
  heal,
  lastWords,
  mode,
  necromancy,
  onAllyAct,
  onAllyEnter,
  onAttack,
  onClash,
  onDiscarded,
  onEnter,
  onEvolve,
  onEvolved,
  onFused,
  onLeaderHealed,
  onSpellboost,
  onSuperEvolve,
  onSuperEvolveInstead,
  onTurnEnd,
  onTurnStart,
  oncePerOwnTurn,
  oppFollowers,
  otherAllyFollowers,
  random,
  repeat,
  returnToDeck,
  slot,
  spell,
  spellboost,
  superEvolveIt,
  union,
  v,
  when,
} from "../helpers";

const ID_BY_NAME = new Map((rawRotCards as { id: string; name: string }[]).map((c) => [c.name, c.id]));
const CREST_ID_BY_NAME = new Map((rawRotCrests as { id: string; name: string }[]).map((c) => [c.name, c.id]));
const SPECIALS = rawRotSpecials as { id: string; kind: string; sources: string[] }[];

/** カード名から前期のローテーションのカードIDを引く */
export function id(name: string): string {
  const v = ID_BY_NAME.get(name);
  if (!v) throw new Error(`前期のローテーションにカードがありません: ${name}`);
  return v;
}

/** 『クレスト：<name>』の ID を前期のローテーションのクレストから引く */
export function crestIdOf(name: string): string {
  const v = CREST_ID_BY_NAME.get(`クレスト：${name}`);
  if (!v) throw new Error(`前期のローテーションにクレストがありません: ${name}`);
  return v;
}

/** カード名の、アクセラレート・結晶・信仰の ID（能力はこの ID に書く。docs/rules.md「12」） */
export function specialId(name: string, kind: "accelerate" | "crystallize" | "faith"): string {
  const src = id(name);
  const sp = SPECIALS.find((x) => x.kind === kind && x.sources.includes(src));
  if (!sp) throw new Error(`${name} に ${kind} がありません`);
  return sp.id;
}

// ---- 名前で書く効果（前期のローテーションのカードから引く） ----

/** 『name』count 枚を自分の手札に加える（slot を渡すと、加えたカードを「それ」として後の効果で使える） */
export const addToHand = (name: string, count: Value = 1, slot?: string): Effect =>
  slot ? { op: "addToHand", cardId: id(name), count, slot } : { op: "addToHand", cardId: id(name), count };
/** 『name』count 枚を自分の場に出す（slot を渡すと、出したカードを「それ」として後の効果で使える） */
export const summon = (name: string, count: Value = 1, slot?: string): Effect =>
  slot ? { op: "summon", cardId: id(name), count, slot } : { op: "summon", cardId: id(name), count };
export const transform = (target: Target, name: string): Effect => ({ op: "transform", target, cardId: id(name) });
export const crest = (name: string, side: "self" | "opponent" = "self"): Effect => ({ op: "crest", crestId: crestIdOf(name), side });
/** 『name』count 枚を自分のデッキ（のランダムな位置）に加える */
export const addToDeck = (name: string, count: Value = 1): Effect => ({ op: "addToDeck", cardId: id(name), count });

// ---- 前期のローテーションで足した仕組み ----

/** 相手は自身のデッキから count 枚を引く */
export const opponentDraws = (count: Value): Effect => ({ op: "draw", count, side: "opponent" });
/** リーダーの体力の最大値を amount だけ増減する */
export const addLeaderMaxHp = (side: "self" | "opponent", amount: number): Effect => ({ op: "addLeaderMaxHp", side, amount });
/** これのカウントを amount だけ増減する */
export const countdown = (amount: number): Effect => ({ op: "countdown", target: { kind: "this" }, amount });

/** 体力最小のリーダーすべて */
export const LOWEST_HP_LEADERS: Target = { kind: "lowestHpLeaders" };
/** 場のカード（両方の場） */
export const boardCards = (filter?: CardFilter): Target => ({
  kind: "board",
  side: "both",
  ...(filter ? { filter } : {}),
});

/** 【自分がカードをプレイしたとき】のプレイしたカードの元のコスト */
export const PLAYED_COST: Value = { kind: "playedCost" };

/** 自分が他のカードをプレイしたとき（filter はプレイしたカードの条件） */
export const onAllyPlay = (filter: CardFilter, ...effects: Effect[]): Ability => ({
  trigger: Object.keys(filter).length > 0 ? { on: "allyPlay", filter } : { on: "allyPlay" },
  effects,
});
/** 手札で働く。自分のターン終了時 */
export const onTurnEndInHand = (...effects: Effect[]): Ability => ({ trigger: { on: "turnEndInHand" }, effects });

export const exists = (of: Target): Condition => ({ kind: "exists", of });
export const leaderHpAtMost = (value: number): Condition => ({ kind: "leaderHpAtMost", value });
export const LEADER_HP_ABOVE_OPPONENT: Condition = { kind: "leaderHpAboveOpponent" };

// ---- ランプD・アミュレットB で足した仕組み ----

/** 自分のPP最大値を amount 増やす */
export const addMaxPp = (amount: number): Effect => ({ op: "addMaxPp", amount });
/** 自分のリーダーの体力の最大値を value にする */
export const setLeaderMaxHp = (value: number): Effect => ({ op: "setLeaderMaxHp", side: "self", value });
/** 相手のターン終了まで、自分のリーダーは「受ける1以上のダメージを0にする。」を持つ */
export const LEADER_DAMAGE_ZERO: Effect = { op: "leaderDamageZero", until: "opponentTurnEnd" };
/** 【モード】。cond を満たすなら、1 つを選ぶのではなくすべて */
export const modeAllIf = (cond: Condition, ...options: Effect[][]): Effect => ({ op: "mode", options, allIf: cond });
/** 「下記の能力から順に1つの能力が働く」（最後の次は最初） */
export const inOrder = (...options: Effect[][]): Effect => ({ op: "inOrder", options });
/** このバトル中に破壊された自分のアミュレット（filter）からランダム count 枚（distinct なら count 種類）と同名のカードを場に出す */
export const summonDestroyedAmulets = (filter: CardFilter, count: number, distinct: boolean): Effect => ({
  op: "summonDestroyedAmulets",
  filter,
  count,
  distinct,
});
/** クレストすべてを消滅（信仰は消えない） */
export const banishCrests = (side: "self" | "opponent" | "both"): Effect => ({ op: "banishCrests", side });
/** カード name の信仰の信仰値を amount 増やす */
export const addFaith = (name: string, amount: number): Effect => ({ op: "addFaith", crestId: specialId(name, "faith"), amount });
/** カード name の信仰の信仰値を amount 減らして then を行う（足りなければ働かない） */
export const spendFaith = (name: string, amount: number, ...then: Effect[]): Effect => ({
  op: "spendFaith",
  crestId: specialId(name, "faith"),
  amount,
  then,
});
/** 自分のアミュレットが破壊されたとき */
export const onAllyAmuletDestroyed = (...effects: Effect[]): Ability => ({ trigger: { on: "allyAmuletDestroyed" }, effects });

export const THIS_EVOLVED: Condition = { kind: "thisEvolved" };
export const countAtLeast = (of: Target, value: number): Condition => ({ kind: "countAtLeast", of, value });
/** 場のカード（両方の場、能力の持ち主を除く） */
export const otherBoardCards = (filter?: CardFilter): Target => boardCards({ excludeSelf: true, ...filter });
/** 「自分のアミュレットを選んだなら」: スロット name に自分のアミュレットがあるか（破壊する前に見る） */
export const choseAllyAmulet = (name = "t"): Condition => ({
  kind: "exists",
  of: { kind: "board", side: "self", filter: { type: "amulet", inSlot: name } },
});

// ---- コンボE・海賊R で足した仕組み ----

/** -value */
export const neg = (of: Value): Value => ({ kind: "neg", of });
/** 【奥義】（奥義ゲージ 10 以上） */
export const OUGI: Condition = { kind: "ougi", level: 10 };
/** 【解放奥義】（奥義ゲージ 15 以上） */
export const RELEASED_OUGI: Condition = { kind: "ougi", level: 15 };
/** 【連携_N】 */
export const link = (atLeast: number): Condition => ({ kind: "link", atLeast });
/** value が eq と等しい */
export const valueEq = (value: Value, eq: number): Condition => ({ kind: "valueEq", value, eq });
/** これをプレイしたときに払ったコスト（「これのコストがNなら」） */
export const PAID_COST: Value = { kind: "paidCost" };
/** 自分のEPを amount 回復 */
export const gainEp = (amount: number): Effect => ({ op: "gainEp", amount });
/** 自分の【コンボ】を amount 増やす */
export const addCombo = (amount: number): Effect => ({ op: "addCombo", amount });
/** 手札のカードのコストを cost にする */
export const setCost = (target: Target, cost: number): Effect => ({ op: "setCost", target, cost });
/** 対象のアミュレットのカウントを amount だけ増減する */
export const countdownOf = (target: Target, amount: number): Effect => ({ op: "countdown", target, amount });
/** 自分のデッキの filter に合うカードすべては +attack/+defense する */
export const buffDeck = (filter: CardFilter, attack: number, defense: number): Effect => ({ op: "buffDeck", filter, attack, defense });
/** 「自分の信仰は「…」を持つ」（カード name の信仰。付く能力は信仰の定義に書く） */
export const grantFaith = (name: string): Effect => ({ op: "grantFaith", crestId: specialId(name, "faith") });
/** 信仰に「…」が付いた数（信仰の定義の中で使う） */
export const FAITH_STACKS: Value = { kind: "faithStacks" };
/** 自分のフォロワーが進化したとき（超進化・効果による進化を含む） */
export const onAllyEvolved = (...effects: Effect[]): Ability => ({ trigger: { on: "allyEvolved" }, effects });
/** 自分がカードを【エンハンス】でプレイしたとき */
export const onAllyPlayEnhanced = (...effects: Effect[]): Ability => ({ trigger: { on: "allyPlay", enhanced: true }, effects });

// ---- ミッドレンジNi・実験体W・クキシロB で足した仕組み ----

/** 『name』count 枚を相手の場に出す */
export const summonToOpponent = (name: string, count: Value = 1): Effect => ({ op: "summon", cardId: id(name), count, side: "opponent" });
/** 【リアニメイト_N】 */
export const reanimate = (cost: number): Effect => ({ op: "reanimate", cost });
/** 「自分のデッキのコスト…のフォロワーからランダム N 種類を自分の場に出す」 */
export const summonFromDeck = (filter: CardFilter, kinds: number): Effect => ({ op: "summonFromDeck", filter, kinds });
/** options からランダムに 1 つ（「『A』『B』からランダム1枚」） */
export const randomOption = (...options: Effect[][]): Effect => ({ op: "randomOption", options });
/** 【ラストワード】を失う */
export const loseLastWords = (target: Target): Effect => ({ op: "loseLastWords", target });
/** 「それを消滅して、コピー1枚を自分の場に出す」 */
export const banishCopy = (target: Target): Effect => ({ op: "banishCopy", target });
/** 自分の PP を amount 消費して then を行う（足りなければ消費せず、働かない） */
export const spendPp = (amount: number, ...then: Effect[]): Effect => ({ op: "spendPp", amount, then });
/** このバトル中に場に出た自分の『names』の枚数（場に出たこれ自身も数える） */
export const enteredCount = (...names: string[]): Value => ({ kind: "enteredCount", ids: names.map(id) });
/**
 * 「これが場に出たとき」の能力の中で、このバトル中に場に出た『name』（これ自身のカード）の枚数を、これが場に出た時点で数える。
 * 一緒に出たカードのうち、後から出たものは数えない（docs/rules.md 12章の 39）
 */
export const enteredCountAtEnter = (name: string): Value => ({ kind: "enteredCount", ids: [id(name)], atEnter: true });
export const valueAtLeast = (value: Value, atLeast: number): Condition => ({ kind: "valueAtLeast", value, atLeast });
/** 自分のターンなら */
export const OWN_TURN: Condition = { kind: "ownTurn" };
/** これに【融合】していたなら */
export const THIS_FUSED: Condition = { kind: "thisFused" };
/** 自分がカードを引いたとき（filter は引いたカードの条件） */
export const onAllyDraw = (filter: CardFilter, ...effects: Effect[]): Ability => ({
  trigger: Object.keys(filter).length > 0 ? { on: "allyDraw", filter } : { on: "allyDraw" },
  effects,
});
/** 自分のフォロワーが攻撃するとき（filter は攻撃するフォロワーの条件） */
export const onAllyAttack = (filter: CardFilter, ...effects: Effect[]): Ability => ({ trigger: { on: "allyAttack", filter }, effects });

// ---- ハイランダーNm で足した仕組み ----

/** アーティファクト・フォロワー */
export const ARTIFACT_FOLLOWER: CardFilter = { type: "follower", tribe: "アーティファクト" };
/** 自分のデッキに重複するカードがないなら（山札が 0 枚なら重複はない。docs/rules.md 12章の 22） */
export const DECK_UNIQUE: Condition = { kind: "deckUnique" };
/** 超進化可能ターンなら */
export const SUPER_EVOLVE_TURN: Condition = { kind: "superEvolveTurn" };
/** このバトル中に場に出た自分のカードのうち filter に合うものの種類 */
export const enteredKinds = (filter: CardFilter): Value => ({ kind: "enteredKinds", filter });
/** このバトル中に自分のフォロワーが進化した回数（超進化・効果での進化を含む） */
export const EVOLVED_COUNT: Value = { kind: "evolvedCount" };
/** 自分のデッキから filter に合うカード count 種類を引く */
export const drawKinds = (count: number, filter: CardFilter): Effect => ({ op: "draw", count, filter, distinct: true });
/** ターン終了まで、手札のカードのコストを amount だけ増減する */
export const costChangeUntilEnd = (target: Target, amount: number): Effect => ({ op: "costChange", target, amount, duration: "endOfTurn" });
/** 相手の手札のカード */
export const oppHandCards = (filter?: CardFilter): Target => ({ kind: "hand", side: "opponent", ...(filter ? { filter } : {}) });
/** このバトル中に破壊された自分のフォロワー（filter に合うもの）からランダム 1 枚と同名のカード 1 枚を非公開で手札に加える */
export const addDestroyedCopy = (filter?: CardFilter): Effect => (filter ? { op: "addDestroyedCopy", filter } : { op: "addDestroyedCopy" });
/** スロット from のカードと同名のカード 1 枚を非公開で手札に加える（slot に加えたカードを入れる） */
export const addCopyToHand = (from: string, slot?: string): Effect => (slot ? { op: "addCopyToHand", from, slot } : { op: "addCopyToHand", from });
/** 手札のカードを、side のデッキのランダム 1 枚のコピーに変身させる */
export const transformToDeckCopy = (target: Target, side: "self" | "opponent"): Effect => ({ op: "transformToDeckCopy", target, side });
/** 「下記の能力から働いていないランダム1つの能力が働く」 */
export const randomUnusedOption = (...options: Effect[][]): Effect => ({ op: "randomUnusedOption", options });
/** スロットのカードと同名のカードを場に出す（コピー） */
export const summonCopy = (from = "t"): Effect => ({ op: "summonCopy", from });
/** 相手のフォロワーが攻撃するとき（filter は攻撃するフォロワーの条件。leader ならリーダーを攻撃するときだけ） */
export const onEnemyAttack = (filter: CardFilter, leader: boolean, ...effects: Effect[]): Ability => ({
  trigger: { on: "enemyAttack", filter, ...(leader ? { leader } : {}) },
  effects,
});
/** これが【直接召喚】されたとき */
export const onDirectSummoned = (...effects: Effect[]): Ability => ({ trigger: { on: "directSummoned" }, effects });
