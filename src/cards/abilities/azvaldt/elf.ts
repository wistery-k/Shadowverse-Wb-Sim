// 前期のローテーションのエルフのカード能力（トークンを含む）

import type { CardAbilities, Effect } from "../../../engine/dsl";
import {
  COMBO,
  OUGI,
  THIS,
  THIS_ATTACK,
  addCombo,
  addToHand,
  allyFollowers,
  buff,
  choose,
  combo,
  costChange,
  crest,
  damage,
  destroy,
  distribute,
  draw,
  evolveIt,
  fanfare,
  gainEp,
  gainPp,
  grant,
  grantFaith,
  handCards,
  id,
  lastWords,
  mode,
  neg,
  onEvolve,
  onSuperEvolve,
  onTurnEnd,
  onTurnEndInHand,
  oppFollowers,
  otherAllyFollowers,
  random,
  repeat,
  returnToDeck,
  slot,
  spell,
  spendFaith,
  summon,
  when,
} from "./helpers";

/** 自分の手札1枚を選ぶ。それをデッキに戻す（グルーミーガール・モエル、エルフトラッパー） */
const returnOneToDeck: Effect[] = [choose(handCards(), 1, "h"), returnToDeck(slot("h"))];
/** 虫風花・ミロクの【モード】 */
const mirokuMode: Effect = mode([addToHand("フェアリー", 2)], [gainPp(2)], [distribute(oppFollowers(), 3)]);

export const ELF: Record<string, CardAbilities> = {
  [id("旧き天槍・ササニド")]: {
    // 「信仰値を-10して、」の後の 2 つの文はどちらも信仰値を払ったときだけ働く（ユーザーの答え。docs/rules.md 12章の 34）
    abilities: [fanfare(spendFaith("旧き天槍・ササニド", 10, addToHand("天槍の深淵"), grantFaith("旧き天槍・ササニド")))],
  },
  [id("グルーミーガール・モエル")]: { abilities: [fanfare(...returnOneToDeck, draw(1))] },
  [id("発芽の組員")]: { abilities: [fanfare(when(combo(3), [draw(1)]))] },
  [id("緑風のレイピア使い")]: { abilities: [fanfare(when(combo(3), [grant(THIS, ["storm"])]))] },
  [id("根差の刺客")]: { abilities: [fanfare(addToHand("フェアリー", 1, "c"), when(combo(3), [grant(slot("c"), ["bane"])]))] },
  [id("枝葉の舎弟頭")]: {
    abilities: [
      fanfare(when(combo(3), [draw(2)])),
      onEvolve(choose(otherAllyFollowers()), buff(slot(), 1, 1), grant(slot(), ["rush"])),
    ],
  },
  [id("虫風花・ミロク")]: { abilities: [fanfare(mirokuMode), onEvolve(mirokuMode)] },
  [id("煙管の咎人・マガチヨ")]: {
    abilities: [
      fanfare(when(combo(3), [damage(oppFollowers(), 4)], [choose(oppFollowers()), damage(slot(), 4)])),
      onSuperEvolve(grant(THIS, ["storm"])),
    ],
  },
  [id("操嵩のアナテマ・ダストデイズ")]: {
    abilities: [
      fanfare(choose(oppFollowers()), buff(slot(), 0, neg(THIS_ATTACK)), addCombo(1)),
      onEvolve(crest("操嵩のアナテマ・ダストデイズ")),
    ],
  },
  [id("緋岸橙酔")]: {
    abilities: [
      onTurnEndInHand(when(combo(3), [costChange(THIS, -1)])),
      spell(choose(oppFollowers()), destroy(slot()), draw(1)),
    ],
  },
  [id("氷界の鹿王")]: {
    abilities: [
      fanfare(addToHand("森の神秘", 2)),
      onTurnEnd(distribute(oppFollowers(), THIS_ATTACK)),
      onSuperEvolve(crest("氷界の鹿王")),
    ],
  },
  [id("離合の有終・セタス＆メイシア")]: {
    abilities: [fanfare(choose(oppFollowers()), destroy(slot()), buff(otherAllyFollowers(), 1, 1))],
  },
  [id("風の理・イーウィヤ")]: { abilities: [fanfare(when(OUGI, [gainEp(1)]))] },
  [id("優雅なる虫風花")]: { abilities: [spell(draw(COMBO))] },
  [id("ゴッズレポーター")]: { abilities: [lastWords(draw(1)), onSuperEvolve(summon("ゴッズレポーター", 2))] },
  [id("調和の舞手・ユエル＆ソシエ")]: {
    abilities: [
      fanfare(repeat(2, random(oppFollowers()), damage(slot(), 4))),
      onSuperEvolve(crest("調和の舞手・ユエル＆ソシエ")),
    ],
  },
  [id("エルフトラッパー")]: { abilities: [fanfare(...returnOneToDeck, addToHand("フェアリー", 2))] },

  // トークン
  [id("天槍の深淵")]: { abilities: [spell(choose(allyFollowers({ notEvolved: true })), evolveIt(slot()))] },
};
