// 盤面の評価関数。重み（EvalWeights）はデータとして持ち、自己対戦で調整できるようにする（scripts/tune.ts）。

import { id } from "../cards/abilities/helpers";
import { CARDS_BY_ID } from "../cards";
import { MAX_PP, abilitiesOf, type FollowerOnBoard, type GameState, type OnBoard, type PlayerIndex } from "../engine";

export interface EvalWeights {
  /** 自分・相手のリーダー体力 1 点 */
  myHp: number;
  oppHp: number;
  /** フォロワー: 攻撃力・体力・1体あたりの基礎点・ターン終了までの攻撃力 */
  attack: number;
  defense: number;
  followerBase: number;
  tempAttack: number;
  /** キーワード能力の価値の倍率（守護1・必殺2 等の基準値にかける） */
  keywords: number;
  /** アミュレット1枚・土の印1つ */
  amulet: number;
  sigil: number;
  /**
   * 土の印を持つアミュレット（大地の魔片等）自体の価値（土の印の数は sigil で数える）。
   * 基準は amulet と同じ。土の印を増やすだけの手（理光の証明の（1）等）が、印の数とは別にアミュレット 1 枚分得をする
   */
  sigilAmulet: number;
  /** 相手の盤面の価値の倍率（自分の盤面に対して） */
  oppBoard: number;
  /** 手札 1 枚 */
  myHand: number;
  oppHand: number;
  /** 残っている EP / SEP / エクストラPP の使用権 */
  ep: number;
  sep: number;
  extraPp: number;
  /** 自分の PP 最大値を、毎ターンの自然な増加（ターン数、最大 10）より増やした分 1 あたり（竜の啓示等） */
  maxPp: number;
  /** クレスト 1 つ */
  crest: number;
  /** 墓場 1（10 まで） */
  graveyard: number;
  /** 相手リーダーの体力がこれ以下のとき、自分のフォロワーの攻撃力を追加で評価する */
  lethalRange: number;
  lethalAttack: number;
  /**
   * 手札にあるデストロイアーティファクト α・β・γ の種類 1 つあたり（同じ種類の 2 枚目以降は数えない）。
   * 3 種類そろうとイクシードアーティファクトΩを作れる。0 なら見ない
   */
  fusionSet: number;
  /**
   * 手札に五行の果て・クオンがあり、超進化を 1 回以上残しているときに足す点。
   * PP 10 でエンハンス 10 のクオンを出し、超進化で式神・貴人に疾走を付けてとどめにするために、
   * 超進化を 1 回分使わずに残す価値。0 なら見ない
   */
  kuonReserve: number;
  /**
   * 進化時能力（【進化時】・これが進化したとき）を持つフォロワーのために EP を残す価値。
   * 手札の進化時能力持ちを EP の数まで数え、このターンに EP で進化させたのが進化時能力持ちならさらに 1 枚分数えて、1 枚あたりこの点を足す。
   * 進化時能力持ちを出してそのターンに進化させても点は変わらず、進化時能力のないフォロワーを進化させたり、
   * 出して進化させずに場に残したりすると下がる。0 なら見ない
   */
  evoReserve: number;
  /**
   * カードごとの「手札に持っておく価値」（カードID → 点数）。切り札を温存させるために使う。
   * 手札1枚の価値（myHand）に加算する
   */
  hold: Readonly<Record<string, number>>;
}

/** 数値の重みの名前（hold を除く） */
export type NumericWeight = Exclude<keyof EvalWeights, "hold">;

/** 手で決めた基準の重み */
export const DEFAULT_WEIGHTS: EvalWeights = {
  myHp: 0.7,
  oppHp: 1.0,
  attack: 1,
  defense: 0.8,
  followerBase: 1,
  tempAttack: 0.3,
  keywords: 1,
  amulet: 1.5,
  sigil: 0.5,
  sigilAmulet: 1.5,
  oppBoard: 1.1,
  myHand: 0.6,
  oppHand: 0.3,
  ep: 1.5,
  sep: 2.5,
  extraPp: 1,
  maxPp: 0,
  crest: 1.5,
  graveyard: 0.05,
  lethalRange: 10,
  lethalAttack: 0.3,
  fusionSet: 0,
  kuonReserve: 0,
  evoReserve: 0,
  hold: {},
};

/**
 * 融合で作るカードの「手札に持っておく価値」。融合した素材の枚数 × 手札 1 枚の価値。
 * 手札を枚数だけで数えると、融合は手札が減る損に見え、AFネメシスがコアを手札に余らせたまま
 * デストロイアーティファクトを作らなかった（ロイヤル戦 7%。docs/ai-notes.md）。
 * Ω は α＋β＋γ の合計（8 枚分）。それより低いと、Ω を作ると評価が下がる
 */
const FUSION_HOLD: Readonly<Record<string, number>> = Object.fromEntries(
  (
    [
      ["アタックアーティファクト", 1],
      ["キャッスルアーティファクト", 1],
      ["デストロイアーティファクトα", 2],
      ["デストロイアーティファクトβ", 3],
      ["デストロイアーティファクトγ", 3],
      ["イクシードアーティファクトΩ", 8],
    ] as const
  ).map(([name, cards]) => [id(name), cards * DEFAULT_WEIGHTS.myHand]),
);

/** Ω の素材（fusionSet で種類を数える） */
const FUSION_SET: ReadonlySet<string> = new Set(["デストロイアーティファクトα", "デストロイアーティファクトβ", "デストロイアーティファクトγ"].map(id));

const KUON = id("五行の果て・クオン");

/** 進化時能力（EP で進化させたとき・これが進化したとき）を持つフォロワー（evoReserve で数える） */
export const EVOLVE_ABILITY: ReadonlySet<string> = new Set(
  [...CARDS_BY_ID.values()]
    .filter((c) => c.type === "follower" && abilitiesOf(c.id).abilities.some((a) => a.trigger.on === "evolve" || a.trigger.on === "evolved"))
    .map((c) => c.id),
);

/**
 * 探索 AI の既定の重み（基準の重み＋PP 最大値＋SEP＋融合で作るカードの価値）。
 * PP 最大値の重みが 0 だと、竜の啓示を打つ手は手札が 1 枚減るだけに見え、初手にあっても 95% の試合で打たなかった。
 * 重み 0/1/2/4/6/8/12/16 で比べて 8 が最も勝った（docs/ai-notes.md）。
 * SEP が 2.5 だと +3/+3（5.4）より安く、超進化しなくても倒せる相手にもジェノを超進化した（docs/ai-notes.md）。
 * クレストは 1.5 だとアリアのクレスト（妖精に疾走）を安く見て、出すべき局面でアリアを出さなかったため 3（ユーザー判断。docs/ai-notes.md）
 * fusionSet（手札の α・β・γ の種類 1 つにつき）は 0/1.2/2.4/3.6/4.8 で比べて 3.6（AFネメシスの勝率 38.7% → 46.8%。docs/ai-notes.md）
 * kuonReserve は 0/8/12/16 で比べて 8（スペルウィッチの勝率 44.4% → 47.1%、1200 試合。docs/ai-notes.md）
 * evoReserve 3 は勝率を変えない（今の AI と 50〜51%）が、進化時能力を持たないフォロワーへの進化が 30% → 20% に減るので採用（ユーザー判断。docs/ai-notes.md）
 */
export const SEARCH_WEIGHTS: EvalWeights = { ...DEFAULT_WEIGHTS, maxPp: 8, sep: 5, crest: 3, fusionSet: 3.6, kuonReserve: 8, evoReserve: 3, hold: FUSION_HOLD };

const KEYWORD_VALUE: Partial<Record<string, number>> = {
  ward: 1,
  bane: 2,
  barrier: 1,
  drain: 1,
  ambush: 1,
  intimidate: 1,
  aura: 0.5,
};

function followerValue(f: FollowerOnBoard, w: EvalWeights): number {
  let v = f.attack * w.attack + f.tempAttack * w.tempAttack + f.defense * w.defense + w.followerBase;
  for (const k of f.keywords) v += (KEYWORD_VALUE[k] ?? 0) * w.keywords;
  for (const k of f.tempKeywords) v += (KEYWORD_VALUE[k] ?? 0) * w.keywords;
  return v;
}

function boardValue(c: OnBoard, w: EvalWeights): number {
  if (c.kind === "follower") return followerValue(c, w);
  if (c.sigils !== null) return w.sigilAmulet + c.sigils * w.sigil;
  return w.amulet;
}

/** プレイヤー p から見た盤面の評価値（大きいほど p に有利） */
export function evaluateWith(state: GameState, p: PlayerIndex, w: EvalWeights): number {
  if (state.phase === "ended") return state.winner === p ? 1e6 : -1e6;
  const me = state.players[p];
  const opp = state.players[p === 0 ? 1 : 0];
  let v = 0;
  v += me.leaderHp * w.myHp - opp.leaderHp * w.oppHp;
  for (const c of me.board) v += boardValue(c, w);
  let oppBoard = 0;
  for (const c of opp.board) oppBoard += boardValue(c, w);
  v -= oppBoard * w.oppBoard;
  v += me.hand.length * w.myHand - opp.hand.length * w.oppHand;
  for (const h of me.hand) v += w.hold[h.cardId] ?? 0;
  if (w.fusionSet !== 0) {
    const kinds = new Set<string>();
    for (const h of me.hand) if (FUSION_SET.has(h.cardId)) kinds.add(h.cardId);
    v += kinds.size * w.fusionSet;
  }
  if (w.kuonReserve !== 0 && me.sep > 0 && me.hand.some((h) => h.cardId === KUON)) v += w.kuonReserve;
  if (w.evoReserve !== 0) {
    let n = 0;
    for (const h of me.hand) if (EVOLVE_ABILITY.has(h.cardId)) n++;
    const used = me.epEvolvedThisTurn !== null && EVOLVE_ABILITY.has(me.epEvolvedThisTurn) ? 1 : 0;
    v += (Math.min(n, me.ep) + used) * w.evoReserve;
  }
  v += me.ep * w.ep + me.sep * w.sep;
  if (me.extraPpAvailable) v += w.extraPp;
  // 自然に増えた分は数えない（PP を増やさないデッキの評価値を変えないため）
  v += (me.maxPp - Math.min(me.turnCount, MAX_PP)) * w.maxPp;
  v += (me.crests.length - opp.crests.length) * w.crest;
  v += Math.min(me.graveyard, 10) * w.graveyard;
  if (opp.leaderHp <= w.lethalRange) {
    for (const c of me.board) if (c.kind === "follower") v += c.attack * w.lethalAttack;
  }
  return v;
}

export function evaluate(state: GameState, p: PlayerIndex): number {
  return evaluateWith(state, p, DEFAULT_WEIGHTS);
}
