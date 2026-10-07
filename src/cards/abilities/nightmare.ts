// ナイトメアのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  BOTH_LEADERS,
  ENHANCED,
  EVENT,
  OPP_LEADER,
  SELF_LEADER,
  THIS,
  act,
  addToHand,
  allyFollowers,
  banish,
  buff,
  choose,
  crest,
  damage,
  destroy,
  distribute,
  draw,
  evolveIt,
  fanfare,
  grant,
  heal,
  id,
  lastWords,
  mode,
  necromancy,
  onAllyEnter,
  onAttack,
  onEvolve,
  onEvolved,
  onSuperEvolve,
  onSuperEvolveInstead,
  onTurnEnd,
  oppFollowers,
  otherAllyFollowers,
  random,
  repeat,
  slot,
  spell,
  summon,
  union,
  when,
} from "./helpers";

const reanimate = (cost: number) => ({ op: "reanimate", cost }) as const;

export const NIGHTMARE: Record<string, CardAbilities> = {
  [id("夜の鬼人")]: { abilities: [fanfare(damage(SELF_LEADER, 1))] },
  [id("悪辣のレッサーマミー")]: { abilities: [fanfare(necromancy(4, grant(THIS, ["storm"])))] },
  [id("カオティックカース")]: {
    abilities: [spell(mode([draw(1, { type: "follower" })], [reanimate(2)]))],
  },
  [id("魅惑のサキュバス・リリム")]: { abilities: [lastWords(addToHand("バット"))] },
  [id("ラバーズネクロマンサー")]: {
    abilities: [
      onEvolve(summon("ゴースト", 2)),
      onSuperEvolveInstead(summon("ゴースト", 2, "g"), grant(slot("g"), ["drain"])),
    ],
  },
  [id("魂の捕食")]: { abilities: [spell(choose(allyFollowers()), destroy(slot()), draw(2))] },
  [id("ミッドナイトヴァンパイア・エラル")]: {
    abilities: [
      fanfare(summon("バット")),
      onAllyEnter({ ids: [id("バット")] }, grant(EVENT, ["storm"]), damage(SELF_LEADER, 1)),
    ],
  },
  [id("無名の悪魔")]: { abilities: [onEvolve(summon("バット", 2))] },
  [id("ボーンガール")]: { abilities: [lastWords(summon("スケルトン", 2))] },
  [id("ジャグリングゴースト")]: { abilities: [fanfare(reanimate(4))] },
  [id("禁約の悪魔")]: {
    abilities: [
      fanfare(draw(2), damage(SELF_LEADER, 2)),
      onEvolve(choose(oppFollowers()), damage(slot(), 6)),
    ],
  },
  [id("死神の一振り")]: {
    abilities: [
      spell(choose(allyFollowers(), 1, "a"), choose(oppFollowers(), 1, "b"), destroy(union(slot("a"), slot("b")))),
    ],
  },
  [id("辣腕の死神・ミーノ")]: {
    abilities: [fanfare(when(ENHANCED, [grant(THIS, ["rush", "bane"])])), lastWords(addToHand("スケルトン"))],
  },
  [id("ナイトメア・ヴェリィ")]: { abilities: [fanfare(damage(SELF_LEADER, 3)), onEvolve(heal(5))] },
  [id("怪奇の探索者・ユナ")]: { abilities: [lastWords(addToHand("ゴースト"), addToHand("バット"))] },
  [id("串刺し公・ヴラド")]: { abilities: [fanfare(choose(oppFollowers()), damage(slot(), 5), heal(5))] },
  [id("瞑地の霊園")]: {
    abilities: [fanfare({ op: "addGraveyard", amount: 2 }), act(0, destroy(THIS), summon("ゴースト", 2))],
  },
  [id("青薔薇の令嬢・セレス")]: {
    abilities: [
      onTurnEnd(when({ kind: "thisSuperEvolved" }, [heal(4), grant(THIS, ["barrier"])], [heal(2)])),
    ],
  },
  [id("燃え盛る魔剣・オルトロス")]: {
    abilities: [
      fanfare({ op: "addGraveyard", amount: 2 }),
      onEvolve(necromancy(4, repeat(2, random(oppFollowers()), damage(slot(), 2)))),
    ],
  },
  [id("瞑地の天宮・ムカン")]: {
    abilities: [
      fanfare(necromancy(8, evolveIt())),
      onAllyEnter({ type: "follower", tribe: "死者" }, grant(EVENT, ["bane"])),
      onEvolved(summon("ゴースト")),
    ],
  },
  [id("闇の賞金稼ぎ・バルト")]: { abilities: [fanfare(crest("闇の賞金稼ぎ・バルト"))] },
  [id("蛇神の怒り")]: {
    abilities: [
      spell(choose(union(oppFollowers(), OPP_LEADER)), damage(slot(), 3), damage(SELF_LEADER, 2)),
    ],
  },
  [id("奔放なる獄炎・ケルベロス")]: {
    abilities: [
      fanfare(
        summon("番犬の右腕・ミミ"),
        summon("番犬の左腕・ココ"),
        necromancy(6, buff(otherAllyFollowers(), 2, 0)),
      ),
      onSuperEvolve(reanimate(1), reanimate(1)),
    ],
  },
  [id("猛毒姫・メドゥーサ")]: {
    abilities: [onAttack(when({ kind: "attackingFollower" }, [destroy(EVENT)]))],
  },
  [id("エンドレスハンター・アラガヴィ")]: {
    abilities: [fanfare(distribute(oppFollowers(), 7)), onEvolve(damage(BOTH_LEADERS, 3))],
  },

  // トークン
  [id("ゴースト")]: { banishOnLeave: true, abilities: [onTurnEnd(banish(THIS))] },
  [id("番犬の右腕・ミミ")]: { abilities: [lastWords(damage(OPP_LEADER, 2))] },
  [id("番犬の左腕・ココ")]: { abilities: [lastWords(heal(2))] },
};
