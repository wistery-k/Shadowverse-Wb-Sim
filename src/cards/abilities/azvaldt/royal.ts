// 前期のローテーションのロイヤルのカード能力（トークンを含む）

import type { CardAbilities, Effect } from "../../../engine/dsl";
import {
  ENHANCED,
  EVENT,
  OPP_LEADER,
  PAID_COST,
  THIS,
  addToHand,
  allyAmulets,
  allyCards,
  allyFollowers,
  banish,
  buff,
  choose,
  countAtLeast,
  countdown,
  countdownOf,
  crest,
  damage,
  draw,
  fanfare,
  grant,
  grantFaith,
  heal,
  id,
  lastWords,
  link,
  mode,
  modeAllIf,
  onAllyEnter,
  onAllyPlay,
  onEvolve,
  onSuperEvolve,
  oppFollowers,
  random,
  setCost,
  slot,
  spell,
  spendFaith,
  summon,
  superEvolveIt,
  union,
  valueEq,
  when,
} from "./helpers";

/** 波濤の副船長: 相手の場のフォロワー1枚を選ぶ。それに3ダメージ。『戦慄の海賊旗』1枚を自分の場に出す */
const viceCaptain: Effect[] = [choose(oppFollowers()), damage(slot(), 3), summon("戦慄の海賊旗")];

export const ROYAL: Record<string, CardAbilities> = {
  [id("旧き天剣・イドメタ")]: {
    abilities: [
      fanfare(addToHand("天剣の深淵")),
      onEvolve(spendFaith("旧き天剣・イドメタ", 5, grantFaith("旧き天剣・イドメタ"))),
    ],
  },
  [id("海域の斥候")]: { abilities: [fanfare(summon("戦慄の海賊旗")), onEvolve(addToHand("黄金の靴"))] },
  [id("栄耀なる麗金花")]: {
    abilities: [spell(when(ENHANCED, [addToHand("輝く金貨", 4)], [addToHand("輝く金貨", 2)]))],
  },
  [id("渦潮の砲手")]: { abilities: [fanfare(summon("戦慄の海賊旗"), addToHand("黄金の杯"))] },
  [id("燃え落ちる縁")]: {
    abilities: [
      spell(
        choose(oppFollowers()),
        damage(slot(), 5),
        when(valueEq(PAID_COST, 3), [addToHand("燃え落ちる縁", 1, "c"), setCost(slot("c"), 1)]),
      ),
    ],
  },
  [id("真紅と群青・ゼタ＆ベアトリクス")]: {
    abilities: [
      fanfare(
        summon("真紅と群青・ゼタ＆ベアトリクス", 1, "c"),
        when(ENHANCED, [grant(slot("c"), ["bane"]), grant(THIS, ["storm"])]),
      ),
    ],
  },
  [id("アージュドール")]: {
    abilities: [
      spell(
        when(
          ENHANCED,
          [summon("戦慄の海賊旗", 2), damage(oppFollowers(), 4)],
          [summon("戦慄の海賊旗"), damage(oppFollowers(), 2)],
        ),
      ),
    ],
  },
  [id("麗金花・ウンケイ")]: {
    abilities: [
      fanfare(choose(oppFollowers()), banish(slot()), addToHand("輝く金貨")),
      onSuperEvolve(crest("麗金花・ウンケイ")),
    ],
  },
  [id("波濤の副船長")]: {
    abilities: [
      fanfare(...viceCaptain),
      onEvolve(...viceCaptain),
      onSuperEvolve(
        addToHand("黄金の小剣", 1, "a"),
        setCost(slot("a"), 0),
        addToHand("黄金の首飾り", 1, "b"),
        setCost(slot("b"), 0),
      ),
    ],
  },
  [id("真王の刃・黄金の騎士")]: {
    abilities: [fanfare(modeAllIf(ENHANCED, [superEvolveIt(THIS)], [damage(oppFollowers(), 4)], [heal(4)]))],
  },
  [id("逆行の咎人・バルバロス")]: {
    abilities: [fanfare(summon("戦慄の海賊旗"), countdownOf(allyAmulets({ ids: [id("戦慄の海賊旗")] }), -5))],
  },
  [id("迷夢の獅子・モルドレッド")]: { abilities: [onEvolve(summon("決意の輝竜・アーサー"))] },
  [id("決意の輝竜・アーサー")]: { abilities: [onEvolve(summon("迷夢の獅子・モルドレッド"))] },
  [id("二等分の日常")]: {
    abilities: [
      spell(modeAllIf(countAtLeast(allyCards(), 2), [random(oppFollowers()), damage(slot(), 4)], [heal(2)])),
    ],
  },
  [id("無音の包囲")]: {
    abilities: [
      spell(
        when(link(10), [addToHand("スティールナイト", 2, "c")], [addToHand("スティールナイト", 1, "c")]),
        grant(slot("c"), ["rush"]),
      ),
    ],
  },
  [id("焦がれし炎将・マーズ")]: {
    abilities: [
      fanfare(summon("ナイト", 3)),
      onAllyEnter({ type: "follower", tribe: "兵士" }, buff(EVENT, 2, 0), grant(EVENT, ["rush"]), buff(THIS, 1, 0)),
      onSuperEvolve(summon("ナイト")),
    ],
  },
  [id("聴略の諜報兵")]: {
    abilities: [lastWords(summon("ナイト")), onEvolve(choose(oppFollowers()), damage(slot(), 3))],
  },
  [id("凄烈の天剣")]: {
    abilities: [spell(modeAllIf(ENHANCED, [draw(1)], [random(oppFollowers()), damage(slot(), 3)]))],
  },
  [id("信念の蹴撃・ランドル")]: { abilities: [fanfare(when(ENHANCED, [grant(THIS, ["storm"])]))] },

  // トークン
  [id("天剣の深淵")]: {
    abilities: [spell(choose(oppFollowers()), when(ENHANCED, [damage(slot(), 3)], [damage(slot(), 1)]))],
  },
  [id("戦慄の海賊旗")]: {
    abilities: [onAllyPlay({ type: "spell" }, countdown(-1)), lastWords(damage(OPP_LEADER, 2))],
  },
  [id("黄金の靴")]: { abilities: [spell(choose(allyFollowers()), buff(slot(), 1, 0), grant(slot(), ["rush"]))] },
  [id("黄金の杯")]: { abilities: [spell(heal(2))] },
  [id("輝く金貨")]: { abilities: [spell(mode([draw(1)], [random(oppFollowers()), damage(slot(), 2)]))] },
  [id("黄金の小剣")]: { abilities: [spell(choose(union(oppFollowers(), OPP_LEADER)), damage(slot(), 1))] },
  [id("黄金の首飾り")]: { abilities: [spell(choose(allyFollowers()), buff(slot(), 0, 1), grant(slot(), ["ward"]))] },
};
