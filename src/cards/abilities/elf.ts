// エルフのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  COMBO,
  OPP_LEADER,
  THIS,
  act,
  addToHand,
  allyCards,
  allyFollowers,
  bounce,
  buff,
  choose,
  combo,
  costChange,
  count,
  crest,
  damage,
  destroy,
  distribute,
  draw,
  evolveIt,
  fanfare,
  gainPp,
  handCards,
  heal,
  id,
  lastWords,
  onAllyEnter,
  onAllyLeaveInHand,
  onAttack,
  onEvolve,
  onSuperEvolve,
  onTurnEnd,
  oppFollowers,
  otherAllyFollowers,
  random,
  repeat,
  setDefense,
  slot,
  spell,
  summon,
  transform,
  union,
  when,
} from "./helpers";

const fairiesInHand = count(handCards({ type: "follower", tribe: "妖精" }));

export const ELF: Record<string, CardAbilities> = {
  [id("フェアリーテイマー")]: { abilities: [fanfare(addToHand("フェアリー", 2))] },
  [id("ストレイビーストマン")]: { abilities: [fanfare({ op: "addCombo", amount: 1 })] },
  [id("温厚なるトレント")]: { abilities: [fanfare(when(combo(3), [evolveIt()])), onAttack(heal(2))] },
  [id("繚乱の庭")]: {
    abilities: [
      fanfare(addToHand("フェアリー")),
      onAllyEnter({ type: "follower", tribe: "妖精" }, random(oppFollowers()), damage(slot(), 1)),
    ],
  },
  [id("アドベンチャーエルフ・メイ")]: {
    abilities: [fanfare(when(combo(3), [choose(oppFollowers()), damage(slot(), 3)]))],
  },
  [id("ソニックアーチャー・セルウィン")]: { abilities: [onSuperEvolve(choose(oppFollowers()), bounce(slot()))] },
  [id("虫の知らせ")]: {
    abilities: [spell(choose(allyCards()), bounce(slot()), random(oppFollowers(), 1, "r"), damage(slot("r"), 2))],
  },
  [id("舞い踊る妖精")]: { abilities: [fanfare(when(combo(3), [buff(otherAllyFollowers(), 1, 1)]))] },
  [id("コンタクトフェアリー")]: {
    abilities: [
      fanfare(summon("フェアリー"), addToHand("フェアリー")),
      onEvolve(summon("フェアリー"), addToHand("フェアリー")),
    ],
  },
  [id("深奥のフェアリービースト")]: { abilities: [fanfare(draw(1), heal(count(handCards())))] },
  [id("働きバッタ")]: { abilities: [fanfare(draw(1, { type: "follower", costEq: COMBO }))] },
  [id("言の葉のエルダーウィードマン")]: {
    abilities: [
      fanfare(
        when(
          combo(3),
          [random(oppFollowers(), 3), damage(slot(), 3)],
          [random(oppFollowers()), damage(slot(), 3)],
        ),
      ),
    ],
  },
  [id("妖精の招集")]: { abilities: [spell(addToHand("フェアリー", 2))] },
  [id("フロストクリスタリア・エリン")]: {
    abilities: [fanfare(choose(oppFollowers()), destroy(slot()), heal(2))],
  },
  [id("純粋なるウォーターフェアリー")]: { abilities: [lastWords(addToHand("フェアリー"))] },
  [id("ベビーカーバンクル")]: {
    abilities: [fanfare(choose(allyCards({ excludeSelf: true })), bounce(slot())), onSuperEvolve(gainPp(3))],
  },
  [id("燐光の岩")]: {
    abilities: [
      fanfare(addToHand("フェアリー"), when(combo(3), [addToHand("森の神秘")])),
      act(0, { op: "destroy", target: THIS }, choose(allyFollowers()), buff(slot(), 1, 1)),
    ],
  },
  [id("薫交の思慕")]: { abilities: [spell(addToHand("森の神秘"), draw(1))] },
  [id("ピュアクリスタリア・リリィ")]: {
    abilities: [
      fanfare(when(combo(3), [choose(oppFollowers()), setDefense(slot(), 1)])),
      onEvolve(draw(1), choose(oppFollowers()), damage(slot(), 1)),
    ],
  },
  [id("薫交の天宮・バックウッド")]: {
    abilities: [fanfare(draw(2)), onEvolve(distribute(oppFollowers(), count(handCards())))],
  },
  [id("煌撃の戦士・ベイル")]: {
    abilities: [onAllyLeaveInHand(costChange(THIS, -1)), fanfare(choose(oppFollowers()), damage(slot(), 4))],
  },
  [id("殺戮のリノセウス")]: { abilities: [fanfare(buff(THIS, COMBO, 0))] },
  [id("聖樹の杖")]: {
    abilities: [
      onTurnEnd(when(combo(3), [draw(1)])),
      act(0, destroy(THIS), choose(allyCards({ excludeSelf: true })), bounce(slot())),
    ],
  },
  [id("自然の妖精姫・アリア")]: {
    abilities: [fanfare(crest("自然の妖精姫・アリア")), onSuperEvolve(summon("フェアリー", 3))],
  },
  [id("豊麗なるローズクイーン")]: {
    abilities: [fanfare(transform(handCards({ costMax: 1, class: "elf" }), "薔薇の閃撃"))],
  },
  [id("ビギンズブレイダー・アマツ")]: {
    abilities: [
      fanfare(buff(THIS, fairiesInHand, fairiesInHand)),
      onEvolve(repeat(fairiesInHand, random(oppFollowers()), damage(slot(), 1))),
    ],
  },

  // トークン
  [id("森の神秘")]: { abilities: [spell(heal(1))] },
  [id("薔薇の閃撃")]: { abilities: [spell(choose(union(oppFollowers(), OPP_LEADER)), damage(slot(), 3))] },
};
