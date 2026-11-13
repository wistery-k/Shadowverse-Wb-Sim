// 前期のローテーションのドラゴンのカード能力（トークン・アクセラレートの姿を含む）

import type { CardAbilities, Effect } from "../../../engine/dsl";
import {
  AWAKENED,
  ENHANCED,
  LEADER_DAMAGE_ZERO,
  OPP_LEADER,
  THIS,
  THIS_EVOLVED,
  addMaxPp,
  addToDeck,
  addToHand,
  allFollowers,
  buff,
  choose,
  count,
  crest,
  damage,
  destroy,
  discard,
  draw,
  fanfare,
  grant,
  handCards,
  heal,
  id,
  mode,
  onAllyEnter,
  onDiscarded,
  onEvolve,
  onSuperEvolve,
  onSuperEvolveInstead,
  onTurnEnd,
  oppFollowers,
  random,
  repeat,
  setLeaderMaxHp,
  slot,
  specialId,
  spell,
  summon,
  union,
  when,
} from "./helpers";

/** 自分の手札1枚を選ぶ。それを捨てる。自分のデッキから1枚を引く。自分のリーダーを1回復（笑顔の調理・キミカ） */
const kimikaEffects: Effect[] = [choose(handCards(), 1, "h"), discard(slot("h")), draw(1), heal(1)];
/** 禁牙の変貌・ノマグダラの【モード】 */
const nomagudaraMode: Effect = mode([draw(1), heal(3)], [buff(oppFollowers(), 0, -4)]);
/** 炎の理・ウィルナス: 相手の場のフォロワー1枚を選ぶ。それに8ダメージ */
const wilnasEffects: Effect[] = [choose(oppFollowers()), damage(slot(), 8)];
/** 天刀の深淵: 相手のリーダーに1ダメージ。自分のリーダーを1回復 */
const tentoEffects: Effect[] = [damage(OPP_LEADER, 1), heal(1)];

export const DRAGON: Record<string, CardAbilities> = {
  [id("金銀絢爛・リュミオール＆アルジャンテ")]: {
    abilities: [
      fanfare(choose(handCards(), 2, "h"), discard(slot("h")), damage(union(oppFollowers(), OPP_LEADER), 4)),
      onSuperEvolve(draw(3)),
    ],
  },
  [specialId("金銀絢爛・リュミオール＆アルジャンテ", "accelerate")]: { abilities: [spell(addMaxPp(1))] },
  [id("笑顔の調理・キミカ")]: { abilities: [fanfare(...kimikaEffects), onEvolve(...kimikaEffects)] },
  [id("禁牙の変貌・ノマグダラ")]: { abilities: [fanfare(nomagudaraMode), onEvolve(nomagudaraMode)] },
  [id("狐火陽炎")]: {
    abilities: [
      spell(
        choose(union(oppFollowers(), OPP_LEADER)),
        damage(slot(), 1),
        addToDeck("狐火陽炎"),
        when(AWAKENED, [draw(1)]),
      ),
    ],
  },
  [id("焦灰のアナテマ・バーンドナイト")]: {
    abilities: [fanfare(damage(oppFollowers(), 9)), onSuperEvolve(crest("焦灰のアナテマ・バーンドナイト", "opponent"))],
  },
  [id("旧き天刀・ヴォーラライ")]: {
    abilities: [
      onDiscarded(summon("旧き天刀・ヴォーラライ")),
      onEvolve(addToHand("天刀の深淵")),
      onSuperEvolveInstead(addToHand("天刀の深淵", 3)),
    ],
  },
  [id("断頭の斬姫・サガツマツ")]: {
    abilities: [fanfare(choose(handCards(), 1, "h"), discard(slot("h")), addToHand("赤色流し", 2))],
  },
  [id("怠惰なる波揺花")]: {
    abilities: [
      spell(repeat(2, random(oppFollowers()), damage(slot(), 2)), when(AWAKENED, [damage(OPP_LEADER, 2)])),
    ],
  },
  [id("律する《正義》・イランツァ")]: {
    abilities: [
      onTurnEnd(
        when(THIS_EVOLVED, [damage(OPP_LEADER, 8)], [random(oppFollowers(), 2), damage(slot(), 8), heal(8)]),
      ),
      onEvolve({ op: "loseKeyword", target: THIS, keyword: "ward" }, grant(THIS, ["intimidate"])),
    ],
  },
  [id("喧伝の龍人")]: { abilities: [fanfare(when(ENHANCED, [summon("喧伝の龍人", 2)]))] },
  [id("世界の味方・ゾーイ")]: {
    abilities: [fanfare(addMaxPp(1), when(ENHANCED, [grant(THIS, ["storm"]), setLeaderMaxHp(1), LEADER_DAMAGE_ZERO]))],
  },
  [id("炎の理・ウィルナス")]: { abilities: [fanfare(...wilnasEffects), onEvolve(...wilnasEffects)] },
  [id("プロミネンスロア")]: { abilities: [spell(damage(allFollowers(), count(allFollowers())))] },
  [id("クラゲの舞姫")]: {
    abilities: [
      fanfare(addToHand("大海のオルカ")),
      onAllyEnter({ type: "follower", tribe: "海洋" }, grant(THIS, ["rush", "bane"])),
    ],
  },
  [id("黒炎の奔流")]: { abilities: [spell(damage(oppFollowers(), 5), damage(OPP_LEADER, 3))] },

  // トークン
  [id("天刀の深淵")]: { abilities: [onDiscarded(...tentoEffects), spell(...tentoEffects)] },
  [id("赤色流し")]: {
    abilities: [spell(choose(handCards(), 1, "h"), choose(oppFollowers()), discard(slot("h")), destroy(slot()))],
  },
};
